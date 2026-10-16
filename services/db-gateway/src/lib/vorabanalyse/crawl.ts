// Leichter Website-Crawl per fetch (kein Browser): Startseite plus wenige Unterseiten,
// robots.txt beachtet, private Netze gesperrt, Groessen- und Zeitlimits.

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const UA = "Mozilla/5.0 (compatible; AVA-Vorabanalyse/1.0; +https://ava.bi)";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_PER_PAGE = 12_000;
const MAX_SUBPAGES = 4;
const SUBPAGE_RE = /(ueber|über|about|unternehmen|company|leistung|service|produkt|product|loesung|lösung|solution|branche|industr|referenz|kunden|customer|team|kontakt|contact|impressum)/i;
const PLATTFORM_SPERRE = /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|xing\.com|kununu\.com|youtube\.com|twitter\.com|x\.com|tiktok\.com|pinterest\.com|wikipedia\.org|google\.[a-z.]+|maps\.google|yelp\.[a-z]+|gelbeseiten\.de|dasoertliche\.de|11880\.com|goyellow\.de|firmenwissen\.de|northdata\.de|unternehmensregister\.de|handelsregister\.de|companyhouse\.de|creditreform\.de|wlw\.de|amazon\.[a-z.]+|ebay\.[a-z.]+|indeed\.com|stepstone\.de|glassdoor\.[a-z.]+|trustpilot\.com|provenexpert\.com|jameda\.de|immobilienscout24\.de|immowelt\.de|booking\.com|tripadvisor\.[a-z.]+|cylex\.de|meinestadt\.de|branchenbuch\.|firmenabc\.|wer-zu-wem\.de|dnb\.com|bloomberg\.com|crunchbase\.com)$/i;

export function istPlattform(hostname: string): boolean {
  return PLATTFORM_SPERRE.test(hostname.toLowerCase());
}

export function kernDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function privateAdresse(ip: string): boolean {
  if (ip.startsWith("10.") || ip.startsWith("127.") || ip.startsWith("0.") || ip.startsWith("169.254.") || ip.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

async function erlaubt(url: URL): Promise<boolean> {
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isIP(host)) return !privateAdresse(host);
  try {
    const a = await lookup(host);
    return !privateAdresse(a.address);
  } catch {
    return false;
  }
}

async function seiteLaden(url: string, timeoutMs = 20_000): Promise<string | null> {
  try {
    const u = new URL(url);
    if (!(await erlaubt(u))) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(u, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/html|xml|text\/plain/.test(ct)) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total > MAX_PAGE_BYTES) { await reader.cancel().catch(() => undefined); break; }
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

export function htmlZuText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö").replace(/&uuml;/g, "ü").replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö").replace(/&Uuml;/g, "Ü").replace(/&szlig;/g, "ß").replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_PER_PAGE);
}

async function disallows(origin: string): Promise<string[]> {
  const txt = await seiteLaden(`${origin}/robots.txt`, 8_000).catch(() => null);
  if (!txt) return [];
  const out: string[] = [];
  let gilt = false;
  for (const zeile of txt.split("\n")) {
    const z = zeile.trim();
    if (/^user-agent:/i.test(z)) gilt = /^user-agent:\s*\*/i.test(z);
    else if (gilt && /^disallow:/i.test(z)) { const p = z.replace(/^disallow:/i, "").trim(); if (p) out.push(p); }
  }
  return out;
}

function unterseiten(html: string, base: URL, kern: string): string[] {
  const out: string[] = [];
  const gesehen = new Set<string>();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_SUBPAGES) {
    const href = m[1]!;
    if (!SUBPAGE_RE.test(href) || /\.(pdf|jpg|png|zip|docx?|xlsx?)$/i.test(href) || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (kernDomain(u.hostname) !== kern) continue;
      u.hash = ""; u.search = "";
      const k = u.toString();
      if (gesehen.has(k) || k === base.toString()) continue;
      gesehen.add(k);
      out.push(k);
    } catch { /* unbrauchbar */ }
  }
  return out;
}

export interface CrawlErgebnis { text: string; url: string; seiten: number; titel: string | null }

/** Website kurz lesen: Startseite + bis zu 4 Unterseiten. null = nicht erreichbar/zu wenig Text. */
export async function websiteLesen(start: string): Promise<CrawlErgebnis | null> {
  const kandidaten = /^https?:\/\//i.test(start) ? [start] : [`https://${start}`, `https://www.${start}`, `http://${start}`];
  let html: string | null = null;
  let base: URL | null = null;
  for (const k of kandidaten) {
    html = await seiteLaden(k);
    if (html) { base = new URL(k); break; }
  }
  if (!html || !base) return null;
  const kern = kernDomain(base.hostname);
  const sperren = await disallows(base.origin);
  if (sperren.includes("/")) return null;
  const titel = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  const teile = [htmlZuText(html)];
  let seiten = 1;
  for (const link of unterseiten(html, base, kern)) {
    const pfad = new URL(link).pathname;
    if (sperren.some((d) => pfad.startsWith(d))) continue;
    const h = await seiteLaden(link, 15_000);
    if (h) { teile.push(`[Seite ${pfad}] ${htmlZuText(h)}`); seiten++; }
  }
  const text = teile.join("\n\n").trim();
  return text.length >= 200 ? { text, url: base.toString(), seiten, titel } : null;
}
