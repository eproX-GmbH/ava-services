// Typen der E-Mail-Ableitung (Main + Renderer). Seit 2026-10-12 ohne
// Hintergrund-Job: nur Schalter und Vorschau; die Verifizierung ist die
// Pipeline-Stufe „E-Mail“ (docs/PLAN_EMAIL_VERIFIZIERUNG.md).

export interface MusterBelegShared {
  fullName: string;
  email: string;
}

export interface MusterBefundShared {
  domain: string;
  muster: string | null;
  konfidenz: number;
  belege: MusterBelegShared[];
  unerklaert: MusterBelegShared[];
  funktionsadressen: string[];
  alternativen: string[];
}

/** Grenzen der Verifizierungsrate (Spiegel von packages/email-muster/src/takt.ts; der Renderer importiert das Paket nicht). */
export const PRUEFUNGEN_JE_STUNDE = { min: 10, max: 3600, standard: 300 } as const;

export interface EmailMusterConfig {
  enabled: boolean;
  /** Firmenadressen per Namensabgleich/Urteil Personen zuordnen. */
  zuordnungAktiv?: boolean;
  /** Ableitungen auch speichern, wenn die Pruefung nicht moeglich war oder ablehnte (gekennzeichnet). */
  ungeprueftAnzeigen?: boolean;
  /** Verifizierungsrate: RCPT-TO-Anfragen je Stunde (Standard 300, 10–3600). Einstellung der Person, nicht der Organisation. */
  pruefungenJeStunde?: number;
}

export interface Vorschau {
  companyId: string;
  domain: string | null;
  befund: MusterBefundShared | null;
  kandidaten: Array<{ personId: string; fullName: string; email: string }>;
  /** Firmenadressen, die (deterministisch) einer Person zugeordnet wuerden. */
  zuordnungen?: Array<{ personId: string; fullName: string; email: string; begruendung: string }>;
  /** Adresse, aus der das Muster abgeleitet wird. */
  baseline?: string | null;
  personenMitMail: number;
  personenOhneMail: number;
  hinweis: string | null;
}
