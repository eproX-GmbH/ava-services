// seite_lesen (docs/PLAN_STELLEN_SIGNALE.md): eine beliebige Webseite als Text in den
// Chat holen — Karriereseite, Pressemitteilung, Produktseite. HTTP zuerst, bei duennem
// Ergebnis (JS-Seite, Bot-Gate) das versteckte Fenster wie beim Mini-Profil. Keine
// Logins, keine Downloads, private Netze gesperrt, robots.txt-Vollsperre respektiert.

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import { fetchPageText, fetchTextViaBrowser } from "../../discovery/profiler";

/** Sichtbarer Text ohne die 6.000-Zeichen-Kappung des Profil-Crawls. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|li|h[1-6]|div|tr|br|section|article)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö").replace(/&uuml;/g, "ü").replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö").replace(/&Uuml;/g, "Ü").replace(/&szlig;/g, "ß").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

const MAX_ZEICHEN = 20_000;

function privateAdresse(ip: string): boolean {
  if (ip.startsWith("10.") || ip.startsWith("127.") || ip.startsWith("0.") || ip.startsWith("169.254.") || ip.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd");
}

async function erlaubt(u: URL): Promise<string | null> {
  if (!/^https?:$/.test(u.protocol)) return "Nur http(s)-Adressen.";
  const host = u.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "Lokale Adressen sind gesperrt.";
  if (isIP(host)) return privateAdresse(host) ? "Private Netze sind gesperrt." : null;
  try {
    const a = await lookup(host);
    return privateAdresse(a.address) ? "Private Netze sind gesperrt." : null;
  } catch {
    return "Die Adresse ist nicht auflösbar.";
  }
}

async function robotsVollsperre(origin: string): Promise<boolean> {
  const txt = await fetchPageText(`${origin}/robots.txt`).catch(() => null);
  if (!txt) return false;
  let gilt = false;
  for (const zeile of txt.split("\n")) {
    const z = zeile.trim();
    if (/^user-agent:/i.test(z)) gilt = /^user-agent:\s*\*/i.test(z);
    else if (gilt && /^disallow:\s*\/\s*$/i.test(z)) return true;
  }
  return false;
}

export function buildSeiteLesenTools(): Tool[] {
  const lesen = defineTool({
    name: "seite_lesen",
    summary: "Eine Webseite als Text lesen (Karriereseite, Pressemeldung, Produktseite) — auch JS-Seiten, ohne Login.",
    category: "webseite url lesen text auslesen karriere seite oeffnen",
    description:
      "Laedt eine Webseite und liefert ihren sichtbaren Text (max. 20.000 Zeichen). Nutze es, wenn der Nutzer eine Adresse nennt oder fragt, was auf einer Seite steht, " +
      "z. B. 'Lies die Karriereseite und sag mir, ob sie betriebliche Altersvorsorge anbieten'. Bei JavaScript-Seiten wird ein verstecktes Fenster genutzt. " +
      "Grenzen: keine Logins, keine Downloads, keine privaten Netze; Seiten mit robots.txt-Vollsperre werden nicht gelesen. Fuer das Firmenprofil company_get nutzen.",
    parameters: { type: "object", required: ["url"], properties: { url: { type: "string" }, frage: { type: "string", description: "Optional: worauf es ankommt (nur fuer das Protokoll)." } } },
    schema: yup.object({ url: yup.string().trim().min(4).max(2000).required(), frage: yup.string().trim().max(300).optional() }).noUnknown(true),
    preview: (r: { zeichen?: number; error?: string; url?: string }) => (r.error ? `nicht lesbar: ${r.error}` : `${r.zeichen ?? 0} Zeichen von ${r.url ?? "?"}`),
    run: async (args) => {
      const roh = /^https?:\/\//i.test(args.url) ? args.url : `https://${args.url}`;
      let u: URL;
      try {
        u = new URL(roh);
      } catch {
        return { error: "Keine gueltige Adresse." };
      }
      const sperre = await erlaubt(u);
      if (sperre) return { error: sperre };
      if (await robotsVollsperre(u.origin)) return { error: "Die Website untersagt das automatische Lesen (robots.txt)." };
      let text = "";
      let quelle: "http" | "browser" = "http";
      const html = await fetchPageText(u.toString());
      if (html) text = htmlToText(html);
      if (text.length < 300) {
        const gerendert = await fetchTextViaBrowser(u.toString());
        if (gerendert && gerendert.length > text.length) {
          text = gerendert;
          quelle = "browser";
        }
      }
      if (text.length < 50) return { error: "Die Seite liefert keinen lesbaren Text (nicht erreichbar, Login, oder nur Bilder)." };
      const gekuerzt = text.length > MAX_ZEICHEN;
      return {
        url: u.toString(),
        quelle,
        zeichen: Math.min(text.length, MAX_ZEICHEN),
        gekuerzt,
        text: text.slice(0, MAX_ZEICHEN),
        hinweis: "Text ist unbearbeitet von der Seite; Aussagen daraus immer mit Quelle (URL) nennen.",
      };
    },
  });
  return [lesen];
}
