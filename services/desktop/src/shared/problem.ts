// docs/PLAN_PROBLEM_MELDEN.md — gemeinsame Typen fuer „Problem melden“.
export const PROBLEM_KATEGORIEN = [
  { id: "fehler", label: "Fehler oder Absturz" },
  { id: "daten", label: "Daten falsch oder fehlen" },
  { id: "verarbeitung", label: "Verarbeitung hängt" },
  { id: "anmeldung", label: "Anmeldung oder Organisation" },
  { id: "abrechnung", label: "Abrechnung oder Plan" },
  { id: "wunsch", label: "Wunsch oder Idee" },
  { id: "sonstiges", label: "Sonstiges" },
] as const;
export type ProblemKategorie = (typeof PROBLEM_KATEGORIEN)[number]["id"];

export const PROBLEM_STATUS_TEXT: Record<string, string> = {
  neu: "neu",
  in_arbeit: "in Arbeit",
  wartet_auf_nutzer: "wartet auf deine Antwort",
  geloest: "gelöst",
  geschlossen: "geschlossen",
  abgelehnt: "nicht umgesetzt",
};

export interface ProblemEingabe {
  kategorie: string;
  titel: string;
  beschreibung: string;
  quelle: "dialog" | "chat";
  conversationId?: string | null;
  companyId?: string | null;
  dateien: Array<{ name: string; mime: string; base64: string }>;
  chatAuszug?: Array<{ rolle: string; text: string; werkzeug?: string | null; zeit?: string | null }> | null;
  bildschirmfoto?: boolean;
  alsMail?: boolean;
}

export type ProblemErgebnis =
  | { weg: "gateway"; kennung: string; id: string }
  | { weg: "mail"; programm: string | null; hinweis: string }
  | { weg: "fehler"; fehler: string };

export interface MeldungZeile {
  id: string;
  kennung: string;
  kategorie: string;
  titel: string;
  status: string;
  prioritaet: string;
  ungelesenNutzer: boolean;
  letzteNachricht: string | null;
  nachrichten: number;
  createdAt: string;
  updatedAt: string;
}
export interface MeineMeldungen { meldungen: MeldungZeile[]; ungelesen: number }
export interface MeldungNachricht { id: string; von: "nutzer" | "betreiber" | "system"; actorName: string | null; text: string; art: string; createdAt: string }
export interface MeldungDetail {
  meldung: MeldungZeile & { beschreibung: string; appVersion: string | null };
  anhaenge: Array<{ id: string; art: string; dateiname: string; groesse: number; verfuegbar: boolean }>;
  nachrichten: MeldungNachricht[];
}
