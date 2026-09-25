// Sprachmodus — WebRTC-Verbindung zu GPT Live (gpt-live-1), 2026-09-25.
//
// Anders als bei der Realtime API entsteht die Sitzung serverseitig: Der
// Renderer erzeugt das SDP-Angebot, der Hauptprozess legt die Sitzung mit
// dem Schluessel an (IPC sprache:liveSitzung) und liefert die SDP-Antwort.
// Audio laeuft ueber die Medienspuren, Ereignisse ueber den Datenkanal
// "oai-events". Gleiche Oberflaeche wie RealtimeVerbindung, damit die
// Seite beide Wege bedienen kann (Realtime bleibt Rueckfall).

import { fehlerEinordnen, type RealtimeCallbacks, type RealtimeEreignis } from "./realtime";

export class LiveVerbindung {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private ausgabe: AnalyserNode | null = null;
  private eingang: AnalyserNode | null = null;
  private puffer = new Uint8Array(256);
  private wartend: string[] = [];
  private zaehler = 0;
  sessionId = "";
  model = "gpt-live-1";

  constructor(private readonly cb: RealtimeCallbacks) {}

  async verbinden(sitzungAnlegen: (sdpOffer: string) => Promise<{ sessionId: string; sdpAnswer: string; model: string }>): Promise<void> {
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
        try { this.cb.onEreignis(JSON.parse(String(m.data)) as RealtimeEreignis); } catch { /* kein JSON */ }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") this.cb.onZustand("fehler", `Verbindung ${pc.connectionState}`);
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // ICE-Kandidaten kurz einsammeln, damit die Antwort direkt passt.
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 1500);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } };
      });
      const sdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
      const antwort = await sitzungAnlegen(sdp);
      this.sessionId = antwort.sessionId;
      this.model = antwort.model;
      await pc.setRemoteDescription({ type: "answer", sdp: antwort.sdpAnswer });
    } catch (err) {
      this.schliessen();
      const f = fehlerEinordnen(err);
      this.cb.onZustand("fehler", f.message);
      throw f;
    }
  }

  /** Ereignis senden; event_id wird ergaenzt, wenn es fehlt. */
  senden(e: RealtimeEreignis): void {
    const mitId = { event_id: `ev_${++this.zaehler}`, ...e };
    const s = JSON.stringify(mitId);
    if (this.dc && this.dc.readyState === "open") this.dc.send(s);
    else this.wartend.push(s);
  }

  mikrofon(an: boolean): void {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = an;
    this.senden({ type: an ? "session.input_audio.unmute" : "session.input_audio.mute" });
  }

  pegelAusgabe(): number { return this.pegel(this.ausgabe); }
  pegelEingang(): number { return this.pegel(this.eingang); }
  private pegel(a: AnalyserNode | null): number {
    if (!a) return 0;
    a.getByteTimeDomainData(this.puffer);
    let sum = 0;
    for (let i = 0; i < this.puffer.length; i++) { const v = (this.puffer[i]! - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / this.puffer.length) * 4);
  }

  offen(): boolean { return this.dc?.readyState === "open"; }

  /** Sauber beenden: session.close schicken, kurz auf session.closed warten, dann abbauen. */
  async beenden(): Promise<void> {
    if (this.dc && this.dc.readyState === "open") {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        const alt = this.dc!.onmessage;
        this.dc!.onmessage = (m) => {
          alt?.call(this.dc!, m);
          try { if ((JSON.parse(String(m.data)) as { type?: string }).type === "session.closed") { clearTimeout(t); resolve(); } } catch { /* egal */ }
        };
        this.senden({ type: "session.close" });
      });
    }
    this.schliessen();
  }

  schliessen(): void {
    try { this.dc?.close(); } catch { /* egal */ }
    try { this.pc?.close(); } catch { /* egal */ }
    for (const t of this.mic?.getAudioTracks() ?? []) t.stop();
    if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl = null; }
    void this.ctx?.close().catch(() => undefined);
    this.dc = null; this.pc = null; this.mic = null; this.ctx = null; this.ausgabe = null; this.eingang = null;
  }
}

/** Text in Happen von hoechstens ~1400 Zeichen (≈ 500 Token) an Satzgrenzen. */
export function inHappen(text: string, max = 1400): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t ? [t] : [];
  const aus: string[] = [];
  let rest = t;
  while (rest.length > max) {
    let schnitt = rest.lastIndexOf(". ", max);
    if (schnitt < max * 0.5) schnitt = rest.lastIndexOf(" ", max);
    if (schnitt < max * 0.3) schnitt = max;
    aus.push(rest.slice(0, schnitt + 1).trim());
    rest = rest.slice(schnitt + 1).trim();
  }
  if (rest) aus.push(rest);
  return aus;
}
