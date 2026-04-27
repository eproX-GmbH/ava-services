import { EventEmitter } from "node:events";
import type { OllamaSupervisor } from "../../ollama-supervisor";
import { streamChat } from "../ollama-client";
import type {
  LlmProvider,
  LlmProviderStatus,
  LlmStreamFrame,
  LlmStreamRequest,
} from "./types";

// OllamaProvider (Phase 8.j).
//
// Thin adapter around the existing Ollama HTTP client + supervisor. The
// supervisor owns the child-process lifecycle and the host/port; this
// class just translates "is the supervisor ready?" into the LlmProvider
// contract and forwards `streamChat` calls through.
//
// We treat the FIRST llm-role required model as the active one. The
// catalog (REQUIRED_MODELS) currently only declares one — if a future
// version ships multiple, ProviderConfigStore picks which tag to use
// and overrides via `modelOverride`.

export interface OllamaProviderOptions {
  supervisor: OllamaSupervisor;
  /** Override the supervisor's default llm tag. Lets a user pick a smaller
   *  variant from Settings without changing the catalog. */
  modelOverride?: string | null;
}

export class OllamaProvider extends EventEmitter implements LlmProvider {
  readonly kind = "ollama" as const;
  private readonly supervisor: OllamaSupervisor;
  private modelOverride: string | null;

  constructor(opts: OllamaProviderOptions) {
    super();
    this.supervisor = opts.supervisor;
    this.modelOverride = opts.modelOverride ?? null;
    // Forward supervisor status transitions as provider status transitions
    // so the orchestrator's broadcast covers Ollama lifecycle (starting →
    // ready → error) without a separate listener.
    this.supervisor.on("status", () => this.emit("status", this.getStatus()));
  }

  setModelOverride(model: string | null): void {
    if (this.modelOverride === model) return;
    this.modelOverride = model;
    this.emit("status", this.getStatus());
  }

  getStatus(): LlmProviderStatus {
    const oll = this.supervisor.getStatus();
    const fallbackModel =
      oll.required.find((m) => m.role === "llm")?.name ?? null;
    const model = this.modelOverride ?? fallbackModel;
    const ready = oll.state === "ready" && model !== null;
    return {
      kind: "ollama",
      model,
      ready,
      errorMessage:
        oll.state === "error"
          ? (oll.errorMessage ?? "Ollama is not running.")
          : !ready && oll.state !== "ready"
            ? "Ollama is starting."
            : !model
              ? "No LLM-role model configured."
              : null,
    };
  }

  onStatusChanged(listener: (s: LlmProviderStatus) => void): () => void {
    const handler = (s: LlmProviderStatus): void => listener(s);
    this.on("status", handler);
    return () => this.off("status", handler);
  }

  async *streamChat(req: LlmStreamRequest): AsyncGenerator<LlmStreamFrame, void, void> {
    const status = this.getStatus();
    if (!status.ready || !status.model) {
      throw new Error(status.errorMessage ?? "Ollama provider not ready.");
    }
    const oll = this.supervisor.getStatus();
    if (!oll.host) throw new Error("Ollama host unknown.");

    // The underlying client already yields the right shape — we re-yield
    // verbatim. Kept as a generator (not a return) so a future provider
    // hook (rate-limit, retry) drops in without callers changing.
    for await (const frame of streamChat({
      host: oll.host,
      model: status.model,
      messages: req.messages,
      tools: req.tools,
      signal: req.signal,
    })) {
      yield frame;
    }
  }
}
