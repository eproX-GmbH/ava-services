#!/usr/bin/env node
//
// v0.1.213 — Setzt `git config core.hooksPath .githooks` für den
// lokalen Clone, damit die in `.githooks/` eingecheckten Hooks aktiv
// werden. Wird per `postinstall` im Root-package.json aufgerufen.
//
// Wir setzen die Config NUR, wenn:
//   1. Der Clone tatsächlich ein Git-Repo ist (.git existiert).
//   2. `core.hooksPath` noch nicht gesetzt ist — wir wollen keine
//      vorhandene Einstellung des Entwicklers überschreiben.
//
// Bei Problemen (z. B. fehlendes git im PATH) loggen wir den Fehler
// und exiten 0, damit `pnpm install` durch geht. Hook-Installation
// ist nice-to-have, kein Blocker.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

if (!existsSync(resolve(REPO_ROOT, ".git"))) {
  // Frische tarball-Installation (z. B. CI mit `--no-frozen-lockfile`
  // ohne Repo-Kontext). Nicht-fatal.
  process.exit(0);
}

const current = git(["config", "--local", "core.hooksPath"]).stdout.trim();
const defaultHooks = resolve(REPO_ROOT, ".git", "hooks");

if (current === ".githooks") {
  // Schon korrekt — silent.
  process.exit(0);
}

// Wir respektieren eine vorhandene Einstellung nur dann, wenn sie
// nicht der Git-Default ist. Manche Setups (Tooling, ältere
// Initialisierungen) schreiben den absoluten `.git/hooks`-Pfad
// explizit in die lokale Config rein — das ist semantisch nichts und
// soll uns nicht blockieren.
if (current && current !== defaultHooks && current !== ".git/hooks") {
  console.log(
    `[install-githooks] core.hooksPath is set to "${current}" — leaving it alone.`,
  );
  console.log(
    `[install-githooks] To enable the AVA hooks: git config core.hooksPath .githooks`,
  );
  process.exit(0);
}

const set = git(["config", "--local", "core.hooksPath", ".githooks"]);
if (set.status !== 0) {
  console.warn(
    `[install-githooks] failed to set core.hooksPath: ${set.stderr.trim()}`,
  );
  process.exit(0); // non-fatal
}
console.log("[install-githooks] core.hooksPath → .githooks (pre-push drift guard active)");
