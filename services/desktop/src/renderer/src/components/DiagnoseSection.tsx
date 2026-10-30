import { useEffect, useState } from "react";

// Diagnose-Section (v0.1.338) — surfaces the persistent main-process log
// file so the user can attach it after a wake-hang ("AVA reagiert nicht
// nach Öffnen des MacBooks"). Until now ALL diagnostic output only went
// to stdout, which a Finder/Dock launch discards — so a frozen instance
// left no log behind. The file logger (main/file-logger.ts +
// lib/renderer-logger.ts) now mirrors every console.* line + crash hook
// into ~/Library/Logs/AVA/ava-main.log; this panel is the reveal/open
// affordance.
export function DiagnoseSection() {
  const [paths, setPaths] = useState<{
    mainLog: string;
    logDir: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    window.api.diag
      .getLogPaths()
      .then((p) => {
        if (alive) setPaths(p);
      })
      .catch(() => {
        /* leave null — buttons fall back to no-op */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="provider-section" id="diagnose">
      <h3>Diagnose</h3>
      <p className="muted">
        AVA schreibt ein Protokoll mit. Wenn die App hängt, lässt es sich hier nachvollziehen. Beim Melden eines Problems schick die Datei bitte mit.
      </p>
      <ul className="kv">
        <li>
          <span className="muted">Protokolldatei:</span>{" "}
          {paths ? (
            <code className="path">{paths.mainLog}</code>
          ) : (
            <span className="muted">wird ermittelt …</span>
          )}
        </li>
      </ul>
      <div className="actions">
        <button
          type="button"
          className="link"
          disabled={!paths}
          onClick={() => {
            if (paths) void window.api.shell.showItemInFolder(paths.mainLog);
          }}
        >
          Im Finder anzeigen
        </button>
        <button
          type="button"
          className="link"
          disabled={!paths}
          onClick={() => {
            if (paths) void window.api.shell.openPath(paths.logDir);
          }}
        >
          Log-Ordner öffnen
        </button>
      </div>
    </section>
  );
}
