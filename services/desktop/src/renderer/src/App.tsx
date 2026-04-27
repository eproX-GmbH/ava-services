import { useEffect, type PropsWithChildren } from "react";
import { useConfigStore } from "./store/config";

// App shell — single responsibility: load `appConfig` from the preload
// bridge once on mount and stash it in the Zustand store so child screens
// can read `gatewayUrl` synchronously. Without this the gateway client
// would have to await ipcRenderer on every fetch.
export function App({ children }: PropsWithChildren) {
  const setConfig = useConfigStore((s) => s.set);
  const ready = useConfigStore((s) => s.ready);

  useEffect(() => {
    void window.api.getConfig().then(setConfig);
  }, [setConfig]);

  if (!ready) {
    return <div className="loading">Loading…</div>;
  }
  return <>{children}</>;
}
