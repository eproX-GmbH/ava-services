// Hintergrundaufgaben im Chat (docs/PLAN_HINTERGRUNDAUFGABEN.md, 2026-10-03).
//
// Nutzerwunsch: Startet AVA eine Verarbeitung (Import, CRM-Import, Radar-
// Uebernahme), soll der Chat sie selbst verfolgen und sich mit dem Ergebnis
// melden, statt "frag spaeter nach dem Stand" zu sagen. Vorbild Claude Code:
// Hintergrundaufgabe in einer Leiste, bei Abschluss eine Benachrichtigung im
// Gespraechsverlauf, auf die das Modell von sich aus antwortet.
//
// Ablauf:
//   1. Registrieren: automatisch, wenn ein Werkzeug mit transactionId
//      antwortet (siehe AUTO_WERKZEUGE), oder per `aufgabe_beobachten`.
//   2. Beobachten: alle 20 s den Stand je Transaktion aus dem Gateway
//      (/v1/transactions/{id}/entities), Leiste im Chat live aktualisieren.
//   3. Melden: sind alle Firmen fertig (completed/failed/skipped), schiebt
//      der Waechter eine Notiz in die Unterhaltung und startet einen Zug.
//      Laeuft gerade ein anderer Zug, wird beim naechsten Takt erneut versucht.
//   4. Haengt eine Aufgabe 2 Stunden ohne Fortschritt, meldet AVA das einmal
//      (siehe Persist-Bus-Ausfall 27.09.–03.10.).
//
// Kosten: Das Beobachten ist reiner Gateway-Abruf ohne KI. Erst die Meldung
// ist ein Modellzug, und der ist das, worum der Nutzer gebeten hat.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { GatewayClient } from "../agent/gateway-client";

export type AufgabeStatus = "laeuft" | "fertig" | "haengt" | "abgebrochen";

export interface AufgabenStand {
  total: number;
  fertig: number;
  abgeschlossen: number;
  fehlgeschlagen: number;
  uebersprungen: number;
  laufend: number;
  fehlerBeispiele: Array<{ companyId?: string; meldung: string }>;
}

export interface HintergrundAufgabe {
  id: string;
  conversationId: string;
  transactionId: string;
  titel: string;
  quelle: string;
  gestartet: number;
  status: AufgabeStatus;
  stand: AufgabenStand | null;
  /** Zeitpunkt der letzten Aenderung am Fortschritt (fuer "haengt"). */
  fortschrittAm: number;
  geprueftAm: number | null;
  /** true, sobald die Meldung im Chat angekommen ist. */
  gemeldet: boolean;
  beendet: number | null;
  letzterFehler: string | null;
}

/** Werkzeuge, deren transactionId automatisch beobachtet wird. */
export const AUTO_WERKZEUGE: Record<string, string> = {
  import_excel: "Excel-Import",
  import_companies: "Firmen-Import",
  import_companies_from_crm: "CRM-Import",
};

const TAKT_MS = 20_000;
const HAENGT_NACH_MS = 2 * 60 * 60_000;
/** Erledigte Aufgaben bleiben so lange in der Leiste sichtbar. */
const SICHTBAR_NACH_ENDE_MS = 30 * 60_000;
const AUFBEWAHREN_MS = 7 * 24 * 60 * 60_000;
const SEITEN_GROESSE = 200;
const MAX_SEITEN = 25;

type EntityRow = { companyId?: string; state?: string; errorMessage?: string };

/** Stand einer Transaktion; geteilt mit dem Werkzeug `import_status`. */
export async function transaktionsStand(gateway: GatewayClient, transactionId: string, signal?: AbortSignal): Promise<AufgabenStand> {
  const s: AufgabenStand = { total: 0, fertig: 0, abgeschlossen: 0, fehlgeschlagen: 0, uebersprungen: 0, laufend: 0, fehlerBeispiele: [] };
  let gesehen = 0;
  let total: number | undefined;
  for (let page = 1; page <= MAX_SEITEN; page++) {
    const data = await gateway.request<{ items?: EntityRow[]; total?: number }>(
      `/v1/transactions/${encodeURIComponent(transactionId)}/entities`,
      { query: { page, pageSize: SEITEN_GROESSE }, ...(signal ? { signal } : {}) },
    );
    const items = data.items ?? [];
    if (typeof data.total === "number") total = data.total;
    for (const r of items) {
      gesehen++;
      if (r.state === "completed") s.abgeschlossen++;
      else if (r.state === "failed") {
        s.fehlgeschlagen++;
        if (r.errorMessage && s.fehlerBeispiele.length < 5) s.fehlerBeispiele.push({ ...(r.companyId ? { companyId: r.companyId } : {}), meldung: r.errorMessage.slice(0, 200) });
      } else if (r.state === "skipped") s.uebersprungen++;
      else s.laufend++;
    }
    if (items.length < SEITEN_GROESSE || (total !== undefined && gesehen >= total)) break;
  }
  s.total = total ?? gesehen;
  s.fertig = s.abgeschlossen + s.fehlgeschlagen + s.uebersprungen;
  return s;
}

/** Text, der bei Abschluss als Notiz in die Unterhaltung geht. Das Praefix
 *  erkennt der Renderer und zeigt die Notiz als Hinweis statt als Blase. */
export const MELDUNG_PRAEFIX = "[Hintergrundaufgabe";

export function meldungsText(a: HintergrundAufgabe): string {
  const s = a.stand;
  const dauerMin = Math.max(1, Math.round(((a.beendet ?? Date.now()) - a.gestartet) / 60_000));
  const kopf = a.status === "haengt"
    ? `${MELDUNG_PRAEFIX} haengt] ${a.titel} (Transaktion ${a.transactionId}) kommt seit über 2 Stunden nicht voran.`
    : `${MELDUNG_PRAEFIX} abgeschlossen] ${a.titel} (Transaktion ${a.transactionId}) ist nach ${dauerMin} Min. fertig.`;
  const zahlen = s
    ? `Firmen: ${s.total}, abgeschlossen ${s.abgeschlossen}${s.fehlgeschlagen > 0 ? `, fehlgeschlagen ${s.fehlgeschlagen}` : ""}${s.uebersprungen > 0 ? `, übersprungen ${s.uebersprungen}` : ""}${s.laufend > 0 ? `, noch offen ${s.laufend}` : ""}.`
    : "";
  const fehler = s && s.fehlerBeispiele.length > 0 ? ` Fehlerbeispiele: ${s.fehlerBeispiele.map((f) => `${f.companyId ?? "?"}: ${f.meldung}`).join(" | ")}.` : "";
  const auftrag = a.status === "haengt"
    ? " Sag dem Nutzer kurz, welche Schritte haengen, und biete an, sie neu anzustossen (retry_stage). Nicht von dir aus neu starten."
    : " Melde dem Nutzer jetzt von dir aus das Ergebnis: knapp, mit den wichtigsten Erkenntnissen zu den Firmen (lies sie bei Bedarf mit company_get bzw. transaction_entities nach), nenne Fehlschlaege und schlage einen sinnvollen naechsten Schritt vor.";
  return `${kopf} ${zahlen}${fehler}${auftrag}`;
}

export interface AufgabenDeps {
  gateway: GatewayClient;
  datei: string;
  /** Startet einen Zug mit der Notiz; false = gerade belegt, spaeter erneut. */
  melden: (conversationId: string, text: string) => boolean;
  /** Systembenachrichtigung, wenn die App nicht im Vordergrund ist. */
  benachrichtigen?: (titel: string, text: string) => void;
  /** Darf gerade geprueft werden (angemeldet, kein Worker-Modus)? */
  aktiv?: () => boolean;
  log?: (msg: string) => void;
}

export class HintergrundAufgaben extends EventEmitter {
  private liste: HintergrundAufgabe[] = [];
  private timer: NodeJS.Timeout | null = null;
  private laeuftTakt = false;

  constructor(private readonly deps: AufgabenDeps) {
    super();
    this.laden();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.takt(), TAKT_MS);
    this.timer.unref?.();
    void this.takt();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Registriert eine Transaktion; doppelte Registrierung je Unterhaltung ist ein No-op. */
  registrieren(input: { conversationId: string; transactionId: string; titel: string; quelle: string }): HintergrundAufgabe {
    const vorhanden = this.liste.find((a) => a.transactionId === input.transactionId && a.conversationId === input.conversationId);
    if (vorhanden) return vorhanden;
    const jetzt = Date.now();
    const a: HintergrundAufgabe = {
      id: `auf-${jetzt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      conversationId: input.conversationId,
      transactionId: input.transactionId,
      titel: input.titel.slice(0, 120),
      quelle: input.quelle,
      gestartet: jetzt,
      status: "laeuft",
      stand: null,
      fortschrittAm: jetzt,
      geprueftAm: null,
      gemeldet: false,
      beendet: null,
      letzterFehler: null,
    };
    this.liste.push(a);
    this.speichern();
    this.aenderung();
    // Ersten Stand gleich holen, damit die Leiste sofort Zahlen zeigt.
    setTimeout(() => void this.takt(), 3_000).unref?.();
    return a;
  }

  abbrechen(id: string): boolean {
    const a = this.liste.find((x) => x.id === id);
    if (!a || a.status !== "laeuft") return false;
    a.status = "abgebrochen";
    a.beendet = Date.now();
    a.gemeldet = true;
    this.speichern();
    this.aenderung();
    return true;
  }

  /** Sichtbare Aufgaben (laufend + kuerzlich beendet), optional je Unterhaltung. */
  sichtbar(conversationId?: string): HintergrundAufgabe[] {
    const jetzt = Date.now();
    return this.liste.filter(
      (a) => (!conversationId || a.conversationId === conversationId) &&
        (a.status === "laeuft" || !a.gemeldet || (a.beendet !== null && jetzt - a.beendet < SICHTBAR_NACH_ENDE_MS)),
    );
  }

  alle(conversationId?: string): HintergrundAufgabe[] {
    return this.liste.filter((a) => !conversationId || a.conversationId === conversationId);
  }

  /** Ein Durchgang: Stand holen, Abschluss erkennen, Meldungen zustellen. */
  async takt(): Promise<void> {
    if (this.laeuftTakt) return;
    if (this.deps.aktiv && !this.deps.aktiv()) return;
    this.laeuftTakt = true;
    try {
      const jetzt = Date.now();
      let geaendert = false;
      for (const a of this.liste) {
        if (a.status !== "laeuft") continue;
        try {
          const s = await transaktionsStand(this.deps.gateway, a.transactionId);
          const vorher = a.stand;
          if (!vorher || vorher.fertig !== s.fertig || vorher.total !== s.total) a.fortschrittAm = jetzt;
          a.stand = s;
          a.geprueftAm = jetzt;
          a.letzterFehler = null;
          if (s.total > 0 && s.laufend === 0 && s.fertig >= s.total) {
            a.status = "fertig";
            a.beendet = jetzt;
          } else if (jetzt - a.fortschrittAm > HAENGT_NACH_MS) {
            a.status = "haengt";
            a.beendet = jetzt;
          }
          geaendert = true;
        } catch (err) {
          a.letzterFehler = err instanceof Error ? err.message : String(err);
          a.geprueftAm = jetzt;
          geaendert = true;
        }
      }
      // Zustellen: je Takt hoechstens eine Meldung, damit Zuege nicht kollidieren.
      const offen = this.liste.find((a) => (a.status === "fertig" || a.status === "haengt") && !a.gemeldet);
      if (offen) {
        const ok = this.deps.melden(offen.conversationId, meldungsText(offen));
        if (ok) {
          offen.gemeldet = true;
          geaendert = true;
          this.deps.log?.(`[aufgaben] gemeldet ${offen.id} (${offen.status}) tx=${offen.transactionId}`);
          const s = offen.stand;
          this.deps.benachrichtigen?.(
            offen.status === "fertig" ? `${offen.titel} fertig` : `${offen.titel} haengt`,
            s ? `${s.abgeschlossen} von ${s.total} Firmen verarbeitet${s.fehlgeschlagen > 0 ? `, ${s.fehlgeschlagen} fehlgeschlagen` : ""}.` : "",
          );
        }
      }
      // Aufraeumen
      const vorherLaenge = this.liste.length;
      this.liste = this.liste.filter((a) => a.status === "laeuft" || !a.beendet || jetzt - a.beendet < AUFBEWAHREN_MS);
      if (this.liste.length !== vorherLaenge) geaendert = true;
      if (geaendert) {
        this.speichern();
        this.aenderung();
      }
    } finally {
      this.laeuftTakt = false;
    }
  }

  private aenderung(): void {
    this.emit("aenderung", this.sichtbar());
  }

  private laden(): void {
    try {
      if (!existsSync(this.deps.datei)) return;
      const roh = JSON.parse(readFileSync(this.deps.datei, "utf8")) as unknown;
      if (Array.isArray(roh)) this.liste = roh.filter((x): x is HintergrundAufgabe => !!x && typeof (x as HintergrundAufgabe).transactionId === "string");
    } catch {
      this.liste = [];
    }
  }

  private speichern(): void {
    try {
      writeFileSync(this.deps.datei, JSON.stringify(this.liste, null, 1));
    } catch (err) {
      this.deps.log?.(`[aufgaben] speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Prozessweite Instanz: die Werkzeuge werden vor dem Waechter registriert.
let instanz: HintergrundAufgaben | null = null;
export function setzeAufgabenInstanz(a: HintergrundAufgaben): void {
  instanz = a;
}
export function aufgabenInstanz(): HintergrundAufgaben | null {
  return instanz;
}
