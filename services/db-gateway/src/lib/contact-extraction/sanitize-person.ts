// Sanitization fuer Personen-Namen und Rollen/Positionen.
//
// Live-Befunde, die hierher fuehrten:
//   - "Dr., Geschäftsführer" als Position (der Extraktions-Prompt
//     schiebt akademische Titel ins title-Feld, das zugleich das
//     Positionsfeld ist)
//   - "Inhaltlich Verantwortliche gemäß § 10 Abs. 3 MDStV" als
//     Position (Impressums-Rechtsfloskel, keine Rolle)
//   - "Dr. Anna Meier" vs. "Anna Meier" wurden zwei Personen, weil
//     der Identitaetsschluessel den rohen Namen hasht.
//
// Konservativ: lieber null (Feld weglassen) als Murks speichern;
// Namen werden nie verworfen, nur bereinigt.

/** Akademische/berufsstaendische Titel am Stringanfang (auch mehrere:
 *  "Prof. Dr. med."). Bewusst eng gehalten — nur eindeutige Titel. */
const HONORIFIC_RE =
  /^(?:(?:prof|dr|med|jur|rer\s?\.?\s?(?:nat|pol|oec)|h\s?\.?\s?c|dipl\s?[.\-]?\s?(?:ing|kfm|kffr|inf|oec|wirt)|mag|ing|mba|llm|ll\s?\.?\s?m|ba|ma|msc|bsc)\s*\.?\s*[,\-]?\s*)+/i;

/** Rechts-/Impressums-Floskeln, die als "Position" extrahiert werden,
 *  aber keine sind → Feld komplett verwerfen. */
const ROLE_BLACKLIST_RE =
  /gem[aä][sß]+\s*§|§\s*\d|mdstv|rstv|\btmg\b|\bddg\b|\bdsgvo\b|v\s?\.?\s?i\s?\.?\s?s\s?\.?\s?d\s?\.?\s?p|i\s?\.?\s?s\s?\.?\s?d\b|inhaltlich\s+verantwortlich|verantwortlich(?:e[rn]?)?\s+(?:f[uü]r\s+den\s+inhalt|i\s?\.?\s?s)|datenschutzbeauftragte|vertretungsberechtigt|registergericht|handelsregister|umsatzsteuer|impressum/i;

const MAX_ROLE_LEN = 100;

/** Fuehrende Titel abtrennen. Gibt {honorific, rest} zurueck;
 *  honorific ohne Trenn-Reste, rest nie leer (dann kein Split). */
export function splitHonorific(raw: string): {
  honorific: string | null;
  rest: string;
} {
  const s = raw.trim().replace(/\s+/g, " ");
  const m = HONORIFIC_RE.exec(s);
  if (!m) return { honorific: null, rest: s };
  const rest = s.slice(m[0].length).replace(/^[,\-\s]+/, "").trim();
  if (!rest) return { honorific: null, rest: s };
  const honorific = m[0].replace(/[,\-\s]+$/, "").trim();
  return { honorific: honorific || null, rest };
}

/**
 * Rolle/Position bereinigen. null = verwerfen (Floskel/Murks).
 *   "Dr., Geschäftsführer" → "Geschäftsführer"
 *   "Inhaltlich Verantwortliche gemäß § 10 Abs. 3 MDStV" → null
 */
export function sanitizeRole(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/\s+/g, " ");
  if (!s) return null;
  s = splitHonorific(s).rest;
  // Reine Kontaktwerte/URLs im Positionsfeld sind Extraktions-Muell.
  if (s.includes("@") || /^https?:\/\//i.test(s)) return null;
  if (ROLE_BLACKLIST_RE.test(s)) return null;
  // Ueberlange "Positionen" sind fast immer Satz-Floskeln, kein Titel.
  if (s.length > MAX_ROLE_LEN) return null;
  if (s.length < 2) return null;
  return s;
}

/** Personennamen bereinigen (nie verwerfen): Whitespace kollabieren,
 *  haengende Satzzeichen weg. Titel BLEIBEN in der Anzeige ("Dr. Anna
 *  Meier" ist gewuenschte Darstellung); nur die Identitaet faltet sie
 *  weg (siehe nameIdentityForm). */
export function sanitizePersonName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[,\-\s]+|[,\-\s]+$/g, "")
    .trim()
    .slice(0, 120);
}

/** Identitaetsform eines Namens: Titel weg, Diakritik gefaltet,
 *  lowercase — "Dr. Anna Meier" und "anna meier" werden dieselbe
 *  Person. Fuer schlichte Namen identisch zum bisherigen
 *  lowercase(trim(name)) → bestehende Identitaetsschluessel bleiben
 *  fuer den Normalfall stabil. */
export function nameIdentityForm(raw: string): string {
  const base = splitHonorific(sanitizePersonName(raw)).rest;
  return base
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
