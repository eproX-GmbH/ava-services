// Register-Delta S6 (docs/PLAN_STAMMDATEN_DELTA.md) — "Mithelfen": der Rechner
// des Nutzers arbeitet Register-Jobs der geteilten Queue ab.

export interface MithelfenSettings {
  /** Opt-in. Default aus. */
  aktiv: boolean;
  /** Nur bei Netzbetrieb arbeiten (Akku schonen). Default an. */
  nurNetzbetrieb: boolean;
}

export interface MithelfenStatus {
  /** Einstellung des Nutzers. */
  aktiv: boolean;
  nurNetzbetrieb: boolean;
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
