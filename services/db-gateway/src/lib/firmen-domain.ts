// Gehoert eine E-Mail-Domain zu einer Firma? (Befund 2026-10-10: joyce@quikk.de der
// Firma QUIKK wurde bei Strategic IT als Beleg genommen und allen Kollegen ein
// vorname@quikk.de abgeleitet.) Massstab ist die Website der Firma; verglichen wird
// die registrierbare Domain (mail.firma.de == firma.de).

const ZWEITE_EBENE = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.at", "or.at", "gv.at", "com.tr", "co.nz", "com.br"]);

/** firma.de aus www.firma.de, mail.firma.de, https://shop.firma.co.uk/ … */
export function registrierbar(hostOderUrl: string | null | undefined): string | null {
  if (!hostOderUrl) return null;
  let host = hostOderUrl.trim().toLowerCase();
  try {
    if (host.includes("/") || host.includes(":")) host = new URL(host.startsWith("http") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  const teile = host.split(".").filter(Boolean);
  if (teile.length < 2) return null;
  const zwei = teile.slice(-2).join(".");
  return ZWEITE_EBENE.has(zwei) && teile.length >= 3 ? teile.slice(-3).join(".") : zwei;
}

export function emailDomain(email: string): string | null {
  const d = email.split("@")[1];
  return d ? registrierbar(d) : null;
}

/** true, wenn die Adresse zur Website der Firma passt; ohne Website unentscheidbar (null). */
export function passtZurFirma(email: string, websiteUrl: string | null | undefined): boolean | null {
  const web = registrierbar(websiteUrl);
  if (!web) return null;
  return emailDomain(email) === web;
}

/**
 * Website der Firma: Company.websiteUrl (Kontakt-Datenbank) ist meist leer, die
 * ermittelte Website steht im Firmenprofil (CompanyProfile.url).
 */
export async function firmenWebsite(companyId: string, gespeichert?: string | null): Promise<string | null> {
  if (gespeichert) return gespeichert;
  try {
    const { getProducerPool } = await import("./producer-pools");
    const r = await getProducerPool("company-profile").query<{ url: string | null }>(`SELECT url FROM "CompanyProfile" WHERE id = $1 LIMIT 1`, [companyId]);
    return r.rows[0]?.url ?? null;
  } catch {
    return null;
  }
}
