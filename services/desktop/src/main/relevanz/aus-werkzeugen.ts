// Firmen und Personen aus Werkzeugaufrufen herauslesen
// (docs/PLAN_RELEVANZ.md, Abschnitt 3.4).
//
// Entscheidend ist nicht der Name, sondern die ID — nur ueber sie laesst
// sich ein Wert verknuepfen. Und die ID liegt ohnehin vor: Nennt der Nutzer
// eine Firma, sucht der Agent sie per Werkzeug, und ab da ist sie
// eindeutig. Deshalb braucht es keine Namenserkennung im Fliesstext, die
// gegen 2000 Firmennamen ohnehin die falschen Treffer liefern wuerde.
//
// Zwei Quellen, mit unterschiedlichem Gewicht:
//   1. IDs in den ARGUMENTEN eines Aufrufs — jemand zeigt auf dieses Ziel.
//      Zaehlt immer.
//   2. IDs im ERGEBNIS einer Suche — aber nur bei wenigen Treffern. Eine
//      Liste mit fuenfzig Firmen ist eine Liste, kein Interesse an jedem
//      Eintrag.

/** Mehr Treffer als das heisst: Liste, nicht Absicht. */
export const TREFFER_GRENZE = 3;

/** Wie viele Ziele ein einzelner Aufruf hoechstens beisteuern darf. */
const JE_AUFRUF_MAX = 5;

export interface Fund {
  zielArt: "firma" | "person";
  zielId: string;
  firmaId?: string | null;
}

const FIRMA_SCHLUESSEL = ["companyid", "company_id", "firmaid", "firma_id"];
const PERSON_SCHLUESSEL = ["personid", "person_id", "kontaktid", "kontakt_id"];

function istFirmenSchluessel(k: string): boolean {
  return FIRMA_SCHLUESSEL.includes(k.toLowerCase());
}
function istPersonenSchluessel(k: string): boolean {
  return PERSON_SCHLUESSEL.includes(k.toLowerCase());
}

/** Plausible ID: nicht leer, nicht absurd lang, keine Adresse. */
function istId(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= 3 &&
    v.length <= 200 &&
    !v.includes(" ") &&
    !v.startsWith("http")
  );
}

/**
 * IDs aus den Argumenten eines Aufrufs.
 *
 * Geht in die Tiefe, weil Bulk-Tools ihre Ziele in Listen verpacken
 * (`{ companyIds: [...] }`, `{ firmen: [{ companyId }] }`).
 */
export function ausArgumenten(args: unknown, tiefe = 0): Fund[] {
  if (tiefe > 4 || args === null || typeof args !== "object") return [];
  const funde: Fund[] = [];

  const sammle = (schluessel: string, wert: unknown): void => {
    const werte = Array.isArray(wert) ? wert : [wert];
    for (const v of werte) {
      if (!istId(v)) continue;
      if (istFirmenSchluessel(schluessel)) funde.push({ zielArt: "firma", zielId: v });
      else if (istPersonenSchluessel(schluessel)) funde.push({ zielArt: "person", zielId: v });
    }
  };

  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    // Mehrzahlformen mitnehmen: companyIds, personIds.
    const einzahl = k.replace(/s$/i, "");
    sammle(k, v);
    if (einzahl !== k) sammle(einzahl, v);
    if (v && typeof v === "object") funde.push(...ausArgumenten(v, tiefe + 1));
  }
  return funde;
}

/**
 * IDs aus dem Ergebnistext eines Aufrufs — nur bei wenigen Treffern.
 *
 * Der Ergebnistext ist das, was das Modell sieht; Firmen stehen darin als
 * `company:ID` (dasselbe Format wie die Chatlinks). Kommen mehr als
 * TREFFER_GRENZE verschiedene IDs vor, war es eine Liste, und es zaehlt
 * nichts: Wer eine Uebersicht aufruft, hat nicht an jedem Eintrag
 * Interesse.
 */
export function ausErgebnis(text: string): Fund[] {
  if (!text) return [];
  const ids = new Set<string>();
  const muster = /company:([A-Za-z0-9_-]{3,64})/g;
  let treffer: RegExpExecArray | null;
  while ((treffer = muster.exec(text)) !== null) {
    const id = treffer[1];
    if (!id) continue;
    ids.add(id);
    if (ids.size > TREFFER_GRENZE) return [];
  }
  return Array.from(ids).map((zielId) => ({ zielArt: "firma" as const, zielId }));
}

/**
 * Was ein einzelner Werkzeugaufruf zur Naehe beitraegt.
 *
 * Doppelte verschwinden, die Menge ist gedeckelt: Ein Bulk-Aufruf ueber
 * hundert Firmen soll nicht hundert Signale erzeugen — das waere wieder
 * die Listenfalle, nur an anderer Stelle.
 */
export function ausAufruf(args: unknown, ergebnis: string): Fund[] {
  const alle = [...ausArgumenten(args), ...ausErgebnis(ergebnis)];
  const gesehen = new Set<string>();
  const eindeutig: Fund[] = [];
  for (const f of alle) {
    const k = `${f.zielArt}:${f.zielId}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    eindeutig.push(f);
    if (eindeutig.length >= JE_AUFRUF_MAX) break;
  }
  // Personen die Firma mitgeben, wenn der Aufruf genau eine nennt: Nur dann
  // ist die Zuordnung eindeutig.
  const firmen = eindeutig.filter((f) => f.zielArt === "firma");
  const einzige = firmen.length === 1 ? firmen[0] : null;
  if (einzige) {
    for (const f of eindeutig) {
      if (f.zielArt === "person") f.firmaId = einzige.zielId;
    }
  }
  return eindeutig;
}
