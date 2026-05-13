import { useEffect, useState, type PropsWithChildren } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { USAGE_QUERY_KEY } from "./api/usage";
import { useConfigStore } from "./store/config";
import { useAuthStore } from "./store/auth";
import { useOllamaStore } from "./store/ollama";
import { usePostgresStore } from "./store/postgres";
import { bindProducersBridge } from "./store/producers";
import { bindUpdaterBridge } from "./store/updater";
import { bindAlertsBridge } from "./store/alerts";
import { bindVoiceBridge } from "./store/voice";
import { bindProfileBridge } from "./store/profile";
import { bindWatchesBridge } from "./store/watches";
import { SignIn } from "./routes/SignIn";
import { FirstRunWizard } from "./routes/FirstRunWizard";
import { DownloadDock } from "./components/DownloadDock";
import { UpdateBanner } from "./components/UpdateBanner";
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

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const setOllamaStatus = useOllamaStore((s) => s.setStatus);
  const setPullProgress = useOllamaStore((s) => s.setPullProgress);
  const ollamaReady = useOllamaStore((s) => s.ready);
  const ollamaStatus = useOllamaStore((s) => s.status);

  const setPostgresStatus = usePostgresStore((s) => s.setStatus);

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

  // Whether the user has made an explicit choice on the FirstRunWizard
  // (clicked "Download all" OR completed "Skip → cloud"). Once true, the
  // wizard stops being a hard modal and the routed app + Download Dock
  // take over while the actual pull progresses in the background. We
  // keep this in App.tsx rather than the ollama store because it's a
  // pure UI gate — the source of truth for "is the agent actually
  // usable" stays `status.missing` + provider config.
  const [pathChosen, setPathChosen] = useState(false);

  useEffect(() => {
    void window.api.getConfig().then(setConfig);
    void window.api.auth.getStatus().then(setAuth);
    void window.api.ollama.getStatus().then(setOllamaStatus);
    void window.api.postgres.getStatus().then(setPostgresStatus);
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
    const offPostgres = window.api.postgres.onStatusChanged(setPostgresStatus);
    // Phase 8.v1.1 — producer subprocess mirror. Bridge handles the
    // initial list fetch + diff subscription internally.
    const offProducers = bindProducersBridge();
    const offUpdater = bindUpdaterBridge();
    // Phase 8.f1 — keep the alerts mirror in sync with main. Bootstraps
    // by fetching the current list once, then re-fetches on every
    // `alerts:changed` push.
    const offAlerts = bindAlertsBridge();
    // Phase 8.n1 — keep the voice/whisper status mirrored.
    const offVoice = bindVoiceBridge();
    // Phase 8.t1 — user profile mirror.
    const offProfile = bindProfileBridge();
    // Phase 8.t2 — watches mirror (topbar chip + Settings panel).
    const offWatches = bindWatchesBridge();
    // Phase 8.f3 — when the user clicks a native OS notification, main
    // focuses the window and pushes this event; we route to /alerts so
    // the alert is one click away from the user's attention.
    const offFocus = window.api.alerts.onFocusAlerts(() => {
      navigate("/alerts");
    });
    // M3 monetization — Stripe success redirect lands here via the
    // `ava://billing/success` protocol → main → IPC. Invalidate the
    // shared `["usage"]` query so Settings + topbar pill reflect the
    // new tier immediately, without polling.
    const offBilling = window.api.billing.onSuccess(() => {
      void queryClient.invalidateQueries({ queryKey: USAGE_QUERY_KEY });
    });
    return () => {
      offAuth();
      offOllama();
      offPull();
      offPostgres();
      offProducers();
      offUpdater();
      offAlerts();
      offVoice();
      offProfile();
      offWatches();
      offFocus();
      offBilling();
    };
  }, [setConfig, setAuth, setOllamaStatus, setPullProgress, setPostgresStatus, navigate, queryClient]);

  if (!configReady || !authReady || !ollamaReady) {
    return <div className="loading">Lädt…</div>;
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

  // Wizard is a HARD modal only when the supervisor isn't reachable or
  // the user hasn't yet chosen between "download local" and "skip to
  // cloud". After they pick a path we drop into the routed app and the
  // Download Dock surfaces ongoing progress non-blockingly — see
  // Phase 8.k10c. The supervisor's `state==="error"` and
  // `state==="starting"` cases stay hard-modal because there's literally
  // nothing useful the user can do in the routed app while the runtime
  // is missing.
  //
  // v0.1.169 — `!usingHostedLlm` escape clause. Without it, a Windows
  // user who hit "Ollama binary not found" on first launch was stuck
  // in the wizard forever — even after entering an API key in the
  // wizard's chooser, the supervisor stayed in "error" and the gate
  // re-fired. Now: if the user has a working hosted LLM configured,
  // the broken local runtime is irrelevant and the app boots normally.
  // The Whoami / Settings panel still surfaces the supervisor error
  // for users who want to fix it later.
  const supervisorHardBlock =
    !usingHostedLlm &&
    (ollamaStatus.state === "error" ||
      ollamaStatus.state === "starting" ||
      ollamaStatus.state === "idle");
  // Show the wizard whenever there's still a *blocking* missing model and
  // the user hasn't yet acknowledged the choice screen this session.
  // We deliberately don't gate on `!usingHostedLlm` here — a returning
  // user who chose cloud last time but quit before the embedding pull
  // finished still needs the wizard to recover (the wizard's intro view
  // detects `cloudOk` and renders "Almost ready" with just a Download
  // button for the remaining embedding row).
  const needsFirstRunChoice = !pathChosen && blockingMissing.length > 0;
  if (supervisorHardBlock || needsFirstRunChoice) {
    return (
      <>
        <FirstRunWizard
          memoryProbe={memoryProbe}
          onPathChosen={() => setPathChosen(true)}
          onProviderConfigChanged={(b) => setProviderKind(b.config.kind)}
        />
        <DownloadDock />
        <UpdateBanner />
      </>
    );
  }
  // Memory probe failure isn't fatal — the agent still runs in-memory —
  // but we want the user to know transcripts won't survive a restart.
  // Surface as a non-blocking banner above the routed app.
  return (
    <>
      {memoryProbe && !memoryProbe.writable && (
        <div className="memory-warning">
          <strong>Konversationsspeicher deaktiviert.</strong>{" "}
          Der Agent funktioniert in dieser Sitzung, aber Verläufe werden nicht
          gespeichert. Verzeichnis <code>{memoryProbe.path}</code>
          {memoryProbe.reason ? <>: {memoryProbe.reason}</> : null}.
        </div>
      )}
      {children}
      <DownloadDock />
    </>
  );
}
