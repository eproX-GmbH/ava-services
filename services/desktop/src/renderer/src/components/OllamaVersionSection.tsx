import { useEffect, useState } from "react";

// v0.1.222 — Settings → System: Ollama-Version + Update-Affordance.
//
// Drei Werte werden nebeneinander gezeigt:
//   - Installiert: was der laufende Ollama-Server unter /api/version meldet
//   - Latest verfügbar: was GitHub gerade als stable Release listet
//     (über den 1h-Cache des Updaters)
//   - Floor: AVAs Mindestversion (nur als technischer Tooltip)
//
// Wenn `latest > installed`, zeigen wir den "Aktualisieren"-Button.
// Sonst nur die Anzeige + "bereits aktuell".

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
  const [latest, setLatest] = useState<string | null>(null);
  const [floor, setFloor] = useState<string | null>(null);
  const [updater, setUpdater] = useState<UpdaterFrame>({ state: "idle" });

  // Initial-Load + Live-Subscription.
  useEffect(() => {
    let cancelled = false;
    void window.api.ollama.getInstalledVersion().then((v) => {
      if (!cancelled) setInstalled(v);
    });
    void window.api.ollama.getResolvedTargetVersion().then((v) => {
      if (!cancelled) setLatest(v);
    });
    void window.api.ollama.getPinnedVersion().then((v) => {
      if (!cancelled) setFloor(v);
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

  const newerAvailable =
    installed && latest && compareVersions(latest, installed) > 0;
  const busy =
    updater.state === "checking" ||
    updater.state === "downloading" ||
    updater.state === "installing";

  const triggerUpdate = async (): Promise<void> => {
    await window.api.ollama.updateBinary();
  };

  return (
    <section className="provider-section" id="ollama-version">
      <h3>Ollama-Laufzeit</h3>
      <p className="muted small">
        AVA bündelt eine lokale Ollama-Instanz für die Modell-Ausführung.
        Wir verfolgen die neueste stabile Version von GitHub und installieren
        sie bei Bedarf nach — ohne dass du AVA neu installieren musst.
      </p>
      <ul className="kv">
        <li>
          <span className="muted">Installiert:</span>{" "}
          <code>{installed ?? "—"}</code>
          {installed && latest && !newerAvailable && (
            <span className="badge ok" style={{ marginLeft: "0.5rem" }}>
              aktuell
            </span>
          )}
        </li>
        <li>
          <span className="muted">Neueste verfügbare Version:</span>{" "}
          <code>{latest ?? "(GitHub nicht erreichbar)"}</code>
        </li>
        {floor && (
          <li
            className="muted small"
            title="AVAs Mindestversion. Floor schützt vor seltsamen Upstream-Antworten."
          >
            <span className="muted">Mindestversion:</span> <code>{floor}</code>
          </li>
        )}
      </ul>

      {busy && (
        <p className="muted small">
          {updater.state === "checking" && "Prüfe Update…"}
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
          Update fehlgeschlagen: {updater.message ?? "Unbekannter Fehler"}
        </p>
      )}

      <div className="actions">
        {newerAvailable && !busy && (
          <button type="button" onClick={() => void triggerUpdate()}>
            {latest ? `Auf ${latest} aktualisieren` : "Aktualisieren"}
          </button>
        )}
        {!newerAvailable && !busy && (
          <button
            type="button"
            className="link"
            onClick={() => void triggerUpdate()}
            title="Auch wenn keine neuere Version verfügbar scheint, einen Update-Lauf erzwingen."
          >
            Erneut prüfen
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

/** Exportiert für `OllamaUpdateBanner`, das dieselbe Vergleichslogik
 *  braucht. */
export { compareVersions };
