// Voice recording (Phase 8.n2).
//
// Captures mic audio at 16 kHz mono via Web Audio API, accumulates raw
// Float32 samples, and on `finish()` encodes them as 16-bit PCM WAV
// for the whisper sidecar. Whisper.cpp wants exactly that format —
// resampling on the renderer side avoids ffmpeg in main and keeps the
// IPC payload small.
//
// The `levels` slice powers the live waveform UI: per ~50 ms tick we
// compute peak amplitude over the last buffer of samples and append
// to a rolling array, capped at MAX_LEVELS. Bars get rendered newest-
// on-the-right (ChatGPT-style).
//
// State machine: idle → recording → transcribing → idle (or error).
// Callers drive the transitions via `start` / `finish` / `cancel`.
// The hook owns the `MediaStream`, `AudioContext`, and the
// AudioWorkletNode / ScriptProcessorNode lifecycles.

import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 16_000;
const LEVEL_TICK_MS = 60;
const MAX_LEVELS = 80;

export type RecordingState =
  | "idle"
  | "recording"
  | "transcribing"
  | "error";

/** Discriminated error so the UI can render the right next step
 *  ("re-try", "open system settings", "retry with different message"). */
export type RecorderError =
  | { kind: "system-denied"; message: string }
  | { kind: "no-device"; message: string }
  | { kind: "in-use"; message: string }
  | { kind: "generic"; message: string };

export interface UseVoiceRecorderResult {
  state: RecordingState;
  error: RecorderError | null;
  /** Rolling RMS levels (0..1), newest at the end. UI renders these
   *  as vertical bars right-to-left for the ChatGPT-style waveform. */
  levels: number[];
  /** Wall-clock seconds since the user pressed mic. Drives a tiny
   *  digital readout next to the waveform. */
  elapsedSeconds: number;
  start: () => Promise<void>;
  /** Stop recording, encode WAV, return audio bytes; the caller is
   *  responsible for shipping them to main and dropping the
   *  transcript wherever they want. */
  finish: () => Promise<Uint8Array>;
  /** Discard. Stops the stream + clears buffers; never produces audio. */
  cancel: () => void;
  /** Clear the sticky error state so the next start() doesn't render
   *  with the previous error visible. */
  clearError: () => void;
}

export function useVoiceRecorder(): UseVoiceRecorderResult {
  const [state, setState] = useState<RecordingState>("idle");
  const [error, setError] = useState<RecorderError | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const startedAtRef = useRef<number>(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const cleanedUpRef = useRef<boolean>(false);

  const cleanup = useCallback(() => {
    if (cleanedUpRef.current) return;
    cleanedUpRef.current = true;
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        /* ignore */
      }
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        /* ignore */
      }
      sourceRef.current = null;
    }
    if (ctxRef.current) {
      // close() is async but rejection is fine; we just want the
      // context torn down at our earliest convenience.
      void ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  // Defensive teardown on unmount (user navigated away mid-recording).
  useEffect(() => () => cleanup(), [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    setLevels([]);
    setElapsedSeconds(0);
    samplesRef.current = [];
    cleanedUpRef.current = false;

    // OS-level pre-flight (macOS only — other platforms return
    // `unsupported` and we let getUserMedia surface the error).
    // - 'not-determined' → fire the system prompt; on grant, continue.
    // - 'denied' → short-circuit with a system-denied error so the
    //   UI can offer "Systemeinstellungen öffnen" instead of looping
    //   on a getUserMedia that'll never succeed.
    // - 'restricted' → MDM / parental control; treat like denied but
    //   tell the user it's policy-locked.
    // - 'granted' / 'unknown' / 'unsupported' → fall through.
    let appNameInSettings = "AVA";
    let isDev = false;
    try {
      const perm = await window.api.voice.getMicPermission();
      appNameInSettings = perm.appNameInSettings ?? appNameInSettings;
      isDev = perm.isDev ?? false;
      if (perm.status === "not-determined") {
        const granted = await window.api.voice.requestMicPermission();
        if (!granted) {
          setError({
            kind: "system-denied",
            message: deniedMessage(appNameInSettings, isDev),
          });
          setState("error");
          return;
        }
      } else if (perm.status === "denied") {
        setError({
          kind: "system-denied",
          message: deniedMessage(appNameInSettings, isDev),
        });
        setState("error");
        return;
      } else if (perm.status === "restricted") {
        setError({
          kind: "system-denied",
          message:
            "Mikrofon-Zugriff ist auf diesem Gerät durch eine Richtlinie (z. B. MDM / Bildschirmzeit) gesperrt.",
        });
        setState("error");
        return;
      }
    } catch (err) {
      // Permission probe itself failed — log + continue; the
      // getUserMedia call below will surface the real problem.
      console.warn("[voice] permission probe failed:", err);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // The browser may not honour an explicit sampleRate on
          // getUserMedia (Chromium often returns the device-native
          // 48 kHz). We resample inside the AudioContext below by
          // requesting a 16 kHz context — that's what Whisper wants.
          sampleRate: TARGET_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // AudioContext at the model's native rate. The browser does the
      // resampling between the device sample rate and ours — saves us
      // shipping a resampler.
      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      ctxRef.current = ctx;
      // Some browsers start the context suspended.
      if (ctx.state === "suspended") await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // ScriptProcessor is deprecated in favour of AudioWorklet but
      // the latter requires a separate worklet module + module load
      // dance that's overkill for a 16 kHz mono capture. The
      // ScriptProcessor still works in Electron's Chromium and the
      // CPU cost is negligible at 16 kHz mono.
      const bufferSize = 4096;
      const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      let levelAccum = 0;
      let levelSamples = 0;
      let lastLevelEmit = 0;

      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        // Buffer.slice() — preserve a copy independent of the
        // AudioContext's reusable buffer. Without the slice the
        // accumulated array is full of stale references.
        samplesRef.current.push(new Float32Array(input));

        // Peak across this buffer for the visualisation.
        let peak = 0;
        for (let i = 0; i < input.length; i++) {
          const v = Math.abs(input[i]!);
          if (v > peak) peak = v;
        }
        levelAccum = Math.max(levelAccum, peak);
        levelSamples += 1;
        const now = performance.now();
        if (now - lastLevelEmit >= LEVEL_TICK_MS) {
          lastLevelEmit = now;
          const next = levelAccum;
          levelAccum = 0;
          levelSamples = 0;
          setLevels((prev) => {
            const arr = prev.length >= MAX_LEVELS ? prev.slice(1) : prev.slice();
            arr.push(next);
            return arr;
          });
        }
      };

      // Connect: source → processor → destination. We connect to
      // destination (silent) so the processor actually pulls samples;
      // some Chromium versions optimise out an unconnected processor.
      source.connect(processor);
      processor.connect(ctx.destination);

      startedAtRef.current = Date.now();
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedSeconds(
          Math.floor((Date.now() - startedAtRef.current) / 1000),
        );
      }, 250);

      setState("recording");
    } catch (err) {
      cleanup();
      setError(classifyMediaError(err));
      setState("error");
      // Don't re-throw — the caller already sees the error via state.
    }
  }, [cleanup]);

  const finish = useCallback(async (): Promise<Uint8Array> => {
    setState("transcribing");
    // Stop capture immediately but keep buffers for encoding.
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
    }
    const wav = encodeWav(samplesRef.current, TARGET_SAMPLE_RATE);
    cleanup();
    return wav;
  }, [cleanup]);

  const cancel = useCallback(() => {
    cleanup();
    samplesRef.current = [];
    setLevels([]);
    setElapsedSeconds(0);
    setState("idle");
    setError(null);
  }, [cleanup]);

  const clearError = useCallback(() => {
    setError(null);
    if (state === "error") setState("idle");
  }, [state]);

  return {
    state,
    error,
    levels,
    elapsedSeconds,
    start,
    finish,
    cancel,
    clearError,
  };
}

/**
 * Build the system-denied message with the right name to look for in
 * System Settings. In dev mode the OS attaches the permission to the
 * shared `Electron` binary (because we're running
 * `node_modules/electron/dist/Electron.app`); in production it's the
 * packaged product name.
 */
function deniedMessage(appName: string, isDev: boolean): string {
  const base =
    `Mikrofon-Zugriff ist im System gesperrt. Bitte aktiviere ` +
    `„${appName}" in den Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon ` +
    `und versuche es erneut.`;
  if (!isDev) return base;
  // Dev-mode footnote — the binary is shared across every Electron app
  // on the machine, so "Electron" might already be present in the
  // list (and toggled off from a previous denied prompt).
  return (
    base +
    `\n\nHinweis: Im Entwickler-Modus läuft AVA als generische ` +
    `Electron-Anwendung. Suche in den Systemeinstellungen daher nach ` +
    `dem Eintrag „${appName}" — nicht nach „AVA". Sollte der ` +
    `Eintrag fehlen, klicke auf „Systemeinstellungen öffnen" und ` +
    `versuche es danach erneut; macOS legt den Eintrag beim ersten ` +
    `Zugriff an.`
  );
}

/**
 * Map the various `getUserMedia` rejection shapes onto our discriminated
 * RecorderError. Chromium throws DOMException subclasses with predictable
 * names; we slot each into a category the UI can render the right next
 * step for.
 */
function classifyMediaError(err: unknown): RecorderError {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name: string }).name;
    const baseMsg =
      err instanceof Error ? err.message : String((err as { name: string }).name);
    switch (name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        // Permission denied AT the browser/Electron layer. With our
        // `setPermissionRequestHandler` granting media this only fires
        // when the OS revoked mid-session OR the user denied at the
        // system prompt.
        return {
          kind: "system-denied",
          message:
            "Mikrofon-Zugriff wurde verweigert. Bitte überprüfe die Systemeinstellungen → Datenschutz → Mikrofon und stelle sicher, dass AVA dort aktiviert ist.",
        };
      case "NotFoundError":
      case "DevicesNotFoundError":
        return {
          kind: "no-device",
          message:
            "Es wurde kein Mikrofon gefunden. Schließe ein Mikrofon an und versuche es erneut.",
        };
      case "NotReadableError":
      case "TrackStartError":
      case "AbortError":
        return {
          kind: "in-use",
          message:
            "Das Mikrofon ist von einer anderen App belegt (z. B. Zoom, Teams). Beende die andere App und versuche es erneut.",
        };
      default:
        return {
          kind: "generic",
          message: `Mikrofon-Zugriff fehlgeschlagen: ${baseMsg}`,
        };
    }
  }
  return {
    kind: "generic",
    message: `Mikrofon-Zugriff fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
  };
}

// ---- WAV encoder ---------------------------------------------------------

/**
 * Encode Float32 samples to a 16-bit PCM mono WAV byte array (44-byte
 * RIFF header + raw little-endian Int16 data). Whisper.cpp's
 * `whisper-cli -f` accepts this format directly — no ffmpeg detour.
 */
function encodeWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total === 0) {
    // Return minimal valid WAV with zero data so whisper-cli reports
    // an empty transcript instead of erroring on a malformed file.
    return buildWavHeader(0, sampleRate);
  }
  const samples = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    samples.set(c, offset);
    offset += c.length;
  }
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]!;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    int16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  const header = buildWavHeader(int16.byteLength, sampleRate);
  const out = new Uint8Array(header.byteLength + int16.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(int16.buffer), header.byteLength);
  return out;
}

function buildWavHeader(dataSize: number, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  // "RIFF"
  view.setUint8(0, 0x52);
  view.setUint8(1, 0x49);
  view.setUint8(2, 0x46);
  view.setUint8(3, 0x46);
  view.setUint32(4, 36 + dataSize, true);
  // "WAVE"
  view.setUint8(8, 0x57);
  view.setUint8(9, 0x41);
  view.setUint8(10, 0x56);
  view.setUint8(11, 0x45);
  // "fmt "
  view.setUint8(12, 0x66);
  view.setUint8(13, 0x6d);
  view.setUint8(14, 0x74);
  view.setUint8(15, 0x20);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  // "data"
  view.setUint8(36, 0x64);
  view.setUint8(37, 0x61);
  view.setUint8(38, 0x74);
  view.setUint8(39, 0x61);
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}
