// Updates der Kunden-Instanzen in Wellen (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §10.6, Z7).
//
// Je neuer Server-Version (Tag in der Kunden-Registry) eine Zeile CloudRollout:
//   betreiber → (24 h) → welle (10 % der Kunden) → (24 h) → alle → fertig
// Bei zu vielen Fehlschlägen (> 5 %, in der Betreiber-Phase schon einer) → angehalten + Meldung.
// Updates laufen nur nachts 02–05 Uhr (Berlin), höchstens `parallel` gleichzeitig, jede mit
// automatischer Rücknahme (CloudBetrieb.aktualisieren). Nutzer können selbst „Jetzt aktualisieren“.
// Mails: M6 am Vorabend (nur mit Hinweistext des Betreibers), M7 nach dem Update (höchstens 1 je
// Woche, abbestellbar). Schalter: CLOUD_UPDATES=0 (aus), CLOUD_UPDATE_STUNDEN, CLOUD_UPDATE_PROZENT,
// CLOUD_UPDATE_PARALLEL.

import { createHash } from "node:crypto";
import type pg from "pg";
import type { FlyKunden } from "./fly-maschinen";
import type { CloudBetrieb, CloudInstanz, CloudRepo, Quelle } from "./instanzen";

export type Phase = "betreiber" | "welle" | "alle" | "fertig" | "angehalten";
export interface Rollout { version: string; phase: Phase; phaseAt: string; erfolge: number; fehler: number; hinweis: string | null; grund: string | null }

export interface RolloutRepo {
  holen(version: string): Promise<Rollout | null>;
  /** Legt die Zeile an (Phase betreiber) oder liefert die vorhandene. */
  anlegen(version: string): Promise<Rollout>;
  phase(version: string, phase: Phase, grund?: string | null): Promise<void>;
  zaehlen(version: string, art: "erfolge" | "fehler"): Promise<void>;
  hinweis(version: string, text: string | null): Promise<void>;
  liste(): Promise<Rollout[]>;
}

export interface RolloutRegeln { stunden: number; prozent: number; parallel: number; fensterVon: number; fensterBis: number; maxFehlerQuote: number }

export function rolloutRegelnAusEnv(): RolloutRegeln {
  const zahl = (n: string, d: number) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
  return { stunden: zahl("CLOUD_UPDATE_STUNDEN", 24), prozent: zahl("CLOUD_UPDATE_PROZENT", 10), parallel: zahl("CLOUD_UPDATE_PARALLEL", 2), fensterVon: 2, fensterBis: 5, maxFehlerQuote: 0.05 };
}

const STUNDE = 3_600_000;

/** a < b für Versionen „0.1.975“. */
export function versionAelter(a: string, b: string): boolean {
  const x = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const y = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** Stunde 0–23 in Berlin (formatToParts: „de-DE“ hängt sonst „Uhr“ an). */
export function berlinStunde(jetzt: number): number {
  const teil = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Berlin" }).formatToParts(new Date(jetzt)).find((p) => p.type === "hour");
  return Number(teil?.value ?? "0") % 24;
}

export const imFenster = (jetzt: number, r: Pick<RolloutRegeln, "fensterVon" | "fensterBis">) => {
  const h = berlinStunde(jetzt);
  return h >= r.fensterVon && h < r.fensterBis;
};

/** Fester Anteil je Version: dieselbe Instanz ist bei derselben Version immer in derselben Welle. */
export function wellenWert(instanzId: string, version: string): number {
  return createHash("sha256").update(`${instanzId}:${version}`).digest().readUInt32BE(0) / 0x1_0000_0000;
}

/** Kann diese Instanz auf `version` gehoben werden? (läuft, soll laufen, ältere Version, nicht schon gescheitert) */
export function aktualisierbar(i: CloudInstanz, version: string): boolean {
  return (i.zustand === "laeuft" || i.zustand === "wartet_auf_verbindung") && i.soll === "laufen" && !!i.maschineId
    && !!i.imageVersion && versionAelter(i.imageVersion, version) && i.schritte.updateFehler !== version;
}

/** Instanzen, die in dieser Phase dran sind. */
export function zielePhase(phase: Phase, instanzen: CloudInstanz[], betreiberTenant: string | null, version: string, prozent: number): CloudInstanz[] {
  const offen = instanzen.filter((i) => aktualisierbar(i, version));
  const betreiber = offen.filter((i) => betreiberTenant && i.tenantId === betreiberTenant);
  if (phase === "betreiber") return betreiber;
  if (phase === "alle") return offen;
  if (phase !== "welle") return [];
  const kunden = instanzen.filter((i) => !(betreiberTenant && i.tenantId === betreiberTenant) && i.zustand !== "geloescht");
  let welle = kunden.filter((i) => wellenWert(i.id, version) * 100 < prozent);
  // Mindestens eine Kunden-Instanz in der ersten Welle, sonst prüft sie nichts.
  if (!welle.length && kunden.length) welle = [kunden.reduce((a, b) => (wellenWert(a.id, version) <= wellenWert(b.id, version) ? a : b))];
  const ids = new Set(welle.map((i) => i.id));
  return [...betreiber, ...offen.filter((i) => ids.has(i.id))];
}

/** Nächste Phase oder null (bleibt). `offen` = Ziele der aktuellen Phase, die noch alt sind. */
export function naechstePhase(r: Rollout, offen: number, jetzt: number, regeln: RolloutRegeln): { phase: Phase; grund?: string } | null {
  if (r.phase === "fertig" || r.phase === "angehalten") return null;
  const versuche = r.erfolge + r.fehler;
  if (r.phase === "betreiber" && r.fehler > 0) return { phase: "angehalten", grund: "Update auf der Betreiber-Instanz gescheitert" };
  if (r.fehler > 0 && r.fehler / Math.max(1, versuche) > regeln.maxFehlerQuote) return { phase: "angehalten", grund: `${r.fehler} von ${versuche} Updates gescheitert` };
  if (offen > 0) return null;
  const alt = jetzt - Date.parse(r.phaseAt);
  if (r.phase === "betreiber" && alt >= regeln.stunden * STUNDE) return { phase: "welle" };
  if (r.phase === "welle" && alt >= regeln.stunden * STUNDE) return { phase: "alle" };
  if (r.phase === "alle") return { phase: "fertig" };
  return null;
}

export type UpdateNachricht = "update_hinweis" | "aktualisiert";

export interface RolloutDeps {
  repo: CloudRepo;
  fly: FlyKunden;
  betrieb: CloudBetrieb;
  rollouts: RolloutRepo;
  betreiberTenant: string | null;
  melden: (text: string) => Promise<unknown>;
  benachrichtigen?: (art: UpdateNachricht, i: CloudInstanz, extra: Record<string, unknown>) => Promise<unknown>;
  warnen?: (daten: Record<string, unknown>, text: string) => void;
  regeln?: Partial<RolloutRegeln>;
  jetzt?: () => number;
  /** Startet ein Update im Hintergrund (im Test: sammeln und abwarten). */
  starte?: (p: Promise<unknown>) => void;
  /** Staging (docs/PLAN_STAGING.md): Kanal dieses Abgleichs; staging = Kandidat sofort, ohne Wellen. */
  kanal?: "prod" | "staging";
  /** Zielversion des Kanals (Standard: neuester Tag der Registry). */
  zielVersion?: () => Promise<string | null>;
}

const zielVon = (d: Pick<RolloutDeps, "zielVersion" | "fly">) => (d.zielVersion ? d.zielVersion() : d.fly.neuesteVersion());

/** Laufende Updates je Gateway-Prozess (für das Parallel-Limit). */
const laufend = new Set<string>();
export const updatesLaufend = () => laufend.size;

/** Ein Update mit Buchführung: Zähler, Markierung bei Fehlschlag, Meldung, Mail M7. */
export async function updateEinerInstanz(d: RolloutDeps, i: CloudInstanz, version: string, quelle: Quelle): Promise<"ok" | "aktuell" | "zurueck" | "fehler"> {
  const jetzt = d.jetzt ?? Date.now;
  laufend.add(i.id);
  try {
    const erg = await d.betrieb.aktualisieren(i.id, version, quelle);
    if (erg.ergebnis === "aktuell") return "aktuell";
    if (erg.ergebnis === "ok") {
      await d.rollouts.zaehlen(version, "erfolge").catch(() => undefined);
      const frisch = await d.repo.holen(i.id);
      const m7 = typeof frisch?.schritte.m7At === "string" ? Date.parse(frisch.schritte.m7At) : 0;
      if (frisch?.verbundenAt && jetzt() - m7 >= 7 * 24 * STUNDE && d.benachrichtigen) {
        await d.repo.aendern(i.id, { schritte: { ...frisch.schritte, m7At: new Date(jetzt()).toISOString() } });
        const r = await d.rollouts.holen(version).catch(() => null);
        await d.benachrichtigen("aktualisiert", frisch, { version, hinweis: r?.hinweis ?? null }).catch(() => undefined);
      }
      return "ok";
    }
    await fehlschlag(d, i, version, erg.zurueckOk ? `Update auf ${version} nicht gesund, zurück auf ${erg.von}` : `Update auf ${version} nicht gesund, Rücknahme auf ${erg.von ?? "?"} ebenfalls nicht gesund`);
    return "zurueck";
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    d.warnen?.({ id: i.id, version, err: text }, "[cloud-update] fehlgeschlagen");
    await fehlschlag(d, i, version, `Update auf ${version} abgebrochen: ${text.slice(0, 200)}`);
    return "fehler";
  } finally {
    laufend.delete(i.id);
  }
}

async function fehlschlag(d: RolloutDeps, i: CloudInstanz, version: string, text: string) {
  await d.rollouts.zaehlen(version, "fehler").catch(() => undefined);
  const frisch = await d.repo.holen(i.id);
  if (frisch) await d.repo.aendern(i.id, { schritte: { ...frisch.schritte, updateFehler: version } });
  await d.melden(`☁️ AVA Cloud ${i.flyApp}: ${text}`).catch(() => undefined);
}

export interface RolloutBericht { version: string; phase: Phase; ziele: number; gestartet: number; m6: number }

/** Ein Schritt je Abgleich-Lauf: Phase prüfen, Vorabend-Mails, Updates im Fenster starten. */
export async function rolloutSchritt(d: RolloutDeps, instanzen: CloudInstanz[]): Promise<RolloutBericht | null> {
  if (process.env.CLOUD_UPDATES === "0") return null;
  const r0: RolloutRegeln = { ...rolloutRegelnAusEnv(), ...d.regeln };
  const jetzt = (d.jetzt ?? Date.now)();
  const version = await zielVon(d);
  if (!version) return null;
  const starte = d.starte ?? ((p: Promise<unknown>) => void p.catch(() => undefined));
  if (d.kanal === "staging") {
    // Testerinnen und Tester bekommen den Kandidaten sofort, ohne Wellen und Nachtfenster.
    const ziele = instanzen.filter((i) => aktualisierbar(i, version));
    const bericht: RolloutBericht = { version, phase: "alle", ziele: ziele.length, gestartet: 0, m6: 0 };
    const frei = Math.max(0, r0.parallel - laufend.size);
    for (const i of ziele.filter((x) => !d.betrieb.beschaeftigt(x.id) && !laufend.has(x.id)).slice(0, frei)) {
      starte(updateEinerInstanz(d, i, version, "abgleicher"));
      bericht.gestartet++;
    }
    return bericht;
  }
  let r = await d.rollouts.holen(version);
  if (!r) {
    if (!instanzen.some((i) => aktualisierbar(i, version))) return null;
    r = await d.rollouts.anlegen(version);
  }
  const bericht: RolloutBericht = { version, phase: r.phase, ziele: 0, gestartet: 0, m6: 0 };
  if (r.phase === "fertig" || r.phase === "angehalten") return bericht;

  let ziele = zielePhase(r.phase, instanzen, d.betreiberTenant, version, r0.prozent);
  const n = naechstePhase(r, ziele.length, jetzt, r0);
  if (n) {
    await d.rollouts.phase(version, n.phase, n.grund ?? null);
    if (n.phase === "angehalten") await d.melden(`☁️ AVA Cloud: Update auf ${version} angehalten (${n.grund}). Fortsetzen über die Betreiber-Route.`).catch(() => undefined);
    r = { ...r, phase: n.phase, phaseAt: new Date(jetzt).toISOString() };
    bericht.phase = r.phase;
    if (r.phase === "fertig" || r.phase === "angehalten") return bericht;
    ziele = zielePhase(r.phase, instanzen, d.betreiberTenant, version, r0.prozent);
  }
  bericht.ziele = ziele.length;

  // M6 am Vorabend (17–20 Uhr), nur mit Hinweistext, je Instanz und Version einmal.
  const h = berlinStunde(jetzt);
  if (r.hinweis && h >= 17 && h < 20 && d.benachrichtigen) {
    for (const i of ziele) {
      if (i.schritte.m6 === version || !i.verbundenAt) continue;
      i.schritte = { ...i.schritte, m6: version };
      await d.repo.aendern(i.id, { schritte: i.schritte });
      await d.benachrichtigen("update_hinweis", i, { version, hinweis: r.hinweis }).catch(() => undefined);
      bericht.m6++;
    }
  }

  if (!imFenster(jetzt, r0)) return bericht;
  const frei = Math.max(0, r0.parallel - laufend.size);
  for (const i of ziele.filter((x) => !d.betrieb.beschaeftigt(x.id) && !laufend.has(x.id)).slice(0, frei)) {
    starte(updateEinerInstanz(d, i, version, "abgleicher"));
    bericht.gestartet++;
  }
  return bericht;
}

/** „Jetzt aktualisieren“ (Nutzer): neueste Version sofort, außer der Rollout ist angehalten. */
export async function jetztAktualisieren(d: RolloutDeps, i: CloudInstanz): Promise<{ gestartet: boolean; grund?: string; version?: string }> {
  const version = await zielVon(d);
  if (!version) return { gestartet: false, grund: "Keine neue Version verfügbar." };
  if (!aktualisierbar({ ...i, schritte: { ...i.schritte, updateFehler: false } }, version)) return { gestartet: false, grund: "Deine AVA ist schon auf dem neuesten Stand." };
  const r = await d.rollouts.holen(version);
  if (r?.phase === "angehalten") return { gestartet: false, grund: "Dieses Update ist gerade angehalten; wir melden uns, sobald es weitergeht." };
  if (d.betrieb.beschaeftigt(i.id) || laufend.has(i.id)) return { gestartet: false, grund: "Für deine AVA läuft gerade schon ein Vorgang." };
  if (!r) await d.rollouts.anlegen(version);
  const starte = d.starte ?? ((p: Promise<unknown>) => void p.catch(() => undefined));
  starte(updateEinerInstanz(d, i, version, "nutzer"));
  return { gestartet: true, version };
}

/** Rollouts in der Gateway-Datenbank. */
export function pgRollouts(pool: pg.Pool): RolloutRepo {
  const zeile = (x: Record<string, unknown>): Rollout => ({
    version: String(x.version), phase: x.phase as Phase, phaseAt: x.phaseAt instanceof Date ? x.phaseAt.toISOString() : String(x.phaseAt),
    erfolge: Number(x.erfolge), fehler: Number(x.fehler), hinweis: (x.hinweis as string | null) ?? null, grund: (x.grund as string | null) ?? null,
  });
  return {
    async holen(version) {
      const r = await pool.query(`SELECT * FROM "CloudRollout" WHERE version = $1`, [version]);
      return r.rows[0] ? zeile(r.rows[0]) : null;
    },
    async anlegen(version) {
      await pool.query(`INSERT INTO "CloudRollout" (version, phase) VALUES ($1, 'betreiber') ON CONFLICT (version) DO NOTHING`, [version]);
      const r = await pool.query(`SELECT * FROM "CloudRollout" WHERE version = $1`, [version]);
      return zeile(r.rows[0]);
    },
    async phase(version, phase, grund = null) {
      await pool.query(`UPDATE "CloudRollout" SET phase = $2, grund = $3, "phaseAt" = now(), "updatedAt" = now() WHERE version = $1`, [version, phase, grund]);
    },
    async zaehlen(version, art) {
      await pool.query(`UPDATE "CloudRollout" SET "${art === "erfolge" ? "erfolge" : "fehler"}" = "${art === "erfolge" ? "erfolge" : "fehler"}" + 1, "updatedAt" = now() WHERE version = $1`, [version]);
    },
    async hinweis(version, text) {
      await pool.query(`UPDATE "CloudRollout" SET hinweis = $2, "updatedAt" = now() WHERE version = $1`, [version, text]);
    },
    async liste() {
      const r = await pool.query(`SELECT * FROM "CloudRollout" ORDER BY "createdAt" DESC LIMIT 50`);
      return r.rows.map(zeile);
    },
  };
}
