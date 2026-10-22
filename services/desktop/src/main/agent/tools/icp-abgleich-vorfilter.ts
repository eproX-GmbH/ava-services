// Deterministischer Vorfilter des Bestands-ICP-Abgleichs (icp_bestand_abgleich):
// reine Funktionen ohne Electron/Provider-Abhaengigkeiten, damit sie sich
// einzeln testen lassen.

export interface Felder {
  companyId: string;
  profil: string | null;
  gegenstand: string | null;
  stichworte: string[];
  mitarbeiter: number | null;
  umsatz: number | null;
  jahr: number | null;
  /** Offene Stellen (Titel) und Arbeitgeberleistungen (docs/PLAN_STELLEN_SIGNALE.md). */
  stellen?: string[];
  leistungen?: string[];
}

/** Woerter ab 4 Zeichen aus einer Liste von Begriffen, klein. */
function begriffe(liste: string[]): string[] {
  const out = new Set<string>();
  for (const s of liste) for (const w of s.toLowerCase().split(/[^a-zäöüß0-9-]+/)) if (w.length >= 4) out.add(w);
  return [...out];
}

/** "10-200 Mitarbeiter", "ab 50", "bis 500", "KMU" → Spanne oder null. */
export function groessenSpanne(text: string): { von: number; bis: number } | null {
  const t = text.toLowerCase();
  const m = t.match(/(\d[\d.]*)\s*(?:-|–|bis)\s*(\d[\d.]*)/);
  const zahl = (x: string) => Number(x.replace(/\./g, ""));
  if (m) return { von: zahl(m[1]!), bis: zahl(m[2]!) };
  const ab = t.match(/(?:ab|mindestens|über|ueber|>)\s*(\d[\d.]*)/);
  if (ab) return { von: zahl(ab[1]!), bis: Number.MAX_SAFE_INTEGER };
  const bis = t.match(/(?:bis|unter|höchstens|hoechstens|<)\s*(\d[\d.]*)/);
  if (bis) return { von: 0, bis: zahl(bis[1]!) };
  if (/\bkmu\b|mittelstand/.test(t)) return { von: 10, bis: 1000 };
  return null;
}

/** Deterministischer Vorfilter: Punkte je Firma aus den ICP-Feldern. */
export function vorfilter(
  icp: { branchen: string[]; groesse: string; ausschluesse: string; orte: string[] },
  k: { location?: string | null; felder: Felder | null },
): { punkte: number; gruende: string[] } {
  const gruende: string[] = [];
  let punkte = 0;
  const f = k.felder;
  const text = f ? `${f.profil ?? ""} ${f.gegenstand ?? ""} ${f.stichworte.join(" ")}`.toLowerCase() : "";
  if (!f || (!f.profil && !f.gegenstand && f.stichworte.length === 0)) {
    gruende.push("kein Profil");
    punkte -= 2;
  }
  const branchen = begriffe(icp.branchen);
  const treffer = branchen.filter((b) => text.includes(b));
  if (treffer.length > 0) {
    punkte += Math.min(3, treffer.length);
    gruende.push(`Branche: ${treffer.slice(0, 3).join(", ")}`);
  }
  const spanne = groessenSpanne(icp.groesse);
  if (spanne && f?.mitarbeiter != null) {
    if (f.mitarbeiter >= spanne.von && f.mitarbeiter <= spanne.bis) {
      punkte += 2;
      gruende.push(`${f.mitarbeiter} Mitarbeiter passt`);
    } else {
      punkte -= 1;
      gruende.push(`${f.mitarbeiter} Mitarbeiter ausserhalb`);
    }
  }
  const aus = begriffe([icp.ausschluesse]).filter((w) => !["keine", "kein", "ohne", "nicht"].includes(w));
  const ausTreffer = aus.filter((w) => text.includes(w));
  if (ausTreffer.length > 0) {
    punkte -= 3;
    gruende.push(`Ausschluss: ${ausTreffer.slice(0, 2).join(", ")}`);
  }
  const ort = (k.location ?? "").toLowerCase();
  if (ort && icp.orte.some((o) => o && ort.includes(o.toLowerCase().replace(/\s*\([a-z]{2}\)\s*$/i, "")))) {
    punkte += 1;
    gruende.push("im ICP-Ort");
  }
  return { punkte, gruende };
}

