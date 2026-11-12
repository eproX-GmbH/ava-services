// Radar-Warteschlange (2026-11-12, Wunsch Marc-Antonio: „anklicken, weg, fertig“).
//
// Ein Klick auf Importieren/Ignorieren in der Radar-Tabelle landet hier und die
// Zeile verschwindet sofort. Nach VERZOEGERUNG_MS ohne weiteren Klick geht alles
// Gesammelte in EINEM decideCandidates-Lauf raus (ein Vorgang statt zehn). Bis
// dahin kann der Nutzer zuruecknehmen. Was nicht importiert werden konnte (kein
// Ort, keine Zuordnung, Gateway-Fehler), bleibt als "fehler" mit Grund stehen —
// die Entscheidung ist dann NICHT gespeichert, die Firma also weiter offen.
// Der Stand liegt in userData, damit Klicks einen Neustart ueberstehen.

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../core/platform";
import type { GatewayClient } from "../agent/gateway-client";
import type { RadarWarteEintrag, RadarWarteErgebnis, RadarWarteKandidat, RadarWarteStand } from "../../shared/radar-warteschlange-types";
import { decideCandidates, type DecideSummary } from "./decide";

const VERZOEGERUNG_MS = 3_000;

export class RadarImportWarteschlange extends EventEmitter {
  private eintraege = new Map<string, RadarWarteEintrag>();
  private zuletzt: RadarWarteErgebnis | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private laeuft = false;
  private readonly datei: string;

  constructor(
    private readonly deps: {
      gateway: GatewayClient;
      /** Nach jedem Lauf (Audit-Protokoll wie beim bisherigen Bulk-Knopf). */
      nachLauf?: (ergebnis: DecideSummary) => void;
      verzoegerungMs?: number;
      dir?: string;
    },
  ) {
    super();
    this.datei = join(deps.dir ?? paths().get("userData"), "radar-warteschlange.json");
    this.laden();
  }

  stand(): RadarWarteStand {
    return {
      eintraege: [...this.eintraege.values()],
      verzoegerungSek: Math.round((this.deps.verzoegerungMs ?? VERZOEGERUNG_MS) / 1000),
      zuletzt: this.zuletzt,
    };
  }

  hinzufuegen(kandidaten: RadarWarteKandidat[], entscheidung: "imported" | "dismissed"): RadarWarteStand {
    const am = new Date().toISOString();
    for (const k of kandidaten) {
      const alt = this.eintraege.get(k.discoveryId);
      if (alt?.status === "laeuft") continue;
      this.eintraege.set(k.discoveryId, { ...k, entscheidung, status: "wartet", am });
    }
    this.geaendert();
    this.planen();
    return this.stand();
  }

  /** Nur solange der Eintrag noch wartet; danach ist die Entscheidung unterwegs. */
  rueckgaengig(discoveryId: string): RadarWarteStand {
    if (this.eintraege.get(discoveryId)?.status === "wartet") {
      this.eintraege.delete(discoveryId);
      this.geaendert();
    }
    return this.stand();
  }

  /** Gescheiterten Eintrag erneut versuchen, wahlweise als Ignorieren. */
  erneut(discoveryId: string, entscheidung?: "imported" | "dismissed"): RadarWarteStand {
    const e = this.eintraege.get(discoveryId);
    if (e?.status === "fehler") {
      this.eintraege.set(discoveryId, { ...e, entscheidung: entscheidung ?? e.entscheidung, status: "wartet", grund: undefined, am: new Date().toISOString() });
      this.geaendert();
      this.planen();
    }
    return this.stand();
  }

  /** Gescheiterten Eintrag verwerfen: die Firma steht wieder offen in der Liste. */
  verwerfen(discoveryId: string): RadarWarteStand {
    if (this.eintraege.get(discoveryId)?.status === "fehler") {
      this.eintraege.delete(discoveryId);
      this.geaendert();
    }
    return this.stand();
  }

  /** Sofort abschicken (Tests, App-Ende). */
  async jetzt(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.abschicken();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private planen(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.abschicken();
    }, this.deps.verzoegerungMs ?? VERZOEGERUNG_MS);
  }

  private async abschicken(): Promise<void> {
    if (this.laeuft) return;
    const los = [...this.eintraege.values()].filter((e) => e.status === "wartet");
    if (los.length === 0) return;
    this.laeuft = true;
    for (const e of los) e.status = "laeuft";
    this.geaendert();
    try {
      const r = await decideCandidates(
        this.deps.gateway,
        los.map((e) => ({
          discoveryId: e.discoveryId,
          decision: e.entscheidung,
          kandidat: { name: e.name, city: e.city, plz: e.plz ?? null, domain: e.domain ?? null, ...(e.country ? { country: e.country } : {}) },
        })),
      );
      if ("error" in r) {
        for (const e of los) this.fehler(e, r.error);
      } else {
        const ohneOrt = new Set(r.ohneOrtIds);
        const ohneZuordnung = new Set(r.ohneZuordnungIds);
        for (const e of los) {
          if (ohneOrt.has(e.discoveryId)) this.fehler(e, "Kein Ort bekannt, deshalb nicht eindeutig im Register zu finden.");
          else if (ohneZuordnung.has(e.discoveryId)) this.fehler(e, "Keine passende Firma im Register und keine Website, über die AVA sie anlegen kann.");
          else this.eintraege.delete(e.discoveryId);
        }
        this.zuletzt = { am: new Date().toISOString(), importiert: r.importiert, ignoriert: r.ignoriert, transactionId: r.transactionId, hinweise: r.hinweise };
        this.deps.nachLauf?.(r);
      }
    } catch (err) {
      for (const e of los) this.fehler(e, err instanceof Error ? err.message : String(err));
    } finally {
      this.laeuft = false;
      this.geaendert();
      // Waehrend des Laufs neu Angeklicktes hinterher schicken.
      if ([...this.eintraege.values()].some((e) => e.status === "wartet")) this.planen();
    }
  }

  private fehler(e: RadarWarteEintrag, grund: string): void {
    this.eintraege.set(e.discoveryId, { ...e, status: "fehler", grund });
  }

  private geaendert(): void {
    this.speichern();
    this.emit("changed", this.stand());
  }

  private laden(): void {
    try {
      if (!existsSync(this.datei)) return;
      const roh = JSON.parse(readFileSync(this.datei, "utf8")) as { eintraege?: RadarWarteEintrag[] };
      for (const e of roh.eintraege ?? []) {
        if (!e?.discoveryId || !e.name) continue;
        // Abgebrochener Lauf (App beendet): noch einmal schicken. Das Gateway
        // nimmt eine doppelte Entscheidung hin; ein doppelter Import faellt in
        // master-data auf dieselben Firmen.
        this.eintraege.set(e.discoveryId, e.status === "laeuft" ? { ...e, status: "wartet" } : e);
      }
      if ([...this.eintraege.values()].some((e) => e.status === "wartet")) this.planen();
    } catch {
      /* kaputte Datei: leer starten */
    }
  }

  private speichern(): void {
    try {
      writeFileSync(this.datei, JSON.stringify({ eintraege: [...this.eintraege.values()] }), "utf8");
    } catch {
      /* best-effort */
    }
  }
}
