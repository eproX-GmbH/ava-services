// WL2 — Anbieter-Key + Konfiguration der Personen-Watchlist (BYOK, W1).
//
// Muster telegram/store.ts: Konfiguration als Klartext-JSON, der Key
// verschluesselt via safeStorage (OS-Schluesselbund). Beides unter
// userData/linkedin/ — damit wischen Kill-Switch UND Werksreset alles
// mit (W7). Der Key wird NIE ueber die IPC-Grenze gespiegelt; der
// Renderer sieht nur hasKey.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { APIFY_DEFAULT_ACTORS } from "./providers/apify";

export interface WatchlistConfig {
  /** Automatik an? (Opt-in, Default AUS.) */
  enabled: boolean;
  /** Anbieter — vorerst nur "apify" (W4). */
  providerId: "apify";
  /** Actor-Overrides (leer = harvestapi-Defaults). */
  reactionsActorId: string;
  commentsActorId: string;
  /** Pruef-Intervall: 24 = taeglich, 168 = woechentlich. */
  intervalHours: 24 | 168;
  /** Item-Budget je Profil und Lauf (Kosten-Kontrolle, Nutzer zahlt). */
  maxItemsPerProfile: number;
  lastRunAt: string | null;
  lastOutcome: string | null;
  /** Kosten-Transparenz: gelieferte Items im laufenden Monat. */
  monthKey: string;
  monthItems: number;
  /** v0.1.479 — Bestands-Rotation: zusaetzlich zur Watchlist werden
   *  je Lauf N Kontakte aus dem gesamten Firmen-Bestand geprueft
   *  (rotierend, am laengsten ungeprueft zuerst). Opt-in — kostet
   *  zusaetzliche Items. */
  bestandRotationEnabled: boolean;
  maxBestandPerRun: number;
  /** v0.1.489 — §8b Kontakt-Suchfenster: wie viele Profile der
   *  Employees-Actor je Firmenlauf maximal liefert (Short-Mode,
   *  4 $ je 1.000 Profile — der Nutzer zahlt). Clamp 25..1000. */
  companyWindow: number;
  /** v0.1.696 — Wie tief der Employees-Actor je Profil graebt.
   *  "kurz" (4 $ je 1.000) nennt Name, Profil und die aktuelle Stellung;
   *  "voll" (8 $ je 1.000) liefert zusaetzlich die Stationen mit Rolle,
   *  Firma und Zeitraum — erst damit steht die Rolle bei GENAU dieser
   *  Firma fest, statt aus einer Kopfzeile geraten zu werden. */
  profilModus: "kurz" | "voll";
  /** Intern: bis zu welchem Stand die Voreinstellungen nachgezogen wurden. */
  konfigStand?: number;
}

const DEFAULT_CONFIG: WatchlistConfig = {
  enabled: false,
  providerId: "apify",
  reactionsActorId: APIFY_DEFAULT_ACTORS.reactionsActorId,
  commentsActorId: APIFY_DEFAULT_ACTORS.commentsActorId,
  intervalHours: 24,
  maxItemsPerProfile: 10,
  lastRunAt: null,
  lastOutcome: null,
  monthKey: "",
  monthItems: 0,
  bestandRotationEnabled: false,
  maxBestandPerRun: 5,
  companyWindow: 50,
  profilModus: "voll",
};

/**
 * Stand der Voreinstellungen. Wird in der Datei mitgefuehrt, damit eine
 * geaenderte Voreinstellung bestehende Installationen einmalig nachzieht.
 *
 * Noetig, weil die Datei bei jedem aktiven Nutzer existiert — der
 * Verbrauchszaehler schreibt sie nach jedem Lauf. Eine neue Voreinstellung
 * allein wuerde deshalb nirgends ankommen.
 */
const KONFIG_STAND = 1;

export class WatchlistKeyStore {
  private readonly dir: string;
  private configCache: WatchlistConfig | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(paths().get("userData"), "linkedin");
  }

  private configPath(): string {
    return join(this.dir, "watchlist-config.json");
  }

  getConfig(): WatchlistConfig {
    if (this.configCache) return { ...this.configCache };
    try {
      if (existsSync(this.configPath())) {
        const p = JSON.parse(
          readFileSync(this.configPath(), "utf8"),
        ) as Partial<WatchlistConfig>;
        this.configCache = {
          enabled: p.enabled === true,
          providerId: "apify",
          reactionsActorId:
            typeof p.reactionsActorId === "string" && p.reactionsActorId.trim()
              ? p.reactionsActorId.trim()
              : DEFAULT_CONFIG.reactionsActorId,
          commentsActorId:
            typeof p.commentsActorId === "string"
              ? p.commentsActorId.trim()
              : DEFAULT_CONFIG.commentsActorId,
          intervalHours: p.intervalHours === 168 ? 168 : 24,
          maxItemsPerProfile:
            typeof p.maxItemsPerProfile === "number" &&
            Number.isFinite(p.maxItemsPerProfile)
              ? Math.min(100, Math.max(1, Math.floor(p.maxItemsPerProfile)))
              : DEFAULT_CONFIG.maxItemsPerProfile,
          lastRunAt: typeof p.lastRunAt === "string" ? p.lastRunAt : null,
          lastOutcome: typeof p.lastOutcome === "string" ? p.lastOutcome : null,
          monthKey: typeof p.monthKey === "string" ? p.monthKey : "",
          monthItems:
            typeof p.monthItems === "number" && Number.isFinite(p.monthItems)
              ? Math.max(0, Math.floor(p.monthItems))
              : 0,
          bestandRotationEnabled: p.bestandRotationEnabled === true,
          maxBestandPerRun:
            typeof p.maxBestandPerRun === "number" &&
            Number.isFinite(p.maxBestandPerRun)
              ? Math.min(50, Math.max(1, Math.floor(p.maxBestandPerRun)))
              : DEFAULT_CONFIG.maxBestandPerRun,
          companyWindow:
            typeof p.companyWindow === "number" &&
            Number.isFinite(p.companyWindow)
              ? Math.min(1000, Math.max(25, Math.round(p.companyWindow)))
              : DEFAULT_CONFIG.companyWindow,
          // Nur die beiden bekannten Werte; alles andere faellt auf den
          // guenstigen zurueck, damit ein Tippfehler nichts verteuert.
          profilModus: p.profilModus === "voll" ? "voll" : "kurz",
          konfigStand: typeof p.konfigStand === "number" ? p.konfigStand : 0,
        };
        // Einmalig auf den Stand von v0.1.697 heben: volle Profiltiefe bei
        // halbiertem Suchfenster. Kostet dasselbe wie vorher (50 Profile zu
        // 8 $ je 1.000 statt 100 zu 4 $), liefert aber die Rolle bei GENAU
        // dieser Firma statt einer aus der Kopfzeile geratenen. Gespeichert
        // wurden ohnehin immer nur die besten 25.
        //
        // Nur angefasst, wer noch auf den alten Voreinstellungen sitzt — wer
        // selbst etwas anderes gewaehlt hat, behaelt es.
        if ((this.configCache.konfigStand ?? 0) < KONFIG_STAND) {
          const unveraendert =
            this.configCache.companyWindow === 100 && this.configCache.profilModus === "kurz";
          this.configCache = {
            ...this.configCache,
            ...(unveraendert
              ? { companyWindow: DEFAULT_CONFIG.companyWindow, profilModus: DEFAULT_CONFIG.profilModus }
              : {}),
            konfigStand: KONFIG_STAND,
          };
          const zuSchreiben = { ...this.configCache };
          try {
            this.setConfig(zuSchreiben);
          } catch {
            /* nicht schreibbar: dann gilt der Wert wenigstens zur Laufzeit */
          }
        }
        return { ...this.configCache };
      }
    } catch {
      /* korrupt → Defaults */
    }
    this.configCache = { ...DEFAULT_CONFIG };
    return { ...this.configCache };
  }

  /** Items dem Monatszaehler zuschlagen (Monatswechsel setzt zurueck). */
  addMonthItems(items: number): void {
    const key = new Date().toISOString().slice(0, 7); // YYYY-MM
    const cfg = this.getConfig();
    this.setConfig({
      monthKey: key,
      monthItems: (cfg.monthKey === key ? cfg.monthItems : 0) + Math.max(0, items),
    });
  }

  setConfig(patch: Partial<WatchlistConfig>): WatchlistConfig {
    const next = { ...this.getConfig(), ...patch, providerId: "apify" as const };
    next.konfigStand = KONFIG_STAND;
    // Kosten-Leitplanke: Suchfenster hart auf 25..1000 begrenzen
    // (1000 = Actor-Maximum je Firma).
    next.companyWindow = Math.max(
      25,
      Math.min(1000, Math.round(Number(next.companyWindow) || 100)),
    );
    // Ohne Key keine Automatik.
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.configPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
      renameSync(tmp, this.configPath());
    } catch (err) {
      console.warn("[watchlist] config persist failed:", err);
    }
    this.configCache = next;
    return { ...next };
  }

  /** 2026-10-13: Apify-Token liegen zentral im Gateway; auf dem Geraet gibt es keinen. */
  hasKey(): boolean {
    return false;
  }
}
