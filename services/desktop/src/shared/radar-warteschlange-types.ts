// Radar „anklicken, weg, fertig“ (2026-11-12, Wunsch Marc-Antonio): Importieren und
// Ignorieren je Zeile wirken sofort in der Tabelle; die eigentliche Entscheidung
// laeuft gesammelt im Hauptprozess. Diese Typen teilen sich Main, Preload und Renderer.

export interface RadarWarteKandidat {
  discoveryId: string;
  name: string;
  city: string | null;
  plz?: string | null;
  domain?: string | null;
  country?: string;
}

export type RadarWarteStatus = "wartet" | "laeuft" | "fehler";

export interface RadarWarteEintrag extends RadarWarteKandidat {
  entscheidung: "imported" | "dismissed";
  status: RadarWarteStatus;
  /** Zeitpunkt des Klicks (ISO). */
  am: string;
  /** Nur bei status "fehler": warum der Import nicht ging, in Worten. */
  grund?: string;
}

export interface RadarWarteErgebnis {
  am: string;
  importiert: number;
  ignoriert: number;
  transactionId: string | null;
  hinweise: string[];
}

export interface RadarWarteStand {
  eintraege: RadarWarteEintrag[];
  /** Sekunden zwischen letztem Klick und Abschicken (Fenster fuer „Rückgängig“). */
  verzoegerungSek: number;
  zuletzt: RadarWarteErgebnis | null;
}
