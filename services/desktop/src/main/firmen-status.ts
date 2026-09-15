// Firmenstatus in Klartext: Registerstatus, Insolvenzstatus und Liquidation
// aus dem Namen. Genutzt vom Status-Waechter (Meldungen) und von den
// Chat-Tools (Warnung an erster Stelle im Kontext).

export interface StatusQuelle {
  name?: string | null;
  registerStatus?: string | null;
  closedAt?: string | null;
  insolvencyStatus?: string | null;
  insolvencyAt?: string | null;
  /** DE | AT | CH (Laenderspalten); fehlt = DE. */
  country?: string | null;
  registerType?: string | null;
  registerNumber?: string | null;
  districtCourt?: string | null;
  legalForm?: string | null;
}

type LandInfo = { name: string; register: string; insolvenzquelle: string };
const LAND_DE: LandInfo = { name: "Deutschland", register: "Handelsregister", insolvenzquelle: "Insolvenzportal" };
const LAND: Record<string, LandInfo> = {
  DE: LAND_DE,
  AT: { name: "Österreich", register: "Firmenbuch", insolvenzquelle: "Ediktsdatei (Insolvenzdatei)" },
  CH: { name: "Schweiz", register: "Handelsregister", insolvenzquelle: "SHAB" },
};

function land(f: StatusQuelle): LandInfo {
  return LAND[f.country ?? "DE"] ?? LAND_DE;
}

/** "HRB 17968" (DE), "FN 56247t" (AT), CHE-Nummer (CH); null ohne Nummer. */
export function registerKennung(f: StatusQuelle): string | null {
  const nr = (f.registerNumber ?? "").trim();
  if (!nr) return null;
  const art = (f.registerType ?? "").trim();
  return f.country === "CH" || !art ? nr : `${art} ${nr}`;
}

/**
 * Eine Zeile Land und Register fuer den Chat-Kontext, z. B.
 * "Österreich, Firmenbuch FN 56247t, Landesgericht Salzburg, Gesellschaft mit beschränkter Haftung".
 * Fuer deutsche Firmen nur, wenn eine Registernummer bekannt ist.
 */
export function landText(f: StatusQuelle): string | null {
  const l = land(f);
  const kennung = registerKennung(f);
  const teile = [l.name, kennung ? `${l.register} ${kennung}` : null, (f.districtCourt ?? "").trim() || null, (f.legalForm ?? "").trim() || null].filter((t): t is string => Boolean(t));
  if ((f.country ?? "DE") === "DE" && !kennung) return null;
  return teile.join(", ");
}

export interface StatusWarnung {
  /** "urgent" = insolvent, geloescht, in Loeschung; "warn" = Verdacht, abgewiesen, aufgehoben, Liquidation */
  stufe: "urgent" | "warn";
  kurz: string;
  text: string;
  schluessel: string;
}

function datum(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : ` (seit ${d.toLocaleDateString("de-DE")})`;
}

const LIQUIDATION_RE = /\b(i\.\s?L\.|in Liquidation|in Liqu\.|i\.\s?Abw\.|in Abwicklung)\b/i;

/** Alle Warnungen zu einer Firma, schwerste zuerst. Leer = nichts Auffaelliges. */
export function firmenStatusWarnungen(f: StatusQuelle): StatusWarnung[] {
  const out: StatusWarnung[] = [];
  switch (f.insolvencyStatus) {
    case "EROEFFNET":
      out.push({ stufe: "urgent", kurz: "insolvent", text: `Insolvenzverfahren eröffnet${datum(f.insolvencyAt)}`, schluessel: "ins:EROEFFNET" });
      break;
    case "SICHERUNG":
      out.push({ stufe: "urgent", kurz: "Insolvenzantrag", text: `Insolvenzantrag mit Sicherungsmaßnahmen, vorläufiger Insolvenzverwalter${datum(f.insolvencyAt)}`, schluessel: "ins:SICHERUNG" });
      break;
    case "ABGEWIESEN":
      out.push({ stufe: "warn", kurz: "Insolvenz mangels Masse abgewiesen", text: `Insolvenzantrag mangels Masse abgewiesen${datum(f.insolvencyAt)}; die Firma ist in aller Regel zahlungsunfähig`, schluessel: "ins:ABGEWIESEN" });
      break;
    case "VERDACHT":
      out.push({ stufe: "warn", kurz: "Insolvenzverfahren", text: `Veröffentlichungen im ${land(f).insolvenzquelle}${datum(f.insolvencyAt)}, Verfahrensstand unklar`, schluessel: "ins:VERDACHT" });
      break;
    case "AUFGEHOBEN":
      out.push({ stufe: "warn", kurz: "Insolvenz beendet", text: `Insolvenzverfahren aufgehoben oder eingestellt${datum(f.insolvencyAt)}`, schluessel: "ins:AUFGEHOBEN" });
      break;
    default:
      break;
  }
  if (f.registerStatus === "CLOSED") out.push({ stufe: "urgent", kurz: "gelöscht", text: `Registerblatt geschlossen, Firma im ${land(f).register} gelöscht${datum(f.closedAt)}`, schluessel: "reg:CLOSED" });
  else if (f.registerStatus === "LOESCHUNG_ANGEKUENDIGT") out.push({ stufe: "urgent", kurz: "in Löschung", text: `Löschung im ${land(f).register} angekündigt`, schluessel: "reg:LOESCHUNG" });
  if (f.name && LIQUIDATION_RE.test(f.name)) out.push({ stufe: "warn", kurz: "in Liquidation", text: "Firma befindet sich laut Firmenname in Liquidation oder Abwicklung", schluessel: "name:LIQUIDATION" });
  out.sort((a, b) => (a.stufe === b.stufe ? 0 : a.stufe === "urgent" ? -1 : 1));
  return out;
}

/** Eine Zeile fuer den Chat-Kontext oder null. */
export function statusWarnungText(f: StatusQuelle): string | null {
  const w = firmenStatusWarnungen(f);
  if (w.length === 0) return null;
  return `ACHTUNG ${w.map((x) => x.kurz.toUpperCase()).join(", ")}: ${w.map((x) => x.text).join("; ")}.`;
}
