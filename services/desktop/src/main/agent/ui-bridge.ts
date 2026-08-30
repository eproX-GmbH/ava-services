import { Notification } from "electron";
import { randomUUID } from "node:crypto";
import type {
  AgentChoiceOption,
  AgentMatchRow,
  AgentStreamFrame,
  AutonomyLevel,
} from "../../shared/types";

// UiBridge — the seam between tools and the renderer.
//
// Tools run in main but sometimes need a roundtrip into the user's eyeballs:
//   - askChoice: pause and wait for the user to pick an option
//   - navigate: tell the renderer to route somewhere
//   - notify: show a native OS notification
//
// We keep this *as a class* (not bare functions) because the orchestrator
// hands tools a per-request bridge that already knows the requestId and
// conversationId. That removes a whole class of bugs where a tool emits
// frames against the wrong request after a fast user-driven abort.
//
// `askChoice` returns a Promise that resolves when the renderer calls
// `agent.answerChoice(choiceId, value)`. The orchestrator catches the
// rejection if the user aborts or the next loop iteration fails.

export interface PendingChoice {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  /** For abort cleanup: which request initiated the prompt. */
  requestId: string;
  /**
   * v0.1.151 — full frame payload kept alongside the resolver so the
   * orchestrator can replay still-open prompts on
   * `agent:getPendingPrompts`. Without this, navigating away from the
   * chat while a prompt is on screen loses the card entirely — the
   * stream frame fires once and is gone.
   */
  conversationId: string;
  prompt:
    | {
        kind: "choice-request";
        prompt: string;
        options: AgentChoiceOption[];
      }
    | {
        kind: "text-request";
        prompt: string;
        placeholder?: string;
        defaultValue?: string;
        optional?: boolean;
      }
    | {
        kind: "match-request";
        prompt: string;
        rows: AgentMatchRow[];
      };
}

// v0.1.459 — T6: Rückfragen über einen entfernten Kanal (Telegram).
// Wenn eine autonome Konversation von einem verifizierten Zweiweg-Kanal
// stammt UND der Nutzer das Feature eingeschaltet hat, beantwortet der
// Kanal askChoice/askText statt dass sie hart werfen. askMatch bleibt
// bewusst Desktop-only (Tabellen-UI, am Handy nicht sinnvoll).
export interface RemoteAskHandler {
  askChoice(
    prompt: string,
    options: AgentChoiceOption[],
    signal: AbortSignal,
  ): Promise<string>;
  askText(
    prompt: string,
    opts: { optional?: boolean },
    signal: AbortSignal,
  ): Promise<string>;
}

/** v0.1.462 — Wirkungsklasse einer bestätigungspflichtigen Aktion
 *  (PLAN_VOLLMACHT.md §3). Tools DEKLARIEREN die Klasse, die
 *  Vollmacht-Stufe des Kanals entscheidet, ob autonom bestätigt wird. */
export type ActionKind = "additive" | "mutating" | "destructive";

export interface ConfirmActionInput {
  kind: ActionKind;
  /** Anzeigetext — identisch zum bisherigen askChoice-Prompt. */
  prompt: string;
  /** Der Options-value, der "Ja, ausführen" bedeutet. Wird bei
   *  autonomer Bestätigung direkt zurückgegeben. */
  confirmValue: string;
  options: AgentChoiceOption[];
}

/** Deckt die Vollmacht-Stufe die Wirkungsklasse? Destruktiv: niemals. */
export function autonomyCovers(
  level: AutonomyLevel,
  kind: ActionKind,
): boolean {
  if (kind === "destructive") return false;
  if (kind === "additive") return level === "additive" || level === "mutating";
  return level === "mutating";
}

export interface UiBridgeDeps {
  emit: (frame: AgentStreamFrame) => void;
  pending: Map<string, PendingChoice>;
  /** v0.1.462 — Audit-Senke für autonome Bestätigungen. Jede per
   *  Vollmacht durchgewunkene Aktion MUSS nachlesbar sein. */
  audit?: (entry: {
    action: string;
    summary: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export class UiBridge {
  constructor(
    private readonly deps: UiBridgeDeps,
    private readonly requestId: string,
    private readonly conversationId: string,
    /**
     * v0.1.299 — Auto-Triage-Modus. Wenn true, werfen askChoice +
     * askText sofort statt zu blocken. Tools die intern via askChoice
     * einen Confirm holen (mail_send für non-allowlist Empfänger,
     * crm_delete_*, notion_delete_page) erhalten so einen klaren
     * Error und können dem Agent zurückmelden „dieser Pfad geht im
     * Auto-Modus nicht — wähl einen anderen oder beende".
     */
    private readonly autonomousMode: boolean = false,
    /** v0.1.459 — T6: beantwortet Rückfragen im autonomen Modus remote. */
    private readonly remoteAsk: RemoteAskHandler | null = null,
    /** v0.1.462 — Vollmacht-Stufe des Kanals (PLAN_VOLLMACHT.md). */
    private readonly autonomyLevel: AutonomyLevel = "none",
  ) {}

  /**
   * v0.1.462 — Bestätigungspflichtige Aktion mit DEKLARIERTER
   * Wirkungsklasse (PLAN_VOLLMACHT.md §4.1). Auflösungsreihenfolge:
   *
   *   1. Interaktiver Chat → normaler askChoice-Dialog.
   *   2. Autonom + Vollmacht deckt die Klasse → sofort confirmValue,
   *      mit Audit-Eintrag (jede autonome Entscheidung ist nachlesbar).
   *   3. Autonom + RemoteAsk (Telegram T6) → Rückfrage im Chat.
   *   4. Sonst → throw (fail-closed, wie bisher).
   *
   * askChoice bleibt für echte Auswahlfragen (Disambiguierung) das
   * richtige API — confirmAction ist NUR für Ja/Nein-Genehmigungen.
   */
  async confirmAction(
    input: ConfirmActionInput,
    signal: AbortSignal,
  ): Promise<string> {
    if (!this.autonomousMode) {
      return this.askChoice(input.prompt, input.options, signal);
    }
    if (autonomyCovers(this.autonomyLevel, input.kind)) {
      this.deps.audit?.({
        action: "agent.autonomy.autoConfirm",
        summary: `Aktion autonom bestätigt (Vollmacht ${this.autonomyLevel}, Klasse ${input.kind})`,
        metadata: {
          conversationId: this.conversationId,
          requestId: this.requestId,
          kind: input.kind,
          level: this.autonomyLevel,
          prompt: input.prompt.slice(0, 2000),
          confirmValue: input.confirmValue,
        },
      });
      return input.confirmValue;
    }
    if (this.remoteAsk && input.options.length > 0) {
      return this.remoteAsk.askChoice(input.prompt, input.options, signal);
    }
    throw new Error(
      input.kind === "destructive"
        ? "Diese Aktion ist destruktiv und braucht IMMER eine Bestätigung — " +
          "im Auto-Modus ohne Rückfrage-Kanal nicht möglich. Am Rechner erledigen."
        : `Diese Aktion (Klasse ${input.kind}) ist von der aktuellen ` +
          `Vollmacht-Stufe (${this.autonomyLevel}) nicht gedeckt und es gibt ` +
          `keinen Rückfrage-Kanal. Wähle einen anderen Pfad oder verweise ` +
          `auf den Rechner. (Vollmacht: Einstellungen → Mail bzw. Telegram.)`,
    );
  }

  async askChoice(
    prompt: string,
    options: AgentChoiceOption[],
    signal: AbortSignal,
  ): Promise<string> {
    if (this.autonomousMode) {
      if (this.remoteAsk && options.length > 0) {
        return this.remoteAsk.askChoice(prompt, options, signal);
      }
      throw new Error(
        "askChoice ist im Auto-Triage-Modus nicht erlaubt (kein User da, " +
          "der antworten könnte). Triff die Entscheidung selbst oder " +
          "wähle einen Pfad ohne User-Confirm.",
      );
    }
    if (options.length === 0) {
      throw new Error("askChoice requires at least one option");
    }
    const choiceId = randomUUID();

    return new Promise<string>((resolve, reject) => {
      // Surface abort by rejecting the pending entry so the running tool
      // unwinds. Any frame we already emitted is harmless — the renderer
      // dismisses choice cards when the request ends.
      const onAbort = () => {
        const entry = this.deps.pending.get(choiceId);
        if (entry) {
          this.deps.pending.delete(choiceId);
          entry.reject(new Error("aborted"));
        }
      };
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      this.deps.pending.set(choiceId, {
        requestId: this.requestId,
        conversationId: this.conversationId,
        prompt: { kind: "choice-request", prompt, options },
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      });

      this.deps.emit({
        kind: "choice-request",
        requestId: this.requestId,
        conversationId: this.conversationId,
        choiceId,
        prompt,
        options,
      });
    });
  }

  /**
   * Free-form text input (Phase 8.f4 chat-form addon). Same `pending`
   * map as `askChoice` so the renderer's existing `answerChoice` IPC
   * resolves both flavours — the only difference is the emitted frame
   * carries no `options[]` and the renderer paints an `<input>` instead
   * of a button row. When `optional` is true the renderer also paints
   * a "Überspringen" button that resolves with the empty string.
   */
  async askText(
    prompt: string,
    opts: {
      placeholder?: string;
      defaultValue?: string;
      optional?: boolean;
    },
    signal: AbortSignal,
  ): Promise<string> {
    if (this.autonomousMode) {
      if (this.remoteAsk) {
        return this.remoteAsk.askText(
          prompt,
          { ...(opts.optional ? { optional: true } : {}) },
          signal,
        );
      }
      throw new Error(
        "askText ist im Auto-Triage-Modus nicht erlaubt. Triff die " +
          "Entscheidung selbst oder beende die Konversation mit einer " +
          "Notiz, was unklar war.",
      );
    }
    const choiceId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.deps.pending.get(choiceId);
        if (entry) {
          this.deps.pending.delete(choiceId);
          entry.reject(new Error("aborted"));
        }
      };
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      this.deps.pending.set(choiceId, {
        requestId: this.requestId,
        conversationId: this.conversationId,
        prompt: {
          kind: "text-request",
          prompt,
          ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
          ...(opts.defaultValue ? { defaultValue: opts.defaultValue } : {}),
          ...(opts.optional ? { optional: true } : {}),
        },
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      });

      this.deps.emit({
        kind: "text-request",
        requestId: this.requestId,
        conversationId: this.conversationId,
        choiceId,
        prompt,
        ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
        ...(opts.defaultValue ? { defaultValue: opts.defaultValue } : {}),
        ...(opts.optional ? { optional: true } : {}),
      });
    });
  }

  /**
   * v0.1.392 — Batch-Zuordnung: zeigt EINE Karte mit allen nicht eindeutig
   * auflösbaren Firmen, je mit Kandidaten + „überspringen". Blockt bis der
   * Nutzer EINMAL bestätigt; liefert eine Map `{ rowId: companyId | "skip" }`.
   * Reused den answerChoice-Kanal (Antwort-`value` ist die JSON-Map).
   */
  async askMatch(
    prompt: string,
    rows: AgentMatchRow[],
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    if (this.autonomousMode) {
      throw new Error(
        "askMatch ist im Auto-Triage-Modus nicht erlaubt (kein User da). " +
          "Triff die Zuordnung selbst oder überspringe unklare Firmen.",
      );
    }
    if (rows.length === 0) return {};
    const choiceId = randomUUID();
    return new Promise<Record<string, string>>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.deps.pending.get(choiceId);
        if (entry) {
          this.deps.pending.delete(choiceId);
          entry.reject(new Error("aborted"));
        }
      };
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      this.deps.pending.set(choiceId, {
        requestId: this.requestId,
        conversationId: this.conversationId,
        prompt: { kind: "match-request", prompt, rows },
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          let parsed: Record<string, string> = {};
          try {
            const obj = JSON.parse(value) as unknown;
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              parsed = obj as Record<string, string>;
            }
          } catch {
            /* malformed → leere Map = alles überspringen */
          }
          resolve(parsed);
        },
        reject: (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      });

      this.deps.emit({
        kind: "match-request",
        requestId: this.requestId,
        conversationId: this.conversationId,
        choiceId,
        prompt,
        rows,
      });
    });
  }

  navigate(path: string): void {
    this.deps.emit({
      kind: "navigate",
      requestId: this.requestId,
      conversationId: this.conversationId,
      path,
    });
  }

  notify(title: string, body: string): void {
    // `Notification.isSupported()` is false on Linux without libnotify; we
    // still try, and let the catch swallow the failure rather than crash
    // the tool. The user just doesn't get a popup — the chat message still
    // shows the same content.
    try {
      if (Notification.isSupported()) {
        new Notification({ title, body }).show();
      }
    } catch (err) {
      console.warn("[agent] notify failed:", err);
    }
  }
}
