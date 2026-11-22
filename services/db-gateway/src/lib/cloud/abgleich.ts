// Soll-Ist-Abgleich der Kunden-Instanzen (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §3.4/§3.5, Z2).
//
// Läuft alle 5 Minuten im Gateway (und auf Anstoß). Für jede Instanz:
//   1. Soll bestimmen: Wunsch (Admin/Betreiber) UND Konto nicht gesperrt UND Abrechnung nicht
//      ausgesetzt/gekündigt.
//   2. Mit dem echten Zustand bei Fly vergleichen und genau EINE Aktion ausführen.
// Nur hier (und durch ausdrückliche Betreiber-Aktionen) werden Maschinen gestartet. Läuft eine
// Maschine, die gestoppt sein soll (Fly-Neustart, Host-Umzug, Fehler), wird sie wieder gestoppt
// und der Betreiber bekommt eine Meldung.
//
// Schalter (Env):
//   CLOUD_ABGLEICH=0        Abgleicher aus (Notschalter; Instanzen bleiben, wie sie sind)
//   CLOUD_RUHE_TAGE=7       gestoppt → Maschine löschen (Volume bleibt)
//   CLOUD_LOESCH_TAGE=30    nach dem Stopp → endgültig löschen …
//   CLOUD_AUTO_LOESCHEN=1   … aber nur damit; sonst nur Meldung „Löschung fällig“ (bis die
//                           Vorwarn-Mail aus Z4 steht, löscht nichts automatisch)

import type pg from "pg";
import type { FlyKunden } from "./fly-maschinen";
import type { CloudBetrieb, CloudInstanz, CloudRepo, Grund, Soll } from "./instanzen";

const TAG = 86_400_000;

export interface Fakten {
  /** geloescht | deaktiviert | gesperrt (KontoStatus) oder null */
  kontoSperre: string | null;
  /** TenantBilling.status der Organisation oder null (keine Abrechnung) */
  abrechnung: string | null;
}

/** Soll aus Wunsch und Fakten. Reihenfolge = Vorrang des Grundes. */
export function sollBestimmen(i: Pick<CloudInstanz, "gewuenscht" | "grund">, f: Fakten): { soll: Soll; grund: Grund | null } {
  if (f.kontoSperre) return { soll: "gestoppt", grund: "konto" };
  if (f.abrechnung === "canceled") return { soll: "gestoppt", grund: "kuendigung" };
  if (f.abrechnung === "suspended") return { soll: "gestoppt", grund: "zahlung" };
  if (i.gewuenscht === "gestoppt") {
    const g = i.grund === "admin" || i.grund === "betreiber" ? i.grund : "betreiber";
    return { soll: "gestoppt", grund: g };
  }
  return { soll: "laufen", grund: null };
}

export type Aktion =
  | { art: "nichts" }
  | { art: "fortsetzen" }
  | { art: "starten"; warum: "soll_laufen" | "unerwartet_gestoppt" }
  | { art: "stoppen"; wiederGestartet: boolean }
  | { art: "ruhen" }
  | { art: "loeschen" }
  | { art: "loeschen_faellig" }
  | { art: "gesundheit" };

export interface Regeln { ruheTage: number; loeschTage: number; autoLoeschen: boolean; maxVersuche: number }

const LAEUFT = new Set(["started", "starting", "replacing", "updating"]);

/**
 * Nächster Schritt für EINE Instanz. `fly` = Zustand der Maschine bei Fly
 * (null = keine Maschine bzw. nicht gefunden).
 */
export function naechsteAktion(i: CloudInstanz, soll: Soll, fly: string | null, jetzt: number, r: Regeln): Aktion {
  if (i.zustand === "geloescht") return { art: "nichts" };
  if (i.zustand === "wird_angelegt") {
    if (soll !== "laufen") return { art: "nichts" };
    return Number(i.schritte.versuche ?? 0) >= r.maxVersuche ? { art: "nichts" } : { art: "fortsetzen" };
  }
  const laeuft = fly !== null && LAEUFT.has(fly);
  if (soll === "gestoppt") {
    if (laeuft) return { art: "stoppen", wiederGestartet: i.zustand === "gestoppt" || i.zustand === "ruht" };
    const seit = i.gestopptAt ? Date.parse(i.gestopptAt) : null;
    if (i.zustand === "gestoppt" && seit !== null && jetzt - seit >= r.ruheTage * TAG) return { art: "ruhen" };
    if (i.zustand === "ruht" && seit !== null && jetzt - seit >= r.loeschTage * TAG) return r.autoLoeschen ? { art: "loeschen" } : { art: "loeschen_faellig" };
    // Soll gestoppt, Maschine steht, Datensatz sagt noch „läuft“ (z. B. Neustart des Gateways mitten im Stoppen)
    if (i.zustand === "laeuft" || i.zustand === "wartet_auf_verbindung") return { art: "stoppen", wiederGestartet: false };
    return { art: "nichts" };
  }
  // soll === "laufen"
  if (i.zustand === "gestoppt" || i.zustand === "ruht") return { art: "starten", warum: "soll_laufen" };
  if (!laeuft) return { art: "starten", warum: "unerwartet_gestoppt" };
  return { art: "gesundheit" };
}

/** Höchstens eine Meldung je Art und Instanz in 6 Stunden. */
export function alarmFaellig(i: Pick<CloudInstanz, "schritte">, art: string, jetzt: number): boolean {
  const zuletzt = i.schritte[`alarm_${art}`];
  return typeof zuletzt !== "string" || jetzt - Date.parse(zuletzt) >= 6 * 3_600_000;
}

export interface AbgleichDeps {
  repo: CloudRepo;
  fly: FlyKunden;
  betrieb: CloudBetrieb;
  fakten: (i: CloudInstanz) => Promise<Fakten>;
  melden: (text: string) => Promise<unknown>;
  regeln?: Partial<Regeln>;
  jetzt?: () => number;
  pause?: (ms: number) => Promise<void>;
  /** Protokoll (im Gateway der Logger); ohne Angabe still. */
  warnen?: (daten: Record<string, unknown>, text: string) => void;
}

export function regelnAusEnv(): Regeln {
  const zahl = (n: string, d: number) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
  return { ruheTage: zahl("CLOUD_RUHE_TAGE", 7), loeschTage: zahl("CLOUD_LOESCH_TAGE", 30), autoLoeschen: process.env.CLOUD_AUTO_LOESCHEN === "1", maxVersuche: 5 };
}

export interface AbgleichBericht { geprueft: number; aktionen: Record<string, number>; fehler: number; waisen: string[] }

/** Ein Durchlauf über alle (oder eine) Instanz. Fehler je Instanz brechen den Lauf nicht ab. */
export async function abgleichen(d: AbgleichDeps, nur?: string): Promise<AbgleichBericht> {
  const r: Regeln = { ...regelnAusEnv(), ...d.regeln };
  const jetzt = d.jetzt ?? Date.now;
  const pause = d.pause ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const warnen = d.warnen ?? (() => undefined);
  const bericht: AbgleichBericht = { geprueft: 0, aktionen: {}, fehler: 0, waisen: [] };
  const alle = await d.repo.liste();
  const liste = alle.filter((i) => i.zustand !== "geloescht" && (!nur || i.id === nur));

  for (const i of liste) {
    if (d.betrieb.beschaeftigt(i.id)) continue;
    bericht.geprueft++;
    const merkeAlarm = async (art: string, text: string) => {
      if (!alarmFaellig(i, art, jetzt())) return;
      i.schritte = { ...i.schritte, [`alarm_${art}`]: new Date(jetzt()).toISOString() };
      await d.repo.aendern(i.id, { schritte: i.schritte });
      await d.melden(`☁️ AVA Cloud ${i.flyApp}: ${text}`).catch(() => undefined);
    };
    try {
      const { soll, grund } = sollBestimmen(i, await d.fakten(i));
      if (soll !== i.soll || grund !== i.grund) {
        await d.repo.aendern(i.id, { soll, grund });
        await d.repo.ereignis(i.id, "soll_geaendert", "abgleicher", { von: i.soll, nach: soll, grund });
        i.soll = soll; i.grund = grund;
      }
      const m = i.maschineId ? await d.fly.maschineHolen(i.flyApp, i.maschineId) : null;
      const fly = m && m.state !== "destroyed" ? m.state : null;
      const a = naechsteAktion(i, soll, fly, jetzt(), r);
      bericht.aktionen[a.art] = (bericht.aktionen[a.art] ?? 0) + 1;

      switch (a.art) {
        case "nichts":
          if (i.zustand === "wird_angelegt" && Number(i.schritte.versuche ?? 0) >= r.maxVersuche) {
            await merkeAlarm("anlegen", `Anlegen nach ${r.maxVersuche} Versuchen gescheitert: ${i.letzterFehler ?? "?"}`);
          }
          break;
        case "fortsetzen":
          await d.betrieb.fortsetzen(i.id, "abgleicher");
          break;
        case "stoppen":
          await d.betrieb.stoppen(i.id, grund ?? "betreiber", "abgleicher");
          if (a.wiederGestartet) {
            await d.repo.ereignis(i.id, "wieder_gestoppt", "abgleicher", { fly });
            await merkeAlarm("wieder_gestartet", `lief, obwohl sie gestoppt sein soll (${grund}); wieder gestoppt.`);
          }
          break;
        case "starten":
          if (a.warum === "unerwartet_gestoppt") {
            await d.repo.ereignis(i.id, "unerwartet_gestoppt", "abgleicher", { fly });
            await merkeAlarm("unerwartet_gestoppt", `war unerwartet aus (${fly ?? "keine Maschine"}); wird neu gestartet.`);
          }
          await d.betrieb.starten(i.id, "abgleicher");
          break;
        case "ruhen":
          await d.betrieb.ruhen(i.id, "abgleicher");
          break;
        case "loeschen":
          await d.betrieb.loeschen(i.id, "abgleicher");
          await d.melden(`☁️ AVA Cloud ${i.flyApp}: nach ${r.loeschTage} Tagen gelöscht (${i.grund}).`).catch(() => undefined);
          break;
        case "loeschen_faellig":
          await merkeAlarm("loeschen_faellig", `ist seit ${r.loeschTage} Tagen gestoppt (${i.grund}); Löschung fällig (CLOUD_AUTO_LOESCHEN aus).`);
          break;
        case "gesundheit": {
          const ok = await d.fly.gesund(i.flyApp);
          if (ok) {
            const alt = i.gesundAt ? Date.parse(i.gesundAt) : 0;
            const s = { ...i.schritte }; delete s.ungesundSeit;
            if (jetzt() - alt > 10 * 60_000 || i.schritte.ungesundSeit) await d.repo.aendern(i.id, { gesundAt: new Date(jetzt()).toISOString(), schritte: s });
          } else {
            const seit = typeof i.schritte.ungesundSeit === "string" ? Date.parse(i.schritte.ungesundSeit) : null;
            if (seit === null) {
              i.schritte = { ...i.schritte, ungesundSeit: new Date(jetzt()).toISOString() };
              await d.repo.aendern(i.id, { schritte: i.schritte });
            } else if (jetzt() - seit >= 15 * 60_000) {
              await merkeAlarm("ungesund", "läuft, antwortet aber seit über 15 Minuten nicht auf /healthz.");
            }
          }
          break;
        }
      }
    } catch (err) {
      bericht.fehler++;
      const text = err instanceof Error ? err.message : String(err);
      warnen({ id: i.id, app: i.flyApp, err: text }, "[cloud-abgleich] Instanz fehlgeschlagen");
      await merkeAlarm("abgleich_fehler", `Abgleich fehlgeschlagen: ${text.slice(0, 200)}`).catch(() => undefined);
    }
    await pause(1_200); // Fly erlaubt ~1 Anfrage/s je Maschine
  }

  // Apps ohne Datensatz (Kostenleck), nur im Volllauf.
  if (!nur) {
    try {
      const bekannt = new Set(alle.filter((i) => i.zustand !== "geloescht").map((i) => i.flyApp));
      bericht.waisen = (await d.fly.appsListe()).filter((a) => a.startsWith("ava-u-") && !bekannt.has(a));
      if (bericht.waisen.length && waisenAlarmFaellig(jetzt())) {
        await d.melden(`☁️ AVA Cloud: ${bericht.waisen.length} Fly-App(s) ohne Datensatz: ${bericht.waisen.join(", ")}`).catch(() => undefined);
      }
    } catch (err) {
      warnen({ err: err instanceof Error ? err.message : String(err) }, "[cloud-abgleich] Waisensuche fehlgeschlagen");
    }
  }
  return bericht;
}

let waisenGemeldet = 0;
function waisenAlarmFaellig(jetzt: number) {
  if (jetzt - waisenGemeldet < 6 * 3_600_000) return false;
  waisenGemeldet = jetzt;
  return true;
}

/** Fakten aus der Gateway-Datenbank. */
export function faktenAusDb(pool: pg.Pool, kontoSperre: (pool: pg.Pool, actorId: string) => Promise<string | null>) {
  return async (i: CloudInstanz): Promise<Fakten> => {
    const b = await pool.query<{ status: string }>(`SELECT status FROM "TenantBilling" WHERE "tenantId" = $1`, [i.tenantId]);
    return { kontoSperre: await kontoSperre(pool, i.actorId), abrechnung: b.rows[0]?.status ?? null };
  };
}
