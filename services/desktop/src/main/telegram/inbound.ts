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
import type { RemoteAskHandler } from "../agent/ui-bridge";
import type {
  AgentChoiceOption,
  AgentStreamFrame,
} from "../../shared/types";
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
/**
 * v0.1.420 — Kommen ZUERST Bilder, warten wir auf die Erklärung dazu.
 * Bewusst großzügig: In der Praxis schickt man erst die Fotos und spricht
 * danach eine längere Sprachnachricht ein — 5–10 Sekunden wären dafür viel
 * zu knapp. Kommt in dieser Zeit nichts, werden die Bilder allein verarbeitet.
 */
const MEDIA_WAIT_MS = 5 * 60_000;
/** Nach so langer Funkstille beginnt ein neuer Gesprächsfaden. */
const CONVERSATION_IDLE_MS = 6 * 60 * 60_000;
/** Ab so vielen Nachrichten im Faden wird neu begonnen (Kontextgrenze). */
const MAX_THREAD_MESSAGES = 60;
/** So lange warten wir höchstens auf die Antwort des Agenten. */
const REPLY_TIMEOUT_MS = 5 * 60_000;
/**
 * v0.1.459 — T6: Rückfragen aufs Handy. So lange darf eine Antwort auf
 * eine askChoice/askText-Rückfrage ausbleiben, bevor die Aktion
 * abgebrochen wird (fail-closed wie bisher).
 */
const ASK_TIMEOUT_MS = 3 * 60_000;
/** Poll-Fenster WÄHREND einer offenen Rückfrage (kurz, damit Timeout
 *  und Abort zeitnah greifen). */
const ASK_POLL_SECONDS = 10;

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
  /** v0.1.420 — laufender Gesprächsfaden (wie ein normaler AVA-Chat). */
  private conversationId: string | null = null;
  private lastActivityAt = 0;
  private threadMessages = 0;
  /** Gepufferte Bilder, die auf eine Erklärung warten. */
  private pendingImages: AgentMessageImage[] = [];
  private pendingCaptions: string[] = [];
  private mediaTimer: NodeJS.Timeout | null = null;

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
    if (this.mediaTimer) {
      clearTimeout(this.mediaTimer);
      this.mediaTimer = null;
    }
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
          if (text === "/neu" || text === "/reset") {
            this.resetThread();
            await this.reply("Alles klar — ich fange einen neuen Faden an.");
            continue;
          }
          if (text === "/start") {
            await this.reply(
              "Hi! Ich bin verbunden. Schreib mir einfach, was du wissen willst.",
            );
            continue;
          }
          await this.pace();
          if (u.chat.photoFileId) {
            // Bild: sammeln und auf die Erklärung warten.
            await this.bufferPhoto(u.chat.photoFileId, u.chat.caption ?? "");
          } else if (u.chat.voiceFileId) {
            // Sprachnachricht: transkribieren und ZUSAMMEN mit evtl.
            // wartenden Bildern als EINE Anfrage verarbeiten.
            await this.handleVoice(u.chat.voiceFileId);
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

    // v0.1.420 — Wartende Bilder gehören zu DIESER Anweisung.
    const buffered = this.takeBufferedImages();
    const allImages = [...(buffered.images ?? []), ...(images ?? [])];
    const withCaptions =
      buffered.captions.length > 0
        ? `${buffered.captions.join("\n")}\n\n${text}`
        : text;

    // v0.1.459 — T6: Sind Rückfragen aufs Handy erlaubt (Opt-in), bekommt
    // die Konversation einen RemoteAsk-Kanal und der Hinweis-Text ändert
    // sich entsprechend. Der Nutzer sitzt ja gerade am Handy.
    const inboundCfg = this.store.getConfig();
    const confirmEnabled = inboundCfg.inboundConfirmEnabled;
    // v0.1.462 — Vollmacht: deckt Klasse-A-(/B-)Aktionen ohne Rückfrage
    // (PLAN_VOLLMACHT.md). Nicht Gedecktes fällt auf T6-Rückfrage bzw.
    // fail-closed zurück.
    const autonomyLevel = inboundCfg.autonomyLevel;
    const hint = confirmEnabled
      ? `[Hinweis: Antworte knapp und handyfreundlich. Wenn eine Aktion ` +
        `eine Bestätigung oder Auswahl braucht, nutze ask_user_choice/` +
        `ask_user_text — die Rückfrage wird dem Nutzer direkt in Telegram ` +
        `gestellt.]`
      : `[Hinweis: Antworte knapp und handyfreundlich. Es gibt hier keinen ` +
        `Bestätigungsdialog — Aktionen, die eine Rückfrage brauchen, kannst ` +
        `du nicht ausführen; sag in dem Fall, dass es am Rechner erledigt ` +
        `werden muss.]`;
    const started = this.orchestrator.startAutonomousConversation({
      conversationId: this.threadId(),
      initialMessage:
        `[Nachricht des Nutzers über Telegram]\n\n${withCaptions}\n\n${hint}`,
      ...(allImages.length > 0 ? { images: allImages } : {}),
      ...(confirmEnabled ? { remoteAsk: this.buildRemoteAsk() } : {}),
      ...(autonomyLevel !== "none" ? { autonomyLevel } : {}),
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
        // v0.1.459 — T6: Aktivität verlängert das Zeitfenster. Eine
        // offene Telegram-Rückfrage kann allein 3 Minuten dauern; ein
        // fixer Timer würde die Antwort danach verwerfen.
        refresh();
        if (frame.kind === "token" && frame.delta) buf += frame.delta;
        else if (frame.kind === "done") finish(buf);
        else if (frame.kind === "error") {
          finish(buf || `Fehler: ${frame.message}`);
        }
      };
      let timer = setTimeout(
        () => finish(buf || "Zeitüberschreitung bei der Antwort."),
        REPLY_TIMEOUT_MS,
      );
      const refresh = (): void => {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(buf || "Zeitüberschreitung bei der Antwort."),
          REPLY_TIMEOUT_MS,
        );
      };
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

  /**
   * v0.1.420 — Foto NICHT sofort verarbeiten, sondern sammeln: In der Praxis
   * kommen erst die Bilder und danach die Erklärung (oft als längere
   * Sprachnachricht). Erst wenn für MEDIA_WAIT_MS nichts mehr folgt, werden
   * die Bilder für sich ausgewertet. Eine Bildunterschrift zählt bereits als
   * Erklärung und löst sofort aus.
   */
  private async bufferPhoto(fileId: string, caption: string): Promise<void> {
    const token = await this.store.getToken();
    if (!token) return;
    const file = await downloadFile(token, fileId);
    if (!file) {
      await this.reply("Das Bild konnte ich nicht laden.");
      return;
    }
    this.pendingImages.push({
      base64: file.bytes.toString("base64"),
      mimeType: file.mimeHint.startsWith("image/")
        ? file.mimeHint
        : "image/jpeg",
      filename: `telegram-foto-${this.pendingImages.length + 1}.jpg`,
    });
    if (caption.trim()) this.pendingCaptions.push(caption.trim());

    // Bildunterschrift = Erklärung liegt vor → direkt verarbeiten.
    if (caption.trim()) {
      await this.handleMessage(caption.trim());
      return;
    }

    // Sonst: Sammelfenster (neu) starten.
    if (this.mediaTimer) clearTimeout(this.mediaTimer);
    this.mediaTimer = setTimeout(() => {
      this.mediaTimer = null;
      void this.flushImagesAlone();
    }, MEDIA_WAIT_MS);
    console.log(
      `[telegram] ${this.pendingImages.length} Bild(er) gepuffert — warte auf Erläuterung`,
    );
  }

  /** Gepufferte Bilder entnehmen (und das Sammelfenster beenden). */
  private takeBufferedImages(): {
    images: AgentMessageImage[];
    captions: string[];
  } {
    if (this.mediaTimer) {
      clearTimeout(this.mediaTimer);
      this.mediaTimer = null;
    }
    const images = this.pendingImages;
    const captions = this.pendingCaptions;
    this.pendingImages = [];
    this.pendingCaptions = [];
    return { images, captions };
  }

  /** Sammelfenster abgelaufen — Bilder ohne Erläuterung auswerten. */
  private async flushImagesAlone(): Promise<void> {
    if (!this.running || this.pendingImages.length === 0) return;
    await this.handleMessage(
      "Zu diesen Bildern kam keine weitere Erläuterung. Beschreibe kurz, " +
        "was darauf zu sehen ist, und halte fest, was für den Vertrieb " +
        "relevant sein könnte.",
    );
  }

  /**
   * v0.1.420 — ID des laufenden Gesprächsfadens. Der Telegram-Chat verhält
   * sich damit wie ein normaler AVA-Chat: Folgefragen ("und das bitte auch
   * bei Kunde Y") kennen den Zusammenhang. Nach langer Funkstille oder bei
   * zu vielen Nachrichten beginnt ein frischer Faden, damit der Kontext
   * nicht unbegrenzt wächst.
   */
  private threadId(): string {
    const now = Date.now();
    const stale =
      this.conversationId === null ||
      now - this.lastActivityAt > CONVERSATION_IDLE_MS ||
      this.threadMessages >= MAX_THREAD_MESSAGES;
    if (stale) {
      this.conversationId = `telegram-${now.toString(36)}`;
      this.threadMessages = 0;
    }
    this.lastActivityAt = now;
    this.threadMessages += 1;
    // Nach dem stale-Zweig ist die ID immer gesetzt.
    return this.conversationId as string;
  }

  /** Faden bewusst neu beginnen (/neu im Chat). */
  private resetThread(): void {
    this.conversationId = null;
    this.threadMessages = 0;
    this.takeBufferedImages();
  }

  // ---- T6: Rückfragen aufs Handy (v0.1.459) -------------------------------
  //
  // Warum die Rückfrage SELBST pollt: Die Haupt-Long-Poll-Schleife wartet
  // in handleMessage auf die Agenten-Antwort und liest währenddessen keine
  // Updates. Es gibt also genau EINEN getUpdates-Konsumenten zur Zeit —
  // erst die Schleife, während einer offenen Rückfrage dieser Poller.
  //
  // Sicherheit: nur der verknüpfte Chat zählt (wie überall), Timeout
  // 3 Minuten → Abbruch (fail-closed, exakt das bisherige Verhalten),
  // „abbrechen" lehnt die Aktion explizit ab.

  private askActive = false;

  private buildRemoteAsk(): RemoteAskHandler {
    return {
      askChoice: (prompt, options, signal) =>
        this.remoteAskPrompt(prompt, options, signal),
      askText: (prompt, opts, signal) =>
        this.remoteAskPrompt(prompt, null, signal, opts.optional === true),
    };
  }

  private async remoteAskPrompt(
    prompt: string,
    options: AgentChoiceOption[] | null,
    signal: AbortSignal,
    optional = false,
  ): Promise<string> {
    if (this.askActive) {
      throw new Error("Es ist bereits eine Rückfrage in Telegram offen.");
    }
    const cfg = this.store.getConfig();
    if (!cfg.inboundConfirmEnabled || !cfg.chatId) {
      throw new Error(
        "Rückfragen über Telegram sind nicht (mehr) aktiviert.",
      );
    }
    this.askActive = true;
    try {
      const lines = [`❓ ${prompt}`];
      if (options) {
        options.forEach((o, i) => {
          lines.push(
            `${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`,
          );
        });
        lines.push(
          `\nAntworte mit der Nummer (1–${options.length}) oder „abbrechen".`,
        );
      } else {
        lines.push(
          optional
            ? `\nAntworte als Text, „-" zum Überspringen oder „abbrechen".`
            : `\nAntworte als Text oder mit „abbrechen".`,
        );
      }
      await this.reply(lines.join("\n"));
      this.onAudit?.({
        severity: "info",
        summary: `Telegram-Rückfrage gestellt: ${prompt.slice(0, 80)}`,
        metadata: { options: options?.length ?? 0 },
      });

      const deadline = Date.now() + ASK_TIMEOUT_MS;
      while (Date.now() < deadline && this.running) {
        if (signal.aborted) throw new Error("aborted");
        const token = await this.store.getToken();
        const cur = this.store.getConfig();
        if (!token || !cur.chatId) break;
        const offset =
          cur.lastUpdateId !== null ? cur.lastUpdateId + 1 : undefined;
        const updates = await getUpdates(token, offset, ASK_POLL_SECONDS);
        for (const u of updates) {
          this.store.setConfig({ lastUpdateId: u.updateId });
          if (u.chat.chatId !== cur.chatId) continue;
          const text = u.chat.text.trim();
          if (!text) {
            // Bild/Sprachnachricht während einer Rückfrage: nicht
            // interpretierbar — kurz sagen, was gebraucht wird.
            await this.reply(`Bitte als Text antworten (oder „abbrechen").`);
            continue;
          }
          const answer = this.parseAskAnswer(text, options, optional);
          if (answer.kind === "cancel") {
            await this.reply("Okay, abgebrochen.");
            throw new Error(
              "Der Nutzer hat die Rückfrage in Telegram abgebrochen.",
            );
          }
          if (answer.kind === "invalid") {
            await this.reply(
              options
                ? `Das konnte ich keiner Option zuordnen — bitte eine Nummer von 1 bis ${options.length} schicken (oder „abbrechen").`
                : `Das konnte ich nicht verwerten — bitte als Text antworten (oder „abbrechen").`,
            );
            continue;
          }
          this.onAudit?.({
            severity: "info",
            summary: "Telegram-Rückfrage beantwortet",
            metadata: { prompt: prompt.slice(0, 80) },
          });
          return answer.value;
        }
      }
      await this.reply(
        "⏱️ Keine Antwort erhalten — ich habe die Aktion abgebrochen.",
      );
      throw new Error(
        "Keine Antwort auf die Telegram-Rückfrage innerhalb von 3 Minuten — " +
          "Aktion abgebrochen. Wähle einen Pfad ohne Bestätigung oder " +
          "verweise auf den Rechner.",
      );
    } finally {
      this.askActive = false;
    }
  }

  /** Antworttext einer Rückfrage auswerten. */
  private parseAskAnswer(
    text: string,
    options: AgentChoiceOption[] | null,
    optional: boolean,
  ):
    | { kind: "value"; value: string }
    | { kind: "cancel" }
    | { kind: "invalid" } {
    const t = text.trim();
    const lower = t.toLowerCase();
    if (["abbrechen", "abbruch", "cancel", "stop", "/abbrechen"].includes(lower)) {
      return { kind: "cancel" };
    }
    if (!options) {
      if (optional && (t === "-" || lower === "überspringen" || lower === "skip")) {
        return { kind: "value", value: "" };
      }
      return { kind: "value", value: t };
    }
    const num = /^\d{1,2}$/.test(t) ? Number(t) : NaN;
    if (Number.isInteger(num) && num >= 1 && num <= options.length) {
      const opt = options[num - 1];
      if (opt) return { kind: "value", value: opt.value };
    }
    const byLabel = options.find(
      (o) =>
        o.label.trim().toLowerCase() === lower ||
        o.value.trim().toLowerCase() === lower,
    );
    if (byLabel) return { kind: "value", value: byLabel.value };
    return { kind: "invalid" };
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
