// v0.1.636 — Live-Aktivitaet des Firmen-Radars (Main → Renderer/Chat).
// Antwort auf die Nutzerfrage "laeuft der Radar gerade, oder haengt er?":
// ein Indikator mit Popup, keine neue Seite.

export type RadarPhase = "idle" | "scan" | "profile" | "match" | "fehler";

export interface RadarActivityEreignis {
  at: string;
  text: string;
}

export interface RadarActivityState {
  phase: RadarPhase;
  /** Seit wann die aktuelle Phase laeuft (ISO) bzw. null bei idle. */
  seit: string | null;
  /** Kurzer Schritt-Text, z. B. "Suchanfragen planen", "Google-Suche 3/8". */
  schritt: string | null;
  scan: {
    laeuft: boolean;
    queries: string[];
    aktuelleQuery: string | null;
    gefunden: { osm: number; serp: number; register: number };
    hochgeladen: number;
  };
  profile: {
    laeuft: boolean;
    /** Firmen, die GERADE ein Mini-Profil bekommen (parallel). */
    aktuell: string[];
    offen: number;
    fertig: number;
    fehler: number;
    /** Pausiert, weil ein Chat-Turn Vorrang hat. */
    pausiert: boolean;
  };
  match: {
    laeuft: boolean;
    /** Firmen, die GERADE ein ICP-Urteil bekommen (Batch). */
    aktuell: string[];
    offen: number;
    bewertet: number;
  };
  letzterFehler: { at: string; text: string } | null;
  /** Juengste Ereignisse, neueste zuerst (max. 40). */
  ereignisse: RadarActivityEreignis[];
  /** Letzter abgeschlossener Radar-Lauf (aus der Konfiguration). */
  letzterLauf: { at: string; outcome: string } | null;
}
