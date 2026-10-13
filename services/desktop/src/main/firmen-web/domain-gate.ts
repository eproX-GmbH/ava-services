// Website-Gate fuer Firmen ohne Registereintrag (docs/PLAN_FIRMEN_OHNE_REGISTER.md §2.4).
//
// Harte, deterministische Pruefung VOR jedem KI-Urteil: Nur eine erreichbare,
// der Firma gehoerende Website mit echtem Inhalt darf zur ID-Basis (Kern-Domain)
// einer WEB-Firma werden. Social-Seiten, Link-Seiten, Verzeichnisse,
// Baukasten-Subdomains, Parkseiten und Redirects auf fremde Domains fallen
// durch. "facebook.com" als Firmen-Domain darf nie entstehen.
//
// Reine Funktionen ohne Electron-Abhaengigkeit; `fetch` wird injiziert, damit
// die Pruefung testbar ist.

export type GateGrund =
  | "keine_url"
  | "social"
  | "linkseite"
  | "google"
  | "verzeichnis"
  | "marktplatz"
  | "baukasten"
  | "nicht_erreichbar"
  | "kein_html"
  | "fremde_domain_nach_redirect"
  | "zu_wenig_inhalt"
  | "parkseite";

export interface GateErgebnis {
  ok: boolean;
  /** Kern-Domain (ID-Basis), auch bei Ablehnung gesetzt, wenn sie sich bilden liess. */
  domain: string | null;
  grund: GateGrund | null;
  /** Endgueltige URL nach Redirects (nur bei ok). */
  url: string | null;
  titel: string | null;
  /** Sichtbarer Text der Startseite, gekuerzt (nur bei ok). */
  text: string | null;
}

/** URL → Kern-Domain. MUSS mit normalizeDomain im Gateway (lib/discovery.ts) uebereinstimmen. */
export function kernDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url.trim().startsWith("http") ? url.trim() : `https://${url.trim()}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
  const tld = labels[labels.length - 1] ?? "";
  const sld = labels[labels.length - 2] ?? "";
  const take = labels.length > 2 && tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  const core = labels.slice(-take).join(".");
  if (core.length < 4 || core.length > 100) return null;
  return core;
}

const SOCIAL_RE = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linkedin\.com|xing\.com|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|pinterest\.(com|de)|threads\.net|snapchat\.com|whatsapp\.com|wa\.me|t\.me|telegram\.me)$/i;
const LINKSEITE_RE = /(^|\.)(linktr\.ee|linktree\.com|linkin\.bio|beacons\.ai|carrd\.co|about\.me|taplink\.cc|lnk\.bio|bio\.link|solo\.to|campsite\.bio|allmylinks\.com|msha\.ke|hoo\.be)$/i;
const GOOGLE_RE = /(^|\.)(google\.[a-z.]+|goo\.gl|business\.site|g\.page|page\.link|maps\.app\.goo\.gl)$/i;
/** Verzeichnisse und Portale (Radar DIRECTORY_DOMAIN_RE, erweitert). */
const VERZEICHNIS_RE = /northdata|unternehmensregister|handelsregister|bundesanzeiger|creditreform|dnb\.com|firmenwissen|firmeneintrag|wlw\.de|gelbeseiten|11880|dasoertliche|kununu|moneyhouse|companyhouse|implisense|genios|websiteprofile|branchenbuch|cylex|yelp\.|herold|stepstone|indeed|wikipedia|trustpilot|provenexpert|golocal|meinestadt|marktplatz-mittelstand|werliefertwas|kompass\.com|europages|yellowpages|tripadvisor|booking\.com|hotels\.com|jameda|doctolib|sanego|immobilienscout|immowelt|check24|verivox|lieferando|wolt\.com|ubereats|zvg\.|justiz\.de/i;
const MARKTPLATZ_RE = /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|ebay-kleinanzeigen\.de|kleinanzeigen\.de|etsy\.com|dawanda|hood\.de|rakuten|otto\.de|zalando\.[a-z]+|idealo\.[a-z]+|billiger\.de)$/i;
/** Baukasten- und Shared-Hosts: die Kern-Domain gehoert dem Anbieter, nicht der Firma. */
const BAUKASTEN_RE = /(^|\.)(wixsite\.com|wix\.com|jimdosite\.com|jimdofree\.com|jimdo\.com|jimdo\.de|webnode\.(com|de|at|ch|page)|weebly\.com|wordpress\.com|blogspot\.(com|de)|blogger\.com|squarespace\.com|godaddysites\.com|strikingly\.com|mystrikingly\.com|github\.io|gitlab\.io|notion\.site|notion\.so|myshopify\.com|shopify\.com|webflow\.io|netlify\.app|vercel\.app|pages\.dev|herokuapp\.com|000webhostapp\.com|site123\.me|simplesite\.com|homepage-baukasten\.de|hpage\.com|npage\.de|beepworld\.de|de\.tl|jouwweb\.nl|one\.com|ionos\.space|my-free-website|yolasite\.com|webador\.(de|com)|wixstatic\.com|strato-hosting|t-online\.de|web\.de|gmx\.(de|net)|arcor\.de|freenet\.de|alice-dsl\.de)$/i;
const PARK_RE = /(domain (is|may be) for sale|this domain (is|was) (parked|registered)|buy this domain|domain zu verkaufen|diese domain (steht|ist) zum verkauf|domain kaufen|parked free|sedoparking|parkingcrew|hugedomains|dan\.com|afternic|domain\s*parking|coming soon|under construction|website im aufbau|hier entsteht (eine neue|die) (internetpr|webpr|website)|baustelle|diese website wird gerade erstellt|website is under construction)/i;

/** Sperrgrund einer Kern-Domain, null = unbedenklich. */
export function sperrgrund(domain: string): GateGrund | null {
  if (SOCIAL_RE.test(domain)) return "social";
  if (LINKSEITE_RE.test(domain)) return "linkseite";
  if (GOOGLE_RE.test(domain)) return "google";
  if (MARKTPLATZ_RE.test(domain)) return "marktplatz";
  if (BAUKASTEN_RE.test(domain)) return "baukasten";
  if (VERZEICHNIS_RE.test(domain)) return "verzeichnis";
  return null;
}

/** HTML → Titel + sichtbarer Text (grob: Skripte/Styles weg, Tags weg, Whitespace falten). */
export function htmlText(html: string): { titel: string | null; text: string } {
  const titel = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
  const ohne = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\s]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { titel, text: ohne };
}

export const MIN_TEXT = 300;
const MAX_TEXT = 6000;
const TIMEOUT_MS = 10_000;

export interface GateFetchAntwort {
  ok: boolean;
  status: number;
  url: string;
  contentType: string | null;
  text: () => Promise<string>;
}
export type GateFetch = (url: string, init: { signal: AbortSignal; redirect: "follow" }) => Promise<GateFetchAntwort>;

const standardFetch: GateFetch = async (url, init) => {
  const r = await fetch(url, { ...init, headers: { "user-agent": "Mozilla/5.0 (compatible; AVA/1.0; +https://ava.bi)", accept: "text/html,application/xhtml+xml" } });
  return { ok: r.ok, status: r.status, url: r.url, contentType: r.headers.get("content-type"), text: () => r.text() };
};

/**
 * Volle Pruefung einer Website-Angabe (z. B. aus einem Google-Places-Eintrag).
 * Reihenfolge: Kern-Domain bilden → Sperrliste → Startseite laden (https, dann
 * http) → Redirect-Ziel muss dieselbe Kern-Domain haben → HTML mit genug Text,
 * keine Parkseite.
 */
export async function pruefeFirmenDomain(url: string | null | undefined, fetchImpl: GateFetch = standardFetch): Promise<GateErgebnis> {
  const ablehnung = (grund: GateGrund, domain: string | null = null): GateErgebnis => ({ ok: false, domain, grund, url: null, titel: null, text: null });
  const domain = kernDomain(url);
  if (!domain) return ablehnung("keine_url");
  const sperre = sperrgrund(domain);
  if (sperre) return ablehnung(sperre, domain);

  let host: string;
  try {
    host = new URL(url!.trim().startsWith("http") ? url!.trim() : `https://${url!.trim()}`).hostname;
  } catch {
    return ablehnung("keine_url", domain);
  }
  let antwort: GateFetchAntwort | null = null;
  let letzterGrund: GateGrund = "nicht_erreichbar";
  for (const kandidat of [`https://${host}/`, `http://${host}/`]) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(kandidat, { signal: ctrl.signal, redirect: "follow" });
      if (r.ok) {
        antwort = r;
        break;
      }
      letzterGrund = "nicht_erreichbar";
    } catch {
      letzterGrund = "nicht_erreichbar";
    } finally {
      clearTimeout(t);
    }
  }
  if (!antwort) return ablehnung(letzterGrund, domain);
  const zielDomain = kernDomain(antwort.url);
  if (zielDomain !== domain) {
    // Redirect auf eine fremde Domain: Facebook-Weiterleitung, Portal, Mutterkonzern.
    const zielSperre = zielDomain ? sperrgrund(zielDomain) : null;
    return ablehnung(zielSperre ?? "fremde_domain_nach_redirect", domain);
  }
  if (antwort.contentType && !/text\/html|application\/xhtml/i.test(antwort.contentType)) return ablehnung("kein_html", domain);
  let html = "";
  try {
    html = await antwort.text();
  } catch {
    return ablehnung("nicht_erreichbar", domain);
  }
  const { titel, text } = htmlText(html);
  if (PARK_RE.test(`${titel ?? ""} ${text.slice(0, 800)}`) && text.length < 1500) return ablehnung("parkseite", domain);
  if (text.length < MIN_TEXT) return ablehnung("zu_wenig_inhalt", domain);
  return { ok: true, domain, grund: null, url: antwort.url, titel, text: text.slice(0, MAX_TEXT) };
}

/** Kern-Domain → companyId einer WEB-Firma (docs/PLAN_FIRMEN_OHNE_REGISTER.md §2.2). */
export function webCompanyId(domain: string): string {
  return `WEB_${domain.toUpperCase().replace(/\./g, "_")}`;
}
export const WEB_COMPANY_ID_RE = /^WEB_[A-Z0-9-]+(_[A-Z0-9-]+)+$/;
