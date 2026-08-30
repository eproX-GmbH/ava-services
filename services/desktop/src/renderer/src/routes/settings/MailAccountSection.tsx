// v0.1.257 — Mail-Konto-Verwaltung im Datenquellen-Tab.
//
// Konfiguriert AVAs dediziertes Mail-Konto (IMAP + SMTP) plus die
// Sender-Allowlist, die das Trust-Modell antreibt. Auf dieser Seite:
//   1. Konto-Form (Adresse, Display-Name, IMAP/SMTP-Hosts, Passwörter,
//      Outbound-Schalter)
//   2. Test-Connection-Button (verifiziert IMAP + SMTP ohne zu speichern)
//   3. Allowlist-Liste mit Add/Remove
//   4. Connection-State-Anzeige (idling/polling/disconnected/error)
//
// Sicherheit: Passwörter werden nie in PGlite oder unverschlüsselt
// gespeichert — der main-process verschlüsselt sie sofort via safeStorage.
// Außerdem ist der "AVA darf Mails verschicken"-Schalter standardmäßig
// AUS; der User muss aktiv freigeben.

import { useEffect, useState, type FormEvent } from "react";
import type {
  MailAccount,
  MailAllowlistEntry,
  MailCredentialsPayload,
  MailSnapshot,
} from "../../../../shared/types";

interface FormState {
  address: string;
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  outboundEnabled: boolean;
  // v0.1.299 — Auto-Triage für eingehende trusted Mails (siehe Toggle
  // im Form). Default off, explizites Opt-in.
  autoTriageEnabled: boolean;
  pollIntervalMinutes: number;
}

const EMPTY_FORM: FormState = {
  address: "",
  displayName: "AVA",
  imapHost: "",
  imapPort: 993,
  imapSecure: true,
  imapUser: "",
  imapPassword: "",
  smtpHost: "",
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: "",
  smtpPassword: "",
  outboundEnabled: false,
  autoTriageEnabled: false,
  pollIntervalMinutes: 15,
};

export function MailAccountSection(): JSX.Element {
  const [snapshot, setSnapshot] = useState<MailSnapshot | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.mail.snapshot().then(setSnapshot);
    const off = window.api.mail.onSnapshot(setSnapshot);
    return () => off();
  }, []);

  // Wenn ein Konto existiert und der User NICHT editiert, Felder aus
  // dem Snapshot reflektieren (Passwörter bleiben leer — wir zeigen die
  // gespeicherten nie an, der User muss bei jedem Edit neu eingeben).
  useEffect(() => {
    if (editing || !snapshot?.account) return;
    const a = snapshot.account;
    setForm({
      address: a.address,
      displayName: a.displayName,
      imapHost: a.imap.host,
      imapPort: a.imap.port,
      imapSecure: a.imap.secure,
      imapUser: a.imap.user,
      imapPassword: "",
      smtpHost: a.smtp.host,
      smtpPort: a.smtp.port,
      smtpSecure: a.smtp.secure,
      smtpUser: a.smtp.user,
      smtpPassword: "",
      outboundEnabled: a.outboundEnabled,
      autoTriageEnabled: a.autoTriageEnabled === true,
      pollIntervalMinutes: a.pollIntervalMinutes,
    });
  }, [snapshot, editing]);

  const buildAccount = (): MailAccount => ({
    address: form.address.trim(),
    displayName: form.displayName.trim() || "AVA",
    imap: {
      host: form.imapHost.trim(),
      port: form.imapPort,
      secure: form.imapSecure,
      user: form.imapUser.trim() || form.address.trim(),
    },
    smtp: {
      host: form.smtpHost.trim(),
      port: form.smtpPort,
      secure: form.smtpSecure,
      user: form.smtpUser.trim() || form.address.trim(),
    },
    outboundEnabled: form.outboundEnabled,
    autoTriageEnabled: form.autoTriageEnabled,
    pollIntervalMinutes: form.pollIntervalMinutes,
    lastSyncAt: snapshot?.account?.lastSyncAt ?? null,
    lastErrorAt: snapshot?.account?.lastErrorAt ?? null,
    lastErrorMessage: snapshot?.account?.lastErrorMessage ?? null,
  });

  const buildCreds = (): MailCredentialsPayload => ({
    imapPassword: form.imapPassword,
    smtpPassword: form.smtpPassword || form.imapPassword, // viele Anbieter: gleicher PW
  });

  const onTest = async (): Promise<void> => {
    setError(null);
    setTestResult(null);
    setBusy(true);
    try {
      const r = await window.api.mail.testConnection(buildAccount(), buildCreds());
      if ("error" in r) setError(r.error);
      else setTestResult(`IMAP ${r.imap ? "✓" : "✗"} · SMTP ${r.smtp ? "✓" : "✗"}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSave = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await window.api.mail.configure(buildAccount(), buildCreds());
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setEditing(false);
      setForm((f) => ({ ...f, imapPassword: "", smtpPassword: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (): Promise<void> => {
    if (
      !window.confirm(
        "Mail-Konto wirklich löschen? Verbindungen werden getrennt, gespeicherte Mails bleiben für den Verlauf erhalten.",
      )
    )
      return;
    setBusy(true);
    try {
      await window.api.mail.deleteAccount();
      setForm(EMPTY_FORM);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const account = snapshot?.account;
  const showForm = editing || !account;

  return (
    <section id="mail-account-section" className="provider-section alerts-prefs">
      <h3>Mail-Konto</h3>
      <p className="muted">
        AVAs dediziertes IMAP/SMTP-Postfach. Eingehende Mails werden
        klassifiziert (Triage-Inbox) und nur Absender in der Allowlist dürfen
        autonome Aktionen auslösen.
      </p>

      {account && !editing && (
        <ConnectedAccountView
          account={account}
          state={snapshot?.connectionState ?? "disconnected"}
          unread={snapshot?.unreadCount ?? 0}
          onEdit={() => setEditing(true)}
          onDelete={onDelete}
        />
      )}

      {showForm && (
        <form className="mail-form" onSubmit={onSave}>
          <div className="mail-form__row">
            <label>
              <span>Mail-Adresse</span>
              <input
                type="email"
                required
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="ava@firma.de"
              />
            </label>
            <label>
              <span>Anzeigename</span>
              <input
                type="text"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="AVA"
              />
            </label>
          </div>

          <fieldset>
            <legend>IMAP (Eingang)</legend>
            <div className="mail-form__row">
              <label>
                <span>Host</span>
                <input
                  type="text"
                  required
                  value={form.imapHost}
                  onChange={(e) => setForm({ ...form, imapHost: e.target.value })}
                  placeholder="imap.firma.de"
                />
              </label>
              <label>
                <span>Port</span>
                <input
                  type="number"
                  required
                  value={form.imapPort}
                  onChange={(e) =>
                    setForm({ ...form, imapPort: parseInt(e.target.value, 10) || 993 })
                  }
                />
              </label>
              <label className="mail-form__checkbox">
                <input
                  type="checkbox"
                  checked={form.imapSecure}
                  onChange={(e) => setForm({ ...form, imapSecure: e.target.checked })}
                />
                <span>TLS</span>
              </label>
            </div>
            <div className="mail-form__row">
              <label>
                <span>Benutzer (Default: Mail-Adresse)</span>
                <input
                  type="text"
                  value={form.imapUser}
                  onChange={(e) => setForm({ ...form, imapUser: e.target.value })}
                  placeholder={form.address}
                />
              </label>
              <label>
                <span>App-Passwort</span>
                <input
                  type="password"
                  required={showForm && !account}
                  value={form.imapPassword}
                  onChange={(e) =>
                    setForm({ ...form, imapPassword: e.target.value })
                  }
                  placeholder={account ? "(unverändert lassen)" : ""}
                />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>SMTP (Ausgang)</legend>
            <div className="mail-form__row">
              <label>
                <span>Host</span>
                <input
                  type="text"
                  required
                  value={form.smtpHost}
                  onChange={(e) => setForm({ ...form, smtpHost: e.target.value })}
                  placeholder="smtp.firma.de"
                />
              </label>
              <label>
                <span>Port</span>
                <input
                  type="number"
                  required
                  value={form.smtpPort}
                  onChange={(e) =>
                    setForm({ ...form, smtpPort: parseInt(e.target.value, 10) || 465 })
                  }
                />
              </label>
              <label className="mail-form__checkbox">
                <input
                  type="checkbox"
                  checked={form.smtpSecure}
                  onChange={(e) => setForm({ ...form, smtpSecure: e.target.checked })}
                />
                <span>TLS</span>
              </label>
            </div>
            <div className="mail-form__row">
              <label>
                <span>Benutzer (Default: Mail-Adresse)</span>
                <input
                  type="text"
                  value={form.smtpUser}
                  onChange={(e) => setForm({ ...form, smtpUser: e.target.value })}
                  placeholder={form.address}
                />
              </label>
              <label>
                <span>App-Passwort (leer = wie IMAP)</span>
                <input
                  type="password"
                  value={form.smtpPassword}
                  onChange={(e) =>
                    setForm({ ...form, smtpPassword: e.target.value })
                  }
                  placeholder={account ? "(unverändert lassen)" : ""}
                />
              </label>
            </div>
          </fieldset>

          <div className="mail-form__row">
            <label className="mail-form__checkbox">
              <input
                type="checkbox"
                checked={form.outboundEnabled}
                onChange={(e) =>
                  setForm({ ...form, outboundEnabled: e.target.checked })
                }
              />
              <span>
                <strong>AVA darf Mails verschicken</strong> (Kill-Switch).
                Wenn deaktiviert, lehnt AVA jeden Versand ab — auch an Allowlist-Adressen.
              </span>
            </label>
          </div>
          {/* v0.1.299 — Auto-Triage-Toggle. Nur sinnvoll wenn Versand
              überhaupt erlaubt ist; im UI dimmen wir das Feld wenn
              outboundEnabled aus ist. */}
          <div className="mail-form__row">
            <label className="mail-form__checkbox">
              <input
                type="checkbox"
                checked={form.autoTriageEnabled ?? false}
                disabled={!form.outboundEnabled}
                onChange={(e) =>
                  setForm({ ...form, autoTriageEnabled: e.target.checked })
                }
              />
              <span>
                <strong>Auto-Triage für trusted Mails</strong> (vollautonom).
                Bei eingehenden Mails von Allowlist-Sendern startet AVA
                automatisch eine Chat-Session und antwortet OHNE Rückfrage.
                Limits: max 5 Auto-Replies pro Thread, Cooldown 5min.
                Nicht-Allowlist-Mails bleiben unverändert manuell.
                Setzt aktivierten Versand voraus.
              </span>
            </label>
          </div>

          {error && <div className="mail-form__error">Fehler: {error}</div>}
          {testResult && <div className="mail-form__ok">{testResult}</div>}

          <div className="mail-form__actions">
            <button type="button" onClick={onTest} disabled={busy}>
              Verbindung testen
            </button>
            <button type="submit" disabled={busy} className="primary">
              Speichern
            </button>
            {editing && (
              <button type="button" onClick={() => setEditing(false)} disabled={busy}>
                Abbrechen
              </button>
            )}
          </div>
        </form>
      )}

      <AllowlistEditor
        entries={snapshot?.allowlist ?? []}
        onAdded={(e) => {
          // Snapshot wird via onSnapshot-Push aktualisiert; lokales Mirror
          // hier nicht nötig.
          void e;
        }}
      />
    </section>
  );
}

function ConnectedAccountView({
  account,
  state,
  unread,
  onEdit,
  onDelete,
}: {
  account: MailAccount;
  state: MailSnapshot["connectionState"];
  unread: number;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="mail-account-summary">
      <div className="mail-account-summary__main">
        <strong>{account.address}</strong>{" "}
        <span className="muted">({account.displayName})</span>
        <div className="muted">
          IMAP {account.imap.host}:{account.imap.port} · SMTP{" "}
          {account.smtp.host}:{account.smtp.port}
        </div>
        <div className="muted">
          Status:{" "}
          <ConnectionPill state={state} />
          {unread > 0 && <> · {unread} ungelesen</>}
          {!account.outboundEnabled && (
            <> · <span className="warn">Versand deaktiviert</span></>
          )}
        </div>
        {account.lastErrorMessage && (
          <div className="mail-form__error">
            Letzter Fehler: {account.lastErrorMessage}
          </div>
        )}
      </div>
      <div className="mail-account-summary__actions">
        <button type="button" onClick={onEdit}>
          Bearbeiten
        </button>
        <button type="button" onClick={onDelete} className="danger">
          Löschen
        </button>
      </div>
    </div>
  );
}

function ConnectionPill({
  state,
}: {
  state: MailSnapshot["connectionState"];
}): JSX.Element {
  const label = stateLabel(state);
  return <span className={`pill pill--${state}`}>{label}</span>;
}

function stateLabel(state: MailSnapshot["connectionState"]): string {
  switch (state) {
    case "connecting":
      return "verbinde…";
    case "connected":
      return "verbunden";
    case "idling":
      return "IDLE (Push)";
    case "polling":
      return "Polling";
    case "disconnected":
      return "getrennt";
    case "error":
      return "Fehler";
  }
}

function AllowlistEditor({
  entries,
  onAdded,
}: {
  entries: MailAllowlistEntry[];
  onAdded: (entry: MailAllowlistEntry) => void;
}): JSX.Element {
  const [pattern, setPattern] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdd = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!pattern.trim() || !label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.mail.addAllowlistEntry(pattern.trim(), label.trim());
      if ("error" in r) {
        setError(r.error);
        return;
      }
      onAdded(r);
      setPattern("");
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id: string): Promise<void> => {
    if (!window.confirm("Diesen Allowlist-Eintrag entfernen?")) return;
    await window.api.mail.removeAllowlistEntry(id);
  };

  return (
    <div className="mail-allowlist">
      <h4>Allowlist — vertrauenswürdige Absender</h4>
      <p className="muted">
        Nur Mails von Absendern in dieser Liste darf AVA autonom beantworten.
        Pattern: <code>max@kunde.de</code> oder Domain-Wildcard <code>*@kunde.de</code>.
      </p>

      <form className="mail-allowlist__form" onSubmit={onAdd}>
        <input
          type="text"
          placeholder="max@kunde.de oder *@kunde.de"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
        <input
          type="text"
          placeholder="Label, z. B. Max Mustermann"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Hinzufügen
        </button>
      </form>
      {error && <div className="mail-form__error">{error}</div>}

      {entries.length === 0 ? (
        <p className="muted">Noch keine Einträge — AVA agiert auf keine Mail autonom.</p>
      ) : (
        <ul className="mail-allowlist__list">
          {entries.map((e) => (
            <li key={e.id}>
              <span>
                <code>{e.pattern}</code> · {e.label}
              </span>
              <span className="muted">
                {e.source === "agent" ? "AVA" : "manuell"} ·{" "}
                {new Date(e.addedAt).toLocaleDateString("de-DE")}
              </span>
              <button type="button" onClick={() => onRemove(e.id)}>
                Entfernen
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
