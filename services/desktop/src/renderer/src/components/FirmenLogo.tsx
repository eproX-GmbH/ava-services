// Firmenlogos (docs/PLAN_FIRMENLOGOS.md, LG3): ein Baustein fuer alle Stellen, an denen AVA eine
// Firma zeigt. Die Website-Stufe liefert bis zu zwei Bilder: ein quadratisches Zeichen und eine
// breite Wortmarke. In die quadratische Flaeche kommt das Zeichen, sonst die eingepasste
// Wortmarke, sonst das kleine Favicon, sonst das Kuerzel aus Buchstaben.
//
// Die Bilder kommen ueber `ava-logo://<sha256>` (Hauptprozess, main/logo-cache.ts). Immer auf
// heller Flaeche, auch im dunklen Design: Die meisten Logos sind fuer weissen Grund gemacht.

import { useState } from "react";
import { kuerzel } from "./chat/gen-ui/firmenprofil-daten";

export interface LogoAngabe {
  sha256: string;
  mime?: string;
  breite: number;
  hoehe: number;
  /** Zeichen unter 64 px (Favicon als letzter Ausweg). */
  klein: boolean;
  stufe?: string;
}

export type FirmenLogos = { zeichen?: LogoAngabe | null; wortmarke?: LogoAngabe | null } | null | undefined;

/** Welches Bild in eine quadratische Flaeche gehoert. */
export function logoFuerFlaeche(logos: FirmenLogos): { logo: LogoAngabe; art: "zeichen" | "wortmarke" | "klein" } | null {
  const z = logos?.zeichen ?? null;
  const w = logos?.wortmarke ?? null;
  const gueltig = (l: LogoAngabe | null): l is LogoAngabe => Boolean(l && /^[0-9a-f]{64}$/.test(l.sha256));
  if (gueltig(z) && !z.klein) return { logo: z, art: "zeichen" };
  if (gueltig(w)) return { logo: w, art: "wortmarke" };
  if (gueltig(z)) return { logo: z, art: "klein" };
  return null;
}

/**
 * Masse der Flaeche. Quadratisch, ausser `breit` ist erlaubt und es gibt nur eine Wortmarke:
 * Dann waechst die Flaeche in die Breite (hoechstens 3,2-fach), sonst waere eine Wortmarke wie
 * 577x118 in 44 px nur noch 7 px hoch.
 */
export function flaechenMasse(wahl: { logo: LogoAngabe; art: string } | null, groesse: number, breit: boolean): { width: number; height: number } {
  if (!wahl || wahl.art !== "wortmarke" || !breit) return { width: groesse, height: groesse };
  const { breite, hoehe } = wahl.logo;
  const verhaeltnis = breite > 0 && hoehe > 0 ? Math.min(3.2, Math.max(1, breite / hoehe)) : 2.4;
  return { width: Math.round(groesse * verhaeltnis), height: groesse };
}

export function FirmenLogo({
  logos,
  name,
  groesse = 44,
  ohneRueckfall = false,
  breit = false,
}: {
  logos: FirmenLogos;
  name: string | null | undefined;
  /** Kantenlaenge der Flaeche in px. */
  groesse?: number;
  /** true = ohne Logo gar nichts zeigen (statt des Kuerzels). */
  ohneRueckfall?: boolean;
  /** true = eine Wortmarke darf eine breitere Flaeche bekommen (Kopf von Profil und Firmenansicht). */
  breit?: boolean;
}) {
  const wahl = logoFuerFlaeche(logos);
  const [kaputt, setKaputt] = useState<string | null>(null);
  const flaeche = flaechenMasse(wahl && kaputt !== wahl.logo.sha256 ? wahl : null, groesse, breit);
  if (!wahl || kaputt === wahl.logo.sha256) {
    if (ohneRueckfall) return null;
    return (
      <span className="firmenlogo firmenlogo--kuerzel" style={{ ...flaeche, fontSize: Math.max(11, Math.round(groesse * 0.36)) }} aria-hidden="true">
        {kuerzel(name)}
      </span>
    );
  }
  // Ein 16-px-Favicon auf 44 px gezogen wird Matsch: kleine Bilder in echter Groesse zeigen.
  const echteGroesse =
    wahl.art === "klein" && wahl.logo.breite > 0
      ? { width: Math.min(wahl.logo.breite, groesse - 8), height: Math.min(wahl.logo.hoehe || wahl.logo.breite, groesse - 8) }
      : undefined;
  return (
    <span className={`firmenlogo firmenlogo--${wahl.art}`} style={flaeche}>
      <img src={`ava-logo://${wahl.logo.sha256}`} alt="" loading="lazy" decoding="async" draggable={false} style={echteGroesse} onError={() => setKaputt(wahl.logo.sha256)} />
    </span>
  );
}
