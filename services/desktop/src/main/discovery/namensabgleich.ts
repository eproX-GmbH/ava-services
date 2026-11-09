// Register-Zuordnung in Stufen (Befund Patrick/Joyce 2026-11-09): erst hart, dann
// weicher, jede weiche Stufe mit Hinweis. Ein gleicher Ort allein oder ein
// gemeinsames Wort wie „GmbH“ reicht NIE (vorher nahm der unscharfe Import den
// ersten Elastic-Treffer, z. B. „ABC GmbH“ fuer „Müller GmbH“ am selben Ort).

const RECHTSFORM = new Set(
  (
    "gmbh mbh ag kg kgaa ohg gbr ug ek ev eg se co cokg haftungsbeschraenkt gesellschaft beschraenkter haftung " +
    "aktiengesellschaft kommanditgesellschaft partg partgmbb ltd limited plc llp inc corp sa sarl sagl bv nv asa oy oyj ab aps " +
    "und u mit der die das"
  ).split(" "),
);

function falten(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

/** Wortbestandteile des Namens ohne Rechtsform und Fuellwoerter. */
export function kernWoerter(name: string): string[] {
  return falten(name)
    .replace(/e\.\s*k\./g, " ek ")
    .replace(/e\.\s*v\./g, " ev ")
    .replace(/&/g, " und ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !RECHTSFORM.has(w));
}

export function kernName(name: string): string {
  return kernWoerter(name).join(" ");
}

/** Ort ohne PLZ und Zusaetze („Frankfurt am Main“ passt zu „Frankfurt“). */
export function ortPasst(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string) => falten(s).replace(/\d+/g, " ").replace(/[^a-z]+/g, " ").trim();
  const x = n(a ?? "");
  const y = n(b ?? "");
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

/** Aehnlich: alle Kernwoerter des kuerzeren Namens kommen im laengeren vor (bei
 *  Woertern ab 5 Zeichen auch mit einem Tippfehler), mindestens ein Wort ab 3 Zeichen. */
function aehnlich(a: string[], b: string[]): boolean {
  const [kurz, lang] = a.length <= b.length ? [a, b] : [b, a];
  if (kurz.length === 0 || !kurz.some((w) => w.length >= 3)) return false;
  return kurz.every((w) => lang.some((v) => v === w || (w.length >= 5 && v.length >= 5 && abstand(w, v) <= 1)));
}

function abstand(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** Hat der Kandidatenname ueberhaupt mit dem gesuchten zu tun (Kernname gleich oder aehnlich)? */
export function namensVerwandt(gesucht: string[], kandidat: string[]): boolean {
  return (gesucht.length > 0 && gesucht.join(" ") === kandidat.join(" ")) || aehnlich(gesucht, kandidat);
}

export type Stufe = "kernname" | "aehnlich";

export interface RegisterKandidat {
  companyId: string;
  name: string;
  location?: string | null;
}

/**
 * Weiche Stufen nach dem harten Abgleich: gleicher Kernname am selben Ort, sonst
 * aehnlicher Name am selben Ort. Mehrere Treffer in derselben Stufe = mehrdeutig
 * (kein Treffer, Grund im Ergebnis). Ohne passenden Namen gibt es nie einen Treffer.
 */
export function registerTreffer<K extends RegisterKandidat>(
  gesucht: { name: string; ort: string | null },
  kandidaten: K[],
): { kandidat: K; stufe: Stufe } | { kandidat: null; mehrdeutig: K[] } {
  const kern = kernWoerter(gesucht.name);
  const amOrt = gesucht.ort ? kandidaten.filter((k) => ortPasst(k.location, gesucht.ort)) : [];
  for (const stufe of ["kernname", "aehnlich"] as const) {
    const passend = amOrt.filter((k) => (stufe === "kernname" ? kern.length > 0 && kernName(k.name) === kern.join(" ") : aehnlich(kern, kernWoerter(k.name))));
    if (passend.length === 1) return { kandidat: passend[0]!, stufe };
    if (passend.length > 1) return { kandidat: null, mehrdeutig: passend };
  }
  return { kandidat: null, mehrdeutig: [] };
}

export function stufenHinweis(gesucht: string, k: RegisterKandidat, stufe: Stufe): string {
  const ziel = `${k.name}${k.location ? ` (${k.location})` : ""}`;
  return stufe === "kernname"
    ? `„${gesucht}“ → ${ziel}: Schreibweise oder Rechtsform weicht ab.`
    : `„${gesucht}“ → ${ziel}: nur ähnlicher Name, bitte prüfen.`;
}
