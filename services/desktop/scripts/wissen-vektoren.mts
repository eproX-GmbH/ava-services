// Loesungskarten: Kartenvektoren VORBERECHNEN und als src/main/wissen/vektoren.json
// in die App legen. Pflicht nach jeder Kartenaenderung (test-wissen meldet
// veraltete Vektoren als Fehler). Rechnet mit demselben Modell wie die App:
// embeddinggemma:latest, Manifest-Digest aus vektoren-datei.ts; ein anderer
// Stand wird abgelehnt. Am besten ueber AVAs eigenes Ollama (ollama-managed).
// Aufruf in services/desktop:
//   ../../node_modules/.bin/tsx scripts/wissen-vektoren.mts [--ollama http://127.0.0.1:11434]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as F0 from "../src/main/wissen/format.ts";
import * as S0 from "../src/main/wissen/suche.ts";
import * as V0 from "../src/main/wissen/vektoren-datei.ts";

const F = ((F0 as any).kartenLesen ? F0 : (F0 as any).default) as typeof import("../src/main/wissen/format.ts");
const S = ((S0 as any).vektorText ? S0 : (S0 as any).default) as typeof import("../src/main/wissen/suche.ts");
const V = ((V0 as any).vektorKodieren ? V0 : (V0 as any).default) as typeof import("../src/main/wissen/vektoren-datei.ts");

const oi = process.argv.indexOf("--ollama");
const ollama = (oi > 0 ? process.argv[oi + 1]! : "http://127.0.0.1:11434").replace(/\/$/, "");
const basis = new URL("../src/main/wissen/", import.meta.url).pathname;
const ziel = join(basis, "vektoren.json");

const tags = (await (await fetch(`${ollama}/api/tags`)).json()) as { models: Array<{ name: string; digest: string }> };
const m = tags.models.find((x) => x.name === V.VEKTOR_MODELL);
if (!m) throw new Error(`${V.VEKTOR_MODELL} fehlt in ${ollama}`);
if (m.digest !== V.VEKTOR_MODELL_DIGEST) throw new Error(`${V.VEKTOR_MODELL} hat Digest ${m.digest}, die App rechnet mit ${V.VEKTOR_MODELL_DIGEST}`);
const version = ((await (await fetch(`${ollama}/api/version`)).json()) as { version: string }).version;

const dateien: Array<{ pfad: string; text: string }> = [];
const lauf = (d: string): void => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) lauf(p);
    else if (n.endsWith(".md") && n !== "README.md") dateien.push({ pfad: relative(basis, p), text: readFileSync(p, "utf8") });
  }
};
lauf(join(basis, "karten"));
const { karten, fehler } = F.kartenLesen(dateien);
if (fehler.length) throw new Error(`kaputte Karten: ${fehler.join("; ")}`);

let alt: import("../src/main/wissen/vektoren-datei.ts").VektorDatei | null = null;
try {
  alt = JSON.parse(readFileSync(ziel, "utf8"));
} catch {
  /* erste Erzeugung */
}
const altGueltig = alt && alt.modell === V.VEKTOR_MODELL && alt.digest === V.VEKTOR_MODELL_DIGEST ? alt.karten : {};

const out: Record<string, { hash: string; v: string }> = {};
const offen = karten.filter((k) => {
  const h = S.vektorHash(k);
  const a = altGueltig[k.id];
  if (a && a.hash === h) out[k.id] = a;
  return !(a && a.hash === h);
});
let dim = alt?.dim ?? 0;
for (let i = 0; i < offen.length; i += 32) {
  const teil = offen.slice(i, i + 32);
  const r = await fetch(`${ollama}/api/embed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: V.VEKTOR_MODELL, input: teil.map((k) => S.vektorText(k)) }) });
  if (!r.ok) throw new Error(`Ollama embed ${r.status}: ${await r.text()}`);
  const e = ((await r.json()) as { embeddings: number[][] }).embeddings;
  teil.forEach((k, j) => {
    dim = e[j]!.length;
    out[k.id] = { hash: S.vektorHash(k), v: V.vektorKodieren(e[j]!) };
  });
}
const sortiert = Object.fromEntries(Object.keys(out).sort().map((id) => [id, out[id]!]));
const datei = { modell: V.VEKTOR_MODELL, digest: V.VEKTOR_MODELL_DIGEST, ollama: version, dim, karten: sortiert };
writeFileSync(ziel, JSON.stringify(datei, null, 1) + "\n");
console.log(`${karten.length} Karten, ${offen.length} neu eingebettet, ${karten.length - offen.length} unverändert (Ollama ${version}, ${V.VEKTOR_MODELL})`);
