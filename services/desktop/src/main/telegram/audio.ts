// v0.1.419 — Sprachnachrichten von Telegram für Whisper aufbereiten.
//
// Telegram liefert OGG/Opus. Whisper (`whisper-cli`) erwartet 16-bit-PCM-WAV
// mit 16 kHz. `ffmpeg` ist bewusst NICHT im Bundle — der Sprachaufnahme-Pfad
// im Renderer vermeidet es ebenfalls und rechnet stattdessen selbst um
// (siehe renderer/src/lib/recordVoice.ts).
//
// Denselben Weg gehen wir hier: Chromium kann Opus von Haus aus dekodieren.
// Wir öffnen ein verstecktes Fenster, lassen dort `decodeAudioData` laufen,
// rechnen über einen OfflineAudioContext auf 16 kHz mono um und bauen ein
// WAV daraus. Damit bleibt die Transkription vollständig auf dem Rechner —
// kein Cloud-Dienst, kein zusätzliches Binary.

import { BrowserWindow } from "electron";

/** Obergrenze, damit eine Monster-Datei nicht den Speicher sprengt. */
const MAX_INPUT_BYTES = 12 * 1024 * 1024;

/**
 * OGG/Opus (oder jedes von Chromium unterstützte Format) nach
 * 16-kHz-mono-WAV wandeln. Gibt null zurück, wenn die Dekodierung
 * scheitert — der Aufrufer meldet das dem Nutzer.
 */
export async function decodeToWav16k(input: Buffer): Promise<Buffer | null> {
  if (input.byteLength === 0 || input.byteLength > MAX_INPUT_BYTES) return null;

  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // v0.1.481 — Helfer-Fenster nie im macOS-Fenster-/Dock-Menue listen.
  win.excludedFromShownWindowsMenu = true;

  try {
    // Leere Seite laden — wir brauchen nur eine JS-Umgebung mit WebAudio.
    await win.loadURL("data:text/html,<!doctype html><meta charset=utf-8>");

    const b64 = input.toString("base64");
    const js = `(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const ctx = new AudioContext();
      let decoded;
      try {
        decoded = await ctx.decodeAudioData(bytes.buffer);
      } finally {
        ctx.close();
      }

      // Auf 16 kHz mono umrechnen (Whisper-Eingabeformat).
      const target = 16000;
      const frames = Math.max(1, Math.ceil(decoded.duration * target));
      const off = new OfflineAudioContext(1, frames, target);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      const samples = rendered.getChannelData(0);

      // 16-bit-PCM-WAV bauen (44-Byte-Header + Daten).
      const dataSize = samples.length * 2;
      const buf = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buf);
      const ascii = (off2, s) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off2 + i, s.charCodeAt(i));
      };
      ascii(0, "RIFF");
      view.setUint32(4, 36 + dataSize, true);
      ascii(8, "WAVE");
      ascii(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);          // PCM
      view.setUint16(22, 1, true);          // mono
      view.setUint32(24, target, true);
      view.setUint32(28, target * 2, true); // byte rate
      view.setUint16(32, 2, true);          // block align
      view.setUint16(34, 16, true);         // bits per sample
      ascii(36, "data");
      view.setUint32(40, dataSize, true);
      let o = 44;
      for (let i = 0; i < samples.length; i++, o += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }

      // Als base64 zurueckgeben (IPC-freundlich).
      let out = "";
      const u8 = new Uint8Array(buf);
      const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) {
        out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      }
      return btoa(out);
    })()`;

    const wavB64 = (await win.webContents.executeJavaScript(js, false)) as
      | string
      | null;
    if (!wavB64) return null;
    return Buffer.from(wavB64, "base64");
  } catch (err) {
    console.warn("[telegram] Audio-Dekodierung fehlgeschlagen:", err);
    return null;
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
  }
}
