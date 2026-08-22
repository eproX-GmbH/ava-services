// LM4 — LinkMonitorSupervisor.
//
// Eine Instanz pro App. Hält Timer für alle "active"-Monitore und führt
// beim Fälligkeitsschlag die Pipeline aus:
//   browse (Headless-Fenster) → extract (LLM-Beobachtungen) → diff
//   (Semantik-Vergleich mit letztem Durchlauf).
// Bei erkannter Änderung: Alert (kind="link-change") + OS-Push +
// Alarm-Glocke. Boot-Rehydrate übersteht App-Restart.
//
// Muster 1:1 von main/scheduler/supervisor.ts:
//   - Per-Monitor setTimeout, Delay-Cap 30 min gegen Sleep/Wake-Drift.
//   - Auto-Pause (status="error") nach N Fehlversuchen in Folge.
//   - Ein Fehler killt nie den Loop.
// Zusätzlich: globales Concurrency-Limit, damit nie mehrere
// Headless-Fenster gleichzeitig RAM/CPU fressen.

import { EventEmitter } from "node:events";
import {
  LINK_MONITOR_MAX_CONSECUTIVE_FAILURES,
  LINK_MONITOR_PRESET_MINUTES,
  LINK_MONITOR_RUN_TIMEOUT_MS,
  type Alert,
  type LinkMonitor,
  type LinkMonitorFrequencyPreset,
  type LinkMonitorInput,
  type LinkMonitorRunOutcome,
  type LinkMonitorStatus,
} from "../../shared/types";
import type { AlertsStore } from "../agent/alerts-store";
import type { LlmProviderManager } from "../agent/providers";
import { browseUrl } from "./browser";
import { detectChange } from "./diff";
import {
  extractObservations,
  type LinkObservations,
} from "./extractor";
import { clampInterval, LinkMonitorStore } from "./store";
import {
  deleteMonitorScreenshots,
  saveRunScreenshot,
} from "./screenshots";

/** v0.1.416 — kontrollierter Abbruch eines Laufs ohne echten Fehler. */
class SkipRunError extends Error {
  constructor() {
    super("run skipped");
    this.name = "SkipRunError";
  }
}

const DELAY_CAP_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_RUNS = 2;

export interface LinkMonitorSupervisorDeps {
  store: LinkMonitorStore;
  providers: LlmProviderManager;
  alerts: AlertsStore;
  /** OS-Push für einen Alert auslösen (notifications.notifyForAlert). */
  notify: (alert: Alert) => void;
  /** Renderer-Glocke aktualisieren (broadcastAlertsChanged). */
  onAlertsChanged: () => void;
  /**
   * v0.1.411 — Audit-Eintrag schreiben (main/index.ts `audit`). Optional,
   * damit Tests den Supervisor ohne Audit-Store bauen können. Vorher wurde
   * KEIN Link-Monitor-Lauf protokolliert — im Audit-Trail war nichts zu
   * sehen, auch nicht bei manuellem „Jetzt prüfen".
   */
  onAudit?: (entry: {
    action: string;
    severity: "info" | "warning" | "error";
    summary: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export interface LinkMonitorSupervisorEvents {
  changed: () => void;
}

export declare interface LinkMonitorSupervisor {
  on<K extends keyof LinkMonitorSupervisorEvents>(
    event: K,
    listener: LinkMonitorSupervisorEvents[K],
  ): this;
  emit<K extends keyof LinkMonitorSupervisorEvents>(
    event: K,
    ...args: Parameters<LinkMonitorSupervisorEvents[K]>
  ): boolean;
}

export class LinkMonitorSupervisor extends EventEmitter {
  private timers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();
  private stopping = false;

  readonly store: LinkMonitorStore;
  private readonly providers: LlmProviderManager;
  private readonly alerts: AlertsStore;
  private readonly notify: (alert: Alert) => void;
  private readonly onAlertsChanged: () => void;
  private readonly onAudit?: LinkMonitorSupervisorDeps["onAudit"];

  constructor(deps: LinkMonitorSupervisorDeps) {
    super();
    this.store = deps.store;
    this.providers = deps.providers;
    this.alerts = deps.alerts;
    this.notify = deps.notify;
    this.onAlertsChanged = deps.onAlertsChanged;
    this.onAudit = deps.onAudit;
    this.store.on("changed", () => this.emit("changed"));
  }

  /** v0.1.411 — IDs der aktuell laufenden Durchläufe (für den UI-Indikator). */
  runningIds(): string[] {
    return [...this.inFlight];
  }

  /** Boot vom main/index.ts. Re-armiert alle active-Monitore. */
  async start(): Promise<void> {
    await this.store.start();
    const active = await this.store.listActive();
    for (const m of active) this.scheduleNextRun(m);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.store.stop();
  }

  /** Monitor anlegen (über IPC/Tool). Leitet Label + LinkedIn-Flag aus
   *  der URL ab und armiert den Timer, falls aktiv angelegt. */
  async createMonitor(
    input: LinkMonitorInput,
    source: "agent" | "user",
  ): Promise<LinkMonitor> {
    const meta = deriveMeta(input.url);
    const interval = resolveInterval(input);
    const monitor = await this.store.create({
      url: meta.url,
      label: input.label?.trim() || meta.host,
      instructions: input.instructions?.trim() ?? "",
      intervalMinutes: interval.minutes,
      frequencyPreset: interval.preset,
      isLinkedIn: meta.isLinkedIn,
      source,
    });
    this.scheduleNextRun(monitor);
    return monitor;
  }

  async update(
    id: string,
    patch: Partial<LinkMonitorInput>,
  ): Promise<LinkMonitor | null> {
    const storePatch: Parameters<LinkMonitorStore["update"]>[1] = {};
    if (patch.url !== undefined) {
      const meta = deriveMeta(patch.url);
      storePatch.url = meta.url;
      storePatch.isLinkedIn = meta.isLinkedIn;
    }
    if (patch.label !== undefined) storePatch.label = patch.label.trim();
    if (patch.instructions !== undefined) {
      storePatch.instructions = patch.instructions.trim();
    }
    if (patch.intervalMinutes !== undefined || patch.frequencyPreset) {
      const interval = resolveInterval(patch);
      storePatch.intervalMinutes = interval.minutes;
      storePatch.frequencyPreset = interval.preset;
    }
    const next = await this.store.update(id, storePatch);
    if (next && next.status === "active") this.scheduleNextRun(next);
    return next;
  }

  async pause(id: string): Promise<void> {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    await this.store.setStatus(id, "paused");
  }

  /** Fortsetzen. Wirft, wenn der Active-Cap (5) bereits erreicht ist. */
  async resume(id: string): Promise<void> {
    const m = await this.store.get(id);
    if (!m || m.status === "active") return;
    // setStatus("active") prüft den Cap und wirft ggf. — sofort fällig.
    await this.store.setStatus(id, "active", {
      nextRunAt: new Date(Date.now() + 1000).toISOString(),
      resetFailures: true,
    });
    const refreshed = await this.store.get(id);
    if (refreshed) this.scheduleNextRun(refreshed);
  }

  async remove(id: string): Promise<void> {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    await this.store.delete(id);
    // v0.1.414 — zugehörige Lauf-Screenshots mit entfernen.
    await deleteMonitorScreenshots(id);
  }

  /**
   * Sofort einen Durchlauf erzwingen (UI „Jetzt prüfen").
   *
   * v0.1.411 — liefert jetzt ein ECHTES Ergebnis statt `void`. Vorher
   * schluckte der Aufruf jede Absage stumm (Monitor unbekannt, Lauf bereits
   * unterwegs), und der IPC-Handler meldete pauschal Erfolg — der Knopf
   * wirkte tot. Der Aufruf wartet bewusst auf das Ende des Durchlaufs
   * (bis ~3 min), damit der Renderer den Knopf so lange als „Prüft…"
   * anzeigen und danach das Ergebnis melden kann.
   */
  async runNow(
    id: string,
  ): Promise<{ ok: boolean; outcome?: LinkMonitorRunOutcome; error?: string }> {
    const m = await this.store.get(id);
    if (!m) return { ok: false, error: "Überwachung nicht gefunden." };
    if (this.inFlight.has(id)) {
      return { ok: false, error: "Für diese Überwachung läuft bereits eine Prüfung." };
    }
    const outcome = await this.runPipeline(m, "manual");
    const refreshed = await this.store.get(id);
    if (refreshed && refreshed.status === "active") {
      this.scheduleNextRun(refreshed);
    }
    if (outcome === undefined) {
      return { ok: false, error: "Prüfung konnte nicht gestartet werden." };
    }
    return { ok: true, outcome };
  }

  // ---- intern -------------------------------------------------------------

  private scheduleNextRun(monitor: LinkMonitor): void {
    if (this.stopping) return;
    const existing = this.timers.get(monitor.id);
    if (existing) clearTimeout(existing);
    if (monitor.status !== "active") return;

    const now = Date.now();
    const nextMs = new Date(monitor.nextRunAt).getTime();
    const delay = Math.max(1000, (Number.isFinite(nextMs) ? nextMs : now) - now);
    const capped = Math.min(delay, DELAY_CAP_MS);
    const timer = setTimeout(() => void this.fire(monitor.id), capped);
    this.timers.set(monitor.id, timer);
  }

  private async fire(id: string): Promise<void> {
    if (this.stopping) return;
    const monitor = await this.store.get(id);
    if (!monitor || monitor.status !== "active") return;

    // Wegen Delay-Cap evtl. noch nicht fällig → nur neu schedulen.
    const dueAt = new Date(monitor.nextRunAt).getTime();
    if (Number.isFinite(dueAt) && dueAt - Date.now() > 2_000) {
      this.scheduleNextRun(monitor);
      return;
    }

    // Concurrency-Limit: zu viele Läufe gleichzeitig → kurz vertagen.
    if (this.inFlight.size >= MAX_CONCURRENT_RUNS) {
      const timer = setTimeout(() => void this.fire(id), 30_000);
      this.timers.set(id, timer);
      return;
    }

    await this.runPipeline(monitor);

    const refreshed = await this.store.get(id);
    if (refreshed && refreshed.status === "active") {
      this.scheduleNextRun(refreshed);
    }
  }

  /**
   * Ein vollständiger Durchlauf inkl. Persistenz + ggf. Alert.
   *
   * v0.1.411 — gibt das Ergebnis zurück (`undefined`, wenn wegen eines schon
   * laufenden Durchlaufs abgelehnt) und meldet Start/Ende an die UI, damit
   * ein laufender Durchlauf sichtbar ist.
   */
  private async runPipeline(
    monitor: LinkMonitor,
    trigger: "manual" | "scheduled" = "scheduled",
  ): Promise<LinkMonitorRunOutcome | undefined> {
    if (this.inFlight.has(monitor.id)) return undefined;
    this.inFlight.add(monitor.id);
    // Laufenden Zustand sofort an den Renderer melden (Knopf → „Prüft…").
    this.emit("changed");
    const startedAt = new Date().toISOString();
    const ctrl = new AbortController();
    const deadlineAt = Date.now() + LINK_MONITOR_RUN_TIMEOUT_MS;
    const hardTimeout = setTimeout(
      () => ctrl.abort(),
      LINK_MONITOR_RUN_TIMEOUT_MS + 15_000,
    );

    let outcome: LinkMonitorRunOutcome = "ok";
    let note: string | null = null;
    let changeSummary: string | null = null;
    let contentHash = "";
    let observations: LinkObservations | null = null;
    let screenshotUrl: string | null = null;
    let targetMissed = false;
    let interstitialActions: string[] = [];

    try {
      const browse = await browseUrl(monitor.url, {
        isLinkedIn: monitor.isLinkedIn,
        instructions: monitor.instructions,
        signal: ctrl.signal,
        deadlineAt,
        // v0.1.415 — LLM für die Zwischenseiten-Steuerung (Cookie-Banner,
        // Alters-/Regionsabfragen), damit der Lauf wirklich auf der
        // Zielseite landet.
        providers: this.providers,
      });
      if (browse.truncated) {
        outcome = "timeout";
        note = browse.note ?? "Teilergebnis (Timeout/Längenlimit).";
      }
      // v0.1.415 — Zieladresse verfehlt (fremde Domain, Login-/Sperrseite).
      // Der Inhalt gehört dann NICHT zur überwachten Seite — das muss
      // sichtbar sein, statt still einen falschen Vergleich zu füttern.
      if (!browse.onTarget) {
        targetMissed = true;
        note = [note, browse.targetNote].filter(Boolean).join(" · ") || null;
      }
      interstitialActions = browse.interstitialActions;

      // v0.1.416 — Bot-Pruefung nicht durchgelaufen: Der Text stammt von
      // der Wartesseite, nicht von der Zielseite. Wir brechen den Lauf
      // hier EHRLICH ab, statt "keine Aenderung" zu melden (genau der
      // Fehler, den der Screenshot aufgedeckt hat) — und sparen zugleich
      // die LLM-Aufrufe fuer Extraktion und Vergleich.
      if (browse.botChallenge) {
        outcome = "error";
        targetMissed = true;
        note =
          "Sicherheitspruefung der Website war noch aktiv — die Zielseite " +
          "wurde nicht erreicht. Ein groesseres Pruefintervall verringert " +
          "die Wahrscheinlichkeit solcher Sperren.";
        throw new SkipRunError();
      }
      // v0.1.414 — Beweis-Screenshot ablegen, BEVOR die weitere Auswertung
      // laufen kann. So existiert er auch dann, wenn Extraktion oder Diff
      // danach scheitern — genau dann will man ja nachsehen können.
      if (browse.screenshot) {
        screenshotUrl = await saveRunScreenshot(monitor.id, browse.screenshot);
      }

      const extracted = await extractObservations({
        providers: this.providers,
        url: monitor.url,
        instructions: monitor.instructions,
        browse,
        signal: ctrl.signal,
      });
      observations = extracted.observations;
      contentHash = extracted.contentHash;

      const prevRun = await this.store.latestSuccessfulRun(monitor.id);
      const prevObs = (prevRun?.observations as LinkObservations | null) ?? null;
      const diff = await detectChange({
        providers: this.providers,
        instructions: monitor.instructions,
        previous: prevObs,
        previousHash: prevRun?.contentHash ?? null,
        current: observations,
        currentHash: contentHash,
        signal: ctrl.signal,
      });
      if (diff.changed) {
        outcome = "changed";
        changeSummary = diff.summary;
        this.fireAlert(monitor, diff.summary ?? "Inhalt hat sich geändert.", contentHash);
      }
    } catch (err) {
      // Kontrollierter Abbruch (z. B. Bot-Pruefung): outcome/note stehen
      // bereits, nicht ueberschreiben.
      if (!(err instanceof SkipRunError)) {
        outcome = "error";
        note = err instanceof Error ? err.message.slice(0, 300) : String(err);
      }
    } finally {
      clearTimeout(hardTimeout);
      this.inFlight.delete(monitor.id);
    }

    await this.persistRun(monitor, {
      startedAt,
      outcome,
      contentHash,
      observations,
      changeSummary,
      note,
    });
    await this.store.pruneRuns(monitor.id).catch(() => undefined);

    // v0.1.411 — Audit-Eintrag pro Durchlauf. Vorher tauchten
    // Link-Überwachungen im Audit-Trail überhaupt nicht auf.
    try {
      this.onAudit?.({
        action:
          trigger === "manual"
            ? "link-monitor.run.manual"
            : "link-monitor.run.scheduled",
        severity:
          outcome === "error"
            ? "error"
            : outcome === "timeout" || targetMissed
              ? "warning"
              : "info",
        summary:
          (targetMissed ? "⚠ Zielseite verfehlt — " : "") +
          `Link-Überwachung „${monitor.label}" ` +
          `(${trigger === "manual" ? "manuell" : "planmäßig"}): ` +
          (outcome === "changed"
            ? `Änderung erkannt — ${changeSummary ?? "Inhalt hat sich geändert."}`
            : outcome === "error"
              ? `Fehler — ${note ?? "unbekannt"}`
              : outcome === "timeout"
                ? `Zeitüberschreitung — ${note ?? "Teilergebnis"}`
                : "keine Änderung"),
        metadata: {
          monitorId: monitor.id,
          url: monitor.url,
          outcome,
          trigger,
          // v0.1.414 — im Verlauf als Bild dargestellt (siehe VerlaufTab).
          ...(screenshotUrl ? { screenshot: screenshotUrl } : {}),
          // v0.1.415 — Nachvollziehbarkeit der Zwischenseiten-Steuerung.
          ...(interstitialActions.length > 0
            ? { zwischenseite: interstitialActions }
            : {}),
          ...(targetMissed ? { zielseiteVerfehlt: true } : {}),
        },
      });
    } catch {
      /* Audit ist best-effort — darf den Lauf nie kippen */
    }

    return outcome;
  }

  private fireAlert(
    monitor: LinkMonitor,
    summary: string,
    contentHash: string,
  ): void {
    const alert = this.alerts.add({
      tenantId: null,
      companyId: "",
      companyName: monitor.label,
      kind: "link-change",
      severity: "warn",
      headline: `Änderung: ${monitor.label}`,
      rationale: summary,
      // Dedup über den Inhalts-Hash: dieselbe Änderung feuert nur einmal.
      sourceRef: `link-monitor:${monitor.id}:${contentHash.slice(0, 16)}`,
      url: monitor.url,
    });
    if (alert) {
      try {
        this.notify(alert);
      } catch {
        /* notify ist best-effort */
      }
      this.onAlertsChanged();
    }
  }

  private async persistRun(
    monitor: LinkMonitor,
    run: {
      startedAt: string;
      outcome: LinkMonitorRunOutcome;
      contentHash: string;
      observations: LinkObservations | null;
      changeSummary: string | null;
      note: string | null;
    },
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    const failed = run.outcome === "error";
    const consecutiveFailures = failed ? monitor.consecutiveFailures + 1 : 0;
    let status: LinkMonitorStatus | undefined;
    if (failed && consecutiveFailures >= LINK_MONITOR_MAX_CONSECUTIVE_FAILURES) {
      status = "error"; // Auto-Pause nach zu vielen Fehlversuchen.
    }
    const nextRunAt = new Date(
      Date.now() + monitor.intervalMinutes * 60_000,
    ).toISOString();

    await this.store.recordRun(
      {
        monitorId: monitor.id,
        startedAt: run.startedAt,
        finishedAt,
        outcome: run.outcome,
        contentHash: run.contentHash,
        observations: run.observations,
        changeSummary: run.changeSummary,
        note: run.note,
      },
      {
        nextRunAt,
        lastCheckedAt: finishedAt,
        lastOutcome: run.outcome,
        consecutiveFailures,
        status,
        lastChangedAt: run.outcome === "changed" ? finishedAt : null,
        lastChangeSummary: run.outcome === "changed" ? run.changeSummary : null,
      },
    );
  }
}

// ---- Helfer ----------------------------------------------------------------

interface UrlMeta {
  url: string;
  host: string;
  isLinkedIn: boolean;
}

/** URL normalisieren (Schema ergänzen), Host + LinkedIn-Flag ableiten. */
export function deriveMeta(rawUrl: string): UrlMeta {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let host = "";
  try {
    const u = new URL(url);
    host = u.host;
    url = u.toString();
  } catch {
    host = url;
  }
  const isLinkedIn = /(^|\.)linkedin\.com$/i.test(host);
  return { url, host, isLinkedIn };
}

/** Frequenz aus Input ableiten: intervalMinutes hat Vorrang vor Preset. */
function resolveInterval(input: Partial<LinkMonitorInput>): {
  minutes: number;
  preset: LinkMonitorFrequencyPreset;
} {
  if (input.intervalMinutes !== undefined) {
    const minutes = clampInterval(input.intervalMinutes);
    // Passt der geklemmte Wert exakt zu einem Preset? Dann Preset-Label.
    const preset = (Object.entries(LINK_MONITOR_PRESET_MINUTES).find(
      ([, m]) => m === minutes,
    )?.[0] ?? "custom") as LinkMonitorFrequencyPreset;
    return { minutes, preset };
  }
  if (input.frequencyPreset && input.frequencyPreset !== "custom") {
    return {
      minutes: LINK_MONITOR_PRESET_MINUTES[input.frequencyPreset],
      preset: input.frequencyPreset,
    };
  }
  // Default: täglich.
  return { minutes: LINK_MONITOR_PRESET_MINUTES.daily, preset: "daily" };
}
