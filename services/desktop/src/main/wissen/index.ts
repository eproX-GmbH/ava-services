// Loesungskarten (docs/PLAN_LOESUNGSKARTEN.md, L3): Karten aus karten/**/*.md
// werden beim Bauen ins Hauptbuendel gebacken (Vite-Glob) und beim ersten
// Zugriff gelesen. Kaputte Karten landen im Protokoll, nicht beim Nutzer.

import { kartenLesen, type Karte } from "./format";
import { WissensIndex, type Einbetter } from "./suche";
import { vektorenAusDatei, type VektorDatei } from "./vektoren-datei";
import VEKTOREN from "./vektoren.json";

const DATEIEN = import.meta.glob(["./karten/**/*.md", "!./karten/README.md"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

let index: WissensIndex | null = null;

export function wissensIndex(einbetten?: Einbetter): WissensIndex {
  if (index) return index;
  const { karten, fehler } = kartenLesen(Object.entries(DATEIEN).map(([pfad, text]) => ({ pfad, text })));
  for (const f of fehler) console.warn(`[wissen] Karte übersprungen: ${f}`);
  console.info(`[wissen] ${karten.length} Lösungskarten geladen`);
  index = new WissensIndex(karten, einbetten, vektorenAusDatei(VEKTOREN as VektorDatei));
  const ohne = index.ohneVektor;
  if (ohne.length) console.warn(`[wissen] ${ohne.length} Karten ohne beigelegten Vektor (nur Volltext): ${ohne.slice(0, 10).join(", ")}`);
  return index;
}

export type { Karte };
export { WissensIndex };
