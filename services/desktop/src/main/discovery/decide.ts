// Phase 3 Firmen-Discovery — Entscheidungen (Import/Ignorieren).
//
// Gemeinsame Logik fuer das Agent-Tool und die Kandidaten-Tabelle (IPC):
//   1. Entscheidungen ans Gateway (DiscoveryDecision, pro Nutzer) —
//      die Firmen verschwinden damit aus der offenen Liste.
//   2. Fuer "imported": EIN Bulk-Import ueber den bestehenden
//      /v1/imports/from-list-Pfad (eine Transaktion mit N Firmen, volle
//      Pipeline). Import braucht einen Ort (master-data-Matching) —
//      Kandidaten ohne Ort werden gemeldet statt still verworfen.
//
// A10: Verarbeitung passiert NUR hier — nie automatisch.

import type { GatewayClient } from "../agent/gateway-client";

/** Obergrenze des Gateways fuer POST /v1/discovery/decisions. */
const DECISIONS_BATCH = 200;

export interface DecideInput {
  discoveryId: string;
  decision: "imported" | "dismissed";
  reason?: string | null;
}

export interface DecideSummary {
  entschieden: number;
  importiert: number;
  ignoriert: number;
  transactionId: string | null;
  /** Import gewuenscht, aber kein Ort vorhanden → nicht importierbar. */
  ohneOrt: string[];
  unbekannt: string[];
}

interface CandidateLookupRow {
  discoveryId: string;
  name: string;
  city: string | null;
}

export async function decideCandidates(
  gateway: GatewayClient,
  decisions: DecideInput[],
): Promise<DecideSummary | { error: string }> {
  if (decisions.length === 0) {
    return { error: "Keine Entscheidungen uebergeben." };
  }

  // v0.1.575 — Kandidaten nur fuer den IMPORT-Pfad aufloesen (Name + Ort).
  // Ignorieren braucht keine Stammdaten; vorher scheiterte "alle 300
  // ignorieren" zusaetzlich daran, dass die Nachschlag-Liste (limit=500,
  // inkl. bereits entschiedener) irgendwann nicht mehr alle IDs enthielt.
  const brauchtLookup = decisions.some((d) => d.decision === "imported");
  let byId = new Map<string, CandidateLookupRow>();
  if (brauchtLookup) {
    try {
      const r = await gateway.request<{ candidates: CandidateLookupRow[] }>(
        "/v1/discovery/candidates?limit=500&includeDecided=true",
      );
      byId = new Map(r.candidates.map((c) => [c.discoveryId, c]));
    } catch (err) {
      return {
        error: `Kandidaten-Abruf fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const unbekannt = decisions
    .filter((d) => d.decision === "imported" && !byId.has(d.discoveryId))
    .map((d) => d.discoveryId);
  const valid = decisions.filter(
    (d) => d.decision === "dismissed" || byId.has(d.discoveryId),
  );
  if (valid.length === 0) {
    return { error: `Keine der IDs ist bekannt (${unbekannt.join(", ")}).` };
  }

  const toImport = valid.filter((d) => d.decision === "imported");
  const importable = toImport.filter((d) => {
    const c = byId.get(d.discoveryId)!;
    return (c.city ?? "").trim().length > 0;
  });
  const ohneOrt = toImport
    .filter((d) => !(byId.get(d.discoveryId)!.city ?? "").trim())
    .map((d) => byId.get(d.discoveryId)!.name);

  // 1. Import ZUERST — schlaegt er fehl, bleiben die Firmen offen
  //    (keine Entscheidung gespeichert) statt still zu verschwinden.
  let transactionId: string | null = null;
  if (importable.length > 0) {
    try {
      const r = await gateway.request<{ transactionId: string }>(
        "/v1/imports/from-list",
        {
          method: "POST",
          body: {
            companies: importable.map((d) => {
              const c = byId.get(d.discoveryId)!;
              return { name: c.name, city: (c.city ?? "").trim() };
            }),
            transactionName: `Discovery-Import: ${importable.length} Firmen`,
            isFuzzy: true,
          },
        },
      );
      transactionId = r.transactionId;
    } catch (err) {
      return {
        error: `Import fehlgeschlagen — Entscheidungen NICHT gespeichert: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 2. Entscheidungen speichern: dismissed alle, imported nur die
  //    tatsaechlich importierten (ohne Ort → bleibt offen).
  const persist = valid.filter(
    (d) =>
      d.decision === "dismissed" ||
      importable.some((i) => i.discoveryId === d.discoveryId),
  );
  // v0.1.575 — Das Gateway nimmt hoechstens DECISIONS_BATCH Entscheidungen
  // je Anfrage an (zod max 200). "Alle 300 ignorieren" lief vorher in
  // einen 400er und die Tabelle blieb unveraendert. Jetzt in Haeppchen.
  let saved = 0;
  if (persist.length > 0) {
    try {
      for (let i = 0; i < persist.length; i += DECISIONS_BATCH) {
        const batch = persist.slice(i, i + DECISIONS_BATCH);
        const r = await gateway.request<{ saved: number }>(
          "/v1/discovery/decisions",
          {
            method: "POST",
            body: {
              decisions: batch.map((d) => ({
                discoveryId: d.discoveryId,
                decision: d.decision,
                reason: d.reason ?? null,
              })),
            },
          },
        );
        saved += r.saved;
      }
    } catch (err) {
      return {
        error: `Entscheidungen speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}${transactionId ? ` (Import ${transactionId} laeuft bereits)` : ""}`,
      };
    }
  }

  return {
    entschieden: saved,
    importiert: importable.length,
    ignoriert: valid.filter((d) => d.decision === "dismissed").length,
    transactionId,
    ohneOrt,
    unbekannt,
  };
}
