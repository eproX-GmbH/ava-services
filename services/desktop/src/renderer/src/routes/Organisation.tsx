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
import { DEEP_RESEARCH_MODELS } from "../../../shared/research-models";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Building2 } from "lucide-react";
import { gatewayFetch } from "../api/gateway";
import { PROVIDER_LABEL, modelOptionLabel } from "./Settings";
import {
  ORG_FEATURES,
  type LlmProviderKind,
  type OrgBillingInvoice,
  type OrgBillingState,
  type OrgPolicy,
  type OrgQuota,
  type OrgState,
  type OrgUsageRow,
  type ProviderCatalogEntry,
  type SeatTier,
} from "../../../shared/types";
import { USAGE_QUERY_KEY } from "../api/usage";

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
          {admin && <Abrechnung st={st} busy={busy} aktion={aktion} />}
          <Vorgaben st={st} admin={admin} busy={busy} aktion={aktion} />
          <Schluessel st={st} admin={admin} busy={busy} aktion={aktion} />
          <Limits st={st} admin={admin} busy={busy} aktion={aktion} />
          <Verbrauch st={st} me={me} />
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
  // B2 — Kostenhinweis, wenn die Organisation Seats bezahlt (Owner-Sicht auf die Wirkung einer Aufnahme).
  const billing = useQuery({ queryKey: ["org", "billing"], queryFn: () => gatewayFetch<OrgBillingState>("/v1/tenants/me/billing") });
  const seat = billing.data?.mode === "seats" && billing.data.seatTier ? { tier: billing.data.seatTier, cents: billing.data.prices[billing.data.seatTier] } : null;
  const entscheiden = (id: string, entscheidung: "approve" | "reject") =>
    aktion(
      () => gatewayFetch(`/v1/tenants/me/requests/${encodeURIComponent(id)}`, { method: "POST", body: { entscheidung } }),
      entscheidung === "approve"
        ? `Anfrage angenommen. Die Person wird beim nächsten Abgleich Mitglied.${seat ? ` Sie zählt ab dem nächsten Stichtag als ${TIER_LABEL[seat.tier]}-Seat (${eur(seat.cents)}/Monat).` : ""}`
        : "Anfrage abgelehnt.",
    );
  return (
    <section className="provider-section">
      <h3>Offene Anfragen</h3>
      {seat && st.openRequests.length > 0 && (
        <p className="muted small">
          Jede Aufnahme kostet einen weiteren {TIER_LABEL[seat.tier]}-Seat ({eur(seat.cents)} pro Monat, voller Monat ab dem ersten
          Stichtag).
        </p>
      )}
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
        Name und E-Mail übernimmt AVA aus der Anmeldung; bis zum nächsten Abgleich eines Mitglieds kann noch die Nutzer-ID erscheinen.
      </p>
    </section>
  );
}

// ---- B2 — Abrechnung (docs/PLAN_ABRECHNUNG_SEATS.md) --------------------------

const TIER_LABEL: Record<SeatTier, string> = { starter: "Starter", pro: "Pro" };
const INVOICE_STATUS: Record<string, string> = {
  recorded: "erfasst",
  issued: "gestellt",
  paid: "bezahlt",
  void: "storniert",
  enterprise_export: "Enterprise (Export)",
};

function eur(cents: number | null | undefined): string {
  return cents == null ? "—" : `${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function monatLabel(periodKey: string): string {
  const [y, m] = periodKey.split("-");
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleDateString("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });
}

function invoiceCsv(inv: OrgBillingInvoice, orgName: string | null): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const e = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const rows: string[] = [];
  rows.push(["Organisation", "Periode", "Status", "Seats", "Netto EUR", "Hash"].map(esc).join(";"));
  rows.push([orgName ?? inv.id, inv.periodKey, inv.status, inv.seatCount, e(inv.subtotalCents), inv.computeHash].map(esc).join(";"));
  rows.push("");
  rows.push(["Position", "Tier", "Seats", "Einzelpreis EUR", "Betrag EUR"].map(esc).join(";"));
  inv.lines.forEach((l, i) => rows.push([i + 1, l.tier, l.seats, e(l.unitPriceCents), e(l.amountCents)].map(esc).join(";")));
  rows.push("");
  rows.push(["Nutzer-ID", "Name", "E-Mail", "Tier", "Erster Stichtag", "Letzter Stichtag", "Stichtage"].map(esc).join(";"));
  for (const s of inv.seats ?? []) rows.push([s.actorId, s.name, s.email, s.tier, s.firstCountedDay, s.lastCountedDay, s.countedDays].map(esc).join(";"));
  return rows.join("\r\n");
}

function Abrechnung({ st, busy, aktion }: { st: OrgState; busy: boolean; aktion: Aktion }) {
  const qc = useQueryClient();
  const owner = st.myRole === "owner";
  const billing = useQuery({ queryKey: ["org", "billing"], queryFn: () => gatewayFetch<OrgBillingState>("/v1/tenants/me/billing") });
  const [tierWahl, setTierWahl] = useState<SeatTier>("starter");
  const [deckel, setDeckel] = useState<string>("");
  const [detail, setDetail] = useState<OrgBillingInvoice | null>(null);
  const b = billing.data;
  useEffect(() => {
    if (b) {
      setDeckel(b.maxSeats != null ? String(b.maxSeats) : "");
      if (b.seatTier) setTierWahl(b.seatTier);
    }
  }, [b?.maxSeats, b?.seatTier]); // eslint-disable-line react-hooks/exhaustive-deps

  const nachher = () => {
    void qc.invalidateQueries({ queryKey: ["org"] });
    void qc.invalidateQueries({ queryKey: USAGE_QUERY_KEY });
  };
  const call = (fn: () => Promise<unknown>, ok?: string) =>
    aktion(async () => {
      await fn();
      nachher();
    }, ok);

  const aktivieren = () => {
    if (!b) return;
    const preis = b.prices[tierWahl];
    const summe = b.memberCount * preis;
    const text =
      `Sammelabrechnung aktivieren?\n\n` +
      `${b.memberCount} Mitglied${b.memberCount === 1 ? "" : "er"} × ${eur(preis)} (${TIER_LABEL[tierWahl]}) = ${eur(summe)} pro Monat, ` +
      `bereits für den laufenden Monat (voller Monatspreis, keine anteilige Berechnung).\n\n` +
      `Persönliche Abos der Mitglieder werden zum Ende ihrer Laufzeit gekündigt (im Kunden-Portal widerrufbar). ` +
      `Alle Mitglieder erhalten sofort ${TIER_LABEL[tierWahl]}-Berechtigungen.`;
    if (!window.confirm(text)) return;
    void call(
      () => gatewayFetch("/v1/tenants/me/billing/seats/activate", { method: "POST", body: { tier: tierWahl } }),
      `Sammelabrechnung aktiv: ${TIER_LABEL[tierWahl]} für alle Mitglieder.`,
    );
  };
  const beenden = () => {
    if (!window.confirm("Sammelabrechnung zum nächsten Monatsersten beenden? Der laufende Monat wird noch voll abgerechnet; danach gilt für jedes Mitglied wieder sein eigenes Abo (oder Free).")) return;
    void call(() => gatewayFetch("/v1/tenants/me/billing/seats/deactivate", { method: "POST", body: {} }), "Beendigung zum Monatsersten vorgemerkt.");
  };
  const beendenZurueck = () =>
    call(() => gatewayFetch("/v1/tenants/me/billing/seats/deactivate", { method: "POST", body: { revoke: true } }), "Beendigung zurückgenommen.");
  const tierSetzen = (tier: SeatTier) => {
    if (!b?.seatTier || tier === b.seatTier) return;
    const upgrade = tier === "pro";
    const text = upgrade
      ? `Auf Pro wechseln? Gilt sofort für alle Mitglieder; der laufende Monat wird als Pro berechnet (${eur(b.prices.pro)} je Seat).`
      : `Auf Starter wechseln? Gilt ab dem nächsten Monatsersten; bis dahin bleibt Pro (${eur(b.prices.starter)} je Seat ab dann).`;
    if (!window.confirm(text)) return;
    void call(() => gatewayFetch("/v1/tenants/me/billing/seats/tier", { method: "PUT", body: { tier } }), upgrade ? "Upgrade auf Pro aktiv." : "Downgrade zum Monatsersten vorgemerkt.");
  };
  const deckelSpeichern = () => {
    const n = deckel.trim() === "" ? null : Number(deckel);
    if (n !== null && (!Number.isInteger(n) || n < 1)) return;
    void call(() => gatewayFetch("/v1/tenants/me/billing/seats", { method: "PATCH", body: { maxSeats: n } }), n === null ? "Seat-Deckel entfernt." : `Seat-Deckel: ${n}.`);
  };
  const oeffneDetail = async (periodKey: string) => {
    try {
      setDetail(await gatewayFetch<OrgBillingInvoice>(`/v1/tenants/me/billing/invoices/${periodKey}`));
    } catch (err) {
      window.alert(fehlerText(err));
    }
  };
  const csvLaden = (inv: OrgBillingInvoice) => {
    const blob = new Blob(["\ufeff" + invoiceCsv(inv, st.name)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ava-seats-${inv.periodKey}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (billing.isLoading) {
    return (
      <section className="provider-section">
        <h3>Abrechnung</h3>
        <p className="muted small">Lädt…</p>
      </section>
    );
  }
  if (billing.error || !b) {
    return (
      <section className="provider-section">
        <h3>Abrechnung</h3>
        <p className="error">{billing.error ? fehlerText(billing.error) : "Keine Abrechnungsdaten."}</p>
      </section>
    );
  }

  const aktiv = b.mode === "seats" && b.seatTier;
  const cur = b.currentPeriod;

  return (
    <>
      <section className="provider-section">
        <h3>Abrechnung</h3>
        {b.mode === "enterprise" ? (
          <p className="muted small">Enterprise-Vertrag: die Abrechnung pflegt der Betreiber. Seats werden zur Information gezählt.</p>
        ) : !aktiv ? (
          <>
            <p className="muted small">
              Ohne Sammelabrechnung zahlt jedes Mitglied sein eigenes Abo (Einstellungen → Plan) und hat sein eigenes Kontingent.
              Mit Sammelabrechnung bekommt die Organisation eine Monatsrechnung über alle Seats; alle Mitglieder erhalten
              dasselbe Tier und teilen sich das Kontingent.
            </p>
            <div className="active-config-card">
              <div className="active-config-card__row">
                <span className="active-config-card__label">Regel</span>
                <span className="active-config-card__value">
                  Ein Seat zählt für den Monat, wenn die Person an mindestens einem Tagesstichtag (00:00 UTC) Mitglied war. Keine
                  anteilige Berechnung, keine Erstattung. Upgrade sofort, Downgrade zum Monatsersten.
                </span>
              </div>
              <div className="active-config-card__row">
                <span className="active-config-card__label">Preise</span>
                <span className="active-config-card__value">
                  Starter {eur(b.prices.starter)} · Pro {eur(b.prices.pro)} je Seat und Monat, netto
                </span>
              </div>
            </div>
            {owner ? (
              <>
                <div className="provider-grid">
                  <label className="field">
                    <span>Tier für alle Mitglieder</span>
                    <select value={tierWahl} disabled={busy} onChange={(e) => setTierWahl(e.target.value as SeatTier)}>
                      <option value="starter">Starter · 500 Firmen je Seat und Monat</option>
                      <option value="pro">Pro · 2 000 Firmen je Seat und Monat</option>
                    </select>
                  </label>
                </div>
                <div className="org-actions">
                  <button type="button" className="primary" disabled={busy} onClick={aktivieren}>
                    Sammelabrechnung aktivieren
                  </button>
                  <span className="muted small">
                    {b.memberCount} Mitglied{b.memberCount === 1 ? "" : "er"} · {eur(b.memberCount * b.prices[tierWahl])} pro Monat
                  </span>
                </div>
              </>
            ) : (
              <p className="muted small">Nur der Owner kann die Sammelabrechnung aktivieren.</p>
            )}
          </>
        ) : (
          <>
            <div className="active-config-card">
              <div className="active-config-card__row">
                <span className="active-config-card__label">Status</span>
                <span className="active-config-card__value">
                  <span className={`badge ${b.status === "active" ? "ok" : ""}`}>
                    {b.status === "active" ? "aktiv" : b.status === "past_due" ? "Zahlung offen" : b.status === "suspended" ? "pausiert" : b.status}
                  </span>{" "}
                  {TIER_LABEL[b.seatTier!]} für alle Mitglieder{b.since ? ` · seit ${datum(b.since)}` : ""}
                  {b.tierNext && b.tierNextFrom ? ` · ab ${datum(b.tierNextFrom)} ${TIER_LABEL[b.tierNext]}` : ""}
                  {b.endsAt ? ` · endet am ${datum(b.endsAt)}` : ""}
                </span>
              </div>
              <div className="active-config-card__row">
                <span className="active-config-card__label">Laufender Monat</span>
                <span className="active-config-card__value">
                  {cur.seatCount} Seat{cur.seatCount === 1 ? "" : "s"} bisher gezählt ({monatLabel(cur.periodKey)}) · voraussichtlich{" "}
                  {eur(b.projectedCents)} netto
                </span>
              </div>
              <div className="active-config-card__row">
                <span className="active-config-card__label">Mitglieder jetzt</span>
                <span className="active-config-card__value">
                  {b.memberCount}
                  {b.maxSeats != null ? ` von maximal ${b.maxSeats}` : ""} · {eur(b.prices[b.seatTier!])} je Seat und Monat
                </span>
              </div>
            </div>
            {b.status === "suspended" && (
              <p className="error">Wegen einer offenen Zahlung sind Importe und Radar-Scans pausiert. Nach Zahlungseingang läuft alles automatisch weiter.</p>
            )}
            {owner && (
              <>
                <div className="provider-grid">
                  <label className="field">
                    <span>Tier</span>
                    <select value={b.seatTier!} disabled={busy || !!b.endsAt} onChange={(e) => tierSetzen(e.target.value as SeatTier)}>
                      <option value="starter">Starter</option>
                      <option value="pro">Pro</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Seat-Deckel (leer = keiner)</span>
                    <input type="number" min={1} step={1} value={deckel} disabled={busy} onChange={(e) => setDeckel(e.target.value)} onBlur={deckelSpeichern} />
                  </label>
                </div>
                <div className="org-actions">
                  {b.endsAt ? (
                    <button type="button" className="btn" disabled={busy} onClick={() => void beendenZurueck()}>
                      Beendigung zurücknehmen
                    </button>
                  ) : (
                    <button type="button" className="btn btn--danger" disabled={busy} onClick={beenden}>
                      Zum Monatsersten beenden
                    </button>
                  )}
                </div>
              </>
            )}
            <p className="muted small">
              Ein Seat zählt für den Monat, sobald die Person an einem Tagesstichtag (00:00 UTC) Mitglied war; Entfernte zählen den
              laufenden Monat noch, Beitritte ab dem nächsten Stichtag. Upgrade sofort, Downgrade zum Monatsersten.
            </p>
          </>
        )}
      </section>

      {(b.invoices.length > 0 || aktiv) && (
        <section className="provider-section">
          <h3>Abrechnungsdatensätze</h3>
          {b.invoices.length === 0 ? (
            <p className="muted small">Der erste Datensatz entsteht am Monatsersten.</p>
          ) : (
            <div className="org-list">
              {b.invoices.map((inv) => (
                <div key={inv.id} className="org-row">
                  <div className="org-row__main">
                    <span className="org-row__title">{monatLabel(inv.periodKey)}</span>
                    <span className="org-row__meta">
                      {inv.seatCount} Seat{inv.seatCount === 1 ? "" : "s"} ·{" "}
                      {inv.lines.map((l) => `${l.seats} × ${TIER_LABEL[l.tier]}`).join(", ") || "keine Positionen"} ·{" "}
                      {INVOICE_STATUS[inv.status] ?? inv.status}
                    </span>
                  </div>
                  <div className="org-row__actions">
                    <strong>{eur(inv.subtotalCents)}</strong>
                    <button type="button" className="btn" onClick={() => void oeffneDetail(inv.periodKey)}>
                      Nachweis
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {detail && (
            <div className="ct-card" style={{ marginTop: "0.75rem", padding: "0.75rem 1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <strong>
                  {monatLabel(detail.periodKey)} · {detail.seatCount} Seat{detail.seatCount === 1 ? "" : "s"} · {eur(detail.subtotalCents)} netto
                </strong>
                <span className="org-actions">
                  <button type="button" className="btn" onClick={() => csvLaden(detail)}>
                    CSV herunterladen
                  </button>
                  <button type="button" className="btn" onClick={() => setDetail(null)}>
                    Schließen
                  </button>
                </span>
              </div>
              <div className="org-list" style={{ marginTop: "0.5rem" }}>
                {(detail.seats ?? []).map((s) => (
                  <div key={s.actorId} className="org-row">
                    <div className="org-row__main">
                      <span className="org-row__title">{s.name ?? s.email ?? `${s.actorId.slice(0, 8)}…`}</span>
                      <span className="org-row__meta">
                        {TIER_LABEL[s.tier]} · Stichtage {s.firstCountedDay} bis {s.lastCountedDay} ({s.countedDays})
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="muted small" style={{ marginTop: "0.5rem" }}>
                Prüfsumme {detail.computeHash.slice(0, 16)}… · erfasst am {datum(detail.computedAt)}
              </p>
            </div>
          )}
        </section>
      )}
    </>
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
          researchModel: entwurf.researchModel || null,
          promptAudit: entwurf.promptAudit,
          personRetentionDays: entwurf.personRetentionDays ?? null,
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
              Chat: {p.chatModel ?? "frei"} · Hintergrund: {p.producerModel ?? "frei"} · Deep Research:{" "}
              {DEEP_RESEARCH_MODELS.find((m) => m.id === p.researchModel)?.label ?? p.researchModel ?? "Standard"}
            </span>
          </div>
          <div className="active-config-card__row">
            <span className="active-config-card__label">Prompt-Audit</span>
            <span className="active-config-card__value">{p.promptAudit ? "aktiv" : "aus"}</span>
          </div>
          <div className="active-config-card__row">
            <span className="active-config-card__label">Aufbewahrung Personen</span>
            <span className="active-config-card__value">{p.personRetentionDays ?? 180} Tage ohne Beobachtung</span>
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
          {/* 2026-09-06 — Deep Research ist OpenAI-exklusiv (Responses-API mit
              web_search); nur die dafuer faehigen Modelle sind waehlbar. */}
          <label className="field">
            <span>Modell für Deep Research (OpenAI)</span>
            <select
              value={entwurf.researchModel ?? ""}
              disabled={busy}
              onChange={(e) => setEntwurf({ ...entwurf, researchModel: e.target.value || null })}
            >
              <option value="">Standard ({DEEP_RESEARCH_MODELS[0]!.label})</option>
              {DEEP_RESEARCH_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.hinweis}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!st.providers?.some((x) => x.kind === "openai") && (
          <p className="muted small">
            Deep Research läuft ausschließlich über OpenAI. Damit Mitglieder es über die Organisation nutzen können, hinterlege
            unten einen OpenAI-Organisationsschlüssel.
          </p>
        )}
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
        <h4 style={{ marginTop: "1rem" }}>Aufbewahrung von Personendaten</h4>
        <div className="provider-grid">
          <label className="field">
            <span>Personen tilgen nach Tagen ohne Beobachtung (Standard 180)</span>
            <input
              type="number"
              min={30}
              max={3650}
              placeholder="180"
              value={entwurf.personRetentionDays ?? ""}
              disabled={busy}
              onChange={(e) => setEntwurf({ ...entwurf, personRetentionDays: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
          <p className="muted small" style={{ alignSelf: "end" }}>
            Eine Person, die so lange von keinem Lauf mehr auf einer Quelle gesehen wurde, wird im gemeinsamen Bestand
            gelöscht. Beschäftigungen verfallen unabhängig davon nach 120 Tagen. Bei mehreren Organisationen gilt der
            kleinste Wert.
          </p>
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

// ---- O6 — Limits und Verbrauch ----------------------------------------------

function usd(cents: number | null | undefined): string {
  return cents == null ? "—" : `${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}

function Limits({ st, admin, busy, aktion }: { st: OrgState; admin: boolean; busy: boolean; aktion: Aktion }) {
  const quelle: OrgQuota = st.quota ?? { mode: "off", orgMonthlyCents: null, userDailyCents: null, hardStop: true };
  const [entwurf, setEntwurf] = useState<OrgQuota>(quelle);
  useEffect(() => setEntwurf(quelle), [st.quota]); // eslint-disable-line react-hooks/exhaustive-deps
  const geaendert = JSON.stringify(entwurf) !== JSON.stringify(quelle);

  const speichern = () =>
    aktion(async () => {
      await gatewayFetch("/v1/tenants/me/quota", { method: "PUT", body: entwurf });
    }, "Limit gespeichert. Gilt sofort für alle Aufrufe über Organisationsschlüssel.");

  const beschreibung =
    quelle.mode === "off"
      ? "Kein Limit gesetzt."
      : quelle.mode === "org_total"
        ? `Monatsbudget der Organisation: ${usd(quelle.orgMonthlyCents)} · ${quelle.hardStop ? "harter Stopp" : "nur Hinweis"}`
        : `Tagesbudget je Mitglied: ${usd(quelle.userDailyCents)} · ${quelle.hardStop ? "harter Stopp" : "nur Hinweis"}`;

  return (
    <section className="provider-section">
      <h3>Limits</h3>
      <p className="muted small">
        Gilt nur für Aufrufe über Organisationsschlüssel; eigene Schlüssel sind nicht messbar und bleiben unlimitiert.
        Beträge in US-Dollar, geschätzt aus der Preistabelle des Modellkatalogs.
      </p>
      {!admin ? (
        <div className="active-config-card">
          <div className="active-config-card__row">
            <span className="active-config-card__label">Limit</span>
            <span className="active-config-card__value">{beschreibung}</span>
          </div>
        </div>
      ) : (
        <>
          <div className="provider-grid">
            <label className="field">
              <span>Art</span>
              <select value={entwurf.mode} disabled={busy} onChange={(e) => setEntwurf({ ...entwurf, mode: e.target.value as OrgQuota["mode"] })}>
                <option value="off">kein Limit</option>
                <option value="org_total">Gesamtbudget der Organisation je Monat</option>
                <option value="per_user_daily">Tagesbudget je Mitglied</option>
              </select>
            </label>
            {entwurf.mode === "org_total" && (
              <label className="field">
                <span>Monatsbudget (USD)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={entwurf.orgMonthlyCents != null ? Math.round(entwurf.orgMonthlyCents / 100) : ""}
                  disabled={busy}
                  onChange={(e) => setEntwurf({ ...entwurf, orgMonthlyCents: e.target.value ? Math.round(Number(e.target.value) * 100) : null })}
                />
              </label>
            )}
            {entwurf.mode === "per_user_daily" && (
              <label className="field">
                <span>Tagesbudget je Mitglied (USD)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={entwurf.userDailyCents != null ? Math.round(entwurf.userDailyCents / 100) : ""}
                  disabled={busy}
                  onChange={(e) => setEntwurf({ ...entwurf, userDailyCents: e.target.value ? Math.round(Number(e.target.value) * 100) : null })}
                />
              </label>
            )}
          </div>
          {entwurf.mode !== "off" && (
            <div className="org-checks">
              <label className="org-check">
                <input type="checkbox" checked={entwurf.hardStop} disabled={busy} onChange={(e) => setEntwurf({ ...entwurf, hardStop: e.target.checked })} />
                <span>
                  Harter Stopp
                  <span className="org-check__hint">
                    Bei Überschreitung werden Aufrufe abgelehnt (Banner beim Mitglied). Ohne Haken laufen sie weiter, das
                    Gateway markiert die Überschreitung nur.
                  </span>
                </span>
              </label>
            </div>
          )}
          <div className="org-actions">
            <button type="button" className="primary" disabled={busy || !geaendert} onClick={() => void speichern()}>
              Limit speichern
            </button>
            {geaendert && <span className="muted small">ungespeicherte Änderungen</span>}
          </div>
        </>
      )}
    </section>
  );
}

function Verbrauch({ st, me }: { st: OrgState; me: WhoamiLite }) {
  const [tage, setTage] = useState(30);
  const usage = useQuery({
    queryKey: ["org", "usage", tage],
    queryFn: () => gatewayFetch<{ rows: OrgUsageRow[]; monthCents: number; todayCents: number; adminView: boolean }>(`/v1/tenants/me/usage?days=${tage}`),
  });
  const namen = new Map<string, string>();
  for (const m of st.members) namen.set(m.actorId, m.name ?? m.email ?? `${m.actorId.slice(0, 8)}…`);
  const rows = usage.data?.rows ?? [];
  const jeMitglied = new Map<string, { calls: number; input: number; output: number; cents: number }>();
  for (const r of rows) {
    const a = jeMitglied.get(r.actorId) ?? { calls: 0, input: 0, output: 0, cents: 0 };
    a.calls += r.calls;
    a.input += r.inputTokens;
    a.output += r.outputTokens;
    a.cents += r.costCents;
    jeMitglied.set(r.actorId, a);
  }
  return (
    <section className="provider-section">
      <h3>Verbrauch über Organisationsschlüssel</h3>
      <div className="active-config-card">
        <div className="active-config-card__row">
          <span className="active-config-card__label">Dieser Monat</span>
          <span className="active-config-card__value">
            {usd(usage.data?.monthCents ?? 0)}
            {usage.data?.adminView ? " (Organisation)" : " (du)"}
          </span>
        </div>
        <div className="active-config-card__row">
          <span className="active-config-card__label">Heute (du)</span>
          <span className="active-config-card__value">{usd(usage.data?.todayCents ?? 0)}</span>
        </div>
      </div>
      <div className="org-actions">
        <label className="field" style={{ minWidth: 160 }}>
          <span>Zeitraum</span>
          <select value={tage} onChange={(e) => setTage(Number(e.target.value))}>
            <option value={7}>7 Tage</option>
            <option value={30}>30 Tage</option>
            <option value={90}>90 Tage</option>
          </select>
        </label>
      </div>
      {usage.isLoading && <p className="muted small">Lädt…</p>}
      {usage.error && <p className="error">{fehlerText(usage.error)}</p>}
      {!usage.isLoading && rows.length === 0 && <p className="muted small">Noch keine Aufrufe über Organisationsschlüssel im Zeitraum.</p>}
      {jeMitglied.size > 0 && (
        <div className="org-list">
          {Array.from(jeMitglied.entries())
            .sort((a, b) => b[1].cents - a[1].cents)
            .map(([actorId, a]) => (
              <div key={actorId} className="org-row">
                <div className="org-row__main">
                  <span className="org-row__title">
                    {namen.get(actorId) ?? `${actorId.slice(0, 8)}…`}
                    {actorId === me.actorId && <span className="muted"> · du</span>}
                  </span>
                  <span className="org-row__meta">
                    {a.calls.toLocaleString("de-DE")} Aufrufe · {a.input.toLocaleString("de-DE")} Eingabe- / {a.output.toLocaleString("de-DE")} Ausgabe-Tokens
                  </span>
                </div>
                <div className="org-row__actions">
                  <strong>{usd(a.cents)}</strong>
                </div>
              </div>
            ))}
        </div>
      )}
      {rows.length > 0 && (
        <details className="settings-collapse" style={{ marginTop: "0.75rem" }}>
          <summary>Je Tag</summary>
          <div className="org-list">
            {rows.map((r) => (
              <div key={`${r.day}-${r.actorId}`} className="org-row">
                <div className="org-row__main">
                  <span className="org-row__title">
                    {r.day} · {namen.get(r.actorId) ?? `${r.actorId.slice(0, 8)}…`}
                  </span>
                  <span className="org-row__meta">
                    {r.calls} Aufrufe · {r.inputTokens.toLocaleString("de-DE")} / {r.outputTokens.toLocaleString("de-DE")} Tokens
                  </span>
                </div>
                <div className="org-row__actions">{usd(r.costCents)}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
