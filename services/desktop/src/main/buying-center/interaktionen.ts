// Interaktionen je Person aus dem CRM (docs/PLAN_BUYING_CENTER.md, BC3).
//
// Leitfrage 3 aus Daten: Wie gut kennen wir die Personen? Das CRM weiss,
// mit wem wann gesprochen wurde — Notizen, Anrufe, E-Mails, Termine. Daraus
// entsteht je Person ein Verlauf fuer die Seitenleiste und ein VORSCHLAG
// fuer die Kontaktintensitaet (0 / S / R / I nach Schwellen). Vorschlag,
// nicht Setzung: Der Nutzer kennt Kontakte, die nie im CRM landeten.
//
// Und das Gespraechsmuster aus dem Buch: Sprecht ihr seit Monaten nur mit
// denselben zwei Leuten? Das ist ein Hinweis, keine Einordnung — er
// empfiehlt eine Handlung.
//
// Laeuft im Hauptprozess, weil die CRM-Anmeldung dort liegt. Der Renderer
// bekommt nur das Ergebnis.

import type { CrmManager } from "../crm";
import { listHubspotAssociatedRecords } from "../crm/write-objects";
import type { GatewayClient } from "../agent/gateway-client";
import type { BcInteraktion, BcInteraktionenErgebnis, BcMitgliedInteraktionen } from "../../shared/types";

/** Zeitraum, der fuer die Kontaktintensitaet zaehlt. */
const TAGE = 90;
/** Schwellen aus dem Plan (Abschnitt 6): 0 / 1–2 / 3–8 / > 8 in 90 Tagen. */
export function kontaktVorschlag(anzahl: number): "0" | "S" | "R" | "I" {
  if (anzahl === 0) return "0";
  if (anzahl <= 2) return "S";
  if (anzahl <= 8) return "R";
  return "I";
}

/** Vergleichsform fuer Namen: klein, Umlaute ausgeschrieben, Titel weg. */
export function falte(v: string | null | undefined): string {
  return (v ?? "")
    .toLowerCase()
    .replace(/\b(dr|prof|dipl|ing|mba|ba|ma|msc|bsc)\.?\s*/g, "")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/\p{M}+/gu, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Rafflenbeul, Joyce" und "Joyce Rafflenbeul" sind dieselbe Person. */
export function gleicherName(a: string, b: string): boolean {
  const fa = falte(a), fb = falte(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  const ta = fa.split(" "), tb = fb.split(" ");
  return ta.length >= 2 && tb.length >= 2 && [...ta].sort().join(" ") === [...tb].sort().join(" ");
}

interface Deps { crm: CrmManager; gateway: GatewayClient }

interface BcRoh {
  id: string; companyId: string; eigenes: boolean;
  mitglieder: Array<{ id: string; name: string; kontakt: string | null }>;
}

export async function ladeInteraktionen(deps: Deps, buyingCenterId: string): Promise<BcInteraktionenErgebnis> {
  const leer = (grund: string): BcInteraktionenErgebnis => ({ verfuegbar: false, grund, mitglieder: [], gespraechsmuster: null });

  const bc = await deps.gateway.request<BcRoh>(`/v1/buying-center/${encodeURIComponent(buyingCenterId)}`);
  const links = await deps.gateway.request<{ links: Array<{ crmType: string; crmExternalId: string }> }>(
    `/v1/companies/${encodeURIComponent(bc.companyId)}/crm`,
  );
  const hubspot = (links.links ?? []).find((l) => l.crmType === "HUBSPOT");
  if (!hubspot) return leer("keine_crm_verknuepfung");
  if (!(await deps.crm.getAccessToken("hubspot"))) return leer("hubspot_nicht_verbunden");

  // Kontakte der verknuepften HubSpot-Firma, dann Namensabgleich mit den
  // Mitgliedern. E-Mail waere trennschaerfer, liegt aber selten auf beiden
  // Seiten vor; der Name reicht bei einer Firma fast immer.
  const kontakte = await listHubspotAssociatedRecords(deps.crm, {
    fromObjectType: "companies", fromObjectId: hubspot.crmExternalId, toObjectType: "contacts", limit: 200,
  });
  const seit = Date.now() - TAGE * 86_400_000;
  const ergebnis: BcMitgliedInteraktionen[] = [];

  for (const m of bc.mitglieder) {
    const treffer = kontakte.records.find((r) =>
      gleicherName(m.name, `${r.properties.firstname ?? ""} ${r.properties.lastname ?? ""}`),
    );
    if (!treffer) {
      ergebnis.push({ mitgliedId: m.id, hubspotContactId: null, anzahl90Tage: 0, letzte: [], kontaktVorschlag: null });
      continue;
    }
    const alle: BcInteraktion[] = [];
    const arten: Array<{ typ: "notes" | "calls" | "emails" | "meetings"; art: BcInteraktion["art"]; titel: (p: Record<string, string | null>) => string | null }> = [
      { typ: "notes", art: "notiz", titel: (p) => kurz(p.hs_note_body) },
      { typ: "calls", art: "anruf", titel: (p) => p.hs_call_title ?? kurz(p.hs_call_body) ?? null },
      { typ: "emails", art: "email", titel: (p) => p.hs_email_subject ?? null },
      { typ: "meetings", art: "termin", titel: (p) => p.hs_meeting_title ?? null },
    ];
    for (const a of arten) {
      try {
        const r = await listHubspotAssociatedRecords(deps.crm, { fromObjectType: "contacts", fromObjectId: treffer.id, toObjectType: a.typ, limit: 50 });
        for (const rec of r.records) {
          alle.push({ art: a.art, zeitpunkt: rec.properties.hs_timestamp ?? rec.properties.hs_meeting_start_time ?? null, titel: a.titel(rec.properties) });
        }
      } catch {
        // Eine Art scheitert (fehlender Scope, Netz) — die anderen zaehlen
        // trotzdem. Lieber ein unvollstaendiger Verlauf als gar keiner.
      }
    }
    alle.sort((x, y) => (y.zeitpunkt ?? "").localeCompare(x.zeitpunkt ?? ""));
    const anzahl = alle.filter((i) => i.zeitpunkt && Date.parse(i.zeitpunkt) >= seit).length;
    const vorschlag = kontaktVorschlag(anzahl);
    ergebnis.push({ mitgliedId: m.id, hubspotContactId: treffer.id, anzahl90Tage: anzahl, letzte: alle.slice(0, 8), kontaktVorschlag: vorschlag });

    // Vorschlag ablegen — nur beim eigenen Buying Center, nur wenn der
    // Nutzer die Kontaktintensitaet nicht selbst gesetzt hat (prueft das
    // Gateway noch einmal). Beim Nutzer-Wert "0" trotz Interaktionen kein
    // Widerspruch von hier: Das waere ein Hinweis, kein Vorschlag (BC5).
    if (bc.eigenes && m.kontakt === null) {
      try {
        await deps.gateway.request(`/v1/buying-center/${encodeURIComponent(bc.id)}/mitglieder/${encodeURIComponent(m.id)}/vorschlaege`, {
          method: "POST",
          body: { dimension: "kontakt", wert: vorschlag, herkunft: "ava:crm", grund: `${anzahl} Interaktion${anzahl === 1 ? "" : "en"} im CRM in den letzten ${TAGE} Tagen` },
        });
      } catch { /* Vorschlag ist Beiwerk; der Verlauf kommt trotzdem an. */ }
    }
  }

  return { verfuegbar: true, mitglieder: ergebnis, gespraechsmuster: gespraechsmuster(ergebnis, bc.mitglieder.length) };
}

function kurz(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 89)}…` : t || null;
}

/**
 * Das Muster aus dem Buch: immer dieselben zwei, und der Rest ohne Kontakt.
 * Ein Hinweis, keine Einordnung. Der Abgleich mit dem Deal-Stand (steht
 * die Sache seit Monaten?) kommt mit BC5, sobald Deals im Bild sind.
 */
function gespraechsmuster(m: BcMitgliedInteraktionen[], mitgliederGesamt: number): string | null {
  const gesamt = m.reduce((s, x) => s + x.anzahl90Tage, 0);
  if (gesamt < 6 || mitgliederGesamt < 4) return null;
  const sortiert = [...m].sort((a, b) => b.anzahl90Tage - a.anzahl90Tage);
  const zweiAnteil = (sortiert[0]!.anzahl90Tage + (sortiert[1]?.anzahl90Tage ?? 0)) / gesamt;
  if (zweiAnteil < 0.9) return null;
  const ohne = m.filter((x) => x.anzahl90Tage === 0).length;
  return `${Math.round(zweiAnteil * 100)} % aller Kontakte der letzten ${TAGE} Tage laufen ueber zwei Personen; ${ohne} der ${mitgliederGesamt} Personen hatten keinen. Vielleicht lohnt ein Gespraech mit jemand anderem.`;
}
