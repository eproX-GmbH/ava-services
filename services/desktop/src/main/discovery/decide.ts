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
import { registerTreffer, stufenHinweis } from "./namensabgleich";

/** Obergrenze des Gateways fuer POST /v1/discovery/decisions. */
const DECISIONS_BATCH = 200;

export interface DecideInput {
  discoveryId: string;
  decision: "imported" | "dismissed";
  reason?: string | null;
  /** Radar-Tabelle (2026-11-12): Stammdaten gleich mitgeben, dann entfaellt das
   *  Nachladen der Kandidatenliste (bis 500 Zeilen) vor dem Import. */
  kandidat?: { name: string; city: string | null; plz?: string | null; domain?: string | null; country?: string };
}

export interface DecideSummary {
  entschieden: number;
  importiert: number;
  ignoriert: number;
  transactionId: string | null;
  /** Import gewuenscht, aber kein Ort vorhanden → nicht importierbar. */
  ohneOrt: string[];
  unbekannt: string[];
  /** Weder im Register sicher gefunden noch ueber die Website anlegbar → bleibt offen. */
  ohneZuordnung: string[];
  /** Weiche Zuordnungen und Website-Anlagen, zum Pruefen fuer den Nutzer. */
  hinweise: string[];
  /** Dieselben Faelle als discoveryIds (Import-Warteschlange des Radars). */
  ohneOrtIds: string[];
  ohneZuordnungIds: string[];
}

interface CandidateLookupRow {
  discoveryId: string;
  name: string;
  city: string | null;
  plz?: string | null;
  domain?: string | null;
  country?: string;
}

interface ImportVorschau {
  unmatched?: Array<{ name: string; location: string; candidates?: Array<{ companyId: string; name: string; location: string; score?: number }> }>;
}

export async function decideCandidates(
  gateway: GatewayClient,
  decisions: DecideInput[],
  /** Onboarding O4: Import des Start-Workflows zaehlt als Startpaket nicht aufs Kontingent. */
  opts: { startpaket?: boolean } = {},
): Promise<DecideSummary | { error: string }> {
  if (decisions.length === 0) {
    return { error: "Keine Entscheidungen uebergeben." };
  }

  // v0.1.575 — Kandidaten nur fuer den IMPORT-Pfad aufloesen (Name + Ort).
  // Ignorieren braucht keine Stammdaten; vorher scheiterte "alle 300
  // ignorieren" zusaetzlich daran, dass die Nachschlag-Liste (limit=500,
  // inkl. bereits entschiedener) irgendwann nicht mehr alle IDs enthielt.
  const brauchtLookup = decisions.some((d) => d.decision === "imported" && !d.kandidat);
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

  for (const d of decisions) {
    if (d.decision === "imported" && d.kandidat) byId.set(d.discoveryId, { discoveryId: d.discoveryId, ...d.kandidat });
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
  const ohneOrtIds = toImport
    .filter((d) => !(byId.get(d.discoveryId)!.city ?? "").trim())
    .map((d) => d.discoveryId);
  const ohneOrt = ohneOrtIds.map((id) => byId.get(id)!.name);

  // 1. Import ZUERST — schlaegt er fehl, bleiben die Firmen offen
  //    (keine Entscheidung gespeichert) statt still zu verschwinden.
  //    Zuordnung in Stufen (2026-11-09): exakt (Name + Ort im Register) →
  //    gleicher Kernname am Ort → aehnlicher Name am Ort (beides mit Hinweis) →
  //    ueber die Website als Firma ohne Registereintrag. Nie mehr der erste
  //    unscharfe Elastic-Treffer (isFuzzy), der nur ueber Ort oder „GmbH“ passte.
  let transactionId: string | null = null;
  const hinweise: string[] = [];
  const ohneZuordnung: string[] = [];
  const ohneZuordnungIds: string[] = [];
  const importiertIds = new Set<string>();
  if (importable.length > 0) {
    try {
      // docs/PLAN_RADAR_LAENDER.md (L6): Abgleich je Land, also eine
      // Transaktion je Land (fast immer genau eine).
      const nachLand = new Map<string, typeof importable>();
      for (const d of importable) {
        const land = byId.get(d.discoveryId)!.country ?? "DE";
        nachLand.set(land, [...(nachLand.get(land) ?? []), d]);
      }
      for (const [land, teil] of nachLand) {
        const zeilen = teil.map((d) => ({ d, c: byId.get(d.discoveryId)! }));
        const vorschau = await gateway.request<ImportVorschau>("/v1/imports/from-list", {
          method: "POST",
          body: { companies: zeilen.map(({ c }) => ({ name: c.name, city: (c.city ?? "").trim() })), dryRun: true, isFuzzy: false, country: land },
        });
        const offen = new Map((vorschau.unmatched ?? []).map((u) => [`${u.name.trim().toLowerCase()}|${u.location.trim().toLowerCase()}`, u]));
        const exakt: Array<{ name: string; city: string }> = [];
        const perId: string[] = [];
        const ueberWebsite: Array<{ d: DecideInput; c: CandidateLookupRow; city: string; domain: string; mehrdeutig: Array<{ name: string }> }> = [];
        for (const { d, c } of zeilen) {
          const city = (c.city ?? "").trim();
          const u = offen.get(`${c.name.trim().toLowerCase()}|${city.toLowerCase()}`);
          if (!u) {
            exakt.push({ name: c.name, city });
            importiertIds.add(d.discoveryId);
            continue;
          }
          const t = registerTreffer({ name: c.name, ort: city }, u.candidates ?? []);
          if (t.kandidat) {
            // Exakter Registername + Sitz → master-data findet ihn ohne Unschaerfe.
            exakt.push({ name: t.kandidat.name, city: t.kandidat.location });
            importiertIds.add(d.discoveryId);
            hinweise.push(stufenHinweis(c.name, t.kandidat, t.stufe));
            continue;
          }
          const domain = c.domain ?? d.discoveryId;
          if (domain && domain.includes(".")) {
            ueberWebsite.push({ d, c, city, domain, mehrdeutig: t.mehrdeutig });
            continue;
          }
          ohneZuordnung.push(c.name);
          ohneZuordnungIds.push(d.discoveryId);
        }
        // Website-Zuordnungen parallel statt nacheinander (2026-11-12, Radar „anklicken, weg, fertig“).
        const webErgebnisse = await Promise.all(
          ueberWebsite.map(async ({ c, city, domain }) => {
            try {
              return await gateway.request<{ companyId: string; neu: boolean; konflikt?: Array<{ companyId: string; name: string | null }> }>("/v1/companies/web", {
                method: "POST",
                body: { name: c.name, website: domain, ort: city, ...(c.plz ? { plz: c.plz } : {}) },
              });
            } catch {
              return null;
            }
          }),
        );
        ueberWebsite.forEach(({ d, c, domain, mehrdeutig }, i) => {
          const w = webErgebnisse[i];
          if (!w) {
            ohneZuordnung.push(c.name);
            ohneZuordnungIds.push(d.discoveryId);
            return;
          }
          perId.push(w.konflikt?.[0]?.companyId ?? w.companyId);
          importiertIds.add(d.discoveryId);
          hinweise.push(
            w.konflikt?.length
              ? `„${c.name}“: Website gehört zur Register-Firma ${w.konflikt[0]!.name ?? w.konflikt[0]!.companyId}.`
              : `„${c.name}“: ${mehrdeutig.length > 1 ? `mehrere ähnliche Register-Firmen am Ort (${mehrdeutig.map((k) => k.name).slice(0, 3).join(", ")})` : "nicht im Register gefunden"}, über die Website ${domain} angelegt.`,
          );
        });
        if (exakt.length > 0) {
          const r = await gateway.request<{ transactionId: string }>("/v1/imports/from-list", {
            method: "POST",
            body: {
              ...(opts.startpaket ? { startpaket: true } : {}),
              companies: exakt,
              transactionName: `Discovery-Import: ${exakt.length} Firmen${land !== "DE" ? ` (${land})` : ""}`,
              isFuzzy: false,
              country: land,
            },
          });
          transactionId = transactionId ?? r.transactionId;
        }
        if (perId.length > 0) {
          const r = await gateway.request<{ transactionId: string }>("/v1/imports/by-ids", {
            method: "POST",
            body: { companyIds: [...new Set(perId)], transactionName: `Discovery-Import über Website: ${perId.length} Firmen` },
          });
          transactionId = transactionId ?? r.transactionId;
        }
      }
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
      importiertIds.has(d.discoveryId),
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
    importiert: importiertIds.size,
    ignoriert: valid.filter((d) => d.decision === "dismissed").length,
    transactionId,
    ohneOrt,
    unbekannt,
    ohneZuordnung,
    hinweise,
    ohneOrtIds,
    ohneZuordnungIds,
  };
}
