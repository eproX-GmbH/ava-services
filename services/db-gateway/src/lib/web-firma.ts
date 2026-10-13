// WEB-Firmen: Firmen ohne Registereintrag, ID-Basis ist die Kern-Domain
// (docs/PLAN_FIRMEN_OHNE_REGISTER.md §2.2). Zwilling der Domain-Regeln aus
// services/desktop/src/main/firmen-web/domain-gate.ts — der Desktop prueft
// zusaetzlich Erreichbarkeit und Inhalt, das Gateway haelt die Sperrliste als
// letzte Schranke vor der Anlage.
import { normalizeDomain } from "./discovery";

const SOCIAL_RE = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|linkedin\.com|xing\.com|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|pinterest\.(com|de)|threads\.net|snapchat\.com|whatsapp\.com|wa\.me|t\.me|telegram\.me)$/i;
const LINKSEITE_RE = /(^|\.)(linktr\.ee|linktree\.com|linkin\.bio|beacons\.ai|carrd\.co|about\.me|taplink\.cc|lnk\.bio|bio\.link|solo\.to|campsite\.bio|allmylinks\.com|msha\.ke|hoo\.be)$/i;
const GOOGLE_RE = /(^|\.)(google\.[a-z.]+|goo\.gl|business\.site|g\.page|page\.link)$/i;
const VERZEICHNIS_RE = /northdata|unternehmensregister|handelsregister|bundesanzeiger|creditreform|dnb\.com|firmenwissen|firmeneintrag|wlw\.de|gelbeseiten|11880|dasoertliche|kununu|moneyhouse|companyhouse|implisense|genios|websiteprofile|branchenbuch|cylex|yelp\.|herold|stepstone|indeed|wikipedia|trustpilot|provenexpert|golocal|meinestadt|werliefertwas|kompass\.com|europages|yellowpages|tripadvisor|booking\.com|jameda|doctolib|immobilienscout|immowelt|check24|lieferando/i;
const MARKTPLATZ_RE = /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|kleinanzeigen\.de|etsy\.com|hood\.de|otto\.de|zalando\.[a-z]+|idealo\.[a-z]+)$/i;
const BAUKASTEN_RE = /(^|\.)(wixsite\.com|wix\.com|jimdosite\.com|jimdofree\.com|jimdo\.com|webnode\.(com|de|at|ch|page)|weebly\.com|wordpress\.com|blogspot\.(com|de)|blogger\.com|squarespace\.com|godaddysites\.com|strikingly\.com|mystrikingly\.com|github\.io|gitlab\.io|notion\.site|notion\.so|myshopify\.com|shopify\.com|webflow\.io|netlify\.app|vercel\.app|pages\.dev|herokuapp\.com|site123\.me|simplesite\.com|homepage-baukasten\.de|hpage\.com|npage\.de|beepworld\.de|de\.tl|one\.com|ionos\.space|yolasite\.com|webador\.(de|com)|t-online\.de|web\.de|gmx\.(de|net)|arcor\.de|freenet\.de)$/i;

export function webSperrgrund(domain: string): string | null {
  if (SOCIAL_RE.test(domain)) return "social";
  if (LINKSEITE_RE.test(domain)) return "linkseite";
  if (GOOGLE_RE.test(domain)) return "google";
  if (MARKTPLATZ_RE.test(domain)) return "marktplatz";
  if (BAUKASTEN_RE.test(domain)) return "baukasten";
  if (VERZEICHNIS_RE.test(domain)) return "verzeichnis";
  return null;
}

export function webKernDomain(url: string): string | null {
  return normalizeDomain(url);
}

export function webCompanyId(domain: string): string {
  return `WEB_${domain.toUpperCase().replace(/\./g, "_")}`;
}

export const WEB_COMPANY_ID_RE = /^WEB_[A-Z0-9-]+(_[A-Z0-9-]+)+$/;

/** Rechtsform aus dem Namen, soweit sie im Namen steht (e. K., GbR, Einzelunternehmen …). */
export function rechtsformAusName(name: string): string | null {
  const n = name.toLowerCase();
  if (/\be\.\s?k\.|\beingetragene[rn]? kaufmann|\beingetragene kauffrau/.test(n)) return "Eingetragener Kaufmann";
  if (/\bgbr\b|gesellschaft bürgerlichen rechts/.test(n)) return "Gesellschaft bürgerlichen Rechts";
  if (/\bgmbh\b/.test(n)) return "Gesellschaft mit beschränkter Haftung";
  if (/\bug\b|haftungsbeschränkt/.test(n)) return "Unternehmergesellschaft (haftungsbeschränkt)";
  if (/\bag\b/.test(n)) return "Aktiengesellschaft";
  if (/\bkg\b/.test(n)) return "Kommanditgesellschaft";
  if (/\bohg\b/.test(n)) return "Offene Handelsgesellschaft";
  if (/\be\.\s?v\.|eingetragener verein/.test(n)) return "Eingetragener Verein";
  return null;
}
