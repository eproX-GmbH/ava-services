// Vorabanalyse (docs/PLAN_VORABANALYSE.md) — Ablage: Laeufe, Firmen, Ereignisse.
// Eigenstaendiges Betreiber-Werkzeug, keine Verbindung zu Transaktionen/Bestand.

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { crmNameBereinigen } from "./namen";

export type LaufStatus = "neu" | "icp" | "abgleich" | "zuordnung" | "website" | "profil" | "urteil" | "fertig" | "pausiert" | "abgebrochen" | "fehler";
export const SCHRITTE = ["datei", "icp", "abgleich", "zuordnung", "website", "profil", "urteil", "ergebnis"] as const;

export interface Einstellungen {
  mindestScore: number;
  judgeKonfidenz: number;
  budgetUsd: number;
  bestMatchMindestScore: number;
  parallelWebsite: number;
  parallelProfil: number;
}
export const STANDARD: Einstellungen = { mindestScore: 60, judgeKonfidenz: 0.7, budgetUsd: 150, bestMatchMindestScore: 0.8, parallelWebsite: 3, parallelProfil: 10 };

export interface Lauf {
  id: string;
  kundeName: string;
  erstelltVon: string;
  status: LaufStatus;
  icp: Record<string, unknown> | null;
  einstellungen: Einstellungen;
  zaehler: Record<string, number>;
  spalten: Record<string, string> | null;
  dateiName: string | null;
  notiz: string | null;
  gestartetAt: string | null;
  beendetAt: string | null;
  createdAt: string;
  updatedAt: string;
  firmen: number;
}

const COLS = `"id", "kundeName", "erstelltVon", "status", "icp", "einstellungen", "zaehler", "spalten", "dateiName", "notiz", "gestartetAt", "beendetAt", "createdAt", "updatedAt",
  (SELECT COUNT(*) FROM "VorabFirma" f WHERE f."laufId" = "VorabLauf"."id")::int AS firmen`;

function mapLauf(r: Record<string, unknown>): Lauf {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  return {
    id: String(r.id), kundeName: String(r.kundeName), erstelltVon: String(r.erstelltVon), status: r.status as LaufStatus,
    icp: (r.icp as Record<string, unknown> | null) ?? null,
    einstellungen: { ...STANDARD, ...((r.einstellungen as Partial<Einstellungen>) ?? {}) },
    zaehler: (r.zaehler as Record<string, number>) ?? {},
    spalten: (r.spalten as Record<string, string> | null) ?? null,
    dateiName: (r.dateiName as string | null) ?? null, notiz: (r.notiz as string | null) ?? null,
    gestartetAt: iso(r.gestartetAt), beendetAt: iso(r.beendetAt), createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!,
    firmen: Number(r.firmen ?? 0),
  };
}

export async function laufAnlegen(pool: Pool, e: { kundeName: string; erstelltVon: string; notiz?: string | null; einstellungen?: Partial<Einstellungen> }): Promise<Lauf> {
  const id = `va_${randomBytes(8).toString("base64url")}`;
  const r = await pool.query(
    `INSERT INTO "VorabLauf" ("id", "kundeName", "erstelltVon", "notiz", "einstellungen") VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${COLS}`,
    [id, e.kundeName, e.erstelltVon, e.notiz ?? null, JSON.stringify({ ...STANDARD, ...(e.einstellungen ?? {}) })],
  );
  await ereignis(pool, id, "datei", "info", `Lauf angelegt für ${e.kundeName}.`);
  return mapLauf(r.rows[0]!);
}

export async function laufListe(pool: Pool): Promise<Lauf[]> {
  const r = await pool.query(`SELECT ${COLS} FROM "VorabLauf" WHERE "deletedAt" IS NULL ORDER BY "createdAt" DESC`);
  return r.rows.map(mapLauf);
}

export async function laufLesen(pool: Pool, id: string): Promise<Lauf | null> {
  const r = await pool.query(`SELECT ${COLS} FROM "VorabLauf" WHERE "id" = $1 AND "deletedAt" IS NULL`, [id]);
  return r.rows[0] ? mapLauf(r.rows[0]) : null;
}

export async function laufAendern(pool: Pool, id: string, patch: { kundeName?: string; notiz?: string | null; einstellungen?: Partial<Einstellungen>; icp?: Record<string, unknown> | null; status?: LaufStatus; spalten?: Record<string, string> | null; dateiName?: string | null }): Promise<Lauf | null> {
  const alt = await laufLesen(pool, id);
  if (!alt) return null;
  const r = await pool.query(
    `UPDATE "VorabLauf" SET "kundeName" = $2, "notiz" = $3, "einstellungen" = $4::jsonb, "icp" = $5::jsonb, "status" = $6, "spalten" = $7::jsonb, "dateiName" = $8, "updatedAt" = NOW() WHERE "id" = $1 RETURNING ${COLS}`,
    [
      id, patch.kundeName ?? alt.kundeName, patch.notiz === undefined ? alt.notiz : patch.notiz,
      JSON.stringify({ ...alt.einstellungen, ...(patch.einstellungen ?? {}) }),
      patch.icp === undefined ? (alt.icp ? JSON.stringify(alt.icp) : null) : patch.icp ? JSON.stringify(patch.icp) : null,
      patch.status ?? alt.status,
      patch.spalten === undefined ? (alt.spalten ? JSON.stringify(alt.spalten) : null) : patch.spalten ? JSON.stringify(patch.spalten) : null,
      patch.dateiName === undefined ? alt.dateiName : patch.dateiName,
    ],
  );
  return mapLauf(r.rows[0]!);
}

export async function laufLoeschen(pool: Pool, id: string): Promise<boolean> {
  const r = await pool.query(`UPDATE "VorabLauf" SET "deletedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = $1 AND "deletedAt" IS NULL`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function ereignis(pool: Pool, laufId: string, schritt: string, art: "info" | "fehler" | "fortschritt", text: string, daten?: unknown): Promise<void> {
  await pool.query(`INSERT INTO "VorabEreignis" ("laufId", "schritt", "art", "text", "daten") VALUES ($1, $2, $3, $4, $5::jsonb)`, [laufId, schritt, art, text, daten == null ? null : JSON.stringify(daten)]).catch(() => undefined);
}

export async function ereignisse(pool: Pool, laufId: string, limit = 200): Promise<Array<{ id: number; zeit: string; schritt: string; art: string; text: string; daten: unknown }>> {
  const r = await pool.query<{ id: string; zeit: Date; schritt: string; art: string; text: string; daten: unknown }>(
    `SELECT "id", "zeit", "schritt", "art", "text", "daten" FROM "VorabEreignis" WHERE "laufId" = $1 ORDER BY "zeit" DESC, "id" DESC LIMIT $2`, [laufId, limit]);
  return r.rows.map((x) => ({ id: Number(x.id), zeit: new Date(x.zeit).toISOString(), schritt: x.schritt, art: x.art, text: x.text, daten: x.daten }));
}

// ---- Firmen ---------------------------------------------------------------

export interface FirmaZeile {
  name: string;
  ort?: string | null;
  plz?: string | null;
  strasse?: string | null;
  land?: string | null;
  eingabe?: Record<string, unknown> | null;
}

export function normalisiert(name: string, ort: string | null | undefined): string {
  const n = name.toLowerCase().replace(/\b(gmbh|ag|kg|ohg|ug|e\.?\s?k\.?|mbh|co\.?|&|und|se|gbr|haftungsbeschränkt|limited|ltd)\b/g, " ").replace(/[^a-z0-9äöüß]+/g, " ").trim();
  const o = (ort ?? "").toLowerCase().replace(/[^a-z0-9äöüß]+/g, " ").trim();
  return `${n}|${o}`;
}

/** Zeilen anfuegen (Pakete); Duplikate (Name+Ort normalisiert) innerhalb des Laufs markieren. */
export async function firmenEinfuegen(pool: Pool, laufId: string, zeilen: FirmaZeile[], startZeile: number): Promise<{ eingefuegt: number; duplikate: number }> {
  if (zeilen.length === 0) return { eingefuegt: 0, duplikate: 0 };
  const vorhandene = await pool.query<{ id: string; name: string; ort: string | null }>(`SELECT "id", "name", "ort" FROM "VorabFirma" WHERE "laufId" = $1 AND "duplikatVon" IS NULL`, [laufId]);
  const schluessel = new Map<string, number>();
  for (const v of vorhandene.rows) schluessel.set(normalisiert(v.name, v.ort), Number(v.id));
  let duplikate = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < zeilen.length; i++) {
      const z = zeilen[i]!;
      // Name bereinigt speichern (Buchhaltungszusaetze raus), Original bleibt in "eingabe".
      z.name = crmNameBereinigen(z.name);
      const k = normalisiert(z.name, z.ort);
      const dup = schluessel.get(k) ?? null;
      const r = await client.query<{ id: string }>(
        `INSERT INTO "VorabFirma" ("laufId", "zeile", "name", "ort", "plz", "strasse", "land", "eingabe", "duplikatVon", "schritt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING "id"`,
        [laufId, startZeile + i, z.name.trim(), z.ort?.trim() || null, z.plz?.trim() || null, z.strasse?.trim() || null, z.land?.trim() || null, z.eingabe ? JSON.stringify(z.eingabe) : null, dup, dup ? "duplikat" : "eingelesen"],
      );
      if (dup) duplikate++;
      else schluessel.set(k, Number(r.rows[0]!.id));
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { eingefuegt: zeilen.length - duplikate, duplikate };
}

export async function firmenLeeren(pool: Pool, laufId: string): Promise<void> {
  await pool.query(`DELETE FROM "VorabFirma" WHERE "laufId" = $1`, [laufId]);
}

export interface Firma {
  id: number; zeile: number; name: string; ort: string | null; plz: string | null; strasse: string | null; land: string | null;
  eingabe: Record<string, unknown> | null; duplikatVon: number | null; abgleich: string | null; kandidaten: unknown; companyId: string | null;
  zuordnung: string; website: string | null; websiteKandidaten: unknown; websiteUrteil: unknown; profil: unknown; icpUrteil: unknown; schritt: string; fehler: string | null;
}

export async function firmenListe(pool: Pool, laufId: string, q: { filter?: string; suche?: string; seite?: number; groesse?: number }): Promise<{ items: Firma[]; gesamt: number }> {
  const groesse = Math.min(500, Math.max(1, q.groesse ?? 100));
  const seite = Math.max(1, q.seite ?? 1);
  const bed: string[] = [`"laufId" = $1`];
  const params: unknown[] = [laufId];
  switch (q.filter) {
    case "unsicher": bed.push(`"abgleich" = 'unsicher' AND "zuordnung" = 'offen'`); break;
    case "treffer": bed.push(`"abgleich" = 'treffer'`); break;
    case "keiner": bed.push(`"abgleich" = 'keiner'`); break;
    case "duplikate": bed.push(`"duplikatVon" IS NOT NULL`); break;
    case "fehler": bed.push(`"fehler" IS NOT NULL`); break;
    case "ohne-website": bed.push(`"schritt" IN ('website') AND "website" IS NULL`); break;
    case "ready": bed.push(`("icpUrteil"->>'passt')::boolean = true`); break;
    case "ausgeschlossen": bed.push(`("zuordnung" = 'ausgeschlossen' OR ("icpUrteil"->>'passt')::boolean = false)`); break;
    default: break;
  }
  if (q.suche?.trim()) {
    params.push(`%${q.suche.trim()}%`);
    bed.push(`("name" ILIKE $${params.length} OR "ort" ILIKE $${params.length})`);
  }
  const where = bed.join(" AND ");
  const gesamt = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "VorabFirma" WHERE ${where}`, params);
  params.push(groesse, (seite - 1) * groesse);
  const r = await pool.query(
    `SELECT "id", "zeile", "name", "ort", "plz", "strasse", "land", "eingabe", "duplikatVon", "abgleich", "kandidaten", "companyId", "zuordnung", "website", "websiteKandidaten", "websiteUrteil", "profil", "icpUrteil", "schritt", "fehler"
       FROM "VorabFirma" WHERE ${where} ORDER BY "zeile" LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    gesamt: Number(gesamt.rows[0]?.n ?? 0),
    items: r.rows.map((x) => ({ ...x, id: Number(x.id), duplikatVon: x.duplikatVon == null ? null : Number(x.duplikatVon) }) as Firma),
  };
}

/** Zaehler je Schritt neu berechnen und am Lauf speichern. */
export async function zaehlerAktualisieren(pool: Pool, laufId: string): Promise<Record<string, number>> {
  const r = await pool.query<{ k: string; n: string }>(
    `SELECT k, COUNT(*)::text AS n FROM (
       SELECT 'gesamt' AS k FROM "VorabFirma" WHERE "laufId" = $1
       UNION ALL SELECT 'duplikate' FROM "VorabFirma" WHERE "laufId" = $1 AND "duplikatVon" IS NOT NULL
       UNION ALL SELECT 'treffer' FROM "VorabFirma" WHERE "laufId" = $1 AND "abgleich" = 'treffer'
       UNION ALL SELECT 'unsicher' FROM "VorabFirma" WHERE "laufId" = $1 AND "abgleich" = 'unsicher'
       UNION ALL SELECT 'keiner' FROM "VorabFirma" WHERE "laufId" = $1 AND "abgleich" = 'keiner'
       UNION ALL SELECT 'zugeordnet' FROM "VorabFirma" WHERE "laufId" = $1 AND "companyId" IS NOT NULL
       UNION ALL SELECT 'offen' FROM "VorabFirma" WHERE "laufId" = $1 AND "abgleich" = 'unsicher' AND "zuordnung" = 'offen'
       UNION ALL SELECT 'ausgeschlossen' FROM "VorabFirma" WHERE "laufId" = $1 AND "zuordnung" = 'ausgeschlossen'
       UNION ALL SELECT 'website' FROM "VorabFirma" WHERE "laufId" = $1 AND "website" IS NOT NULL
       UNION ALL SELECT 'websiteGeprueft' FROM "VorabFirma" WHERE "laufId" = $1 AND "websiteUrteil" IS NOT NULL
       UNION ALL SELECT 'profil' FROM "VorabFirma" WHERE "laufId" = $1 AND "profil" IS NOT NULL
       UNION ALL SELECT 'urteil' FROM "VorabFirma" WHERE "laufId" = $1 AND "icpUrteil" IS NOT NULL
       UNION ALL SELECT 'ready' FROM "VorabFirma" WHERE "laufId" = $1 AND ("icpUrteil"->>'passt')::boolean = true
       UNION ALL SELECT 'fehler' FROM "VorabFirma" WHERE "laufId" = $1 AND "fehler" IS NOT NULL
     ) t GROUP BY k`,
    [laufId],
  );
  const z: Record<string, number> = {};
  for (const row of r.rows) z[row.k] = Number(row.n);
  // Nur die Zaehler; updatedAt bleibt (die Konsole nutzt updatedAt als Schluessel
  // fuer Formulare, ein staendiger Wechsel wuerde Eingaben verwerfen).
  await pool.query(`UPDATE "VorabLauf" SET "zaehler" = $2::jsonb WHERE "id" = $1`, [laufId, JSON.stringify(z)]);
  return z;
}

/** Kosten des Laufs aus LlmUsage (quelle vorab:<id>) und ProxyAudit (ref). */
export async function laufKosten(pool: Pool, laufId: string): Promise<{ openaiAufrufe: number; openaiUsd: number; valueserpSuchen: number; valueserpUsd: number; gesamtUsd: number }> {
  const [l, v] = await Promise.all([
    pool.query<{ n: string; usd: string }>(`SELECT COUNT(*)::text AS n, COALESCE(SUM("costMicroUsd"), 0)::text AS usd FROM "LlmUsage" WHERE quelle = $1`, [`vorab:${laufId}`]),
    pool.query<{ n: string; usd: string }>(`SELECT COUNT(*) FILTER (WHERE NOT "cacheHit" AND status < 400)::text AS n, COALESCE(SUM("kostenMicroUsd"), 0)::text AS usd FROM "ProxyAudit" WHERE "ref" = $1`, [`vorab:${laufId}`]),
  ]);
  const o = Number(l.rows[0]?.usd ?? 0) / 1e6;
  const s = Number(v.rows[0]?.usd ?? 0) / 1e6;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { openaiAufrufe: Number(l.rows[0]?.n ?? 0), openaiUsd: r2(o), valueserpSuchen: Number(v.rows[0]?.n ?? 0), valueserpUsd: r2(s), gesamtUsd: r2(o + s) };
}
