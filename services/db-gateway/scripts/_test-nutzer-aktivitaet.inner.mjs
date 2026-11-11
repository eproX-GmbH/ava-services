import assert from "node:assert/strict";
// konto-loeschen laedt die Gateway-Umgebung: Platzhalter, es wird nichts verbunden.
for (const k of ["DATABASE_URL", "UPSTREAM_MASTER_DATA_URL", "UPSTREAM_COMPANY_PROFILE_URL", "UPSTREAM_COMPANY_CONTACT_URL", "UPSTREAM_COMPANY_PUBLICATION_URL", "UPSTREAM_WEBSITE_URL", "UPSTREAM_STRUCTURED_CONTENT_URL", "EVENT_BUS_URL", "JWKS_URI"]) process.env[k] ??= "http://127.0.0.1:9/test";
const A = await import("../src/lib/nutzer-aktivitaet.ts");
const K = await import("../src/lib/konto-loeschen.ts");

// Signale aus der App → Text fuer die Konsole
assert.equal(A.signalText("firma.ansicht"), "Firma angesehen");
assert.equal(A.signalText("firma.verweildauer"), "Firma angesehen");
assert.equal(A.signalText("person.chat"), "Chat zu einer Firma");
assert.equal(A.signalText("firma.import"), "Firma importiert");
assert.equal(A.signalText("person.mail"), "Mail-Entwurf");
assert.equal(A.signalText("etwas.neues"), "In der App");

// MCP-Client aus dem User-Agent
assert.equal(A.mcpClient("Claude-User (claude.ai)"), "MCP (Claude)");
assert.equal(A.mcpClient("openai-mcp/1.0"), "MCP (ChatGPT)");
assert.equal(A.mcpClient("node"), "MCP");
assert.equal(A.mcpClient(null), "MCP");

// Nutzung: hoechstens eine Minute je Nutzer und Minute zaehlen, Art/Zeit immer schreiben
const aufrufe = [];
const pool = { query: async (sql, p) => { aufrufe.push({ sql, p }); return { rows: [] }; } };
A.vermerkeNutzung(pool, { actorId: "u1", tenantId: "t1", art: "Chat (Telegram)" });
A.vermerkeNutzung(pool, { actorId: "u1", tenantId: "t1", art: "MCP (Claude): firma_lesen" });
A.vermerkeNutzung(pool, { actorId: "u2", tenantId: "t1", art: "Firma angesehen", at: new Date(Date.now() + 3_600_000) });
assert.equal(aufrufe.length, 3);
assert.equal(aufrufe[0].p[4], 1, "erste Nutzung der Minute zaehlt");
assert.equal(aufrufe[1].p[4], 0, "zweite Nutzung derselben Minute zaehlt nicht doppelt");
assert.equal(aufrufe[1].p[3], "MCP (Claude): firma_lesen");
assert.ok(aufrufe[2].p[2].getTime() <= Date.now(), "Zeitpunkt aus der Zukunft wird auf jetzt begrenzt");
assert.match(aufrufe[0].sql, /GREATEST/);

// Version aus der Relais-Anmeldung, "?" (unbekannt) wird ignoriert
aufrufe.length = 0;
A.vermerkeAppVersion(pool, { actorId: "u1", version: "?" });
A.vermerkeAppVersion(pool, { actorId: "u1", version: "0.1.930" });
assert.equal(aufrufe.length, 1);
assert.deepEqual(aufrufe[0].p, ["u1", "0.1.930"]);

// Anmeldepruefung unterscheidet Sperre durch das AVA-Team von Loeschung
const statusPool = { query: async () => ({ rows: [{ actorId: "g", art: "gesperrt" }, { actorId: "l", art: "geloescht" }] }) };
K.sperrenNeuLaden();
assert.equal(await K.kontoSperre(statusPool, "g"), "gesperrt");
assert.equal(await K.kontoSperre(statusPool, "l"), "geloescht");
assert.equal(await K.kontoSperre(statusPool, "x"), null);
assert.equal(await K.istGeloescht(statusPool, "g"), true);

console.log("Nutzer-Aktivitaet-Tests ok");
