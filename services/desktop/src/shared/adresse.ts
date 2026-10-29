// Postanschrift aus Registerfeldern für Anzeige und Karte.
//
// Deutsche, österreichische und Schweizer Adressen: "Straße Nr", "PLZ Ort".
// Britische Adressen: "Nr Straße", "Ort Postcode". Companies-House-Daten, die
// vor dem Parser-Fix (structured-content, 2026-10-11) gespeichert wurden, tragen
// oft das Land als Ort ("England") und Grafschaft/Doppelzeilen in der Straße;
// ukAdresseTeilen räumt das mit derselben Regel wie der Parser auf.

import type { RegisterLand } from "./register-land";

export const LAND_NAME: Record<RegisterLand, string> = {
  DE: "Deutschland",
  AT: "Österreich",
  CH: "Schweiz",
  UK: "United Kingdom",
  NO: "Norwegen",
};

const UK_LAND = /^(england|scotland|wales|northern ireland|united kingdom|uk|great britain|gb)$/i;
const UK_GRAFSCHAFT =
  /(shire|^essex|^kent|^surrey|^sussex|^east sussex|^west sussex|^middlesex|^norfolk|^suffolk|^cornwall|^devon|^dorset|^somerset|^cumbria|^durham|^county durham|^merseyside|^greater london|^greater manchester|^west midlands|^east midlands|^tyne and wear|^west yorkshire|^south yorkshire|^north yorkshire|^east yorkshire|^rutland|^isle of wight)$/i;
const UK_PLZ = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

/** Wie structured-content adresseTeilen: Land und Grafschaft weg, doppelte Zeilen weg. */
export function ukAdresseTeilen(sitz: string): { street: string; houseNumber: string; zipCode: string; city: string } {
  let teile = sitz.split(",").map((t) => t.trim()).filter(Boolean);
  const plzIdx = teile.findIndex((t) => UK_PLZ.test(t));
  const plz = plzIdx >= 0 ? teile[plzIdx]! : "";
  if (plzIdx >= 0) teile.splice(plzIdx, 1);
  teile = teile.filter((t) => !UK_LAND.test(t));
  if (teile.length > 2 && UK_GRAFSCHAFT.test(teile[teile.length - 1]!)) teile.pop();
  const stadt = teile.length > 1 ? (teile.pop() as string) : "";
  const m = /^(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?)\s+(.+)$/.exec(teile[0] ?? "");
  const nummer = m ? m[1]! : "";
  if (m) teile[0] = m[2]!;
  const ohneDoppelte = teile.filter((t, i) => i === 0 || t.toLowerCase() !== teile[i - 1]!.toLowerCase());
  return { street: ohneDoppelte.join(", "), houseNumber: nummer, zipCode: plz, city: stadt };
}

export interface RegisterAdresse {
  street?: string | null;
  houseNumber?: string | null;
  zipCode?: string | null;
  city?: string | null;
}

/** Zwei Anzeigezeilen (leere fallen weg) in der Reihenfolge des Landes. */
export function adressZeilen(a: RegisterAdresse, land: RegisterLand): string[] {
  const t = (x?: string | null) => (x ?? "").trim();
  if (land === "UK") {
    const roh = [[t(a.houseNumber), t(a.street)].filter(Boolean).join(" "), t(a.city), t(a.zipCode)].filter(Boolean).join(", ");
    const u = ukAdresseTeilen(roh);
    return [[u.houseNumber, u.street].filter(Boolean).join(" "), [u.city, u.zipCode].filter(Boolean).join(" ")].filter(Boolean);
  }
  return [[t(a.street), t(a.houseNumber)].filter(Boolean).join(" "), [t(a.zipCode), t(a.city)].filter(Boolean).join(" ")].filter(Boolean);
}

/** Suchtext für Google Maps: Zeilen plus Landesname, damit gleichnamige Orte nicht verwechselt werden. */
export function kartenSuche(zeilen: string[], land: RegisterLand): string | null {
  const teile = zeilen.map((z) => z.trim()).filter(Boolean);
  if (teile.length === 0) return null;
  const name = LAND_NAME[land];
  const hatLand = teile.some((z) => z.toLowerCase().includes(name.toLowerCase()) || (land === "UK" && /\b(england|scotland|wales|uk)\b/i.test(z)));
  return [...teile, ...(hatLand ? [] : [name])].join(", ");
}
