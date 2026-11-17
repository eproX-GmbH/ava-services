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
import { fetchPostEngagement, zeitfensterSeit, type EngagementAbruf, type Engager } from "./engagement";
import { resolveEngagerCompanies } from "./matching";
import type { PersonenRadarStore } from "./store";

const CHECK_INTERVAL_MS = 60 * 60_000;
const FIRST_TICK_DELAY_MS = 5 * 60_000;
const MAX_POSTS_PER_RUN = 10;
const MAX_CANDIDATES_PER_BATCH = 25;
/** PM-2026-0052 — volles Nachladen: hoechstens so viele Kommentare (explizit, damit das
 *  Gateway die Kosten richtig schaetzt; maxItems 0 hiesse beim Actor ebenfalls 1.000). */
export const NACHLADEN_MAX_KOMMENTARE = 1000;
/** So viele wartende Personen nimmt ein Lauf zusaetzlich auf. */
const WARTESCHLANGE_JE_LAUF = 1000;
/** PM-2026-0053 — so viele Personen werden gleichzeitig ihrer Firma zugeordnet. */
const ZUORDNUNG_PARALLEL = 5;
/** Hoechstdauer einer Zuordnung (Profil, Firmenseite, Websuche); danach wartet die Person. */
const ZUORDNUNG_TIMEOUT_MS = 3 * 60_000;
const GATEWAY_TIMEOUT_MS = 60_000;
/** Nach so vielen zugeordneten Personen werden Leads und Kandidaten gespeichert. */
const SPEICHER_PAKET = 10;

export interface LaufFortschritt {
  phase: "kommentare" | "zuordnen";
  gesamt: number;
  erledigt: number;
  leads: number;
  seit: string;
}

/** Fuehrt `fn` fuer alle Eintraege aus, hoechstens `n` gleichzeitig. */
export async function nebenlaeufig<T>(eintraege: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const arbeiter = async (): Promise<void> => {
    while (i < eintraege.length) {
      const x = eintraege[i++]!;
      await fn(x);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, eintraege.length)) }, arbeiter));
}

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
  /** docs/PLAN_LINKEDIN_LEADS.md L5 — neue Leads mit Firma (Workflow-Ereignis linkedin.lead). */
  onLeads?: (leads: Array<Record<string, unknown>>) => void;
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
  /** PM-2026-0053 — Stand des laufenden Laufs fuer Anzeige und Chat. */
  private fortschritt: LaufFortschritt | null = null;

  getFortschritt(): LaufFortschritt | null {
    return this.fortschritt ? { ...this.fortschritt } : null;
  }

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

  /**
   * PM-2026-0052 — `nachladen`: fuer EINEN beobachteten Post alle Kommentare (mit Antworten)
   * holen und mit groesserem Budget zuordnen. Ist der Post schon voll geladen, holt der Lauf
   * nur neue Kommentare und arbeitet die Warteschlange weiter ab.
   */
  async runNow(trigger: "automatik" | "manuell", opts: { nachladen?: string } = {}): Promise<string> {
    if (this.running) return "Personen-Radar-Lauf laeuft bereits.";
    const cfg = this.deps.store.getConfig();
    const key = await this.deps.getApifyAccess();
    if (!key) return "Kein Apify-Zugang: weder eigener Token (LinkedIn → Watchlist) noch Organisationsschluessel.";
    if (cfg.postUrls.length === 0) return "Keine Quell-Posts konfiguriert.";
    const nachladen = opts.nachladen?.trim() || null;
    if (nachladen && !cfg.postUrls.includes(nachladen)) return "Dieser Post wird nicht beobachtet.";
    const posts = nachladen ? [nachladen] : cfg.postUrls.slice(0, MAX_POSTS_PER_RUN);
    this.running = true;
    const startedAt = new Date().toISOString();
    let items = 0;
    let engagerGesamt = 0;
    let neuePersonen = 0;
    let aufgeloest = 0;
    let firmenNeu = 0;
    let firmenBekannt = 0;
    const probleme: string[] = [];
    const hinweise: string[] = [];
    try {
      // 1. Engagement einsammeln. PM-2026-0052: der Actor kennt kein Blaettern. Ohne volles
      //    Nachladen sieht jeder Lauf dieselben ersten Kommentare; danach nur noch neue.
      const alle: Engager[] = [];
      this.fortschritt = { phase: "kommentare", gesamt: posts.length, erledigt: 0, leads: 0, seit: startedAt };
      for (const postUrl of posts) {
        const stand = cfg.postStand[postUrl];
        const fenster = stand?.vollGeladenAt ? zeitfensterSeit(stand.letzterAbrufAt) : null;
        const abruf: EngagementAbruf =
          nachladen && !stand?.vollGeladenAt
            ? { reaktionen: 0, kommentare: NACHLADEN_MAX_KOMMENTARE, antworten: true, lang: true }
            : nachladen
              ? { reaktionen: 0, kommentare: NACHLADEN_MAX_KOMMENTARE, antworten: true, zeitfenster: fenster ?? "month", lang: true }
              : stand?.vollGeladenAt && fenster
                ? { reaktionen: cfg.maxItemsPerPost, kommentare: cfg.maxItemsPerPost, antworten: true, zeitfenster: fenster }
                : { reaktionen: cfg.maxItemsPerPost, kommentare: cfg.maxItemsPerPost };
        try {
          const r = await fetchPostEngagement(key, cfg.actorIds, postUrl, abruf);
          if (this.fortschritt) this.fortschritt.erledigt++;
          items += r.kosteneinheiten;
          alle.push(...r.engager);
          this.deps.store.setPostStand(postUrl, {
            letzterAbrufAt: startedAt,
            ...(nachladen && !stand?.vollGeladenAt ? { vollGeladenAt: startedAt } : {}),
          });
          if (!stand?.vollGeladenAt && !nachladen && r.kommentare >= cfg.maxItemsPerPost) {
            hinweise.push(`Post hat mehr als ${cfg.maxItemsPerPost} Kommentare, ältere erst nach „Alle Kommentare nachladen“`);
          }
          if (nachladen && !stand?.vollGeladenAt && r.kommentare >= NACHLADEN_MAX_KOMMENTARE) {
            hinweise.push(`mehr als ${NACHLADEN_MAX_KOMMENTARE} Kommentare, die ältesten fehlen`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("APIFY_AUTH") || msg.startsWith("APIFY_CREDITS") || msg.startsWith("LINKEDIN_LIMIT")) {
            // P4: Limit der LinkedIn-Beobachtung → Lauf endet, Automatik bleibt an (naechster Monat/Limit-Erhoehung).
            if (msg.startsWith("LINKEDIN_LIMIT")) this.linkedinLimitMelden(msg);
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
      // PM-2026-0052: zuerst die Personen, die frueher am Budget gescheitert sind.
      const wartend = await this.deps.store.offeneHolen(WARTESCHLANGE_JE_LAUF, nachladen);
      for (const e of [...wartend, ...alle]) {
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
      // PM-2026-0053: alle neuen Personen sofort vormerken; nach dem Speichern fallen sie wieder
      // heraus. Wird AVA mitten im Lauf beendet, macht der naechste Lauf genau dort weiter.
      await this.deps.store.offeneAblegen([...proPerson.values()].flat());
      const firmenCache = await this.deps.store.getFirmenCache([...proPerson.keys()]);

      // 3. Aufloesung. PM-2026-0053: parallel (ZUORDNUNG_PARALLEL), jede Person mit Zeitlimit,
      //    Ergebnisse in Paketen gespeichert — ein haengender Aufruf blockiert nicht mehr den
      //    ganzen Lauf, und ein Abbruch verliert hoechstens das letzte Paket. Gecachte Personen
      //    kosten nichts und zaehlen nicht gegen das Budget; beim Nachladen gibt es keinen Deckel.
      type Kandidat = { name: string; domain: string; meta: Record<string, unknown> };
      type Unklar = { profileUrl: string; name: string | null; headline: string | null; grund: string };
      const zuordnen = [...proPerson.entries()];
      let budget = nachladen ? Number.POSITIVE_INFINITY : cfg.maxResolvesPerRun;
      const zurueckgestellt: Engager[] = [];
      const firmenImLauf = new Set<string>();
      let unklarGesamt = 0;
      let leadsNeu = 0;
      let leadsKommentare = 0;
      let abbruch: string | null = null;
      type Puffer = { leads: Array<Record<string, unknown>>; kandidaten: Kandidat[]; unklar: Unklar[]; bearbeitet: string[]; engager: Engager[]; personen: number };
      const leer = (): Puffer => ({ leads: [], kandidaten: [], unklar: [], bearbeitet: [], engager: [], personen: 0 });
      let puffer: Puffer = leer();
      const speichern = async (): Promise<void> => {
        const p = puffer;
        puffer = leer();
        if (p.personen === 0) return;
        if (p.leads.length > 0) {
          try {
            const r = await this.deps.gateway.request<{ neu: number; aktualisiert: number; vorhanden: number; ids?: Array<{ profileUrl: string; postUrl: string; id: string; neu: boolean }> }>("/v1/linkedin-leads/batch", { method: "POST", body: { leads: p.leads.slice(0, 500) }, signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
            const neuHier = r.neu + r.aktualisiert;
            leadsNeu += neuHier;
            leadsKommentare += p.leads.filter((l) => l.aktivitaet === "comment").length;
            if (neuHier > 0 && this.deps.onLeads) {
              try {
                // 2026-10-31: leadId aus der Gateway-Antwort mitgeben (Workflow-Ereignis linkedin.lead);
                // nur neue Leads loesen aus — bereits bekannte waren schon einmal Ereignis.
                const idJeLead = new Map((r.ids ?? []).map((x) => [`${x.profileUrl}|${x.postUrl}`, x] as const));
                this.deps.onLeads(
                  p.leads
                    .filter((l) => typeof l.firmaDomain === "string" && l.firmaDomain)
                    .map((l) => ({ ...l, leadId: idJeLead.get(`${l.profileUrl}|${l.postUrl}`)?.id ?? null, neu: idJeLead.get(`${l.profileUrl}|${l.postUrl}`)?.neu ?? true }))
                    .filter((l) => l.neu),
                );
              } catch {
                /* best-effort */
              }
            }
          } catch (err) {
            // Nicht gespeichert: Personen bleiben ungesehen und warten auf den naechsten Lauf
            // (Firmen-Cache macht die erneute Zuordnung kostenlos).
            zurueckgestellt.push(...p.engager);
            probleme.push(`Leads speichern: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`);
            return;
          }
        }
        // Die Firma geht zusaetzlich als Direkt-Kandidat in den Trichter, damit Mini-Profil und
        // Ort entstehen — die Radar-Liste blendet diese Quelle aus.
        for (let i = 0; i < p.kandidaten.length; i += MAX_CANDIDATES_PER_BATCH) {
          try {
            const r = await this.deps.gateway.request<{ added: number; updated: number; known: Record<string, string> }>("/v1/discovery/candidates/direct", {
              method: "POST",
              body: {
                source: "personen-radar",
                candidates: p.kandidaten.slice(i, i + MAX_CANDIDATES_PER_BATCH).map((k) => ({ name: k.name, domain: k.domain, source: "personen-radar", meta: k.meta })),
              },
              signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
            });
            firmenNeu += r.added;
            firmenBekannt += r.updated + Object.keys(r.known).length;
            if (r.added > 0) this.deps.onCandidatesAdded();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            probleme.push(msg.includes("DIRECT_CAP") ? "Tages-Deckel fuer Direkt-Kandidaten erreicht — Rest kommt beim naechsten Lauf." : `Kandidaten-Einspeisung: ${msg.slice(0, 100)}`);
            break;
          }
        }
        await this.deps.store.markPersonsSeen(p.bearbeitet);
        if (p.unklar.length > 0) await this.deps.store.addUnklar(p.unklar);
        await this.deps.store.offeneEntfernen(p.bearbeitet);
        if (this.fortschritt) this.fortschritt.leads = leadsNeu;
      };
      let kette: Promise<void> = Promise.resolve();
      const sichern = (): Promise<void> => (kette = kette.then(speichern).catch(() => undefined));

      this.fortschritt = { phase: "zuordnen", gesamt: zuordnen.length, erledigt: 0, leads: 0, seit: startedAt };
      await nebenlaeufig(zuordnen, ZUORDNUNG_PARALLEL, async ([url, auftritte]) => {
        const engager = auftritte[0]!;
        let matches = firmenCache.get(url) as Array<{ domain: string; companyName: string; rolle: string | null; konfidenz: "hart" | "mittel" }> | undefined;
        let grund: string | null = null;
        if (!matches) {
          // Budget aufgebraucht oder Lauf abgebrochen: merken statt verwerfen.
          if (abbruch || budget <= 0) {
            zurueckgestellt.push(...auftritte);
            return;
          }
          budget--;
          try {
            const r = await resolveEngagerCompanies({
              access: key,
              actors: cfg.actorIds,
              gateway: this.deps.gateway,
              engager,
              firmaAusHeadline: (h) => this.firmaAusHeadlinePerLlm(h),
              signal: AbortSignal.timeout(ZUORDNUNG_TIMEOUT_MS),
            });
            this.deps.keyStore.addMonthItems(r.kosteneinheiten);
            matches = r.matches;
            grund = r.unaufgeloest[0] ?? null;
            if (matches.length > 0) await this.deps.store.setFirmenCache(url, matches);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            zurueckgestellt.push(...auftritte);
            if (msg.startsWith("APIFY_AUTH") || msg.startsWith("APIFY_CREDITS") || msg.startsWith("LINKEDIN_LIMIT")) {
              abbruch ??= msg;
              return;
            }
            probleme.push(`${engager.name ?? url}: ${/abort|timeout/i.test(msg) ? "Zeitlimit überschritten" : msg.slice(0, 80)}`);
            return;
          } finally {
            if (this.fortschritt) this.fortschritt.erledigt++;
          }
        } else if (this.fortschritt) {
          this.fortschritt.erledigt++;
        }
        puffer.bearbeitet.push(...auftritte.map((e) => `${e.profileUrl}|${e.postUrl}`));
        puffer.engager.push(...auftritte);
        puffer.personen++;
        if (matches.length > 0) aufgeloest++;
        else {
          unklarGesamt++;
          puffer.unklar.push({ profileUrl: url, name: engager.name, headline: engager.headline, grund: grund ?? "keine belastbare Firma" });
        }
        for (const e of auftritte) {
          const basis = { postUrl: e.postUrl, personName: e.name, profileUrl: e.profileUrl, headline: e.headline, aktivitaet: e.activityType, reactionType: e.reactionType, kommentar: e.commentText?.slice(0, 200) ?? null };
          if (matches.length === 0) {
            puffer.leads.push({ ...basis, status: "ungeklaert", grund: grund ?? "keine belastbare Firma" });
            continue;
          }
          for (const m of matches.slice(0, 2)) {
            puffer.leads.push({ ...basis, rolle: m.rolle, firmaDomain: m.domain, firmaName: m.companyName, konfidenz: m.konfidenz === "hart" ? 0.9 : 0.6 });
            if (firmenImLauf.has(m.domain)) continue;
            firmenImLauf.add(m.domain);
            puffer.kandidaten.push({
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
        if (puffer.personen >= SPEICHER_PAKET) await sichern();
      });
      await sichern();
      await kette;
      await this.deps.store.offeneAblegen(zurueckgestellt);

      if (leadsNeu > 0) {
        const alert = this.deps.alerts.add({
          tenantId: null,
          companyId: "",
          companyName: "LinkedIn-Leads",
          kind: "linkedin-signal",
          severity: "info",
          headline: `${leadsNeu} neue LinkedIn-Leads`,
          rationale: `${leadsNeu} Personen haben auf beobachtete Posts reagiert${leadsKommentare > 0 ? `, davon ${leadsKommentare} mit Kommentar` : ""}. Bereich LinkedIn → Leads.`,
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
      // In der parallelen Schleife gesetzt; TypeScript sieht das nicht.
      const abbruchGrund = abbruch as string | null;
      if (abbruchGrund) {
        if (abbruchGrund.startsWith("LINKEDIN_LIMIT")) this.linkedinLimitMelden(abbruchGrund);
        this.finishRun(startedAt, `${abbruchGrund} (${leadsNeu} Leads bis dahin gespeichert)`, trigger, "error");
        return abbruchGrund;
      }

      // 5. Buchhaltung.
      const nochOffen = Object.values(await this.deps.store.offeneAnzahl()).reduce((a, n) => a + n, 0);

      const outcome = [
        `${engagerGesamt} Engagements (${items} Items)`,
        `${neuePersonen} neue Personen`,
        `${aufgeloest} aufgeloest`,
        `${leadsNeu} neue Leads`,
        `${firmenNeu} neue Firmen im Radar` +
          (firmenBekannt > 0 ? ` (${firmenBekannt} bereits bekannt)` : ""),
        unklarGesamt > 0 ? `${unklarGesamt} ungeklaert` : null,
        nochOffen > 0 ? `${nochOffen} warten auf Zuordnung` : null,
        hinweise.length > 0 ? `Hinweis: ${hinweise.slice(0, 2).join(" · ")}` : null,
        probleme.length > 0 ? `Probleme: ${probleme.slice(0, 2).join(" · ")}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      this.finishRun(startedAt, nachladen ? `Nachladen: ${outcome}` : outcome, nachladen ? "nachladen" : trigger, probleme.length > 0 ? "warning" : "info");
      return outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishRun(startedAt, `Fehler: ${msg.slice(0, 200)}`, trigger, "error");
      return msg;
    } finally {
      this.running = false;
      this.fortschritt = null;
    }
  }

  /** P6 — Meldung im Chat, wenn die Beobachtung am Monatslimit haengt (einmal je Monat und Grund). */
  private linkedinLimitMelden(msg: string): void {
    const grund = msg.split(":")[1] ?? "linkedin_limit";
    const monat = new Date().toISOString().slice(0, 7);
    const alert = this.deps.alerts.add({
      tenantId: null,
      companyId: "",
      companyName: "LinkedIn-Beobachtung",
      kind: "linkedin-signal",
      severity: "warn",
      headline: grund === "linkedin_limit_fehlt" ? "Beobachtete Posts pausiert: Monatslimit fehlt" : "Beobachtete Posts pausiert: Monatslimit erreicht",
      rationale: `${msg.replace(/^LINKEDIN_LIMIT:[a-z_]+:\s*/, "")} Limit in Einstellungen → Plan & Abrechnung.`,
      sourceRef: `linkedin-limit:posts:${grund}:${monat}`,
    });
    if (alert) { try { this.deps.notify(alert); } catch { /* best-effort */ } }
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
