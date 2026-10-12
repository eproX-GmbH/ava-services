// Verarbeitungsstand einer Firma fuer externe KIs ueber MCP (2026-10-12).
// Zwilling von services/desktop/src/main/agent/verarbeitungsstand.ts, mit den
// MCP-Werkzeugnamen (import_anlegen, neu_verarbeiten, auftrag_status) in den
// Hinweisen. Fuer den Nutzer gibt es "verarbeiten" nicht: fehlende Daten
// werden geholt, nicht als "liegt nicht vor" beantwortet.

export type MatrixZelle = { state: string; updatedAt: string | null; transactionId: string | null };
export interface MatrixZeile {
  companyId: string;
  name?: string;
  stages: Record<string, MatrixZelle>;
}

export const STUFE_VON_PRODUCER: Record<string, string> = {
  "structured-content": "structuredContent",
  "company-publication": "companyPublication",
  website: "website",
  "company-profile": "companyProfile",
  "company-contact": "companyContact",
  "company-email": "companyEmail",
  "company-evaluation": "companyEvaluation",
};

const LAUF_HOECHSTENS_MS = 2 * 60 * 60 * 1000;

export interface Verarbeitungsstand {
  imBestand: boolean;
  stand: "fehlt" | "laeuft" | "unvollstaendig" | "vollstaendig";
  fehlendeStufen: string[];
  laufendeStufen: string[];
  transactionId: string | null;
  hinweis: string;
}

/** Juengste Transaktion der Zeile (Stufe mit dem neuesten Stand). */
export function juengsteTransaktion(zeile: MatrixZeile | null | undefined): string | null {
  let id: string | null = null;
  let t0 = -1;
  for (const z of Object.values(zeile?.stages ?? {})) {
    const t = z.updatedAt ? Date.parse(z.updatedAt) : 0;
    if (z.transactionId && t >= t0) {
      t0 = t;
      id = z.transactionId;
    }
  }
  return id;
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
        "Die Firma ist noch nicht im Bestand des Nutzers aufbereitet; Profil, Website, Finanzen, Kontakte und Bewertung fehlen. " +
        `JETZT ohne Rueckfrage import_anlegen mit companyIds=["${companyId}"] aufrufen und dem Nutzer sagen, dass die Firma jetzt vollstaendig aufbereitet wird. ` +
        "Keine Antwort aus den Stammdaten allein, nie 'dazu liegt nichts vor' oder 'soll ich die Firma verarbeiten?'.",
    };
  }
  const fehlend: string[] = [];
  const laufend: string[] = [];
  for (const [producer, stufe] of Object.entries(STUFE_VON_PRODUCER)) {
    const z = zeile.stages[producer];
    const t = z?.updatedAt ? Date.parse(z.updatedAt) : 0;
    if (!z || z.state === "failed" || (z.state === "pending" && !z.updatedAt)) fehlend.push(stufe);
    else if (z.state === "pending" || z.state === "in_progress") {
      if (t && jetzt - t > LAUF_HOECHSTENS_MS) fehlend.push(stufe);
      else laufend.push(stufe);
    }
  }
  const transactionId = juengsteTransaktion(zeile);
  if (laufend.length > 0) {
    return {
      imBestand: true,
      stand: "laeuft",
      fehlendeStufen: fehlend,
      laufendeStufen: laufend,
      transactionId,
      hinweis: `Die Aufbereitung laeuft gerade (${laufend.join(", ")}). Nicht erneut importieren; Stand mit auftrag_status. Fehlende Bereiche sind kein Befund.`,
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
        `Diese Stufen sind noch nicht gelaufen: ${fehlend.join(", ")}. Braucht die Frage eine davon, JETZT ohne Rueckfrage neu_verarbeiten(companyId, stufe) aufrufen ` +
        "und dem Nutzer sagen, dass das nachgeholt wird. Nie 'gibt es nicht' sagen, solange die Stufe nicht gelaufen ist.",
    };
  }
  return { imBestand: true, stand: "vollstaendig", fehlendeStufen: [], laufendeStufen: [], transactionId, hinweis: "" };
}
