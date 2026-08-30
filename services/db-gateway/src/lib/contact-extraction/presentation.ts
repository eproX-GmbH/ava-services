// Anzeige-Bereinigung fuer Kontaktwerte — Port von
// company-contact/src/infrastructure/contact-extraction/presentation.ts
// (v0.1.194) in den PRODUKTIVEN Persist-Pfad.
//
// Hintergrund: Der Gateway-Spiegel war auf Phase-3-Stand eingefroren;
// die De-Obfuskierung ("info (at) quikk.de") und Telefon-Bereinigung
// ("tel://...", Labels, Trunk-Null) existierten nur im toten
// Producer-Pfad. Ab jetzt laeuft JEDER Kontaktwert vor dem Speichern
// hier durch — Fact.value ist damit praesentabel und die
// Dedup-Normalform wird aus dem bereinigten Wert berechnet.
//
// Grundsaetze (unveraendert vom Original):
//   - Idempotent: bereinigten Wert erneut bereinigen ist ein No-op.
//   - Konservativ: im Zweifel Eingabe unveraendert lassen.
//   - Keine schweren Dependencies (kein libphonenumber).

/** E-Mail fuer die Anzeige bereinigen: mailto:-Praefix weg,
 *  (at)/[at]/" at " → "@", (dot)/[dot]/" dot " → ".", lowercase. */
export function cleanEmailForDisplay(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim();
  s = s.replace(/^mailto:/i, "").trim();
  s = s.replace(/\s*[(\[]\s*at\s*[)\]]\s*/gi, "@");
  s = s.replace(/\s+at\s+/gi, "@");
  s = s.replace(/\s*[(\[]\s*dot\s*[)\]]\s*/gi, ".");
  s = s.replace(/\s+dot\s+/gi, ".");
  s = s.replace(/\s+/g, "").toLowerCase();
  // Defensive: wenn das Ergebnis kein "@" hat, das Original aber schon,
  // lieber das getrimmte Original zurueckgeben als Murks.
  if (!s.includes("@") && raw.trim().includes("@")) return raw.trim();
  return s;
}

/** Telefon fuer die Anzeige bereinigen:
 *  1. URI-Schema weg (tel:, tel://, phone:, callto:, sms:)
 *  2. fuehrendes Text-Label weg ("Service ", "Tel.:", ...)
 *  3. Klammer-Gruppen zu einem Ziffernblock kollabieren
 *  4. deutsche Trunk-Null nach Laendercode weg (+49 (0)5221 → +49 5221)
 *  5. Bindestriche/Punkte vor Ziffern → Leerzeichen
 *  6. Slashes → Leerzeichen
 *  7. Mehrfach-Whitespace kollabieren */
export function cleanPhoneForDisplay(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim();
  s = s.replace(/^(?:tel|phone|callto|sms):\/{0,2}/i, "");
  s = s.replace(/^[^+\d]+/, "");
  s = s.replace(/\(\s*([\d\s]+?)\s*\)/g, (_, inner: string) =>
    inner.replace(/\s+/g, ""),
  );
  s = s.replace(/(\+\d{1,3})\s*0(?=\d)/, "$1 ");
  s = s.replace(/[-.](?=\d)/g, " ");
  s = s.replace(/\s*\/\s*/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Dispatcher nach Feldname. Unbekannte Felder bleiben unveraendert
 *  (Adressen, Namen, Positionen haben eigene Sanitizer). */
export function cleanContactValueForDisplay(args: {
  field: string;
  value: string;
}): string {
  const v = args.value ?? "";
  if (!v) return v;
  const f = args.field.toLowerCase();
  if (f.includes("email")) return cleanEmailForDisplay(v);
  if (f.includes("phone") || f.includes("tel")) return cleanPhoneForDisplay(v);
  return v;
}
