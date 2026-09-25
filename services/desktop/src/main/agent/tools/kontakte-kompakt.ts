// Kompakte Kontaktansicht fuer das Modell (2026-09-25).
//
// Anlass: company_contacts gab die Rohdaten des Gateways zurueck — alle
// Fakten, Beobachtungen (Belegketten), Signale (Verlauf) und Beschaeftigungen.
// Bei einer grossen Firma waren das 865 KB; ein einziger Modellaufruf kostete
// 1,35 $. Das Modell braucht fuer fast jede Frage nur: wer, welche Rolle, wie
// erreichbar, woher. Belege und Verlauf gibt es nur auf ausdrueckliche
// Nachfrage (Parameter `mitBelegen`).

type Zeile = Record<string, unknown>;

const PERSONEN_FELDER: Record<string, string> = {
  jobTitle: "rolle",
  department: "abteilung",
  email: "email",
  phone: "telefon",
  mobilePhone: "mobil",
  linkedinUrl: "linkedin",
  xingUrl: "xing",
  employmentSince: "seit",
  websiteBeschreibung: "beschreibung",
};
const FIRMEN_FELDER: Record<string, string> = {
  email: "emails",
  phone: "telefon",
  address: "adressen",
  fax: "fax",
};

/** Quellwert des Producers → lesbare Gruppe (wie an der Personenkarte). */
export function quellenGruppe(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source.startsWith("apify:")) return "LinkedIn";
  if (source.startsWith("search") || source.startsWith("valueserp:")) return "Websuche";
  if (source === "agent:datenschutz") return "Datenschutzerklärung";
  if (source.startsWith("agent:")) return "Firmenwebsite";
  if (source.startsWith("pattern:")) return "abgeleitet (E-Mail-Muster)";
  return null;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export interface KompakteKontakte {
  firma: string | null;
  website: string | null;
  firmenkontakt: Record<string, string[]>;
  personen: Array<Record<string, string | string[]>>;
  anzahlPersonen: number;
  hinweis: string;
}

export function kompakteKontakte(roh: Zeile, maxPersonen = 60): KompakteKontakte {
  const fakten = (Array.isArray(roh["companyFacts"]) ? roh["companyFacts"] : []) as Zeile[];
  const beobachtungen = (Array.isArray(roh["companyObservations"]) ? roh["companyObservations"] : []) as Zeile[];
  const beschaeftigt = (Array.isArray(roh["employments"]) ? roh["employments"] : []) as Zeile[];
  const quelleJeBeobachtung = new Map<string, string>();
  for (const o of beobachtungen) { const id = s(o["id"]); const src = s(o["source"]); if (id && src) quelleJeBeobachtung.set(id, src); }
  // Ausgeschieden = KEINE aktuelle Position mehr bei dieser Firma. Eine
  // Person hat oft mehrere Zeilen (alte und neue Rolle); eine alte Zeile
  // mit isCurrent false heisst nicht, dass sie weg ist.
  const aktuell = new Set(beschaeftigt.filter((e) => e["isCurrent"] !== false).map((e) => s(e["personId"])).filter((x): x is string => !!x));

  const firmenkontakt: Record<string, string[]> = {};
  const personen = new Map<string, Record<string, string | string[]>>();
  const quellen = new Map<string, Set<string>>();
  for (const f of fakten) {
    if (s(f["status"]) && f["status"] !== "ACTIVE") continue;
    const feld = s(f["field"]); const wert = s(f["value"]);
    if (!feld || !wert) continue;
    const typ = s(f["entityType"]);
    if (typ === "COMPANY") {
      const k = FIRMEN_FELDER[feld];
      if (!k) continue;
      const liste = (firmenkontakt[k] ??= []);
      if (!liste.includes(wert) && liste.length < 8) liste.push(wert);
      continue;
    }
    if (typ !== "PERSON") continue;
    const pid = s(f["entityId"]) ?? s(f["personId"]);
    if (!pid) continue;
    if (aktuell.size > 0 && !aktuell.has(pid)) continue;
    const p = personen.get(pid) ?? { personId: pid };
    if (feld === "fullName") { if (!p["name"]) p["name"] = wert; }
    else {
      const k = PERSONEN_FELDER[feld];
      if (!k) continue;
      // Fakten dieser Firma kommen zuerst (Sortierung im Gateway): erster Wert gewinnt.
      if (!p[k]) p[k] = k === "beschreibung" ? wert.slice(0, 200) : wert;
    }
    personen.set(pid, p);
    const q = quellenGruppe(quelleJeBeobachtung.get(s(f["lastObsId"]) ?? "") ?? null);
    if (q) { const set = quellen.get(pid) ?? new Set<string>(); set.add(q); quellen.set(pid, set); }
  }
  const liste = [...personen.values()]
    .filter((p) => p["name"])
    .map((p) => {
      const q = quellen.get(String(p["personId"]));
      return q ? { ...p, quelle: [...q] } : p;
    });
  return {
    firma: s(roh["companyName"]),
    website: s(roh["websiteUrl"]),
    firmenkontakt,
    personen: liste.slice(0, maxPersonen),
    anzahlPersonen: liste.length,
    hinweis: liste.length > maxPersonen
      ? `Gekürzt auf ${maxPersonen} von ${liste.length} Personen. Belegketten und Verlauf nur auf ausdrückliche Nachfrage (mitBelegen: true).`
      : "Belegketten und Verlauf nur auf ausdrückliche Nachfrage (mitBelegen: true).",
  };
}
