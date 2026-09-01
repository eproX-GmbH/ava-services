// v0.1.497 — Zwilling des Producer-Filters (company-contact
// valueserp.ts bereinigePerson): der FIRMENNAME ist keine Abteilung
// und kein Titel. Der Desktop-Filter greift nur bei neuen
// Producer-Versionen — dieses Nadeloehr schuetzt ALLE Quellen und
// Altversionen. Feld-Drop ist immer besser als ein falscher Wert.

/** Firmennamen-Vergleichsform: lowercase, Rechtsform-Suffixe weg. */
export function firmenKern(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(gmbh|ag|kg|se|ug|ohg|gbr|mbh|co\.?|&|und|group|gruppe|holding)\b/g,
      " ",
    )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Ist `value` (Abteilung/Titel) in Wahrheit der Firmenname? */
export function istFirmenname(
  value: string | null | undefined,
  companyName: string | null | undefined,
): boolean {
  if (!value || !companyName) return false;
  const kern = firmenKern(companyName);
  const vKern = firmenKern(value);
  if (vKern.length === 0 || kern.length === 0) return false;
  if (vKern === kern) return true;
  // Substring-Richtungen nur ab 5 Zeichen — sonst wuerde z.B. eine
  // legitime Abteilung "IT" bei "XY IT-Systeme GmbH" verworfen.
  return vKern.length >= 5 && (kern.includes(vKern) || vKern.includes(kern));
}

/** Firmennennung STUTZEN (nicht droppen): "Consultant bei X AG" →
 *  "Consultant". Reiner Firmenname → undefined. Zwilling des
 *  Producer-Helfers stutzeFirmennennung. */
export function behandleFirmenwert(
  value: string | null | undefined,
  companyName: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  if (!companyName) return value;
  if (istFirmenname(value, companyName)) return undefined;
  const kern = firmenKern(companyName);
  if (kern.length < 5 || !firmenKern(value).includes(kern)) return value;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let v = value;
  v = v.replace(
    new RegExp(
      `\\s*(?:\\b(?:bei|at|fuer|für|of)\\b|@)?\\s*${esc(companyName)}`,
      "gi",
    ),
    " ",
  );
  v = v.replace(
    new RegExp(
      `\\s*(?:\\b(?:bei|at|fuer|für|of)\\b|@)?\\s*\\b${esc(kern)}\\b(?:[\\s-]*(?:gmbh|ag|kg|se|ug|mbh|gruppe|group|holding))*`,
      "gi",
    ),
    " ",
  );
  v = v
    .replace(/\(\s*\)/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–·,;/]+|[\s\-–·,;/]+$/g, "")
    .trim();
  return v.length >= 3 ? v : undefined;
}
