// Firmenlogos (docs/PLAN_FIRMENLOGOS.md, LG3): ein Baustein fuer alle Stellen, an denen AVA eine
// Firma zeigt. Die Website-Stufe liefert bis zu zwei Bilder: ein quadratisches Zeichen und eine
// breite Wortmarke. In die quadratische Flaeche kommt das Zeichen, sonst die eingepasste
// Wortmarke, sonst das kleine Favicon, sonst das Kuerzel aus Buchstaben.
//
// Die Bilder kommen ueber `ava-logo://<sha256>` (Hauptprozess, main/logo-cache.ts). Immer auf
// heller Flaeche, auch im dunklen Design: Die meisten Logos sind fuer weissen Grund gemacht.

import { useState, type CSSProperties, type ReactNode } from "react";
import { kuerzel } from "./chat/gen-ui/firmenprofil-daten";
import { useFirmenLogos } from "../lib/firmen-logos-laden";

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

/** Innenrand der Flaeche um ein eingepasstes Bild, in px. */
const RAND = 4;
/** Unter dieser Hoehe ist eine eingepasste Wortmarke nicht mehr lesbar. */
const WORTMARKE_MIN_HOEHE = 11;

/**
 * Welches Bild in die Flaeche gehoert. Ohne Angaben gilt die grosse Flaeche (44 px, quadratisch).
 *
 * 1. ein gutes Zeichen (ab 64 px),
 * 2. die Wortmarke, wenn die Flaeche breit werden darf,
 * 3. ein kleines Zeichen, das fuer DIESE Flaeche trotzdem genug Bildpunkte hat (48-px-Icon in
 *    einer 34-px-Zeile einer Liste),
 * 4. die Wortmarke eingepasst, solange sie lesbar bleibt (577x118 in 34 px waere 5 px hoch),
 * 5. das kleine Zeichen in echter Groesse,
 * sonst nichts: Dann zeigt der Baustein das Kuerzel.
 */
export function logoFuerFlaeche(
  logos: FirmenLogos,
  { groesse = 44, breit = false }: { groesse?: number; breit?: boolean } = {},
): { logo: LogoAngabe; art: "zeichen" | "wortmarke" | "klein" } | null {
  const z = logos?.zeichen ?? null;
  const w = logos?.wortmarke ?? null;
  const gueltig = (l: LogoAngabe | null): l is LogoAngabe => Boolean(l && /^[0-9a-f]{64}$/.test(l.sha256));
  if (gueltig(z) && !z.klein) return { logo: z, art: "zeichen" };
  if (gueltig(w) && breit) return { logo: w, art: "wortmarke" };
  if (gueltig(z) && z.breite >= groesse - 2 * RAND) return { logo: z, art: "zeichen" };
  if (gueltig(w)) {
    const verhaeltnis = w.breite > 0 && w.hoehe > 0 ? Math.max(1, w.breite / w.hoehe) : 2.4;
    if ((groesse - 2 * RAND) / verhaeltnis >= WORTMARKE_MIN_HOEHE) return { logo: w, art: "wortmarke" };
  }
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
  laedt = false,
}: {
  logos: FirmenLogos;
  name: string | null | undefined;
  /** Kantenlaenge der Flaeche in px. */
  groesse?: number;
  /** true = ohne Logo gar nichts zeigen (statt des Kuerzels). */
  ohneRueckfall?: boolean;
  /** true = eine Wortmarke darf eine breitere Flaeche bekommen (Kopf von Profil und Firmenansicht). */
  breit?: boolean;
  /** true = die Angaben sind noch unterwegs: leere Flaeche statt Kuerzel. */
  laedt?: boolean;
}) {
  const wahl = logoFuerFlaeche(logos, { groesse, breit });
  const [kaputt, setKaputt] = useState<string | null>(null);
  // Kleine Flaechen (Zeile einer Tabelle) bekommen kleinere Ecken, sonst wirken sie wie Punkte.
  const flaeche = { ...flaechenMasse(wahl && kaputt !== wahl.logo.sha256 ? wahl : null, groesse, breit), borderRadius: Math.min(8, Math.round(groesse * 0.22)) };
  if (!wahl || kaputt === wahl.logo.sha256) {
    if (ohneRueckfall) return null;
    if (laedt) return <span className="firmenlogo firmenlogo--laedt" style={flaeche} aria-hidden="true" />;
    return (
      <span className="firmenlogo firmenlogo--kuerzel" style={{ ...flaeche, fontSize: Math.max(9, Math.round(groesse * 0.36)) }} aria-hidden="true">
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

/** Logo einer Firma, von der nur die Kennung bekannt ist (Listen, Bausteine im Chat). */
export function FirmenLogoVon({
  companyId,
  logos,
  ...rest
}: { companyId: string | null | undefined; logos?: FirmenLogos } & Omit<Parameters<typeof FirmenLogo>[0], "logos">) {
  const stand = useFirmenLogos(companyId, logos);
  return <FirmenLogo logos={stand.logos} laedt={stand.laedt} {...rest} />;
}

/**
 * Logo links, daneben Name und Unterzeile. Die Logo-Flaeche ist so hoch wie die beiden Zeilen
 * zusammen: Ihre Oberkante liegt auf der Oberkante der Grossbuchstaben des Namens, ihre
 * Unterkante auf der Grundlinie der Unterzeile (Befund Joyce 2026-11-27). Die erste Zeile im
 * Text bekommt dafuer die Klasse `logo-zeile__oben`, die letzte `logo-zeile__unten`; gibt es
 * nur eine Zeile, bekommt sie beide und steht mittig.
 */
export function LogoZeile({
  logo,
  hoehe,
  className,
  children,
}: {
  logo: ReactNode;
  /** Hoehe der Logo-Flaeche in px; muss zur `groesse` des Logos passen. */
  hoehe: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `logo-zeile ${className}` : "logo-zeile"} style={{ "--logo-hoehe": `${hoehe}px` } as CSSProperties}>
      {logo}
      <div className="logo-zeile__text">{children}</div>
    </div>
  );
}

