import { useEffect, useState } from "react";
import type {
  AlertSeverity,
  TelegramConfig,
  TelegramSnapshot,
} from "../../../../shared/types";

// v0.1.412 — Einstellungen → Automatisierungen → Telegram.
//
// Der Verbinden-Assistent nimmt dem Nutzer die unangenehmste Stelle ab:
// die Chat-ID. Statt sie irgendwo herauszusuchen, schickt man dem Bot
// einfach „/start" und AVA liest sie selbst aus (`getUpdates`).
//
// Konvention wie beim Mail-Konto: der Bot-Token wird NIE zurück in die
// Oberfläche gespiegelt — der Snapshot kennt nur `hasToken`.

const SEVERITY_OPTIONS: { value: AlertSeverity; label: string }[] = [
  { value: "info", label: "Alle Meldungen" },
  { value: "warn", label: "Ab „wichtig“" },
  { value: "urgent", label: "Nur dringende" },
];

export function TelegramSection(): JSX.Element {
  const [snap, setSnap] = useState<TelegramSnapshot | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void window.api.telegram.snapshot().then(setSnap);
    const off = window.api.telegram.onChanged(setSnap);
    return () => off();
  }, []);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onConnect = (): Promise<void> =>
    run(async () => {
      const r = await window.api.telegram.connect(token);
      if (!r.ok) {
        setError(r.error ?? "Verbindung fehlgeschlagen.");
        return;
      }
      setToken(""); // Token nie im Formular stehen lassen.
      setInfo(
        `Bot @${r.botUsername} erkannt. Schicke ihm jetzt in Telegram „/start“ und klicke dann auf „Chat verknüpfen“.`,
      );
      setSnap(await window.api.telegram.snapshot());
    });

  const onDiscover = (): Promise<void> =>
    run(async () => {
      const r = await window.api.telegram.discoverChat();
      if (!r.ok) {
        setError(r.error ?? "Chat konnte nicht ermittelt werden.");
        return;
      }
      setInfo(`Chat verknüpft: ${r.title ?? r.chatId}`);
      setSnap(await window.api.telegram.snapshot());
    });

  const onTest = (): Promise<void> =>
    run(async () => {
      const r = await window.api.telegram.sendTest();
      if (!r.ok) {
        setError(r.error ?? "Testnachricht fehlgeschlagen.");
        return;
      }
      setInfo("Testnachricht gesendet — schau in deinen Telegram-Chat.");
    });

  const onDisconnect = (): Promise<void> =>
    run(async () => {
      if (
        !window.confirm(
          "Telegram-Verbindung trennen? Der Bot-Token wird gelöscht.",
        )
      )
        return;
      setSnap(await window.api.telegram.disconnect());
      setInfo("Verbindung getrennt.");
    });

  const patch = (p: Parameters<typeof window.api.telegram.setConfig>[0]) =>
    run(async () => {
      setSnap(await window.api.telegram.setConfig(p));
    });

  if (snap == null) {
    return (
      <section id="telegram-section" className="provider-section alerts-prefs">
        <h3>Telegram</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }

  const cfg = snap.config;
  const connected = snap.hasToken;
  const ready = connected && cfg.chatId !== null;

  return (
    <section id="telegram-section" className="provider-section alerts-prefs">
      <h3>Telegram</h3>
      <p className="muted">
        Bekomme deine Meldungen zusätzlich als Telegram-Nachricht — auch dann,
        wenn die Desktop-Benachrichtigungen aus sind. Läuft direkt von deinem
        Rechner zu Telegram.
      </p>

      {!snap.encryptionAvailable && (
        <p className="error">
          Der System-Schlüsselbund ist nicht verfügbar — der Bot-Token kann
          nicht sicher gespeichert werden.
        </p>
      )}

      {!connected ? (
        <>
          <ol className="muted telegram-steps">
            <li>
              Öffne in Telegram <strong>@BotFather</strong> und schicke{" "}
              <code>/newbot</code>.
            </li>
            <li>Namen vergeben — BotFather antwortet mit einem Token.</li>
            <li>Token hier einfügen:</li>
          </ol>
          <div className="telegram-row">
            <input
              type="password"
              className="telegram-input"
              placeholder="123456789:ABCdef..."
              value={token}
              disabled={busy || !snap.encryptionAvailable}
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || token.trim().length < 20}
              onClick={() => void onConnect()}
            >
              {busy ? "Prüft…" : "Verbinden"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="telegram-row">
            <span className="pill pill--connected">
              {cfg.botUsername ? `@${cfg.botUsername}` : "Bot verbunden"}
            </span>
            {cfg.chatId ? (
              <span className="pill pill--connected">Chat verknüpft</span>
            ) : (
              <span className="pill pill--polling">Chat fehlt noch</span>
            )}
            {snap.pendingCount > 0 && (
              <span className="pill pill--polling">
                {snap.pendingCount} in Warteschlange
              </span>
            )}
          </div>

          {!cfg.chatId && (
            <p className="muted">
              Schicke deinem Bot in Telegram eine Nachricht (z. B.{" "}
              <code>/start</code>) und klicke dann auf „Chat verknüpfen“ — AVA
              liest die Chat-ID automatisch aus.
            </p>
          )}

          <div className="telegram-row">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void onDiscover()}
            >
              {cfg.chatId ? "Chat neu verknüpfen" : "Chat verknüpfen"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !ready}
              onClick={() => void onTest()}
            >
              Testnachricht senden
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void onDisconnect()}
            >
              Trennen
            </button>
          </div>

          <label className="field-inline">
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={busy || !ready}
              onChange={(e) => void patch({ enabled: e.target.checked })}
            />
            <span>
              Meldungen an Telegram senden
              {!ready && " (erst Chat verknüpfen)"}
            </span>
          </label>

          <label className="field">
            <span>Ab welcher Wichtigkeit?</span>
            <select
              value={cfg.severityThreshold}
              disabled={busy}
              onChange={(e) =>
                void patch({
                  severityThreshold: e.target.value as AlertSeverity,
                })
              }
            >
              {SEVERITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field-inline">
            <input
              type="checkbox"
              checked={cfg.inboundEnabled}
              disabled={busy || !ready}
              onChange={(e) => void patch({ inboundEnabled: e.target.checked })}
            />
            <span>
              Auf meine Nachrichten antworten (Gegenrichtung)
              {!ready && " (erst Chat verknüpfen)"}
            </span>
          </label>
          {cfg.inboundEnabled && (
            <p className="muted small">
              AVA liest Nachrichten aus <strong>diesem</strong> Chat und
              antwortet darauf — wie bei der Mail-Bearbeitung. Nachrichten aus
              anderen Chats werden verworfen.
              {!cfg.inboundConfirmEnabled &&
                " Aktionen, die am Rechner eine Rückfrage brauchen (z. B. etwas im CRM löschen), sind über Telegram bewusst nicht möglich."}
            </p>
          )}

          {cfg.inboundEnabled && (
            <>
              <label className="field-inline">
                <input
                  type="checkbox"
                  checked={cfg.inboundConfirmEnabled}
                  disabled={busy}
                  onChange={(e) =>
                    void patch({ inboundConfirmEnabled: e.target.checked })
                  }
                />
                <span>Rückfragen aufs Handy erlauben</span>
              </label>
              {cfg.inboundConfirmEnabled && (
                <p className="muted small">
                  Braucht eine Aktion eine Bestätigung oder Auswahl, stellt
                  AVA die Rückfrage direkt in diesem Chat (Antwort per Nummer
                  oder Text, „abbrechen" bricht ab). Kommt innerhalb von 3
                  Minuten keine Antwort, wird die Aktion abgebrochen. Damit
                  sind auch Aktionen mit Bestätigungspflicht — etwa
                  CRM-Löschungen — vom Handy aus möglich.
                </p>
              )}

              {/* v0.1.462 — Vollmacht (PLAN_VOLLMACHT.md): welche
                  Wirkungsklassen darf AVA ohne Rückfrage bestätigen? */}
              <label className="field">
                <span>Vollmacht (ohne Rückfrage bestätigen)</span>
                <select
                  value={cfg.autonomyLevel}
                  disabled={busy}
                  onChange={(e) =>
                    void patch({
                      autonomyLevel: e.target
                        .value as TelegramConfig["autonomyLevel"],
                    })
                  }
                >
                  <option value="none">Keine — immer fragen</option>
                  <option value="additive">
                    Neues anlegen (Notiz, Aktivität, Aufgabe, Neuanlage,
                    Verknüpfung)
                  </option>
                  <option value="mutating">
                    Neues anlegen + Bestehendes ändern
                  </option>
                </select>
              </label>
              {cfg.autonomyLevel !== "none" && (
                <p className="muted small">
                  Gedeckte Aktionen bestätigt AVA autonom — jede davon landet
                  im Audit-Trail. Löschen und andere destruktive Aktionen
                  bleiben IMMER bestätigungspflichtig
                  {cfg.inboundConfirmEnabled
                    ? " (Rückfrage in diesem Chat)"
                    : " (nur am Rechner)"}
                  .
                </p>
              )}
            </>
          )}

          <label className="field-inline">
            <input
              type="checkbox"
              checked={cfg.respectQuietHours}
              disabled={busy}
              onChange={(e) =>
                void patch({ respectQuietHours: e.target.checked })
              }
            />
            <span>Ruhezeiten auch für Telegram beachten</span>
          </label>
        </>
      )}

      {error && <p className="error">Fehler: {error}</p>}
      {info && <p className="muted">{info}</p>}
    </section>
  );
}
