// docs/PLAN_PRICING_TIERS.md P6 — Plan & Abrechnung im Sitz-Modell (Vorbild Claude/ChatGPT):
// Kopfkarte „Dein Plan“ mit Kontingentbalken, Plan-Auswahl mit Upgrade sofort und
// Downgrade zum Zyklusende, Ultra-Zusatz „Über das Kontingent hinaus“, LinkedIn-
// Beobachtung nach Verbrauch. Erscheint nur, wenn das Gateway `kontingent` liefert
// (Schalter PRICING_TIERS); sonst bleibt die bisherige PlanSection.
//
// Sitze verwaltet die Organisation in der Konsole; hier wechselt ein Owner/Admin
// seinen eigenen Plan, ein Mitglied kann einen Wechsel anfragen.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch, GatewayError } from "../../api/gateway";
import { useUsage, USAGE_QUERY_KEY, type UsageSnapshot } from "../../api/usage";
import { bestaetigen } from "../../components/Bestaetigung";
import { ExternalLink } from "../../components/ExternalLink";
import { KONSOLE_URL } from "../../../../shared/config";

type PlanId = "free" | "pro" | "max" | "ultra" | "enterprise";
type SitzPlan = "pro" | "max" | "ultra";

interface PlanEintrag {
  plan: PlanId;
  name: string;
  rang: number;
  preisCents: number | null;
  kontingentCents: number | null;
  firmenLebenslang: number | null;
  payg: boolean;
  linkedinBeobachtung: boolean;
  merkmale: string[];
  beispielFirmen: { klein: number; gross: number } | null;
}
interface Plaene { plaene: PlanEintrag[]; stufen: { klein: number; mittel: number; gross: number }; freePlaetzeJeOrganisation: number }

interface Sitze {
  ich: string;
  zyklusende: string | null;
  stripe: boolean;
  jePlan: Record<SitzPlan, { gekauft: number; belegt: number; frei: number; reduktionGeplant: number }>;
  freeBelegt: number;
  freePlaetze: number;
  kannVerwalten: boolean;
  enterprise: { maxMitglieder: number | null; firmenLimit: number | null; linkedinLimitCents: number | null } | null;
  mitglieder: Array<{ actorId: string; role: string; name: string | null; email: string | null; plan: PlanId; wechsel: { zu: PlanId; am: string } | null }>;
}

interface LinkedinStand {
  limitCents: number | null;
  verbrauchtCents: number;
  geschaetztCents: number;
  jeFunktion: Record<string, number>;
  laeufe: number;
  enterprise: boolean;
  imVertrag: boolean;
  preise?: Array<{ schluessel: string; einheit: string; centsJe1000: number }>;
}

const eur = (c: number) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const datum = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : null);
const FUNKTION_TEXT: Record<string, string> = { "personen-radar": "Beobachtete Posts", watchlist: "Beobachtete Personen", leads: "Leads", sonstiges: "Sonstiges" };

function fehlertext(e: unknown): string {
  if (e instanceof GatewayError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function usePlaene() {
  return useQuery({ queryKey: ["plaene"], queryFn: () => gatewayFetch<Plaene>("/v1/plaene"), staleTime: 3_600_000 });
}
export function useSitze(enabled = true) {
  return useQuery({ queryKey: ["sitze"], queryFn: () => gatewayFetch<Sitze>("/v1/tenants/me/sitze"), staleTime: 30_000, retry: false, enabled });
}
function useLinkedinStand(enabled: boolean) {
  return useQuery({ queryKey: ["linkedin-verbrauch"], queryFn: () => gatewayFetch<LinkedinStand>("/v1/usage/linkedin"), staleTime: 30_000, retry: false, enabled });
}

export function PlanAbrechnungSection({ usage }: { usage: UsageSnapshot }) {
  const qc = useQueryClient();
  const plaene = usePlaene();
  const sitze = useSitze();
  const kontingent = usage.kontingent!;
  const ist = kontingent.plan;
  const kannWechseln = usage.kannSelbstWechseln !== false;
  const istEnterprise = ist === "enterprise";
  const linkedin = useLinkedinStand(!istEnterprise && ist !== "free");
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState<string | null>(null);
  const [auswahlOffen, setAuswahlOffen] = useState(false);
  const alle = qc.invalidateQueries.bind(qc);
  const neuLaden = () => Promise.all([alle({ queryKey: USAGE_QUERY_KEY }), alle({ queryKey: ["sitze"] }), alle({ queryKey: ["linkedin-verbrauch"] })]);

  const katalog = plaene.data?.plaene ?? [];
  const eintrag = katalog.find((p) => p.plan === ist) ?? null;
  const ichZeile = sitze.data?.mitglieder.find((m) => m.actorId === sitze.data?.ich) ?? null;
  const wechsel = ichZeile?.wechsel ?? null;
  const zyklusende = sitze.data?.zyklusende ?? usage.periodEnd ?? null;
  const kont = kontingent.kontingentCents ?? 0;
  const verbraucht = kontingent.verbrauchtCents;
  const pct = kont > 0 ? Math.min(100, (verbraucht / kont) * 100) : 0;
  const stufen = plaene.data?.stufen;
  const reichtNochMittel = stufen && kontingent.uebrigCents != null ? Math.floor(kontingent.uebrigCents / Math.max(1, stufen.mittel)) : null;
  const firmen = kontingent.stufen.klein + kontingent.stufen.mittel + kontingent.stufen.gross + kontingent.stufen.offen;

  async function planWaehlen(ziel: PlanEintrag) {
    if (!sitze.data || !kannWechseln) return;
    setFehler(null);
    const me = sitze.data.ich;
    const hoch = ziel.rang > (eintrag?.rang ?? 0);
    try {
      if (hoch && ziel.plan !== "enterprise") {
        const plan = ziel.plan as SitzPlan;
        const frei = sitze.data.jePlan[plan]?.frei ?? 0;
        let text = `Ab sofort ${ziel.name}: dein Kontingent für diesen Monat steigt anteilig auf den ${ziel.name}-Wert, ab ${datum(zyklusende) ?? "dem nächsten Zyklus"} gelten ${eur(ziel.preisCents ?? 0)} im Monat für diesen Sitz.`;
        if (frei > 0) text += `\n\nEin freier ${ziel.name}-Sitz eurer Organisation wird dir zugewiesen, es entstehen keine neuen Kosten.`;
        else {
          try {
            const v = await gatewayFetch<{ heuteCents: number; anteilig: boolean }>(`/v1/billing/sitze/vorschau?plan=${plan}&anzahl=1`);
            text += sitze.data.stripe
              ? `\n\nHeute zahlt ihr anteilig ${eur(v.heuteCents)} für den Rest des Zyklus${eintrag && eintrag.plan !== "free" ? ` (dein bisheriger ${eintrag.name}-Sitz wird frei und kann zum Zyklusende reduziert werden)` : ""}.`
              : `\n\nDer erste Sitz läuft über die Kasse: Zahlungsmittel eurer Organisation hinterlegen, ${eur(ziel.preisCents ?? 0)} im Monat.`;
          } catch {
            text += `\n\nEin neuer ${ziel.name}-Sitz wird gekauft, anteilig bis zum Zyklusende.`;
          }
        }
        const ok = await bestaetigen({ titel: `Auf ${ziel.name} wechseln`, text, bestaetigen: `Auf ${ziel.name} wechseln` });
        if (!ok) return;
        setLaeuft(ziel.plan);
        if (frei > 0) {
          await gatewayFetch(`/v1/tenants/me/mitglieder/${encodeURIComponent(me)}/sitz`, { method: "PUT", body: { plan } });
        } else {
          const r = await gatewayFetch<{ checkout?: { url: string } | null }>("/v1/tenants/me/sitze", { method: "POST", body: { plan, anzahl: 1, actorId: me, rueckkehr: "app" } });
          if (r.checkout?.url) {
            await window.api.shell.openExternal(r.checkout.url);
          }
        }
      } else {
        // Downgrade oder Free: zum Zyklusende vormerken.
        const zielText = ziel.plan === "free" ? "Free (ohne Sitz)" : ziel.name;
        const warnung = ziel.kontingentCents != null && verbraucht > ziel.kontingentCents
          ? `\n\nAchtung: Dein Bestand ist aktuell ${eur(verbraucht)} wert, ${ziel.name} bietet ${eur(ziel.kontingentCents)}. Du behältst alle Daten, kannst aber keine neuen Firmen aufnehmen, bis du Firmen entfernst.`
          : ziel.plan === "free" ? "\n\nDu behältst alle Daten. Ohne Sitz gelten 25 Firmen insgesamt." : "";
        const ok = await bestaetigen({ titel: `Zum ${datum(zyklusende) ?? "Zyklusende"} auf ${zielText} wechseln`, text: `Bis dahin bleibt dein ${eintrag?.name ?? "aktueller"}-Plan samt Kontingent. Der Wechsel lässt sich bis zum Stichtag rückgängig machen.${warnung}`, bestaetigen: "Wechsel vormerken", zerstoerend: ziel.plan === "free" });
        if (!ok) return;
        setLaeuft(ziel.plan);
        await gatewayFetch(`/v1/tenants/me/mitglieder/${encodeURIComponent(me)}/sitz`, { method: "PUT", body: { plan: ziel.plan, zum: "zyklusende" } });
      }
      await neuLaden();
      setAuswahlOffen(false);
    } catch (e) {
      setFehler(fehlertext(e));
    } finally {
      setLaeuft(null);
    }
  }

  async function wechselWiderrufen() {
    if (!sitze.data) return;
    setFehler(null);
    try {
      await gatewayFetch(`/v1/tenants/me/mitglieder/${encodeURIComponent(sitze.data.ich)}/sitz/wechsel`, { method: "DELETE" });
      await neuLaden();
    } catch (e) {
      setFehler(fehlertext(e));
    }
  }

  async function anfragen(ziel: PlanEintrag) {
    setFehler(null);
    try {
      await gatewayFetch("/v1/billing/plan-anfrage", { method: "POST", body: { plan: ziel.plan } });
      setFehler(null);
      await bestaetigen({ titel: "Anfrage gesendet", text: `Owner und Admins deiner Organisation sehen deine Anfrage nach ${ziel.name} in der Konsole.`, bestaetigen: "Verstanden" });
    } catch (e) {
      setFehler(fehlertext(e));
    }
  }

  const portal = useMutation({
    mutationFn: () => window.api.billing.openPortal(),
    onError: (e: Error) => setFehler(e.message),
  });

  return (
    <section id="plan-section" className="ct-card u-mb-2">
      <header className="ct-card__header">
        <h3>Plan &amp; Abrechnung</h3>
        <p className="muted">Dein Plan, dein Monatskontingent und was es bedeutet.</p>
      </header>

      <div className="u-stack u-stack--lg">
        {/* Kopfkarte */}
        <div className="plan-kopf">
          <div className="plan-kopf__links">
            <div className="u-row">
              <span className={`badge badge--${ist}`}>{eintrag?.name ?? ist}</span>
              <span className="muted small">Dein Plan</span>
              {eintrag?.preisCents ? <span className="muted small">· {eur(eintrag.preisCents)} im Monat</span> : null}
              {zyklusende && !istEnterprise && ist !== "free" && <span className="muted small">· nächste Abrechnung {datum(zyklusende)}</span>}
            </div>
            {wechsel && (
              <div className="ct-card ct-card--kompakt ct-card--warn plan-kopf__hinweis">
                Wechselt am {datum(wechsel.am)} zu {katalog.find((p) => p.plan === wechsel.zu)?.name ?? wechsel.zu}.{" "}
                {kannWechseln && (
                  <button type="button" className="link is-inline" onClick={() => void wechselWiderrufen()}>rückgängig</button>
                )}
              </div>
            )}
            {usage.status === "past_due" && <div className="ct-card ct-card--kompakt ct-card--warn">Bei eurer Organisation ist eine Zahlung offen. Bis zur Klärung läuft alles weiter.</div>}
            {usage.status === "suspended" && <div className="error">Der Zugang eurer Organisation ist wegen einer offenen Zahlung pausiert. Neue Firmen warten, bis die Zahlung geklärt ist.</div>}
          </div>

          {istEnterprise ? (
            <div className="u-stack u-stack--sm">
              <strong>Vertrag eurer Organisation</strong>
              <span className="muted small">
                {firmen} Firmen im Bestand
                {kontingent.enterprise?.firmenLimit != null ? ` von höchstens ${kontingent.enterprise.firmenLimit}` : ""}
                {" · "}Abrechnung laut Vertrag
              </span>
            </div>
          ) : ist === "free" ? (
            <div className="u-stack u-stack--sm">
              <div className="fortschritt__kopf">
                <strong>{usage.used} von {usage.limit} Firmen genutzt</strong>
                <span className="muted">einmalig, ohne Zeitlimit</span>
              </div>
              <div role="progressbar" aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={usage.used} className="fortschritt">
                <div className={`fortschritt__balken${usage.used >= usage.limit ? " fortschritt__balken--err" : usage.used / Math.max(1, usage.limit) >= 0.8 ? " fortschritt__balken--warn" : ""}`} style={{ width: `${Math.min(100, (usage.used / Math.max(1, usage.limit)) * 100)}%` }} />
              </div>
            </div>
          ) : (
            <div className="u-stack u-stack--sm">
              <div className="fortschritt__kopf">
                <strong>{eur(verbraucht)} von {eur(kont)} genutzt</strong>
                <span className="muted">{kontingent.anteilig ? "anteiliges Kontingent in diesem Monat" : "Kontingent in diesem Monat"}</span>
              </div>
              <div role="progressbar" aria-valuemin={0} aria-valuemax={kont} aria-valuenow={verbraucht} className="fortschritt">
                <div className={`fortschritt__balken${verbraucht >= kont ? " fortschritt__balken--err" : pct >= 80 ? " fortschritt__balken--warn" : ""}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="muted small">
                {firmen} Firmen im Bestand
                {firmen > 0 ? ` (${[kontingent.stufen.klein ? `${kontingent.stufen.klein} klein` : "", kontingent.stufen.mittel ? `${kontingent.stufen.mittel} mittel` : "", kontingent.stufen.gross ? `${kontingent.stufen.gross} groß` : "", kontingent.stufen.offen ? `${kontingent.stufen.offen} noch ohne Stufe` : ""].filter(Boolean).join(", ")})` : ""}
                {kontingent.neuverarbeitungCents > 0 ? ` · ${eur(kontingent.neuverarbeitungCents)} für Neuverarbeitungen` : ""}
                {reichtNochMittel != null && !kontingent.payg.freigegeben ? ` · reicht noch für etwa ${reichtNochMittel} mittlere Firmen` : ""}
              </span>
              {kontingent.payg.freigegeben && (
                <span className="small text-warn">Über das Kontingent hinaus freigegeben: bisher {eur(kontingent.payg.ueberCents)} zusätzlich{kontingent.payg.limitCents != null ? ` (Deckel ${eur(kontingent.payg.limitCents)})` : ""}.</span>
              )}
            </div>
          )}

          <div className="u-row plan-kopf__aktionen">
            {!istEnterprise && kannWechseln && (
              <button type="button" className="btn btn--primaer" onClick={() => setAuswahlOffen((o) => !o)}>
                {auswahlOffen ? "Plan-Auswahl schließen" : "Plan ändern"}
              </button>
            )}
            {!istEnterprise && !kannWechseln && (
              <button type="button" className="btn" onClick={() => setAuswahlOffen((o) => !o)}>
                {auswahlOffen ? "Schließen" : "Wechsel anfragen"}
              </button>
            )}
            {sitze.data?.stripe && kannWechseln && (
              <button type="button" className="btn" disabled={portal.isPending} onClick={() => portal.mutate()}>
                {portal.isPending ? "Wird geöffnet…" : "Rechnungen und Zahlungsmittel"}
              </button>
            )}
            {kannWechseln && (
              <ExternalLink href={`${KONSOLE_URL}/mitglieder`} className="btn">Sitze der Organisation</ExternalLink>
            )}
            {!kannWechseln && <span className="muted small">Pläne verwaltet eure Organisation in der Konsole.</span>}
          </div>
        </div>

        {/* Plan-Auswahl */}
        {auswahlOffen && !istEnterprise && (
          <div className="plan-grid">
            {katalog.filter((p) => p.plan !== "enterprise").map((p) => {
              const istAktuell = p.plan === ist;
              const hoch = p.rang > (eintrag?.rang ?? 0);
              const beispiel = p.beispielFirmen ? `z. B. ${p.beispielFirmen.klein} kleine oder ${p.beispielFirmen.gross} große Firmen` : p.firmenLebenslang ? `${p.firmenLebenslang} Firmen insgesamt` : "";
              return (
                <div key={p.plan} className={"plan-card" + (istAktuell ? " plan-card--current" : "") + (p.plan === "max" && !istAktuell ? " plan-card--recommended" : "")}>
                  {istAktuell && <span className="plan-card__badge plan-card__badge--current">Dein Plan</span>}
                  {p.plan === "max" && !istAktuell && <span className="plan-card__badge">Empfohlen</span>}
                  <div className="plan-card__name">{p.name}</div>
                  <div className="plan-card__price">
                    <span className="plan-card__price-amount">{p.preisCents == null ? "Vertrag" : p.preisCents === 0 ? "0 €" : eur(p.preisCents).replace(",00", "")}</span>
                    {p.preisCents ? <span className="plan-card__price-cadence">je Nutzer und Monat</span> : null}
                  </div>
                  <div className="plan-card__quota muted">
                    {p.kontingentCents != null ? `Monatskontingent ${eur(p.kontingentCents).replace(",00", "")}` : p.firmenLebenslang ? "Ohne Monatskontingent" : ""}
                    {beispiel ? ` · ${beispiel}` : ""}
                  </div>
                  <ul className="plan-card__features">{p.merkmale.map((m) => <li key={m}>{m}</li>)}</ul>
                  <div className="plan-card__cta">
                    {istAktuell ? (
                      <button type="button" disabled className="plan-card__cta-btn">Aktiv</button>
                    ) : kannWechseln ? (
                      <button type="button" className={"plan-card__cta-btn" + (hoch ? " plan-card__cta-btn--primary" : "")} disabled={laeuft !== null || !sitze.data} onClick={() => void planWaehlen(p)}>
                        {laeuft === p.plan ? "Wird umgestellt…" : hoch ? "Upgrade" : `Zum ${datum(zyklusende) ?? "Zyklusende"} wechseln`}
                      </button>
                    ) : (
                      <button type="button" className="plan-card__cta-btn" onClick={() => void anfragen(p)}>Anfragen</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {auswahlOffen && !istEnterprise && (
          <small className="muted">
            Für Teams mit Sammelrechnung und Vertrag: <ExternalLink href="https://ava.bi/kontakt">Enterprise anfragen</ExternalLink>. Upgrades wirken sofort und werden anteilig berechnet, Downgrades zum Zyklusende.
          </small>
        )}

        {/* Ultra: über das Kontingent hinaus */}
        {ist === "ultra" && <PaygKarte kontingent={kontingent} kannWechseln={kannWechseln} onChanged={neuLaden} onError={setFehler} />}

        {/* LinkedIn-Beobachtung */}
        {!istEnterprise && ist !== "free" && <LinkedinKarte stand={linkedin.data} kannWechseln={kannWechseln} onChanged={neuLaden} onError={setFehler} />}

        {fehler && <div className="error">{fehler}</div>}
      </div>
    </section>
  );
}

function PaygKarte({ kontingent, kannWechseln, onChanged, onError }: { kontingent: NonNullable<UsageSnapshot["kontingent"]>; kannWechseln: boolean; onChanged: () => Promise<unknown>; onError: (m: string | null) => void }) {
  const [deckel, setDeckel] = useState<string>(kontingent.payg.limitCents != null ? String(kontingent.payg.limitCents / 100) : "");
  const [laeuft, setLaeuft] = useState(false);
  const an = kontingent.payg.freigegeben;
  const schalten = async () => {
    onError(null);
    const limitCents = deckel.trim() === "" ? null : Math.round(Number(deckel.replace(",", ".")) * 100);
    if (limitCents != null && (!Number.isFinite(limitCents) || limitCents < 0)) { onError("Bitte einen Betrag in Euro eingeben (leer = kein Deckel)."); return; }
    if (!an) {
      const ok = await bestaetigen({
        titel: "Über das Kontingent hinaus aufnehmen",
        text: `Für den laufenden Monat darf dein Bestand das Kontingent übersteigen. Jede weitere Firma wird nach Stufe berechnet (0,50 €, 1,00 € oder 1,50 € je Monat)${limitCents != null ? `, höchstens ${eur(limitCents)} zusätzlich` : ""}. Am Monatsersten ist die Freigabe wieder aus.`,
        bestaetigen: "Freigeben",
      });
      if (!ok) return;
    }
    setLaeuft(true);
    try {
      await gatewayFetch("/v1/usage/payg", { method: "PUT", body: { freigeben: !an, limitCents } });
      await onChanged();
    } catch (e) {
      onError(fehlertext(e));
    } finally {
      setLaeuft(false);
    }
  };
  return (
    <div className="ct-card ct-card--kompakt u-stack u-stack--sm">
      <strong>Über das Kontingent hinaus</strong>
      <span className="muted small">Nur mit Ultra: Für den laufenden Monat weitere Firmen aufnehmen, berechnet nach Stufe. Die Freigabe endet automatisch am Monatsersten.</span>
      <div className="u-row">
        <label className="muted small" htmlFor="payg-deckel">Deckel je Monat</label>
        <input id="payg-deckel" type="text" inputMode="decimal" placeholder="kein Deckel" value={deckel} onChange={(e) => setDeckel(e.target.value)} disabled={!kannWechseln || laeuft} style={{ width: "7rem" }} />
        <span className="muted small">€</span>
        {kannWechseln && (
          <button type="button" className={an ? "btn" : "btn btn--primaer"} disabled={laeuft} onClick={() => void schalten()}>
            {laeuft ? "Speichert…" : an ? "Freigabe zurücknehmen" : "Für diesen Monat freigeben"}
          </button>
        )}
        {!kannWechseln && <span className="muted small">setzt der Owner oder Admin eurer Organisation</span>}
      </div>
      {an && <span className="small text-warn">Freigegeben bis Monatsende · bisher {eur(kontingent.payg.ueberCents)} zusätzlich.</span>}
    </div>
  );
}

function LinkedinKarte({ stand, kannWechseln, onChanged, onError }: { stand: LinkedinStand | undefined; kannWechseln: boolean; onChanged: () => Promise<unknown>; onError: (m: string | null) => void }) {
  const [entwurf, setEntwurf] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  if (!stand) return null;
  const wert = entwurf ?? (stand.limitCents != null ? String(stand.limitCents / 100) : "");
  const pct = stand.limitCents ? Math.min(100, (stand.verbrauchtCents / stand.limitCents) * 100) : 0;
  const speichern = async () => {
    onError(null);
    const roh = (entwurf ?? "").trim().replace(",", ".");
    const limitCents = roh === "" ? null : Math.round(Number(roh) * 100);
    if (limitCents != null && (!Number.isFinite(limitCents) || limitCents < 0)) { onError("Bitte einen Betrag in Euro eingeben (leer = kein Limit, dann läuft keine Beobachtung)."); return; }
    setLaeuft(true);
    try {
      await gatewayFetch("/v1/usage/linkedin-limit", { method: "PUT", body: { limitCents } });
      setEntwurf(null);
      await onChanged();
    } catch (e) {
      onError(fehlertext(e));
    } finally {
      setLaeuft(false);
    }
  };
  const funktionen = Object.entries(stand.jeFunktion).filter(([, c]) => c > 0);
  return (
    <div className="ct-card ct-card--kompakt u-stack u-stack--sm">
      <strong>LinkedIn-Beobachtung · nach Verbrauch</strong>
      <span className="muted small">Beobachtete Posts, beobachtete Personen und Leads werden nach Verbrauch berechnet und kommen mit der nächsten Rechnung. Ohne Monatslimit läuft keine Beobachtung.</span>
      <div className="fortschritt__kopf">
        <strong>{eur(stand.verbrauchtCents)}{stand.limitCents != null ? ` von ${eur(stand.limitCents)}` : ""} in diesem Monat</strong>
        <span className="muted">{stand.laeufe} Läufe{stand.geschaetztCents > 0 ? ` · ${eur(stand.geschaetztCents)} noch geschätzt` : ""}</span>
      </div>
      {stand.limitCents != null && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={stand.limitCents} aria-valuenow={stand.verbrauchtCents} className="fortschritt">
          <div className={`fortschritt__balken${stand.verbrauchtCents >= stand.limitCents ? " fortschritt__balken--err" : pct >= 80 ? " fortschritt__balken--warn" : ""}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {funktionen.length > 0 && (
        <span className="muted small">{funktionen.map(([k, c]) => `${FUNKTION_TEXT[k] ?? k}: ${eur(c)}`).join(" · ")}</span>
      )}
      <div className="u-row">
        <label className="muted small" htmlFor="linkedin-limit">Monatslimit</label>
        <input id="linkedin-limit" type="text" inputMode="decimal" placeholder="kein Limit" value={wert} disabled={!kannWechseln || laeuft} onChange={(e) => setEntwurf(e.target.value)} style={{ width: "7rem" }} />
        <span className="muted small">€</span>
        {kannWechseln && entwurf !== null && (
          <button type="button" className="btn btn--primaer" disabled={laeuft} onClick={() => void speichern()}>{laeuft ? "Speichert…" : "Speichern"}</button>
        )}
        {!kannWechseln && <span className="muted small">setzt der Owner oder Admin eurer Organisation</span>}
      </div>
      {stand.limitCents != null && stand.verbrauchtCents >= stand.limitCents && (
        <span className="small text-warn">Das Monatslimit ist erreicht. Beobachtungen pausieren bis zum Monatsanfang oder bis du das Limit erhöhst.</span>
      )}
      {stand.preise && stand.preise.length > 0 && (
        <details>
          <summary className="muted small">Preise</summary>
          <ul className="muted small">
            {stand.preise.map((p) => <li key={p.schluessel}>{eur(p.centsJe1000)} je 1.000 {p.einheit}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
