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

export interface EmailMusterConfig {
  enabled: boolean;
  lastRunAt: string | null;
  lastOutcome: string | null;
  netz: { erreichbar: boolean; grund: string; at: string } | null;
  tag: { day: string; count: number };
  domains: Record<string, { at: string; muster: string | null; belege: number; catchAll: boolean }>;
  stats: { firmen: number; geprueft: number; verifiziert: number; abgelehnt: number; unbekannt: number; catchAll: number };
}

export interface Vorschau {
  companyId: string;
  domain: string | null;
  befund: MusterBefundShared | null;
  kandidaten: Array<{ personId: string; fullName: string; email: string }>;
  personenMitMail: number;
  personenOhneMail: number;
  hinweis: string | null;
}

