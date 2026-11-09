// Loesungskarten (docs/PLAN_LOESUNGSKARTEN.md, L3/L8): alle Karten lesen und den
// Pruefsatz gegen den echten Index laufen lassen. Treffer = erwartete id unter
// den ersten drei. Mit --vektoren zusaetzlich mit den beigelegten Kartenvektoren
// (vektoren.json) und lokal eingebetteter Frage (Ollama, embeddinggemma). Veraltete
// oder fehlende Kartenvektoren sind immer ein Fehler → scripts/wissen-vektoren.mts.
// Aufruf in services/desktop: ../../node_modules/.bin/tsx scripts/test-wissen.mts [--vektoren]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as F0 from "../src/main/wissen/format.ts";
import * as S0 from "../src/main/wissen/suche.ts";
import * as V0 from "../src/main/wissen/vektoren-datei.ts";

const F = ((F0 as any).kartenLesen ? F0 : (F0 as any).default) as typeof import("../src/main/wissen/format.ts");
const S = ((S0 as any).WissensIndex ? S0 : (S0 as any).default) as typeof import("../src/main/wissen/suche.ts");
const V = ((V0 as any).vektorenAusDatei ? V0 : (V0 as any).default) as typeof import("../src/main/wissen/vektoren-datei.ts");

// --basis <dir>: anderes Verzeichnis mit karten/ und pruefsatz.json (z. B. Stand einer anderen Session).
const bi = process.argv.indexOf("--basis");
const basis = bi > 0 && process.argv[bi + 1] ? process.argv[bi + 1]!.replace(/\/?$/, "/") : new URL("../src/main/wissen/", import.meta.url).pathname;
const satzDatei = process.argv.includes("--satz") ? process.argv[process.argv.indexOf("--satz") + 1]! : "pruefsatz.json";
const kartenDir = join(basis, "karten");
const dateien: Array<{ pfad: string; text: string }> = [];
const lauf = (d: string): void => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) lauf(p);
    else if (n.endsWith(".md") && n !== "README.md") dateien.push({ pfad: relative(basis, p), text: readFileSync(p, "utf8") });
  }
};
lauf(kartenDir);

const { karten, fehler } = F.kartenLesen(dateien);
for (const f of fehler) console.log(`FEHLER ${f}`);

const mitVektoren = process.argv.includes("--vektoren");
const einbetten = mitVektoren
  ? async (texte: string[]) => {
      const r = await fetch("http://127.0.0.1:11434/api/embed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: V.VEKTOR_MODELL, input: texte }) });
      if (!r.ok) return null;
      return ((await r.json()) as { embeddings?: number[][] }).embeddings ?? null;
    }
  : undefined;
let vektorDatei: import("../src/main/wissen/vektoren-datei.ts").VektorDatei | null = null;
try {
  vektorDatei = JSON.parse(readFileSync(join(basis, "vektoren.json"), "utf8"));
} catch {
  /* fehlt → unten als Fehler */
}
const index = new S.WissensIndex(karten, einbetten, V.vektorenAusDatei(vektorDatei));
const ohneVektor = index.ohneVektor;
if (ohneVektor.length) console.log(`FEHLER ${ohneVektor.length} Karten ohne aktuellen Vektor (${ohneVektor.slice(0, 8).join(", ")}${ohneVektor.length > 8 ? " …" : ""}) → scripts/wissen-vektoren.mts laufen lassen`);

const satz = JSON.parse(readFileSync(join(basis, satzDatei), "utf8")) as Array<{ frage: string; erwartet: string | string[] }>;
const ids = new Set(karten.map((k) => k.id));
let treffer = 0;
for (const p of satz) {
  const erwartet = Array.isArray(p.erwartet) ? p.erwartet : [p.erwartet];
  for (const e of erwartet) if (!ids.has(e)) console.log(`FEHLER Prüfsatz nennt unbekannte Karte "${e}" (${p.frage})`);
  const top = await index.suchen(p.frage, { limit: 3 });
  const ok = top.some((t) => erwartet.includes(t.karte.id));
  if (ok) treffer++;
  else console.log(`DANEBEN "${p.frage}" → erwartet ${erwartet.join("|")}, bekommen ${top.map((t) => t.karte.id).join(", ") || "nichts"}`);
}
const quote = satz.length ? treffer / satz.length : 1;
console.log(`${karten.length} Karten, ${fehler.length} kaputt; Prüfsatz ${treffer}/${satz.length} (${Math.round(quote * 100)} %)${mitVektoren ? " mit Vektoren" : " nur Volltext"}`);
if (fehler.length > 0 || ohneVektor.length > 0 || quote < 0.9) process.exit(1);
