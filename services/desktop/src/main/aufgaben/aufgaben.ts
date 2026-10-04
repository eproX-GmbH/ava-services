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
//   4. Lebendigkeit (Stufe 2, Nutzervorgabe 2026-10-03): Jede Veraenderung
//      zaehlt, also neue Schritte, Endzustaende und die Lebenszeichen, die
//      Producer alle 5 Minuten waehrend der Arbeit senden. Solange sich
//      etwas bewegt, wird nie abgebrochen. Bewegt sich STILLSTAND_MS lang gar
//      nichts, bricht der Waechter die offenen Schritte im Gateway mit Fehler
//      ab und meldet das.
//
// Kosten: Das Beobachten ist reiner Gateway-Abruf ohne KI. Erst die Meldung
// ist ein Modellzug, und der ist das, worum der Nutzer gebeten hat.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { GatewayClient } from "../agent/gateway-client";

/** abgebrochen = vom Waechter nach Stillstand beendet; nicht_verfolgt = Nutzer hat × gedrueckt. */
export type AufgabeStatus = "laeuft" | "fertig" | "abgebrochen" | "nicht_verfolgt";

export interface AufgabenStand {
  /** Firmen der Transaktion. */
  total: number;
  /** Firmen ohne offenen Schritt. */
  fertig: number;
  /** Firmen ohne offenen Schritt und ohne Fehler. */
  abgeschlossen: number;
  /** Firmen mit mindestens einem fehlgeschlagenen Schritt. */
  fehlgeschlagen: number;
  uebersprungen: number;
  /** Firmen mit mindestens einem offenen Schritt. */
  laufend: number;
  /** Offene Schritte (pending/in_progress) ueber alle Firmen. */
  offeneSchritte: number;
  /** Juengste Aenderung an irgendeinem Schritt (ISO). */
  letztesLebenszeichen: string | null;
  fehlerBeispiele: Array<{ companyId?: string; meldung: string }>;
}

export interface HintergrundAufgabe {
  id: string;
  conversationId: string;
  transactionId: string;
  titel: string;
  quelle: string;
  /** Werkzeugaufruf, der die Aufgabe gestartet hat: dort steht die Karte im Verlauf. */
  ankerToolCallId?: string;
  gestartet: number;
  status: AufgabeStatus;
  stand: AufgabenStand | null;
  /** Zeitpunkt der letzten beobachteten Veraenderung (Lebendigkeit). */
  fortschrittAm: number;
  /** Fingerabdruck des letzten Stands (Zaehler + letztes Lebenszeichen). */
  fingerabdruck?: string;
  /** Wie oft hintereinander "alles fertig" gesehen (Uebergang zwischen Schritten abwarten). */
  fertigGesehen?: number;
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
/** Nutzervorgabe 2026-10-03: 60 Minuten ohne jede Veraenderung = Abbruch. */
export const STILLSTAND_MS = 60 * 60_000;
/** Erledigte Aufgaben bleiben so lange in der Leiste sichtbar. */
const SICHTBAR_NACH_ENDE_MS = 30 * 60_000;
/** Karten stehen im Verlauf wie Nachrichten; so lange bleiben sie erhalten. */
const AUFBEWAHREN_MS = 180 * 24 * 60 * 60_000;
const SEITEN_GROESSE = 200;
const MAX_SEITEN = 25;

type FortschrittAntwort = {
  firmen: number;
  firmenFertig: number;
  firmenMitFehler: number;
  schritte: { gesamt: number; offen: number; abgeschlossen: number; fehlgeschlagen: number; uebersprungen: number };
  letztesLebenszeichen: string | null;
  fehlerBeispiele: Array<{ companyId: string; producer: string; meldung: string }>;
};

/** Stand einer Transaktion auf Schritt-Ebene (Gateway /fortschritt). */
export async function transaktionsStand(gateway: GatewayClient, transactionId: string, signal?: AbortSignal): Promise<AufgabenStand> {
  const f = await gateway.request<FortschrittAntwort>(
    `/v1/transactions/${encodeURIComponent(transactionId)}/fortschritt`,
    signal ? { signal } : {},
  );
  const fertigOhneFehler = Math.max(0, f.firmenFertig - f.firmenMitFehler);
  return {
    total: f.firmen,
    fertig: f.firmenFertig,
    abgeschlossen: fertigOhneFehler,
    fehlgeschlagen: f.firmenMitFehler,
    uebersprungen: 0,
    laufend: Math.max(0, f.firmen - f.firmenFertig),
    offeneSchritte: f.schritte.offen,
    letztesLebenszeichen: f.letztesLebenszeichen,
    fehlerBeispiele: f.fehlerBeispiele.map((x) => ({ companyId: x.companyId, meldung: `${x.producer}: ${x.meldung}` })),
  };
}

/** Text, der bei Abschluss als Notiz in die Unterhaltung geht. Das Praefix
 *  erkennt der Renderer und zeigt die Notiz als Hinweis statt als Blase. */
export const MELDUNG_PRAEFIX = "[Hintergrundaufgabe";

export function meldungsText(a: HintergrundAufgabe): string {
  const s = a.stand;
  const dauerMin = Math.max(1, Math.round(((a.beendet ?? Date.now()) - a.gestartet) / 60_000));
  const kopf = a.status === "abgebrochen"
    ? `${MELDUNG_PRAEFIX} abgebrochen] ${a.titel} (Transaktion ${a.transactionId}) kam ${Math.round(STILLSTAND_MS / 60_000)} Minuten lang gar nicht weiter und wurde nach ${dauerMin} Min. mit Fehler abgebrochen.`
    : `${MELDUNG_PRAEFIX} abgeschlossen] ${a.titel} (Transaktion ${a.transactionId}) ist nach ${dauerMin} Min. fertig.`;
  const zahlen = s
    ? `Firmen: ${s.total}, ohne Fehler fertig ${s.abgeschlossen}${s.fehlgeschlagen > 0 ? `, mit Fehler ${s.fehlgeschlagen}` : ""}${s.laufend > 0 ? `, noch offen ${s.laufend}` : ""}.`
    : "";
  const fehler = s && s.fehlerBeispiele.length > 0 ? ` Fehlerbeispiele: ${s.fehlerBeispiele.map((f) => `${f.companyId ?? "?"}: ${f.meldung}`).join(" | ")}.` : "";
  const auftrag = a.status === "abgebrochen"
    ? " Sag dem Nutzer kurz, dass und wo die Verarbeitung stehen geblieben ist (lies bei Bedarf transaction_errors), nenne die wahrscheinliche Ursache und biete an, die betroffenen Schritte neu anzustossen (retry_stage). Nicht von dir aus neu starten."
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
  registrieren(input: { conversationId: string; transactionId: string; titel: string; quelle: string; ankerToolCallId?: string }): HintergrundAufgabe {
    const vorhanden = this.liste.find((a) => a.transactionId === input.transactionId && a.conversationId === input.conversationId);
    if (vorhanden) {
      if (input.ankerToolCallId && !vorhanden.ankerToolCallId) {
        vorhanden.ankerToolCallId = input.ankerToolCallId;
        this.speichern();
        this.aenderung();
      }
      return vorhanden;
    }
    const jetzt = Date.now();
    const a: HintergrundAufgabe = {
      id: `auf-${jetzt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      conversationId: input.conversationId,
      transactionId: input.transactionId,
      titel: input.titel.slice(0, 120),
      quelle: input.quelle,
      ...(input.ankerToolCallId ? { ankerToolCallId: input.ankerToolCallId } : {}),
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

  /** × in der Leiste: nur nicht mehr verfolgen, die Verarbeitung laeuft weiter. */
  abbrechen(id: string): boolean {
    const a = this.liste.find((x) => x.id === id);
    if (!a || a.status !== "laeuft") return false;
    a.status = "nicht_verfolgt";
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
          // Lebendigkeit: jede Veraenderung zaehlt (Zaehler, neue Schritte,
          // Endzustaende, Lebenszeichen der Producer).
          const abdruck = `${s.total}|${s.fertig}|${s.fehlgeschlagen}|${s.offeneSchritte}|${s.letztesLebenszeichen ?? ""}`;
          if (abdruck !== a.fingerabdruck) {
            a.fingerabdruck = abdruck;
            a.fortschrittAm = jetzt;
          }
          a.stand = s;
          a.geprueftAm = jetzt;
          a.letzterFehler = null;
          const zuletzt = s.letztesLebenszeichen ? Date.parse(s.letztesLebenszeichen) : 0;
          if (s.total > 0 && s.offeneSchritte === 0) {
            // Zwischen zwei Schritten (Register fertig, Website noch nicht
            // angelegt) ist kurz nichts offen. Erst nach zwei Takten und
            // 90 s Ruhe als fertig werten.
            a.fertigGesehen = (a.fertigGesehen ?? 0) + 1;
            if (a.fertigGesehen >= 2 && jetzt - zuletzt > 90_000) {
              a.status = "fertig";
              a.beendet = jetzt;
            }
          } else {
            a.fertigGesehen = 0;
            if (jetzt - a.fortschrittAm > STILLSTAND_MS) {
              const grund = `seit ${Math.round(STILLSTAND_MS / 60_000)} Minuten kein Fortschritt`;
              try {
                await this.deps.gateway.request(`/v1/transactions/${encodeURIComponent(a.transactionId)}/abbrechen`, { method: "POST", body: { grund } });
                a.stand = await transaktionsStand(this.deps.gateway, a.transactionId).catch(() => s);
              } catch (err) {
                this.deps.log?.(`[aufgaben] abbrechen im Gateway fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
              }
              a.status = "abgebrochen";
              a.beendet = jetzt;
            }
          }
          geaendert = true;
        } catch (err) {
          a.letzterFehler = err instanceof Error ? err.message : String(err);
          a.geprueftAm = jetzt;
          geaendert = true;
        }
      }
      // Zustellen: je Takt hoechstens eine Meldung, damit Zuege nicht kollidieren.
      const offen = this.liste.find((a) => (a.status === "fertig" || a.status === "abgebrochen") && !a.gemeldet);
      if (offen) {
        const ok = this.deps.melden(offen.conversationId, meldungsText(offen));
        if (ok) {
          offen.gemeldet = true;
          geaendert = true;
          this.deps.log?.(`[aufgaben] gemeldet ${offen.id} (${offen.status}) tx=${offen.transactionId}`);
          const s = offen.stand;
          this.deps.benachrichtigen?.(
            offen.status === "fertig" ? `${offen.titel} fertig` : `${offen.titel} abgebrochen`,
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

  /** Anker nachtragen (aufgabe_beobachten kennt seine eigene Aufruf-Id nicht). */
  verankern(conversationId: string, transactionId: string, toolCallId: string): void {
    const a = this.liste.find((x) => x.conversationId === conversationId && x.transactionId === transactionId);
    if (!a || a.ankerToolCallId) return;
    a.ankerToolCallId = toolCallId;
    this.speichern();
    this.aenderung();
  }

  private aenderung(): void {
    this.emit("aenderung", this.liste);
  }

  private laden(): void {
    try {
      if (!existsSync(this.deps.datei)) return;
      const roh = JSON.parse(readFileSync(this.deps.datei, "utf8")) as unknown;
      if (Array.isArray(roh)) {
        this.liste = roh.filter((x): x is HintergrundAufgabe => !!x && typeof (x as HintergrundAufgabe).transactionId === "string");
        // v0.1.743 kannte "haengt" (nur gemeldet) und "abgebrochen" (= ×).
        for (const a of this.liste) {
          const alt = a.status as string;
          if (alt === "haengt") a.status = "abgebrochen";
          else if (alt === "abgebrochen" && a.gemeldet && !a.stand) a.status = "nicht_verfolgt";
        }
      }
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
