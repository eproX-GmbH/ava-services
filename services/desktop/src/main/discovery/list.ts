// Phase 3 Firmen-Discovery — Kandidatenliste mit lokalen Match-Scores.
//
// Gemeinsame Logik fuer das Agent-Tool (discovery_candidates) und die
// Kandidaten-Tabelle (IPC): offene Kandidaten vom Gateway + Merge der
// nutzerlokalen Match-Scores (ICP ist privat), heisseste zuerst.

import type { GatewayClient } from "../agent/gateway-client";
import type { MatchStore } from "./match-store";
import { sanitizeCategory } from "./category";

export interface CandidateListRow {
  discoveryId: string;
  name: string;
  /** docs/PLAN_RADAR_LAENDER.md: DE | AT | CH | UK. */
  land: string;
  ort: string | null;
  plz: string | null;
  website: string;
  kategorie: string | null;
  quelle: string;
  bereitsInAva: boolean;
  profiliert: boolean;
  matchScore: number | null;
  matchBegruendung: string | null;
}

export async function listCandidatesWithMatches(
  gateway: GatewayClient,
  matchStore: MatchStore,
  opts: { limit?: number } = {},
): Promise<CandidateListRow[]> {
  // docs/PLAN_LINKEDIN_LEADS.md L2: Firmen aus beobachteten Posts leben im Bereich
  // LinkedIn-Leads, nicht in der Radar-Liste (ihr Mini-Profil entsteht trotzdem).
  const qs = new URLSearchParams({ limit: String(opts.limit ?? 200), ohneQuelle: "personen-radar" });
  const r = await gateway.request<{
    candidates: Array<{
      discoveryId: string;
      name: string;
      country?: string;
      city: string | null;
      plz: string | null;
      domain: string;
      category: string | null;
      source: string;
      masterCompanyId: string | null;
      profiledAt: string | null;
    }>;
  }>(`/v1/discovery/candidates?${qs.toString()}`);

  const matches = matchStore.getAll();
  const rows: CandidateListRow[] = r.candidates.map((c) => {
    const m = matches[c.discoveryId];
    return {
      discoveryId: c.discoveryId,
      name: c.name,
      land: c.country ?? "DE",
      ort: c.city,
      plz: c.plz,
      website: c.domain,
      // Sanitizing auch beim Lesen: Bestandsdaten mit Roh-Tags
      // ("yes", "construction_company") erscheinen sauber, ohne
      // DB-Migration (COALESCE-Upsert ueberschreibt Altwerte nicht).
      kategorie: sanitizeCategory(c.category),
      quelle: c.source,
      bereitsInAva: c.masterCompanyId !== null,
      profiliert: c.profiledAt !== null,
      matchScore: m?.score ?? null,
      matchBegruendung: m?.begruendung ?? null,
    };
  });
  rows.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
  return rows;
}

/** Free-Plan: so viele echte Radar-Treffer verlassen den Hauptprozess (Tabelle und Chat). */
export const FREE_SICHTBARE_TREFFER = 2;

/** Nur bezahlte Plaene sehen die ganze Liste; unbekannter Plan zaehlt als Free. */
export function istVollzugriff(tier: string | null | undefined): boolean {
  return tier === "starter" || tier === "pro" || tier === "enterprise";
}

/**
 * 2026-11-20 (Joyce): Im Free-Plan gehen NIE mehr als die ersten beiden Treffer an die
 * Oberflaeche oder den Chat. Der Rest wird nicht verdeckt, sondern gar nicht erst
 * geliefert; die Tabelle zeigt stattdessen eine kurze Platzhalterliste ohne echte Daten.
 */
export function freePlanAusschnitt<T>(tier: string | null | undefined, rows: T[]): { rows: T[]; weitere: number } {
  if (istVollzugriff(tier)) return { rows, weitere: 0 };
  return { rows: rows.slice(0, FREE_SICHTBARE_TREFFER), weitere: Math.max(0, rows.length - FREE_SICHTBARE_TREFFER) };
}

/** Plan frisch vom Gateway; offline gilt der zuletzt bekannte Wert (null = wie Free). */
export async function aktuellerTier(gateway: GatewayClient, zuletzt: string | null = null): Promise<string | null> {
  try {
    const u = await gateway.request<{ tier?: string }>("/v1/usage");
    return u.tier ?? zuletzt;
  } catch {
    return zuletzt;
  }
}
