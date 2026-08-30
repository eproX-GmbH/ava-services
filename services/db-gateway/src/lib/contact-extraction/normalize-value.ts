// Kanonische Dedup-Normalform fuer Kontaktwerte (nie fuer die Anzeige).
//
// Laeuft auf dem bereits per presentation.ts BEREINIGTEN Wert, wendet
// die Bereiniger aber defensiv selbst nochmal an (idempotent) — so
// liefert auch ein Aufruf mit Rohwert dieselbe Normalform.
//
// Telefon-Normalform: E.164-artig (+49...).
//   - deutsche Trunk-Null nach +49 wird entfernt (+4905221... → +495221...)
//   - "00"-Prefix (internationale Verkehrsausscheidung) → "+"
//   - nationale Schreibweise "0..." → +<Laendercode>... — Default-
//     Laendercode ist "49": der Compute-Worker befuellte das Feld nie
//     (toter Parameter), wodurch nationale Nummern bisher NIE gegen
//     ihre +49-Form deduplizierten.

import {
  cleanEmailForDisplay,
  cleanPhoneForDisplay,
} from "./presentation";

export type NormalizeInput = {
  field: string;
  value: string;
  defaultCountryCode?: string;
};

const DEFAULT_COUNTRY_CODE = "49";

export function normalizeValue(input: NormalizeInput): string {
  const v = (input.value ?? "").trim();
  if (!v) return "";
  const f = input.field.toLowerCase();

  if (f.includes("email")) {
    return cleanEmailForDisplay(v).toLowerCase();
  }

  if (f.includes("phone") || f.includes("tel")) {
    const digits = cleanPhoneForDisplay(v).replace(/[^\d+]/g, "");
    if (!digits) return "";
    const cc =
      (input.defaultCountryCode ?? DEFAULT_COUNTRY_CODE).replace(/[^\d]/g, "") ||
      DEFAULT_COUNTRY_CODE;
    let out = digits;
    if (out.startsWith("00")) out = `+${out.slice(2)}`;
    if (!out.startsWith("+")) {
      out = out.startsWith("0") ? `+${cc}${out.slice(1)}` : `+${cc}${out}`;
    }
    // Deutsche Trunk-Null direkt nach dem Laendercode ist ein
    // Schreibweisen-Artefakt ("+49 (0)5221"), nie Teil der Nummer.
    // Bewusst NUR fuer +49 — andere Laender (z. B. Italien) fuehren
    // die Null tatsaechlich mit.
    out = out.replace(/^\+490(?=\d)/, "+49");
    return out;
  }

  if (
    f.includes("url") ||
    f.includes("website") ||
    f.includes("linkedin") ||
    f.includes("xing") ||
    f.includes("social")
  ) {
    try {
      const u = new URL(v.startsWith("http") ? v : `https://${v}`);
      u.hash = "";
      u.searchParams.forEach((_, k) => {
        if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
      });
      if ([...u.searchParams.keys()].length === 0) u.search = "";
      // www. ist Darstellungs-Varianz, keine andere Ressource.
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      const path = u.pathname.replace(/\/+$/, "") || "/";
      return `${u.protocol}//${host}${path}${u.search}`;
    } catch {
      return v;
    }
  }

  return v.replace(/\s+/g, " ").trim();
}
