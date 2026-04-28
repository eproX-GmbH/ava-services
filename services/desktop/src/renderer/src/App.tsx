import { useEffect, useState, type PropsWithChildren } from "react";
import { useConfigStore } from "./store/config";
import { useAuthStore } from "./store/auth";
import { useOllamaStore } from "./store/ollama";
import { SignIn } from "./routes/SignIn";
import { FirstRunWizard } from "./routes/FirstRunWizard";
import type { LlmProviderKind } from "../../shared/types";

interface MemoryProbe {
  writable: boolean;
  reason?: string;
  path: string;
}

// App shell.
//
// Loads boot config (gateway URL) + the current auth status from the
// preload bridge once on mount, then subscribes to auth status pushes
// so login / logout / silent refresh keep the renderer mirror in sync.
//
// Gating order (top of stack first):
//   1. SignIn — if not authenticated. Auth runs first so we know who the
//      user is before committing GBs of disk to model downloads.
//   2. FirstRunWizard — if Ollama supervisor reports missing required
//      models, OR is in `error` / `starting` state. Blocks the rest of
//      the app because every meaningful screen depends on it.
//   3. Children — the routed app.
export function App({ children }: PropsWithChildren) {
  const setConfig = useConfigStore((s) => s.set);
  const configReady = useConfigStore((s) => s.ready);

  const setAuth = useAuthStore((s) => s.set);
  const authReady = useAuthStore((s) => s.ready);
  const signedIn = useAuthStore((s) => s.signedIn);

  // Phase 8.d. Probed once on mount — the result is sticky for the
  // process lifetime (the main-side store caches it). Null until the
  // first IPC call resolves; we treat that null window as "no warning".
  const [memoryProbe, setMemoryProbe] = useState<MemoryProbe | null>(null);

  const setOllamaStatus = useOllamaStore((s) => s.setStatus);
  const setPullProgress = useOllamaStore((s) => s.setPullProgress);
  const ollamaReady = useOllamaStore((s) => s.ready);
  const ollamaStatus = useOllamaStore((s) => s.status);

  // Active LLM provider — when the user has chosen a hosted provider
  // (Phase 8.k10b "Skip → cloud" flow), the missing-LLM rows in
  // status.missing must NOT block the app shell; only the embedding
  // model is genuinely required. Polling-free: the FirstRunWizard
  // refreshes this via setProviderKind after a successful skip, and
  // we re-fetch on mount so a returning user lands directly in the
  // app even if some Ollama LLM is "missing".
  const [providerKind, setProviderKind] = useState<LlmProviderKind | null>(
    null,
  );

  useEffect(() => {
    void window.api.getConfig().then(setConfig);
    void window.api.auth.getStatus().then(setAuth);
    void window.api.ollama.getStatus().then(setOllamaStatus);
    void window.api.agent.getMemoryProbe().then(setMemoryProbe);
    void window.api.agent
      .getProviderConfig()
      .then((b) => setProviderKind(b.config.kind))
      .catch(() => {
        // Non-fatal — fall through to the conservative "treat as local"
        // branch (the wizard is shown, with the LLM listed as missing).
      });
    const offAuth = window.api.auth.onStatusChanged(setAuth);
    const offOllama = window.api.ollama.onStatusChanged(setOllamaStatus);
    const offPull = window.api.ollama.onPullProgress(setPullProgress);
    return () => {
      offAuth();
      offOllama();
      offPull();
    };
  }, [setConfig, setAuth, setOllamaStatus, setPullProgress]);

  if (!configReady || !authReady || !ollamaReady) {
    return <div className="loading">Loading…</div>;
  }
  if (!signedIn) {
    return <SignIn />;
  }
  // Show the wizard whenever the supervisor isn't fully ready or any
  // *blocking* required model is missing. State transitions
  // (starting → ready → missing-models-pulled) are pushed as IPC events,
  // so this branch self-resolves as the user clicks "Download all".
  //
  // When the user has chosen a hosted LLM (Phase 8.k10b skip flow), the
  // LLM rows in `status.missing` are NOT blocking — only the embedding
  // is. We never want to invalidate a user's locally-built indexes by
  // silently swapping embedders, so embedding stays local regardless of
  // LLM choice; see catalog.ts header for the vector-space rationale.
  const usingHostedLlm = providerKind !== null && providerKind !== "ollama";
  const blockingMissing = usingHostedLlm
    ? ollamaStatus.missing.filter((m) => m.role !== "llm")
    : ollamaStatus.missing;
  const ollamaBlocking =
    ollamaStatus.state !== "ready" || blockingMissing.length > 0;
  if (ollamaBlocking) {
    return <FirstRunWizard memoryProbe={memoryProbe} />;
  }
  // Memory probe failure isn't fatal — the agent still runs in-memory —
  // but we want the user to know transcripts won't survive a restart.
  // Surface as a non-blocking banner above the routed app.
  return (
    <>
      {memoryProbe && !memoryProbe.writable && (
        <div className="memory-warning">
          <strong>Conversation memory disabled.</strong>{" "}
          The agent will work for this session, but transcripts won't be saved.
          Tried to use <code>{memoryProbe.path}</code>
          {memoryProbe.reason ? <> — {memoryProbe.reason}</> : null}.
        </div>
      )}
      {children}
    </>
  );
}
