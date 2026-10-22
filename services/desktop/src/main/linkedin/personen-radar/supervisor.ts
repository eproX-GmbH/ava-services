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
import type { LlmProviderManager } from "../../agent/providers";
import {
  buildMessages,
  parseJsonObject,
  streamToText,
} from "../../link-monitor/llm";
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
  /** v0.1.519 — fuer die Headline-Extraktion per LLM. */
  providers: LlmProviderManager;
  keyStore: WatchlistKeyStore;
  /** v0.1.580 — eigener Token oder Organisationsschluessel (Gateway-Proxy). */
  getApifyAccess: () => Promise<import("../apify-access").ApifyAccess | null>;
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

  /**
   * v0.1.519 — Arbeitgeber aus der Headline per LLM (User-Direktive
   * 2026-09-02: "bei/at/@"-Heuristik deckt die Realitaet nicht ab).
   * Halluzinationssperre: der genannte Name muss WOERTLICH in der
   * Headline stehen (Whitespace-gefaltet, case-insensitiv) — sonst
   * null. Kein Modell bereit → null (dann greift die Heuristik).
   */
  async firmaAusHeadlinePerLlm(headline: string): Promise<string | null> {
    if (!this.deps.providers.getStatus().ready) return null;
    const system =
      "Du liest LinkedIn-Headlines und nennst den AKTUELLEN Arbeitgeber (Firmenname), " +
      "falls die Headline einen nennt. Regeln: Nur den Firmennamen, exakt so geschrieben " +
      "wie in der Headline, ohne Rolle, ohne Zusatz. Hochschulen, Vereine und Eigenmarken " +
      "gelten als Arbeitgeber. Steht KEIN Arbeitgeber in der Headline (nur Rolle, Slogan, " +
      "Themen), antworte mit null. Niemals raten oder ergaenzen. " +
      'Antworte NUR als JSON: {"firma": "<Name>" | null}';
    try {
      const producerModel = this.deps.providers.getProducerModelOverride();
      const raw = await streamToText(
        this.deps.providers,
        buildMessages(system, headline.slice(0, 300), "pradar-headline"),
        { timeoutMs: 30_000, ...(producerModel ? { modelOverride: producerModel } : {}) },
      );
      const parsed = parseJsonObject(raw) as { firma?: unknown } | null;
      const firma = typeof parsed?.firma === "string" ? parsed.firma.trim() : "";
      if (firma.length < 2 || firma.length > 80) return null;
      const falte = (t: string) => t.replace(/\s+/g, " ").toLowerCase();
      if (!falte(headline).includes(falte(firma))) return null;
      return firma;
    } catch (err) {
      console.warn("[personen-radar] Headline-Extraktion fehlgeschlagen:", err);
      return null;
    }
  }

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
    if (!this.deps.isSignedIn()) return;
    if (cfg.postUrls.length === 0) return;
    if (!(await this.deps.getApifyAccess())) return;
    const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
    if (Date.now() - last < cfg.intervalHours * 3600_000) return;
    await this.runNow("automatik");
  }

  async runNow(trigger: "automatik" | "manuell"): Promise<string> {
    if (this.running) return "Personen-Radar-Lauf laeuft bereits.";
    const cfg = this.deps.store.getConfig();
    const key = await this.deps.getApifyAccess();
    if (!key) return "Kein Apify-Zugang: weder eigener Token (LinkedIn → Watchlist) noch Organisationsschluessel.";
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

      // 2. Dedupe je (Person, Post) — docs/PLAN_LINKEDIN_LEADS.md L2: dieselbe Person auf
      //    einem zweiten Post ist ein eigener Lead (starkes Signal), kostet aber keinen
      //    zweiten Profil-Lookup (Firmen-Cache 90 Tage). Je Paar den staerksten Auftritt
      //    behalten (Kommentar > Reaktion).
      const proPaar = new Map<string, Engager>();
      for (const e of alle) {
        const k = `${e.profileUrl}|${e.postUrl}`;
        const vorhanden = proPaar.get(k);
        if (!vorhanden || (e.activityType === "comment" && vorhanden.activityType !== "comment")) proPaar.set(k, e);
      }
      const neuePaare = await this.deps.store.filterNewPersons([...proPaar.keys()]);
      const proPerson = new Map<string, Engager[]>();
      for (const k of neuePaare) {
        const e = proPaar.get(k)!;
        proPerson.set(e.profileUrl, [...(proPerson.get(e.profileUrl) ?? []), e]);
      }
      neuePersonen = proPerson.size;
      const firmenCache = await this.deps.store.getFirmenCache([...proPerson.keys()]);

      // 3. Budget-Aufloesung (§8.2: teuerster Schritt hart gedeckelt); gecachte Personen
      //    kosten nichts und zaehlen nicht gegen das Budget.
      const kandidaten: Array<{
        name: string;
        domain: string;
        meta: Record<string, unknown>;
      }> = [];
      const leads: Array<Record<string, unknown>> = [];
      const unklar: Array<{ profileUrl: string; name: string | null; headline: string | null; grund: string }> = [];
      const bearbeitet: string[] = [];
      const firmenImLauf = new Set<string>();
      let budget = cfg.maxResolvesPerRun;
      for (const [url, auftritte] of proPerson) {
        const engager = auftritte[0]!;
        let matches = firmenCache.get(url) as Array<{ domain: string; companyName: string; rolle: string | null; konfidenz: "hart" | "mittel" }> | undefined;
        let grund: string | null = null;
        if (!matches) {
          if (budget <= 0) break;
          budget--;
          try {
            const r = await resolveEngagerCompanies({
              access: key,
              actors: cfg.actorIds,
              gateway: this.deps.gateway,
              engager,
              firmaAusHeadline: (h) => this.firmaAusHeadlinePerLlm(h),
            });
            this.deps.keyStore.addMonthItems(r.kosteneinheiten);
            matches = r.matches;
            grund = r.unaufgeloest[0] ?? null;
            if (matches.length > 0) await this.deps.store.setFirmenCache(url, matches);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.startsWith("APIFY_AUTH") || msg.startsWith("APIFY_CREDITS")) {
              this.finishRun(startedAt, msg, trigger, "error");
              return msg;
            }
            probleme.push(`${engager.name ?? url}: ${msg.slice(0, 80)}`);
            continue;
          }
        }
        bearbeitet.push(...auftritte.map((e) => `${e.profileUrl}|${e.postUrl}`));
        if (matches.length > 0) aufgeloest++;
        else {
          unklar.push({ profileUrl: url, name: engager.name, headline: engager.headline, grund: grund ?? "keine belastbare Firma" });
        }
        for (const e of auftritte) {
          const basis = { postUrl: e.postUrl, personName: e.name, profileUrl: e.profileUrl, headline: e.headline, aktivitaet: e.activityType, reactionType: e.reactionType, kommentar: e.commentText?.slice(0, 200) ?? null };
          if (matches.length === 0) {
            leads.push({ ...basis, status: "ungeklaert", grund: grund ?? "keine belastbare Firma" });
            continue;
          }
          for (const m of matches.slice(0, 2)) {
            leads.push({ ...basis, rolle: m.rolle, firmaDomain: m.domain, firmaName: m.companyName, konfidenz: m.konfidenz === "hart" ? 0.9 : 0.6 });
            if (firmenImLauf.has(m.domain)) continue;
            firmenImLauf.add(m.domain);
            kandidaten.push({
              name: m.companyName,
              domain: m.domain,
              meta: {
                ausloeser: {
                  person: e.name,
                  profileUrl: e.profileUrl,
                  rolle: m.rolle,
                  aktivitaet: e.activityType,
                  reactionType: e.reactionType,
                  kommentar: e.commentText?.slice(0, 200) ?? null,
                  postUrl: e.postUrl,
                  konfidenz: m.konfidenz,
                },
              },
            });
          }
        }
      }

      // 3b. Leads ans Gateway (Bereich LinkedIn-Leads); die Firma geht zusaetzlich als
      //     Direkt-Kandidat in den Trichter, damit Mini-Profil und Ort entstehen — die
      //     Radar-Liste blendet diese Quelle aus.
      let leadsNeu = 0;
      if (leads.length > 0) {
        try {
          const r = await this.deps.gateway.request<{ neu: number; aktualisiert: number; vorhanden: number }>("/v1/linkedin-leads/batch", { method: "POST", body: { leads: leads.slice(0, 500) } });
          leadsNeu = r.neu + r.aktualisiert;
        } catch (err) {
          probleme.push(`Leads speichern: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
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
          if (r.added > 0) this.deps.onCandidatesAdded();
          if (leadsNeu > 0) {
            const kommentare = leads.filter((l) => l.aktivitaet === "comment").length;
            const alert = this.deps.alerts.add({
              tenantId: null,
              companyId: "",
              companyName: "LinkedIn-Leads",
              kind: "linkedin-signal",
              severity: "info",
              headline: `${leadsNeu} neue LinkedIn-Leads`,
              rationale: `${leadsNeu} Personen haben auf beobachtete Posts reagiert${kommentare > 0 ? `, davon ${kommentare} mit Kommentar` : ""}. Bereich LinkedIn → Leads.`,
              sourceRef: `leads:${startedAt}`,
            });
            if (alert) {
              try {
                this.deps.notify(alert);
              } catch {
                /* best-effort */
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
        `${leadsNeu} neue Leads`,
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
