// Neuigkeiten-Mail vom Server (Burggraben 3, docs/PLAN_BURGGRABEN.md).
//
// Bisher schickte nur der Desktop-Heartbeat die Sammelmail (onboarding/
// neuigkeiten-mail.ts → POST /v1/onboarding/mail/neuigkeiten), also nur,
// solange die App des Nutzers lief. Wer AVA zuklappt, hoerte nichts mehr.
//
// Dieser Takt mailt stattdessen vom Gateway aus, regelbasiert und ohne
// KI-Urteil, aber nur dann, wenn
//   * der Nutzer Neuigkeiten per Mail bestaetigt hat (Double-Opt-in) und
//     nicht abgemeldet ist,
//   * seine AVA (Desktop oder Server) seit mindestens einem Tag keine
//     Anfrage gestellt hat (NutzerAktivitaet.appZuletztAt) — sonst mailt
//     der Desktop-Takt selbst, mit Urteil und Nutzerprofil,
//   * seit der letzten Neuigkeiten-Mail (egal von wem) 20 Stunden vergangen
//     sind (MailVersand), und
//   * es morgens ist (06:00 bis 10:00 Europe/Berlin).
//
// Quellen sind dieselben wie beim Heartbeat (sammleNeuheiten): Register-
// aenderungen, Veroeffentlichungen, Ansprechpartner-Wechsel, neue Kunden,
// Stellen, Fokus-Themen. Neue Ansprechpartner (new-contacts) bleiben ohne
// Urteil draussen, sie sind zu laut. Fenster: seit der letzten Mail, beim
// ersten Mal sieben Tage (Deckel 30 Tage in sammleNeuheiten).
//
// NEUIGKEITEN_CRON_DISABLED=1 schaltet ab (Tests, Wartung).

import { logger } from "./logger";
import { getGatewayPool } from "./producer-pools";
import { resolveCompanyNames } from "./company-names";
import { tombstonedSubset } from "./company-tombstones";
import { masterData } from "./register-jobs";
import { loadEnv } from "./env";
import { linkAdressen, mailSenden, versandBereit, type MailKonto } from "./mail/versand";
import { neuigkeitenMail, type NeuigkeitenDaten } from "./mail/vorlagen";
import { sammleNeuheiten, type NeuheitItem } from "../routes/v1/alerts-neuheiten";

const TAKT_MS = 60 * 60_000;
/** Wie die Route: hoechstens eine Neuigkeiten-Mail je 20 Stunden. */
export const ABSTAND_MS = 20 * 3600_000;
/** AVA gilt als still, wenn sie so lange keine Anfrage gestellt hat. */
export const APP_STILL_MS = 24 * 3600_000;
/** Erste Mail: so weit zurueckschauen. */
const ERSTES_FENSTER_MS = 7 * 86_400_000;
const MAX_FIRMEN = 500;
export const MAX_MELDUNGEN = 12;
/** Versandfenster in Europe/Berlin, Stunde ab (einschliesslich) bis (ausschliesslich). */
const FENSTER = { von: 6, bis: 10 };

export type Meldung = NeuigkeitenDaten["meldungen"][number];

/** Stunde in Europe/Berlin (Sommer-/Winterzeit ueber Intl). */
export function stundeBerlin(d: Date): number {
  const s = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false }).format(d);
  return Number.parseInt(s, 10) % 24;
}

/** Soll fuer dieses Konto jetzt gemailt werden? Reine Entscheidung, keine Datenbank. */
export function cronEntscheidung(e: { jetzt: Date; letzterVersand: Date | null; appZuletztAt: Date | null }): { senden: boolean; grund: string } {
  const h = stundeBerlin(e.jetzt);
  if (h < FENSTER.von || h >= FENSTER.bis) return { senden: false, grund: "ausserhalb des Zeitfensters" };
  if (e.letzterVersand && e.jetzt.getTime() - e.letzterVersand.getTime() < ABSTAND_MS) return { senden: false, grund: "zu frueh" };
  if (e.appZuletztAt && e.jetzt.getTime() - e.appZuletztAt.getTime() < APP_STILL_MS) return { senden: false, grund: "AVA des Nutzers laeuft" };
  return { senden: true, grund: "faellig" };
}

const name = (p: Record<string, unknown> | undefined): string => `${String(p?.firstName ?? "")} ${String(p?.lastName ?? "")}`.replace(/\s+/g, " ").trim();
const wert = (p: Record<string, unknown> | undefined): string => String(p?.value ?? "").trim();
const liste = (xs: string[], max = 4): string => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} und ${xs.length - max} weitere`);
const geld = (v: { value: number | null; currency: string | null } | null): string | null =>
  v?.value == null ? null : `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(v.value)} ${v.currency ?? "EUR"}`;

/** Gewicht je Art: kleiner = wichtiger, kommt zuerst. */
function gewicht(i: NeuheitItem): number {
  switch (i.art) {
    case "profile-change":
      return i.kind === "managing-directors" ? 0 : i.kind === "name" || i.kind === "legal-form" ? 1 : i.kind === "purpose" ? 3 : 2;
    case "publication": return 3;
    case "contact-change": return 4;
    case "new-customers": return 5;
    case "job-postings": return 6;
    case "thema-gefunden": return 6;
    default: return 9;
  }
}

/** Eine Neuheit als Mail-Zeile; null = gehoert nicht in die Mail. */
function zeile(i: NeuheitItem, firma: string): Meldung | null {
  const basis = { firma, companyId: i.companyId };
  switch (i.art) {
    case "profile-change": {
      const vorher = wert(i.removed[0]);
      const nachher = wert(i.added[0]);
      const art = "Stammdaten";
      if (i.kind === "managing-directors") {
        const neu = i.added.map(name).filter(Boolean);
        const weg = i.removed.map(name).filter(Boolean);
        const text = [neu.length ? `Neu: ${liste(neu)}.` : "", weg.length ? `Ausgeschieden: ${liste(weg)}.` : ""].filter(Boolean).join(" ");
        return { ...basis, art, titel: "Geschäftsführung geändert", text: `${text} Laut Handelsregister.`, quelleUrl: null };
      }
      const t: Record<string, string> = { name: "Umfirmierung", "legal-form": "Rechtsform", address: "Neuer Sitz", "share-capital": "Stammkapital", purpose: "Unternehmensgegenstand" };
      const titel = t[i.kind] ?? i.kind;
      if (i.kind === "purpose") return { ...basis, art, titel: `${titel} geändert`, text: `Neu: ${nachher.slice(0, 300)}`, quelleUrl: null };
      return { ...basis, art, titel: `${titel}: ${vorher} → ${nachher}`, text: "Laut Handelsregister.", quelleUrl: null };
    }
    case "publication": {
      const kennzahlen = [
        i.employeeCount != null ? `${i.employeeCount} Mitarbeitende` : null,
        geld(i.revenueVolume) ? `Umsatz ${geld(i.revenueVolume)}` : null,
        geld(i.totalAssetsVolume) ? `Bilanzsumme ${geld(i.totalAssetsVolume)}` : null,
      ].filter((x): x is string => !!x);
      return { ...basis, art: "Veröffentlichung", titel: `Neue Veröffentlichung${i.year ? ` ${i.year}` : ""}: ${i.name ?? "Jahresabschluss"}`, text: kennzahlen.length ? kennzahlen.join(", ") : "Im Unternehmensregister eingegangen.", quelleUrl: null };
    }
    case "contact-change": {
      const wer = i.personName ?? "Ansprechpartner";
      const quelleUrl = i.quellen?.[0]?.url ?? null;
      const art = "Ansprechpartner";
      if (i.typ === "job-changed") return { ...basis, art, titel: `${wer}: neue Position`, text: `${i.before ?? "?"} → ${i.after ?? "?"}`, quelleUrl };
      if (i.typ === "employer-changed") return { ...basis, art, titel: `${wer} hat den Arbeitgeber gewechselt`, text: `${i.before ?? "?"} → ${i.after ?? "?"}`, quelleUrl };
      return { ...basis, art, titel: i.typ === "company-phone-changed" ? "Telefonnummer geändert" : "E-Mail-Adresse geändert", text: `${i.before ?? "?"} → ${i.after ?? "?"}`, quelleUrl };
    }
    case "new-customers":
      return { ...basis, art: "Kunden", titel: i.anzahl === 1 ? "Neue Referenz auf der Website" : `${i.anzahl} neue Kunden/Referenzen auf der Website`, text: liste(i.kunden.map((k) => k.name)), quelleUrl: i.kunden.find((k) => k.quelle)?.quelle ?? null };
    case "job-postings":
      return { ...basis, art: "Stellen", titel: i.anzahl === 1 ? "Neue Stellenanzeige" : `${i.anzahl} neue Stellenanzeigen`, text: liste(i.stellen.map((s) => s.title)), quelleUrl: i.stellen[0]?.sourceUrl ?? null };
    case "thema-gefunden":
      return { ...basis, art: "Fokus-Thema", titel: `Fokus-Thema gefunden: ${liste(i.themen.map((t) => t.name), 3)}`, text: i.themen[0]?.zitat ?? "Auf der Website gefunden.", quelleUrl: i.themen.find((t) => t.quelleUrl)?.quelleUrl ?? null };
    default:
      return null; // new-contacts: ohne Urteil zu laut
  }
}

/** Neuheiten regelbasiert in Mail-Zeilen verwandeln: gewichtet, je Firma und Art einmal, hoechstens MAX_MELDUNGEN. */
export function neuheitenZuMeldungen(items: NeuheitItem[], namen: Map<string, string>): Meldung[] {
  const sortiert = [...items].sort((a, b) => gewicht(a) - gewicht(b));
  const gesehen = new Set<string>();
  const out: Meldung[] = [];
  for (const i of sortiert) {
    const z = zeile(i, namen.get(i.companyId) ?? i.companyId);
    if (!z) continue;
    const key = `${z.companyId}|${z.art}|${z.titel}`;
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    out.push({ ...z, firma: z.firma.slice(0, 200), titel: z.titel.slice(0, 200), text: z.text.slice(0, 600) });
    if (out.length >= MAX_MELDUNGEN) break;
  }
  return out;
}

interface Konto { actorId: string; email: string; vorname: string | null; token: string; appZuletztAt: Date | null; letzterVersand: Date | null }

/** Wer koennte eine Mail bekommen: bestaetigt, nicht abgemeldet, mit letzter Mail und letzter App-Anfrage. */
async function konten(): Promise<Konto[]> {
  const r = await getGatewayPool().query<Konto>(
    `SELECT m."actorId", m.email, m.vorname, m.token, a."appZuletztAt",
            (SELECT max(v."createdAt") FROM "MailVersand" v
              WHERE v."actorId" = m."actorId" AND v.art = 'neuigkeiten' AND v.status = 'gesendet') AS "letzterVersand"
       FROM "MailEinstellung" m
       LEFT JOIN "NutzerAktivitaet" a ON a."actorId" = m."actorId"
      WHERE m.neuigkeiten AND m."abgemeldetAt" IS NULL
      ORDER BY m."actorId"`,
  );
  return r.rows;
}

/** Firmen des Nutzers laut master-data, ohne vom Nutzer geloeschte. */
async function firmenDesNutzers(actorId: string): Promise<string[]> {
  const r = await masterData<{ rows: Array<{ companyId: string }> }>("POST", "/internal/transactions/companies-by-users", { userIds: [actorId] });
  const ids = [...new Set((r.rows ?? []).map((x) => x.companyId).filter(Boolean))];
  if (ids.length === 0) return [];
  const weg = await tombstonedSubset(getGatewayPool(), actorId, ids).catch(() => new Set<string>());
  return ids.filter((id) => !weg.has(id)).slice(0, MAX_FIRMEN);
}

/** Je Konto hoechstens einmal am Tag sammeln, auch wenn nichts zu melden war. */
const geprueftAm = new Map<string, string>();

export async function runNeuigkeitenCronOnce(jetzt: Date = new Date()): Promise<{ geprueft: number; gesendet: number }> {
  const erg = { geprueft: 0, gesendet: 0 };
  if (!versandBereit()) return erg;
  const tag = jetzt.toISOString().slice(0, 10);
  const env = loadEnv();
  const pool = getGatewayPool();
  let liste: Konto[];
  try {
    liste = await konten();
  } catch (err) {
    logger.warn({ err: fehlertext(err) }, "[neuigkeiten-cron] Konten nicht lesbar");
    return erg;
  }
  for (const k of liste) {
    const e = cronEntscheidung({ jetzt, letzterVersand: k.letzterVersand ? new Date(k.letzterVersand) : null, appZuletztAt: k.appZuletztAt ? new Date(k.appZuletztAt) : null });
    if (!e.senden) continue;
    if (geprueftAm.get(k.actorId) === tag) continue;
    geprueftAm.set(k.actorId, tag);
    erg.geprueft += 1;
    try {
      const ids = await firmenDesNutzers(k.actorId);
      if (ids.length === 0) continue;
      const seit = k.letzterVersand ? new Date(k.letzterVersand) : new Date(jetzt.getTime() - ERSTES_FENSTER_MS);
      const { items } = await sammleNeuheiten(ids, seit.toISOString(), k.actorId);
      const namen = await resolveCompanyNames(pool, items.map((i) => i.companyId));
      const meldungen = neuheitenZuMeldungen(items, namen);
      if (meldungen.length === 0) {
        logger.info({ actorId: k.actorId, firmen: ids.length }, "[neuigkeiten-cron] nichts Neues");
        continue;
      }
      const konto: MailKonto = { actorId: k.actorId, email: k.email, vorname: k.vorname, token: k.token, neuigkeiten: true, abgemeldet: false };
      const r = await mailSenden(pool, konto, "neuigkeiten", neuigkeitenMail({ vorname: k.vorname, meldungen, appBasis: env.AVA_APP_URL, abmeldenUrl: linkAdressen(k.token).abmelden }));
      if (r.ok) erg.gesendet += 1;
      logger.info({ actorId: k.actorId, firmen: ids.length, meldungen: meldungen.length, gesendet: r.ok, grund: r.grund }, "[neuigkeiten-cron] Mail");
    } catch (err) {
      logger.warn({ actorId: k.actorId, err: fehlertext(err) }, "[neuigkeiten-cron] Konto uebersprungen");
    }
  }
  if (geprueftAm.size > 50_000) geprueftAm.clear();
  return erg;
}

let timer: NodeJS.Timeout | null = null;

export function startNeuigkeitenCron(): void {
  if (process.env.NEUIGKEITEN_CRON_DISABLED === "1") {
    logger.info("[neuigkeiten-cron] abgeschaltet (NEUIGKEITEN_CRON_DISABLED=1)");
    return;
  }
  if (timer) return;
  const tick = () => { void runNeuigkeitenCronOnce().catch((err) => logger.warn({ err: fehlertext(err) }, "[neuigkeiten-cron] Lauf fehlgeschlagen")); };
  timer = setInterval(tick, TAKT_MS);
  timer.unref?.();
  // Erster Lauf kurz nach dem Start, damit ein Neustart im Fenster keinen Tag auslaesst.
  setTimeout(tick, 2 * 60_000).unref?.();
  logger.info({ taktMinuten: TAKT_MS / 60_000, fenster: `${FENSTER.von}-${FENSTER.bis} Uhr Europe/Berlin` }, "[neuigkeiten-cron] gestartet");
}

export function stopNeuigkeitenCron(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function fehlertext(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
