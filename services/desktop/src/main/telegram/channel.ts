// v0.1.412 — Telegram-Zustellkanal.
//
// Nimmt Alerts entgegen und stellt sie zu. Drei Dinge, die hier zwingend
// gelöst sein müssen:
//
//  1. RATE-LIMIT. Telegram erlaubt ~1 Nachricht/Sekunde pro Chat. Alert-
//     Wellen sind real (ein LinkedIn-Sweep erzeugte 10 Meldungen zur
//     selben Sekunde). Deshalb: eine Queue mit fester Taktung.
//  2. BÜNDELUNG. Statt zehn Einzelnachrichten wird ab BATCH_THRESHOLD
//     eine Sammelnachricht geschickt. Sonst ist das Handy unbenutzbar.
//  3. KEIN STILLER VERLUST. Ist das Netz weg, bleiben Meldungen in der
//     Outbox und werden später erneut versucht (mit Obergrenze, damit
//     nach Tagen offline nicht 500 Meldungen nachprasseln).
//
// Der Kanal ist bewusst fire-and-forget: `enqueue()` kehrt sofort zurück,
// damit der Heartbeat-Fan-out (synchron!) nie blockiert.

import type { Alert, AlertSeverity } from "../../shared/types";
import { escapeHtml, redactToken, sendMessage } from "./client";
import type { TelegramStore } from "./store";

/** Mindestabstand zwischen zwei Nachrichten an denselben Chat. */
const SEND_SPACING_MS = 1200;
/** Sammelfenster: so lange wird auf weitere Meldungen gewartet. */
const BATCH_WINDOW_MS = 8_000;
/** Ab dieser Anzahl im Fenster wird gebündelt statt einzeln gesendet. */
const BATCH_THRESHOLD = 3;
/** Obergrenze der Outbox — verhindert Nachrichtenflut nach langem Offline. */
const MAX_QUEUE = 50;
/** Zustellversuche pro Meldung, danach wird verworfen (mit Log). */
const MAX_ATTEMPTS = 4;

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warn: 1,
  urgent: 2,
};

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: "ℹ️",
  warn: "⚠️",
  urgent: "❗",
};

interface QueueItem {
  alert: Alert;
  attempts: number;
}

export interface TelegramChannelDeps {
  store: TelegramStore;
  /** Liefert true, wenn gerade Ruhezeiten aktiv sind. */
  inQuietHours: () => boolean;
  /** Optional: Zustell-Ereignisse protokollieren (Audit). */
  onAudit?: (entry: {
    severity: "info" | "warning" | "error";
    summary: string;
    metadata: Record<string, unknown>;
  }) => void;
  /** Wird gerufen, wenn sich die Anzahl offener Meldungen ändert (UI). */
  onPendingChanged?: (pending: number) => void;
}

export class TelegramChannel {
  private readonly store: TelegramStore;
  private readonly inQuietHours: () => boolean;
  private readonly onAudit?: TelegramChannelDeps["onAudit"];
  private readonly onPendingChanged?: TelegramChannelDeps["onPendingChanged"];

  private queue: QueueItem[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopped = false;

  constructor(deps: TelegramChannelDeps) {
    this.store = deps.store;
    this.inQuietHours = deps.inQuietHours;
    this.onAudit = deps.onAudit;
    this.onPendingChanged = deps.onPendingChanged;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Alert einreihen. Kehrt SOFORT zurück (der Heartbeat-Fan-out ist
   * synchron und darf nie auf Netzwerk warten). Liefert false, wenn die
   * Meldung gar nicht für Telegram bestimmt ist.
   */
  enqueue(alert: Alert): boolean {
    if (this.stopped) return false;
    const reason = this.shouldSuppress(alert);
    if (reason) {
      console.log(`[telegram] skipped (${reason}) for ${alert.id}`);
      return false;
    }
    if (this.queue.length >= MAX_QUEUE) {
      // Älteste zuerst verwerfen — neue Meldungen sind relevanter.
      this.queue.shift();
      console.warn("[telegram] queue full — oldest alert dropped");
    }
    this.queue.push({ alert, attempts: 0 });
    this.onPendingChanged?.(this.queue.length);
    this.scheduleFlush();
    return true;
  }

  /** Freie Nachricht senden (Agent-Tool / Testnachricht). */
  async sendRaw(text: string): Promise<void> {
    const cfg = this.store.getConfig();
    const token = await this.store.getToken();
    if (!token) throw new Error("Kein Telegram-Bot-Token hinterlegt.");
    if (!cfg.chatId) throw new Error("Keine Telegram-Chat-ID hinterlegt.");
    await sendMessage(token, cfg.chatId, escapeHtml(text));
  }

  // ---- intern -------------------------------------------------------------

  private shouldSuppress(alert: Alert): string | null {
    const cfg = this.store.getConfig();
    if (!cfg.enabled) return "channel disabled";
    if (!cfg.chatId) return "no chat id";
    if (
      SEVERITY_RANK[alert.severity] < SEVERITY_RANK[cfg.severityThreshold]
    ) {
      return `below threshold (${alert.severity} < ${cfg.severityThreshold})`;
    }
    if (cfg.respectQuietHours && this.inQuietHours()) return "quiet hours";
    return null;
  }

  /**
   * Sammelfenster starten. Trifft in dieser Zeit nichts weiteres ein, wird
   * einzeln gesendet; kommen mehrere, entsteht eine Sammelnachricht.
   */
  private scheduleFlush(): void {
    if (this.flushTimer || this.draining) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.drain();
    }, BATCH_WINDOW_MS);
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const cfg = this.store.getConfig();
        const token = await this.store.getToken();
        if (!token || !cfg.chatId || !cfg.enabled) {
          // Konfiguration verschwunden (getrennt) → Queue verwerfen.
          this.queue = [];
          this.onPendingChanged?.(0);
          return;
        }

        // Bündeln, sobald genug im Fenster liegt.
        const batch: QueueItem[] =
          this.queue.length >= BATCH_THRESHOLD
            ? this.queue.splice(0, this.queue.length)
            : this.queue.splice(0, 1);
        const first = batch[0];
        if (!first) return; // Queue leer — nichts zu tun.
        this.onPendingChanged?.(this.queue.length);

        const text =
          batch.length === 1
            ? formatAlert(first.alert)
            : formatBatch(batch.map((b) => b.alert));

        try {
          await sendMessage(token, cfg.chatId, text, {
            silent: batch.every((b) => b.alert.severity === "info"),
          });
          this.onAudit?.({
            severity: "info",
            summary:
              batch.length === 1
                ? `Telegram-Meldung zugestellt: ${first.alert.headline}`
                : `Telegram-Sammelmeldung zugestellt (${batch.length} Meldungen)`,
            metadata: { count: batch.length },
          });
        } catch (err) {
          const msg =
            err instanceof Error ? redactToken(err.message) : String(err);
          const status = (err as { status?: number }).status;
          // Endgültige Fehler (Token ungültig, Chat gesperrt) → nicht erneut
          // versuchen, sonst laufen wir gegen eine Wand.
          const terminal = status === 401 || status === 403 || status === 400;
          if (terminal) {
            console.warn(`[telegram] terminal delivery error: ${msg}`);
            this.onAudit?.({
              severity: "error",
              summary: `Telegram-Zustellung endgültig fehlgeschlagen: ${msg}`,
              metadata: { count: batch.length, status: status ?? null },
            });
            // Kanal deaktivieren, damit der Nutzer es in den Einstellungen sieht.
            this.store.setConfig({ enabled: false });
            this.queue = [];
            this.onPendingChanged?.(0);
            return;
          }
          // Vorübergehender Fehler → zurück in die Queue.
          const retryable = batch
            .map((b) => ({ ...b, attempts: b.attempts + 1 }))
            .filter((b) => b.attempts < MAX_ATTEMPTS);
          const dropped = batch.length - retryable.length;
          if (dropped > 0) {
            console.warn(`[telegram] gave up on ${dropped} alert(s): ${msg}`);
            this.onAudit?.({
              severity: "warning",
              summary: `Telegram-Zustellung aufgegeben (${dropped} Meldungen): ${msg}`,
              metadata: { dropped, status: status ?? null },
            });
          }
          this.queue.unshift(...retryable);
          this.onPendingChanged?.(this.queue.length);
          if (retryable.length > 0) {
            // Später erneut versuchen, nicht sofort im heißen Loop.
            this.scheduleRetry();
          }
          return;
        }

        // Taktung einhalten (≈1 Nachricht/Sekunde pro Chat).
        if (this.queue.length > 0) await sleep(SEND_SPACING_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  private scheduleRetry(): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.drain();
    }, 60_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Nachrichtenformat -----------------------------------------------------

/**
 * Einzelmeldung. Anders als der OS-Toast (der die Begründung wegwirft, weil
 * Toasts zu kurz sind) hat Telegram Platz — Begründung und Link kommen mit.
 */
function formatAlert(alert: Alert): string {
  const lines: string[] = [];
  lines.push(
    `${SEVERITY_EMOJI[alert.severity]} <b>${escapeHtml(alert.headline)}</b>`,
  );
  if (alert.companyName) lines.push(escapeHtml(alert.companyName));
  if (alert.rationale) lines.push("", escapeHtml(alert.rationale));
  if (alert.url) lines.push("", escapeHtml(alert.url));
  return lines.join("\n");
}

/** Sammelnachricht bei Meldungswellen. */
function formatBatch(alerts: Alert[]): string {
  const lines: string[] = [
    `<b>${alerts.length} neue Meldungen</b>`,
    "",
  ];
  for (const a of alerts.slice(0, 10)) {
    const company = a.companyName ? `${escapeHtml(a.companyName)}: ` : "";
    lines.push(
      `${SEVERITY_EMOJI[a.severity]} ${company}${escapeHtml(a.headline)}`,
    );
  }
  if (alerts.length > 10) {
    lines.push("", `… und ${alerts.length - 10} weitere.`);
  }
  return lines.join("\n");
}
