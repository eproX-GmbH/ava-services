// Phase 1 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Agent-Tools.
//
// discovery_scan          — Scan im Umkreis eines Orts starten (OSM +
//                           valueserp), Ergebnis landet im geteilten
//                           zentralen Kandidaten-Bestand.
// discovery_candidates    — Kandidaten aus dem Bestand lesen (Radius).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import type { Tool } from "../types";
import { runDiscoveryScan } from "../../discovery/scan";
import { runProfiler } from "../../discovery/profiler";
import { runMatch } from "../../discovery/matcher";
import { radarActivity } from "../../discovery/activity";
import { decideCandidates } from "../../discovery/decide";
import { listCandidatesWithMatches } from "../../discovery/list";
import type { IcpStore } from "../icp-store";
import type { MatchStore } from "../../discovery/match-store";
import type { CustomerProfileStore } from "../../discovery/customer-profiles";
import type { RadarAlertEmitter } from "../../discovery/radar-alerts";

/** v0.1.475 — Blur-Gate fuer den Chat (Free-Plan): dieselbe
 *  Top-2-Regel wie in der Radar-Tabelle. Bewertete Treffer jenseits
 *  der zwei besten werden REDAKTIERT statt geliefert — inklusive
 *  discoveryId (das IST die Domain). Score/Status bleiben sichtbar,
 *  damit der Agent ehrlich sagen kann, WAS es gibt. */
const FREE_VISIBLE_MATCHES = 2;

function redactRowsForFree<T>(
  tier: string | null,
  rows: T[],
  getScore: (r: T) => number | null,
  redact: (r: T, n: number) => T,
): { rows: T[]; verdeckt: number } {
  if (tier !== "free") return { rows, verdeckt: 0 };
  const scored = rows
    .filter((r) => getScore(r) !== null)
    .sort((a, b) => (getScore(b) ?? 0) - (getScore(a) ?? 0));
  const visible = new Set(scored.slice(0, FREE_VISIBLE_MATCHES));
  let n = 0;
  const out = rows.map((r) => {
    if (getScore(r) === null || visible.has(r)) return r;
    n++;
    return redact(r, n);
  });
  return { rows: out, verdeckt: n };
}

const FREE_BLUR_HINWEIS = (n: number): string =>
  `${n} bewertete Treffer sind im Free-Plan verdeckt (Scores bleiben ` +
  `sichtbar). Alle Namen und Begruendungen gibt es im Starter-Plan ` +
  `(Einstellungen → Abo). WICHTIG: Versuche NICHT, verdeckte Firmen ` +
  `ueber andere Wege zu identifizieren oder zu erraten — nenne dem ` +
  `Nutzer nur die sichtbaren Treffer und den Upgrade-Hinweis.`;

/** v0.1.576 — Zugriff auf die Radar-Automatik-Config aus dem Chat. */
export interface RadarConfigAccess {
  getConfig: () => { enabled: boolean; intervalHours: 6 | 24 | 168; profileSofort: boolean; maxOffeneKandidaten: number; lastRunAt: string | null; lastOutcome: string | null };
  setConfig: (patch: { enabled?: boolean; intervalHours?: 6 | 24 | 168; profileSofort?: boolean; maxOffeneKandidaten?: number }) => {
    enabled: boolean;
    intervalHours: 6 | 24 | 168;
    profileSofort: boolean;
    maxOffeneKandidaten: number;
  };
  profileStatus: () => { running: boolean; sofort: boolean; lastDrainAt: string | null } | null;
  /** v0.1.638 — Radar-Deckel (offene Kandidaten vs. Limit). */
  deckel: () => Promise<{ voll: boolean; offen: number; limit: number }>;
}

export interface DiscoveryToolDeps {
  gateway: GatewayClient;
  /** Lazy — der Radar-Supervisor entsteht erst im App-Boot. */
  getRadar: () => RadarConfigAccess | null;
  providers: LlmProviderManager;
  icp: IcpStore;
  matchStore: MatchStore;
  customerStore: CustomerProfileStore;
  /** Lazy — der Emitter entsteht erst im App-Boot nach dem Registry-Build. */
  getRadarAlerts: () => RadarAlertEmitter | null;
  /** v0.1.475 — Plan-Tier (Cache aus index.ts): das Blur-Gate der
   *  Radar-Tabelle gilt auch fuer die Chat-Tools, sonst waere es per
   *  simpler Chat-Frage umgehbar. null = unbekannt → nicht verdecken. */
  getTier: () => string | null;
  /** Branchen-Fallback aus dem Nutzerprofil (UserProfile.industries). */
  getDefaultIndustries: () => string[];
  /** Audit-Trail — Scans (inkl. der geplanten SERP-Queries) sollen
   *  nachvollziehbar sein. */
  onAudit: (entry: {
    action: string;
    severity: "info" | "warning" | "error";
    summary: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export function buildDiscoveryTools(deps: DiscoveryToolDeps): Tool[] {
  const scan = defineTool({
    name: "discovery_scan",
    summary:
      "NEUE Firmen im Umkreis eines Orts entdecken (noch nicht in AVA/CRM) — OSM + Google-Places-Scan, Ergebnis im zentralen Kandidaten-Bestand.",
    category: "discovery neue firmen umkreis radar akquise",
    description:
      "Startet einen Discovery-Scan: findet Firmen im Umkreis eines Orts, " +
      "die noch NICHT in AVA importiert sind (Quellen: OpenStreetMap-" +
      "Gewerbeeintraege + Google-Places-Suche pro Branchenbegriff). " +
      "Kandidaten landen im geteilten zentralen Bestand; bereits bekannte " +
      "Firmen werden automatisch markiert. Dauert 30-90 Sekunden. " +
      "Branchenbegriffe verbessern das Ergebnis deutlich — ohne Angabe " +
      "werden die Branchen aus dem Nutzerprofil verwendet. Tageslimit " +
      "pro Konto beachten (Fehlermeldung nennt es).",
    parameters: {
      type: "object",
      required: ["ort"],
      properties: {
        ort: {
          type: "string",
          description: "Ortsname als Zentrum, z. B. 'Hannover'.",
        },
        radiusKm: {
          type: "integer",
          description: "Umkreis in km (Default 30, max 100).",
        },
        branchen: {
          type: "array",
          items: { type: "string" },
          description:
            "Branchenbegriffe fuer die Places-Suche, z. B. ['IT-Dienstleister', 'Maschinenbau']. Max 8.",
        },
      },
    },
    schema: yup.object({
      ort: yup.string().trim().min(2).max(80).required(),
      radiusKm: yup.number().integer().min(1).max(100).optional(),
      branchen: yup
        .array()
        .of(yup.string().trim().min(2).max(60).required())
        .max(8)
        .optional(),
    }),
    preview: (r) => {
      const res = r as { error?: string; kandidatenGesamt?: number; added?: number };
      if (res.error) return res.error;
      return `${res.kandidatenGesamt ?? 0} Kandidaten (${res.added ?? 0} neu)`;
    },
    run: async (args) => {
      // v0.1.574 — Kein Scan ohne vollstaendiges ICP: Google-/Register-
      // Suchen kosten Kontingent und liefern ohne Region/Branchen/Profil
      // nur eine unsortierte Masse. Erst ICP vervollstaendigen (icp_set).
      const fehlt = deps.icp.fehlendeFelder();
      if (fehlt.length > 0) {
        return {
          error:
            `Kein Radar-Scan: Das Idealkundenprofil ist unvollstaendig — es fehlt: ${fehlt.join("; ")}. ` +
            "Frag den Nutzer nach den fehlenden Angaben und speichere sie mit icp_set; danach den Scan starten.",
          icpUnvollstaendig: fehlt,
        };
      }
      // v0.1.638 — Radar-Deckel gilt auch fuer manuelle Scans aus dem Chat.
      const d = await deps.getRadar()?.deckel();
      if (d?.voll) {
        return {
          error: `Kein Radar-Scan: ${d.offen} offene Kandidaten, Deckel ${d.limit}. Erst Kandidaten entscheiden (discovery_decide) oder den Deckel per radar_config maxOffeneKandidaten erhöhen (0 = unbegrenzt).`,
        };
      }
      const branchen =
        args.branchen && args.branchen.length > 0
          ? args.branchen
          : deps.icp.get().branchen.length > 0
            ? deps.icp.get().branchen
            : deps.getDefaultIndustries();
      const result = await runDiscoveryScan(deps.gateway, deps.providers, {
        ort: args.ort,
        radiusKm: args.radiusKm ?? 30,
        branchen,
        icpText: deps.icp.renderText(),
      });
      if (!("error" in result)) {
        deps.onAudit({
          action: "discovery.scan",
          severity: "info",
          summary:
            `Radar-Scan ${args.ort} (${args.radiusKm ?? 30} km): ` +
            `${result.kandidatenGesamt} Kandidaten — SERP-Recherche ` +
            `(${result.queryPlanung}): ${result.serpQueries.join(" | ") || "—"}`,
          metadata: {
            scanId: result.scanId,
            queryPlanung: result.queryPlanung,
            serpQueries: result.serpQueries,
            quellen: result.quellen,
            hinweise: result.hinweise,
          },
        });
      }
      return result;
    },
  });

  const list = defineTool({
    name: "discovery_candidates",
    summary:
      "Discovery-Kandidaten aus dem zentralen Bestand lesen (optional Geo-Radius) — inkl. bereits-bekannt-Markierung.",
    category: "discovery neue firmen kandidaten",
    description:
      "Liest die OFFENEN Firmen-Kandidaten aus dem Discovery-Bestand, " +
      "sortiert nach ICP-Match-Score (heisseste zuerst, inkl. Warum-" +
      "Begruendung, falls discovery_match_run gelaufen ist). " +
      "bereitsInAva = Firma ist schon im Bestand; profiliert = " +
      "Mini-Profil vorhanden.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max Ergebnisse (Default 50, max 200)." },
      },
    },
    schema: yup.object({
      limit: yup.number().integer().min(1).max(200).optional(),
    }),
    preview: (r) => {
      const res = r as { candidates?: unknown[] };
      return `${res.candidates?.length ?? 0} Kandidaten`;
    },
    run: async (args) => {
      const rows = await listCandidatesWithMatches(
        deps.gateway,
        deps.matchStore,
        { limit: args.limit ?? 50 },
      );
      // v0.1.475 — Blur-Gate gilt auch hier (sonst per Chat umgehbar).
      const gated = redactRowsForFree(
        deps.getTier(),
        rows,
        (r) => (r as { matchScore: number | null }).matchScore,
        (r, n) => ({
          ...r,
          discoveryId: `verdeckt-${n}`,
          name: "[Im Starter-Plan sichtbar]",
          website: "[verdeckt]",
          ort: null,
          plz: null,
          kategorie: null,
          matchBegruendung: "[verdeckt]",
        }) as typeof r,
      );
      return {
        hinweis:
          "Nur offene Kandidaten (importierte/verworfene ausgeblendet), sortiert nach ICP-Match-Score." +
          (gated.verdeckt > 0 ? ` ${FREE_BLUR_HINWEIS(gated.verdeckt)}` : ""),
        candidates: gated.rows,
      };
    },
  });

  const profile = defineTool({
    name: "discovery_profile_run",
    summary:
      "Mini-Profile fuer offene Discovery-Kandidaten erstellen (Website-Kurzcrawl + LLM + Embedding, zentral geteilt).",
    category: "discovery profil firmenprofil",
    description:
      "Erstellt fuer bis zu N offene Discovery-Kandidaten ein kompaktes " +
      "Firmen-Kurzprofil: Website kurz crawlen (Startseite + Impressum/" +
      "Leistungen, robots.txt respektiert), Profil per LLM (nutzt das " +
      "guenstige Producer-Modell, falls konfiguriert), Embedding lokal, " +
      "zentrale Ablage — einer verarbeitet, alle profitieren. Firmen mit " +
      "Profil juenger als 6 Monate werden uebersprungen. Dauert grob " +
      "10-20 Sekunden pro Firma; Default 10 Firmen pro Lauf.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Wie viele Kandidaten dieser Lauf verarbeitet (Default 10, max 25).",
        },
      },
    },
    schema: yup.object({
      limit: yup.number().integer().min(1).max(25).optional(),
    }),
    preview: (r) => {
      const res = r as { error?: string; profiliert?: number; betrachtet?: number };
      if (res.error) return res.error;
      return `${res.profiliert ?? 0}/${res.betrachtet ?? 0} Profile erstellt`;
    },
    run: async (args) =>
      runProfiler(deps.gateway, deps.providers, {
        limit: args.limit ?? 10,
        // ICP-Branchen zuerst profilieren — echte Treffer vor Absagen.
        prioritizeTerms: deps.icp.get().branchen,
      }),
  });

  const match = defineTool({
    name: "discovery_match_run",
    summary:
      "Profilierte Discovery-Kandidaten gegen das ICP matchen — Score 0-100 + Warum-Begruendung pro Firma.",
    category: "discovery icp match radar",
    description:
      "Matcht die profilierten offenen Kandidaten gegen das Idealkunden-" +
      "profil des Nutzers: lokales Embedding-Vorranking, dann LLM-Urteil " +
      "(guenstiges Producer-Modell) mit Score 0-100 und einem Satz, WARUM " +
      "die Firma (nicht) passt. Ergebnisse landen lokal und sortieren die " +
      "Kandidaten-Tabelle. Braucht ein gesetztes ICP (icp_set) und " +
      "profilierte Kandidaten (discovery_profile_run).",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: (r) => {
      const res = r as { error?: string; bewertet?: number };
      if (res.error) return res.error;
      return `${res.bewertet ?? 0} Kandidaten bewertet`;
    },
    run: async () => {
      const result = await runMatch(
        deps.gateway,
        deps.providers,
        deps.icp,
        deps.matchStore,
        deps.customerStore,
      );
      // Heisse Treffer melden (Glocke/Push/Telegram) — alle Match-Pfade
      // laufen durch denselben Emitter (Dedup inklusive).
      if (!("error" in result)) {
        const emitted = deps.getRadarAlerts()?.emit(result.ergebnisse);
        if (emitted && (emitted.neu > 0 || emitted.bereitsGemeldet > 0)) {
          result.hinweise.push(
            `${emitted.neu} neue heisse Treffer gemeldet` +
              (emitted.bereitsGemeldet > 0
                ? ` (${emitted.bereitsGemeldet} bereits frueher gemeldet)`
                : "") +
              ".",
          );
        }
        // v0.1.475 — Blur-Gate auch im Chat-Ergebnis (die Alerts oben
        // laufen durch die eigene Plan-Politik des Emitters).
        const gated = redactRowsForFree(
          deps.getTier(),
          result.ergebnisse,
          (r) => r.score,
          (r, n) => ({
            ...r,
            discoveryId: `verdeckt-${n}`,
            name: "[Im Starter-Plan sichtbar]",
            ort: null,
            begruendung: "[verdeckt]",
          }),
        );
        result.ergebnisse = gated.rows;
        if (gated.verdeckt > 0) {
          result.hinweise.push(FREE_BLUR_HINWEIS(gated.verdeckt));
        }
      }
      return result;
    },
  });

  const decide = defineTool({
    name: "discovery_decide",
    summary:
      "Discovery-Kandidaten importieren (volle Verarbeitung) oder ignorieren — NUR auf explizite Nutzer-Anweisung.",
    category: "discovery import ignorieren",
    description:
      "Speichert Entscheidungen zu Kandidaten: 'imported' startet EINEN " +
      "Bulk-Import (eine Transaktion, volle Pipeline) fuer alle gewaehlten " +
      "Firmen; 'dismissed' blendet sie dauerhaft aus. Entschiedene Firmen " +
      "verschwinden aus der Kandidatenliste. WICHTIG: Nur aufrufen, wenn " +
      "der Nutzer die Entscheidung explizit getroffen hat — nie " +
      "eigenmaechtig importieren. Import braucht einen Ort; Firmen ohne " +
      "Ort werden gemeldet.",
    parameters: {
      type: "object",
      required: ["decisions"],
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            required: ["discoveryId", "decision"],
            properties: {
              discoveryId: { type: "string" },
              decision: { type: "string", enum: ["imported", "dismissed"] },
              reason: { type: "string", description: "Optional, z. B. Verwerf-Grund." },
            },
          },
        },
      },
    },
    schema: yup.object({
      decisions: yup
        .array()
        .of(
          yup.object({
            discoveryId: yup.string().trim().min(4).max(100).required(),
            decision: yup.string().oneOf(["imported", "dismissed"]).required(),
            reason: yup.string().trim().max(500).optional(),
          }),
        )
        .min(1)
        .max(200)
        .required(),
    }),
    preview: (r) => {
      const res = r as { error?: string; importiert?: number; ignoriert?: number };
      if (res.error) return res.error;
      return `${res.importiert ?? 0} importiert, ${res.ignoriert ?? 0} ignoriert`;
    },
    run: async (args) =>
      decideCandidates(
        deps.gateway,
        args.decisions.map((d) => ({
          discoveryId: d.discoveryId,
          decision: d.decision as "imported" | "dismissed",
          reason: d.reason ?? null,
        })),
      ),
  });

  // v0.1.576 — Radar-Automatik und Sofort-Profile per Chat steuerbar.
  const radarConfig = defineTool({
    name: "radar_config",
    summary: "Firmen-Radar-Einstellungen lesen/aendern: Automatik an/aus, Intervall, sofortige Mini-Profil-Verarbeitung.",
    category: "radar firmenradar automatik intervall mini-profile sofort schnell einstellungen",
    description:
      "Liest oder aendert die Einstellungen des Firmen-Radars. Ohne Argumente: aktuelle Werte. Mit Argumenten (nach Bestaetigung): " +
      "enabled = Radar-Automatik, intervalHours = 6 (4x taeglich, Pro), 24 (taeglich) oder 168 (woechentlich), " +
      "profileSofort = sofortige Mini-Profil-Verarbeitung (alle offenen Kandidaten so schnell wie moeglich profilieren: " +
      "mehr Parallelitaet, Minutentakt; laufende Chats haben weiterhin Vorrang; verbraucht entsprechend mehr KI-Aufrufe), " +
      "maxOffeneKandidaten = Deckel fuer offene, noch nicht entschiedene Kandidaten (Standard 300, 0 = unbegrenzt, nach oben keine Grenze): " +
      "ist er erreicht, startet kein Scan, bis Kandidaten importiert oder ignoriert wurden.",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        intervalHours: { type: "number", enum: [6, 24, 168] },
        profileSofort: { type: "boolean", description: "true = sofortige Mini-Profil-Verarbeitung" },
        maxOffeneKandidaten: { type: "number", description: "Deckel offene Kandidaten, 0 = unbegrenzt (Standard 300)" },
      },
    },
    schema: yup
      .object({
        enabled: yup.boolean().optional(),
        intervalHours: yup.number().oneOf([6, 24, 168]).optional(),
        profileSofort: yup.boolean().optional(),
        maxOffeneKandidaten: yup.number().integer().min(0).optional(),
      })
      .noUnknown(true),
    preview: (r: { error?: string; geaendert?: boolean; config?: { enabled: boolean; profileSofort: boolean } }) =>
      r.error ? r.error : r.geaendert ? "Radar-Einstellungen geaendert" : "Radar-Einstellungen gelesen",
    run: async (args, c) => {
      const radar = deps.getRadar();
      if (!radar) return { error: "Radar noch nicht initialisiert." };
      const patch: { enabled?: boolean; intervalHours?: 6 | 24 | 168; profileSofort?: boolean; maxOffeneKandidaten?: number } = {};
      const aenderungen: string[] = [];
      if (args.enabled !== undefined) {
        patch.enabled = args.enabled;
        aenderungen.push(`Automatik → ${args.enabled ? "an" : "aus"}`);
      }
      if (args.intervalHours !== undefined) {
        patch.intervalHours = args.intervalHours as 6 | 24 | 168;
        aenderungen.push(`Intervall → ${args.intervalHours}h`);
      }
      if (args.profileSofort !== undefined) {
        patch.profileSofort = args.profileSofort;
        aenderungen.push(`Sofortige Mini-Profil-Verarbeitung → ${args.profileSofort ? "an" : "aus"}`);
      }
      if (args.maxOffeneKandidaten !== undefined) {
        patch.maxOffeneKandidaten = args.maxOffeneKandidaten;
        aenderungen.push(`Deckel offene Kandidaten → ${args.maxOffeneKandidaten === 0 ? "unbegrenzt" : args.maxOffeneKandidaten}`);
      }
      if (aenderungen.length === 0) {
        return { geaendert: false, config: radar.getConfig(), profile: radar.profileStatus() };
      }
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Firmen-Radar aendern: ${aenderungen.join(", ")}?`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: "Ändern" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { geaendert: false, abgebrochen: true };
      const config = radar.setConfig(patch);
      return { geaendert: true, config };
    },
  });

  // v0.1.636 — "Laeuft der Radar gerade?" auch im Chat beantwortbar.
  const activity = defineTool({
    name: "radar_activity",
    summary: "Live-Stand des Firmen-Radars: laeuft gerade ein Scan, eine Mini-Profil-Runde oder ein ICP-Match, und woran genau?",
    category: "radar firmenradar status aktivitaet laeuft haengt live fortschritt",
    description:
      "Zeigt, was der Firmen-Radar in diesem Moment tut: Phase (Scan / Mini-Profile / ICP-Match / nichts), aktueller Schritt, " +
      "aktuelle Google-Suchanfrage, gefundene Firmen je Quelle, Firmen, die gerade ein Mini-Profil oder ein ICP-Urteil bekommen, " +
      "offene Zaehler, letzter Fehler, juengste Ereignisse und der letzte abgeschlossene Lauf. Dieselben Daten wie das Popup " +
      "hinter dem Aktivitaets-Indikator auf der Radar-Seite.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { phase?: string; schritt?: string | null }) =>
      r.phase === "idle" ? "Radar: nichts in Arbeit" : `Radar: ${r.phase}${r.schritt ? ` — ${r.schritt}` : ""}`,
    run: async () => {
      const s = radarActivity.get();
      return { ...s, ereignisse: s.ereignisse.slice(0, 15) };
    },
  });

  return [scan, list, profile, match, decide, radarConfig, activity];
}
