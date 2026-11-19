// Firmenhistorie (docs/PLAN_FIRMEN_HISTORIE.md, H1): Jobtitel → Rollengruppe und Ebene.
//
// Zweck: echte Personalwechsel von Umformulierungen trennen. „Technischer Vertrieb“ →
// „Technischer Vertrieb Innendienst“ ist derselbe Job (Vertrieb, Mitarbeit); „Vertriebsingenieur“
// → „Vertriebsleitung“ ist ein Aufstieg (Vertrieb, Mitarbeit → Leitung). Feste Woerterliste,
// deutsch und englisch, an 4.291 echten Titeln geprueft (H0, 2026-11-19). Was nicht sicher
// passt, ist „sonstige“ und zaehlt nie als Wechsel.

export type Rollengruppe =
  | "geschaeftsfuehrung"
  | "aufsicht"
  | "vertrieb"
  | "marketing"
  | "einkauf"
  | "it"
  | "personal"
  | "finanzen"
  | "technik"
  | "service"
  | "sonstige";
export type Ebene = "leitung" | "mitarbeit";

export const ROLLENGRUPPEN: Record<Rollengruppe, string> = {
  geschaeftsfuehrung: "Geschäftsführung",
  aufsicht: "Aufsichtsrat und Beirat",
  vertrieb: "Vertrieb",
  marketing: "Marketing",
  einkauf: "Einkauf",
  it: "IT und Digitales",
  personal: "Personal",
  finanzen: "Finanzen",
  technik: "Technik und Produktion",
  service: "Service",
  sonstige: "Sonstige",
};

function falten(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[-_/|·,;:()&+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Reihenfolge zaehlt: C-Titel mit Fachbezug vor der allgemeinen Geschaeftsfuehrung, damit
// „CSO“ Vertrieb (Leitung) ist und nicht Geschaeftsfuehrung.
const C_TITEL: Array<[RegExp, Rollengruppe]> = [
  [/\b(cso|cro|chief (sales|revenue|commercial) officer)\b/, "vertrieb"],
  [/\b(cmo|chief marketing officer)\b/, "marketing"],
  [/\b(cpo|chief (procurement|purchasing) officer)\b/, "einkauf"],
  [/\b(cio|cto|cdo|ciso|chief (information|technology|digital|data|information security) officer)\b/, "it"],
  [/\b(chro|chief (people|human resources|hr) officer)\b/, "personal"],
  [/\b(cfo|chief financial officer)\b/, "finanzen"],
  [/\b(coo|chief operating officer)\b/, "technik"],
];

// Assistenz und Sekretariat nennen oft die Geschaeftsleitung, sind aber keine Fuehrungsrolle.
const ASSISTENZ = /\b(assistent\w*|assistenz\w*|sekretaer\w*|sekretariat|office manager\w*|executive assistant|personal assistant|referent\w* der geschaeftsfuehrung|referent\w* der geschaeftsleitung)\b/;

const AUFSICHT = /\b(aufsichtsrat\w*|aufsichtsrats\w*|supervisory board|supervisory|chairman of the supervisory board|beirat\w*|beiraete|advisory board|verwaltungsrat\w*)\b/;

const GF = /\b(executive director|geschaeftsfuehrende\w* direktor\w*|geschaeftsfuehr\w*|managing director|general manager|ceo|chief executive( officer)?|vorstand\w*|vorstands\w*|inhaber\w*|owner|founder|co founder|gruender\w*|mitgruender\w*|praesident\w*|president|geschaeftsleitung|geschaeftsleiter\w*|board member|member of the (executive )?board|executive board|managing partner|gesellschafter geschaeftsfuehr\w*)\b/;

// Fachgruppen; die erste passende gewinnt.
const GRUPPEN: Array<[RegExp, Rollengruppe]> = [
  [/\b(vertrieb\w*|verkauf\w*|verkaeufer\w*|sales|account (manager|executive|director)|key account\w*|business development|bizdev|aussendienst\w*|innendienst\w*|gebietsleit\w*|gebietsverkaufsleit\w*|kundenberat\w*|kundenbetreu\w*|vertriebs\w*|revenue|presales|pre sales)\b/, "vertrieb"],
  [/\b(marketing\w*|kommunikation\w*|communications?|pr|public relations|brand\w*|content|social media|pressesprecher\w*|werbung)\b/, "marketing"],
  [/\b(einkauf\w*|einkaeufer\w*|beschaffung\w*|purchas\w*|procurement|buyer|supply chain|disponent\w*|disposition)\b/, "einkauf"],
  [/\b(it|edv|informatik\w*|software\w*|softwareentwickl\w*|developer|entwickler software|devops|cloud|data|daten\w*|digital\w*|digitalisierung|system administrator|systemadministr\w*|sysadmin|it leiter|ciso|netzwerk\w*|anwendungsentwickl\w*|fullstack|full stack|frontend|backend|programmier\w*|sap)\b/, "it"],
  [/\b(personal\w*|hr|human resources|recruit\w*|people|talent\w*|personalleit\w*|ausbild\w*)\b/, "personal"],
  [/\b(finanz\w*|buchhalt\w*|controlling|controller\w*|accounting|accountant|kaufmaennisch\w*|steuer\w*|treasury|bilanz\w*|finance|lohn\w*)\b/, "finanzen"],
  [/\b(service\w*|kundendienst\w*|support|customer success|after sales|servicetechnik\w*|helpdesk)\b/, "service"],
  [/\b(produktion\w*|fertigung\w*|technik\w*|technical|engineer\w*|engineering|ingenieur\w*|konstrukt\w*|entwicklung\w*|forschung\w*|qualitaet\w*|quality|operations|werk\w*|logistik\w*|montage\w*|instandhalt\w*|betriebsleit\w*|r d|research)\b/, "technik"],
];

const LEITUNG = /\b(leiter\w*|leitung|head|director|direktor\w*|chief|vp|vice president|svp|evp|teamleit\w*|bereichsleit\w*|abteilungsleit\w*|gesamtleit\w*|prokurist\w*|lead|principal|geschaeftsfuehr\w*|vorstand\w*|ceo|managing director|general manager|inhaber\w*|owner|founder|gruender\w*|praesident\w*|president|cso|cro|cmo|cio|cto|cfo|coo|chro|cpo|cdo|ciso|[a-z]+leiter\w*|[a-z]+leitung)\b/;

const GEBIET = /\b(gebiets\w*|regional\w*|bezirks\w*|area|territory|district)\b/;
const OBERE_LEITUNG = /\b(head|director|direktor\w*|vp|vice president|chief|gesamtleit\w*|bereichsleit\w*)\b/;

export interface Rolle {
  gruppe: Rollengruppe;
  ebene: Ebene;
}

export function rolleEinordnen(titel: string | null | undefined): Rolle {
  if (!titel || !titel.trim()) return { gruppe: "sonstige", ebene: "mitarbeit" };
  const t = falten(titel);
  if (ASSISTENZ.test(t)) return { gruppe: "sonstige", ebene: "mitarbeit" };
  if (AUFSICHT.test(t)) return { gruppe: "aufsicht", ebene: "leitung" };
  for (const [re, gruppe] of C_TITEL) if (re.test(t)) return { gruppe, ebene: "leitung" };
  // „Vice President HR“ ist Bereichsleitung, „Product Owner“ Fachrolle, beides nicht
  // Geschaeftsfuehrung (sonst traefen „president“ und „owner“).
  const ohneScheinleitung = t.replace(/\b(vice|senior vice|executive vice) president\b|\b(solution|product|produkt|process|prozess|service|business|data|budget|system|application|account|content|feature)s? owner\b/g, " ");
  if (GF.test(ohneScheinleitung)) return { gruppe: "geschaeftsfuehrung", ebene: "leitung" };
  // Gebiets- und Regionalleiter im Vertrieb sind Aussendienst, keine Bereichsleitung
  // („Gebietsverkaufsleiter“ → „Sales Manager Süd-West“ ist derselbe Job, H1-Probe).
  const gebiet = GEBIET.test(t) && !OBERE_LEITUNG.test(t);
  const ebene: Ebene = (LEITUNG.test(ohneScheinleitung) || OBERE_LEITUNG.test(t)) && !gebiet ? "leitung" : "mitarbeit";
  for (const [re, gruppe] of GRUPPEN) if (re.test(t)) return { gruppe, ebene };
  return { gruppe: "sonstige", ebene };
}

/** Ist der Titelwechsel ein echter Wechsel (Gruppe oder Ebene anders), nicht nur Umformulierung? */
export function echterRollenwechsel(vorher: string | null | undefined, nachher: string | null | undefined): boolean {
  const a = rolleEinordnen(vorher);
  const b = rolleEinordnen(nachher);
  // Nur wenn beide Titel sicher eingeordnet sind: Ein unklarer alter Titel („Mitarbeiter mit
  // Erfahrung bei …“) ist meist nur ein besser gelesenes Profil, kein Wechsel (H0).
  if (a.gruppe === "sonstige" || b.gruppe === "sonstige") return false;
  return a.gruppe !== b.gruppe || a.ebene !== b.ebene;
}

const PENDEL_TAG = 86_400_000;
const PENDEL_TAGE = 120;

/** Pendel-Wechsel entfernen: A→B und spaeter B→A (gleiche Gruppe und Ebene) binnen 120 Tagen. */
export function pendelEntfernen<T extends { personId: string | null; zeitpunkt: string; gruppe: Rollengruppe; ebene: Ebene; gruppeVorher: Rollengruppe | null; ebeneVorher: Ebene | null }>(liste: T[]): T[] {
  const weg = new Set<T>();
  const jePerson = new Map<string, T[]>();
  for (const e of liste) if (e.personId) jePerson.set(e.personId, [...(jePerson.get(e.personId) ?? []), e]);
  for (const reihe of jePerson.values()) {
    reihe.sort((a, b) => a.zeitpunkt.localeCompare(b.zeitpunkt));
    for (let i = 0; i < reihe.length; i++) {
      const a = reihe[i]!;
      if (weg.has(a)) continue;
      for (let j = i + 1; j < reihe.length; j++) {
        const b = reihe[j]!;
        if (weg.has(b)) continue;
        if (Date.parse(b.zeitpunkt) - Date.parse(a.zeitpunkt) > PENDEL_TAGE * PENDEL_TAG) break;
        if (b.gruppe === a.gruppeVorher && b.ebene === a.ebeneVorher && b.gruppeVorher === a.gruppe && b.ebeneVorher === a.ebene) {
          weg.add(a);
          weg.add(b);
          break;
        }
      }
    }
  }
  return liste.filter((e) => !weg.has(e));
}

