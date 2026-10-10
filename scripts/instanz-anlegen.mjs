#!/usr/bin/env node
// Neue AVA-Server-Instanz für einen Kunden (docs/PLAN_AVA_CLOUD.md §14).
//
//   node scripts/instanz-anlegen.mjs --name zimmer-gmbh --konto person@zimmer.de
//        [--ollama eigen|geteilt]  (Standard eigen: eigener Embeddings-Sidecar)
//        [--groesse 4gb|8gb] [--volume 10] [--region fra] [--org personal]
//        [--version 0.1.797]       (Standard: Version in services/desktop/package.json)
//
// Ergebnis: App ava-i-<name> (+ ava-i-<name>-ollama), erreichbar unter
// https://<name>.ava.bi über den Router, gebunden an das Konto. Setup-Adresse und
// Schlüssel stehen danach in ~/.ava-instanzen/<name>.json (nur lokal, 0600).
// Voraussetzungen: Image der Version (scripts/instanz-image.mjs), Router mit
// Wildcard-Zertifikat (infra/fly-router), AVA-Konto des Kunden existiert.

import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  adresse, appExistiert, appName, args, desktopVersion, DOMAIN, fly, GETEILTES_OLLAMA, imageRef,
  instanzToml, notizLesen, notizSchreiben, ollamaApp, ollamaToml, secretsSetzen, slugPruefen, tempToml,
} from "./lib/instanz-fly.mjs";

const a = args();
try {
  const slug = slugPruefen(String(a.name || ""));
  const konto = String(a.konto || "").trim().toLowerCase();
  if (!konto) throw new Error("--konto fehlt (E-Mail des AVA-Kontos, dem die Instanz gehört).");
  const ollama = a.ollama === "geteilt" ? "geteilt" : "eigen";
  if (a.ollama && !["eigen", "geteilt"].includes(a.ollama)) throw new Error("--ollama ist eigen oder geteilt.");
  const groesse = String(a.groesse || "4gb");
  if (!["4gb", "8gb"].includes(groesse)) throw new Error("--groesse ist 4gb oder 8gb.");
  const region = String(a.region || "fra");
  const org = String(a.org || "personal");
  const volumeGb = Number(a.volume || 10);
  const version = String(a.version || desktopVersion()).replace(/^v/, "");
  const app = appName(slug);

  const alt = notizLesen(slug);
  if (appExistiert(app) && !a.fortsetzen) {
    throw new Error(`${app} gibt es schon. Aktualisieren: scripts/instanzen-aktualisieren.mjs --nur ${slug}; abgebrochene Anlage fortsetzen: --fortsetzen.`);
  }

  console.log(`\nAVA-Instanz ${slug}.${DOMAIN}\n  App ${app} (${groesse}, ${region}, Org ${org}), Image ${imageRef(version)}\n  Konto ${konto}\n  Embeddings: ${ollama === "eigen" ? ollamaApp(slug) : `${GETEILTES_OLLAMA} (geteilt)`}\n`);

  // 1. Embeddings-Sidecar
  let ollamaHost = `${GETEILTES_OLLAMA}.internal`;
  if (ollama === "eigen") {
    const oa = ollamaApp(slug);
    ollamaHost = `${oa}.internal`;
    if (!appExistiert(oa)) fly(["apps", "create", oa, "--org", org]);
    const t = tempToml(ollamaToml({ app: oa, region }));
    console.log(`→ ${oa} ausrollen …`);
    fly(["deploy", dirname(t), "-c", t, "-a", oa, "--ha=false", "--now", "--yes"]);
  }

  // 2. Kopf-App und Secrets (bei --fortsetzen bleiben Schlüssel und Setup-Token der ersten Anlage)
  if (!appExistiert(app)) fly(["apps", "create", app, "--org", org]);
  const secretsKey = alt?.secretsKey ?? randomBytes(32).toString("hex");
  const setupToken = alt?.setupToken ?? randomBytes(18).toString("base64url");
  secretsSetzen(app, {
    AVA_SECRETS_KEY: secretsKey,
    AVA_SETUP_TOKEN: setupToken,
    AVA_KONTO: konto,
    AVA_INSTANZ_NAME: `${slug}.${DOMAIN}`,
    AVA_PUBLIC_URL: adresse(slug),
  });

  // 3. Ausrollen aus dem fertigen Image
  const t = tempToml(instanzToml({ app, region, ollamaHost, speicher: groesse, cpus: groesse === "8gb" ? 4 : 2, volumeGb }));
  console.log(`→ ${app} ausrollen …`);
  try {
    fly(["deploy", dirname(t), "-c", t, "-a", app, "--image", imageRef(version), "--ha=false", "--now", "--yes"]);
  } catch (err) {
    throw new Error(`${err.message}\n  Gibt es das Image schon? node scripts/instanz-image.mjs --version ${version}\n  Danach: node scripts/instanz-anlegen.mjs --name ${slug} --konto ${konto} --fortsetzen`);
  }

  const setupUrl = `${adresse(slug)}/setup?t=${setupToken}`;
  const notiz = notizSchreiben(slug, {
    slug, app, konto, ollama: ollama === "eigen" ? ollamaApp(slug) : GETEILTES_OLLAMA, groesse, region, org, version,
    adresse: adresse(slug), setupToken, setupUrl,
    // Ohne diesen Schlüssel sind die Geheimnisse im Volume nach einer Wiederherstellung in eine neue App nicht lesbar.
    secretsKey,
    angelegt: alt?.angelegt ?? new Date().toISOString(),
  });

  console.log(`\n✓ ${slug}.${DOMAIN} läuft.
  Setup (an den Kunden, nur dieses Konto kann sich anmelden: ${konto}):
    ${setupUrl}
  Ersatzadresse ohne Router: https://${app}.fly.dev/setup?t=…
  Notiz mit Schlüssel: ${notiz}
  Kunde danach: Anmeldung bestätigen, Schlüssel oder ChatGPT-Abo, optional Telegram-Bot; MCP über https://mcp.${DOMAIN}.`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
