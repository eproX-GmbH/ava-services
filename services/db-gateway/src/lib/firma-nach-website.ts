// Firma zu einer Website: Welche Firmen im Bestand tragen genau diese Domain?
//
// Befund PM-2026-0059 (Joyce, 2026-11-26/27): "kannst du mir was zur Firma nexburg
// (nexburg.com) sagen?" fuehrte zweimal zur NEXBURG LTD. in London. Die gemeinte
// Nexburg GmbH (Aachen) stand im Suchindex noch unter ihrem alten Namen, ihre Website
// nexburg.com war aber laengst im Firmenprofil bekannt. Nennt der Nutzer eine Website,
// ist sie das staerkste Merkmal; die Namenssuche kommt erst danach.
//
// Quellen (alle klein, nur aufbereitete Firmen): CompanyProfile.url (massgeblich, siehe
// firmenWebsite), Website.url (Website-Stufe) und WebsiteVorgabe.domain (vom Nutzer
// festgelegt). Verglichen wird die Kern-Domain (www./Pfad egal).

import { normalizeDomain } from "./discovery";
import { getProducerPool } from "./producer-pools";
import { logger } from "./logger";

export type WebsiteFirma = { companyId: string; url: string; quelle: "profil" | "website" | "vorgabe" };

/** Kern-Domain aus einer Nutzereingabe ("nexburg.com", "https://www.nexburg.com/de"); null bei Unsinn. */
export function websiteDomain(eingabe: string | null | undefined): string | null {
  const t = (eingabe ?? "").trim();
  if (!t || /\s/.test(t) || t.includes("@")) return null;
  return normalizeDomain(t);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (z) => `\\${z}`);
}

type Abfrage = { query<R>(sql: string, werte: unknown[]): Promise<{ rows: R[] }> };

/**
 * Firmen, deren Website genau diese Kern-Domain hat; Register-Firmen vor WEB-Firmen,
 * hoechstens `max`. Fehler einer Quelle werden geloggt und uebersprungen.
 */
export async function firmenMitWebsite(
  domain: string,
  max = 5,
  /** Nur fuer Tests: Datenbanken statt der Produzenten-Pools. */
  pools?: { profil: Abfrage; website: Abfrage | null },
): Promise<WebsiteFirma[]> {
  const muster = `%${escapeLike(domain)}%`;
  const gefunden = new Map<string, WebsiteFirma>();
  const nimm = (companyId: string, url: string | null, quelle: WebsiteFirma["quelle"]) => {
    if (!url || gefunden.has(companyId)) return;
    if (normalizeDomain(url) !== domain) return;
    gefunden.set(companyId, { companyId, url, quelle });
  };

  try {
    const r = await (pools?.profil ?? (getProducerPool("company-profile") as unknown as Abfrage)).query<{ id: string; url: string | null }>(
      `SELECT id, url FROM "CompanyProfile" WHERE url ILIKE $1 LIMIT 20`,
      [muster],
    );
    for (const z of r.rows) nimm(z.id, z.url, "profil");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), domain }, "[firma-nach-website] Firmenprofil uebersprungen");
  }

  const website = pools
    ? pools.website
    : (() => {
        try {
          return getProducerPool("website") as unknown as Abfrage;
        } catch {
          return null;
        }
      })();
  if (website) {
    try {
      const r = await website.query<{ companyId: string; url: string | null }>(
        `SELECT "companyId", url FROM "Website" WHERE url ILIKE $1 LIMIT 20`,
        [muster],
      );
      for (const z of r.rows) nimm(z.companyId, z.url, "website");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), domain }, "[firma-nach-website] Website-Stufe uebersprungen");
    }
    try {
      // Die Tabelle legt website-vorgabe.ts erst beim ersten Schreiben an.
      const r = await website.query<{ companyId: string; url: string }>(
        `SELECT "companyId", url FROM "WebsiteVorgabe" WHERE domain = $1 OR domain = $2 LIMIT 20`,
        [domain, `www.${domain}`],
      );
      for (const z of r.rows) nimm(z.companyId, z.url, "vorgabe");
    } catch {
      /* keine Vorgaben angelegt */
    }
  }

  return [...gefunden.values()]
    .sort((a, b) => Number(a.companyId.startsWith("WEB_")) - Number(b.companyId.startsWith("WEB_")))
    .slice(0, max);
}
