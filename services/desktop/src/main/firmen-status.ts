// Firmenstatus in Klartext: Registerstatus, Insolvenzstatus und Liquidation
// aus dem Namen. Genutzt vom Status-Waechter (Meldungen) und von den
// Chat-Tools (Warnung an erster Stelle im Kontext).

export interface StatusQuelle {
  name?: string | null;
  registerStatus?: string | null;
  closedAt?: string | null;
  insolvencyStatus?: string | null;
  insolvencyAt?: string | null;
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
      out.push({ stufe: "warn", kurz: "Insolvenzverfahren", text: `Veröffentlichungen im Insolvenzportal${datum(f.insolvencyAt)}, Verfahrensstand unklar`, schluessel: "ins:VERDACHT" });
      break;
    case "AUFGEHOBEN":
      out.push({ stufe: "warn", kurz: "Insolvenz beendet", text: `Insolvenzverfahren aufgehoben oder eingestellt${datum(f.insolvencyAt)}`, schluessel: "ins:AUFGEHOBEN" });
      break;
    default:
      break;
  }
  if (f.registerStatus === "CLOSED") out.push({ stufe: "urgent", kurz: "gelöscht", text: `Registerblatt geschlossen, Firma im Handelsregister gelöscht${datum(f.closedAt)}`, schluessel: "reg:CLOSED" });
  else if (f.registerStatus === "LOESCHUNG_ANGEKUENDIGT") out.push({ stufe: "urgent", kurz: "in Löschung", text: "Löschung im Handelsregister angekündigt", schluessel: "reg:LOESCHUNG" });
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
