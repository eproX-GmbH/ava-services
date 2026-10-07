// Best Match fuer den Stammdaten-Abgleich im Kunden-Reiter (docs/PLAN_KUNDEN.md,
// Operator 2026-10-07). Reine Funktionen ohne Datenbank, testbar.

import type { KundenMatch } from "./kunden";
import { getMasterDataPool } from "./discovery";

type Treffer = KundenMatch;

/** Vergleichsform ohne Rechtsform: „AUDI AG“ und „Audi“ treffen sich. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|ag|se|b\.?v|s\.?a|corp|co|kg|mbh|ohg|e\.?v)\b\.?/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Wortmenge ohne Rechtsform, fuer die Ueberdeckungsregel. */
function woerter(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|gmbh|ag|se|b\.?v|s\.?a|corp|co|kg|mbh|ohg|e\.?v)\b\.?/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 2),
  );
}

/** Kandidat beginnt (ohne Rechtsform) mit dem Kundennamen an einer Wortgrenze: „Audi“ → „AUDI AG“, nicht „Audio Service“. */
function namenstreffer(kunde: string, kandidat: string): boolean {
  const n = norm(kunde);
  const kn = norm(kandidat);
  if (n.length < 3) return false;
  if (kn === n) return true;
  if (!kn.startsWith(n)) return false;
  const i = kandidat.toLowerCase().indexOf(kunde.toLowerCase());
  if (i < 0) return true; // Normalform passt, Original anders geschrieben (Rechtsform mittendrin)
  const rest = kandidat.slice(i + kunde.length);
  return rest.length === 0 || /^[\s\-–,.&(]/.test(rest);
}

/**
 * Best Match (Operator 2026-10-07): aus den Kandidaten des Trockenlaufs den
 * besten Stammdaten-Treffer waehlen und einstufen.
 *  - sicher:   genau EIN Kandidat trifft den Namen (ohne Rechtsform), oder ein
 *              Mehrwortname wird exakt getroffen. „EnKo Engineering GmbH“ → eindeutig.
 *  - unsicher: mehrere Kandidaten treffen den Namen (KUKA AG, KUKA Deutschland
 *              GmbH …) → der mit dem hoechsten Score; oder kein Namenstreffer,
 *              aber alle Woerter des Kundennamens kommen im besten Kandidaten vor.
 *  - null:     sonst („nicht gefunden“).
 */
export function waehleBestMatch(kunde: string, kandidaten: Array<{ companyId: string; name: string; location?: string | null; score?: number }>): Treffer | null {
  if (kandidaten.length === 0) return null;
  const sortiert = [...kandidaten].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const treffer = sortiert.filter((k) => namenstreffer(kunde, k.name));
  const mach = (k: (typeof sortiert)[number], stufe: "sicher" | "unsicher"): Treffer => ({ companyId: k.companyId, name: k.name, location: k.location ?? null, stufe, score: typeof k.score === "number" ? k.score : null });
  const exakt = treffer.filter((k) => norm(k.name) === norm(kunde));
  if (treffer.length === 1) return mach(treffer[0]!, "sicher");
  // Mehrwortname exakt getroffen („EnKo Engineering GmbH“) ist eindeutig, auch wenn
  // weitere Kandidaten mit dem Namen beginnen. Ein Einwortname (KUKA, Hettich) mit
  // mehreren passenden Firmen (AG, Deutschland GmbH, Systems GmbH) bleibt unsicher.
  if (exakt.length === 1 && woerter(kunde).size >= 2) return mach(exakt[0]!, "sicher");
  if (treffer.length > 1) return mach(exakt[0] ?? treffer[0]!, "unsicher");
  const w = woerter(kunde);
  if (w.size === 0) return null;
  const best = sortiert[0]!;
  const bw = woerter(best.name);
  const alle = [...w].every((x) => bw.has(x));
  return alle ? mach(best, "unsicher") : null;
}


/**
 * Stufe 0 (Operator 2026-10-07): normalisierte Namenssuche direkt in den
 * Stammdaten, bevor Elasticsearch gefragt wird. Beide Seiten nutzen die
 * SQL-Funktion firmen_schluessel (Umlaute ausgeschrieben, nur [a-z0-9]), mit
 * Ausdrucksindex auf GermanCompany.name (Historie bewusst nicht, Operator 2026-10-07).
 * Genau EIN aktiver Treffer → "sicher". Null oder mehrere → null, der Aufrufer
 * weicht auf Elasticsearch mit Score aus.
 */
export async function schluesselTreffer(namen: string[]): Promise<Map<string, KundenMatch | null>> {
  const out = new Map<string, KundenMatch | null>();
  const eindeutig = [...new Set(namen.map((n) => n.trim()).filter((n) => n.length >= 3))];
  if (eindeutig.length === 0) return out;
  const r = await getMasterDataPool().query<{ gesucht: string; companyId: string; name: string; location: string | null; anzahl: string }>(
    `WITH gesucht AS (SELECT unnest($1::text[]) AS n),
          alle AS (
            SELECT DISTINCT g.n AS gesucht, c."companyId", c.name, c.location
              FROM gesucht g JOIN "GermanCompany" c ON firmen_schluessel(c.name) = firmen_schluessel(g.n)
             WHERE c."registerStatus" = 'ACTIVE'
          )
     SELECT gesucht, "companyId", name, location, count(*) OVER (PARTITION BY gesucht)::text AS anzahl
       FROM alle`,
    [eindeutig],
  );
  const treffer = new Map<string, Array<{ companyId: string; name: string; location: string | null }>>();
  for (const z of r.rows) {
    const l = treffer.get(z.gesucht) ?? [];
    l.push({ companyId: z.companyId, name: z.name, location: z.location });
    treffer.set(z.gesucht, l);
  }
  for (const n of eindeutig) {
    const l = treffer.get(n) ?? [];
    out.set(n, l.length === 1 ? { companyId: l[0]!.companyId, name: l[0]!.name, location: l[0]!.location, stufe: "sicher", score: null } : null);
  }
  return out;
}
