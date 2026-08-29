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
import type { Alert } from "../../shared/types";
import type { GatewayClient } from "../agent/gateway-client";
import type { LlmProviderManager } from "../agent/providers";
import type { AlertsStore } from "../agent/alerts-store";
import type { IcpStore } from "../agent/icp-store";
import type { MatchStore } from "./match-store";
import { runDiscoveryScan } from "./scan";
import { runProfiler } from "./profiler";
import { runMatch } from "./matcher";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const HOT_SCORE = 70;
const MAX_ALERTS_PER_RUN = 5;
const PROFILE_LIMIT_PER_RUN = 15;

export interface RadarConfig {
  enabled: boolean;
  intervalHours: 24 | 168;
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
  alerts: AlertsStore;
  notify: (alert: Alert) => void;
  onAlertsChanged: () => void;
  isSignedIn: () => boolean;
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
  private readonly alertedPath: string;
  private config: RadarConfig | null = null;
  private alerted: Set<string> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: RadarSupervisorDeps, dir?: string) {
    this.deps = deps;
    this.dir = dir ?? join(app.getPath("userData"), "discovery");
    this.configPath = join(this.dir, "radar-config.json");
    this.alertedPath = join(this.dir, "radar-alerted.json");
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
        intervalHours: parsed.intervalHours === 168 ? 168 : 24,
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

  private getAlerted(): Set<string> {
    if (this.alerted) return this.alerted;
    try {
      this.alerted = existsSync(this.alertedPath)
        ? new Set(JSON.parse(readFileSync(this.alertedPath, "utf8")) as string[])
        : new Set();
    } catch {
      this.alerted = new Set();
    }
    return this.alerted;
  }

  private persistAlerted(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const arr = [...this.getAlerted()];
      // Cap gegen unbegrenztes Wachstum.
      writeFileSync(this.alertedPath, JSON.stringify(arr.slice(-1000)), "utf8");
    } catch (err) {
      console.warn("[radar] alerted persist failed:", err);
    }
  }

  private async tick(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled || this.running) return;
    if (!this.deps.isSignedIn()) return;
    if (!this.deps.providers.getStatus().ready) return;
    if (!this.deps.icp.isSet()) return;
    const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
    if (Date.now() - last < cfg.intervalHours * 3600 * 1000) return;
    await this.runNow("automatik");
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

      const scan = await runDiscoveryScan(this.deps.gateway, {
        ort,
        radiusKm: icp.radiusKm,
        branchen: icp.branchen,
      });
      if ("error" in scan) {
        this.finishRun(startedAt, `Scan: ${scan.error}`, trigger, "warning");
        return scan.error;
      }
      const prof = await runProfiler(this.deps.gateway, this.deps.providers, {
        limit: PROFILE_LIMIT_PER_RUN,
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

      // Alerts fuer NEUE heisse Kandidaten.
      const alerted = this.getAlerted();
      const hot = match.ergebnisse
        .filter((r) => r.score >= HOT_SCORE && !alerted.has(r.discoveryId))
        .slice(0, MAX_ALERTS_PER_RUN);
      for (const h of hot) {
        const alert = this.deps.alerts.add({
          tenantId: null,
          companyId: "",
          companyName: h.name,
          kind: "radar-match",
          severity: "info",
          headline: `Radar: ${h.name} passt zu deinem ICP (Score ${h.score})`,
          rationale: `${h.begruendung} — Entscheiden unter Firmen → Radar.`,
          sourceRef: `radar:${h.discoveryId}`,
        });
        alerted.add(h.discoveryId);
        if (alert) {
          try {
            this.deps.notify(alert);
          } catch {
            /* best-effort */
          }
        }
      }
      if (hot.length > 0) {
        this.persistAlerted();
        this.deps.onAlertsChanged();
      }

      const outcome =
        `${scan.kandidatenGesamt} Kandidaten (OSM ${scan.quellen.osm}, ` +
        `SERP ${scan.quellen.serp}, Register ${scan.quellen.register}), ` +
        `${profNote}, ${match.bewertet} bewertet, ${hot.length} neue heisse Treffer`;
      this.finishRun(startedAt, outcome, trigger, "info");
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
  ): void {
    this.config = { ...this.getConfig(), lastRunAt: startedAt, lastOutcome: outcome };
    this.persistConfig();
    this.deps.onAudit({
      action: "discovery.radar-run",
      severity,
      summary: `Radar-Lauf (${trigger}): ${outcome}`,
      metadata: { trigger },
    });
  }
}
