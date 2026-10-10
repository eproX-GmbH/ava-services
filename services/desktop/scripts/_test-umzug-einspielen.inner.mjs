// Umzug-Test, Teil B (Ziel, anderer Schlüssel): Paket einlesen, einspielen, prüfen.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const load = async (p) => { const m = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const { credentials, paths } = await load("../src/core/platform.ts");
const { PaketLeser } = await load("../src/core/umzug/paket.ts");
const { eintragSchreiben, wendeUmzugAn } = await load("../src/core/umzug/umzug.ts");
const { PGlite } = await import("@electric-sql/pglite");

const failures = [];
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) failures.push(m); };
const d = paths().get("userData");
const w = (rel, inhalt) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), inhalt); };
// Bestehender Stand des Ziels
w("instanz.json", JSON.stringify({ id: "ziel-instanz-id", name: "Ziel", mcp: true }));
w("telegram/bot-token.enc", credentials().encryptString("222:ziel"));
w("agent/openai-subscription.enc", credentials().encryptString("abo-des-ziels"));
w("agent/alt-nur-ziel.json", "{}");
w("auth.bin", credentials().encryptString("refresh-des-ziels"));

const umzugId = "test-umzug";
const staging = join(d, ".umzug-eingang", umzugId);
mkdirSync(join(staging, "dateien"), { recursive: true });
const datenbanken = [];
const leser = new PaketLeser((k, i) => eintragSchreiben(staging, k, i, datenbanken));
const paket = readFileSync(process.env.UMZUG_PAKET);
for (let o = 0; o < paket.length; o += 777) leser.schreibe(paket.subarray(o, o + 777)); // krumme Teile
ok(leser.restlos(), "Paket vollständig gelesen");
writeFileSync(join(staging, "manifest.json"), JSON.stringify({ umzugId, von: "Quelle", datenbanken }));
writeFileSync(join(d, ".umzug-eingang", "bereit.json"), JSON.stringify({ umzugId }));
await wendeUmzugAn(() => {});

const lies = (rel) => readFileSync(join(d, rel));
ok(JSON.parse(lies("agent/icp.json")).beschreibung === "Mittelstand OWL", "ICP übernommen");
ok(existsSync(join(d, "agent/memory/c1.jsonl")), "Gedächtnis übernommen");
ok(existsSync(join(d, "workflows/wf_1.json")), "Workflow übernommen");
ok(credentials().decryptString(lies("agent/openai.enc")) === "sk-test-quelle", "API-Schlüssel mit Ziel-Schlüssel neu verschlüsselt");
const crm = JSON.parse(lies("crm/hubspot.json"));
ok(credentials().decryptString(Buffer.from(crm.encryptedTokens, "base64")) === '{"access":"tok"}', "JSON-Geheimnis (CRM-Token) neu verschlüsselt");
ok(JSON.parse(lies("instanz.json")).id === "ziel-instanz-id", "Instanz-ID des Ziels bleibt");
ok(credentials().decryptString(lies("telegram/bot-token.enc")) === "222:ziel", "Telegram-Bot des Ziels bleibt");
ok(credentials().decryptString(lies("auth.bin")) === "refresh-des-ziels", "Anmeldung des Ziels bleibt");
ok(credentials().decryptString(lies("agent/openai-subscription.enc")) === "abo-des-ziels", "ChatGPT-Abo des Ziels bleibt, das der Quelle zieht nicht mit");
ok(!existsSync(join(d, "agent/alt-nur-ziel.json")), "alter Stand des Ziels ersetzt");
ok(!existsSync(join(d, "Cache")), "Browser-Cache zieht nicht mit");
ok(existsSync(join(d, "umzug-letzter.json")), "Umzug protokolliert");
const db = new PGlite(join(d, "pglite", "mail"));
const r = await db.query("select betreff from m where id = 1");
await db.close();
ok(r.rows[0]?.betreff === "Hallo aus der Quelle", "Datenbank aus Abzug eingespielt");
if (failures.length) { console.log(`\n${failures.length} Fehler`); process.exit(1); }
console.log("\nUmzug: alle Prüfungen bestanden");
