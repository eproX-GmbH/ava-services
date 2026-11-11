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
  if (source.startsWith("zuordnung:")) return "Firmenadresse, der Person zugeordnet";
  if (source.startsWith("user:")) return "vom Nutzer angegeben";
  return null;
}

// Belastbarkeit einer gespeicherten E-Mail-Adresse — die EINE Stelle dafuer
// (2026-11-10). Anlass: Eine vom Mailserver bestaetigte Muster-Adresse trug nur
// `emailAbgeleitet: true`; das Modell las „nicht bestaetigt“ und liess den
// Empfaenger im Mail-Entwurf leer. Der Status trennt die Frage „kann ich die
// Adresse verwenden?“ von der Herkunft (emailHerkunft): abgeleitet UND
// bestaetigt ist der Normalfall, kein Widerspruch.
export type EmailStatus = "bestätigt" | "wahrscheinlich" | "ungeprüft" | "abgelehnt";

const PRUEFUNG: Record<string, { status: EmailStatus; zusatz: string }> = {
  smtp: { status: "bestätigt", zusatz: "vom Mail-Server bestätigt" },
  reply: { status: "bestätigt", zusatz: "Antwort von dieser Adresse erhalten" },
  catchall: { status: "wahrscheinlich", zusatz: "Mail-Server nimmt jede Adresse an" },
  offen: { status: "ungeprüft", zusatz: "Prüfung beim Mail-Server nicht möglich" },
  abgelehnt: { status: "abgelehnt", zusatz: "vom Mail-Server abgelehnt" },
};
const pruefungVon = (source: string | null | undefined) => {
  const m = /^(?:pattern|zuordnung):(.+)$/.exec(source ?? "");
  // Unbekannte Pruefstufe einer Ableitung: vorsichtig wie „offen“ behandeln.
  return m ? (PRUEFUNG[m[1]!] ?? PRUEFUNG["offen"]!) : null;
};

/**
 * bestätigt = Mailserver-Pruefung, Antwort erhalten, Nutzerangabe oder gefunden
 * (Website, LinkedIn, Websuche); wahrscheinlich = Muster belegt, Server nimmt
 * alles an; ungeprüft = Muster belegt, Pruefung nicht moeglich; abgelehnt =
 * Server kennt die Adresse nicht.
 */
export function emailStatus(source: string | null | undefined): EmailStatus {
  return pruefungVon(source)?.status ?? "bestätigt";
}

/** Herkunft in Worten, bei Ableitungen samt Pruefergebnis („abgeleitet (E-Mail-Muster), vom Mail-Server bestätigt“). */
export function emailHerkunft(source: string | null | undefined): string | null {
  const gruppe = quellenGruppe(source) ?? (source || null);
  const pruefung = pruefungVon(source);
  return gruppe && pruefung ? `${gruppe}, ${pruefung.zusatz}` : gruppe;
}

/** Erklaerung fuer die Tool-Beschreibungen (kontakt_suchen, company_contacts): ein Wortlaut fuer alle. */
export const EMAIL_STATUS_HINWEIS =
  "emailStatus sagt, wie belastbar die Adresse ist: 'bestätigt' (Mailserver-Pruefung, Antwort erhalten, Nutzerangabe oder auf Website/LinkedIn gefunden) → ohne Vorbehalt verwenden; " +
  "'wahrscheinlich' (Adressmuster der Firma belegt, Mail-Server nimmt jede Adresse an) und 'ungeprüft' (Muster belegt, Pruefung nicht moeglich) → verwenden und die Herkunft in einem Satz nennen. " +
  "emailHerkunft nennt, woher die Adresse stammt. Eine aus dem Muster abgeleitete Adresse mit Status 'bestätigt' ist belegt, nicht geraten.";

const STATUS_RANG: Record<EmailStatus, number> = { "bestätigt": 3, wahrscheinlich: 2, "ungeprüft": 1, abgelehnt: 0 };

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export interface KompakteKontakte {
  firma: string | null;
  website: string | null;
  firmenkontakt: Record<string, string[]>;
  personen: Array<Record<string, string | string[]>>;
  anzahlPersonen: number;
  hinweis: string;
}

/**
 * Die belastbarste Adresse einer Person. Bei gleichem Status gewinnt die erste
 * (das Gateway sortiert Fakten dieser Firma nach vorn). Eine abgelehnte Adresse
 * erscheint nie als `email`, nur als `emailAbgelehnt`, wenn es keine andere gibt.
 */
function besteAdresse(liste: Array<{ wert: string; quelle: string | null }>): Record<string, string> {
  let beste: { wert: string; quelle: string | null; status: EmailStatus } | null = null;
  let abgelehnt: string | null = null;
  for (const a of liste) {
    const status = emailStatus(a.quelle);
    if (status === "abgelehnt") { abgelehnt ??= a.wert; continue; }
    if (!beste || STATUS_RANG[status] > STATUS_RANG[beste.status]) beste = { ...a, status };
  }
  if (beste) {
    const herkunft = emailHerkunft(beste.quelle);
    return { email: beste.wert, emailStatus: beste.status, ...(herkunft ? { emailHerkunft: herkunft } : {}) };
  }
  return abgelehnt ? { emailAbgelehnt: abgelehnt } : {};
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
  const adressen = new Map<string, Array<{ wert: string; quelle: string | null }>>();
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
    // Quelle der letzten Beobachtung: das Gateway liefert sie je Fakt mit; die
    // Beobachtungsliste ist der Rueckfall.
    const quelle = s(f["lastSource"]) ?? quelleJeBeobachtung.get(s(f["lastObsId"]) ?? "") ?? null;
    if (feld === "fullName") { if (!p["name"]) p["name"] = wert; }
    else if (feld === "email") {
      // Eine Person kann mehrere Adressen tragen (gefunden, abgeleitet, abgelehnt):
      // erst sammeln, unten die belastbarste waehlen.
      const liste = adressen.get(pid) ?? [];
      if (!liste.some((a) => a.wert.toLowerCase() === wert.toLowerCase())) liste.push({ wert, quelle });
      adressen.set(pid, liste);
      personen.set(pid, p);
      continue; // Herkunft der Adresse steht in emailHerkunft, nicht in `quelle`
    } else {
      const k = PERSONEN_FELDER[feld];
      if (!k) continue;
      // Fakten dieser Firma kommen zuerst (Sortierung im Gateway): erster Wert gewinnt.
      if (!p[k]) p[k] = k === "beschreibung" ? wert.slice(0, 200) : wert;
    }
    personen.set(pid, p);
    const q = quellenGruppe(quelle);
    if (q) { const set = quellen.get(pid) ?? new Set<string>(); set.add(q); quellen.set(pid, set); }
  }
  const liste = [...personen.values()]
    .filter((p) => p["name"])
    .map((p) => {
      const pid = String(p["personId"]);
      const q = quellen.get(pid);
      return { ...p, ...besteAdresse(adressen.get(pid) ?? []), ...(q ? { quelle: [...q] } : {}) };
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
