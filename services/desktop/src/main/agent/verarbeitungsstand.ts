// Verarbeitungsstand einer Firma fuer das Modell (2026-10-12).
//
// Fuer den Nutzer gibt es den Begriff "verarbeiten" nicht: er erwartet, dass
// AVA zu jeder Firma alles weiss. Fehlen Daten, weil die Firma noch nie oder
// nur teilweise durch die Pipeline lief, darf AVA das nicht als "dazu liegt
// nichts vor" beantworten und auch nicht fragen, ob sie verarbeiten soll —
// sie stoesst die Verarbeitung an. Damit das Modell diese Entscheidung nicht
// aus 3+ leeren Abschnitten raten muss, liefert company_get diesen Block aus
// der Firmen-Matrix (Meine Firmen, Stand je Stufe).

export type StufenZelle = { state: string; updatedAt: string | null; transactionId: string | null };

export interface MatrixZeile {
  companyId: string;
  lastSeenAt?: string;
  stages: Record<string, StufenZelle>;
}

/** Producer-Name der Matrix → Stufen-Schluessel von retry_stage. */
export const STUFE_VON_PRODUCER: Record<string, string> = {
  "structured-content": "structuredContent",
  "company-publication": "companyPublication",
  website: "website",
  "company-profile": "companyProfile",
  "company-contact": "companyContact",
  "company-email": "companyEmail",
  "company-evaluation": "companyEvaluation",
};

/** Laeuft eine Stufe laenger als das, gilt sie als haengend, nicht als laufend. */
const LAUF_HOECHSTENS_MS = 2 * 60 * 60 * 1000;

export interface Verarbeitungsstand {
  imBestand: boolean;
  stand: "fehlt" | "laeuft" | "unvollstaendig" | "vollstaendig";
  fehlendeStufen: string[];
  laufendeStufen: string[];
  transactionId: string | null;
  hinweis: string;
}

export function verarbeitungsstand(companyId: string, zeile: MatrixZeile | null | undefined, jetzt = Date.now()): Verarbeitungsstand {
  if (!zeile) {
    return {
      imBestand: false,
      stand: "fehlt",
      fehlendeStufen: Object.values(STUFE_VON_PRODUCER),
      laufendeStufen: [],
      transactionId: null,
      hinweis:
        `Die Firma ${companyId} ist noch nicht im Bestand des Nutzers aufbereitet; Profil, Website, Finanzen, Kontakte und Bewertung fehlen. ` +
        "JETZT ohne Rueckfrage import_companies mit companyIds=[\"" + companyId + "\"] aufrufen. Dem Nutzer nur sagen, dass du die Firma jetzt vollstaendig aufbereitest und dich meldest, sobald sie fertig ist. " +
        "Keine Antwort aus den Stammdaten allein, nie 'dazu liegt nichts vor' oder 'soll ich die Firma verarbeiten?'.",
    };
  }
  const fehlend: string[] = [];
  const laufend: string[] = [];
  let transactionId: string | null = null;
  let juengste = 0;
  for (const [producer, stufe] of Object.entries(STUFE_VON_PRODUCER)) {
    const z = zeile.stages[producer];
    const t = z?.updatedAt ? Date.parse(z.updatedAt) : 0;
    if (z?.transactionId && t >= juengste) {
      juengste = t;
      transactionId = z.transactionId;
    }
    if (!z || z.state === "failed" || (z.state === "pending" && !z.updatedAt)) fehlend.push(stufe);
    else if (z.state === "pending" || z.state === "in_progress") {
      if (t && jetzt - t > LAUF_HOECHSTENS_MS) fehlend.push(stufe);
      else laufend.push(stufe);
    }
  }
  if (laufend.length > 0) {
    return {
      imBestand: true,
      stand: "laeuft",
      fehlendeStufen: fehlend,
      laufendeStufen: laufend,
      transactionId,
      hinweis:
        `Die Aufbereitung dieser Firma laeuft gerade (${laufend.join(", ")}). NICHT erneut importieren. ` +
        "Dem Nutzer sagen, dass die Firma gerade aufbereitet wird und du dich meldest; mit aufgabe_beobachten(transactionId) dranbleiben. Fehlende Bereiche sind kein Befund.",
    };
  }
  if (fehlend.length > 0) {
    return {
      imBestand: true,
      stand: "unvollstaendig",
      fehlendeStufen: fehlend,
      laufendeStufen: [],
      transactionId,
      hinweis:
        `Diese Stufen sind fuer die Firma noch nicht gelaufen: ${fehlend.join(", ")}. ` +
        (transactionId
          ? `Braucht die Frage eine davon, JETZT ohne Rueckfrage retry_stage(transactionId=\"${transactionId}\", companyId=\"${companyId}\", stage=…) aufrufen`
          : `Braucht die Frage eine davon, JETZT ohne Rueckfrage import_companies mit companyIds=[\"${companyId}\"] aufrufen`) +
        " und dem Nutzer sagen, dass du das jetzt nachholst. Nie 'gibt es nicht' oder 'liegt nicht vor' sagen, solange die Stufe nicht gelaufen ist.",
    };
  }
  return { imBestand: true, stand: "vollstaendig", fehlendeStufen: [], laufendeStufen: [], transactionId, hinweis: "" };
}
