// O2 (docs/PLAN_ORGANISATIONEN.md) — Seite „Organisation".
//
// Persoenlicher Bereich: Organisation anlegen oder per Einladungslink
// beitreten (Anfrage, wirkt nach Freigabe). Organisation: Mitglieder,
// offene Anfragen (Admin), Einladungslink (Admin), Rollen (Owner),
// Austritt. Vorgaben werden hier nur angezeigt; bearbeiten kommt mit O3.
//
// Nach eigenen Tenant-Wechseln (anlegen, verlassen) stoesst die Seite den
// Abgleich im Hauptprozess an; der zeigt den Hinweis und startet AVA neu.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";
import { ORG_FEATURES, type OrgPolicy, type OrgState } from "../../../shared/types";

interface WhoamiLite {
  tenantId: string;
  actorId: string;
  openJoinRequest?: { tenantId: string; tenantName: string | null; requestedAt: string } | null;
}

const ROLLEN: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Mitglied" };

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

  // Kaltstart per Link: Token wurde im Hauptprozess gepuffert.
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

  const aktion = async (fn: () => Promise<void>, okText?: string) => {
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

  if (whoami.isLoading || org.isLoading) return <section><h2>Organisation</h2><p>Lädt…</p></section>;
  if (org.error || whoami.error) {
    return (
      <section>
        <h2>Organisation</h2>
        <p className="error">Fehler: {fehlerText(org.error ?? whoami.error)}</p>
      </section>
    );
  }
  const st = org.data!;
  const me = whoami.data!;
  const admin = st.kind === "organisation" && (st.myRole === "owner" || st.myRole === "admin");

  return (
    <section>
      <h2>Organisation</h2>
      {meldung && <p className={meldung.art === "fehler" ? "error" : "muted"}>{meldung.text}</p>}

      {joinToken && (
        <div className="card" style={{ margin: "1rem 0", padding: "1rem" }}>
          <h3>Einladung erhalten</h3>
          <p>
            Du hast einen Einladungslink geöffnet. Soll AVA den Beitritt anfragen? Bis ein Admin freigibt, bleibst du in
            deinem jetzigen Bereich.
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="primary" disabled={busy} onClick={() => void beitrittAnfragen(joinToken)}>
              Beitritt anfragen
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setJoinToken(null); setParams({}); }}>
              Verwerfen
            </button>
          </div>
        </div>
      )}

      {st.kind === "personal" ? (
        <Persoenlich me={me} busy={busy} aktion={aktion} beitrittAnfragen={beitrittAnfragen} />
      ) : (
        <OrgAnsicht st={st} me={me} admin={admin} busy={busy} aktion={aktion} />
      )}

      <Vorgaben st={st} admin={admin} busy={busy} aktion={aktion} />
      <Schluessel st={st} admin={admin} busy={busy} aktion={aktion} />
    </section>
  );
}

function Persoenlich({
  me,
  busy,
  aktion,
  beitrittAnfragen,
}: {
  me: WhoamiLite;
  busy: boolean;
  aktion: (fn: () => Promise<void>, okText?: string) => Promise<void>;
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
      <p className="muted">
        Du nutzt AVA in deinem persönlichen Bereich. Firmen, Kontakte und Schlüssel gehören nur dir. Eine Organisation
        teilt Firmenbestand, Vorgaben und auf Wunsch zentrale Schlüssel mit ihren Mitgliedern.
      </p>
      {me.openJoinRequest && (
        <p>
          <strong>Beitritt zu {me.openJoinRequest.tenantName ?? "einer Organisation"} angefragt</strong>{" "}
          <span className="muted small">am {datum(me.openJoinRequest.requestedAt)} · wartet auf Freigabe durch einen Admin</span>
        </p>
      )}
      <h3>Organisation anlegen</h3>
      <p className="muted small">
        Du wirst Owner. Deine bisherigen Firmen und Kontakte bleiben in deinem persönlichen Bereich; AVA startet danach in
        der neuen Organisation neu.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", maxWidth: 520 }}>
        <input
          type="text"
          placeholder="Name der Organisation"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" className="primary" disabled={busy || name.trim().length < 2} onClick={() => void anlegen()}>
          Anlegen
        </button>
      </div>
      <h3 style={{ marginTop: "1.5rem" }}>Einer Organisation beitreten</h3>
      <p className="muted small">Füge den Einladungslink ein, den du von einem Admin bekommen hast (ava://join/…).</p>
      <div style={{ display: "flex", gap: "0.5rem", maxWidth: 520 }}>
        <input
          type="text"
          placeholder="ava://join/…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn" disabled={busy || link.trim().length < 8} onClick={() => void linkEinloesen()}>
          Beitritt anfragen
        </button>
      </div>
    </>
  );
}

function OrgAnsicht({
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
  aktion: (fn: () => Promise<void>, okText?: string) => Promise<void>;
}) {
  const [kopiert, setKopiert] = useState(false);
  const link = st.inviteToken ? `ava://join/${st.inviteToken}` : null;
  const owner = st.myRole === "owner";

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

  const entscheiden = (id: string, entscheidung: "approve" | "reject") =>
    aktion(
      () => gatewayFetch(`/v1/tenants/me/requests/${encodeURIComponent(id)}`, { method: "POST", body: { entscheidung } }),
      entscheidung === "approve" ? "Anfrage angenommen. Die Person wird beim nächsten Abgleich Mitglied." : "Anfrage abgelehnt.",
    );

  const entfernen = (actorId: string, label: string) => {
    if (!window.confirm(`${label} aus ${st.name ?? "der Organisation"} entfernen? Die Person fällt in ihren persönlichen Bereich zurück.`)) return;
    void aktion(() => gatewayFetch(`/v1/tenants/me/members/${encodeURIComponent(actorId)}`, { method: "DELETE" }), `${label} entfernt.`);
  };

  const rolleSetzen = (actorId: string, role: string) =>
    aktion(() => gatewayFetch(`/v1/tenants/me/members/${encodeURIComponent(actorId)}`, { method: "PATCH", body: { role } }));

  const verlassen = () => {
    if (!window.confirm(`${st.name ?? "Die Organisation"} verlassen? Du arbeitest danach wieder in deinem persönlichen Bereich; AVA startet neu.`)) return;
    void aktion(async () => {
      await gatewayFetch(`/v1/tenants/me/members/${encodeURIComponent(me.actorId)}`, { method: "DELETE" });
      const neu = await window.api.org.checkTenant();
      if (!neu) throw new Error("Austritt gespeichert, aber der Abgleich hat keinen Wechsel erkannt. Bitte AVA neu starten.");
    });
  };

  const linkErneuern = () => {
    if (!window.confirm("Neuen Einladungslink erzeugen? Der bisherige Link wird sofort ungültig.")) return;
    void aktion(() => gatewayFetch("/v1/tenants/me/invite", { method: "POST" }), "Neuer Einladungslink erzeugt.");
  };

  return (
    <>
      <dl>
        <dt>Organisation</dt>
        <dd>
          {st.name ?? st.tenantId}{" "}
          <span className="muted small">· deine Rolle: {ROLLEN[st.myRole] ?? st.myRole} · {st.members.length} Mitglied{st.members.length === 1 ? "" : "er"}</span>
        </dd>
        {admin && (
          <>
            <dt>Einladungslink</dt>
            <dd>
              <code>{link}</code>{" "}
              <button type="button" className="btn" disabled={busy} onClick={() => void kopieren()}>
                {kopiert ? "Kopiert" : "Kopieren"}
              </button>{" "}
              <button type="button" className="btn" disabled={busy} onClick={linkErneuern}>
                Erneuern
              </button>
              <div className="muted small">
                Wer den Link in AVA öffnet oder unter Organisation einfügt, stellt eine Beitrittsanfrage. Du gibst sie hier
                frei.
              </div>
            </dd>
          </>
        )}
      </dl>

      {admin && (
        <>
          <h3>Offene Anfragen</h3>
          {st.openRequests.length === 0 ? (
            <p className="muted small">Keine offenen Beitrittsanfragen.</p>
          ) : (
            <dl>
              {st.openRequests.map((r) => (
                <span key={r.id} style={{ display: "contents" }}>
                  <dt>{datum(r.requestedAt)}</dt>
                  <dd>
                    {r.name ?? r.email ?? r.actorId}
                    {r.email && r.name && <span className="muted small"> · {r.email}</span>}{" "}
                    <button type="button" className="primary" disabled={busy} onClick={() => void entscheiden(r.id, "approve")}>
                      Aufnehmen
                    </button>{" "}
                    <button type="button" className="btn" disabled={busy} onClick={() => void entscheiden(r.id, "reject")}>
                      Ablehnen
                    </button>
                  </dd>
                </span>
              ))}
            </dl>
          )}
        </>
      )}

      <h3>Mitglieder</h3>
      <dl>
        {st.members.map((m) => {
          const label = m.name ?? m.email ?? m.actorId.slice(0, 8) + "…";
          const ich = m.actorId === me.actorId;
          return (
            <span key={m.actorId} style={{ display: "contents" }}>
              <dt>{ROLLEN[m.role] ?? m.role}</dt>
              <dd>
                {label}
                {ich && <span className="muted small"> · das bist du</span>}
                {m.email && m.name && <span className="muted small"> · {m.email}</span>}
                <span className="muted small"> · seit {datum(m.joinedAt)}</span>
                {owner && !ich && (
                  <>
                    {" "}
                    <select value={m.role} disabled={busy} onChange={(e) => void rolleSetzen(m.actorId, e.target.value)}>
                      <option value="member">Mitglied</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                  </>
                )}
                {admin && !ich && (
                  <>
                    {" "}
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => entfernen(m.actorId, label)}>
                      Entfernen
                    </button>
                  </>
                )}
              </dd>
            </span>
          );
        })}
      </dl>
      <p className="muted small">
        Name und E-Mail kennt AVA aus der Beitrittsanfrage; wer die Organisation angelegt hat, erscheint mit Nutzer-ID.
      </p>

      <h3>Verlassen</h3>
      <p className="muted small">
        {owner
          ? "Als letzter Owner kannst du nicht austreten. Ernenne vorher einen Nachfolger."
          : "Du fällst in deinen persönlichen Bereich zurück; AVA startet neu."}
      </p>
      <button type="button" className="btn btn--danger" disabled={busy} onClick={verlassen}>
        Organisation verlassen
      </button>
    </>
  );
}

function Vorgaben({
  st,
  admin,
  busy,
  aktion,
}: {
  st: OrgState;
  admin: boolean;
  busy: boolean;
  aktion: (fn: () => Promise<void>, okText?: string) => Promise<void>;
}) {
  const [entwurf, setEntwurf] = useState<OrgPolicy>(st.policy);
  useEffect(() => setEntwurf(st.policy), [st.policy]);
  if (st.kind !== "organisation") return null;
  const p = st.policy;

  const speichern = () =>
    aktion(async () => {
      await gatewayFetch("/v1/tenants/me/policy", {
        method: "PUT",
        body: {
          features: entwurf.features,
          providerLock: entwurf.providerLock,
          chatModel: entwurf.chatModel?.trim() || null,
          producerModel: entwurf.producerModel?.trim() || null,
          promptAudit: entwurf.promptAudit,
        },
      });
      await window.api.org.refreshPolicy();
    }, "Vorgaben gespeichert. Mitglieder übernehmen sie beim nächsten Abgleich (spätestens in 10 Minuten).");

  if (!admin) {
    const aus = ORG_FEATURES.filter((f) => p.features[f.key] === false).map((f) => f.label);
    return (
      <>
        <h3 style={{ marginTop: "1.5rem" }}>Vorgaben</h3>
        <dl>
          <dt>Abgeschaltete Funktionen</dt>
          <dd>{aus.length === 0 ? "keine" : aus.join(", ")}</dd>
          <dt>Anbieter-Sperre</dt>
          <dd>{p.providerLock ? "Anbieter und Schlüssel dürfen nicht lokal überschrieben werden" : "lokales Überschreiben erlaubt"}</dd>
          <dt>Modelle</dt>
          <dd>Chat: {p.chatModel ?? "frei"} · Hintergrund: {p.producerModel ?? "frei"}</dd>
          <dt>Prompt-Audit</dt>
          <dd>{p.promptAudit ? "aktiv" : "aus"}</dd>
        </dl>
      </>
    );
  }

  return (
    <>
      <h3 style={{ marginTop: "1.5rem" }}>Vorgaben</h3>
      <p className="muted small">
        Abgeschaltete Funktionen verschwinden bei allen Mitgliedern aus Navigation, Einstellungen und Chat; Hintergrunddienste
        stoppen. Kontakt-Recherche wird zusätzlich im Gateway abgewiesen.
      </p>
      <h4>Funktionen</h4>
      <div style={{ display: "grid", gap: "0.35rem", maxWidth: 640 }}>
        {ORG_FEATURES.map((f) => (
          <label key={f.key} style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
            <input
              type="checkbox"
              checked={entwurf.features[f.key] !== false}
              disabled={busy}
              onChange={(e) =>
                setEntwurf({ ...entwurf, features: { ...entwurf.features, [f.key]: e.target.checked } })
              }
            />
            <span>
              {f.label} <span className="muted small">· {f.hinweis}</span>
            </span>
          </label>
        ))}
      </div>
      <h4 style={{ marginTop: "1rem" }}>KI und Schlüssel</h4>
      <p className="muted small">Anbieter-Sperre und Modellvorgaben werden mit den nächsten Stufen (O5/O6) in der App durchgesetzt; hier bereits einstellbar.</p>
      <div style={{ display: "grid", gap: "0.5rem", maxWidth: 640 }}>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
          <input
            type="checkbox"
            checked={entwurf.providerLock}
            disabled={busy}
            onChange={(e) => setEntwurf({ ...entwurf, providerLock: e.target.checked })}
          />
          <span>Mitglieder dürfen Anbieter, Schlüssel und Modell <strong>nicht</strong> lokal überschreiben</span>
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ minWidth: 160 }}>Chat-Modell</span>
          <input type="text" placeholder="frei" value={entwurf.chatModel ?? ""} disabled={busy} style={{ flex: 1 }}
            onChange={(e) => setEntwurf({ ...entwurf, chatModel: e.target.value || null })} />
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ minWidth: 160 }}>Hintergrund-Modell</span>
          <input type="text" placeholder="frei" value={entwurf.producerModel ?? ""} disabled={busy} style={{ flex: 1 }}
            onChange={(e) => setEntwurf({ ...entwurf, producerModel: e.target.value || null })} />
        </label>
        <label style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
          <input
            type="checkbox"
            checked={entwurf.promptAudit}
            disabled={busy}
            onChange={(e) => setEntwurf({ ...entwurf, promptAudit: e.target.checked })}
          />
          <span>Prompt-Audit: Prompts über den Organisationsschlüssel werden gespeichert (Opt-in, wirkt ab O4)</span>
        </label>
      </div>
      <div style={{ marginTop: "0.75rem" }}>
        <button type="button" className="primary" disabled={busy} onClick={() => void speichern()}>
          Vorgaben speichern
        </button>
      </div>
    </>
  );
}

// O5 — Organisationsschluessel: Admin hinterlegt je Anbieter einen Schluessel,
// der im Gateway verschluesselt bleibt (Klartext geht rein, nie wieder raus).
const ANBIETER: Array<{ kind: string; label: string }> = [
  { kind: "openai", label: "OpenAI" },
  { kind: "anthropic", label: "Anthropic" },
  { kind: "google", label: "Google" },
  { kind: "mistral", label: "Mistral" },
  { kind: "deepseek", label: "DeepSeek" },
  { kind: "xai", label: "xAI" },
  { kind: "qwen", label: "Qwen" },
  { kind: "apify", label: "Apify" },
];

function Schluessel({
  st,
  admin,
  busy,
  aktion,
}: {
  st: OrgState;
  admin: boolean;
  busy: boolean;
  aktion: (fn: () => Promise<void>, okText?: string) => Promise<void>;
}) {
  const [entwurf, setEntwurf] = useState<Record<string, string>>({});
  if (st.kind !== "organisation") return null;
  const hints: Record<string, string> = {};
  for (const p of st.providers ?? []) hints[p.kind] = p.keyHint;

  const setzen = (kind: string) =>
    aktion(async () => {
      const apiKey = (entwurf[kind] ?? "").trim();
      if (apiKey.length < 8) throw new Error("Schlüssel zu kurz.");
      await gatewayFetch(`/v1/tenants/me/providers/${kind}`, { method: "PUT", body: { apiKey } });
      setEntwurf({ ...entwurf, [kind]: "" });
      await window.api.org.refreshPolicy();
    }, "Organisationsschlüssel gespeichert. Mitglieder ohne eigenen Schlüssel nutzen ihn beim nächsten Abgleich.");

  const entfernen = (kind: string) => {
    if (!window.confirm(`Organisationsschlüssel für ${kind} entfernen? Mitglieder, die ihn nutzen, verlieren den Zugriff.`)) return;
    void aktion(async () => {
      await gatewayFetch(`/v1/tenants/me/providers/${kind}`, { method: "DELETE" });
      await window.api.org.refreshPolicy();
    }, "Organisationsschlüssel entfernt.");
  };

  return (
    <>
      <h3 style={{ marginTop: "1.5rem" }}>Organisationsschlüssel</h3>
      <p className="muted small">
        Die Schlüssel bleiben verschlüsselt im AVA-Gateway; Mitglieder rufen die Anbieter darüber auf, ohne den
        Schlüssel je zu sehen. Verbrauch wird der Organisation zugerechnet. Mit eigenem Schlüssel läuft alles
        lokal wie bisher.
      </p>
      <dl>
        {ANBIETER.map((a) => (
          <span key={a.kind} style={{ display: "contents" }}>
            <dt>{a.label}</dt>
            <dd>
              {hints[a.kind] ? (
                <span className="pill">hinterlegt · …{hints[a.kind]}</span>
              ) : (
                <span className="muted small">kein Schlüssel</span>
              )}
              {admin && (
                <span style={{ display: "inline-flex", gap: "0.4rem", marginLeft: "0.6rem", alignItems: "center" }}>
                  <input
                    type="password"
                    placeholder={hints[a.kind] ? "neuen Schlüssel einfügen" : "Schlüssel"}
                    value={entwurf[a.kind] ?? ""}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(e) => setEntwurf({ ...entwurf, [a.kind]: e.target.value })}
                    style={{ width: 260 }}
                  />
                  <button type="button" className="btn" disabled={busy || (entwurf[a.kind] ?? "").trim().length < 8} onClick={() => void setzen(a.kind)}>
                    Speichern
                  </button>
                  {hints[a.kind] && (
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={() => entfernen(a.kind)}>
                      Entfernen
                    </button>
                  )}
                </span>
              )}
            </dd>
          </span>
        ))}
      </dl>
    </>
  );
}
