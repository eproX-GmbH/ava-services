// Firmensuche mit Filter auf das Gruendungsjahr.
//
// Das Gruendungsjahr steht nicht im Firmenbestand (master-data), sondern im
// strukturierten Registerinhalt (Datenbank structured-content, Tabelle
// StructuredContent, Spalte foundingYear). Der Bestand hat 5,2 Mio Firmen, den
// strukturierten Inhalt haben rund 38.000 davon. Deshalb laeuft die Abfrage
// genau andersherum als die normale Suche:
//
//   1. Seite in structured-content bestimmen (Filter, Sortierung, Blaettern) —
//      kleine Tabelle, alles in einer Datenbank, Paginierung bleibt korrekt.
//   2. Die hoechstens 200 Ids der Seite in master-data anreichern
//      (/internal/companies/by-ids) fuer Name, Sitz, Status und Land.
//
// Der Namensfilter greift dabei auf den Namen im Registerauszug, nicht auf den
// Bestandsnamen; bei einer Umfirmierung kann er also aelter sein. Das ist der
// Preis dafuer, dass Filter und Blaettern in einer Datenbank bleiben.

import { getProducerPool } from "./producer-pools";
import { masterData } from "./register-jobs";

export type GruendungsSortierung = "gruendung_auf" | "gruendung_ab";

export type GruendungsAbfrage = {
  von?: number;
  bis?: number;
  sortierung?: GruendungsSortierung;
  /** Namensteil; sucht im Namen des Registerauszugs. */
  suche?: string;
  country?: "DE" | "AT" | "CH" | "UK";
  page: number;
  pageSize: number;
};

export type FirmaMitGruendung = Record<string, unknown> & { companyId: string; foundingYear: number | null };

/** Ist einer der Gruendungsjahr-Parameter gesetzt? Nur dann laeuft dieser Weg. */
export function gruendungsFilterAktiv(a: { von?: number; bis?: number; sortierung?: string }): boolean {
  return a.von !== undefined || a.bis !== undefined || a.sortierung !== undefined;
}

/**
 * Landfilter ueber das Praefix der companyId. Die Id ist deterministisch
 * (lib/register-ids.ts): Oesterreich AT_FN…, UK UK_…, Schweiz CH_…, alles
 * andere ist deutsch. Ein deutsches Gericht wie Attendorn beginnt zwar mit
 * "AT", nie aber mit "AT_", deshalb ist das Praefix eindeutig.
 */
function landBedingung(country: string | undefined, werte: unknown[]): string {
  if (!country) return "TRUE";
  if (country === "DE") return `"companyId" NOT LIKE 'AT\\_%' AND "companyId" NOT LIKE 'UK\\_%' AND "companyId" NOT LIKE 'CH\\_%'`;
  werte.push(`${country}\\_%`);
  return `"companyId" LIKE $${werte.length}`;
}

export async function firmenNachGruendungsjahr(a: GruendungsAbfrage): Promise<{ items: FirmaMitGruendung[]; total: number }> {
  const werte: unknown[] = [];
  const teile: string[] = [`"foundingYear" IS NOT NULL`];
  if (a.von !== undefined) {
    werte.push(a.von);
    teile.push(`"foundingYear" >= $${werte.length}`);
  }
  if (a.bis !== undefined) {
    werte.push(a.bis);
    teile.push(`"foundingYear" <= $${werte.length}`);
  }
  const suche = a.suche?.trim();
  if (suche) {
    werte.push(`%${suche.replace(/[%_]/g, (z) => `\\${z}`)}%`);
    teile.push(`name ILIKE $${werte.length}`);
  }
  teile.push(landBedingung(a.country, werte));
  const wo = teile.join(" AND ");

  const pool = getProducerPool("structured-content");
  const anzahl = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "StructuredContent" WHERE ${wo}`, werte);
  const total = Number(anzahl.rows[0]?.count ?? 0);
  if (total === 0) return { items: [], total: 0 };

  // Absteigend ist die Voreinstellung fuer "die juengsten zuerst"; ohne Angabe
  // sortiert die Seite aufsteigend nach Jahr, damit das Blaettern stabil ist.
  const richtung = a.sortierung === "gruendung_ab" ? "DESC" : "ASC";
  const grenzen = [...werte, a.pageSize, Math.max(0, (a.page - 1) * a.pageSize)];
  const seite = await pool.query<{ companyId: string; foundingYear: number }>(
    `SELECT "companyId", "foundingYear" FROM "StructuredContent"
      WHERE ${wo}
      ORDER BY "foundingYear" ${richtung}, name ASC, "companyId" ASC
      LIMIT $${werte.length + 1} OFFSET $${werte.length + 2}`,
    grenzen,
  );
  const ids = seite.rows.map((r) => r.companyId);
  if (ids.length === 0) return { items: [], total };

  const jahrJeId = new Map(seite.rows.map((r) => [r.companyId, r.foundingYear]));
  let bestand: Array<Record<string, unknown> & { companyId: string }> = [];
  try {
    const antwort = await masterData<{ germanCompanies?: Array<Record<string, unknown> & { companyId: string }> }>("POST", "/internal/companies/by-ids", { companyIds: ids });
    bestand = antwort.germanCompanies ?? [];
  } catch {
    // Bestand nicht erreichbar: lieber die Ids mit Jahr zeigen als gar nichts.
    bestand = [];
  }
  const bestandJeId = new Map(bestand.map((c) => [c.companyId, c]));

  // Reihenfolge der Seite kommt aus der Sortierung, nicht aus der Anreicherung.
  const items = seite.rows.map((r) => {
    const c = bestandJeId.get(r.companyId);
    return {
      ...(c ?? { companyId: r.companyId, name: r.companyId, createdAt: new Date(0).toISOString() }),
      companyId: r.companyId,
      foundingYear: jahrJeId.get(r.companyId) ?? null,
    } as FirmaMitGruendung;
  });
  return { items, total };
}
