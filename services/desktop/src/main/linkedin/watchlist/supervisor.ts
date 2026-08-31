// WL3 (PLAN_LINKEDIN_WATCHLIST.md §4.3/§4.4) — Watchlist-Supervisor.
//
// Muster RadarSupervisor: Opt-in, Intervall (24/168 h), Tick alle
// 30 Minuten prueft Faelligkeit. Pro Lauf:
//
//   1. Profil-Auswahl (§2c Fokus-Priorisierung): ALLE aktiven
//      Fokus-Personen zuerst, danach rotiert der Rest nach aeltester
//      Sichtung (REST_PROFILES_PER_RUN je Lauf — mit taeglichem
//      Intervall und 25 Eintraegen ist die Wochen-Garantie
//      arithmetisch erfuellt).
//   2. Fetch pro Profil EINZELN (WL1-Befund: die Item→Profil-
//      Zuordnung ist bei Mehr-Profil-Batches actor-abhaengig —
//      1er-Batches kosten dasselbe, Pay-per-Item).
//   3. ERST-LAUF = BASELINE: Beim ersten Kontakt mit einem Profil
//      (lastCheckedAt null) werden alle Items nur als gesehen
//      markiert, KEINE Alerts — sonst hagelt es beim Onboarding
//      10 Meldungen pro Person ueber alte Aktivitaet.
//   4. Ab dann: filterNew → LLM-Einordnung (Producer-Modell, mit
//      ICP-Kontext; Ausfall kippt nichts — Heuristik-Fallback) →
//      Alert kind="linkedin-signal" durch den normalen Fanout.
//   5. Severity: Fokus-Person → mind. "warn" (§2c, Telegram-Default);
//      Kommentar > Reaktion; LLM darf auf "warn" heben (ICP-Naehe).
//
// Fehlerpolitik: Profil-Fehler → 24-h-Backoff (Muster ProfileWorker);
// APIFY_AUTH → Automatik AUS + klarer Settings-Hinweis;
// APIFY_CREDITS → Lauf-Abbruch mit Hinweis, Automatik bleibt an.

import * as yup from "yup";
import type { AlertsStore } from "../../agent/alerts-store";
import type { LlmProviderManager } from "../../agent/providers";
import type { IcpStore } from "../../agent/icp-store";
import type { Alert } from "../../../shared/types";
import {
  buildMessages,
  parseJsonObject,
  streamToText,
} from "../../link-monitor/llm";
import { buildApifyProvider } from "./providers/apify";
import type { WatchlistKeyStore } from "./key-store";
import type { WatchlistEntry, WatchlistStore } from "./store";
import {
  activityDedupeKey,
  type ProfileActivitySignal,
} from "./types";

const CHECK_INTERVAL_MS = 30 * 60_000;
const FIRST_TICK_DELAY_MS = 3 * 60_000;
const REST_PROFILES_PER_RUN = 10;
const FAIL_BACKOFF_MS = 24 * 3600_000;
const CLASSIFY_BATCH = 5;
const BESTAND_POOL_MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_ALERTS_PER_RUN = 15;

const classifySchema = yup.array().of(
  yup
    .object({
      index: yup.number().integer().min(0).required(),
      relevanz: yup.number().min(0).max(100).required(),
      begruendung: yup.string().trim().max(300).default(""),
    })
    .noUnknown(true),
);

export interface WatchlistSupervisorDeps {
  keyStore: WatchlistKeyStore;
  watchlist: WatchlistStore;
  providers: LlmProviderManager;
  icp: IcpStore;
  alerts: AlertsStore;
  notify: (alert: Alert) => void;
  onAlertsChanged: () => void;
  isSignedIn: () => boolean;
  /** v0.1.479 — Bestands-Rotation: liefert alle Kontakte mit
   *  LinkedIn-Profil aus dem verarbeiteten Firmen-Bestand (Gateway).
   *  null = Quelle nicht verfuegbar (offline) → Rotation aussetzen. */
  fetchBestandPool?: () => Promise<Array<{
    profileUrl: string;
    label: string;
    companyId: string | null;
  }> | null>;
  onAudit: (entry: {
    action: string;
    severity: "info" | "warning" | "error";
    summary: string;
    metadata?: Record<string, unknown>;
  }) => void;
}

export class WatchlistSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly deps: WatchlistSupervisorDeps) {}

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
    const cfg = this.deps.keyStore.getConfig();
    if (!cfg.enabled || this.running) return;
    if (!this.deps.isSignedIn()) return;
    if (!this.deps.keyStore.hasKey()) return;
    const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
    if (Date.now() - last < cfg.intervalHours * 3600_000) return;
    await this.runNow("automatik");
  }

  /** Profil-Auswahl nach §2c: Fokus komplett, Rest rotiert. */
  private selectProfiles(entries: WatchlistEntry[]): WatchlistEntry[] {
    const now = Date.now();
    const usable = entries.filter(
      (e) =>
        e.aktiv &&
        !(this.failedAt.has(e.profileUrl) &&
          now - (this.failedAt.get(e.profileUrl) ?? 0) < FAIL_BACKOFF_MS),
    );
    const fokus = usable.filter((e) => e.fokus);
    const rest = usable
      .filter((e) => !e.fokus)
      .sort((a, b) => {
        const ta = a.lastCheckedAt ? Date.parse(a.lastCheckedAt) : 0;
        const tb = b.lastCheckedAt ? Date.parse(b.lastCheckedAt) : 0;
        return ta - tb; // aelteste Sichtung zuerst
      })
      .slice(0, REST_PROFILES_PER_RUN);
    return [...fokus, ...rest];
  }

  async runNow(trigger: "automatik" | "manuell"): Promise<string> {
    if (this.running) return "Watchlist-Lauf laeuft bereits.";
    const cfg = this.deps.keyStore.getConfig();
    const key = this.deps.keyStore.getKey();
    if (!key) return "Kein Anbieter-Token hinterlegt (Einstellungen → LinkedIn → Watchlist).";
    this.running = true;
    const startedAt = new Date().toISOString();
    const provider = buildApifyProvider({
      reactionsActorId: cfg.reactionsActorId,
      commentsActorId: cfg.commentsActorId,
    });
    const probleme: string[] = [];
    try {
      const entries = await this.deps.watchlist.list();
      const selected = this.selectProfiles(entries);
      if (selected.length === 0) {
        const msg = "Keine aktiven Watchlist-Eintraege (oder alle im Fehler-Backoff).";
        this.finishRun(startedAt, msg, trigger, "info");
        return msg;
      }

      const zaehler = { profileOk: 0, neueSignale: 0, alertsNeu: 0, baselines: 0 };
      for (const entry of selected) {
        const r = await this.checkProfile(provider, key, cfg, entry, zaehler, probleme, (url) =>
          this.deps.watchlist.markChecked([url]),
        );
        if (r === "auth") {
          this.deps.keyStore.setConfig({ enabled: false });
          this.finishRun(
            startedAt,
            "Apify-Token ungueltig — Automatik abgeschaltet. Neuen Token hinterlegen (Einstellungen → LinkedIn → Watchlist).",
            trigger,
            "error",
          );
          return "Apify-Token ungueltig.";
        }
        if (r === "credits") {
          this.finishRun(
            startedAt,
            "Apify-Guthaben aufgebraucht — Lauf abgebrochen, Automatik bleibt an.",
            trigger,
            "warning",
          );
          return "Apify-Guthaben aufgebraucht.";
        }
      }

      // ---- v0.1.479: Bestands-Rotation — "alle verarbeiteten Firmen
      //      wenigstens ab und zu": nach der Watchlist rotieren N
      //      Kontakte aus dem Gesamt-Bestand (am laengsten ungeprueft
      //      zuerst). Pool woechentlich auffrischen.
      let bestandGeprueft = 0;
      if (cfg.bestandRotationEnabled && this.deps.fetchBestandPool) {
        const info = await this.deps.watchlist.bestandPoolInfo();
        const stale =
          !info.refreshedAt ||
          Date.now() - Date.parse(info.refreshedAt) > BESTAND_POOL_MAX_AGE_MS;
        if (stale) {
          try {
            const pool = await this.deps.fetchBestandPool();
            if (pool) {
              const n = await this.deps.watchlist.refreshBestandPool(pool);
              this.deps.onAudit({
                action: "linkedin.watchlist.bestandPool",
                severity: "info",
                summary: `Bestands-Pool aufgefrischt: ${n} Kontakte mit LinkedIn-Profil`,
                metadata: {},
              });
            }
          } catch (err) {
            probleme.push(
              `Bestands-Pool: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
            );
          }
        }
        const batch = await this.deps.watchlist.nextBestandBatch(cfg.maxBestandPerRun);
        for (const b of batch) {
          const pseudo: WatchlistEntry = {
            profileUrl: b.profileUrl,
            label: b.label,
            quelle: "kontakt",
            companyId: b.companyId,
            aktiv: true,
            fokus: false,
            addedAt: "",
            lastCheckedAt: b.lastCheckedAt,
          };
          const r = await this.checkProfile(provider, key, cfg, pseudo, zaehler, probleme, (url) =>
            this.deps.watchlist.markBestandChecked([url]),
          );
          if (r === "auth" || r === "credits") break; // Meldung kam schon oben nicht — hier: Lauf einfach beenden
          if (r === "ok") bestandGeprueft++;
        }
      }

      const { profileOk, neueSignale, alertsNeu, baselines } = zaehler;
      const teile = [
        `${profileOk}/${selected.length + bestandGeprueft} Profile geprueft` +
          (bestandGeprueft > 0 ? ` (davon ${bestandGeprueft} Bestand)` : ""),
        baselines > 0 ? `${baselines} Baseline(s) aufgenommen` : null,
        `${neueSignale} neue Signale`,
        `${alertsNeu} Meldungen`,
      ].filter(Boolean);
      if (probleme.length > 0) {
        teile.push(`Probleme: ${probleme.slice(0, 3).join(" · ")}`);
      }
      const outcome = teile.join(", ");
      this.finishRun(startedAt, outcome, trigger, probleme.length > 0 ? "warning" : "info");
      if (alertsNeu > 0) this.deps.onAlertsChanged();
      return outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishRun(startedAt, `Fehler: ${msg.slice(0, 200)}`, trigger, "error");
      return msg;
    } finally {
      this.running = false;
    }
  }

  /** Eine Person pruefen (Watchlist ODER Bestand — gleiche Semantik,
   *  nur der Checked-Marker unterscheidet sich). */
  private async checkProfile(
    provider: ReturnType<typeof buildApifyProvider>,
    key: string,
    cfg: ReturnType<WatchlistKeyStore["getConfig"]>,
    entry: WatchlistEntry,
    zaehler: { profileOk: number; neueSignale: number; alertsNeu: number; baselines: number },
    probleme: string[],
    markChecked: (url: string) => Promise<void>,
  ): Promise<"ok" | "fehler" | "auth" | "credits"> {
    let signals: ProfileActivitySignal[];
    try {
      const r = await provider.fetchActivity(key, [entry.profileUrl], {
        maxItemsPerProfile: cfg.maxItemsPerProfile,
      });
      signals = r.signals;
      this.deps.keyStore.addMonthItems(r.kosteneinheiten);
      for (const f of r.fehlgeschlagen) {
        if (f.grund.includes("keine oeffentliche Aktivitaet")) continue;
        probleme.push(`${entry.label}: ${f.grund}`);
      }
    } catch (err) {
      const grund = err instanceof Error ? err.message : String(err);
      if (grund.startsWith("APIFY_AUTH")) return "auth";
      if (grund.startsWith("APIFY_CREDITS")) return "credits";
      this.failedAt.set(entry.profileUrl, Date.now());
      probleme.push(`${entry.label}: ${grund.slice(0, 120)}`);
      return "fehler";
    }

    const isBaseline = entry.lastCheckedAt === null;
    if (isBaseline) {
      await this.deps.watchlist.markSeen(signals);
      await markChecked(entry.profileUrl);
      zaehler.baselines++;
      zaehler.profileOk++;
      return "ok";
    }

    const neu = await this.deps.watchlist.filterNew(signals);
    zaehler.neueSignale += neu.length;
    if (neu.length > 0 && zaehler.alertsNeu < MAX_ALERTS_PER_RUN) {
      const bewertet = await this.classify(neu.slice(0, MAX_ALERTS_PER_RUN));
      for (const b of bewertet) {
        if (zaehler.alertsNeu >= MAX_ALERTS_PER_RUN) break;
        if (this.emitAlert(entry, b.signal, b.relevanz, b.begruendung)) {
          zaehler.alertsNeu++;
        }
      }
    }
    await this.deps.watchlist.markSeen(signals);
    await markChecked(entry.profileUrl);
    zaehler.profileOk++;
    return "ok";
  }

  private finishRun(
    startedAt: string,
    outcome: string,
    trigger: string,
    severity: "info" | "warning" | "error",
  ): void {
    this.deps.keyStore.setConfig({ lastRunAt: startedAt, lastOutcome: outcome });
    this.deps.onAudit({
      action: "linkedin.watchlist.run",
      severity,
      summary: `Watchlist-Lauf (${trigger}): ${outcome}`,
      metadata: { trigger, startedAt },
    });
  }

  /**
   * LLM-Einordnung: Relevanz 0-100 mit ICP-Kontext. Ausfall kippt
   * nichts — dann greift die Heuristik allein (relevanz -1 = unbewertet).
   */
  private async classify(
    signale: ProfileActivitySignal[],
  ): Promise<Array<{ signal: ProfileActivitySignal; relevanz: number; begruendung: string }>> {
    const fallback = signale.map((signal) => ({ signal, relevanz: -1, begruendung: "" }));
    if (!this.deps.providers.getStatus().ready) return fallback;
    const icpText = this.deps.icp.isSet()
      ? this.deps.icp.renderText().slice(0, 1200)
      : "";
    const out = new Map<number, { relevanz: number; begruendung: string }>();
    for (let i = 0; i < signale.length; i += CLASSIFY_BATCH) {
      const batch = signale.slice(i, i + CLASSIFY_BATCH);
      const lines = batch
        .map((s, j) => {
          const art = s.activityType === "comment" ? "kommentierte" : `reagierte (${s.reactionType ?? "?"})`;
          return `${j}: ${s.personName ?? "Person"} ${art} auf Post von ${s.targetAuthorName ?? "?"}: "${(s.targetSnippet ?? "").slice(0, 200)}"${s.commentText ? ` — Kommentar: "${s.commentText.slice(0, 150)}"` : ""}`;
        })
        .join("\n");
      const system =
        "Du bewertest LinkedIn-Aktivitaeten von Zielkontakten eines B2B-Anbieters. " +
        "Relevanz 0-100: Wie stark deutet die Aktivitaet auf ein Thema hin, das fuer die " +
        "Ansprache durch den Anbieter nuetzlich ist (Kaufsignal, Gespraechsanlass)? " +
        "begruendung: EIN kurzer deutscher Satz, konkret aufs Thema bezogen — nichts erfinden. " +
        (icpText ? `Anbieter-Profil (ICP):\n${icpText}\n` : "") +
        'Antworte NUR als JSON: {"bewertungen": [{"index": 0, "relevanz": 0, "begruendung": "..."}]}';
      try {
        const producerModel = this.deps.providers.getProducerModelOverride();
        const raw = await streamToText(
          this.deps.providers,
          buildMessages(system, lines, "wlclassify"),
          { timeoutMs: 60_000, ...(producerModel ? { modelOverride: producerModel } : {}) },
        );
        const parsed = parseJsonObject(raw) as { bewertungen?: unknown } | null;
        const rows = classifySchema.validateSync(parsed?.bewertungen ?? [], {
          abortEarly: true,
        });
        for (const r of rows ?? []) {
          if (r && batch[r.index]) {
            out.set(i + r.index, { relevanz: r.relevanz, begruendung: r.begruendung ?? "" });
          }
        }
      } catch (err) {
        console.warn("[watchlist] Klassifikation fehlgeschlagen:", err);
      }
    }
    return signale.map((signal, idx) => ({
      signal,
      relevanz: out.get(idx)?.relevanz ?? -1,
      begruendung: out.get(idx)?.begruendung ?? "",
    }));
  }

  /** Alert bauen + durch den normalen Fanout schicken. */
  private emitAlert(
    entry: WatchlistEntry,
    s: ProfileActivitySignal,
    relevanz: number,
    begruendung: string,
  ): boolean {
    const art =
      s.activityType === "comment"
        ? "kommentiert"
        : `reagiert${s.reactionType ? ` (${s.reactionType.toLowerCase()})` : ""}`;
    // Severity §2c/§4.4: Fokus mind. warn; Kommentar > Reaktion;
    // hohe ICP-Relevanz hebt auf warn.
    const severity: Alert["severity"] =
      entry.fokus || s.activityType === "comment" || relevanz >= 70
        ? "warn"
        : "info";
    const thema =
      (s.targetSnippet ?? "").slice(0, 60) ||
      (s.targetAuthorName ? `Post von ${s.targetAuthorName}` : "einen LinkedIn-Post");
    const rationaleTeile = [
      begruendung ||
        `${entry.label} hat auf LinkedIn ${art}: "${(s.targetSnippet ?? "").slice(0, 150)}"`,
      s.commentText ? `Kommentar: "${s.commentText.slice(0, 120)}"` : null,
      s.targetPostUrl,
    ].filter(Boolean);
    const alert = this.deps.alerts.add({
      tenantId: null,
      companyId: entry.companyId ?? "",
      companyName: entry.label,
      kind: "linkedin-signal",
      severity,
      headline: `Watchlist: ${entry.label} hat ${art} — ${thema}`,
      rationale: rationaleTeile.join(" — "),
      sourceRef: `watchlist:${activityDedupeKey(s)}`,
    });
    if (alert) {
      try {
        this.deps.notify(alert);
      } catch {
        /* best-effort */
      }
      return true;
    }
    return false;
  }
}
