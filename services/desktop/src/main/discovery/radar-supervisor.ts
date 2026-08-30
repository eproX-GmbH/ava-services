// Phase 4 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Automatik.
//
// Periodischer Radar-Lauf (Muster link-monitor/supervisor): Scan →
// Mini-Profile → ICP-Match → Alerts fuer NEUE heisse Kandidaten
// (Score >= 70, noch nie alarmiert, offen). Alerts laufen ueber den
// bestehenden Fanout (Alerts-Glocke + Desktop-Notification + Telegram,
// falls verbunden).
//
// A10 bleibt unberuehrt: Die Automatik ENTDECKT und MELDET nur —
// importiert wird ausschliesslich durch explizite Nutzer-Entscheidung.
//
// Konfig: userData/discovery/radar-config.json — enabled (Default AUS,
// Opt-in!), intervalHours (24 = taeglich, 168 = woechentlich). Ort,
// Radius und Branchen kommen aus dem ICP.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { GatewayClient } from "../agent/gateway-client";
import type { LlmProviderManager } from "../agent/providers";
import type { IcpStore } from "../agent/icp-store";
import type { MatchStore } from "./match-store";
import type { CustomerProfileStore } from "./customer-profiles";
import type { RadarAlertEmitter } from "./radar-alerts";
import { runDiscoveryScan } from "./scan";
import { runProfiler } from "./profiler";
import { runMatch } from "./matcher";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

// v0.1.466 — Hinweis, wenn die Automatik am Free-Plan haengt (landet in
// lastOutcome und ist damit im Radar-UI-Status sichtbar).
const FREE_AUTOMATIK_HINT =
  "Automatik ist im Free-Plan nicht enthalten — 1 manueller Scan pro Woche. Mehr im Starter-/Pro-Plan (Einstellungen → Abo).";
const PROFILE_LIMIT_PER_RUN = 15;

export interface RadarConfig {
  enabled: boolean;
  /** 6 = 4x taeglich (nur Pro/Enterprise), 24 = taeglich, 168 = woechentlich. */
  intervalHours: 6 | 24 | 168;
  lastRunAt: string | null;
  lastOutcome: string | null;
}

const DEFAULT_CONFIG: RadarConfig = {
  enabled: false,
  intervalHours: 24,
  lastRunAt: null,
  lastOutcome: null,
};

export interface RadarSupervisorDeps {
  gateway: GatewayClient;
  providers: LlmProviderManager;
  icp: IcpStore;
  matchStore: MatchStore;
  customerStore: CustomerProfileStore;
  /** Zentraler Alert-Emitter — geteilt mit dem manuellen Match. */
  radarAlerts: RadarAlertEmitter;
  isSignedIn: () => boolean;
  /** v0.1.466 — Plan-Staffelung: aktueller Tier (aus dem Cache in
   *  index.ts; null = noch unbekannt → keine Einschraenkung). */
  getTier?: () => string | null;
  onAudit: (entry: {
    action: string;
    severity: "info" | "warning" | "error";
    summary: string;
    metadata?: Record<string, unknown>;
  }) => void;
}

export class RadarSupervisor {
  private readonly deps: RadarSupervisorDeps;
  private readonly dir: string;
  private readonly configPath: string;
  private config: RadarConfig | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: RadarSupervisorDeps, dir?: string) {
    this.deps = deps;
    this.dir = dir ?? join(app.getPath("userData"), "discovery");
    this.configPath = join(this.dir, "radar-config.json");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    // Erster Check kurz nach Boot (nicht sofort — Provider/Auth brauchen
    // einen Moment).
    setTimeout(() => void this.tick(), 90_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getConfig(): RadarConfig {
    if (this.config) return this.config;
    if (!existsSync(this.configPath)) {
      this.config = { ...DEFAULT_CONFIG };
      return this.config;
    }
    try {
      const parsed = JSON.parse(
        readFileSync(this.configPath, "utf8"),
      ) as Partial<RadarConfig>;
      this.config = {
        enabled: parsed.enabled === true,
        intervalHours:
          parsed.intervalHours === 168
            ? 168
            : parsed.intervalHours === 6
              ? 6
              : 24,
        lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
        lastOutcome:
          typeof parsed.lastOutcome === "string" ? parsed.lastOutcome : null,
      };
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }
    return this.config;
  }

  setConfig(patch: Partial<Pick<RadarConfig, "enabled" | "intervalHours">>): RadarConfig {
    const next = { ...this.getConfig(), ...patch };
    this.config = next;
    this.persistConfig();
    return next;
  }

  private persistConfig(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config), "utf8");
    } catch (err) {
      console.warn("[radar] config persist failed:", err);
    }
  }

  private async tick(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled || this.running) return;
    if (!this.deps.isSignedIn()) return;
    if (!this.deps.providers.getStatus().ready) return;
    if (!this.deps.icp.isSet()) return;

    // v0.1.466 — Plan-Staffelung: Free hat keine Automatik (nur den
    // manuellen Wochen-Scan); das 6-Stunden-Intervall ist Pro/Enterprise
    // vorbehalten (Starter wird still auf taeglich geklammert). Das
    // Gateway erzwingt die Scan-Quota ohnehin — das hier spart nur die
    // sinnlosen 429-Laeufe und macht den Grund sichtbar.
    const tier = this.deps.getTier?.() ?? null;
    if (tier === "free") {
      if (this.getConfig().lastOutcome !== FREE_AUTOMATIK_HINT) {
        this.setConfigInternal({ lastOutcome: FREE_AUTOMATIK_HINT });
      }
      return;
    }
    let effectiveInterval: number = cfg.intervalHours;
    if (
      cfg.intervalHours === 6 &&
      tier !== null &&
      tier !== "pro" &&
      tier !== "enterprise"
    ) {
      effectiveInterval = 24;
    }

    const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
    if (Date.now() - last < effectiveInterval * 3600 * 1000) return;
    await this.runNow("automatik");
  }

  /** Interner Patch inkl. lastOutcome (setConfig ist auf die
   *  UI-Felder beschraenkt). */
  private setConfigInternal(patch: Partial<RadarConfig>): void {
    this.config = { ...this.getConfig(), ...patch };
    this.persistConfig();
  }

  /** Ein voller Radar-Lauf. `trigger` nur fuers Audit. */
  async runNow(trigger: "automatik" | "manuell"): Promise<string> {
    if (this.running) return "Radar-Lauf laeuft bereits.";
    this.running = true;
    const startedAt = new Date().toISOString();
    try {
      const icp = this.deps.icp.get();
      const ort = icp.orte[0];
      if (!ort) {
        const msg =
          "Kein Radar-Ort im ICP hinterlegt (icp_set mit orte) — Lauf uebersprungen.";
        this.finishRun(startedAt, msg, trigger, "warning");
        return msg;
      }

      const scan = await runDiscoveryScan(this.deps.gateway, this.deps.providers, {
        ort,
        radiusKm: icp.radiusKm,
        branchen: icp.branchen,
        icpText: this.deps.icp.renderText(),
      });
      if ("error" in scan) {
        this.finishRun(startedAt, `Scan: ${scan.error}`, trigger, "warning");
        return scan.error;
      }
      const prof = await runProfiler(this.deps.gateway, this.deps.providers, {
        limit: PROFILE_LIMIT_PER_RUN,
        prioritizeTerms: icp.branchen,
      });
      const profNote =
        "error" in prof
          ? `Profile: ${prof.error}`
          : `${prof.profiliert} Profile`;
      const match = await runMatch(
        this.deps.gateway,
        this.deps.providers,
        this.deps.icp,
        this.deps.matchStore,
        this.deps.customerStore,
      );
      if ("error" in match) {
        this.finishRun(
          startedAt,
          `${scan.kandidatenGesamt} Kandidaten, ${profNote}, Match: ${match.error}`,
          trigger,
          "warning",
        );
        return match.error;
      }

      // Alerts fuer NEUE heisse Kandidaten (zentraler Emitter — Dedup
      // ueber alle Match-Pfade hinweg).
      const emitted = this.deps.radarAlerts.emit(match.ergebnisse);

      const outcome =
        `${scan.kandidatenGesamt} Kandidaten (OSM ${scan.quellen.osm}, ` +
        `SERP ${scan.quellen.serp}, Register ${scan.quellen.register}), ` +
        `${profNote}, ${match.bewertet} bewertet, ` +
        `${emitted.neu} neue heisse Treffer` +
        (emitted.bereitsGemeldet > 0
          ? ` (${emitted.bereitsGemeldet} heisse bereits frueher gemeldet)`
          : "");
      // Auditierbarkeit: die geplanten SERP-Recherchen gesammelt in die
      // Metadaten des Lauf-Eintrags.
      this.finishRun(startedAt, outcome, trigger, "info", {
        scanId: scan.scanId,
        queryPlanung: scan.queryPlanung,
        serpQueries: scan.serpQueries,
        quellen: scan.quellen,
      });
      return outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishRun(startedAt, `Fehler: ${msg}`, trigger, "error");
      return msg;
    } finally {
      this.running = false;
    }
  }

  private finishRun(
    startedAt: string,
    outcome: string,
    trigger: string,
    severity: "info" | "warning" | "error",
    extraMetadata: Record<string, unknown> = {},
  ): void {
    this.config = { ...this.getConfig(), lastRunAt: startedAt, lastOutcome: outcome };
    this.persistConfig();
    this.deps.onAudit({
      action: "discovery.radar-run",
      severity,
      summary: `Radar-Lauf (${trigger}): ${outcome}`,
      metadata: { trigger, ...extraMetadata },
    });
  }
}
