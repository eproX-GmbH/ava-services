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
  const qs = new URLSearchParams({ limit: String(opts.limit ?? 200) });
  const r = await gateway.request<{
    candidates: Array<{
      discoveryId: string;
      name: string;
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
