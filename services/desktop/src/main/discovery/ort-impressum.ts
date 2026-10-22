// Sitz einer Firma deterministisch aus dem Impressum lesen (PLZ + Ort), ohne KI.
// Genutzt vom Mini-Profiler (wenn die KI keinen Ort liefert) und von der
// LinkedIn-Lead-Uebernahme. Keine Electron-Abhaengigkeit.

async function htmlLaden(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; AVA/1.0)", accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const text = await res.text();
    return text.slice(0, 400_000);
  } catch {
    return null;
  }
}

const IMPRESSUM_PFADE = ["/impressum/", "/impressum", "/imprint", "/kontakt/", "/kontakt", "/legal-notice", "/impressum.html"];
const ORT_STOPP = /^(telefon|tel|fax|sitz|deutschland|germany|austria|schweiz|e-?mail|mail|web|internet|www|handelsregister|amtsgericht|ust|umsatzsteuer|geschaeftsfuehrer|geschäftsführer|vertreten|kontakt|postfach|standort|adresse|anschrift|buero|büro|office|zentrale|niederlassung|hauptsitz)$/i;

/** PLZ + Ort aus einem Seitentext (DE 5-stellig bevorzugt, AT/CH 4-stellig als Rückfall).
 *  Deterministisch, ohne KI: die häufigste Kombination gewinnt (Adresse steht im Impressum oft mehrfach). */
export function ortAusText(text: string): { ort: string; plz: string } | null {
  const t = text.replace(/\s+/g, " ");
  // 4-stellige PLZ nur, wenn die Seite auf Oesterreich/Schweiz hindeutet (sonst Telefon-/HRB-Nummern).
  const atCh = /(Österreich|Oesterreich|Austria|Schweiz|Switzerland|Suisse|Svizzera)|\b(AT|CH)-\d{4}\b/i.test(t);
  const zaehler = new Map<string, { ort: string; plz: string; n: number; prio: number }>();
  const muster: Array<[RegExp, number]> = [
    [/\b(\d{5})\s+([A-ZÄÖÜ][a-zäöüß\-]{2,}(?:\s(?:am|an|im|bei|ob|unter|in|vor)\s(?:der\s)?[A-ZÄÖÜ][a-zäöüß\-]{2,})?)/g, 2],
    [/\b(\d{4})\s+([A-ZÄÖÜ][a-zäöüß\-]{2,}(?:\s(?:am|an|im|bei|ob|unter|in|vor)\s(?:der\s)?[A-ZÄÖÜ][a-zäöüß\-]{2,})?)/g, 1],
  ];
  for (const [re, prio] of muster) {
    if (prio === 1 && !atCh) continue;
    for (const m of t.matchAll(re)) {
      const ort = m[2]!.trim();
      if (ORT_STOPP.test(ort.split(" ")[0]!)) continue;
      const key = `${m[1]}|${ort.toLowerCase()}`;
      const e = zaehler.get(key) ?? { ort, plz: m[1]!, n: 0, prio };
      e.n++;
      zaehler.set(key, e);
    }
  }
  const beste = [...zaehler.values()].sort((a, b) => b.prio - a.prio || b.n - a.n)[0];
  return beste ? { ort: beste.ort, plz: beste.plz } : null;
}

function htmlZuText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Sitz der Firma direkt aus dem Impressum lesen, wenn das Mini-Profil keinen Ort geliefert hat
 *  (Befund Patrick 2026-10-22: Sellmore GmbH, Impressum nur unter /impressum/ erreichbar). */
export async function ortAusImpressum(domain: string): Promise<{ ort: string; plz: string; url: string } | null> {
  const hosts = domain.startsWith("www.") ? [domain, domain.slice(4)] : [`www.${domain}`, domain];
  for (const pfad of IMPRESSUM_PFADE) {
    for (const host of hosts) {
      const url = `https://${host}${pfad}`;
      const html = await htmlLaden(url);
      if (!html || html.length < 500) continue;
      const treffer = ortAusText(htmlZuText(html));
      if (treffer) return { ...treffer, url };
    }
  }
  return null;
}
