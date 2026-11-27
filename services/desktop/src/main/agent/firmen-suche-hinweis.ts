// Firmensuche im Chat: genannte Website und Laender-Plausibilitaet (PM-2026-0059).
//
// Befund 2026-11-26/27 (Joyce): "kannst du mir was zur Firma nexburg (nexburg.com)
// sagen?" fuehrte zweimal zur NEXBURG LTD. in London statt zur Nexburg GmbH in Aachen.
// Der Suchindex kannte die GmbH nur unter ihrem alten Namen, die Website nexburg.com
// war aber bekannt, und die Regel "ein passender Treffer, direkt weiter" griff bei
// einem britischen Namenstreffer, obwohl der Nutzer in Deutschland sitzt und kein
// Land genannt hatte. Hier liegt die reine Logik (ohne Gateway), damit sie testbar ist.

/** Dateiendungen, die wie Domains aussehen ("bericht.pdf"), aber keine sind. */
const DATEIENDUNG = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "xlsm", "csv", "ppt", "pptx", "txt", "md", "json", "xml", "zip",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "eml", "msg", "ics", "vcf", "mp3", "mp4", "mov", "wav",
  "html", "htm", "js", "ts", "py", "exe", "dmg", "pkg",
]);

/**
 * Domains aus Freitext ("nexburg (nexburg.com)", "https://www.firma.de/kontakt").
 * E-Mail-Adressen und Dateinamen zaehlen nicht. Ergebnis kleingeschrieben, ohne www.,
 * ohne Doppelte, in Reihenfolge des Auftretens.
 */
export function domainsAusText(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?=[\s/)\]},;:!?"'»“”]|\.(?:\s|$)|$)/gi;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    // Teil einer E-Mail-Adresse (max@firma.de) oder eines laengeren Wortes: ueberspringen.
    const davor = start > 0 ? text[start - 1] : "";
    if (davor === "@" || (davor && /[\w.-]/.test(davor))) continue;
    const domain = m[1]!.toLowerCase().replace(/^www\./, "");
    const tld = m[2]!.toLowerCase();
    if (DATEIENDUNG.has(tld)) continue;
    if (!out.includes(domain)) out.push(domain);
  }
  return out;
}

/** Erster Namensteil einer Domain: "nexburg.com" → "nexburg", "shop.firma.co.uk" → "firma". */
export function domainName(domain: string): string {
  const teile = domain.split(".");
  const zweiteEbene = teile.length >= 3 && /^(co|com|org|net|ac|gv|or)$/.test(teile[teile.length - 2]!);
  return teile[teile.length - (zweiteEbene ? 3 : 2)] ?? domain;
}

const RECHTSFORM = /\b(gmbh|mbh|ag|kg|kgaa|ohg|gbr|ug|se|eg|ev|e\.?v\.?|co|cokg|haftungsbeschränkt|haftungsbeschraenkt|ltd|limited|plc|llp|lp|l\.p\.|llc|inc|corp|sa|sas|sarl|srl|spa|bv|nv|ab|as|asa|oy|oyj|aps|a\/s|sp\.? ?z\.? ?o\.? ?o\.?)\b\.?/giu;

/** Kernname zum Vergleich: klein, ohne Rechtsform und Satzzeichen. */
export function kernName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(RECHTSFORM, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Welche Website soll die Suche mitbekommen? Vorrang: vom Modell uebergeben, dann
 * eine Domain als Suchbegriff, dann genau eine Domain in der letzten Nutzernachricht.
 * Bei einer Domain als Suchbegriff wird der Name daraus gesucht ("nexburg").
 */
export function websiteFuerSuche(args: { q: string; website?: string }, nutzerText?: string): { q: string; website?: string; quelle?: "argument" | "suchbegriff" | "nachricht" } {
  if (args.website?.trim()) return { q: args.q, website: args.website.trim(), quelle: "argument" };
  const imBegriff = domainsAusText(args.q);
  if (imBegriff.length === 1 && args.q.trim().split(/\s+/).length === 1) {
    return { q: domainName(imBegriff[0]!), website: imBegriff[0]!, quelle: "suchbegriff" };
  }
  const inNachricht = domainsAusText(nutzerText);
  if (inNachricht.length === 1) return { q: args.q, website: inNachricht[0]!, quelle: "nachricht" };
  return { q: args.q };
}

type Treffer = { companyId?: unknown; name?: unknown; location?: unknown; country?: unknown; land?: unknown; websiteTreffer?: unknown; website?: unknown };

const LAND: Record<string, string> = { AT: "Österreich", CH: "Schweiz", UK: "Vereinigtes Königreich", NO: "Norwegen", FI: "Finnland" };

/**
 * Hinweis fuer das Modell zum Suchergebnis, oder null. `country` = Laenderfilter
 * der Suche (dann hat der Nutzer das Land bestimmt). `items` tragen `country` nur
 * ausserhalb Deutschlands (wie das company_search-Ergebnis).
 */
export function suchHinweis(o: { q: string; website?: string; country?: string; items: Treffer[] }): string | null {
  const web = o.items.filter((i) => i.websiteTreffer === true);
  if (web.length === 1) {
    const f = web[0]!;
    return (
      `Die genannte Website ${o.website ?? ""} gehört zu ${String(f.name)} (${String(f.location ?? "")}), companyId ${String(f.companyId)}. ` +
      "Das ist die gemeinte Firma: direkt mit ihr weiter (company_get), nicht nachfragen und keine andere Firma mit ähnlichem Namen nehmen."
    ).replace(/\s+/g, " ");
  }
  if (web.length > 1) {
    return (
      `Mehrere Firmen tragen die Website ${o.website ?? ""} (websiteTreffer: true), z. B. Mutter- und Tochtergesellschaft. ` +
      "Nur zwischen diesen per ask_user_choice wählen lassen (Name + Ort); keine anderen Namenstreffer anbieten."
    ).replace(/\s+/g, " ");
  }
  const kerne = new Set([kernName(o.q), o.website ? kernName(domainName(o.website)) : ""].filter(Boolean));
  const namensgleich = o.items.filter((i) => typeof i.name === "string" && kerne.has(kernName(i.name)));
  const suchName = kernName(o.q) || (o.website ? domainName(o.website) : o.q);
  const deutsch = namensgleich.filter((i) => !i.country || i.country === "DE");
  const websiteSatz = o.website
    ? `Keine Firma im Bestand trägt die Website ${o.website}; der Namenstreffer ist damit nicht belegt. `
    : "";
  if (!o.country && namensgleich.length > 0 && deutsch.length === 0) {
    const laender = [...new Set(namensgleich.map((i) => LAND[String(i.country)] ?? String(i.country)))].join(", ");
    return (
      `${websiteSatz}Treffer mit diesem Namen gibt es nur im Ausland (${laender}). Der Nutzer arbeitet in Deutschland und hat kein Land genannt, ` +
      "und der Suchindex kennt neue Firmennamen (Umbenennungen) erst verzögert. Deshalb JETZT ohne Rückfrage " +
      `register_live_suche(name: "${suchName}") für das deutsche Handelsregister aufrufen und eine passende deutsche Firma nehmen. ` +
      "Die ausländische Firma nur, wenn dort nichts passt; dann das Land ausdrücklich nennen."
    ).replace(/\s+/g, " ");
  }
  if (o.website && namensgleich.length === 0) {
    return `${websiteSatz}Ohne passenden Namenstreffer: register_live_suche(name: "${suchName}") aufrufen, nicht raten.`.replace(/\s+/g, " ");
  }
  if (o.website && namensgleich.length > 0) {
    return `${websiteSatz}Sag dem Nutzer, dass die Zuordnung zur Website erst die Website-Prüfung bestätigt.`.replace(/\s+/g, " ");
  }
  return null;
}
