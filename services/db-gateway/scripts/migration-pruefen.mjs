#!/usr/bin/env node
// Staging (docs/PLAN_STAGING.md §4.2): Das Staging-Gateway wendet Migrationen auf die
// PRODUKTIONS-Datenbank an, während Prod noch den alten Code fährt. Erlaubt sind daher nur
// additive Änderungen („erweitern, dann aufräumen“). Diese Prüfung bricht ab bei DROP, RENAME,
// Typwechsel, SET NOT NULL und großem CREATE INDEX (ohne CONCURRENTLY; OOM 2026-10-07), sofern
// die Zeile nicht ausdrücklich mit `-- staging: bewusst` markiert ist.
//
//   node scripts/migration-pruefen.mjs [--seit <git-ref>]   (Standard: vorheriger Tag)
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
let seit = arg("--seit");
if (!seit) {
  try { seit = git("describe", "--tags", "--abbrev=0", "HEAD^"); } catch { seit = "HEAD~20"; }
}
const neu = git("diff", "--name-only", "--diff-filter=AM", `${seit}..HEAD`, "--", "prisma/migrations").split("\n").filter((f) => f.endsWith(".sql"));
const REGELN = [
  [/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|SCHEMA|CONSTRAINT)\b/i, "löscht etwas (erst aufräumen, wenn kein Code es mehr nutzt)"],
  [/\bRENAME\s+(COLUMN|TO|CONSTRAINT)\b/i, "benennt um (alter Code findet es nicht mehr)"],
  [/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, "ändert einen Spaltentyp"],
  [/\bSET\s+NOT\s+NULL\b/i, "macht eine Spalte Pflicht (alter Code schreibt evtl. NULL)"],
  [/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, "Index auf bestehender Tabelle (sperrt; bei großen Tabellen OOM-Gefahr, 2026-10-07)"],
  [/\bTRUNCATE\b|\bDELETE\s+FROM\b/i, "löscht Daten"],
];
const funde = [];
const wurzel = git("rev-parse", "--show-toplevel");
for (const f of neu) {
  const pfad = existsSync(f) ? f : join(wurzel, f);
  const text = readFileSync(pfad, "utf8");
  // Tabellen, die diese Migration selbst anlegt: Indizes darauf sind unkritisch (leer).
  const neueTabellen = new Set([...text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map((m) => m[1].toLowerCase()));
  // Anweisungen einzeln, Kommentare am Zeilenende bleiben für die Markierung erhalten.
  for (const anw of text.split(";")) {
    if (/--\s*staging:\s*bewusst/i.test(anw)) continue;
    const ohneKommentar = anw.split("\n").map((z) => z.replace(/--.*$/, "")).join("\n");
    const indexAuf = /\bINDEX\b[^;]*?\bON\s+"?(\w+)"?/i.exec(ohneKommentar)?.[1]?.toLowerCase();
    for (const [re, warum] of REGELN) if (re.test(ohneKommentar) && !(warum.startsWith("Index") && indexAuf && neueTabellen.has(indexAuf))) funde.push(`${f}: ${warum}\n    ${ohneKommentar.trim().split("\n")[0].slice(0, 120)}`);
  }
}
if (funde.length) {
  console.error(`Migrationsprüfung (seit ${seit}): ${funde.length} Fund(e). Im Kandidaten nur additive Änderungen, sonst die Zeile mit "-- staging: bewusst" markieren und vor dem Staging-Deploy mit Joyce klären.\n  ` + funde.join("\n  "));
  process.exit(1);
}
console.log(`Migrationsprüfung (seit ${seit}): ${neu.length} neue Migration(en), nur additiv.`);
