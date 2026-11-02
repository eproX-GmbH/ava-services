import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../core/platform";

// Urteilsgedaechtnis des Heartbeats (2026-11-02, Befund Patrick: "0 Kandidaten").
//
// Der erste Takt nach einem App-Start fragt das Gateway ohne Zeitgrenze
// (30-Tage-Fenster) und bekommt bei einer groesseren Firmenliste 80+
// Fundstellen. Davon beurteilte der Judge nur maxPerTick (20); der Rest
// ging verloren, weil der naechste Takt nur noch das 15-Minuten-Fenster
// abfragt. Seit diesem Umbau hebt der Heartbeat den Rest als Rueckstand
// auf und arbeitet ihn Takt fuer Takt ab.
//
// Damit nach jedem Neustart nicht dieselben Fundstellen erneut durch den
// Judge laufen (Kosten, und dieselben 20 gewinnen immer die Sortierung),
// merkt sich diese Datei je sourceRef, dass ein Urteil gefallen ist.
// Gemeldete Fundstellen stehen ohnehin in alerts.jsonl (Dedup dort); hier
// landen die uebrigen Ausgaenge: nicht meldenswert, gesammelt.
//
// Ablage: userData/agent/heartbeat-urteile.jsonl, eine Zeile je Urteil.
// Eintraege verfallen nach AUFBEWAHRUNG_TAGE (laenger als das 30-Tage-
// Fenster des Gateways, damit nichts im Fenster zweimal beurteilt wird).

export type UrteilAusgang = "not-worth" | "gesammelt";

interface Zeile {
  sourceRef: string;
  ausgang: UrteilAusgang;
  am: string;
}

const AUFBEWAHRUNG_TAGE = 45;
const DATEINAME = "heartbeat-urteile.jsonl";

export class HeartbeatUrteile {
  readonly path: string;
  private readonly dir: string;
  private cache: Map<string, Zeile> | null = null;
  private schreibbar = true;

  constructor(dir?: string) {
    this.dir = dir ?? join(paths().get("userData"), "agent");
    this.path = join(this.dir, DATEINAME);
  }

  /** Urteil zu dieser Fundstelle schon gefallen (und noch nicht verfallen)? */
  hat(sourceRef: string): boolean {
    return this.laden().has(sourceRef);
  }

  /** Urteil festhalten; ein zweites Urteil zur selben Fundstelle ersetzt das erste. */
  merken(sourceRef: string, ausgang: UrteilAusgang, am: Date = new Date()): void {
    const zeile: Zeile = { sourceRef, ausgang, am: am.toISOString() };
    this.laden().set(sourceRef, zeile);
    if (!this.schreibbar) return;
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path, JSON.stringify(zeile) + "\n", { mode: 0o600 });
    } catch (err) {
      // Ohne Datei laeuft der Heartbeat weiter; das Gedaechtnis gilt dann nur
      // bis zum naechsten Neustart.
      this.schreibbar = false;
      console.warn("[heartbeat-urteile] schreiben fehlgeschlagen:", err instanceof Error ? err.message : err);
    }
  }

  /** Anzahl gemerkter Urteile (Diagnose). */
  anzahl(): number {
    return this.laden().size;
  }

  private laden(): Map<string, Zeile> {
    if (this.cache) return this.cache;
    const map = new Map<string, Zeile>();
    const grenze = Date.now() - AUFBEWAHRUNG_TAGE * 86_400_000;
    let verfallen = 0;
    try {
      if (existsSync(this.path)) {
        for (const roh of readFileSync(this.path, "utf8").split("\n")) {
          const l = roh.trim();
          if (!l) continue;
          try {
            const z = JSON.parse(l) as Partial<Zeile>;
            if (typeof z.sourceRef !== "string" || typeof z.am !== "string") continue;
            if (new Date(z.am).getTime() < grenze) {
              verfallen += 1;
              continue;
            }
            map.set(z.sourceRef, { sourceRef: z.sourceRef, ausgang: z.ausgang === "gesammelt" ? "gesammelt" : "not-worth", am: z.am });
          } catch {
            /* kaputte Zeile ueberspringen */
          }
        }
      }
    } catch (err) {
      console.warn("[heartbeat-urteile] lesen fehlgeschlagen:", err instanceof Error ? err.message : err);
    }
    this.cache = map;
    // Verfallene Zeilen beim Laden ausduennen, damit die Datei nicht waechst.
    if (verfallen > 0) {
      try {
        writeFileSync(this.path, [...map.values()].map((z) => JSON.stringify(z)).join("\n") + (map.size > 0 ? "\n" : ""), { mode: 0o600 });
      } catch {
        /* beim naechsten Laden erneut */
      }
    }
    return map;
  }
}
