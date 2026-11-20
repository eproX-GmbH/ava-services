// ChatGPT-Plugin-ZIP bauen (docs/PLAN_CHATGPT_PLUGIN.md, C4): prueft Manifest-Grenzen,
// Schnappschuss-Test und erreichbare Adressen, packt plugin.json, mcp.json, assets/, skills/
// nach dist/ava-chatgpt-plugin-<version>.zip. EINREICHUNG.md und der Schnappschuss bleiben draussen.
import { readFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const quelle = join(root, "plugin-chatgpt");
const fehler = [];
const warnung = [];

const plugin = JSON.parse(readFileSync(join(quelle, "plugin.json"), "utf8"));
const mcp = JSON.parse(readFileSync(join(quelle, "mcp.json"), "utf8"));
const oa = plugin.extensions?.["com.openai"] ?? {};
const ui = oa.interface ?? {};

if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? "")) fehler.push("version ist keine semantische Version");
if ((ui.displayName ?? "").length > 30) fehler.push("displayName > 30 Zeichen");
if ((ui.shortDescription ?? "").length > 30) fehler.push("shortDescription > 30 Zeichen");
if ((ui.longDescription ?? "").length > 4000) fehler.push("longDescription > 4000 Zeichen");
if ((ui.developerName ?? "").length > 80) fehler.push("developerName > 80 Zeichen");
for (const k of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
  if (!/^https:\/\//.test(ui[k] ?? "")) fehler.push(`${k} fehlt oder ist nicht HTTPS`);
}
const server = Object.values(mcp.mcpServers ?? {});
if (server.length !== 1) fehler.push("mcp.json braucht genau einen Server");
if (server[0] && !/^https:\/\/mcp\.ava\.bi\//.test(server[0].url ?? "")) fehler.push("Server-Adresse muss auf mcp.ava.bi bleiben (Ursprung darf sich nie aendern)");
if (server[0]?.headers && Object.keys(server[0].headers).length) fehler.push("Server-Header sind bei der Einreichung verboten");
for (const k of ["logo", "composerIcon"]) {
  const p = join(quelle, ui[k] ?? "-");
  if (!existsSync(p)) fehler.push(`${k} fehlt`);
  else if (statSync(p).size > 5 * 1024 * 1024) fehler.push(`${k} > 5 MiB`);
}
for (const d of readdirSync(join(quelle, "skills"))) {
  const s = readFileSync(join(quelle, "skills", d, "SKILL.md"), "utf8");
  if (!/^---\nname: [a-z0-9-]+\ndescription: .+\n---/m.test(s)) fehler.push(`skills/${d}/SKILL.md: Kopf mit name und description fehlt`);
}

// Adressen erreichbar (Weiterleitungen folgen)?
const adressen = [ui.websiteURL, ui.supportURL, ui.privacyPolicyURL, ui.termsOfServiceURL, oa.review?.demo_recording_url].filter(Boolean);
for (const u of adressen) {
  try {
    const r = await fetch(u, { method: "GET", redirect: "follow" });
    if (!r.ok) (u === oa.review?.demo_recording_url ? warnung : fehler).push(`${u} antwortet ${r.status}`);
  } catch (e) {
    warnung.push(`${u} nicht erreichbar (${e.message})`);
  }
}

const test = spawnSync(process.execPath, [join(root, "scripts", "test-mcp-plugin.mjs")], { cwd: root, encoding: "utf8" });
if (test.status !== 0) fehler.push("Schnappschuss-/Plugin-Test rot (npm run test:mcp-plugin)");

for (const w of warnung) console.log(`  Warnung: ${w}`);
if (fehler.length) {
  for (const f of fehler) console.log(`  FEHLER:  ${f}`);
  process.exit(1);
}

const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const ziel = join(dist, `ava-chatgpt-plugin-${plugin.version}.zip`);
rmSync(ziel, { force: true });
const z = spawnSync("zip", ["-r", "-X", ziel, "plugin.json", "mcp.json", "assets", "skills", "-x", "*.DS_Store"], { cwd: quelle, encoding: "utf8" });
if (z.status !== 0) {
  console.log(z.stderr || z.stdout);
  process.exit(1);
}
console.log(`  ZIP: ${ziel}`);
