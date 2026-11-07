// Weitere Dienste (docs/PLAN_CLOSE_MCP.md C2, docs/PLAN_LOESUNGSKARTEN.md L6):
// Zugangsarten, vorbereitete Dienste und die Zugangsanfrage, die AVA im Chat
// stellt. Geteilt zwischen Einstellungen, Chat-Karte und Hauptprozess.

/**
 * keine        ohne Zugang
 * zugangscode  ein Schluessel/Token, gesendet als "Authorization: Bearer …"
 * kopfzeilen   frei benannte Kopfzeilen (z. B. Close-API-Key)
 * anmeldung    Benutzername und Passwort (HTTP Basic)
 * client       OAuth 2.0 Client Credentials: Client-ID, Client-Secret, Token-Adresse, Scopes
 */
export type DienstZugangArt = "keine" | "zugangscode" | "kopfzeilen" | "anmeldung" | "client";
export const DIENST_ZUGANG_ARTEN: readonly DienstZugangArt[] = ["keine", "zugangscode", "kopfzeilen", "anmeldung", "client"];

export interface DienstVorlage {
  id: string;
  name: string;
  url: string;
  art: "mcp" | "a2a";
  zugang: DienstZugangArt;
  kopfzeilen?: Array<{ name: string; hinweis: string; wert?: string }>;
  /** Wo der Nutzer den Zugang im Dienst findet (Anzeige). */
  hinweis: string;
  tokenAdresse?: string;
  scope?: string;
}

export const DIENST_VORLAGEN: DienstVorlage[] = [
  {
    id: "close",
    art: "mcp",
    name: "Close",
    url: "https://mcp.close.com/mcp",
    zugang: "kopfzeilen",
    kopfzeilen: [
      { name: "Close-API-Key", hinweis: "Schlüssel aus Close (Einstellungen → Entwickler)" },
      { name: "Close-Scope", hinweis: "Zugriffsbereich laut Close; vorbelegt ist sicheres Schreiben", wert: ["mcp", "write_safe"].join(".") },
    ],
    hinweis: "Kontakte, Aktivitäten, Chancen und Aufgaben in Close. Vorbelegt ist Lesen und sicheres Schreiben; Löschen erlaubt erst der Zugriffsbereich für destruktives Schreiben (siehe Close-Dokumentation).",
  },
  {
    id: "compleadly",
    art: "mcp",
    name: "CompLeadly",
    url: "https://mcp.complead.ly/user/mcp",
    zugang: "zugangscode",
    hinweis: "LinkedIn-Sequenzen über dein CompLeadly-Konto. Zugangscode in CompLeadly unter Einstellungen → Eigene KI verbinden anlegen („Neuer Token“) und hier eintragen.",
  },
];

export function vorlageFuer(name: string | undefined | null): DienstVorlage | null {
  if (!name) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return DIENST_VORLAGEN.find((v) => v.id === slug || v.name.toLowerCase().replace(/[^a-z0-9]+/g, "") === slug) ?? null;
}

/** Was AVA im Chat erfragt; enthaelt nie Zugangsdaten, nur Vorbelegung. */
export interface ZugangAnfrage {
  vorlage?: string;
  name?: string;
  url?: string;
  art?: "mcp" | "a2a";
  zugang?: DienstZugangArt;
  /** Ein Satz, wofuer AVA den Zugang braucht. */
  grund?: string;
}

/** Was die Karte an AVA zurueckmeldet; ebenfalls ohne Zugangsdaten. */
export interface ZugangErgebnis {
  verbunden: boolean;
  abgebrochen?: boolean;
  name?: string;
  slug?: string;
  werkzeuge?: number;
  fehler?: string;
}
