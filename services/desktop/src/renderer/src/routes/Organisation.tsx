// O2–O5 (docs/PLAN_ORGANISATIONEN.md) — Seite „Organisation" (Untermenue
// von Einstellungen). Aufbau wie Einstellungen → Modelle: provider-section-
// Karten, provider-grid/field fuer Formulare, provider-key-card fuer
// Schluessel. Modellvorgaben kommen aus dem Katalog (kein Freitext).
//
// Persoenlicher Bereich: Organisation anlegen oder per Einladungslink
// beitreten. Organisation: Ueberblick + Einladungslink, offene Anfragen
// (Admin), Mitglieder/Rollen, Funktionen, KI-Vorgaben, Organisations-
// schluessel (KI-Anbieter) und Apify getrennt, Austritt.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Building2 } from "lucide-react";
import { gatewayFetch } from "../api/gateway";
import { PROVIDER_LABEL, modelOptionLabel } from "./Settings";
import {
  ORG_FEATURES,
  type LlmProviderKind,
  type OrgPolicy,
  type OrgState,
  type ProviderCatalogEntry,
} from "../../../shared/types";

interface WhoamiLite {
  tenantId: string;
  actorId: string;
  openJoinRequest?: { tenantId: string; tenantName: string | null; requestedAt: string } | null;
}

type Aktion = (fn: () => Promise<void>, okText?: string) => Promise<void>;

const ROLLEN: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Mitglied" };
const LLM_ANBIETER: LlmProviderKind[] = ["openai", "anthropic", "google", "mistral", "deepseek", "xai", "qwen"];

function datum(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")}.${d.getFullYear()}`;
}

function fehlerText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function Organisation() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [joinToken, setJoinToken] = useState<string | null>(params.get("join"));
  const [meldung, setMeldung] = useState<{ art: "ok" | "fehler"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const whoami = useQuery({ queryKey: ["whoami"], queryFn: () => gatewayFetch<WhoamiLite>("/v1/whoami") });
  const org = useQuery({ queryKey: ["org"], queryFn: () => gatewayFetch<OrgState>("/v1/tenants/me") });

  useEffect(() => {
    if (joinToken) return;
    void window.api.org.consumePendingJoin().then((t) => {
      if (t) setJoinToken(t);
    });
  }, [joinToken]);
  useEffect(() => window.api.org.onRequestsChanged(() => void qc.invalidateQueries({ queryKey: ["org"] })), [qc]);

  const neuLaden = () => {
    void qc.invalidateQueries({ queryKey: ["org"] });
    void qc.invalidateQueries({ queryKey: ["whoami"] });
  };

  const aktion: Aktion = async (fn, okText) => {
    setBusy(true);
    setMeldung(null);
    try {
      await fn();
      if (okText) setMeldung({ art: "ok", text: okText });
      neuLaden();
    } catch (err) {
      setMeldung({ art: "fehler", text: fehlerText(err) });
    } finally {
      setBusy(false);
    }
  };

  const beitrittAnfragen = (token: string) =>
    aktion(async () => {
      const r = await gatewayFetch<{ tenantName: string | null }>("/v1/tenants/join", {
        method: "POST",
        body: { inviteToken: token },
      });
      setJoinToken(null);
      setParams({});
      setMeldung({
        art: "ok",
        text: `Beitritt zu ${r.tenantName ?? "der Organisation"} angefragt. Ein Admin muss die Anfrage freigeben; AVA meldet sich dann.`,
      });
    });

  const kopf = (
    <header className="ct-page-header">
      <p className="ct-page-header__eyebrow">
        <Building2 className="ct-icon-sm" aria-hidden="true" /> Einstellungen
      </p>
      <h2 className="ct-page-header__title">Organisation</h2>
      <p className="ct-page-header__lede">
        Gemeinsamer Firmenbestand, Vorgaben und zentrale Schlüssel für ein Team. Mit eigenem Schlüssel läuft alles lokal
        wie bisher.
      </p>
    </header>
  );

  if (whoami.isLoading || org.isLoading) {
    return (
      <section className="page org-page">
        {kopf}
        <p className="muted">Lädt…</p>
      </section>
    );
  }
  if (org.error || whoami.error) {
    return (
      <section className="page org-page">
        {kopf}
        <p className="error">Fehler: {fehlerText(org.error ?? whoami.error)}</p>
      </section>
    );
  }
  const st = org.data!;
  const me = whoami.data!;
  const admin = st.kind === "organisation" && (st.myRole === "owner" || st.myRole === "admin");

  return (
    <section className="page org-page" style={{ paddingBottom: "2rem" }}>
      {kopf}
      {meldung && (
        <div className={`active-config-card${meldung.art === "fehler" ? " active-config-card--warn" : ""}`} role="status">
          <div className="active-config-card__row">
            <span className="active-config-card__label">{meldung.art === "fehler" ? "Fehler" : "Hinweis"}</span>
            <span className="active-config-card__value">{meldung.text}</span>
          </div>
        </div>
      )}

      {joinToken && (
        <section className="provider-section">
          <h3>Einladung erhalten</h3>
          <p className="muted small">
            Du hast einen Einladungslink geöffnet. Soll AVA den Beitritt anfragen? Bis ein Admin freigibt, bleibst du in
            deinem jetzigen Bereich.
          </p>
          <div className="org-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void beitrittAnfragen(joinToken)}>
              Beitritt anfragen
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setJoinToken(null);
                setParams({});
              }}
            >
              Verwerfen
            </button>
          </div>
        </section>
      )}

      {st.kind === "personal" ? (
        <Persoenlich me={me} busy={busy} aktion={aktion} beitrittAnfragen={beitrittAnfragen} />
      ) : (
        <>
          <Ueberblick st={st} admin={admin} busy={busy} aktion={aktion} />
          {admin && <Anfragen st={st} busy={busy} aktion={aktion} />}
          <Mitglieder st={st} me={me} admin={admin} busy={busy} aktion={aktion} />
          <Vorgaben st={st} admin={admin} busy={busy} aktion={aktion} />
          <Schluessel st={st} admin={admin} busy={busy} aktion={aktion} />
          <Verlassen st={st} me={me} busy={busy} aktion={aktion} />
        </>
      )}
    </section>
  );
}

// ---- Persoenlicher Bereich ---------------------------------------------------

function Persoenlich({
  me,
  busy,
  aktion,
  beitrittAnfragen,
}: {
  me: WhoamiLite;
  busy: boolean;
  aktion: Aktion;
  beitrittAnfragen: (token: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [link, setLink] = useState("");

  const anlegen = () =>
    aktion(async () => {
      await gatewayFetch("/v1/tenants", { method: "POST", body: { name: name.trim() } });
      const neu = await window.api.org.checkTenant();
      if (!neu) throw new Error("Organisation angelegt, aber der Abgleich hat keinen Wechsel erkannt. Bitte AVA neu starten.");
    });

  const linkEinloesen = () =>
    aktion(async () => {
      const token = await window.api.org.extractJoinToken(link);
      if (!token) throw new Error("Das ist kein gültiger Einladungslink (erwartet: ava://join/…).");
      await beitrittAnfragen(token);
    });

  return (
    <>
      <section className="provider-section">
        <h3>Persönlicher Bereich</h3>
        <p className="muted small">
          Firmen, Kontakte und Schlüssel gehören nur dir. Eine Organisation teilt Firmenbestand, Vorgaben und auf Wunsch
          zentrale Schlüssel mit ihren Mitgliedern.
        </p>
        {me.openJoinRequest && (
          <div className="active-config-card">
            <div className="active-config-card__row">
              <span className="active-config-card__label">Beitritt angefragt</span>
              <span className="active-config-card__value">
                {me.openJoinRequest.tenantName ?? "Organisation"} · am {datum(me.openJoinRequest.requestedAt)} · wartet auf
                Freigabe durch einen Admin
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="provider-section">
        <h3>Organisation anlegen</h3>
        <p className="muted small">
          Du wirst Owner. Deine bisherigen Firmen und Kontakte bleiben in deinem persönlichen Bereich; AVA startet danach in
          der neuen Organisation neu.
        </p>
        <div className="org-inline">
          <input type="text" placeholder="Name der Organisation" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="primary" disabled={busy || name.trim().length < 2} onClick={() => void anlegen()}>
            Anlegen
          </button>
        </div>
      </section>

      <section className="provider-section">
        <h3>Einer Organisation beitreten</h3>
        <p className="muted small">Füge den Einladungslink ein, den du von einem Admin bekommen hast (ava://join/…).</p>
        <div className="org-inline">
          <input type="text" placeholder="ava://join/…" value={link} onChange={(e) => setLink(e.target.value)} />
          <button type="button" className="btn" disabled={busy || link.trim().length < 8} onClick={() => void linkEinloesen()}>
            Beitritt anfragen
          </button>
        </div>
      </section>
    </>
  );
}

// ---- Organisation ----------------------------------------------------------

function Ueberblick({ st, admin, busy, aktion }: { st: OrgState; admin: boolean; busy: boolean; aktion: Aktion }) {
  const [kopiert, setKopiert] = useState(false);
  const link = st.inviteToken ? `ava://join/${st.inviteToken}` : null;

  const kopieren = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2000);
    } catch {
      window.prompt("Link kopieren:", link);
    }
  };
  const linkErneuern = () => {
    if (!window.confirm("Neuen Einladungslink erzeugen? Der bisherige Link wird sofort ungültig.")) return;
    void aktion(() => gatewayFetch("/v1/tenants/me/invite", { method: "POST" }), "Neuer Einladungslink erzeugt.");
  };

  return (
    <section className="provider-section">
      <h3>{st.name ?? st.tenantId}</h3>
      <div className="active-config-card">
        <div className="active-config-card__row">
          <span className="active-config-card__label">Deine Rolle</span>
          <span className="active-config-card__value">
            <span className="badge ok">{ROLLEN[st.myRole] ?? st.myRole}</span>
          </span>
        </div>
        <div className="active-config-card__row">
          <span className="active-config-card__label">Mitglieder</span>
          <span className="active-config-card__value">{st.members.length}</span>
        </div>
        {admin && link && (
          <div className="active-config-card__row">
            <span className="active-config-card__label">Einladungslink</span>
            <span className="active-config-card__value">
              <span className="org-code">{link}</span>
            </span>
          </div>
        )}
      </div>
      {admin && (
        <>
          <div className="org-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void kopieren()}>
              {kopiert ? "Kopiert" : "Link kopieren"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={linkErneuern}>
              Link erneuern
            </button>
          </div>
          <p className="muted small">
            Wer den Link in AVA öffnet oder unter Organisation einfügt, stellt eine Beitrittsanfrage. Du gibst sie unten
            frei.
          </p>
        </>
      )}
    </section>
  );
}

function Anfragen({ st, busy, aktion }: { st: OrgState; busy: boolean; aktion: Aktion }) {
  const entscheiden = (id: string, entscheidung: "approve" | "reject") =>
    aktion(
      () => gatewayFetch(`/v1/tenants/me/requests/${encodeURIComponent(id)}`, { method: "POST", body: { entscheidung } }),
      entscheidung === "approve" ? "Anfrage angenommen. Die Person wird beim nächsten Abgleich Mitglied." : "Anfrage abgelehnt.",
    );
  return (
    <section className="provider-section">
      <h3>Offene Anfragen</h3>
      {st.openRequests.length === 0 ? (
        <p className="muted small">Keine offenen Beitrittsanfragen.</p>
      ) : (
        <div className="org-list">
          {st.openRequests.map((r) => (
            <div key={r.id} className="org-row">
              <div className="org-row__main">
                <span className="org-row__title">{r.name ?? r.email ?? r.actorId}</span>
                <span className="org-row__meta">
                  {r.email && r.name ? `${r.email} · ` : ""}angefragt am {datum(r.requestedAt)}
                </span>
              </div>
              <div className="org-row__actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void entscheiden(r.id, "approve")}>
                  Aufnehmen
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void entscheiden(r.id, "reject")}>
                  Ablehnen
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Mitglieder({
  st,
  me,
  admin,
  busy,
  aktion,
}: {
  st: OrgState;
  me: WhoamiLite;
  admin: boolean;
  busy: boolean;
  aktion: Aktion;
}) {
  const owner = st.myRole === "owner";
  const entfernen = (actorId: string, label: string) => {
    if (!window.confirm(`${label} aus ${st.name ?? "der Organisation"} entfernen? Die Person fällt in ihren persönlichen Bereich zurück.`)) return;
    void aktion(() => gatewayFetch(`/v1/tenants/me/members/${encodeURIComponent(actorId)}`, { method: "DELETE" }), `${label} entfernt.`);
  };
  const rolleSetzen = (actorId: string, role: string) =>
    aktion(() => gatewayFetch(`/v1/tenants/me/members/${encodeURIComponent(actorId)}`, { method: "PATCH", body: { role } }));

  return (
    <section className="provider-section">
      <h3>Mitglieder</h3>
      <div className="org-list">
        {st.members.map((m) => {
          const label = m.name ?? m.email ?? `${m.actorId.slice(0, 8)}…`;
          const ich = m.actorId === me.actorId;
          return (
            <div key={m.actorId} className="org-row">
              <div className="org-row__main">
                <span className="org-row__title">
                  {label}
                  {ich && <span className="muted"> · das bist du</span>}
                </span>
                <span className="org-row__meta">
                  {m.email && m.name ? `${m.email} · ` : ""}
                  {ROLLEN[m.role] ?? m.role} · seit {datum(m.joinedAt)}
                </span>
              </div>
              <div className="org-row__actions">
                {owner && !ich && (
                  <select value={m.role} disabled={busy} onChange={(e) => void rolleSetzen(m.actorId, e.target.value)}>
                    <option value="member">Mitglied</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                )}
                {admin && !ich && (
                  <button type="button" className="btn btn--danger" disabled={busy} onClick={() => entfernen(m.actorId, label)}>
                    Entfernen
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted small">
        Name und E-Mail kennt AVA aus der Beitrittsanfrage; wer die Organisation angelegt hat, erscheint mit Nutzer-ID.
      </p>
    </section>
  );
}

// ---- Vorgaben --------------------------------------------------------------

function ModellAuswahl({
  label,
  value,
  models,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  models: ProviderCatalogEntry[];
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const gruppen = useMemo(() => {
    const by = new Map<LlmProviderKind, ProviderCatalogEntry[]>();
    for (const m of models) {
      const list = by.get(m.provider) ?? [];
      list.push(m);
      by.set(m.provider, list);
    }
    return Array.from(by.entries());
  }, [models]);
  const unbekannt = value && !models.some((m) => m.id === value);
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">frei (Mitglieder wählen selbst)</option>
        {unbekannt && <option value={value}>{value} (nicht im Katalog)</option>}
        {gruppen.map(([kind, list]) => (
          <optgroup key={kind} label={PROVIDER_LABEL[kind]}>
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {modelOptionLabel(m)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function Vorgaben({ st, admin, busy, aktion }: { st: OrgState; admin: boolean; busy: boolean; aktion: Aktion }) {
  const [entwurf, setEntwurf] = useState<OrgPolicy>(st.policy);
  useEffect(() => setEntwurf(st.policy), [st.policy]);
  const models = useQuery<ProviderCatalogEntry[]>({
    queryKey: ["agent", "models"],
    queryFn: () => window.api.agent.listModels(),
    staleTime: Infinity,
  });
  const p = st.policy;

  const speichern = () =>
    aktion(async () => {
      await gatewayFetch("/v1/tenants/me/policy", {
        method: "PUT",
        body: {
          features: entwurf.features,
          providerLock: entwurf.providerLock,
          chatModel: entwurf.chatModel || null,
          producerModel: entwurf.producerModel || null,
          promptAudit: entwurf.promptAudit,
        },
      });
      await window.api.org.refreshPolicy();
    }, "Vorgaben gespeichert. Mitglieder übernehmen sie beim nächsten Abgleich (spätestens in 10 Minuten).");

  if (!admin) {
    const aus = ORG_FEATURES.filter((f) => p.features[f.key] === false).map((f) => f.label);
    return (
      <section className="provider-section">
        <h3>Vorgaben</h3>
        <div className="active-config-card">
          <div className="active-config-card__row">
            <span className="active-config-card__label">Abgeschaltet</span>
            <span className="active-config-card__value">{aus.length === 0 ? "keine Funktion" : aus.join(", ")}</span>
          </div>
          <div className="active-config-card__row">
            <span className="active-config-card__label">Anbieter-Sperre</span>
            <span className="active-config-card__value">{p.providerLock ? "lokales Überschreiben gesperrt" : "lokales Überschreiben erlaubt"}</span>
          </div>
          <div className="active-config-card__row">
            <span className="active-config-card__label">Modelle</span>
            <span className="active-config-card__value">
              Chat: {p.chatModel ?? "frei"} · Hintergrund: {p.producerModel ?? "frei"}
            </span>
          </div>
          <div className="active-config-card__row">
            <span className="active-config-card__label">Prompt-Audit</span>
            <span className="active-config-card__value">{p.promptAudit ? "aktiv" : "aus"}</span>
          </div>
        </div>
      </section>
    );
  }

  const geaendert = JSON.stringify(entwurf) !== JSON.stringify(p);

  return (
    <>
      <section className="provider-section">
        <h3>Funktionen</h3>
        <p className="muted small">
          Abgeschaltete Funktionen verschwinden bei allen Mitgliedern aus Navigation, Einstellungen und Chat; Hintergrunddienste
          stoppen. Kontakt-Recherche wird zusätzlich im Gateway abgewiesen.
        </p>
        <div className="org-checks">
          {ORG_FEATURES.map((f) => (
            <label key={f.key} className="org-check">
              <input
                type="checkbox"
                checked={entwurf.features[f.key] !== false}
                disabled={busy}
                onChange={(e) => setEntwurf({ ...entwurf, features: { ...entwurf.features, [f.key]: e.target.checked } })}
              />
              <span>
                {f.label}
                <span className="org-check__hint">{f.hinweis}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="provider-section">
        <h3>KI-Vorgaben</h3>
        <p className="muted small">
          Modelle aus dem Katalog wie in Einstellungen → Modelle. Ein vorgegebenes Modell wirkt nur mit Anbieter-Sperre;
          sonst ist es die Empfehlung, Mitglieder dürfen abweichen.
        </p>
        <div className="provider-grid">
          <ModellAuswahl
            label="Chat-Modell"
            value={entwurf.chatModel}
            models={models.data ?? []}
            disabled={busy || models.isLoading}
            onChange={(v) => setEntwurf({ ...entwurf, chatModel: v })}
          />
          <ModellAuswahl
            label="Modell für Hintergrund-Verarbeitung"
            value={entwurf.producerModel}
            models={models.data ?? []}
            disabled={busy || models.isLoading}
            onChange={(v) => setEntwurf({ ...entwurf, producerModel: v })}
          />
        </div>
        <div className="org-checks">
          <label className="org-check">
            <input
              type="checkbox"
              checked={entwurf.providerLock}
              disabled={busy}
              onChange={(e) => setEntwurf({ ...entwurf, providerLock: e.target.checked })}
            />
            <span>
              Anbieter-Sperre
              <span className="org-check__hint">
                Mitglieder dürfen Anbieter, Schlüssel und Modell nicht lokal überschreiben; Aufrufe laufen über die
                Organisationsschlüssel.
              </span>
            </span>
          </label>
          <label className="org-check">
            <input
              type="checkbox"
              checked={entwurf.promptAudit}
              disabled={busy}
              onChange={(e) => setEntwurf({ ...entwurf, promptAudit: e.target.checked })}
            />
            <span>
              Prompt-Audit
              <span className="org-check__hint">
                Prompts und Antworten über den Organisationsschlüssel werden im Gateway gespeichert (Opt-in; ohne Audit nur
                Zähler).
              </span>
            </span>
          </label>
        </div>
        <div className="org-actions">
          <button type="button" className="primary" disabled={busy || !geaendert} onClick={() => void speichern()}>
            Vorgaben speichern
          </button>
          {geaendert && <span className="muted small">ungespeicherte Änderungen</span>}
        </div>
      </section>
    </>
  );
}

// ---- Organisationsschluessel ------------------------------------------------

function OrgKeyCard({
  kind,
  label,
  hint,
  admin,
  busy,
  beschreibung,
  aktion,
}: {
  kind: string;
  label: string;
  hint: string | null;
  admin: boolean;
  busy: boolean;
  beschreibung?: string;
  aktion: Aktion;
}) {
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (apiKey: string) =>
      aktion(async () => {
        await gatewayFetch(`/v1/tenants/me/providers/${kind}`, { method: "PUT", body: { apiKey } });
        setDraft("");
        await window.api.org.refreshPolicy();
      }, `${label}: Organisationsschlüssel gespeichert.`),
  });
  const clear = useMutation({
    mutationFn: () =>
      aktion(async () => {
        await gatewayFetch(`/v1/tenants/me/providers/${kind}`, { method: "DELETE" });
        await window.api.org.refreshPolicy();
      }, `${label}: Organisationsschlüssel entfernt.`),
  });
  const entfernen = () => {
    if (!window.confirm(`Organisationsschlüssel für ${label} entfernen? Mitglieder, die ihn nutzen, verlieren den Zugriff.`)) return;
    clear.mutate();
  };
  return (
    <div className="provider-key-card">
      <div className="provider-key-card__header">
        <span className="provider-key-card__title">{label}</span>
        {hint ? <span className="badge ok">hinterlegt · …{hint}</span> : <span className="badge">kein Schlüssel</span>}
      </div>
      {admin && (
        <div className="provider-key-card__input-row">
          <input
            type="password"
            placeholder={hint ? "•••• hinterlegt, neuen Schlüssel einfügen, um zu ersetzen" : "Schlüssel"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <button type="button" onClick={() => save.mutate(draft.trim())} disabled={busy || draft.trim().length < 8}>
            Speichern
          </button>
          {hint ? (
            <button type="button" className="link" onClick={entfernen} disabled={busy} title="Organisationsschlüssel entfernen">
              entfernen
            </button>
          ) : (
            <span />
          )}
        </div>
      )}
      {beschreibung && <p className="provider-key-card__description">{beschreibung}</p>}
    </div>
  );
}

function Schluessel({ st, admin, busy, aktion }: { st: OrgState; admin: boolean; busy: boolean; aktion: Aktion }) {
  const hints: Record<string, string> = {};
  for (const p of st.providers ?? []) hints[p.kind] = p.keyHint;
  return (
    <>
      <section className="provider-section">
        <h3>Organisationsschlüssel für KI-Anbieter</h3>
        <p className="muted small">
          Die Schlüssel bleiben verschlüsselt im AVA-Gateway; Mitglieder rufen die Anbieter darüber auf, ohne den Schlüssel
          je zu sehen. Verbrauch wird der Organisation zugerechnet. Das Gateway sieht dabei die Prompts (Frankfurt, EU),
          speichert sie aber nur mit Prompt-Audit.
        </p>
        <div className="api-keys">
          {LLM_ANBIETER.map((kind) => (
            <OrgKeyCard key={kind} kind={kind} label={PROVIDER_LABEL[kind]} hint={hints[kind] ?? null} admin={admin} busy={busy} aktion={aktion} />
          ))}
        </div>
      </section>
      <section className="provider-section">
        <h3>Apify</h3>
        <p className="muted small">
          Token für die LinkedIn-Mitarbeitersuche des Contact-Producers. Mitglieder ohne eigenen Apify-Token nutzen ihn
          automatisch über das Gateway.
        </p>
        <div className="api-keys">
          <OrgKeyCard
            kind="apify"
            label="Apify"
            hint={hints["apify"] ?? null}
            admin={admin}
            busy={busy}
            aktion={aktion}
            beschreibung="Wird nur im Contact-Producer verwendet; Watchlist und Personen-Radar nutzen weiterhin den eigenen Token aus Einstellungen → Datenquellen."
          />
        </div>
      </section>
    </>
  );
}

function Verlassen({ st, me, busy, aktion }: { st: OrgState; me: WhoamiLite; busy: boolean; aktion: Aktion }) {
  const owner = st.myRole === "owner";
  const verlassen = () => {
    if (!window.confirm(`${st.name ?? "Die Organisation"} verlassen? Du arbeitest danach wieder in deinem persönlichen Bereich; AVA startet neu.`)) return;
    void aktion(async () => {
      await gatewayFetch(`/v1/tenants/me/members/${encodeURIComponent(me.actorId)}`, { method: "DELETE" });
      const neu = await window.api.org.checkTenant();
      if (!neu) throw new Error("Austritt gespeichert, aber der Abgleich hat keinen Wechsel erkannt. Bitte AVA neu starten.");
    });
  };
  return (
    <section className="provider-section">
      <h3>Organisation verlassen</h3>
      <p className="muted small">
        {owner
          ? "Als letzter Owner kannst du nicht austreten. Ernenne vorher einen Nachfolger."
          : "Du fällst in deinen persönlichen Bereich zurück; AVA startet neu."}
      </p>
      <div className="org-actions">
        <button type="button" className="btn btn--danger" disabled={busy} onClick={verlassen}>
          Organisation verlassen
        </button>
      </div>
    </section>
  );
}
