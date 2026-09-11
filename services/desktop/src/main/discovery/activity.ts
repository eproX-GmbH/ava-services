// v0.1.636 — Zentraler Live-Zustand des Firmen-Radars.
//
// Scan, Profil-Worker und Matcher melden hier, was sie gerade tun
// (Suchbegriff, Firma in Arbeit, Zaehler). Der Renderer bekommt jede
// Aenderung gedrosselt (max. alle 250 ms) per IPC; das Chat-Tool
// radar_activity liest denselben Stand. Kein Persistieren — nach einem
// Neustart ist der Zustand leer, und das ist korrekt (nichts laeuft).

import { EventEmitter } from "node:events";
import type { RadarActivityState, RadarPhase } from "../../shared/radar-activity-types";

const MAX_EREIGNISSE = 40;
const THROTTLE_MS = 250;

function leer(): RadarActivityState {
  return {
    phase: "idle",
    seit: null,
    schritt: null,
    scan: { laeuft: false, queries: [], aktuelleQuery: null, gefunden: { osm: 0, serp: 0, register: 0 }, hochgeladen: 0 },
    profile: { laeuft: false, aktuell: [], offen: 0, fertig: 0, fehler: 0, fehlerGruende: { website: 0, ki: 0, speichern: 0 }, letzterGrund: null, pausiert: false },
    match: { laeuft: false, aktuell: [], offen: 0, bewertet: 0 },
    letzterFehler: null,
    ereignisse: [],
    letzterLauf: null,
  };
}

class RadarActivity extends EventEmitter {
  private state: RadarActivityState = leer();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  get(): RadarActivityState {
    return this.state;
  }

  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.emit("changed", this.state);
    }, THROTTLE_MS);
  }

  private ablesen(): RadarPhase {
    if (this.state.scan.laeuft) return "scan";
    if (this.state.profile.laeuft) return "profile";
    if (this.state.match.laeuft) return "match";
    return "idle";
  }

  private phaseNeu(): void {
    const p = this.ablesen();
    if (p !== this.state.phase) {
      this.state.phase = p;
      this.state.seit = p === "idle" ? null : new Date().toISOString();
      if (p === "idle") this.state.schritt = null;
    }
  }

  ereignis(text: string): void {
    this.state.ereignisse = [{ at: new Date().toISOString(), text }, ...this.state.ereignisse].slice(0, MAX_EREIGNISSE);
    this.touch();
  }

  fehler(text: string): void {
    this.state.letzterFehler = { at: new Date().toISOString(), text };
    this.ereignis(`Fehler: ${text}`);
  }

  schritt(text: string): void {
    this.state.schritt = text;
    this.touch();
  }

  // ---- Scan -------------------------------------------------------------
  scanStart(): void {
    this.state.scan = { laeuft: true, queries: [], aktuelleQuery: null, gefunden: { osm: 0, serp: 0, register: 0 }, hochgeladen: 0 };
    this.state.letzterFehler = null;
    this.phaseNeu();
    this.ereignis("Scan gestartet");
  }
  scanQueries(queries: string[]): void {
    this.state.scan.queries = queries;
    this.touch();
  }
  scanQuery(q: string | null, treffer?: number): void {
    this.state.scan.aktuelleQuery = q;
    if (typeof treffer === "number") this.state.scan.gefunden.serp += treffer;
    if (q) this.state.schritt = `Google-Suche: ${q}`;
    this.touch();
  }
  scanQuelle(quelle: "osm" | "register", anzahl: number): void {
    this.state.scan.gefunden[quelle] = anzahl;
    this.ereignis(`${quelle === "osm" ? "Karten-Suche" : "Handelsregister"}: ${anzahl} Firmen`);
  }
  scanHochgeladen(n: number): void {
    this.state.scan.hochgeladen += n;
    this.touch();
  }
  scanEnde(text: string): void {
    this.state.scan.laeuft = false;
    this.state.scan.aktuelleQuery = null;
    this.phaseNeu();
    this.ereignis(text);
  }

  // ---- Mini-Profile -----------------------------------------------------
  profileStart(offen: number): void {
    this.state.profile = { laeuft: true, aktuell: [], offen, fertig: 0, fehler: 0, fehlerGruende: { website: 0, ki: 0, speichern: 0 }, letzterGrund: null, pausiert: false };
    this.state.schritt = `Mini-Profile: ${offen} offen`;
    this.phaseNeu();
    this.ereignis(`Mini-Profile: ${offen} Firmen anstehend`);
  }
  profileOffen(offen: number): void {
    this.state.profile.offen = offen;
    this.touch();
  }
  profileFirma(name: string, status: "start" | "ok" | "fehler", grund?: { art: "website" | "ki" | "speichern"; text: string }): void {
    const p = this.state.profile;
    if (status === "start") {
      if (!p.aktuell.includes(name)) p.aktuell = [...p.aktuell, name].slice(-12);
    } else {
      p.aktuell = p.aktuell.filter((n) => n !== name);
      p.offen = Math.max(0, p.offen - 1);
      if (status === "ok") p.fertig++;
      else {
        p.fehler++;
        if (grund) {
          p.fehlerGruende[grund.art]++;
          p.letzterGrund = grund.text;
          // Jeden Fehlschlag mit Grund in den Verlauf; die KI-Meldung ist
          // fuer den Nutzer die entscheidende Diagnose ("Kein Schluessel",
          // "Abo deckt Hintergrund nicht", Timeout ...).
          this.state.ereignisse = [{ at: new Date().toISOString(), text: `${name}: ${grund.text}` }, ...this.state.ereignisse].slice(0, MAX_EREIGNISSE);
        }
      }
    }
    this.state.schritt = `Mini-Profile: ${p.fertig} fertig, ${p.offen} offen${p.fehler > 0 ? `, ${p.fehler} fehlgeschlagen` : ""}`;
    this.touch();
  }
  profilePausiert(on: boolean): void {
    if (this.state.profile.pausiert === on) return;
    this.state.profile.pausiert = on;
    if (on) this.ereignis("Mini-Profile pausiert: Chat hat Vorrang");
    else this.touch();
  }
  profileEnde(text: string): void {
    this.state.profile.laeuft = false;
    this.state.profile.aktuell = [];
    this.state.profile.pausiert = false;
    this.phaseNeu();
    this.ereignis(text);
  }

  // ---- ICP-Match --------------------------------------------------------
  matchStart(offen: number): void {
    this.state.match = { laeuft: true, aktuell: [], offen, bewertet: 0 };
    this.state.schritt = `ICP-Match: ${offen} zu bewerten`;
    this.phaseNeu();
    this.ereignis(`ICP-Match: ${offen} Firmen zu bewerten`);
  }
  matchBatch(namen: string[]): void {
    this.state.match.aktuell = namen;
    this.state.schritt = `ICP-Match: ${namen.length} Firmen im Urteil`;
    this.touch();
  }
  matchBewertet(n: number): void {
    this.state.match.bewertet += n;
    this.state.match.offen = Math.max(0, this.state.match.offen - n);
    this.state.match.aktuell = [];
    this.touch();
  }
  matchEnde(text: string): void {
    this.state.match.laeuft = false;
    this.state.match.aktuell = [];
    this.phaseNeu();
    this.ereignis(text);
  }

  letzterLauf(at: string | null, outcome: string | null): void {
    this.state.letzterLauf = at && outcome ? { at, outcome } : null;
    this.touch();
  }
}

export const radarActivity = new RadarActivity();
