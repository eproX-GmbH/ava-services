// Sprachmodus — WebRTC-Verbindung zur OpenAI Realtime API (docs/PLAN_SPRACHMODUS.md, S1).
//
// Der Renderer bekommt vom Hauptprozess nur den ephemeren Client-Schluessel
// (ek_…). Damit: SDP-Angebot an https://api.openai.com/v1/realtime/calls,
// Audio rein (Mikrofon) und raus (Remote-Track), Ereignisse ueber den
// Datenkanal "oai-events". Pegel fuer die Kugel kommen aus zwei
// AnalyserNodes (Ausgabe und Mikrofon).

export interface RealtimeEreignis { type: string; [k: string]: unknown }

/** Fehlerbild fuer die Oberflaeche (S6): Ursache, Text, was hilft. */
export type SpracheFehlerArt = "mikrofon-verweigert" | "kein-mikrofon" | "netz" | "schluessel" | "kontingent" | "sonstiges";
export class SpracheFehler extends Error {
  /** Originalmeldung (z. B. von OpenAI), klein unter der Erklaerung gezeigt. */
  public readonly detail: string | null;
  constructor(public readonly art: SpracheFehlerArt, message: string, detail?: string | null) { super(message); this.name = "SpracheFehler"; this.detail = detail ?? null; }
}

export function fehlerEinordnen(err: unknown): SpracheFehler {
  if (err instanceof SpracheFehler) return err;
  const e = err as { name?: string; message?: string } | null;
  const name = e?.name ?? "";
  const msg = e?.message ?? String(err);
  if (name === "NotAllowedError" || name === "SecurityError" || /permission|verweigert|denied/i.test(msg)) return new SpracheFehler("mikrofon-verweigert", "Der Zugriff auf das Mikrofon wurde verweigert.", msg.slice(0, 240));
  if (name === "NotFoundError" || name === "OverconstrainedError" || /kein mikrofon|no audio|device not found/i.test(msg)) return new SpracheFehler("kein-mikrofon", "Kein Mikrofon gefunden.", msg.slice(0, 240));
  if (/HTTP 401|HTTP 403|invalid_api_key|incorrect api key|schl(ü|ue)ssel/i.test(msg)) return new SpracheFehler("schluessel", "Der OpenAI-Schlüssel wurde abgelehnt.", msg.slice(0, 240));
  if (/HTTP 429|quota|kontingent|insufficient_quota|rate limit/i.test(msg)) return new SpracheFehler("kontingent", "Das Kontingent bei OpenAI ist erschöpft oder das Limit erreicht.", msg.slice(0, 240));
  if (/Failed to fetch|NetworkError|ECONN|ENOTFOUND|Verbindung (failed|disconnected)|\bICE\b|timeout|upstream_unreachable|HTTP 5\d\d/i.test(msg)) return new SpracheFehler("netz", "Keine Verbindung zu OpenAI.", msg.slice(0, 240));
  return new SpracheFehler("sonstiges", msg || "Unbekannter Fehler.");
}

export interface RealtimeCallbacks {
  onEreignis: (e: RealtimeEreignis) => void;
  onZustand: (z: "verbindet" | "offen" | "geschlossen" | "fehler", detail?: string) => void;
}

export class RealtimeVerbindung {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private ausgabe: AnalyserNode | null = null;
  private eingang: AnalyserNode | null = null;
  private puffer = new Uint8Array(256);
  private wartend: string[] = [];

  constructor(private readonly cb: RealtimeCallbacks) {}

  async verbinden(clientSecret: string, model: string): Promise<void> {
    this.cb.onZustand("verbindet");
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.ctx = new AudioContext();
      const micQuelle = this.ctx.createMediaStreamSource(this.mic);
      this.eingang = this.ctx.createAnalyser();
      this.eingang.fftSize = 512;
      micQuelle.connect(this.eingang);

      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.audioEl = document.createElement("audio");
      this.audioEl.autoplay = true;
      pc.ontrack = (ev) => {
        const [stream] = ev.streams;
        if (!stream || !this.audioEl || !this.ctx) return;
        this.audioEl.srcObject = stream;
        const q = this.ctx.createMediaStreamSource(stream);
        this.ausgabe = this.ctx.createAnalyser();
        this.ausgabe.fftSize = 512;
        q.connect(this.ausgabe);
      };
      for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onopen = () => {
        for (const w of this.wartend) dc.send(w);
        this.wartend = [];
        this.cb.onZustand("offen");
      };
      dc.onclose = () => this.cb.onZustand("geschlossen");
      dc.onmessage = (m) => {
        try {
          this.cb.onEreignis(JSON.parse(String(m.data)) as RealtimeEreignis);
        } catch {
          /* kein JSON */
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") this.cb.onZustand("fehler", `Verbindung ${pc.connectionState}`);
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${clientSecret}`, "content-type": "application/sdp" },
        body: offer.sdp ?? "",
      });
      if (!res.ok) throw new Error(`OpenAI antwortet mit HTTP ${res.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch (err) {
      this.schliessen();
      const f = fehlerEinordnen(err);
      this.cb.onZustand("fehler", f.message);
      throw f;
    }
  }

  senden(e: RealtimeEreignis): void {
    const s = JSON.stringify(e);
    if (this.dc && this.dc.readyState === "open") this.dc.send(s);
    else this.wartend.push(s);
  }

  mikrofon(an: boolean): void {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = an;
  }

  /** 0..1, grob der Lautstaerke folgend. */
  pegelAusgabe(): number { return this.pegel(this.ausgabe); }
  pegelEingang(): number { return this.pegel(this.eingang); }

  private pegel(a: AnalyserNode | null): number {
    if (!a) return 0;
    a.getByteTimeDomainData(this.puffer);
    let sum = 0;
    for (let i = 0; i < this.puffer.length; i++) { const v = (this.puffer[i]! - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / this.puffer.length);
    return Math.min(1, rms * 4);
  }

  offen(): boolean { return this.dc?.readyState === "open"; }

  schliessen(): void {
    try { this.dc?.close(); } catch { /* egal */ }
    try { this.pc?.close(); } catch { /* egal */ }
    for (const t of this.mic?.getAudioTracks() ?? []) t.stop();
    if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl = null; }
    void this.ctx?.close().catch(() => undefined);
    this.dc = null; this.pc = null; this.mic = null; this.ctx = null; this.ausgabe = null; this.eingang = null;
  }
}

/** Kurzer Signalton beim Aufwachen (wie bei Alexa), zwei steigende Toene. */
export function signalton(): void {
  try {
    const ctx = new AudioContext();
    const t0 = ctx.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * 0.13);
      g.gain.linearRampToValueAtTime(0.18, t0 + i * 0.13 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.13 + 0.14);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0 + i * 0.13); o.stop(t0 + i * 0.13 + 0.15);
    }
    setTimeout(() => void ctx.close(), 600);
  } catch { /* kein Ton */ }
}
