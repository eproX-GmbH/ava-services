// v0.1.474 — Kontinuierlicher Mini-Profil-Worker (Radar-Paket a).
//
// Vorher entstanden Profile nur in 15er- (Automatik) bzw. 25er-Happen
// (Button) — ein 300er-Backlog aus einem Pro-Scan brauchte Wochen.
// Profile sind lokales Compute und fuettern den GETEILTEN Pool, also
// gilt: gar nicht drosseln, nur ruecksichtsvoll sein.
//
// Der Worker laeuft als Hintergrund-Schleife:
//   * Tick alle 10 Minuten (+ Kick nach jedem Scan/Button-Klick).
//   * Pro Drain mehrere Runden a 100 Kandidaten, bis nichts mehr
//     faellig ist — ICP-Branchen zuerst (prioritizeTerms).
//   * Pausiert zwischen Kandidaten, solange der Nutzer aktiv chattet
//     (shouldPause → Orchestrator-inFlight): der Chat hat Vorrang
//     vor Hintergrund-Compute.
//   * Fehl-Kandidaten (Crawl/LLM kaputt) bekommen 24 h Backoff, damit
//     tote Websites die Schleife nicht heisslaufen lassen.
//   * Nach jedem Drain mit neuen Profilen: onDrained(count) — der
//     Aufrufer haengt dort das inkrementelle Matching an (Paket c).

import type { GatewayClient } from "../agent/gateway-client";
import type { LlmProviderManager } from "../agent/providers";
import { runProfiler, type ProfilerSummary } from "./profiler";

const TICK_MS = 10 * 60_000;
const FIRST_TICK_DELAY_MS = 2 * 60_000;
const ROUND_LIMIT = 100;
const MAX_ROUNDS_PER_DRAIN = 20;
const FAIL_BACKOFF_MS = 24 * 3600_000;

export interface ProfileWorkerDeps {
  gateway: GatewayClient;
  providers: LlmProviderManager;
  getPrioritizeTerms: () => string[];
  isSignedIn: () => boolean;
  /** true = LLM gerade fuer einen interaktiven Turn gebraucht. */
  isLlmBusy: () => boolean;
  /** Neue Profile sind da → inkrementelles Matching anstossen. */
  onDrained: (profiliert: number) => void;
  onAudit?: (entry: {
    severity: "info" | "warning" | "error";
    summary: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export class ProfileWorker {
  private readonly deps: ProfileWorkerDeps;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<ProfilerSummary | { error: string }> | null = null;
  private readonly failedAt = new Map<string, number>();
  private lastSummary: ProfilerSummary | null = null;
  private lastDrainAt: string | null = null;

  constructor(deps: ProfileWorkerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), TICK_MS);
    setTimeout(() => void this.drain(), FIRST_TICK_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): {
    running: boolean;
    lastDrainAt: string | null;
    lastSummary: ProfilerSummary | null;
  } {
    return {
      running: this.current !== null,
      lastDrainAt: this.lastDrainAt,
      lastSummary: this.lastSummary,
    };
  }

  /** Sofort loslegen (nach Scan / Button-Klick). Laeuft schon einer,
   *  wird DER zurueckgegeben statt ein zweiter gestartet. */
  drain(): Promise<ProfilerSummary | { error: string }> {
    if (this.current) return this.current;
    this.current = this.drainInner().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private exclude(): Set<string> {
    const now = Date.now();
    for (const [id, at] of this.failedAt) {
      if (now - at > FAIL_BACKOFF_MS) this.failedAt.delete(id);
    }
    return new Set(this.failedAt.keys());
  }

  private async drainInner(): Promise<ProfilerSummary | { error: string }> {
    if (!this.deps.isSignedIn()) return { error: "Nicht angemeldet." };
    if (!this.deps.providers.getStatus().ready) {
      return { error: "Kein KI-Modell bereit." };
    }
    const total: ProfilerSummary = {
      betrachtet: 0,
      profiliert: 0,
      uebersprungenFrisch: 0,
      crawlFehler: 0,
      llmFehler: 0,
      ohneEmbedding: 0,
      dauerSek: 0,
      beispiele: [],
      fehlgeschlagenIds: [],
    };
    const t0 = Date.now();
    for (let round = 0; round < MAX_ROUNDS_PER_DRAIN; round++) {
      const r = await runProfiler(this.deps.gateway, this.deps.providers, {
        limit: ROUND_LIMIT,
        prioritizeTerms: this.deps.getPrioritizeTerms(),
        exclude: this.exclude(),
        shouldPause: this.deps.isLlmBusy,
      });
      if ("error" in r) {
        if (total.betrachtet === 0) return r;
        break;
      }
      total.betrachtet += r.betrachtet;
      total.profiliert += r.profiliert;
      total.uebersprungenFrisch += r.uebersprungenFrisch;
      total.crawlFehler += r.crawlFehler;
      total.llmFehler += r.llmFehler;
      total.ohneEmbedding += r.ohneEmbedding;
      for (const b of r.beispiele) {
        if (total.beispiele.length < 5) total.beispiele.push(b);
      }
      const now = Date.now();
      for (const id of r.fehlgeschlagenIds) {
        total.fehlgeschlagenIds.push(id);
        this.failedAt.set(id, now);
      }
      // Nichts mehr faellig (oder nur noch Fehl-Kandidaten): fertig.
      if (r.betrachtet === 0) break;
      if (r.profiliert === 0 && r.uebersprungenFrisch === 0) break;
    }
    total.dauerSek = Math.round((Date.now() - t0) / 1000);
    this.lastSummary = total;
    this.lastDrainAt = new Date().toISOString();
    if (total.profiliert > 0) {
      this.deps.onAudit?.({
        severity: "info",
        summary: `Profil-Worker: ${total.profiliert} Mini-Profile erstellt (${total.dauerSek}s)`,
        metadata: {
          profiliert: total.profiliert,
          crawlFehler: total.crawlFehler,
          llmFehler: total.llmFehler,
        },
      });
      try {
        this.deps.onDrained(total.profiliert);
      } catch (err) {
        console.warn("[profile-worker] onDrained failed:", err);
      }
    }
    return total;
  }
}
