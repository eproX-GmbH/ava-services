// Sprachmodus — Aktivierungswort "Hey AVA" lokal (docs/PLAN_SPRACHMODUS.md, S4b).
//
// Im Ruhezustand hoert nur das Geraet zu. Ein Pegel-Detektor (billig,
// laeuft staendig) schneidet bei Sprache ein Fenster von etwa zwei Sekunden
// aus; erst das geht an das lokale Whisper-Modell. Audio verlaesst das
// Geraet nicht. Whisper laeuft also nicht dauerhaft, sondern je Sprechpause
// einmal kurz.

import { encodeWav } from "./recordVoice";

const SCHWELLE = 0.018;
const FENSTER_MS = 2400;
const MIN_MS = 350;
const STILLE_MS = 450;
const RE = /\b(h[ea]y|hallo|hi|he|ey)\s*,?\s*(ava|afa|eva|aber|ava\.)\b|\bava\b/i;

export function istWachwort(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-zäöü\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/\b(hey|hallo|hi|he|ey)\s+(ava|afa|eva)\b/.test(t)) return true;
  // Whisper hoert "Hey AVA" auch als "Hey, Aber" oder nur "Ava".
  return /^(hey|hallo|hi|he|ey)?\s*(ava|afa|eva)\b/.test(t);
}

export class WachwortLauscher {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private proc: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private sprichtSeit: number | null = null;
  private letzteStimme = 0;
  private laeuft = false;
  private aktiv = false;

  constructor(private readonly onWach: () => void, private readonly transkribieren: (wav: Uint8Array) => Promise<string>) {}

  async starten(): Promise<void> {
    if (this.aktiv) return;
    this.aktiv = true;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    src.connect(this.proc);
    this.proc.connect(this.ctx.destination);
    this.proc.onaudioprocess = (ev) => this.verarbeite(ev.inputBuffer.getChannelData(0));
  }

  stoppen(): void {
    this.aktiv = false;
    try { this.proc?.disconnect(); } catch { /* egal */ }
    for (const t of this.stream?.getAudioTracks() ?? []) t.stop();
    void this.ctx?.close().catch(() => undefined);
    this.proc = null; this.stream = null; this.ctx = null; this.chunks = []; this.sprichtSeit = null;
  }

  private verarbeite(data: Float32Array): void {
    if (!this.aktiv || !this.ctx) return;
    const rate = this.ctx.sampleRate;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
    const rms = Math.sqrt(sum / data.length);
    const jetzt = performance.now();
    this.chunks.push(new Float32Array(data));
    const maxChunks = Math.ceil((FENSTER_MS / 1000) * rate / data.length);
    while (this.chunks.length > maxChunks) this.chunks.shift();
    if (rms > SCHWELLE) {
      if (this.sprichtSeit === null) this.sprichtSeit = jetzt;
      this.letzteStimme = jetzt;
      if (jetzt - this.sprichtSeit >= FENSTER_MS) this.auswerten(rate);
      return;
    }
    if (this.sprichtSeit !== null && jetzt - this.letzteStimme > STILLE_MS) {
      if (jetzt - this.sprichtSeit >= MIN_MS) this.auswerten(rate);
      else this.sprichtSeit = null;
    }
  }

  private auswerten(rate: number): void {
    if (this.laeuft) { this.sprichtSeit = null; return; }
    this.laeuft = true;
    const wav = encodeWav(this.chunks, rate);
    this.chunks = [];
    this.sprichtSeit = null;
    void this.transkribieren(wav)
      .then((text) => { if (this.aktiv && istWachwort(text)) this.onWach(); })
      .catch(() => undefined)
      .finally(() => { this.laeuft = false; });
  }
}
