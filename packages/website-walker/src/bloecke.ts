// Website-Walker, Schicht 2: Blockzerlegung (docs/PLAN_WEBSITE_WALKER.md §2).
//
// Eine Seite wird nicht als Ganzes ins Modell gegeben, sondern in Blöcke
// geschnitten: Überschrift plus Folgeabsätze, Listen, Karten, Tabellen.
// Navigation, Kopf, Fuß, Cookie-Banner, Skripte und srcset-Reste fallen
// vorher weg. Jeder Block kennt seine Fundstelle (URL, Position,
// Überschriftenpfad), damit das Modell belegte Passagen bekommt.

export interface Block {
  url: string;
  /** Laufende Nummer auf der Seite. */
  pos: number;
  /** Überschriften, unter denen der Block steht ("Karriere > Deine Aufgaben"). */
  pfad: string[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", ndash: "–", mdash: "—", euro: "€", hellip: "…" };

export function entschaerfe(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n] ?? " ");
}

/** Hauptinhalt ohne Skripte, Navigation, Kopf, Fuß und Banner. */
export function hauptinhalt(html: string): string {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|canvas)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ")
    // Cookie-Banner, Consent, Skip-Links, Breadcrumbs ueber Klassen-/Id-Namen.
    .replace(/<(div|section)\b[^>]*(id|class)\s*=\s*["'][^"']*(cookie|consent|gdpr|banner|breadcrumb|skip-link|offcanvas|mobile-nav|modal)[^"']*["'][^>]*>[\s\S]{0,4000}?<\/\1>/gi, " ");
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(h)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(h)?.[1];
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 300) h = main;
  return h;
}

function textAus(html: string): string {
  return entschaerfe(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(li|tr|p|div|dd|dt)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Seite in Blöcke schneiden. Schnittstellen sind Überschriften und die
 * Grenzen von article/section/li-Karten; Blöcke unter 40 Zeichen fallen weg,
 * sehr lange werden an Absatzgrenzen geteilt.
 */
export function zerlege(html: string, url: string, opts: { maxBlockZeichen?: number } = {}): Block[] {
  const maxBlock = opts.maxBlockZeichen ?? 2_500;
  const h = hauptinhalt(html);
  const teile = h.split(/(?=<h[1-6]\b)|(?=<article\b)|(?=<section\b)|(?=<li\b[^>]*class\s*=\s*["'][^"']*(?:item|card|teaser|entry|job|position|stelle)[^"']*["'])/i);
  const pfad: string[] = [];
  const out: Block[] = [];
  let pos = 0;
  for (const t of teile) {
    const ueb = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(t);
    if (ueb) {
      const ebene = Number(ueb[1]);
      const titel = textAus(ueb[2] ?? "").replace(/\n/g, " ").slice(0, 120);
      pfad.splice(Math.max(0, ebene - 1));
      pfad[Math.max(0, ebene - 1)] = titel;
    }
    const text = textAus(t);
    if (text.length < 40) continue;
    const stuecke: string[] = [];
    if (text.length <= maxBlock) stuecke.push(text);
    else {
      let rest = text;
      while (rest.length > maxBlock) {
        const schnitt = rest.lastIndexOf("\n", maxBlock);
        const bei = schnitt > maxBlock / 2 ? schnitt : maxBlock;
        stuecke.push(rest.slice(0, bei));
        rest = rest.slice(bei);
      }
      if (rest.trim().length >= 40) stuecke.push(rest);
    }
    for (const s of stuecke) out.push({ url, pos: pos++, pfad: pfad.filter(Boolean).slice(0, 4), text: s.trim() });
  }
  return out;
}

/** Blöcke als Modell-Eingabe mit Fundstelle. */
export function alsEingabe(bloecke: Block[]): string {
  return bloecke
    .map((b) => `[${b.url}#${b.pos}]${b.pfad.length ? ` (${b.pfad.join(" > ")})` : ""}\n${b.text}`)
    .join("\n\n");
}
