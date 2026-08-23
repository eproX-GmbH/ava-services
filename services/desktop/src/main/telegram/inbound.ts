// v0.1.417 — Gegenrichtung: Nachrichten AUS dem Telegram-Chat lesen und
// von AVA beantworten lassen.
//
// Spiegelt bewusst den Mail-Weg (mail/agent-bridge.ts):
// `orchestrator.startAutonomousConversation(...)` — also derselbe
// autonome Modus, den die Mail-Triage nutzt.
//
// SICHERHEIT — bewusste Entscheidungen:
//
//  * NUR der verknüpfte Chat wird akzeptiert. Jeder, der den Bot-Namen
//    kennt, kann ihm schreiben; alles außerhalb der konfigurierten
//    chatId wird verworfen und protokolliert.
//  * Eingehender Text ist NICHT vertrauenswürdig (Prompt-Injection).
//    Schutz ist der autonome Modus selbst: `askChoice` wirft dort
//    (ui-bridge.ts), d. h. alle Tools mit Bestätigungs-Dialog — allen
//    voran destruktive CRM-Operationen — können aus Telegram heraus
//    NICHT ausgeführt werden. Es fällt geschlossen aus.
//  * Standardmäßig AUS (`inboundEnabled`), muss aktiv eingeschaltet werden.
//  * Durchsatzbremse gegen Schleifen/Flut.
//
// Kein Webhook: Ein Desktop-Rechner hat keine öffentliche Adresse.
// Deshalb Long-Polling über getUpdates.

import type { AgentOrchestrator } from "../agent/orchestrator";
import type { AgentStreamFrame } from "../../shared/types";
import { escapeHtml, getUpdates, redactToken, sendMessage } from "./client";
import type { TelegramStore } from "./store";

/** Long-Poll-Fenster; bleibt unter dem 20-s-Request-Timeout des Clients. */
const LONG_POLL_SECONDS = 15;
/** Pause nach einem Fehler, damit wir die API nicht hämmern. */
const ERROR_BACKOFF_MS = 30_000;
/** Höchstzahl beantworteter Nachrichten pro Stunde (Schleifenschutz). */
const MAX_PER_HOUR = 30;
/** So lange warten wir höchstens auf die Antwort des Agenten. */
const REPLY_TIMEOUT_MS = 5 * 60_000;

export interface TelegramInboundDeps {
  store: TelegramStore;
  orchestrator: AgentOrchestrator;
  onAudit?: (entry: {
    severity: "info" | "warning" | "error";
    summary: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export class TelegramInbound {
  private readonly store: TelegramStore;
  private readonly orchestrator: AgentOrchestrator;
  private readonly onAudit?: TelegramInboundDeps["onAudit"];

  private running = false;
  private loopHandle: Promise<void> | null = null;
  private recentTimestamps: number[] = [];

  constructor(deps: TelegramInboundDeps) {
    this.store = deps.store;
    this.orchestrator = deps.orchestrator;
    this.onAudit = deps.onAudit;
  }

  /** Startet/stoppt anhand der aktuellen Konfiguration. Idempotent. */
  sync(): void {
    const cfg = this.store.getConfig();
    const should = cfg.inboundEnabled && cfg.chatId !== null;
    if (should && !this.running) this.start();
    else if (!should && this.running) this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log("[telegram] Eingang aktiviert — Long-Polling läuft");
    this.loopHandle = this.loop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    console.log("[telegram] Eingang deaktiviert");
  }

  // ---- intern -------------------------------------------------------------

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const cfg = this.store.getConfig();
        const token = await this.store.getToken();
        if (!token || !cfg.chatId || !cfg.inboundEnabled) {
          this.running = false;
          break;
        }
        const offset =
          cfg.lastUpdateId !== null ? cfg.lastUpdateId + 1 : undefined;
        const updates = await getUpdates(token, offset, LONG_POLL_SECONDS);
        if (!this.running) break;

        for (const u of updates) {
          // Offset IMMER fortschreiben — auch für verworfene Nachrichten,
          // sonst holen wir sie endlos erneut.
          this.store.setConfig({ lastUpdateId: u.updateId });

          if (u.chat.chatId !== cfg.chatId) {
            console.warn(
              `[telegram] Nachricht aus fremdem Chat ${u.chat.chatId} verworfen`,
            );
            this.onAudit?.({
              severity: "warning",
              summary:
                "Telegram-Nachricht aus einem nicht verknüpften Chat verworfen",
              metadata: { fromChatId: u.chat.chatId },
            });
            continue;
          }
          const text = u.chat.text.trim();
          if (!text) continue;
          if (text === "/start") {
            await this.reply(
              "Hi! Ich bin verbunden. Schreib mir einfach, was du wissen willst.",
            );
            continue;
          }
          if (!this.withinRateLimit()) {
            await this.reply(
              "Zu viele Anfragen in kurzer Zeit — ich pausiere kurz.",
            );
            continue;
          }
          await this.handleMessage(text);
        }
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? redactToken(err.message) : String(err);
        console.warn("[telegram] Eingang-Schleife:", msg);
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  private withinRateLimit(): boolean {
    const now = Date.now();
    this.recentTimestamps = this.recentTimestamps.filter(
      (t) => now - t < 60 * 60_000,
    );
    if (this.recentTimestamps.length >= MAX_PER_HOUR) return false;
    this.recentTimestamps.push(now);
    return true;
  }

  /** Eine Nachricht an den Agenten geben und die Antwort zurückschicken. */
  private async handleMessage(text: string): Promise<void> {
    const started = this.orchestrator.startAutonomousConversation({
      initialMessage:
        `[Nachricht des Nutzers über Telegram]\n\n${text}\n\n` +
        `[Hinweis: Antworte knapp und handyfreundlich. Es gibt hier keinen ` +
        `Bestätigungsdialog — Aktionen, die eine Rückfrage brauchen, kannst ` +
        `du nicht ausführen; sag in dem Fall, dass es am Rechner erledigt ` +
        `werden muss.]`,
    });

    if (!started) {
      await this.reply(
        "Ich bin gerade beschäftigt oder mein Modell ist nicht bereit — versuch es gleich nochmal.",
      );
      return;
    }

    this.onAudit?.({
      severity: "info",
      summary: `Telegram-Anfrage verarbeitet: ${text.slice(0, 80)}`,
      metadata: { conversationId: started.conversationId },
    });

    const answer = await this.awaitAnswer(started.requestId);
    await this.reply(
      answer && answer.trim().length > 0
        ? answer
        : "Ich konnte dazu leider keine Antwort erzeugen.",
    );
  }

  /** Sammelt die Antwort des Agenten aus den Stream-Frames. */
  private awaitAnswer(requestId: string): Promise<string> {
    return new Promise((resolve) => {
      let buf = "";
      let settled = false;
      const finish = (v: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.orchestrator.off("stream", onFrame);
        resolve(v);
      };
      const onFrame = (frame: AgentStreamFrame): void => {
        if (frame.requestId !== requestId) return;
        if (frame.kind === "token" && frame.delta) buf += frame.delta;
        else if (frame.kind === "done") finish(buf);
        else if (frame.kind === "error") {
          finish(buf || `Fehler: ${frame.message}`);
        }
      };
      const timer = setTimeout(
        () => finish(buf || "Zeitüberschreitung bei der Antwort."),
        REPLY_TIMEOUT_MS,
      );
      this.orchestrator.on("stream", onFrame);
    });
  }

  private async reply(text: string): Promise<void> {
    try {
      const cfg = this.store.getConfig();
      const token = await this.store.getToken();
      if (!token || !cfg.chatId) return;
      // Telegram-Limit ~4096 Zeichen.
      await sendMessage(token, cfg.chatId, escapeHtml(text).slice(0, 3900));
    } catch (err) {
      console.warn(
        "[telegram] Antwort senden fehlgeschlagen:",
        err instanceof Error ? redactToken(err.message) : err,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
