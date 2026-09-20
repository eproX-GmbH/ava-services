// Relevanz auf dem Geraet (docs/PLAN_RELEVANZ.md).
//
// Aufgaben hier: Handlungen entgegennehmen, entprellen, in die
// Warteschlange legen, gebuendelt ans Gateway schicken und die gelesenen
// Werte fuer den Heartbeat vorhalten. Gerechnet wird im Gateway.
//
// Der Schalter: Die Funktion ist standardmaessig AN. Abgeschaltet wird sie
// entweder vom Nutzer oder von der Organisation; setzt die Organisation
// verbindlich, hat der Nutzer keinen Schalter. Ist sie aus, wird nichts
// erfasst, nichts uebertragen und nichts angezeigt.

import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getOrgPolicy, featureEnabled } from "../org-policy";
import { signalArt, ENTPRELLUNG_MS, WEGWISCHEN_AB } from "./katalog";
import * as ausgang from "./ausgang";

export interface RelevanzWert {
  zielArt: "firma" | "person";
  zielId: string;
  naehe: number;
  gewicht: number;
  rang: number;
  begruendung: Array<{ art: string; anteil: number; anzahl: number }>;
  letztesSignal: string | null;
}

interface Deps {
  gatewayUrl: string;
  getAccessToken: () => Promise<string | null>;
}

/** Spaetestens nach dieser Zeit wird uebertragen. */
const VERSAND_MS = 60_000;
/** Oder frueher, sobald so viele Eintraege warten. */
const VERSAND_AB = 50;
/** Werte so lange als aktuell ansehen. */
const CACHE_MS = 15 * 60_000;

let deps: Deps | null = null;
let timer: NodeJS.Timeout | null = null;
let laeuft = false;

/** Ziel -> Zeitpunkt des letzten gleichen Signals (Entprellung). */
const zuletzt = new Map<string, number>();
/** Firma+Alarmart -> wie oft weggewischt. */
const weggewischt = new Map<string, number>();
/** Gelesene Werte, bis sie veralten. */
const cache = new Map<string, { wert: RelevanzWert; bis: number }>();

// ---- Schalter --------------------------------------------------------------

interface Einstellung { an: boolean }

function pfad(): string {
  const dir = join(app.getPath("userData"), "relevanz");
  mkdirSync(dir, { recursive: true });
  return join(dir, "einstellung.json");
}

let einstellung: Einstellung | null = null;

function ladeEinstellung(): Einstellung {
  if (einstellung) return einstellung;
  try {
    const roh = JSON.parse(readFileSync(pfad(), "utf8")) as Partial<Einstellung>;
    einstellung = { an: roh.an !== false };
  } catch {
    // Keine Datei = noch nie etwas eingestellt = Standard an.
    einstellung = { an: true };
  }
  return einstellung;
}

/**
 * Darf das Mitglied selbst entscheiden?
 *
 * Fehlende Angabe heisst ja — so wie ein fehlender Feature-Schluessel
 * "erlaubt" heisst. Aeltere Gateways und Organisationen ohne diese
 * Vorgabe verhalten sich damit wie bisher.
 */
export function selbstbestimmt(): boolean {
  return getOrgPolicy().relevanzSelbstbestimmt !== false;
}

/** Ist die Erfassung aktiv? Organisation schlaegt Nutzer. */
export function aktiv(): boolean {
  if (!featureEnabled("relevanz")) return false;
  if (!selbstbestimmt()) return true; // Organisation setzt verbindlich
  return ladeEinstellung().an;
}

export function setzeAn(an: boolean): void {
  if (!selbstbestimmt()) return;
  einstellung = { an };
  try {
    writeFileSync(pfad(), JSON.stringify(einstellung), { mode: 0o600 });
  } catch { /* nicht schlimm genug, um den Aufruf scheitern zu lassen */ }
  if (!an) ausgang.leeren();
}

// ---- Erfassen --------------------------------------------------------------

export interface ErfassenOptionen {
  /** Bei Personen: die Firma, ueber die sie gefunden wurde. */
  firmaId?: string | null;
  /** Sachliche Passung 1..10, lokal gebildet. */
  gewicht?: number;
  /** Bei Alarmen: die Art, damit wiederholtes Wegwischen zaehlbar wird. */
  alarmArt?: string;
}

/**
 * Eine Handlung erfassen. Still und folgenlos, wenn die Funktion aus ist.
 *
 * Wird aus Ereignispfaden der Oberflaeche aufgerufen und darf deshalb
 * niemals werfen: Ein Fehler in der Erfassung darf keinen Klick
 * verschlucken.
 */
export function erfasse(art: string, zielId: string, opt: ErfassenOptionen = {}): void {
  try {
    if (!aktiv()) return;
    const def = signalArt(art);
    if (!def || !zielId) return;

    // Wiederholtes Wegwischen: Einmal heisst "erledigt", dreimal heisst
    // "lass mich damit in Ruhe". Erst ab dem dritten Mal zaehlt es.
    if (art === "firma.alarm.weggewischt") {
      const k = `${zielId}|${opt.alarmArt ?? ""}`;
      const n = (weggewischt.get(k) ?? 0) + 1;
      weggewischt.set(k, n);
      if (n < WEGWISCHEN_AB) return;
    }

    // Entprellung: Zehnmal neuladen ist kein Interesse. Zwei Aufrufe am
    // Vormittag und am Nachmittag zaehlen dagegen beide.
    const schluessel = `${art}|${def.ziel}|${zielId}`;
    const jetzt = Date.now();
    const vorher = zuletzt.get(schluessel);
    if (vorher !== undefined && jetzt - vorher < ENTPRELLUNG_MS) return;
    zuletzt.set(schluessel, jetzt);

    ausgang.anhaengen({
      zielArt: def.ziel,
      zielId,
      firmaId: opt.firmaId ?? null,
      art,
      punkte: def.punkte,
      // Halbwertszeit 0 steht im Katalog fuer "verfaellt nie"; die Rechnung
      // im Gateway erwartet dafuer einen sehr grossen Wert.
      halbwertT: def.halbwertT === 0 ? 100_000 : def.halbwertT,
      zeitpunkt: new Date(jetzt).toISOString(),
      gewicht: opt.gewicht,
    });

    if (ausgang.anzahl() >= VERSAND_AB) void sende();
  } catch {
    /* Erfassung darf den Aufrufer nie stoeren. */
  }
}

// ---- Versand ---------------------------------------------------------------

async function ruf(pfadTeil: string, init: RequestInit): Promise<Response | null> {
  if (!deps) return null;
  const token = await deps.getAccessToken();
  if (!token) return null;
  const url = new URL(pfadTeil, deps.gatewayUrl).toString();
  return fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

export async function sende(): Promise<void> {
  if (laeuft || !deps || !aktiv()) return;
  const buendel = ausgang.naechste(VERSAND_AB);
  if (buendel.length === 0) return;
  laeuft = true;
  try {
    const res = await ruf("/v1/relevanz/signale", {
      method: "POST",
      body: JSON.stringify({ signale: buendel }),
    });
    // Nur bei nachweislicher Annahme streichen. Ohne Netz, ohne Anmeldung
    // oder bei einem Serverfehler bleibt alles liegen und geht beim
    // naechsten Versuch mit.
    if (res?.ok) {
      ausgang.bestaetigen(buendel);
      cache.clear(); // Werte haben sich geaendert
    } else if (res && res.status >= 400 && res.status < 500 && res.status !== 429) {
      // Abgelehnt und nicht wiederholbar (etwa Funktion in der Organisation
      // abgeschaltet). Wegwerfen, sonst staut sich die Warteschlange bis
      // zum Deckel voll und blockiert Nachkommendes.
      ausgang.bestaetigen(buendel);
    }
  } catch {
    /* Netzfehler: liegen lassen. */
  } finally {
    laeuft = false;
  }
}

// ---- Lesen -----------------------------------------------------------------

/**
 * Werte zu bestimmten Zielen. Ohne Netz kommt der zuletzt bekannte Stand —
 * das ist richtiger, als so zu tun, als waere alles kalt.
 */
export async function werte(
  zielArt: "firma" | "person",
  ids: string[],
): Promise<Map<string, RelevanzWert>> {
  const ergebnis = new Map<string, RelevanzWert>();
  if (!aktiv() || ids.length === 0) return ergebnis;

  const jetzt = Date.now();
  const fehlend: string[] = [];
  for (const id of ids) {
    const c = cache.get(`${zielArt}:${id}`);
    if (c && c.bis > jetzt) ergebnis.set(id, c.wert);
    else fehlend.push(id);
  }
  if (fehlend.length === 0) return ergebnis;

  try {
    const res = await ruf(
      `/v1/relevanz?zielArt=${zielArt}&ids=${encodeURIComponent(fehlend.slice(0, 200).join(","))}`,
      { method: "GET" },
    );
    if (res?.ok) {
      const daten = (await res.json()) as { werte?: RelevanzWert[] };
      for (const w of daten.werte ?? []) {
        ergebnis.set(w.zielId, w);
        cache.set(`${w.zielArt}:${w.zielId}`, { wert: w, bis: jetzt + CACHE_MS });
      }
    }
  } catch {
    /* Ohne Netz bleibt es bei dem, was im Zwischenspeicher lag. */
  }
  return ergebnis;
}

/** Arbeitsvorschau fuer den Heartbeat, nach Rang. */
export async function vorschau(limit = 50): Promise<RelevanzWert[]> {
  if (!aktiv()) return [];
  try {
    const res = await ruf(`/v1/relevanz/vorschau?limit=${limit}`, { method: "GET" });
    if (!res?.ok) return [];
    const daten = (await res.json()) as { werte?: RelevanzWert[] };
    return daten.werte ?? [];
  } catch {
    return [];
  }
}

/** Rohsignale eines Ziels — die Einsicht in den Einstellungen. */
export async function rohsignale(
  zielArt?: "firma" | "person",
  zielId?: string,
): Promise<Array<{ zielArt: string; zielId: string; art: string; punkte: number; zeitpunkt: string }>> {
  try {
    const p = new URLSearchParams();
    if (zielArt) p.set("zielArt", zielArt);
    if (zielId) p.set("zielId", zielId);
    const res = await ruf(`/v1/relevanz/signale?${p.toString()}`, { method: "GET" });
    if (!res?.ok) return [];
    const daten = (await res.json()) as { signale?: Array<{ zielArt: string; zielId: string; art: string; punkte: number; zeitpunkt: string }> };
    return daten.signale ?? [];
  } catch {
    return [];
  }
}

/**
 * Vergessen. Ohne Ziel: alles. Mit `sperreTage` wird das Ziel so lange
 * nicht wieder warm — gedacht fuer das Entfernen einer Firma aus der
 * Uebersicht, damit sie nicht durch Nebenwirkungen zurueckkehrt.
 */
export async function vergessen(
  zielArt?: "firma" | "person",
  zielId?: string,
  sperreTage?: number,
): Promise<boolean> {
  try {
    const p = new URLSearchParams();
    if (zielArt) p.set("zielArt", zielArt);
    if (zielId) p.set("zielId", zielId);
    if (sperreTage) p.set("sperreTage", String(sperreTage));
    const res = await ruf(`/v1/relevanz/signale?${p.toString()}`, { method: "DELETE" });
    cache.clear();
    if (!zielId) ausgang.leeren();
    return res?.ok === true;
  } catch {
    return false;
  }
}

/** Organisationsaggregat: welche Firmen gerade Thema sind. Anzahl, keine Namen. */
export async function thema(limit = 50): Promise<{
  verfuegbar: boolean;
  grund: string | null;
  firmen: Array<{ companyId: string; anzahl: number; zuletzt: string | null }>;
}> {
  const leer = { verfuegbar: false, grund: "nicht_erreichbar", firmen: [] };
  if (!featureEnabled("relevanz")) return { ...leer, grund: "funktion_abgeschaltet" };
  try {
    const res = await ruf(`/v1/relevanz/thema?limit=${limit}`, { method: "GET" });
    if (!res?.ok) return leer;
    return (await res.json()) as Awaited<ReturnType<typeof thema>>;
  } catch {
    return leer;
  }
}

// ---- Start und Ende --------------------------------------------------------

export function initRelevanz(d: Deps): void {
  deps = d;
  if (timer) return;
  timer = setInterval(() => { void sende(); }, VERSAND_MS);
  timer.unref?.();
}

/** Beim ordentlichen Beenden: noch einmal alles rausschicken. */
export async function beendeRelevanz(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  await sende();
}
