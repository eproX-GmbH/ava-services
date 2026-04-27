import { useEffect, useState, type PropsWithChildren } from "react";
import { useConfigStore } from "./store/config";
import { useAuthStore } from "./store/auth";
import { useOllamaStore } from "./store/ollama";
import { SignIn } from "./routes/SignIn";
import { FirstRunWizard } from "./routes/FirstRunWizard";

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

  useEffect(() => {
    void window.api.getConfig().then(setConfig);
    void window.api.auth.getStatus().then(setAuth);
    void window.api.ollama.getStatus().then(setOllamaStatus);
    void window.api.agent.getMemoryProbe().then(setMemoryProbe);
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
  // required model is missing. State transitions (starting → ready →
  // missing-models-pulled) are pushed as IPC events, so this branch
  // self-resolves as the user clicks "Download all".
  const ollamaBlocking =
    ollamaStatus.state !== "ready" || ollamaStatus.missing.length > 0;
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
