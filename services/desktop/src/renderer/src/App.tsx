import { useEffect, type PropsWithChildren } from "react";
import { useConfigStore } from "./store/config";
import { useAuthStore } from "./store/auth";
import { SignIn } from "./routes/SignIn";

// App shell.
//
// Loads boot config (gateway URL) + the current auth status from the
// preload bridge once on mount, then subscribes to auth status pushes
// so login / logout / silent refresh keep the renderer mirror in sync.
//
// Routing gate: anything that needs the gateway is hidden behind the
// SignIn screen. The two smoke routes (/whoami, /transactions) both
// hit gateway endpoints that require auth, so there's no point letting
// them render with no token.
export function App({ children }: PropsWithChildren) {
  const setConfig = useConfigStore((s) => s.set);
  const configReady = useConfigStore((s) => s.ready);

  const setAuth = useAuthStore((s) => s.set);
  const authReady = useAuthStore((s) => s.ready);
  const signedIn = useAuthStore((s) => s.signedIn);

  useEffect(() => {
    void window.api.getConfig().then(setConfig);
    void window.api.auth.getStatus().then(setAuth);
    return window.api.auth.onStatusChanged(setAuth);
  }, [setConfig, setAuth]);

  if (!configReady || !authReady) {
    return <div className="loading">Loading…</div>;
  }
  if (!signedIn) {
    return <SignIn />;
  }
  return <>{children}</>;
}
