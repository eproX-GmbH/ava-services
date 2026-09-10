// M4 (docs/PLAN_EMAIL_MUSTER.md) — Typen der lokalen E-Mail-Ableitung (Main + Renderer).

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

/** Ergebnis einer einzelnen Adresspruefung (Verlauf in den Einstellungen / Chat). */
export type VerlaufErgebnis = "verifiziert" | "abgelehnt" | "unklar" | "catch_all" | "gesperrt";

export interface VerlaufEintrag {
  at: string;
  companyId: string;
  firma: string;
  domain: string;
  personId: string;
  fullName: string;
  email: string;
  muster: string;
  ergebnis: VerlaufErgebnis;
  /** true = am Server als Fakt gespeichert ("verifiziert" oder "catch_all" = unbestaetigt). */
  gespeichert: boolean;
  smtpCode?: number;
  mx?: string | null;
  fehler?: string;
}

export interface EmailMusterConfig {
  enabled: boolean;
  lastRunAt: string | null;
  lastOutcome: string | null;
  netz: { erreichbar: boolean; grund: string; at: string } | null;
  tag: { day: string; count: number };
  domains: Record<string, { at: string; muster: string | null; belege: number; catchAll: boolean; grund?: string }>;
  stats: { firmen: number; geprueft: number; verifiziert: number; unbestaetigt: number; abgelehnt: number; unbekannt: number; catchAll: number };
  /** Juengste Pruefungen zuerst, begrenzt (VERLAUF_MAX). */
  verlauf: VerlaufEintrag[];
}

export const VERLAUF_MAX = 500;

export interface Vorschau {
  companyId: string;
  domain: string | null;
  befund: MusterBefundShared | null;
  kandidaten: Array<{ personId: string; fullName: string; email: string }>;
  personenMitMail: number;
  personenOhneMail: number;
  hinweis: string | null;
}

