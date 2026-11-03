import { useEffect, useState } from "react";

// Einstellungen → KI: Version der lokalen KI. Seit 2026-11-03 gibt es genau
// eine von AVA vorgesehene Version (Pin); sie wird beim Start still
// abgeglichen. Hier: laufende Version, vorgesehene Version, Fortschritt oder
// Fehler des Abgleichs und ein Knopf "Neu installieren".

type UpdaterState =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

interface UpdaterFrame {
  state: UpdaterState;
  percent?: number;
  bytesPerSec?: number;
  message?: string;
  targetVersion?: string;
  version?: string;
}

export function OllamaVersionSection() {
  const [installed, setInstalled] = useState<string | null>(null);
  const [vorgesehen, setVorgesehen] = useState<string | null>(null);
  const [updater, setUpdater] = useState<UpdaterFrame>({ state: "idle" });

  // Initial-Load + Live-Subscription.
  useEffect(() => {
    let cancelled = false;
    void window.api.ollama.getInstalledVersion().then((v) => {
      if (!cancelled) setInstalled(v);
    });
    void window.api.ollama.getPinnedVersion().then((v) => {
      if (!cancelled) setVorgesehen(v);
    });
    void window.api.ollama.getUpdaterState().then((s) => {
      if (!cancelled) setUpdater(s as UpdaterFrame);
    });
    const off = window.api.ollama.onUpdaterState((s) => {
      setUpdater(s as UpdaterFrame);
      // Wenn ein Update fertig ist, installed-Version neu lesen.
      if (s.state === "ready") {
        // Ollama braucht einen Moment zum Hochfahren nach Restart.
        setTimeout(() => {
          void window.api.ollama.getInstalledVersion().then((v) => {
            if (!cancelled) setInstalled(v);
          });
        }, 2000);
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const passt = !!installed && !!vorgesehen && compareVersions(vorgesehen, installed) === 0;
  const busy =
    updater.state === "checking" ||
    updater.state === "downloading" ||
    updater.state === "installing";

  const triggerUpdate = async (): Promise<void> => {
    await window.api.ollama.updateBinary();
  };

  return (
    <section className="provider-section" id="ollama-version">
      <h3>Lokale KI</h3>
      <p className="muted">
        AVA bringt eine lokale KI mit und hält sie auf der Version, die mit dieser AVA-Fassung geprüft wurde. Der Abgleich läuft beim Start von selbst.
      </p>
      <ul className="kv">
        <li>
          <span className="muted">Läuft gerade:</span>{" "}
          <code>{installed ?? "—"}</code>
          {passt && (
            <span className="badge ok" style={{ marginLeft: "0.5rem" }}>
              aktuell
            </span>
          )}
        </li>
        <li>
          <span className="muted">Von AVA vorgesehen:</span>{" "}
          <code>{vorgesehen ?? "—"}</code>
        </li>
      </ul>

      {busy && (
        <p className="muted small">
          {updater.state === "checking" && "Prüfe…"}
          {updater.state === "downloading" && (
            <>
              Lade Ollama
              {updater.targetVersion ? ` ${updater.targetVersion}` : ""}{" "}
              herunter… {updater.percent ?? 0} %
              {updater.bytesPerSec && updater.bytesPerSec > 0
                ? ` · ${formatBytes(updater.bytesPerSec)}/s`
                : ""}
            </>
          )}
          {updater.state === "installing" && (
            <>
              Installiere Ollama
              {updater.targetVersion ? ` ${updater.targetVersion}` : ""}…
            </>
          )}
        </p>
      )}

      {updater.state === "error" && (
        <p className="error small">
          Abgleich fehlgeschlagen: {updater.message ?? "Unbekannter Fehler"}
        </p>
      )}

      <div className="actions">
        {!busy && (
          <button
            type="button"
            className={passt ? "link" : undefined}
            onClick={() => void triggerUpdate()}
            title="Die vorgesehene Version neu herunterladen (mit Prüfsumme) und die lokale KI neu starten."
          >
            {passt ? "Neu installieren" : `Auf ${vorgesehen ?? "die vorgesehene Version"} bringen`}
          </button>
        )}
      </div>
    </section>
  );
}

// Sehr leichter Semver-Vergleich. Gibt 1 zurück wenn `a > b`, -1 wenn
// `a < b`, 0 wenn gleich. Spiegelt die Logik im
// main/ollama-binary-updater.ts.
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => parseInt(n, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export { compareVersions };
