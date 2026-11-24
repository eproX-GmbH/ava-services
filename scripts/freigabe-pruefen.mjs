#!/usr/bin/env node
// Schutz vor dem Zurückdrehen bei der Freigabe (docs/PLAN_STAGING.md, Vorfall 2026-11-23).
//
// `freigabe.yml` baut das Prod-Gateway aus dem Tag der freigegebenen Version. Läuft Prod schon
// mit neuerem Gateway-Code als dieser Tag (Direkt-Deploy von main, oder eine ältere Version wird
// nach einer neueren freigegeben), nähme die Freigabe ihn still zurück. Dieses Skript bricht
// dann ab, bevor irgendetwas ausgeliefert wird.
//
//   node scripts/freigabe-pruefen.mjs --tag v0.1.978 [--prod <commit>] [--erzwingen]
//
//   --prod       Commit, aus dem Prod gebaut ist (GET /health → commit). Fehlt er oder kennt das
//                Repo ihn nicht, gilt der strengere Vergleich mit origin/main: Der Tag muss dann
//                alle Gateway-Änderungen von main enthalten (Direkt-Deploys kommen von main).
//   --erzwingen  nur warnen (bewusstes Zurückgehen auf einen älteren Stand, von Hand).
//
// Geprüft wird nur services/db-gateway: Das ist der Build-Ordner des Fly-Deploys.
// Braucht die volle Historie mit Tags (actions/checkout fetch-depth: 0).
import { execFileSync } from "node:child_process";

const ORDNER = "services/db-gateway";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? "");
}
const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gibtEs = (ref) => { try { git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`); return true; } catch { return false; } };

const tag = arg("tag") ?? "";
const prod = (arg("prod") ?? "").trim();
const erzwingen = process.argv.includes("--erzwingen");

if (!/^v\d+\.\d+\.\d+$/.test(tag)) { console.error(`::error::--tag erwartet eine Version wie v0.1.978, bekommen: „${tag}“`); process.exit(2); }
if (!gibtEs(`refs/tags/${tag}`)) { console.error(`::error::Den Tag ${tag} gibt es nicht.`); process.exit(2); }

const hauptzweig = gibtEs("origin/main") ? "origin/main" : "main";
const prodBekannt = /^[0-9a-f]{7,40}$/i.test(prod) && gibtEs(prod);
const basis = prodBekannt ? prod : hauptzweig;
const woher = prodBekannt
  ? `Prod läuft mit ${git("rev-parse", "--short", prod)}`
  : `Prod-Stand ${prod ? `„${prod}“ ist im Repo unbekannt` : "unbekannt"}, verglichen mit ${hauptzweig}`;

// Commits, die in der Basis liegen, aber nicht im Tag, und das Gateway anfassen.
const fehlend = git("log", "--format=%h %s", `refs/tags/${tag}..${basis}`, "--", ORDNER).split("\n").filter(Boolean);

if (fehlend.length === 0) {
  console.log(`Freigabe ${tag}: in Ordnung (${woher}; der Tag enthält allen Gateway-Code davon).`);
  process.exit(0);
}

const liste = fehlend.map((z) => `  ${z}`).join("\n");
const text = `${tag} enthält ${fehlend.length} Gateway-Änderung(en) nicht, die ${prodBekannt ? "auf Prod schon laufen" : `in ${hauptzweig} liegen`} (${woher}). Die Freigabe nähme sie zurück.`;
if (erzwingen) {
  console.log(`::warning::${text} Erzwungen, es geht trotzdem weiter.`);
  console.log(liste);
  process.exit(0);
}
console.error(`::error::${text} Neuen Kandidaten taggen und den freigeben.`);
console.error(liste);
process.exit(1);
