// Register-Delta — Kennzeichnung geschlossener oder in Loeschung befindlicher
// Registerblaetter (master-data GermanCompany.registerStatus). Ueberall dort,
// wo eine Firma erscheint: Suche, Meine Firmen, Vorgaenge, Firmendetails.

export function registerStatusText(status: string | null | undefined): string | null {
  if (status === "CLOSED") return "gelöscht";
  if (status === "LOESCHUNG_ANGEKUENDIGT") return "in Löschung";
  return null;
}

export function RegisterStatusBadge({ status, closedAt }: { status: string | null | undefined; closedAt?: string | null }) {
  const text = registerStatusText(status);
  if (!text) return null;
  const titel =
    status === "CLOSED"
      ? `Registerblatt geschlossen${closedAt ? ` (gesehen am ${new Date(closedAt).toLocaleDateString("de-DE")})` : ""}`
      : "Löschung im Handelsregister angekündigt";
  return (
    <span className={`badge ${status === "CLOSED" ? "bad" : "warn"}`} title={titel} style={{ marginLeft: "0.4rem", verticalAlign: "middle" }}>
      {text}
    </span>
  );
}

// Insolvenz-Delta — Chip zum Insolvenzstatus (master-data GermanCompany.insolvencyStatus).
export function insolvenzText(status: string | null | undefined): { text: string; ton: "bad" | "warn" | "muted" } | null {
  switch (status) {
    case "EROEFFNET":
      return { text: "insolvent", ton: "bad" };
    case "SICHERUNG":
      return { text: "Insolvenzantrag", ton: "bad" };
    case "VERDACHT":
      return { text: "Insolvenzverfahren", ton: "warn" };
    case "ABGEWIESEN":
      return { text: "Insolvenz abgewiesen", ton: "warn" };
    case "AUFGEHOBEN":
      return { text: "Insolvenz beendet", ton: "muted" };
    default:
      return null;
  }
}

const INSOLVENZ_TITEL: Record<string, string> = {
  EROEFFNET: "Insolvenzverfahren eröffnet",
  SICHERUNG: "Sicherungsmaßnahmen im Insolvenzantragsverfahren (vorläufiger Insolvenzverwalter)",
  VERDACHT: "Veröffentlichungen im Insolvenzportal, Verfahrensstand unklar",
  ABGEWIESEN: "Insolvenzantrag mangels Masse abgewiesen",
  AUFGEHOBEN: "Insolvenzverfahren aufgehoben oder eingestellt",
};

export function InsolvenzBadge({ status, seit }: { status: string | null | undefined; seit?: string | null }) {
  const t = insolvenzText(status);
  if (!t) return null;
  const titel = `${INSOLVENZ_TITEL[status as string] ?? ""}${seit ? ` (seit ${new Date(seit).toLocaleDateString("de-DE")})` : ""}`;
  return (
    <span className={`badge ${t.ton === "muted" ? "" : t.ton}`} title={titel} style={{ marginLeft: "0.4rem", verticalAlign: "middle" }}>
      {t.text}
    </span>
  );
}

// Laenderspalten (docs/PLAN_OESTERREICH.md): Land und amtliche Registerkennung.
// Deutschland ist der Normalfall und bekommt keinen Chip; Oesterreich und die
// Schweiz werden markiert, weil Register, Nummernsystem und Quellen abweichen.
const LAND_TEXT: Record<string, { kurz: string; lang: string; register: string }> = {
  AT: { kurz: "AT", lang: "Österreich", register: "Firmenbuch" },
  CH: { kurz: "CH", lang: "Schweiz", register: "Handelsregister" },
};

export function LandBadge({ country }: { country: string | null | undefined }) {
  const l = country ? LAND_TEXT[country] : undefined;
  if (!l) return null;
  return (
    <span className="badge" title={`${l.lang} (${l.register})`} style={{ marginLeft: "0.4rem", verticalAlign: "middle" }}>
      {l.kurz}
    </span>
  );
}

/** "HRB 17968" (DE), "FN 56247t" (AT), "CHE-101.602.521" (CH); null ohne Nummer. */
export function registerKennung(c: { country?: string | null; registerType?: string | null; registerNumber?: string | null }): string | null {
  const nr = (c.registerNumber ?? "").trim();
  if (!nr) return null;
  const art = (c.registerType ?? "").trim();
  if (c.country === "CH") return nr;
  return art ? `${art} ${nr}` : nr;
}

/** Registerzeile fuer Details: Kennung, Gericht, Rechtsform. */
export function registerZeile(c: { country?: string | null; registerType?: string | null; registerNumber?: string | null; districtCourt?: string | null; legalForm?: string | null }): string | null {
  const teile = [registerKennung(c), (c.districtCourt ?? "").trim() || null, (c.legalForm ?? "").trim() || null].filter((t): t is string => Boolean(t));
  return teile.length > 0 ? teile.join(" · ") : null;
}
