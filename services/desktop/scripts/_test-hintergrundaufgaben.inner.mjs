import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import A from "../src/main/aufgaben/aufgaben.ts";
const { HintergrundAufgaben, meldungsText } = A;
const ordner = mkdtempSync(join(tmpdir(), "ava-auf-"));
let zustaende = { tx1: ["in_progress", "pending", "completed"] };
const gateway = {
  request: async (path) => {
    const tx = /transactions\/([^/]+)\/entities/.exec(path)[1];
    const items = (zustaende[tx] ?? []).map((state, i) => ({ companyId: `C${i}`, state, ...(state === "failed" ? { errorMessage: "Website nicht gefunden" } : {}) }));
    return { items, total: items.length };
  },
};
const gemeldet = [];
let belegt = false;
const aufgaben = new HintergrundAufgaben({
  gateway,
  datei: join(ordner, "a.json"),
  melden: (conv, text) => { if (belegt) return false; gemeldet.push({ conv, text }); return true; },
});
const a = aufgaben.registrieren({ conversationId: "conv1", transactionId: "tx1", titel: "Firmen-Import (3 Firmen)", quelle: "import_companies" });
assert.equal(aufgaben.registrieren({ conversationId: "conv1", transactionId: "tx1", titel: "x", quelle: "y" }).id, a.id, "doppelt = gleiche Aufgabe");
await aufgaben.takt();
assert.equal(a.status, "laeuft"); assert.equal(a.stand.fertig, 1); assert.equal(a.stand.total, 3);
assert.equal(gemeldet.length, 0, "laufend = keine Meldung");
// fertig, aber Chat belegt
zustaende.tx1 = ["completed", "failed", "completed"];
belegt = true;
await aufgaben.takt();
assert.equal(a.status, "fertig"); assert.equal(a.gemeldet, false); assert.equal(gemeldet.length, 0, "belegt = spaeter");
belegt = false;
await aufgaben.takt();
assert.equal(a.gemeldet, true); assert.equal(gemeldet.length, 1);
assert.equal(gemeldet[0].conv, "conv1");
assert.match(gemeldet[0].text, /^\[Hintergrundaufgabe abgeschlossen\] Firmen-Import \(3 Firmen\)/);
assert.match(gemeldet[0].text, /abgeschlossen 2, fehlgeschlagen 1/);
assert.match(gemeldet[0].text, /Website nicht gefunden/);
await aufgaben.takt();
assert.equal(gemeldet.length, 1, "nur einmal melden");
// haengt
zustaende.tx2 = ["in_progress"];
const b = aufgaben.registrieren({ conversationId: "conv2", transactionId: "tx2", titel: "CRM-Import", quelle: "x" });
await aufgaben.takt();
b.fortschrittAm = Date.now() - 3 * 60 * 60_000;
await aufgaben.takt();
assert.equal(b.status, "haengt"); assert.match(gemeldet[1].text, /^\[Hintergrundaufgabe haengt\] CRM-Import/);
// sichtbar je Unterhaltung, Persistenz
assert.equal(aufgaben.sichtbar("conv1").length, 1);
assert.ok(existsSync(join(ordner, "a.json")));
const neu = new HintergrundAufgaben({ gateway, datei: join(ordner, "a.json"), melden: () => true });
assert.equal(neu.alle().length, 2, "nach Neustart wieder da");
// Abbrechen
zustaende.tx3 = ["pending"];
const c = aufgaben.registrieren({ conversationId: "conv1", transactionId: "tx3", titel: "Z", quelle: "x" });
assert.equal(aufgaben.abbrechen(c.id), true); assert.equal(c.status, "abgebrochen");
// Anzeige-Text ohne Auftrag
assert.ok(!meldungsText({ ...a }).includes("undefined"));
console.log("Hintergrundaufgaben-Tests ok");
