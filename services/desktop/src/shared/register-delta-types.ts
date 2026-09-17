// Register-Delta S6 (docs/PLAN_STAMMDATEN_DELTA.md) — "Mithelfen": der Rechner
// des Nutzers arbeitet Register-Jobs der geteilten Queue ab.

export interface MithelfenSettings {
  /** Opt-in. Default aus. */
  aktiv: boolean;
  /** Nur bei Netzbetrieb arbeiten (Akku schonen). Default an. */
  nurNetzbetrieb: boolean;
  /**
   * Worker-Modus: AVA arbeitet ausschliesslich Handelsregister-Jobs ab und
   * laesst alles andere ruhen (kein Herzschlag, keine Vorgaenge, keine
   * Producer, keine Workflows, keine Mail, kein Radar). Default aus.
   */
  nurRegister: boolean;
}

export interface MithelfenStatus {
  /** Einstellung des Nutzers. */
  aktiv: boolean;
  nurNetzbetrieb: boolean;
  /** Worker-Modus: nur Handelsregister-Verarbeitung, alles andere ruht. */
  nurRegister: boolean;
  /** Vorgabe der Organisation. */
  orgErlaubt: boolean;
  /** Kindprozess laeuft. */
  laeuft: boolean;
  /** Warum gerade nicht gearbeitet wird (null = arbeitet oder wartet auf Jobs). */
  pausenGrund: "aus" | "organisation" | "abgemeldet" | "akku" | "nicht_installiert" | "gesperrt" | null;
  aktuellerJob: { id: string; art: string; schluessel: string } | null;
  jobsErledigt: number;
  abfragenLetzteStunde: number;
  gesperrtBis: string | null;
  letzterFehler: string | null;
  workerId: string | null;
}

/** Ein erledigter Job dieses Rechners (Verlauf in den Einstellungen). */
export interface MithelfenVerlaufEintrag {
  at: string;
  id: string;
  art: string;
  /** Kurzbeschreibung: "Aurich HRB ab 203892", "Tag 2026-09-13", "15 Blätter (bek-2026-09-10)". */
  was: string;
  abfragen: number;
  treffer: number;
  neu: number;
  geaendert: number;
  unveraendert: number;
  bekanntmachungen: number;
  status: string;
}

export interface MithelfenVerlauf {
  eintraege: MithelfenVerlaufEintrag[];
  summe: { jobs: number; abfragen: number; treffer: number; neu: number; geaendert: number; seit: string | null };
}
