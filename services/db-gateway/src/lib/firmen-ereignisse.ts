// Firmenhistorie (docs/PLAN_FIRMEN_HISTORIE.md, H1): Personal- und Geschaeftsfuehrungswechsel
// einer Firmenliste aus den zentralen Daten, nicht aus den (lokalen, persoenlichen) Meldungen.
//
// Quellen:
//   Kontakt-DB   Employment (eine Zeile je Person und Firma) → „neu“ und „verlassen“
//                SignalEvent PERSON_JOB_CHANGED                → „wechsel“ (nur echte, s. u.)
//   Gateway-DB   ProfileChangeEvent managing-directors*        → „geschaeftsfuehrung“
//
// Regeln (H0, an 4.291 Titeln und 1.776 Titelaenderungen geprueft, 2026-11-19):
//   * Umformulierungen sind kein Wechsel: nur Wechsel von Rollengruppe oder Ebene, und nur wenn
//     beide Titel sicher eingeordnet sind (rollengruppe.ts). 161 von 1.776 bleiben.
//   * Hin und zurueck innerhalb von 120 Tagen (Quellen widersprechen sich) zaehlt gar nicht.
//   * Zeitpunkt laut Profil (startDate/endDate) vor „erstmals/zuletzt gesehen“, immer gekennzeichnet.
//     Ohne Profildatum ist „neu“ nur, wer nach dem ersten Abruf der Firma auftaucht (Erst-Crawl
//     ist nie ein Ereignis).

import { getGatewayPool, getProducerPool } from "./producer-pools";
import { gfDiffBereinigen } from "./stammdaten-vergleich";
import { echterRollenwechsel, pendelEntfernen, rolleEinordnen, type Ebene, type Rollengruppe } from "./rollengruppe";

export { pendelEntfernen };

export type EreignisArt = "neu" | "verlassen" | "wechsel" | "geschaeftsfuehrung";
export type ZeitpunktArt = "laut_profil" | "erstmals_gesehen" | "festgestellt" | "register";

export interface FirmenEreignis {
  id: string;
  art: EreignisArt;
  companyId: string;
  firma: string | null;
  personId: string | null;
  person: string | null;
  /** Titel vorher (nur „wechsel“ und „verlassen“) und nachher. */
  rolleVorher: string | null;
  rolle: string | null;
  gruppe: Rollengruppe;
  ebene: Ebene;
  gruppeVorher: Rollengruppe | null;
  ebeneVorher: Ebene | null;
  zeitpunkt: string;
  zeitpunktArt: ZeitpunktArt;
  quelle: string | null;
  url: string | null;
  /** Nur „geschaeftsfuehrung“: Namen laut Register/Abschluss. */
  neuBestellt?: string[];
  ausgeschieden?: string[];
}

export interface EreignisAbfrage {
  companyIds: string[];
  seit?: Date | null;
  bis?: Date | null;
  arten?: EreignisArt[] | null;
  gruppen?: Rollengruppe[] | null;
  ebene?: Ebene | null;
  limit?: number;
  /** Nur Ereignisse dieser Personen (anonymes Mitzaehlen vor dem Loeschen, fluktuation.ts). */
  personIds?: string[] | null;
  /** Ohne Obergrenze (nur intern: Kennzahl, Loeschung). */
  ohneLimit?: boolean;
}

const TAG = 86_400_000;

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function quelleText(source: string | null | undefined): string | null {
  if (!source) return null;
  if (/linkedin|apify/i.test(source)) return "LinkedIn";
  if (/website|impressum|team/i.test(source)) return "Website";
  if (/serp|search|google/i.test(source)) return "Websuche";
  return source;
}

export async function firmenEreignisse(q: EreignisAbfrage): Promise<FirmenEreignis[]> {
  const ids = [...new Set(q.companyIds.filter(Boolean))].slice(0, 1000);
  if (ids.length === 0) return [];
  const arten = new Set<EreignisArt>(q.arten && q.arten.length > 0 ? q.arten : ["neu", "verlassen", "wechsel", "geschaeftsfuehrung"]);
  const gruppen = q.gruppen && q.gruppen.length > 0 ? new Set(q.gruppen) : null;
  const seit = q.seit ? q.seit.getTime() : -Infinity;
  const bis = q.bis ? q.bis.getTime() : Infinity;
  const kontakt = getProducerPool("company-contact");
  const out: FirmenEreignis[] = [];

  const namen = new Map<string, string | null>();
  const n = await kontakt.query<{ id: string; name: string | null }>(`SELECT id, name FROM "Company" WHERE id = ANY($1::text[])`, [ids]);
  for (const r of n.rows) namen.set(r.id, r.name);

  const zeilenWechsel: FirmenEreignis[] = [];
  if (arten.has("neu") || arten.has("verlassen") || arten.has("wechsel")) {
    const r = await kontakt.query<{
      id: string; companyId: string; personId: string; fullName: string | null; title: string | null; isCurrent: boolean;
      startDate: Date | null; endDate: Date | null; firstSeen: Date; lastSeen: Date; ab: Date; url: string | null; source: string | null;
    }>(
      // ab = erster Abruf der Firma DURCH DIE QUELLE, die die Person zuerst gesehen hat: Kommt
      // eine Quelle neu hinzu (LinkedIn-Mitarbeiterliste nach der Website), ist ihr erster Fund
      // Bestand, kein Neuzugang.
      `WITH quellen AS (
         SELECT s."employmentId", s.source, s."observedAt", e2."companyId"
           FROM "EmploymentSource" s JOIN "Employment" e2 ON e2.id = s."employmentId"
          WHERE e2."companyId" = ANY($1::text[])
       ), bestand AS (
         SELECT "companyId", source, min("observedAt") AS ab FROM quellen GROUP BY 1, 2
       ), firma AS (
         SELECT "companyId", min("firstSeen") AS ab FROM "Employment" WHERE "companyId" = ANY($1::text[]) GROUP BY 1
       )
       SELECT e.id, e."companyId", e."personId", p."fullName", e.title, e."isCurrent", e."startDate", e."endDate",
              e."firstSeen", e."lastSeen", greatest(f.ab, coalesce(b.ab, f.ab)) AS ab, q.url, q.source
         FROM "Employment" e
         JOIN firma f ON f."companyId" = e."companyId"
         LEFT JOIN "Person" p ON p.id = e."personId"
         LEFT JOIN LATERAL (
           SELECT s.url, s.source FROM "EmploymentSource" s WHERE s."employmentId" = e.id
            ORDER BY (s.url IS NULL), s."observedAt" DESC LIMIT 1
         ) q ON TRUE
         LEFT JOIN LATERAL (
           SELECT s.source FROM "EmploymentSource" s WHERE s."employmentId" = e.id ORDER BY s."observedAt" ASC LIMIT 1
         ) erst ON TRUE
         LEFT JOIN bestand b ON b."companyId" = e."companyId" AND b.source = erst.source
        WHERE e."companyId" = ANY($1::text[])`,
      [ids],
    );
    // Je Person und Firma die Zeilen in zeitlicher Reihenfolge: Eine Titelaenderung schliesst die
    // alte Zeile (endDate = Verarbeitungszeitpunkt, NICHT laut Profil) und legt eine neue an. Die
    // erste Zeile ist „neu“, jede weitere ein moeglicher Wechsel; „verlassen“ nur, wenn keine
    // aktuelle Zeile mehr da ist.
    const jePaar = new Map<string, typeof r.rows>();
    for (const e of r.rows) jePaar.set(`${e.personId}|${e.companyId}`, [...(jePaar.get(`${e.personId}|${e.companyId}`) ?? []), e]);
    for (const reihe of jePaar.values()) {
      reihe.sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime());
      const erste = reihe[0]!;
      const letzte = reihe[reihe.length - 1]!;
      // Kurzlebige Zuordnung (binnen 30 Tagen auf- und wieder zugeklappt, ohne Profildatum) ist
      // eine korrigierte Fehlzuordnung zur falschen Firma, weder Neuzugang noch Abgang.
      const geschlossen = !reihe.some((e) => e.isCurrent);
      if (geschlossen && !erste.startDate && (letzte.endDate ?? letzte.lastSeen).getTime() - erste.firstSeen.getTime() < 30 * TAG) continue;
      const basis = (e: (typeof reihe)[number]) => ({ companyId: e.companyId, firma: namen.get(e.companyId) ?? null, personId: e.personId, person: e.fullName, quelle: quelleText(e.source), url: e.url });
      if (arten.has("neu")) {
        const rolle = rolleEinordnen(erste.title);
        // Profil-Startdatum zaehlt immer (Historie); ohne es nur, wer nach dem Erst-Abruf auftauchte.
        const zeit = erste.startDate ?? (erste.firstSeen.getTime() > erste.ab.getTime() + 2 * TAG ? erste.firstSeen : null);
        if (zeit && rolle.gruppe !== "sonstige") out.push({ ...basis(erste), id: `neu:${erste.id}`, art: "neu", rolleVorher: null, rolle: erste.title, gruppe: rolle.gruppe, ebene: rolle.ebene, gruppeVorher: null, ebeneVorher: null, zeitpunkt: iso(zeit)!, zeitpunktArt: erste.startDate ? "laut_profil" : "erstmals_gesehen" });
      }
      for (let i = 1; i < reihe.length; i++) {
        const vorher = reihe[i - 1]!;
        const jetzt = reihe[i]!;
        if (!echterRollenwechsel(vorher.title, jetzt.title)) continue;
        const a = rolleEinordnen(vorher.title);
        const b = rolleEinordnen(jetzt.title);
        const zeit = jetzt.startDate ?? jetzt.firstSeen;
        zeilenWechsel.push({ ...basis(jetzt), id: `wechsel:${jetzt.id}`, art: "wechsel", rolleVorher: vorher.title, rolle: jetzt.title, gruppe: b.gruppe, ebene: b.ebene, gruppeVorher: a.gruppe, ebeneVorher: a.ebene, zeitpunkt: iso(zeit)!, zeitpunktArt: jetzt.startDate ? "laut_profil" : "erstmals_gesehen" });
      }
      if (arten.has("verlassen") && geschlossen) {
        const rolle = rolleEinordnen(letzte.title);
        if (rolle.gruppe !== "sonstige") out.push({ ...basis(letzte), id: `verlassen:${letzte.id}`, art: "verlassen", rolleVorher: letzte.title, rolle: null, gruppe: rolle.gruppe, ebene: rolle.ebene, gruppeVorher: rolle.gruppe, ebeneVorher: rolle.ebene, zeitpunkt: iso(letzte.endDate ?? letzte.lastSeen)!, zeitpunktArt: "festgestellt" });
      }
    }
  }

  if (arten.has("wechsel")) {
    const r = await kontakt.query<{ id: string; companyId: string; personId: string | null; fullName: string | null; before: string | null; after: string | null; observedAt: Date; evidenceUrl: string | null; source: string | null }>(
      `SELECT s.id, s."companyId", s."personId", p."fullName", s.before, s.after, s."observedAt", s."evidenceUrl", s.source
         FROM "SignalEvent" s LEFT JOIN "Person" p ON p.id = s."personId"
        WHERE s.type = 'PERSON_JOB_CHANGED' AND s."companyId" = ANY($1::text[])`,
      [ids],
    );
    const wechsel: FirmenEreignis[] = [];
    for (const s of r.rows) {
      if (!echterRollenwechsel(s.before, s.after)) continue;
      const v = rolleEinordnen(s.before);
      const n2 = rolleEinordnen(s.after);
      wechsel.push({
        id: `wechsel:${s.id}`, art: "wechsel", companyId: s.companyId, firma: namen.get(s.companyId) ?? null, personId: s.personId, person: s.fullName,
        rolleVorher: s.before, rolle: s.after, gruppe: n2.gruppe, ebene: n2.ebene, gruppeVorher: v.gruppe, ebeneVorher: v.ebene,
        zeitpunkt: iso(s.observedAt)!, zeitpunktArt: "erstmals_gesehen", quelle: quelleText(s.source), url: s.evidenceUrl,
      });
    }
    // Dieselbe Befoerderung steht oft in beiden Quellen: Zeilen-Wechsel (mit Profildatum) zuerst,
    // Signal nur, wenn fuer Person, Firma und Zielrolle binnen 180 Tagen keiner da ist.
    const doppelt = (s: FirmenEreignis) =>
      zeilenWechsel.some((z) => z.personId === s.personId && z.companyId === s.companyId && z.gruppe === s.gruppe && z.ebene === s.ebene && Math.abs(Date.parse(z.zeitpunkt) - Date.parse(s.zeitpunkt)) < 180 * TAG);
    // Gleicher Wechsel mehrfach (zwei Signale, oder Signal und Zeile mit anderem Datum): einer
    // je Person, Firma und Rollenpaar, bevorzugt mit Profildatum, sonst der frueheste.
    const einmal = new Map<string, FirmenEreignis>();
    for (const e of pendelEntfernen([...zeilenWechsel, ...wechsel.filter((s) => !doppelt(s))])) {
      const k = `${e.personId ?? e.id}|${e.companyId}|${e.gruppeVorher}|${e.ebeneVorher}|${e.gruppe}|${e.ebene}`;
      const da = einmal.get(k);
      const besser = !da || (e.zeitpunktArt === "laut_profil" && da.zeitpunktArt !== "laut_profil") || (e.zeitpunktArt === da.zeitpunktArt && e.zeitpunkt < da.zeitpunkt);
      if (besser) einmal.set(k, e);
    }
    out.push(...einmal.values());
  }

  if (arten.has("geschaeftsfuehrung")) {
    const g = getGatewayPool();
    const r = await g
      .query<{ id: string; companyId: string; kind: string; added: Array<{ firstName?: string; lastName?: string }>; removed: Array<{ firstName?: string; lastName?: string }>; createdAt: Date }>(
        `SELECT id, "companyId", kind, added, removed, "createdAt" FROM "ProfileChangeEvent"
          WHERE "companyId" = ANY($1::text[]) AND kind LIKE 'managing-directors%'`,
        [ids],
      )
      .catch(() => ({ rows: [] }));
    const name = (d: { firstName?: string; lastName?: string }) => [d.firstName, d.lastName].filter(Boolean).join(" ").trim();
    for (const e of r.rows) {
      // Schein-Wechsel (gleiche Person anders geschrieben, Registergericht als Person) raus.
      const d = gfDiffBereinigen(Array.isArray(e.added) ? e.added : [], Array.isArray(e.removed) ? e.removed : []);
      const neuB = d.added.map(name).filter(Boolean);
      const weg = d.removed.map(name).filter(Boolean);
      if (neuB.length === 0 && weg.length === 0) continue;
      out.push({
        id: `gf:${e.id}`, art: "geschaeftsfuehrung", companyId: e.companyId, firma: namen.get(e.companyId) ?? null, personId: null, person: null,
        rolleVorher: null, rolle: null, gruppe: "geschaeftsfuehrung", ebene: "leitung", gruppeVorher: null, ebeneVorher: null,
        zeitpunkt: iso(e.createdAt)!, zeitpunktArt: "register", quelle: e.kind.includes("konzernabschluss") ? "Konzernabschluss" : "Registerangaben", url: null,
        neuBestellt: neuB, ausgeschieden: weg,
      });
    }
  }

  // Schub: Liest eine Quelle eine Firma auf einmal vollstaendiger (neue Teamseite, laengere
  // Mitarbeiterliste), tauchen viele Personen am selben Tag erstmals auf. Ab 3 am selben Tag aus
  // derselben Quelle ist das Bestand, kein Neuzugang (H1-Probe: 5 „neue“ GF bei einer Firma).
  const schub = new Map<string, number>();
  const schubKey = (e: FirmenEreignis) => `${e.companyId}|${e.quelle ?? ""}|${e.zeitpunkt.slice(0, 10)}`;
  for (const e of out) if (e.art === "neu" && e.zeitpunktArt === "erstmals_gesehen") schub.set(schubKey(e), (schub.get(schubKey(e)) ?? 0) + 1);
  const ohneSchub = out.filter((e) => !(e.art === "neu" && e.zeitpunktArt === "erstmals_gesehen" && (schub.get(schubKey(e)) ?? 0) >= 3));

  const nurPersonen = q.personIds && q.personIds.length > 0 ? new Set(q.personIds) : null;
  const gefiltert = ohneSchub.filter((e) => {
    if (nurPersonen && !(e.personId && nurPersonen.has(e.personId))) return false;
    const t = Date.parse(e.zeitpunkt);
    if (!(t >= seit && t <= bis)) return false;
    if (gruppen && !gruppen.has(e.gruppe) && !(e.gruppeVorher && gruppen.has(e.gruppeVorher))) return false;
    if (q.ebene && e.ebene !== q.ebene && e.ebeneVorher !== q.ebene) return false;
    return true;
  });
  gefiltert.sort((a, b) => b.zeitpunkt.localeCompare(a.zeitpunkt));
  return q.ohneLimit ? gefiltert : gefiltert.slice(0, Math.max(1, Math.min(500, q.limit ?? 100)));
}
