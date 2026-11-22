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
//   CLOUD_LOESCH_TAGE=30    nach dem Stopp → endgültig löschen, frühestens 7 Tage nach der
//                           Vorwarn-Mail M11 (Z4); ohne Mail-Grund (Betreiber) nie automatisch
//   CLOUD_AUTO_LOESCHEN=0   automatisches Löschen aus; dann nur Meldung „Löschung fällig“
//
// Mails an Nutzer (Z4, §10.4): M2 verbunden, M3 Bestätigung fehlt (30 Min./24 h), M4/M5 Ausfall
// und Wiederkehr (ab 10 Min., höchstens 1 je 6 h, nicht während Update/Neustart), M11
// Löschung in 7 Tagen, M12 gelöscht.

import type pg from "pg";
import type { FlyKunden } from "./fly-maschinen";
import type { CloudBetrieb, CloudInstanz, CloudRepo, Grund, Soll } from "./instanzen";
import { rolloutSchritt, type RolloutBericht, type RolloutDeps } from "./rollout";

const TAG = 86_400_000;

export interface Fakten {
  /** geloescht | deaktiviert | gesperrt (KontoStatus) oder null */
  kontoSperre: string | null;
  /** TenantBilling.status der Organisation oder null (keine Abrechnung) */
  abrechnung: string | null;
  /** Seit wann die Zahlung offen ist (TenantBilling.pastDueSince), ISO */
  offenSeit?: string | null;
}

/**
 * Soll aus Wunsch und Fakten. Reihenfolge = Vorrang des Grundes.
 * Cloud-Frist (§10.5, E6): offene Zahlung → nach `fristTage` gestoppt, auch wenn die Organisation
 * selbst erst später (graceDays) gesperrt wird.
 */
export function sollBestimmen(
  i: Pick<CloudInstanz, "gewuenscht" | "grund"> & { abbestelltZum?: string | null },
  f: Fakten,
  jetzt: number = Date.now(),
  fristTage = 7,
): { soll: Soll; grund: Grund | null } {
  if (f.kontoSperre) return { soll: "gestoppt", grund: "konto" };
  if (f.abrechnung === "canceled") return { soll: "gestoppt", grund: "kuendigung" };
  if (f.abrechnung === "suspended") return { soll: "gestoppt", grund: "zahlung" };
  if (f.abrechnung === "past_due" && f.offenSeit && jetzt - Date.parse(f.offenSeit) >= fristTage * TAG) return { soll: "gestoppt", grund: "zahlung" };
  if (i.abbestelltZum && Date.parse(i.abbestelltZum) <= jetzt) return { soll: "gestoppt", grund: "abbestellt" };
  if (i.gewuenscht === "gestoppt") {
    const g = i.grund === "admin" || i.grund === "betreiber" ? i.grund : "betreiber";
    return { soll: "gestoppt", grund: g };
  }
  return { soll: "laufen", grund: null };
}

export type Aktion =
  | { art: "nichts" }
  | { art: "vorwarnen" }
  | { art: "fortsetzen" }
  | { art: "starten"; warum: "soll_laufen" | "unerwartet_gestoppt" }
  | { art: "stoppen"; wiederGestartet: boolean }
  | { art: "ruhen" }
  | { art: "loeschen" }
  | { art: "loeschen_faellig" }
  | { art: "gesundheit" };

export interface Regeln { ruheTage: number; loeschTage: number; autoLoeschen: boolean; maxVersuche: number; fristTage: number }

/** Vorwarnung M11 so viele Tage vor dem Löschen; gelöscht wird frühestens so lange danach. */
export const VORWARN_TAGE = 7;
const MIN = 60_000;
const STUNDE = 60 * MIN;

/** Pausen-Gründe, bei denen der Nutzer Mails bekommt (nicht: Betreiber, Konto). */
export const MAIL_GRUENDE = new Set<Grund>(["zahlung", "kuendigung", "abbestellt", "admin"]);

/** Wann die Daten frühestens gelöscht werden (für Anzeige und Mails); null = läuft. */
export function loeschDatum(i: Pick<CloudInstanz, "gestopptAt" | "schritte">, r: Pick<Regeln, "loeschTage">): string | null {
  if (!i.gestopptAt) return null;
  const nachStopp = Date.parse(i.gestopptAt) + r.loeschTage * TAG;
  const gewarnt = typeof i.schritte.m11 === "string" ? Date.parse(i.schritte.m11) + VORWARN_TAGE * TAG : 0;
  return new Date(Math.max(nachStopp, gewarnt)).toISOString();
}

const LAEUFT = new Set(["started", "starting", "replacing", "updating"]);

/**
 * Nächster Schritt für EINE Instanz. `fly` = Zustand der Maschine bei Fly
 * (null = keine Maschine bzw. nicht gefunden).
 */
export function naechsteAktion(i: CloudInstanz, soll: Soll, fly: string | null, jetzt: number, r: Regeln): Aktion {
  if (i.zustand === "geloescht" || i.zustand === "zahlung_offen") return { art: "nichts" };
  if (i.zustand === "wird_angelegt") {
    if (soll !== "laufen") return { art: "nichts" };
    return Number(i.schritte.versuche ?? 0) >= r.maxVersuche ? { art: "nichts" } : { art: "fortsetzen" };
  }
  const laeuft = fly !== null && LAEUFT.has(fly);
  if (soll === "gestoppt") {
    if (laeuft) return { art: "stoppen", wiederGestartet: i.zustand === "gestoppt" || i.zustand === "ruht" };
    const seit = i.gestopptAt ? Date.parse(i.gestopptAt) : null;
    if (i.zustand === "gestoppt" && seit !== null && jetzt - seit >= r.ruheTage * TAG) return { art: "ruhen" };
    if ((i.zustand === "ruht" || i.zustand === "gestoppt") && seit !== null) {
      // Löschen nur nach Vorwarnung (M11) mit 7 Tagen Abstand; Betreiber-Stopps nie automatisch.
      const mitMail = i.grund !== null && MAIL_GRUENDE.has(i.grund);
      const gewarnt = typeof i.schritte.m11 === "string" ? Date.parse(i.schritte.m11) : null;
      const automatisch = r.autoLoeschen && i.grund !== "betreiber";
      if (automatisch && mitMail && gewarnt === null && jetzt - seit >= Math.max(0, r.loeschTage - VORWARN_TAGE) * TAG) return { art: "vorwarnen" };
      if (i.zustand === "ruht" && jetzt - seit >= r.loeschTage * TAG) {
        if (!automatisch) return { art: "loeschen_faellig" };
        if (mitMail && (gewarnt === null || jetzt - gewarnt < VORWARN_TAGE * TAG)) return { art: "nichts" };
        return { art: "loeschen" };
      }
    }
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

/** Nachrichten des Abgleichers an Nutzer (Mail-Katalog §10.4). */
export type CloudNachricht =
  | "zahlung_offen" | "pausiert" | "laeuft_wieder"
  | "laeuft" | "bestaetigen" | "nicht_erreichbar" | "wieder_erreichbar" | "loeschung_angekuendigt" | "geloescht"
  | "update_hinweis" | "aktualisiert";

/** Erinnerungsstufe bei offener Zahlung: 0, 3, 6 Tage (§10.5); null = keine. */
export function zahlungsStufe(offenSeit: string | null | undefined, jetzt: number): 0 | 3 | 6 | null {
  if (!offenSeit) return null;
  const tage = Math.floor((jetzt - Date.parse(offenSeit)) / TAG);
  if (tage < 0) return null;
  return tage >= 6 ? 6 : tage >= 3 ? 3 : 0;
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
  /** Mails an Nutzer/Admins (M8–M10); ohne Angabe keine. */
  benachrichtigen?: (art: CloudNachricht, i: CloudInstanz, extra: Record<string, unknown>) => Promise<unknown>;
  /** Protokoll (im Gateway der Logger); ohne Angabe still. */
  warnen?: (daten: Record<string, unknown>, text: string) => void;
  /** Z7: Updates in Wellen (nur im Volllauf); ohne Angabe keine. */
  rollout?: Pick<RolloutDeps, "rollouts" | "betreiberTenant" | "starte" | "regeln" | "kanal" | "zielVersion">;
  /** Staging (docs/PLAN_STAGING.md): nur Instanzen, für die dieses Gateway zuständig ist; Standard alle. */
  zustaendig?: (i: CloudInstanz) => boolean;
  /** Waisensuche nur im Prod-Gateway (Standard an). */
  waisen?: boolean;
}

export function regelnAusEnv(): Regeln {
  const zahl = (n: string, d: number) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };
  return { ruheTage: zahl("CLOUD_RUHE_TAGE", 7), loeschTage: zahl("CLOUD_LOESCH_TAGE", 30), autoLoeschen: process.env.CLOUD_AUTO_LOESCHEN !== "0", maxVersuche: 5, fristTage: zahl("CLOUD_FRIST_TAGE", 7) };
}

export interface AbgleichBericht { geprueft: number; aktionen: Record<string, number>; fehler: number; waisen: string[]; rollout?: RolloutBericht | null }

/** Ein Durchlauf über alle (oder eine) Instanz. Fehler je Instanz brechen den Lauf nicht ab. */
export async function abgleichen(d: AbgleichDeps, nur?: string): Promise<AbgleichBericht> {
  const r: Regeln = { ...regelnAusEnv(), ...d.regeln };
  const jetzt = d.jetzt ?? Date.now;
  const pause = d.pause ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const warnen = d.warnen ?? (() => undefined);
  const bericht: AbgleichBericht = { geprueft: 0, aktionen: {}, fehler: 0, waisen: [] };
  const alle = await d.repo.liste();
  const zustaendig = d.zustaendig ?? (() => true);
  const liste = alle.filter((i) => i.zustand !== "geloescht" && (!nur || i.id === nur) && zustaendig(i));

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
      const fakten = await d.fakten(i);
      const { soll, grund } = sollBestimmen(i, fakten, jetzt(), r.fristTage);
      const vorher = { zustand: i.zustand, grund: i.grund };
      const melde = async (art: CloudNachricht, extra: Record<string, unknown> = {}) => {
        if (!d.benachrichtigen) return;
        await d.benachrichtigen(art, i, extra).catch((err) => warnen({ id: i.id, art, err: err instanceof Error ? err.message : String(err) }, "[cloud-abgleich] Mail fehlgeschlagen"));
      };
      // Erinnerungen bei offener Zahlung (Tag 0/3/6), solange die AVA noch läuft.
      if (fakten.abrechnung === "past_due" && soll === "laufen" && i.zustand !== "zahlung_offen") {
        const stufe = zahlungsStufe(fakten.offenSeit, jetzt());
        const basis = fakten.offenSeit ?? "";
        if (stufe !== null && i.schritte[`m8_${stufe}`] !== basis) {
          i.schritte = { ...i.schritte, [`m8_${stufe}`]: basis };
          await d.repo.aendern(i.id, { schritte: i.schritte });
          await melde("zahlung_offen", { stufe, pauseAm: new Date(Date.parse(basis) + r.fristTage * TAG).toISOString() });
        }
      }
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
          if (i.schritte.m4Offen || i.schritte.ungesundSeit || i.schritte.wiederSeit) {
            // Ausfall-Zustand vergessen: nach der Pause kommt M10, nicht zusätzlich M5.
            const s = { ...(await d.repo.holen(i.id))?.schritte };
            delete s.m4Offen; delete s.wiederSeit; delete s.ungesundSeit;
            await d.repo.aendern(i.id, { schritte: s });
          }
          if (!a.wiederGestartet && grund && MAIL_GRUENDE.has(grund) && vorher.zustand !== "gestoppt" && vorher.zustand !== "ruht") {
            await melde("pausiert", { grund, loeschenAb: new Date(jetzt() + r.loeschTage * TAG).toISOString() });
          }
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
          if (a.warum === "soll_laufen" && vorher.grund && MAIL_GRUENDE.has(vorher.grund)) await melde("laeuft_wieder", { grund: vorher.grund });
          break;
        case "ruhen":
          await d.betrieb.ruhen(i.id, "abgleicher");
          break;
        case "loeschen":
          await d.betrieb.loeschen(i.id, "abgleicher");
          if (i.grund && MAIL_GRUENDE.has(i.grund)) await melde("geloescht", { grund: i.grund });
          await d.melden(`☁️ AVA Cloud ${i.flyApp}: nach ${r.loeschTage} Tagen gelöscht (${i.grund}).`).catch(() => undefined);
          break;
        case "vorwarnen": {
          i.schritte = { ...i.schritte, m11: new Date(jetzt()).toISOString() };
          await d.repo.aendern(i.id, { schritte: i.schritte });
          await d.repo.ereignis(i.id, "loeschung_angekuendigt", "abgleicher", { am: loeschDatum(i, r) });
          await melde("loeschung_angekuendigt", { grund: i.grund, loeschenAm: loeschDatum(i, r) });
          break;
        }
        case "loeschen_faellig":
          await merkeAlarm("loeschen_faellig", `ist seit ${r.loeschTage} Tagen gestoppt (${i.grund}); Löschung fällig (CLOUD_AUTO_LOESCHEN aus).`);
          break;
        case "gesundheit":
          await gesundheit(d, i, fly, jetzt(), melde, merkeAlarm);
          break;
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
    if (d.waisen !== false) try {
      const bekannt = new Set(alle.filter((i) => i.zustand !== "geloescht").map((i) => i.flyApp));
      bericht.waisen = (await d.fly.appsListe()).filter((a) => a.startsWith("ava-u-") && !bekannt.has(a));
      if (bericht.waisen.length && waisenAlarmFaellig(jetzt())) {
        await d.melden(`☁️ AVA Cloud: ${bericht.waisen.length} Fly-App(s) ohne Datensatz: ${bericht.waisen.join(", ")}`).catch(() => undefined);
      }
    } catch (err) {
      warnen({ err: err instanceof Error ? err.message : String(err) }, "[cloud-abgleich] Waisensuche fehlgeschlagen");
    }
    if (d.rollout) {
      try {
        const aktuell = (await d.repo.liste()).filter((i) => i.zustand !== "geloescht" && zustaendig(i));
        bericht.rollout = await rolloutSchritt({ repo: d.repo, fly: d.fly, betrieb: d.betrieb, melden: d.melden, benachrichtigen: d.benachrichtigen, warnen, jetzt, ...d.rollout }, aktuell);
      } catch (err) {
        warnen({ err: err instanceof Error ? err.message : String(err) }, "[cloud-update] Schritt fehlgeschlagen");
      }
    }
  }
  return bericht;
}

/**
 * Gesundheit und Verbindung einer laufenden Instanz (Z4). Während Update/Neustart (Fly-Zustand
 * nicht „started“) wird nichts bewertet: keine Ausfallmail bei geplanten Updates.
 */
async function gesundheit(
  d: AbgleichDeps,
  i: CloudInstanz,
  fly: string | null,
  t: number,
  melde: (art: CloudNachricht, extra?: Record<string, unknown>) => Promise<void>,
  merkeAlarm: (art: string, text: string) => Promise<void>,
): Promise<void> {
  if (fly !== "started") return;
  const token = i.schritte.gatewayToken ? d.betrieb.gatewayToken(i.id) : null;
  const an = token ? await d.fly.anmeldung(i.flyApp, token) : null;
  // Verbindung: angemeldet → „läuft“ (+ M2 beim ersten Mal); wartet die Instanz wieder auf eine
  // Bestätigung (Device Flow mit Link), zurück auf „wartet“.
  if (an?.angemeldet) {
    const r = await d.betrieb.verbindungMelden(i.id, "abgleicher");
    if (r === "neu") await melde("laeuft");
  } else if (an && an.link && i.zustand === "laeuft") {
    await d.betrieb.verbindungVerloren(i.id, "abgleicher", t);
  }
  const frisch = an ? await d.repo.holen(i.id) : null;
  if (frisch) Object.assign(i, frisch);

  const ok = an !== null || (await d.fly.gesund(i.flyApp));
  const iso = new Date(t).toISOString();
  const s: CloudInstanz["schritte"] = { ...i.schritte };
  const vorher = JSON.stringify(s);
  let gesundAt: string | undefined;
  let nachricht: [CloudNachricht, Record<string, unknown>] | null = null;
  let alarm = false;

  if (ok) {
    delete s.ungesundSeit;
    if (t - (i.gesundAt ? Date.parse(i.gesundAt) : 0) > 10 * MIN) gesundAt = iso;
    // M5 erst, wenn sie nach einer Ausfallmail 5 Minuten stabil läuft (Wackeln = eine Mail).
    if (typeof s.m4Offen === "string") {
      if (typeof s.wiederSeit !== "string") s.wiederSeit = iso;
      else if (t - Date.parse(s.wiederSeit) >= 5 * MIN) {
        const dauerMin = Math.max(1, Math.round((Date.parse(s.wiederSeit) - Date.parse(s.m4Offen)) / MIN));
        delete s.m4Offen; delete s.wiederSeit;
        nachricht = ["wieder_erreichbar", { dauerMin }];
      }
    }
    // M3: Bestätigung fehlt seit 30 Minuten bzw. 24 Stunden (nur mit Ein-Klick-Endpunkt).
    if (i.zustand === "wartet_auf_verbindung" && an && !an.angemeldet && !nachricht) {
      const basis = Date.parse(typeof s.wartetSeit === "string" ? s.wartetSeit : i.createdAt);
      const stufe = t - basis >= 24 * STUNDE ? "24h" : t - basis >= 30 * MIN ? "30m" : null;
      if (stufe && !s[`m3_${stufe}`]) {
        s.m3_30m ??= iso;
        if (stufe === "24h") s.m3_24h = iso;
        nachricht = ["bestaetigen", { stufe }];
      }
    }
  } else {
    delete s.wiederSeit;
    if (typeof s.ungesundSeit !== "string") s.ungesundSeit = iso;
    else if (t - Date.parse(s.ungesundSeit) >= 10 * MIN) {
      alarm = true;
      const m4At = typeof s.m4At === "string" ? Date.parse(s.m4At) : 0;
      if (i.zustand === "laeuft" && t - m4At >= 6 * STUNDE) {
        if (typeof s.m4Offen !== "string") s.m4Offen = s.ungesundSeit;
        s.m4At = iso;
        nachricht = ["nicht_erreichbar", { seit: s.m4Offen }];
      }
    }
  }
  if (JSON.stringify(s) !== vorher || gesundAt) {
    i.schritte = s;
    await d.repo.aendern(i.id, { schritte: s, ...(gesundAt ? { gesundAt } : {}) });
  }
  if (alarm) await merkeAlarm("ungesund", "läuft, antwortet aber seit über 10 Minuten nicht (/healthz).");
  if (nachricht) await melde(nachricht[0], nachricht[1]);
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
    const b = await pool.query<{ status: string; pastDueSince: Date | null }>(`SELECT status, "pastDueSince" FROM "TenantBilling" WHERE "tenantId" = $1`, [i.tenantId]);
    const z = b.rows[0];
    return { kontoSperre: await kontoSperre(pool, i.actorId), abrechnung: z?.status ?? null, offenSeit: z?.pastDueSince ? z.pastDueSince.toISOString() : null };
  };
}
