// docs/PLAN_PRICING_TIERS.md P1 — reine Rechnung fuer das tagesanteilige
// Monatskontingent (ohne Datenbank, ohne Umgebungsvariablen; testbar).
import type { BillingTier } from "./billing";
import { planEintrag } from "./billing-plans";

/** Grenzen eines Kalendermonats (UTC) aus einem periodKey YYYY-MM. */
export function monatsGrenzen(periodKey: string): { von: Date; bis: Date; tage: number } {
  const [y, m] = periodKey.split("-").map(Number);
  const von = new Date(Date.UTC(y, m - 1, 1));
  const bis = new Date(Date.UTC(y, m, 1));
  return { von, bis, tage: Math.round((bis.getTime() - von.getTime()) / 86_400_000) };
}

/**
 * Tagesanteiliges Monatskontingent eines Nutzers in Cent: Summe ueber die Tage
 * des Monats von Kontingent(Plan am Tag) / Tage im Monat. Tage ohne Zeitraum
 * zaehlen als Free (0). Enterprise liefert null (Vertrag/Betreiber-Limit).
 * `stand` begrenzt die Rechnung auf den Teil des Monats bis heute, wenn der
 * Monat noch laeuft (damit das Kontingent am 10. nicht schon den 30. enthaelt);
 * standardmaessig wird der ganze Monat gerechnet, weil die Vorabpruefung gegen
 * den Monatsbestand laeuft.
 */
/** Reine Rechnung fuer kontingentCents (testbar ohne Datenbank). */
export function kontingentAusZeitraeumen(
  zeitraeume: Array<{ plan: string; ab: Date; bis: Date | null }>,
  periodKey: string,
  jetzt: Date = new Date(),
): { kontingentCents: number | null; planHeute: BillingTier; anteilig: boolean } {
  const { von, bis, tage } = monatsGrenzen(periodKey);
  let summe = 0;
  let anteilig = false;
  let enterprise = false;
  let planHeute: BillingTier = "free";
  let abgedeckt = 0;
  for (const z of zeitraeume) {
    const plan = z.plan as BillingTier;
    if (plan === "enterprise") enterprise = true;
    const k = planEintrag(plan).kontingentCents ?? 0;
    const a = Math.max(z.ab.getTime(), von.getTime());
    const b = Math.min((z.bis ?? bis).getTime(), bis.getTime());
    const tageImMonat = Math.max(0, (b - a) / 86_400_000);
    abgedeckt += tageImMonat;
    summe += (k * tageImMonat) / tage;
    if (z.ab <= jetzt && (!z.bis || z.bis > jetzt)) planHeute = plan;
  }
  // Anteilig, sobald der Monat nicht durchgehend mit demselben Kontingent belegt ist.
  if (zeitraeume.length > 0 && (abgedeckt < tage - 0.01 || new Set(zeitraeume.map((z) => z.plan)).size > 1)) anteilig = true;
  if (enterprise) return { kontingentCents: null, planHeute: "enterprise", anteilig: false };
  return { kontingentCents: Math.round(summe), planHeute, anteilig };
}

