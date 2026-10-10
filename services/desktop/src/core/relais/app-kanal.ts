// App-Kanal (docs/PLAN_APP_PWA.md §3.2/§3.3): die AVA-App (app.ava.bi) als
// zweite Oberfläche dieser AVA, über das Kopf-Relais des Gateways.
//
// Anfragen kommen als {typ: "app", id, art, daten} und werden mit
// {typ: "ergebnis", id, text: JSON} beantwortet. Frames des Orchestrators
// (Token, Werkzeugschritte, Rückfragen, Ende) gehen als {typ: "app-frame"}
// an den Gateway, solange dort eine App lauscht (Abo, verlängert vom Gateway).
// Die App ist eine echte Oberfläche: Rückfragen werden interaktiv über
// answerChoice beantwortet, wie im Desktop-Fenster.
//
// Eine Anfrage zur Zeit (Orchestrator): Ist die AVA beschäftigt, wartet die
// Nachricht in einer kleinen Warteschlange (höchstens 3, 10 Minuten) und
// startet, sobald die AVA frei ist (E5).

import { randomUUID } from "node:crypto";
import type { AgentMessage, AgentMessageImage, AgentPendingPrompt, AgentSendInput, AgentStatus, AgentStreamFrame } from "../../shared/types";

/** Was der App-Kanal vom Orchestrator braucht (Tests geben eine Attrappe). */
export interface AppAgent {
  send(input: AgentSendInput): { requestId: string };
  abort(requestId?: string): void;
  answerChoice(choiceId: string, value: string): void;
  getStatus(): AgentStatus;
  getPendingPrompts(conversationId: string): AgentPendingPrompt[];
  on(ev: "stream", cb: (f: AgentStreamFrame) => void): unknown;
  on(ev: "status", cb: (s: AgentStatus) => void): unknown;
  emit(ev: "stream", f: AgentStreamFrame): boolean;
}

export interface AppGespraeche {
  list(): Array<{ conversationId: string; modifiedAt: number; label: string }>;
  load(id: string): AgentMessage[];
  delete(id: string): boolean;
}

/** Was an die App geht: Agent-Frames, Sprach-Ergebnisse oder Ereignisse des Kanals selbst. */
export type AppFrame =
  | { kanal: "agent"; frame: AgentStreamFrame }
  | { kanal: "sprache"; art: "ergebnis" | "fortschritt"; daten: unknown }
  | { kanal: "app"; ereignis: AppEreignis };

export type AppEreignis =
  | { art: "durchlauf"; aktiv: boolean; requestId: string | null; conversationId: string | null }
  | { art: "gestartet"; warteId: string; requestId: string; conversationId: string }
  | { art: "verworfen"; warteId: string; conversationId: string; grund: string }
  | { art: "warteschlange"; laenge: number }
  | { art: "meldungen"; ungelesen: number };

/** Optionale Fähigkeiten (P3–P7); fehlt eine, antwortet der Kanal „nicht verfügbar“. */
export interface AppKanalExtras {
  /** Mail-Entwurf als .eml mit Anhängen (docs/PLAN_MAIL_ENTWURF.md E4); `entwurf` = Inhalt des Blocks. */
  mailEml?: (entwurf: unknown) => Promise<{ base64: string; dateiname: string }>;
  /** Bild aus dem Verlauf auf höchstens `kante` Pixel verkleinern (Server: Original). */
  bild?: (bild: AgentMessageImage, kante: number) => AgentMessageImage;
  anhang?: (input: { filename: string; bytes: Uint8Array; conversationId?: string }) => Promise<unknown>;
  transkribieren?: (wav: Uint8Array) => Promise<unknown>;
  sprache?: {
    stand: () => unknown;
    /** Sprachmodus einschalten (die App öffnet die Sprachblase). */
    einschalten: () => unknown;
    sitzung: () => Promise<unknown>;
    live: (sdpOffer: string) => Promise<unknown>;
    auftrag: (input: { conversationId: string; text: string; images?: AgentMessageImage[] }) => unknown;
    rueckfrage: (choiceId: string, wert: string) => unknown;
    abbrechen: () => void;
    verbrauch: (v: { model: string; latencyMs?: number; usage: Record<string, number>; sekunden?: number }) => Promise<unknown>;
  };
  meldungen?: {
    liste: (limit: number) => unknown[];
    ungelesen: () => number;
    gesehen: (id: string) => boolean;
    verwerfen: (id: string) => boolean;
    alleGesehen: () => number;
  };
  push?: {
    schluessel: () => string;
    abonnieren: (abo: { endpoint: string; keys: { p256dh: string; auth: string } }, geraet: string) => number;
    abbestellen: (endpoint: string) => boolean;
    hatAbo: (endpoint: string) => boolean;
    test: () => Promise<unknown>;
  };
}

const ANHANG_TEILE_MAX = 40;
const ANHANG_MS = 10 * 60_000;

export interface AppKanalDeps {
  agent: AppAgent;
  gespraeche: AppGespraeche;
  /** Sendet einen Frame an den Gateway (nur bei offenem Relais). */
  senden: (frame: AppFrame) => void;
  instanzName: () => string;
  log?: (zeile: string) => void;
  extras?: AppKanalExtras;
}

const ABO_MS = 150_000;
const WARTE_MAX = 3;
const WARTE_MS = 10 * 60_000;
const MAX_NACHRICHTEN = 200;
const MAX_INHALT = 40_000;

interface Wartend {
  warteId: string;
  input: AgentSendInput;
  bis: number;
}

export class AppFehler extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class AppKanal {
  private aboBis = 0;
  private warteschlange: Wartend[] = [];
  private letzterDurchlauf: string | null = null;
  private uploads = new Map<string, { teile: string[]; bis: number }>();

  constructor(private readonly deps: AppKanalDeps) {
    deps.agent.on("stream", (frame) => {
      if (this.abo()) this.deps.senden({ kanal: "agent", frame });
    });
    deps.agent.on("status", (s) => this.statusGeaendert(s));
  }

  private abo(): boolean {
    return this.aboBis > Date.now();
  }

  /** Sprach-Ergebnisse und -Fortschritt (SpracheRelay) an die App. */
  spracheSenden(art: "ergebnis" | "fortschritt", daten: unknown): void {
    if (this.abo()) this.deps.senden({ kanal: "sprache", art, daten });
  }

  /** Meldungen haben sich geändert (neu, gelesen, verworfen). */
  meldungenGeaendert(): void {
    const m = this.deps.extras?.meldungen;
    if (m && this.abo()) this.deps.senden({ kanal: "app", ereignis: { art: "meldungen", ungelesen: m.ungelesen() } });
  }

  private extra<K extends keyof AppKanalExtras>(k: K): NonNullable<AppKanalExtras[K]> {
    const e = this.deps.extras?.[k];
    if (!e) throw new AppFehler("nicht_verfuegbar", "Diese AVA unterstützt das noch nicht (Update nötig).");
    return e as NonNullable<AppKanalExtras[K]>;
  }

  private statusGeaendert(s: AgentStatus): void {
    if (s.inFlightRequestId !== this.letzterDurchlauf) {
      this.letzterDurchlauf = s.inFlightRequestId;
      if (this.abo()) {
        this.deps.senden({ kanal: "app", ereignis: { art: "durchlauf", aktiv: s.inFlightRequestId !== null, requestId: s.inFlightRequestId, conversationId: s.inFlightConversationId } });
      }
    }
    if (s.inFlightRequestId === null) this.naechsterAusWarteschlange();
  }

  private naechsterAusWarteschlange(): void {
    const jetzt = Date.now();
    while (this.warteschlange.length) {
      const w = this.warteschlange.shift()!;
      if (w.bis < jetzt) {
        this.deps.senden({ kanal: "app", ereignis: { art: "verworfen", warteId: w.warteId, conversationId: w.input.conversationId, grund: "AVA war zu lange beschäftigt." } });
        continue;
      }
      try {
        const { requestId } = this.starten(w.input);
        this.deps.senden({ kanal: "app", ereignis: { art: "gestartet", warteId: w.warteId, requestId, conversationId: w.input.conversationId } });
      } catch (err) {
        this.deps.senden({ kanal: "app", ereignis: { art: "verworfen", warteId: w.warteId, conversationId: w.input.conversationId, grund: err instanceof Error ? err.message : String(err) } });
      }
      return;
    }
  }

  /** Startet einen Durchlauf und zeigt die Nutzernachricht allen Oberflächen. */
  private starten(input: AgentSendInput): { requestId: string } {
    const { requestId } = this.deps.agent.send(input);
    this.deps.agent.emit("stream", {
      kind: "user-message",
      requestId,
      conversationId: input.conversationId,
      messageId: randomUUID(),
      content: input.message,
      source: "app",
    });
    return { requestId };
  }

  /** Stand für die App: wer antwortet, ob die AVA frei ist, Warteschlange. */
  private stand() {
    const s = this.deps.agent.getStatus();
    return {
      instanz: this.deps.instanzName(),
      bereit: s.ready,
      modell: s.model,
      fehler: s.errorMessage,
      beschaeftigt: s.inFlightRequestId !== null,
      durchlauf: s.inFlightRequestId ? { requestId: s.inFlightRequestId, conversationId: s.inFlightConversationId } : null,
      warteschlange: this.warteschlange.length,
    };
  }

  async anfrage(art: string, daten: Record<string, unknown>): Promise<unknown> {
    switch (art) {
      case "abo":
        this.aboBis = daten.an === false ? 0 : Date.now() + ABO_MS;
        return { ok: true, bis: this.aboBis };
      case "stand":
        return this.stand();
      case "senden":
        return this.senden(daten);
      case "abbrechen": {
        const s = this.deps.agent.getStatus();
        const requestId = typeof daten.requestId === "string" ? daten.requestId : null;
        // Nur den angegebenen Durchlauf abbrechen, nie fremde Arbeit (Telegram, Workflows).
        if (!requestId || s.inFlightRequestId !== requestId) return { abgebrochen: false };
        this.deps.agent.abort(requestId);
        return { abgebrochen: true };
      }
      case "warteschlange_entfernen": {
        const vorher = this.warteschlange.length;
        this.warteschlange = this.warteschlange.filter((w) => w.warteId !== daten.warteId);
        return { entfernt: vorher !== this.warteschlange.length };
      }
      case "antwort": {
        if (typeof daten.choiceId !== "string" || typeof daten.wert !== "string") throw new AppFehler("ungueltig", "choiceId und wert fehlen.");
        this.deps.agent.answerChoice(daten.choiceId, daten.wert);
        return { ok: true };
      }
      case "offene_fragen":
        return { fragen: this.deps.agent.getPendingPrompts(String(daten.conversationId ?? "")) };
      case "gespraeche":
        return {
          gespraeche: this.deps.gespraeche
            .list()
            .slice(0, Math.min(200, Number(daten.limit) || 100))
            .map((g) => ({ id: g.conversationId, titel: g.label || "Neues Gespräch", geaendert: new Date(g.modifiedAt).toISOString() })),
        };
      case "gespraech":
        return this.gespraech(String(daten.conversationId ?? ""));
      case "bild":
        return this.bild(daten);
      case "mail_eml": {
        const bauen = this.extra("mailEml");
        try {
          return await bauen(daten.entwurf);
        } catch (err) {
          throw new AppFehler("ungueltig", err instanceof Error ? err.message : String(err));
        }
      }
      case "gespraech_loeschen": {
        const id = String(daten.conversationId ?? "");
        if (this.deps.agent.getStatus().inFlightConversationId === id) throw new AppFehler("beschaeftigt", "Das Gespräch läuft gerade.");
        return { geloescht: this.deps.gespraeche.delete(id) };
      }
      // ---- P3 Anhänge: in Teilen (Base64, je höchstens ~768 KB), dann aufbereiten.
      case "anhang_teil": {
        const id = String(daten.uploadId ?? "");
        const index = Number(daten.index);
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !Number.isInteger(index) || index < 0 || index >= ANHANG_TEILE_MAX || typeof daten.base64 !== "string") {
          throw new AppFehler("ungueltig", "Ungültiger Upload-Teil.");
        }
        for (const [k, u] of this.uploads) if (u.bis < Date.now()) this.uploads.delete(k);
        const u = this.uploads.get(id) ?? { teile: [], bis: Date.now() + ANHANG_MS };
        u.teile[index] = daten.base64;
        this.uploads.set(id, u);
        return { ok: true };
      }
      case "anhang_fertig": {
        const id = String(daten.uploadId ?? "");
        const u = this.uploads.get(id);
        this.uploads.delete(id);
        const anzahl = Number(daten.teile);
        if (!u || u.teile.length !== anzahl || u.teile.some((t) => typeof t !== "string")) throw new AppFehler("ungueltig", "Upload unvollständig, bitte erneut senden.");
        const bytes = new Uint8Array(Buffer.concat(u.teile.map((t) => Buffer.from(t, "base64"))));
        const filename = String(daten.filename ?? "datei").replace(/[\\/]/g, "_").slice(0, 200);
        return this.extra("anhang")({ filename, bytes, ...(typeof daten.conversationId === "string" ? { conversationId: daten.conversationId } : {}) });
      }
      // ---- P4 Diktat
      case "transkribieren": {
        if (typeof daten.wav !== "string") throw new AppFehler("ungueltig", "Aufnahme fehlt.");
        return this.extra("transkribieren")(new Uint8Array(Buffer.from(daten.wav, "base64")));
      }
      // ---- P6 Sprache
      case "sprache_stand":
        return this.extra("sprache").stand();
      case "sprache_einschalten":
        return this.extra("sprache").einschalten();
      case "sprache_sitzung":
        return this.extra("sprache").sitzung();
      case "sprache_live":
        if (typeof daten.sdpOffer !== "string") throw new AppFehler("ungueltig", "SDP-Angebot fehlt.");
        return this.extra("sprache").live(daten.sdpOffer);
      case "sprache_auftrag":
        return this.extra("sprache").auftrag({ conversationId: String(daten.conversationId ?? ""), text: String(daten.text ?? ""), ...(Array.isArray(daten.bilder) ? { images: daten.bilder as AgentMessageImage[] } : {}) });
      case "sprache_rueckfrage":
        return this.extra("sprache").rueckfrage(String(daten.choiceId ?? ""), String(daten.wert ?? ""));
      case "sprache_abbrechen":
        this.extra("sprache").abbrechen();
        return { ok: true };
      case "sprache_verbrauch":
        return this.extra("sprache").verbrauch(daten as { model: string; usage: Record<string, number> });
      // ---- P7 Meldungen und Push
      case "meldungen": {
        const m = this.extra("meldungen");
        return { meldungen: m.liste(Math.min(200, Number(daten.limit) || 100)), ungelesen: m.ungelesen() };
      }
      case "meldung_status": {
        const m = this.extra("meldungen");
        const id = String(daten.id ?? "");
        const r = daten.aktion === "alle_gesehen" ? m.alleGesehen() : daten.aktion === "verwerfen" ? m.verwerfen(id) : m.gesehen(id);
        this.meldungenGeaendert();
        return { ok: true, ergebnis: r, ungelesen: m.ungelesen() };
      }
      case "push_schluessel": {
        const p = this.extra("push");
        return { schluessel: p.schluessel(), abonniert: typeof daten.endpoint === "string" ? p.hatAbo(daten.endpoint) : false };
      }
      case "push_abo": {
        const p = this.extra("push");
        if (daten.an === false) return { abbestellt: p.abbestellen(String(daten.endpoint ?? "")) };
        const abo = daten.abo as { endpoint: string; keys: { p256dh: string; auth: string } };
        return { geraete: p.abonnieren(abo, String(daten.geraet ?? "Gerät")) };
      }
      case "push_test":
        return this.extra("push").test();
      default:
        throw new AppFehler("unbekannt", `Unbekannte App-Anfrage: ${art}`);
    }
  }

  private senden(daten: Record<string, unknown>) {
    const nachricht = typeof daten.nachricht === "string" ? daten.nachricht.trim() : "";
    const bilder = Array.isArray(daten.bilder) ? (daten.bilder as AgentMessageImage[]).slice(0, 8) : [];
    if (!nachricht && bilder.length === 0) throw new AppFehler("ungueltig", "Nachricht fehlt.");
    const conversationId = typeof daten.conversationId === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(daten.conversationId) ? daten.conversationId : randomUUID();
    const input: AgentSendInput = { conversationId, message: nachricht, ...(bilder.length ? { images: bilder } : {}), quelle: "app" };
    const s = this.deps.agent.getStatus();
    if (!s.ready) throw new AppFehler("nicht_bereit", s.errorMessage ?? "AVA ist noch nicht bereit (kein KI-Modell eingerichtet).");
    if (s.inFlightRequestId === null && this.warteschlange.length === 0) {
      const { requestId } = this.starten(input);
      return { status: "gestartet", requestId, conversationId };
    }
    if (this.warteschlange.length >= WARTE_MAX) throw new AppFehler("beschaeftigt", "AVA ist beschäftigt und die Warteschlange ist voll. Bitte gleich nochmal versuchen.");
    const warteId = randomUUID();
    this.warteschlange.push({ warteId, input, bis: Date.now() + WARTE_MS });
    this.deps.senden({ kanal: "app", ereignis: { art: "warteschlange", laenge: this.warteschlange.length } });
    return { status: "wartet", warteId, position: this.warteschlange.length, conversationId };
  }

  /** Gesprächsverlauf für die Anzeige: Nutzer- und AVA-Nachrichten, Werkzeugnamen, keine Bilddaten. */
  /** Ein Bild aus dem Verlauf (die Liste trägt nur Name und Typ). */
  private bild(daten: Record<string, unknown>) {
    const conversationId = String(daten.conversationId ?? "");
    const messageId = String(daten.messageId ?? "");
    const index = Number(daten.index ?? 0);
    if (!conversationId || !messageId || !Number.isInteger(index) || index < 0) throw new AppFehler("ungueltig", "conversationId, messageId und index nötig.");
    const nachricht = this.deps.gespraeche.load(conversationId).find((m) => m.id === messageId);
    const bild = nachricht?.images?.[index];
    if (!bild) throw new AppFehler("nicht_gefunden", "Das Bild gibt es nicht (mehr).");
    try {
      const b = this.extra("bild")(bild, daten.gross === true ? 2048 : 800);
      return { base64: b.base64, mimeType: b.mimeType, filename: b.filename ?? null };
    } catch (err) {
      if (err instanceof AppFehler) throw err;
      throw new AppFehler("zu_gross", err instanceof Error ? err.message : String(err));
    }
  }

  private gespraech(id: string) {
    if (!id) throw new AppFehler("ungueltig", "conversationId fehlt.");
    const alle = this.deps.gespraeche.load(id);
    const nachrichten = alle
      .filter((m) => m.role === "user" || m.role === "assistant")
      .filter((m) => m.content.trim() || (m.toolCalls?.length ?? 0) > 0)
      .slice(-MAX_NACHRICHTEN)
      .map((m) => ({
        id: m.id,
        rolle: m.role,
        text: m.content.length > MAX_INHALT ? `${m.content.slice(0, MAX_INHALT)}…` : m.content,
        zeit: new Date(m.createdAt).toISOString(),
        ...(m.toolCalls?.length ? { werkzeuge: m.toolCalls.map((t) => t.name) } : {}),
        ...(m.images?.length ? { bilder: m.images.map((b) => ({ mimeType: b.mimeType, filename: b.filename ?? null })) } : {}),
        ...(m.quelle ? { quelle: m.quelle } : {}),
      }));
    return { id, nachrichten, offeneFragen: this.deps.agent.getPendingPrompts(id), laeuft: this.deps.agent.getStatus().inFlightConversationId === id };
  }
}
