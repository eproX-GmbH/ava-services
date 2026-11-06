// Bestandssuche S2 (docs/PLAN_BESTANDSSUCHE.md): zentrale Tabelle SuchBlock im
// Gateway. Jede Quelle (Stellen, Karriereseite, Fokus-Themen, Referenzen,
// Firmenprofil) schreibt beim Persistieren ihre Belege hierhin; die Suche liest
// nur noch diese Tabelle (GIN auf tsv). Abschlussbloecke bleiben in
// PublicationBlock (eigener Index, viele Zeilen je Firma).
//
// Schreiben ist best-effort: ein Fehler hier darf den Persist nie kippen.

import { createHash } from "node:crypto";
import type pg from "pg";
import { getGatewayPool, getProducerPool } from "./producer-pools";

export const SUCH_QUELLEN = ["stelle", "karriere", "thema", "kunde", "profil"] as const;
export type SuchQuelle = (typeof SUCH_QUELLEN)[number];

export interface SuchBlockEingang {
  /** Stabil je Beleg innerhalb (companyId, quelle): URL, Schluessel, Name. */
  ref: string;
  titel: string;
  text: string;
  quelleUrl?: string | null;
  datum?: Date | string | null;
}

const MAX_TEXT = 12_000;
const MAX_JE_FIRMA_QUELLE = 60;

function id(companyId: string, quelle: SuchQuelle, ref: string): string {
  return createHash("sha1").update(`${quelle}\u0000${companyId}\u0000${ref}`).digest("hex");
}

function datum(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Belege einer Firma und Quelle ersetzen (Lauf-Semantik: der neue Stand gilt).
 *  Mit actorId (Fokus-Themen) nur die Belege dieses Nutzers; ref wird dann je
 *  Nutzer eindeutig gemacht, damit gleichnamige Themen sich nicht verdraengen. */
export async function suchbloeckeErsetzen(companyId: string, quelle: SuchQuelle, bloecke: SuchBlockEingang[], q: pg.Pool | pg.PoolClient = getGatewayPool(), actorId: string | null = null): Promise<number> {
  const sauber = bloecke
    .map((b) => ({ ...b, ref: (b.ref ?? "").trim().slice(0, 500), titel: (b.titel ?? "").replace(/\s+/g, " ").trim().slice(0, 300), text: (b.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) }))
    .filter((b) => b.ref && b.text.length >= 3)
    .slice(0, MAX_JE_FIRMA_QUELLE)
    .map((b) => (actorId ? { ...b, ref: `${actorId}:${b.ref}`.slice(0, 500) } : b));
  if (actorId) await q.query(`DELETE FROM "SuchBlock" WHERE "companyId" = $1 AND quelle = $2 AND "actorId" = $3`, [companyId, quelle, actorId]);
  else await q.query(`DELETE FROM "SuchBlock" WHERE "companyId" = $1 AND quelle = $2 AND "actorId" IS NULL`, [companyId, quelle]);
  for (const b of sauber) {
    await q.query(
      `INSERT INTO "SuchBlock" (id, "companyId", quelle, ref, titel, text, "quelleUrl", datum, "actorId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (quelle, "companyId", ref) DO UPDATE SET titel = EXCLUDED.titel, text = EXCLUDED.text, "quelleUrl" = EXCLUDED."quelleUrl", datum = EXCLUDED.datum, "actorId" = EXCLUDED."actorId", "updatedAt" = NOW()`,
      [id(companyId, quelle, b.ref), companyId, quelle, b.ref, b.titel, b.text, b.quelleUrl ?? null, datum(b.datum), actorId],
    );
  }
  return sauber.length;
}

/** Wie suchbloeckeErsetzen, aber schluckt Fehler (Persist-Haken). */
export async function suchbloeckeErsetzenLeise(companyId: string, quelle: SuchQuelle, bloecke: SuchBlockEingang[], warn: (m: string) => void = (m) => console.warn(m), actorId: string | null = null): Promise<void> {
  try {
    await suchbloeckeErsetzen(companyId, quelle, bloecke, getGatewayPool(), actorId);
  } catch (err) {
    warn(`[suchblock] ${quelle} ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- Belege aus den Fachdaten bauen (eine Stelle fuer Persist UND Backfill) ----

export interface StelleRoh { title: string; sourceUrl: string; location?: string | null; description?: string | null; requirements?: string[] | null; technologies?: string[] | null; benefits?: string[] | null; releaseDate?: Date | string | null }
export function stellenBloecke(stellen: StelleRoh[]): SuchBlockEingang[] {
  return stellen.map((jp) => ({
    ref: `${jp.sourceUrl}#${jp.title}`.slice(0, 500),
    titel: jp.title,
    text: [jp.location, jp.description, (jp.requirements ?? []).length ? `Anforderungen: ${(jp.requirements ?? []).join(" • ")}` : null, (jp.technologies ?? []).length ? `Technologien: ${(jp.technologies ?? []).join(" • ")}` : null, (jp.benefits ?? []).length ? `Wir bieten: ${(jp.benefits ?? []).join(" • ")}` : null].filter(Boolean).join("\n"),
    quelleUrl: jp.sourceUrl,
    datum: jp.releaseDate ?? null,
  }));
}

export function karriereBloecke(k: { benefits?: string[] | null; quelleUrl?: string | null; auszug?: string | null; updatedAt?: Date | string | null }): SuchBlockEingang[] {
  const text = [(k.benefits ?? []).length ? `Leistungen: ${(k.benefits ?? []).join(" • ")}` : null, k.auszug].filter(Boolean).join("\n");
  return text ? [{ ref: k.quelleUrl ?? "karriere", titel: "Karriereseite", text, quelleUrl: k.quelleUrl ?? null, datum: k.updatedAt ?? null }] : [];
}

export function themenBloecke(themen: Array<{ schluessel: string; name: string; status: string; zitat?: string | null; quelleUrl?: string | null; ueberschrift?: string | null; begruendung?: string | null; updatedAt?: Date | string | null }>): SuchBlockEingang[] {
  return themen
    .filter((t) => t.status === "gefunden" || t.status === "unklar")
    .map((t) => ({ ref: t.schluessel, titel: `Fokus-Thema: ${t.name} (${t.status === "gefunden" ? "gefunden" : "unklar"})`, text: [t.zitat, t.ueberschrift, t.begruendung].filter(Boolean).join("\n"), quelleUrl: t.quelleUrl ?? null, datum: t.updatedAt ?? null }));
}

export function kundenBloecke(kunden: Array<{ name: string; art?: string | null; beleg?: string | null; quelle?: string | null; zuletztGesehen?: Date | string | null }>): SuchBlockEingang[] {
  return kunden.map((k) => ({ ref: k.name, titel: `Referenz/Partner: ${k.name}${k.art ? ` (${k.art})` : ""}`, text: [k.name, k.beleg].filter(Boolean).join("\n"), quelleUrl: k.quelle ?? null, datum: k.zuletztGesehen ?? null }));
}

export function profilBloecke(p: { profile: string; url?: string | null; updatedAt?: Date | string | null }): SuchBlockEingang[] {
  return p.profile?.trim() ? [{ ref: "profil", titel: "Firmenprofil", text: p.profile, quelleUrl: p.url ?? null, datum: p.updatedAt ?? null }] : [];
}

// ---- Suche ----

export interface SuchTreffer { companyId: string; quelle: SuchQuelle; titel: string; auszug: string; url: string | null; datum: string | null; rang: number; embedding?: number[] | null }

const HEADLINE = "'MaxWords=45, MinWords=20, MaxFragments=2, FragmentDelimiter=\" … \", StartSel=«, StopSel=»'";

export function tsqueryAusdruck(anzahl: number, offset: number): string {
  return Array.from({ length: anzahl }, (_, i) => `websearch_to_tsquery('german', $${offset + i})`).join(" || ");
}

export async function suchbloeckeSuchen(companyIds: string[], quellen: SuchQuelle[], begriffe: string[], maxZeilen: number, actorId: string): Promise<SuchTreffer[]> {
  if (companyIds.length === 0 || quellen.length === 0 || begriffe.length === 0) return [];
  const q = tsqueryAusdruck(begriffe.length, 5);
  const r = await getGatewayPool().query<SuchTreffer>(
    `SELECT "companyId", quelle, titel, "quelleUrl" AS url, to_char(datum, 'YYYY-MM-DD') AS datum, embedding,
            ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug,
            ts_rank_cd(tsv, ${q}) AS rang
     FROM "SuchBlock"
     WHERE "companyId" = ANY($1::text[]) AND quelle = ANY($2::text[]) AND tsv @@ (${q})
       AND (quelle <> 'thema' OR "actorId" = $4)
     ORDER BY rang DESC LIMIT $3`,
    [companyIds, quellen, maxZeilen, actorId, ...begriffe],
  );
  return r.rows.map((x) => ({ ...x, rang: Number(x.rang) || 0, auszug: (x.auszug ?? "").replace(/\s+/g, " ").trim().slice(0, 600) }));
}

/** Pool-Suche: alle Bloecke AUSSER denen der uebergebenen Firmen (eigener Bestand). */
export async function suchbloeckePoolSuchen(ausgeschlossen: string[], quellen: SuchQuelle[], begriffe: string[], maxZeilen: number): Promise<SuchTreffer[]> {
  if (quellen.length === 0 || begriffe.length === 0) return [];
  const q = tsqueryAusdruck(begriffe.length, 4);
  const r = await getGatewayPool().query<SuchTreffer>(
    `SELECT "companyId", quelle, titel, "quelleUrl" AS url, to_char(datum, 'YYYY-MM-DD') AS datum, embedding,
            ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug,
            ts_rank_cd(tsv, ${q}) AS rang
     FROM "SuchBlock"
     WHERE NOT ("companyId" = ANY($1::text[])) AND quelle = ANY($2::text[]) AND quelle <> 'thema' AND tsv @@ (${q})
     ORDER BY rang DESC LIMIT $3`,
    [ausgeschlossen, quellen, maxZeilen, ...begriffe],
  );
  return r.rows.map((x) => ({ ...x, rang: Number(x.rang) || 0, auszug: (x.auszug ?? "").replace(/\s+/g, " ").trim().slice(0, 600) }));
}

// ---- Altbestand (einmalig, Betreiber) ----

export interface BackfillStand { stelle: number; karriere: number; thema: number; kunde: number; profil: number; firmen: number; laeuft: boolean; fehler: string | null; gestartet: string | null; beendet: string | null }
const stand: BackfillStand = { stelle: 0, karriere: 0, thema: 0, kunde: 0, profil: 0, firmen: 0, laeuft: false, fehler: null, gestartet: null, beendet: null };
export function backfillStand(): BackfillStand { return { ...stand }; }

async function firmenIds(pool: pg.Pool, sql: string): Promise<string[]> {
  try {
    const r = await pool.query<{ companyId: string }>(sql);
    return r.rows.map((x) => x.companyId);
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    throw err;
  }
}

/** Alle vorhandenen Belege einmal nach SuchBlock uebernehmen (nur Volltext, keine Embeddings). */
export async function suchblockBackfill(log: (m: string) => void): Promise<void> {
  if (stand.laeuft) return;
  Object.assign(stand, { stelle: 0, karriere: 0, thema: 0, kunde: 0, profil: 0, firmen: 0, laeuft: true, fehler: null, gestartet: new Date().toISOString(), beendet: null });
  try {
    const web = getProducerPool("website");
    const alleFirmen = new Set<string>();
    // Stellen
    for (const cid of await firmenIds(web, `SELECT DISTINCT "companyId" FROM "JobPosting"`)) {
      const r = await web.query<StelleRoh>(`SELECT title, "sourceUrl", location, description, requirements, technologies, benefits, "releaseDate" FROM "JobPosting" WHERE "companyId" = $1`, [cid]);
      stand.stelle += await suchbloeckeErsetzen(cid, "stelle", stellenBloecke(r.rows));
      alleFirmen.add(cid);
    }
    // Karriere
    for (const cid of await firmenIds(web, `SELECT "companyId" FROM "CompanyKarriere"`)) {
      const r = await web.query<{ benefits: string[]; quelleUrl: string | null; auszug: string | null; updatedAt: Date }>(`SELECT benefits, "quelleUrl", auszug, "updatedAt" FROM "CompanyKarriere" WHERE "companyId" = $1`, [cid]);
      if (r.rows[0]) stand.karriere += await suchbloeckeErsetzen(cid, "karriere", karriereBloecke(r.rows[0]));
      alleFirmen.add(cid);
    }
    // Themen
    // Themen je Nutzer (seit 2026-11-06); Altbestand ohne Nutzer ('') bleibt draussen.
    const themenPaare = await web
      .query<{ companyId: string; actorId: string }>(`SELECT DISTINCT "companyId", "actorId" FROM "CompanyThema" WHERE "actorId" <> ''`)
      .catch(() => ({ rows: [] as Array<{ companyId: string; actorId: string }> }));
    await getGatewayPool().query(`DELETE FROM "SuchBlock" WHERE quelle = 'thema' AND "actorId" IS NULL`).catch(() => undefined);
    for (const { companyId: cid, actorId } of themenPaare.rows) {
      const r = await web.query(`SELECT schluessel, name, status, zitat, "quelleUrl", ueberschrift, begruendung, "updatedAt" FROM "CompanyThema" WHERE "companyId" = $1 AND "actorId" = $2`, [cid, actorId]);
      stand.thema += await suchbloeckeErsetzen(cid, "thema", themenBloecke(r.rows), getGatewayPool(), actorId);
      alleFirmen.add(cid);
    }
    // Referenzen (Gateway-DB)
    const gw = getGatewayPool();
    for (const cid of await firmenIds(gw, `SELECT DISTINCT "companyId" FROM "CompanyKunde"`)) {
      const r = await gw.query(`SELECT name, art, beleg, quelle, "zuletztGesehen" FROM "CompanyKunde" WHERE "companyId" = $1`, [cid]);
      stand.kunde += await suchbloeckeErsetzen(cid, "kunde", kundenBloecke(r.rows));
      alleFirmen.add(cid);
    }
    // Profil
    const prof = getProducerPool("company-profile");
    for (const cid of await firmenIds(prof, `SELECT id AS "companyId" FROM "CompanyProfile"`)) {
      const r = await prof.query<{ profile: string; url: string | null; updatedAt: Date }>(`SELECT profile, url, "updatedAt" FROM "CompanyProfile" WHERE id = $1`, [cid]);
      if (r.rows[0]) stand.profil += await suchbloeckeErsetzen(cid, "profil", profilBloecke(r.rows[0]));
      alleFirmen.add(cid);
    }
    stand.firmen = alleFirmen.size;
    log(`[suchblock] Backfill fertig: ${JSON.stringify({ stelle: stand.stelle, karriere: stand.karriere, thema: stand.thema, kunde: stand.kunde, profil: stand.profil, firmen: stand.firmen })}`);
  } catch (err) {
    stand.fehler = err instanceof Error ? err.message : String(err);
    log(`[suchblock] Backfill abgebrochen: ${stand.fehler}`);
  } finally {
    stand.laeuft = false;
    stand.beendet = new Date().toISOString();
  }
}

// ---- S3: Vektoren (lokal gerechnet) ----

export function kosinus(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * BM25-Rang und Kosinus-Rang je Block per RRF (k=60) verschmelzen. Bloecke ohne
 * Embedding behalten nur den BM25-Anteil. Liefert dieselben Treffer mit neuem
 * `rang` (RRF-Summe), absteigend sortiert, plus Zaehler fuer die Antwort.
 */
export function fusioniere<T extends { rang: number; embedding?: number[] | null }>(treffer: T[], frageEmbedding: number[] | null): { treffer: T[]; mitEmbedding: number } {
  const bm25 = [...treffer].sort((a, b) => b.rang - a.rang);
  const bmRang = new Map<T, number>(bm25.map((t, i) => [t, i]));
  if (!frageEmbedding) return { treffer: bm25, mitEmbedding: 0 };
  const mitVektor = treffer.filter((t) => Array.isArray(t.embedding) && t.embedding.length > 0);
  const kos = new Map<T, number>(mitVektor.map((t) => [t, kosinus(frageEmbedding, t.embedding as number[])]));
  const kosRang = new Map<T, number>([...mitVektor].sort((a, b) => (kos.get(b) ?? 0) - (kos.get(a) ?? 0)).map((t, i) => [t, i]));
  const K = 60;
  const neu = treffer.map((t) => {
    let r = 1 / (K + (bmRang.get(t) ?? treffer.length));
    const kr = kosRang.get(t);
    if (kr !== undefined) r += 1 / (K + kr);
    return { ...t, rang: r };
  });
  neu.sort((a, b) => b.rang - a.rang);
  return { treffer: neu, mitEmbedding: mitVektor.length };
}

/** Bloecke der genannten Firmen ohne Vektor (fuer den lokalen Einbetter des Desktops). */
export async function offeneEmbeddings(companyIds: string[], limit: number, actorId: string): Promise<Array<{ id: string; titel: string; text: string }>> {
  if (companyIds.length === 0) return [];
  // Fokus-Themen fremder Nutzer gehen nie an diesen Rechner.
  const r = await getGatewayPool().query<{ id: string; titel: string; text: string }>(
    `SELECT id, titel, left(text, 4000) AS text FROM "SuchBlock"
      WHERE "companyId" = ANY($1::text[]) AND embedding IS NULL AND (quelle <> 'thema' OR "actorId" = $3)
      ORDER BY "updatedAt" DESC LIMIT $2`,
    [companyIds, limit, actorId],
  );
  return r.rows;
}

/** Vektoren eintragen; nur Zeilen der genannten Firmen. Liefert die Zahl der geschriebenen Zeilen. */
export async function embeddingsSetzen(companyIds: string[], modell: string, eintraege: Array<{ id: string; embedding: number[] }>, actorId: string): Promise<number> {
  if (companyIds.length === 0 || eintraege.length === 0) return 0;
  let n = 0;
  const pool = getGatewayPool();
  for (const e of eintraege) {
    const r = await pool.query(`UPDATE "SuchBlock" SET embedding = $3::real[], "embeddingModell" = $4 WHERE id = $1 AND "companyId" = ANY($2::text[]) AND (quelle <> 'thema' OR "actorId" = $5)`, [e.id, companyIds, e.embedding, modell, actorId]);
    n += r.rowCount ?? 0;
  }
  return n;
}
