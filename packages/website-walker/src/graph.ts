// Website-Walker, Schicht 1: Linkgraph (docs/PLAN_WEBSITE_WALKER.md §2).
//
// Startseite, Navigation und Sitemap einer Website lesen und jeden Link ohne
// Modell einem Zweck zuordnen (Pfad und Linktext). Tiefe 2, nur der eigene
// Host. Das Ergebnis ist die Kandidatenliste, aus der jede Stufe (Stellen,
// Referenzen, Personen, Profil) ihre Seiten zieht.

// Kanonische Fassung: packages/website-walker/src (vendoriert nach
// website/ und company-contact/ unter src/infrastructure/walker/, Abgleich
// scripts/check-vendor-drift.mjs). Keine Producer-Importe: den Browser-
// Rueckfall reicht der Aufrufer als Funktion herein.

/** Browser-Rueckfall des Producers (Selenium); null = nur HTTP. */
export type BrowserLader = ((url: string) => Promise<{ html: string }>) | null;

export const WALKER_UA = "Mozilla/5.0 (compatible; AVA-Website/1.0; +https://ava.bi)";

export type Zweck = "karriere" | "stelle" | "referenzen" | "team" | "impressum" | "news" | "produkt" | "sonstiges";

const QUELLEN_RANG: Record<Knoten["quelle"], number> = { start: 0, sitemap: 1, seite: 2 };
/** Seiten, die "nicht gefunden" melden, obwohl der Server 200 sagt. */
export function istSoft404(html: string): boolean {
  const titel = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  return /\b404\b|nicht gefunden|not found|seite existiert nicht|page doesn.t exist/i.test(titel);
}

export interface Knoten {
  url: string;
  /** Linktext, wie er auf der verweisenden Seite stand (leer bei Sitemap). */
  text: string;
  zwecke: Set<Zweck>;
  /** Woher der Link stammt: Startseite, Unterseite, Sitemap. */
  quelle: "start" | "seite" | "sitemap";
}

export interface Graph {
  base: URL;
  startHtml: string | null;
  knoten: Map<string, Knoten>;
}

const MAX_SITEMAP_URLS = 500;
const MAX_LINKS_JE_SEITE = 400;

const RE: Record<Exclude<Zweck, "sonstiges">, RegExp> = {
  karriere: /karriere|career|jobs\b|\/job\b|stellen|arbeiten-bei|work-with-us|join-us|wir-suchen|mitarbeit|bewerb|vacanc|recruit/i,
  stelle: /\(\s*[mwdfx]\s*[\/|]\s*[mwdfx]\s*([\/|]\s*[mwdfx*]\s*)?\)|\b[mwdf]-[mwdf]-[mwdfx]\b|\(gn\)|\(all genders\)|festanstellung\/[a-z0-9]|ausbildung-|werkstudent|praktikum|\/jobs?\/[a-z0-9]|\/stellen(angebote)?\/[a-z0-9]|\/karriere\/[a-z0-9][^"']{3,}|\/career[s]?\/[a-z0-9][^"']{3,}|job-?(id|detail|posting)/i,
  referenzen: /referenz|kunden|customers|clients|case-stud|erfolgsgeschicht|success-stor|projekte\b|portfolio|testimonial|partner/i,
  team: /\/team\b|unser-team|ueber-uns|ueber_uns|about-us|about\b|wir-ueber-uns|unternehmen\b|management|geschaeftsfuehrung|ansprechpartner|mitarbeiter\b|people|leadership/i,
  impressum: /impressum|imprint|kontakt|contact|legal-notice/i,
  news: /news|aktuell|blog|presse|press|magazin|up2date|neuigkeit|artikel/i,
  produkt: /produkt|product|leistung|service|loesung|solution|angebot|branche|industr|portfolio/i,
};

/** Zwecke eines Links aus Pfad und Linktext. */
export function zweckeVon(url: string, text: string): Set<Zweck> {
  const z = new Set<Zweck>();
  let pfad = "";
  try {
    pfad = decodeURIComponent(new URL(url).pathname);
  } catch {
    pfad = url;
  }
  const t = text.replace(/\s+/g, " ").trim();
  for (const k of Object.keys(RE) as Array<Exclude<Zweck, "sonstiges">>) {
    if (RE[k].test(pfad) || RE[k].test(t)) z.add(k);
  }
  // Eine einzelne Anzeige zaehlt auch als Karriere-Zweig.
  if (z.has("stelle")) z.add("karriere");
  if (z.size === 0) z.add("sonstiges");
  return z;
}

export async function ladeHtml(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": WALKER_UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/html|text|xml/.test(ct)) return null;
    const text = await res.text();
    return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  } catch {
    return null;
  }
}

/** Sichtbarer Text ohne Skripte, Styles und Tags (grob, nur fuer die Duenn-Pruefung). */
export function textLaenge(html: string): number {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * HTML einer Seite; bei leerem, blockiertem oder duennem Inhalt (Stellenlisten,
 * die erst JavaScript nachlaedt: slashwhy.de, sim-automation.de, Messung
 * 2026-10-25) ueber den Browser des Producers.
 */
export async function ladeSeite(url: string, log?: (m: string) => void, browser: BrowserLader = null): Promise<string | null> {
  const html = await ladeHtml(url);
  if (html && html.length >= 1_500 && textLaenge(html) >= 800) return html;
  if (!browser) return html;
  try {
    return (await browser(url)).html;
  } catch (err) {
    log?.(`[walker] ${url}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return html;
  }
}

function gleicherHost(u: URL, base: URL): boolean {
  return u.hostname.replace(/^www\./, "") === base.hostname.replace(/^www\./, "");
}

function normalisiere(href: string, base: URL): string | null {
  if (/^(mailto|tel|javascript|data):/i.test(href) || /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3)(\?|$)/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol) || !gleicherHost(u, base)) return null;
    u.hash = "";
    // Tracking-Parameter weg, sonst dieselbe Seite mehrfach.
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|cHash$)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

/** Links einer Seite mit Linktext (Bild-alt und title zaehlen als Text). */
export function linksAus(html: string, base: URL): Array<{ url: string; text: string }> {
  const out: Array<{ url: string; text: string }> = [];
  const re = /<a\b([^>]*)href\s*=\s*["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_LINKS_JE_SEITE) {
    const url = normalisiere(m[2]!, base);
    if (!url) continue;
    const attrs = `${m[1] ?? ""} ${m[3] ?? ""}`;
    const title = /title\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    const inner = m[4] ?? "";
    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(inner)?.[1] ?? "";
    const text = `${inner.replace(/<[^>]+>/g, " ")} ${title} ${alt}`.replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
    out.push({ url, text });
  }
  return out;
}

async function sitemapUrls(base: URL, log?: (m: string) => void): Promise<string[]> {
  const gesehen = new Set<string>();
  const out: string[] = [];
  const warteschlange = [new URL("/sitemap.xml", base).toString(), new URL("/sitemap_index.xml", base).toString()];
  let geladen = 0;
  while (warteschlange.length > 0 && out.length < MAX_SITEMAP_URLS && geladen < 12) {
    const u = warteschlange.shift()!;
    if (gesehen.has(u)) continue;
    gesehen.add(u);
    const xml = await ladeHtml(u, 10_000);
    geladen++;
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    const istIndex = /<sitemapindex/i.test(xml);
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((x) => x[1]!.trim());
    if (istIndex) {
      for (const l of locs.slice(0, 20)) warteschlange.push(l);
    } else {
      for (const l of locs) {
        const n = normalisiere(l, base);
        if (n && !gesehen.has(n)) {
          gesehen.add(n);
          out.push(n);
          if (out.length >= MAX_SITEMAP_URLS) break;
        }
      }
    }
  }
  if (out.length > 0) log?.(`[walker] Sitemap: ${out.length} URLs`);
  return out;
}

/**
 * Linkgraph der Website: Startseite (Tiefe 1), Sitemap und die Links der
 * Unterseiten, die einem der gewuenschten Zwecke dienen (Tiefe 2).
 */
export async function baueGraph(website: string, zwecke: Zweck[], opts: { maxUnterseiten?: number; log?: (m: string) => void; browser?: BrowserLader } = {}): Promise<Graph | null> {
  const start = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  let base: URL;
  try {
    base = new URL(start);
  } catch {
    return null;
  }
  const log = opts.log;
  const knoten = new Map<string, Knoten>();
  const merke = (url: string, text: string, quelle: Knoten["quelle"]) => {
    const z = zweckeVon(url, text);
    const alt = knoten.get(url);
    if (alt) {
      for (const x of z) alt.zwecke.add(x);
      if (!alt.text && text) alt.text = text;
      return;
    }
    knoten.set(url, { url, text, zwecke: z, quelle });
  };

  const browser = opts.browser ?? null;
  const startHtml = await ladeSeite(base.toString(), log, browser);
  if (startHtml) for (const l of linksAus(startHtml, base)) merke(l.url, l.text, "start");
  for (const u of await sitemapUrls(base, log)) merke(u, "", "sitemap");
  // Feste Pfade nur als Rueckfall, wenn Navigation und Sitemap fuer einen
  // Zweck nichts hergeben (sonst gewinnen /jobs-Soft-404s gegen /karriere/).
  const FESTE: Array<[Zweck, string[]]> = [
    ["karriere", ["/karriere", "/karriere/", "/jobs", "/career", "/careers", "/stellenangebote"]],
    ["referenzen", ["/referenzen", "/kunden"]],
    ["team", ["/team", "/ueber-uns"]],
    ["impressum", ["/impressum"]],
  ];
  for (const [zweck, pfade] of FESTE) {
    if ([...knoten.values()].some((k) => k.zwecke.has(zweck))) continue;
    for (const pfad of pfade) {
      const u = new URL(pfad, base).toString();
      if (!knoten.has(u)) merke(u, "", "seite");
    }
  }

  // Tiefe 2: Unterseiten der gewuenschten Zwecke lesen und deren Links aufnehmen.
  const max = opts.maxUnterseiten ?? 6;
  const unterseiten = [...knoten.values()]
    .filter((k) => k.url !== base.toString() && zwecke.some((z) => k.zwecke.has(z)) && !k.zwecke.has("stelle"))
    .sort((a, b) => QUELLEN_RANG[a.quelle] - QUELLEN_RANG[b.quelle] || a.url.length - b.url.length)
    .slice(0, max);
  for (const k of unterseiten) {
    const html = await ladeSeite(k.url, log, browser);
    if (!html || istSoft404(html)) {
      knoten.delete(k.url);
      continue;
    }
    for (const l of linksAus(html, base)) merke(l.url, l.text, "seite");
  }
  log?.(`[walker] Graph ${base.hostname}: ${knoten.size} Links, ${unterseiten.length} Unterseiten gelesen`);
  return { base, startHtml, knoten };
}

/** Knoten eines Zwecks: zuerst aus Navigation, dann Sitemap, dann Rueckfall; kurze Pfade zuerst. */
export function knotenFuer(graph: Graph, zweck: Zweck, max: number): Knoten[] {
  return [...graph.knoten.values()]
    .filter((k) => k.zwecke.has(zweck))
    .sort((a, b) => QUELLEN_RANG[a.quelle] - QUELLEN_RANG[b.quelle] || a.url.length - b.url.length)
    .slice(0, max);
}
