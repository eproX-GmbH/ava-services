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
import {
  downloadFile,
  escapeHtml,
  getUpdates,
  redactToken,
  sendMessage,
} from "./client";
import { decodeToWav16k } from "./audio";
import type { TelegramStore } from "./store";
import type { AgentMessageImage } from "../../shared/types";

/** Long-Poll-Fenster; bleibt unter dem 20-s-Request-Timeout des Clients. */
const LONG_POLL_SECONDS = 15;
/** Pause nach einem Fehler, damit wir die API nicht hämmern. */
const ERROR_BACKOFF_MS = 30_000;
/**
 * v0.1.419 — Mindestabstand zwischen zwei verarbeiteten Nachrichten.
 * Ersetzt die alte harte Obergrenze (30/Stunde): Ein RÜCKSTAU nach einer
 * Offline-Phase ist kein Missbrauch — er darf nicht abgewiesen, sondern nur
 * entzerrt werden. Sonst gingen genau die Anweisungen verloren, die
 * unterwegs diktiert wurden.
 */
const MIN_GAP_MS = 1_500;
/** So lange warten wir höchstens darauf, dass der Agent frei wird. */
const WAIT_FOR_AGENT_MS = 5 * 60_000;
/** So lange warten wir höchstens auf die Antwort des Agenten. */
const REPLY_TIMEOUT_MS = 5 * 60_000;

export interface TelegramInboundDeps {
  store: TelegramStore;
  orchestrator: AgentOrchestrator;
  /** v0.1.419 — lokale Transkription von Sprachnachrichten (Whisper). */
  transcribe?: (wav: Uint8Array) => Promise<{ text: string }>;
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
  private readonly transcribe?: TelegramInboundDeps["transcribe"];

  private running = false;
  private loopHandle: Promise<void> | null = null;
  private lastHandledAt = 0;

  constructor(deps: TelegramInboundDeps) {
    this.store = deps.store;
    this.orchestrator = deps.orchestrator;
    this.onAudit = deps.onAudit;
    this.transcribe = deps.transcribe;
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
          const hasMedia = Boolean(u.chat.photoFileId || u.chat.voiceFileId);
          if (!text && !hasMedia) continue;
          if (text === "/start") {
            await this.reply(
              "Hi! Ich bin verbunden. Schreib mir einfach, was du wissen willst.",
            );
            continue;
          }
          await this.pace();
          if (u.chat.voiceFileId) {
            await this.handleVoice(u.chat.voiceFileId);
          } else if (u.chat.photoFileId) {
            await this.handlePhoto(
              u.chat.photoFileId,
              u.chat.caption ?? text,
            );
          } else {
            await this.handleMessage(text);
          }
        }
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? redactToken(err.message) : String(err);
        console.warn("[telegram] Eingang-Schleife:", msg);
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  /** Entzerrt aufeinanderfolgende Anfragen, ohne welche zu verwerfen. */
  private async pace(): Promise<void> {
    const since = Date.now() - this.lastHandledAt;
    if (since < MIN_GAP_MS) await sleep(MIN_GAP_MS - since);
    this.lastHandledAt = Date.now();
  }

  /** Eine Nachricht an den Agenten geben und die Antwort zurückschicken. */
  private async handleMessage(
    text: string,
    images?: AgentMessageImage[],
  ): Promise<void> {
    // v0.1.419 — Der Orchestrator verarbeitet immer nur EINE Anfrage. War er
    // beschäftigt, meldete der Empfänger früher "bin beschäftigt" und die
    // Antwort ging verloren (der Orchestrator reiht intern zwar ein, aber
    // ohne dass wir das Ergebnis noch zuordnen könnten). Jetzt warten wir,
    // bis er frei ist — genau das braucht der Rückstau nach einer
    // Offline-Phase.
    const freeAt = Date.now() + WAIT_FOR_AGENT_MS;
    while (
      this.orchestrator.getStatus().inFlightRequestId !== null &&
      Date.now() < freeAt &&
      this.running
    ) {
      await sleep(2_000);
    }
    if (!this.running) return;

    const started = this.orchestrator.startAutonomousConversation({
      initialMessage:
        `[Nachricht des Nutzers über Telegram]\n\n${text}\n\n` +
        `[Hinweis: Antworte knapp und handyfreundlich. Es gibt hier keinen ` +
        `Bestätigungsdialog — Aktionen, die eine Rückfrage brauchen, kannst ` +
        `du nicht ausführen; sag in dem Fall, dass es am Rechner erledigt ` +
        `werden muss.]`,
      ...(images && images.length > 0 ? { images } : {}),
    });

    if (!started) {
      await this.reply(
        "Ich konnte das gerade nicht verarbeiten — mein Modell ist offenbar " +
          "nicht bereit. Schreib mir die Anweisung bitte gleich nochmal.",
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

  /**
   * v0.1.419 — Sprachnachricht: lokal per Whisper transkribieren und wie
   * eine getippte Anweisung behandeln. Die Transkription wird VORHER
   * zurückgeschickt, damit erkennbar ist, worauf AVA gleich handelt —
   * Namen und Zahlen verhört man leicht, und daraus wird womöglich ein
   * CRM-Eintrag.
   */
  private async handleVoice(fileId: string): Promise<void> {
    if (!this.transcribe) {
      await this.reply(
        "Ich kann Sprachnachrichten gerade nicht auswerten — die lokale " +
          "Spracherkennung ist nicht bereit (Einstellungen → Modelle → Voice).",
      );
      return;
    }
    const cfg = this.store.getConfig();
    const token = await this.store.getToken();
    if (!token || !cfg.chatId) return;

    const file = await downloadFile(token, fileId);
    if (!file) {
      await this.reply("Die Sprachnachricht konnte ich nicht laden.");
      return;
    }
    const wav = await decodeToWav16k(file.bytes);
    if (!wav) {
      await this.reply("Die Sprachnachricht konnte ich nicht dekodieren.");
      return;
    }
    let text = "";
    try {
      const r = await this.transcribe(wav);
      text = r.text.trim();
    } catch (err) {
      await this.reply(
        "Die Spracherkennung ist fehlgeschlagen: " +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (!text) {
      await this.reply("Ich habe in der Sprachnachricht nichts verstanden.");
      return;
    }
    await this.reply(`🎙️ Verstanden: „${text}"`);
    this.onAudit?.({
      severity: "info",
      summary: `Telegram-Sprachnachricht transkribiert: ${text.slice(0, 80)}`,
      metadata: { chars: text.length },
    });
    await this.handleMessage(text);
  }

  /** v0.1.419 — Foto an den Agenten geben (Bildunterschrift als Anweisung). */
  private async handlePhoto(fileId: string, caption: string): Promise<void> {
    const token = await this.store.getToken();
    if (!token) return;
    const file = await downloadFile(token, fileId);
    if (!file) {
      await this.reply("Das Bild konnte ich nicht laden.");
      return;
    }
    const prompt =
      caption.trim().length > 0
        ? caption.trim()
        : "Was ist auf diesem Bild zu sehen? Fasse das Wichtigste zusammen.";
    await this.handleMessage(prompt, [
      {
        base64: file.bytes.toString("base64"),
        mimeType: file.mimeHint.startsWith("image/")
          ? file.mimeHint
          : "image/jpeg",
        filename: "telegram-foto.jpg",
      },
    ]);
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
