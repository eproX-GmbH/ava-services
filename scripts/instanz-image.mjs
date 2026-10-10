#!/usr/bin/env node
// Baut das Server-Image einer Version einmal und legt es in der Fly-Registry ab
// (docs/PLAN_AVA_CLOUD.md §14). Alle Kunden-Instanzen werden danach aus diesem
// Image ausgerollt, ohne eigenen Build.
//
//   node scripts/instanz-image.mjs [--version 0.1.797] [--org personal]
//
// NPM_TOKEN (für das Vendoring der Producer) aus der Umgebung oder master-data/.env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { args, appExistiert, desktopVersion, fly, IMAGE_APP, imageRef, REPO } from "./lib/instanz-fly.mjs";

const a = args();
const version = String(a.version || desktopVersion()).replace(/^v/, "");
const org = a.org || "personal";

function npmToken() {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN;
  const env = join(REPO, "master-data/.env");
  if (existsSync(env)) {
    const m = readFileSync(env, "utf8").match(/^NPM_TOKEN=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("NPM_TOKEN fehlt (Umgebung oder master-data/.env).");
}

try {
  if (!appExistiert(IMAGE_APP)) {
    console.log(`Lege die Image-App ${IMAGE_APP} an (hält nur Images, keine Maschinen) …`);
    fly(["apps", "create", IMAGE_APP, "--org", org]);
  }
  console.log(`Baue ${imageRef(version)} …`);
  fly([
    "deploy", REPO,
    "-c", join(REPO, "services/desktop/fly.server.toml"),
    "-a", IMAGE_APP,
    "--build-only", "--push",
    "--image-label", `v${version}`,
    "--build-secret", `npm_token=${npmToken()}`,
  ]);
  console.log(`\nFertig: ${imageRef(version)}\nAusrollen: node scripts/instanzen-aktualisieren.mjs --version ${version}`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
