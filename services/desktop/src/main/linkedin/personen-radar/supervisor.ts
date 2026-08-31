// Personen-Radar PR3 (PLAN §8) — Supervisor.
//
// Lauf: Quell-Posts → Engagement (Reaktionen + Kommentare) →
// Personen-Dedupe (90 Tage) → Budget-Aufloesung (Kaskade §8.1,
// teuerster Schritt zuerst gedeckelt) → gematchte Firmen als
// DIREKT-Kandidaten in den normalen Radar-Trichter (Gateway-Route,
// eigener Tages-Deckel) MIT Ausloeser-Person im meta. Profiler +
// inkrementeller ICP-Match uebernehmen danach automatisch.
//
// Info-Alert je NEUER Firma ("Engager X, Rolle Y, reagierte auf Z")
// — der eigentliche Match-Alert kommt spaeter aus dem Radar-Pfad.

import type { AlertsStore } from "../../agent/alerts-store";
import type { GatewayClient } from "../../agent/gateway-client";
import type { Alert } from "../../../shared/types";
import type { WatchlistKeyStore } from "../watchlist/key-store";
import { fetchPostEngagement, type Engager } from "./engagement";
import { resolveEngagerCompanies } from "./matching";
import type { PersonenRadarStore } from "./store";

const CHECK_INTERVAL_MS = 60 * 60_000;
const FIRST_TICK_DELAY_MS = 5 * 60_000;
const MAX_POSTS_PER_RUN = 10;
const MAX_CANDIDATES_PER_BATCH = 25;

export interface PersonenRadarSupervisorDeps {
  keyStore: WatchlistKeyStore;
  store: PersonenRadarStore;
  gateway: GatewayClient;
  alerts: AlertsStore;
  notify: (alert: Alert) => void;
  onAlertsChanged: () => void;
  isSignedIn: () => boolean;
  /** Nach neuen Kandidaten den Profil-Worker anstossen. */
  onCandidatesAdded: () => void;
  onAudit: (entry: {
    action: string;
    severity: "info" | "warning" | "error";
    summary: string;
    metadata?: Record<string, unknown>;
  }) => void;
}

export class PersonenRadarSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: PersonenRadarSupervisorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    setTimeout(() => void this.tick(), FIRST_TICK_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async tick(): Promise<void> {
    const cfg = this.deps.store.getConfig();
    if (!cfg.enabled || this.running) return;
    if (!this.deps.isSignedIn() || !this.deps.keyStore.hasKey()) return;
    if (cfg.postUrls.length === 0) return;
    const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
    if (Date.now() - last < cfg.intervalHours * 3600_000) return;
    await this.runNow("automatik");
  }

  async runNow(trigger: "automatik" | "manuell"): Promise<string> {
    if (this.running) return "Personen-Radar-Lauf laeuft bereits.";
    const cfg = this.deps.store.getConfig();
    const key = this.deps.keyStore.getKey();
    if (!key) return "Kein Apify-Token hinterlegt (LinkedIn → Watchlist).";
    if (cfg.postUrls.length === 0) return "Keine Quell-Posts konfiguriert.";
    this.running = true;
    const startedAt = new Date().toISOString();
    let items = 0;
    let engagerGesamt = 0;
    let neuePersonen = 0;
    let aufgeloest = 0;
    let firmenNeu = 0;
    let firmenBekannt = 0;
    const probleme: string[] = [];
    try {
      // 1. Engagement einsammeln.
      const alle: Engager[] = [];
      for (const postUrl of cfg.postUrls.slice(0, MAX_POSTS_PER_RUN)) {
        try {
          const r = await fetchPostEngagement(
            key,
            cfg.actorIds,
            postUrl,
            cfg.maxItemsPerPost,
          );
          items += r.kosteneinheiten;
          alle.push(...r.engager);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("APIFY_AUTH") || msg.startsWith("APIFY_CREDITS")) {
            this.finishRun(startedAt, msg, trigger, "error");
            return msg;
          }
          probleme.push(`Post ${postUrl.slice(0, 50)}…: ${msg.slice(0, 80)}`);
        }
      }
      engagerGesamt = alle.length;
      this.deps.keyStore.addMonthItems(items);

      // 2. Personen-Dedupe (eine Person = ein Aufloesungsversuch, je
      //    90 Tage) + pro Person den staerksten Auftritt behalten
      //    (Kommentar > Reaktion).
      const proPerson = new Map<string, Engager>();
      for (const e of alle) {
        const vorhanden = proPerson.get(e.profileUrl);
        if (!vorhanden || (e.activityType === "comment" && vorhanden.activityType !== "comment")) {
          proPerson.set(e.profileUrl, e);
        }
      }
      const neu = await this.deps.store.filterNewPersons([...proPerson.keys()]);
      neuePersonen = neu.size;

      // 3. Budget-Aufloesung (§8.2: teuerster Schritt hart gedeckelt).
      const kandidaten: Array<{
        name: string;
        domain: string;
        meta: Record<string, unknown>;
      }> = [];
      const unklar: Array<{ profileUrl: string; name: string | null; headline: string | null; grund: string }> = [];
      const bearbeitet: string[] = [];
      let budget = cfg.maxResolvesPerRun;
      for (const url of neu) {
        if (budget <= 0) break;
        const engager = proPerson.get(url)!;
        budget--;
        bearbeitet.push(url);
        try {
          const r = await resolveEngagerCompanies({
            key,
            actors: cfg.actorIds,
            gateway: this.deps.gateway,
            engager,
          });
          this.deps.keyStore.addMonthItems(r.kosteneinheiten);
          aufgeloest += r.matches.length > 0 ? 1 : 0;
          if (r.matches.length === 0) {
            unklar.push({
              profileUrl: url,
              name: engager.name,
              headline: engager.headline,
              grund: r.unaufgeloest[0] ?? "keine belastbare Firma",
            });
            continue;
          }
          for (const m of r.matches.slice(0, 2)) {
            kandidaten.push({
              name: m.companyName,
              domain: m.domain,
              meta: {
                ausloeser: {
                  person: engager.name,
                  profileUrl: engager.profileUrl,
                  rolle: m.rolle,
                  aktivitaet: engager.activityType,
                  reactionType: engager.reactionType,
                  kommentar: engager.commentText?.slice(0, 200) ?? null,
                  postUrl: engager.postUrl,
                  konfidenz: m.konfidenz,
                },
              },
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("APIFY_AUTH") || msg.startsWith("APIFY_CREDITS")) {
            this.finishRun(startedAt, msg, trigger, "error");
            return msg;
          }
          probleme.push(`${engager.name ?? url}: ${msg.slice(0, 80)}`);
        }
      }

      // 4. Direkt in den Radar-Trichter (Batch, eigener Tages-Deckel).
      if (kandidaten.length > 0) {
        try {
          const r = await this.deps.gateway.request<{
            added: number;
            updated: number;
            known: Record<string, string>;
          }>("/v1/discovery/candidates/direct", {
            method: "POST",
            body: {
              source: "personen-radar",
              candidates: kandidaten.slice(0, MAX_CANDIDATES_PER_BATCH).map((k) => ({
                name: k.name,
                domain: k.domain,
                source: "personen-radar",
                meta: k.meta,
              })),
            },
          });
          firmenNeu = r.added;
          firmenBekannt = r.updated + Object.keys(r.known).length;
          if (r.added > 0) {
            this.deps.onCandidatesAdded();
            for (const k of kandidaten.slice(0, 5)) {
              const a = k.meta.ausloeser as Record<string, unknown>;
              const alert = this.deps.alerts.add({
                tenantId: null,
                companyId: "",
                companyName: k.name,
                kind: "radar-match",
                severity: "info",
                headline: `Personen-Radar: ${k.name} entdeckt`,
                rationale: `${String(a.person ?? "Eine Person")}${a.rolle ? ` (${String(a.rolle)})` : ""} hat auf einen beobachteten Post ${a.aktivitaet === "comment" ? "kommentiert" : "reagiert"} — Firma dem Radar hinzugefuegt. ${String(a.postUrl ?? "")}`,
                sourceRef: `pradar:${k.domain}`,
              });
              if (alert) {
                try {
                  this.deps.notify(alert);
                } catch {
                  /* best-effort */
                }
              }
            }
            this.deps.onAlertsChanged();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          probleme.push(
            msg.includes("DIRECT_CAP")
              ? "Tages-Deckel fuer Direkt-Kandidaten erreicht — Rest kommt beim naechsten Lauf."
              : `Kandidaten-Einspeisung: ${msg.slice(0, 100)}`,
          );
        }
      }

      // 5. Buchhaltung.
      await this.deps.store.markPersonsSeen(bearbeitet);
      if (unklar.length > 0) await this.deps.store.addUnklar(unklar);

      const outcome = [
        `${engagerGesamt} Engagements (${items} Items)`,
        `${neuePersonen} neue Personen`,
        `${aufgeloest} aufgeloest`,
        `${firmenNeu} neue Firmen im Radar` +
          (firmenBekannt > 0 ? ` (${firmenBekannt} bereits bekannt)` : ""),
        unklar.length > 0 ? `${unklar.length} ungeklaert` : null,
        probleme.length > 0 ? `Probleme: ${probleme.slice(0, 2).join(" · ")}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      this.finishRun(startedAt, outcome, trigger, probleme.length > 0 ? "warning" : "info");
      return outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishRun(startedAt, `Fehler: ${msg.slice(0, 200)}`, trigger, "error");
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
    this.deps.store.setConfig({ lastRunAt: startedAt, lastOutcome: outcome });
    this.deps.onAudit({
      action: "linkedin.personenRadar.run",
      severity,
      summary: `Personen-Radar-Lauf (${trigger}): ${outcome}`,
      metadata: { trigger, startedAt },
    });
  }
}
