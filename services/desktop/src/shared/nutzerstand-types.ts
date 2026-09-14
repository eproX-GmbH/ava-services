// v0.1.646 (docs/PLAN_CHAT_VORSCHLAEGE.md, V1) — Nutzerstand: was der Nutzer
// mit AVA schon eingerichtet und getan hat. Deterministisch aus den Stores,
// kein LLM. Grundlage fuer die Chat-Vorschlaege (Startseite + Gespraech).

export type Verbindung = "verbunden" | "offen" | "gesperrt";

export interface Nutzerstand {
  erzeugtAt: string;
  angemeldet: boolean;
  verbindungen: {
    mail: Verbindung;
    telegram: Verbindung;
    hubspot: Verbindung;
    notion: Verbindung;
    obsidian: Verbindung;
    linkedin: Verbindung;
  };
  icp: "fehlt" | "unvollstaendig" | "vollstaendig";
  radar: {
    automatik: boolean;
    bewertet: number;
    heisseTreffer: number;
    /** Hoechster ICP-Score, Name wird lazy nachgeladen (kann null sein). */
    topTreffer: { discoveryId: string; score: number; name: string | null } | null;
    letzterLaufAt: string | null;
  };
  firmen: { importiert: number | null };
  workflows: { anzahl: number; letzterLaufAt: string | null };
  skills: { eigene: number };
  watchlist: { personen: number };
  emailAbleitung: { aktiv: boolean };
  modell: { bereit: boolean; anbieter: string | null; modell: string | null; sStufe: boolean };
  plan: "free" | "starter" | "pro" | "enterprise" | "unbekannt";
  organisation: { mitglied: boolean };
  /** Feature-Schluessel, die die Organisation abgeschaltet hat (unsichtbar). */
  gesperrteModule: string[];
}

/** Eine Faehigkeitsgruppe fuer den Vorschlags-Prompt (Variante B: ~35 Zeilen). */
export interface Faehigkeit {
  id: string;
  /** Kurzer Satz in Nutzersprache. */
  text: string;
  /** Tool-Namen (oder Praefixe mit *), die diese Gruppe tragen. */
  tools: string[];
  /** Feature-Schluessel der Org-Policy, der die Gruppe abschaltet. */
  feature?: string;
  /** Verwaltung: nie auf der Startseite vorschlagen, nur bei ausdruecklicher Absicht. */
  verwaltung?: boolean;
}
