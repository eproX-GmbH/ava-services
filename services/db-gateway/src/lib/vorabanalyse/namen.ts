// Vorabanalyse: Firmennamen aus CRM-Exporten bereinigen und Namensbezug pruefen.
// CRM-Namen tragen oft Buchhaltungs- oder Pflegezusaetze ("Kreditorenkontokorrent",
// "(alt)", "Debitor 4711"), die Stammdatensuche und Websuche in die Irre fuehren.

const ZUSATZ = /\b(kreditoren?kontokorrent|debitoren?kontokorrent|kontokorrent|kreditoren?|debitoren?|lieferanten?konto|kundenkonto|sammelkonto|personenkonto|inaktiv|gesperrt|nicht\s+(mehr\s+)?(verwenden|nutzen|benutzen)|alt|old|dublette|duplikat|do\s+not\s+use|loeschen|löschen|test)\b/gi;

/** CRM-Namen bereinigen: Zusaetze, Klammern mit Pflegehinweisen, Kontonummern, doppelte Leerzeichen. */
export function crmNameBereinigen(name: string): string {
  let n = name.replace(/\s+/g, " ").trim();
  n = n.replace(/\((?:[^)]*\b(?:alt|inaktiv|gesperrt|kredit|debit|konto|nicht|dublette|test)\b[^)]*)\)/gi, " ");
  n = n.replace(ZUSATZ, " ");
  n = n.replace(/\b(?:nr\.?|no\.?|konto)\s*\d+\b/gi, " ").replace(/\s\d{4,}\b/g, " ");
  n = n.replace(/\s*[-–,;/|]+\s*$/g, "").replace(/^\s*[-–,;/|]+\s*/g, "");
  n = n.replace(/\s+/g, " ").trim();
  return n.length >= 2 ? n : name.trim();
}

const GENERISCH = new Set(["gmbh", "co", "kg", "ag", "ohg", "ug", "mbh", "gbr", "se", "kgaa", "und", "the", "der", "die", "das", "von", "fuer", "group", "gruppe", "holding", "international", "deutschland", "germany", "service", "services", "systems", "system", "technik", "technology", "technologies", "tube", "mill", "steel", "engineering", "industrie", "industries", "industrial", "maschinen", "maschinenbau", "anlagenbau", "metallbau", "automotive", "automation", "solutions", "consulting", "software", "haftungsbeschraenkt", "handel", "vertrieb", "werk", "werke", "fabrik", "produktion", "manufacturing", "partner", "beteiligungs", "verwaltungs", "verwaltung", "gesellschaft", "stiftung", "e.k", "ek"]);

function norm(x: string): string {
  return x.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
}

/** Kennzeichnende Namensbestandteile: ohne Rechtsformen, Branchenwoerter und den Ort. */
export function kennzeichen(name: string, ort?: string | null): string[] {
  const ortTeile = new Set(norm(ort ?? "").split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
  return [...new Set(norm(crmNameBereinigen(name)).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERISCH.has(t) && !ortTeile.has(t)))];
}

/** Traegt der Text (Domain, Titel, anderer Name) einen kennzeichnenden Bestandteil? */
export function namePasst(name: string, ort: string | null | undefined, text: string): boolean {
  const k = kennzeichen(name, ort);
  if (k.length === 0) return true;
  const ziel = norm(text).replace(/[-_.]/g, "");
  return k.some((t) => ziel.includes(t) || (t.length >= 6 && ziel.includes(t.slice(0, 5))));
}

/** Teilen zwei Firmennamen einen kennzeichnenden Bestandteil (in beide Richtungen)? */
export function namenUeberlappen(a: string, b: string, ort?: string | null): boolean {
  return namePasst(a, ort, b) || namePasst(b, ort, a);
}
