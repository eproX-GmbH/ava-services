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

export interface RadarAlertEmitterDeps {
  alerts: AlertsStore;
  notify: (alert: Alert) => void;
  onAlertsChanged: () => void;
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

  /** Heisse Treffer (Score >= 70) aus einem Match-Lauf melden. */
  emit(ergebnisse: MatchResultRow[]): EmitResult {
    const alerted = this.getAlerted();
    const hot = ergebnisse.filter((r) => r.score >= HOT_SCORE);
    const bereitsGemeldet = hot.filter((r) => alerted.has(r.discoveryId)).length;
    const neu = hot
      .filter((r) => !alerted.has(r.discoveryId))
      .slice(0, MAX_ALERTS_PER_EMIT);
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
      this.persist();
      this.deps.onAlertsChanged();
    }
    return { neu: neu.length, bereitsGemeldet };
  }
}
