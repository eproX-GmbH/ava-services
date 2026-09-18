#!/usr/bin/env node
// Pre-flight check for the release CI workflow (Phase 8.u1).
//
// Catches the "I forgot to bump package.json before tagging" mistake
// before electron-builder runs. The workflow passes the tag via the
// AVA_RELEASE_TAG env (or `--tag <value>` for local testing); we
// strip the `v` prefix and assert it equals package.json's `version`
// field. Mismatch = exit 1 + a loud error so the run fails fast
// instead of producing a release labelled with the wrong number.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const pkgVersion = pkg.version;

const cliFlag = process.argv.find((a) => a.startsWith("--tag="));
const tag =
  // AVA_RELEASE_TAG zuerst: Namen mit GITHUB_-Praefix lassen sich in einem
  // Workflow-Schritt nicht setzen, weshalb beim manuellen Start frueher der
  // Branchname ankam. GITHUB_REF_NAME bleibt als Rueckfall fuer den Tag-Push.
  (cliFlag ? cliFlag.split("=")[1] : (process.env.AVA_RELEASE_TAG || process.env.GITHUB_REF_NAME)) ?? "";

if (!tag) {
  console.error(
    "[validate-version-tag] No tag supplied. Pass --tag=v1.2.3 or set AVA_RELEASE_TAG.",
  );
  process.exit(1);
}

const tagVersion = tag.startsWith("v") ? tag.slice(1) : tag;
if (tagVersion !== pkgVersion) {
  console.error(
    `[validate-version-tag] mismatch:\n  Git tag      = ${tag} (parses as ${tagVersion})\n  package.json = ${pkgVersion}\n\nBump package.json's "version" field and re-tag, OR re-tag to match the existing version.`,
  );
  process.exit(1);
}
console.log(
  `[validate-version-tag] OK — tag ${tag} matches package.json version ${pkgVersion}.`,
);
