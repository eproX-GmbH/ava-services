import { Notification } from "electron";
import { randomUUID } from "node:crypto";
import type {
  AgentChoiceOption,
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
  ) {}

  async askChoice(
    prompt: string,
    options: AgentChoiceOption[],
    signal: AbortSignal,
  ): Promise<string> {
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
