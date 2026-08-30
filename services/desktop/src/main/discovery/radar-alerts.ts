// Radar-Alerts — zentraler Emitter fuer heisse ICP-Treffer.
//
// Vorher feuerte NUR der Automatik-Lauf Alerts; der manuelle
// "ICP-Match aktualisieren"-Button und das Chat-Match taten es nicht —
// Nutzer sahen heisse Kandidaten in der Tabelle, aber weder Glocke
// noch Telegram meldeten sich. Jetzt laufen ALLE drei Match-Pfade
// durch diesen Emitter.
//
// Dedup: radar-alerted.json (eine Firma alarmiert nur EINMAL, egal wie
// oft sie neu gescored wird) + der sourceRef-Dedup des AlertsStore als
// zweite Verteidigungslinie.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { Alert } from "../../shared/types";
import type { AlertsStore } from "../agent/alerts-store";
import type { MatchResultRow } from "./matcher";

const HOT_SCORE = 70;
const MAX_ALERTS_PER_EMIT = 5;

// ---- Plan-Politik (v0.1.466) -----------------------------------------------
//
// "Alle Tiers sehen dieselbe Rangliste, aber unterschiedlich viel und
// unterschiedlich schnell": Free bekommt die Top-Treffer eines
// Wochen-Budgets, Starter ein Tages-Budget, Pro alles ab niedrigerer
// Schwelle sofort. Die Schwelle wird fuer niedrigere Plaene NICHT
// gesenkt — Free-Treffer sind per Konstruktion die relevantesten.

export interface RadarAlertPolicy {
  threshold: number;
  maxPerEmit: number;
  /** Alert-Budget je Zeitfenster; null = unbegrenzt. */
  budget: { max: number; windowDays: number } | null;
}

export function policyForTier(tier: string | null): RadarAlertPolicy {
  switch (tier) {
    case "free":
      return { threshold: 75, maxPerEmit: 3, budget: { max: 3, windowDays: 7 } };
    case "starter":
      return { threshold: 75, maxPerEmit: 5, budget: { max: 10, windowDays: 1 } };
    case "pro":
    case "enterprise":
      return { threshold: 65, maxPerEmit: 10, budget: null };
    default:
      // Tier (noch) unbekannt → bisheriges Verhalten.
      return { threshold: HOT_SCORE, maxPerEmit: MAX_ALERTS_PER_EMIT, budget: null };
  }
}

export interface RadarAlertEmitterDeps {
  alerts: AlertsStore;
  notify: (alert: Alert) => void;
  onAlertsChanged: () => void;
  /** v0.1.466 — Plan-Politik (synchron aus dem Tier-Cache in index.ts).
   *  Fehlt der Hook: Legacy-Verhalten. */
  getPolicy?: () => RadarAlertPolicy;
}

export interface EmitResult {
  /** Jetzt neu alarmiert. */
  neu: number;
  /** Heiss, aber frueher schon gemeldet (Dedup). */
  bereitsGemeldet: number;
}

export class RadarAlertEmitter {
  private readonly deps: RadarAlertEmitterDeps;
  private readonly path: string;
  private readonly dir: string;
  private alerted: Set<string> | null = null;

  constructor(deps: RadarAlertEmitterDeps, dir?: string) {
    this.deps = deps;
    this.dir = dir ?? join(app.getPath("userData"), "discovery");
    // Gleicher Dateiname wie der fruehere Supervisor-interne Store —
    // bestehende Dedup-Historie bleibt gueltig.
    this.path = join(this.dir, "radar-alerted.json");
  }

  private getAlerted(): Set<string> {
    if (this.alerted) return this.alerted;
    try {
      this.alerted = existsSync(this.path)
        ? new Set(JSON.parse(readFileSync(this.path, "utf8")) as string[])
        : new Set();
    } catch {
      this.alerted = new Set();
    }
    return this.alerted;
  }

  private persist(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        this.path,
        JSON.stringify([...this.getAlerted()].slice(-1000)),
        "utf8",
      );
    } catch (err) {
      console.warn("[radar-alerts] persist failed:", err);
    }
  }

  // Alert-Budget-Fenster (Plan-Politik): {windowStart, count}.
  private budgetState: { windowStart: number; count: number } | null = null;

  private budgetPath(): string {
    return join(this.dir, "radar-alert-budget.json");
  }

  private loadBudget(): { windowStart: number; count: number } {
    if (this.budgetState) return this.budgetState;
    try {
      const raw = JSON.parse(
        readFileSync(this.budgetPath(), "utf8"),
      ) as { windowStart?: number; count?: number };
      this.budgetState = {
        windowStart: typeof raw.windowStart === "number" ? raw.windowStart : Date.now(),
        count: typeof raw.count === "number" ? raw.count : 0,
      };
    } catch {
      this.budgetState = { windowStart: Date.now(), count: 0 };
    }
    return this.budgetState;
  }

  private persistBudget(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.budgetPath(), JSON.stringify(this.budgetState), "utf8");
    } catch {
      /* best-effort */
    }
  }

  /** Wieviele Alerts das Plan-Budget JETZT noch zulaesst. */
  private budgetRoom(policy: RadarAlertPolicy): number {
    if (!policy.budget) return Number.MAX_SAFE_INTEGER;
    const st = this.loadBudget();
    const windowMs = policy.budget.windowDays * 86_400_000;
    if (Date.now() - st.windowStart >= windowMs) {
      st.windowStart = Date.now();
      st.count = 0;
    }
    return Math.max(0, policy.budget.max - st.count);
  }

  /** Heisse Treffer aus einem Match-Lauf melden (Schwelle + Budget
   *  nach Plan-Politik; beste Scores zuerst). */
  emit(ergebnisse: MatchResultRow[]): EmitResult {
    const policy = this.deps.getPolicy?.() ?? policyForTier(null);
    const alerted = this.getAlerted();
    const hot = ergebnisse.filter((r) => r.score >= policy.threshold);
    const bereitsGemeldet = hot.filter((r) => alerted.has(r.discoveryId)).length;
    const room = Math.min(policy.maxPerEmit, this.budgetRoom(policy));
    const neu = hot
      .filter((r) => !alerted.has(r.discoveryId))
      .sort((a, b) => b.score - a.score)
      .slice(0, room);
    for (const h of neu) {
      const alert = this.deps.alerts.add({
        tenantId: null,
        companyId: "",
        companyName: h.name,
        kind: "radar-match",
        // "warn", nicht "info": Radar-Treffer sind bewusst aktivierte,
        // seltene, heisse Meldungen (Score >= 70, max 5/Lauf, Dedup) —
        // der Telegram-Kanal filtert per Default alles unter "warn"
        // weg, und genau dort sollen sie ankommen.
        severity: "warn",
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
    if (neu.length > 0) {
      if (policy.budget) {
        const st = this.loadBudget();
        st.count += neu.length;
        this.persistBudget();
      }
      this.persist();
      this.deps.onAlertsChanged();
    }
    return { neu: neu.length, bereitsGemeldet };
  }
}
