import { Notification } from "electron";
import { randomUUID } from "node:crypto";
import type {
  AgentChoiceOption,
  AgentMatchRow,
  AgentStreamFrame,
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

export interface UiBridgeDeps {
  emit: (frame: AgentStreamFrame) => void;
  pending: Map<string, PendingChoice>;
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
  ) {}

  async askChoice(
    prompt: string,
    options: AgentChoiceOption[],
    signal: AbortSignal,
  ): Promise<string> {
    if (this.autonomousMode) {
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
