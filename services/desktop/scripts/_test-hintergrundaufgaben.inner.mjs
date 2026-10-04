import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import A from "../src/main/aufgaben/aufgaben.ts";
const { HintergrundAufgaben, meldungsText, STILLSTAND_MS } = A;
const ordner = mkdtempSync(join(tmpdir(), "ava-auf-"));
// Fake-Gateway auf Schritt-Ebene
const tx = {};
const abgebrochen = [];
const gateway = {
  request: async (path, opts) => {
    const m = /transactions\/([^/]+)\/(fortschritt|abbrechen)/.exec(path);
    const t = tx[m[1]];
    if (m[2] === "abbrechen") {
      abgebrochen.push({ id: m[1], grund: opts.body.grund });
      t.schritte = t.schritte.map((x) => (x.state === "pending" || x.state === "in_progress" ? { ...x, state: "failed", err: `Abgebrochen: ${opts.body.grund}` } : x));
      t.zuletzt = new Date().toISOString();
      return { abgebrochen: 1 };
    }
    const firmen = [...new Set(t.schritte.map((x) => x.c))];
    const fertig = firmen.filter((c) => t.schritte.filter((x) => x.c === c).every((x) => ["completed", "failed", "skipped"].includes(x.state)));
    const fehler = firmen.filter((c) => t.schritte.some((x) => x.c === c && x.state === "failed"));
    return {
      firmen: firmen.length, firmenFertig: fertig.length, firmenMitFehler: fehler.length,
      schritte: { gesamt: t.schritte.length, offen: t.schritte.filter((x) => ["pending", "in_progress"].includes(x.state)).length, abgeschlossen: 0, fehlgeschlagen: 0, uebersprungen: 0 },
      letztesLebenszeichen: t.zuletzt,
      fehlerBeispiele: t.schritte.filter((x) => x.state === "failed").map((x) => ({ companyId: x.c, producer: x.p, meldung: x.err ?? "Fehler" })),
    };
  },
};
const gemeldet = [];
let belegt = false;
const aufgaben = new HintergrundAufgaben({ gateway, datei: join(ordner, "a.json"), melden: (conv, text) => { if (belegt) return false; gemeldet.push({ conv, text }); return true; } });

// 1) Normaler Lauf mit Uebergang zwischen Schritten
tx.t1 = { zuletzt: new Date().toISOString(), schritte: [{ c: "A", p: "structured-content", state: "in_progress" }, { c: "B", p: "structured-content", state: "completed" }] };
const a = aufgaben.registrieren({ conversationId: "conv1", transactionId: "t1", titel: "Firmen-Import (2 Firmen)", quelle: "import_companies" });
await aufgaben.takt();
assert.equal(a.status, "laeuft"); assert.equal(a.stand.fertig, 1);
// Register fertig, Website noch nicht angelegt: kurz nichts offen, aber frisch → nicht fertig
tx.t1.schritte[0].state = "completed"; tx.t1.zuletzt = new Date().toISOString();
await aufgaben.takt(); await aufgaben.takt();
assert.equal(a.status, "laeuft", "frische Aenderung (<90 s) = Uebergang, nicht fertig");
// Website erscheint und scheitert bei A
tx.t1.schritte.push({ c: "A", p: "website", state: "failed", err: "Keine Unternehmenswebseite gefunden" });
tx.t1.zuletzt = new Date(Date.now() - 120_000).toISOString();
belegt = true;
await aufgaben.takt(); await aufgaben.takt();
assert.equal(a.status, "fertig", "zwei Takte ohne offene Schritte und 90 s Ruhe = fertig");
assert.equal(gemeldet.length, 0, "Chat belegt = spaeter");
belegt = false;
await aufgaben.takt();
assert.equal(gemeldet.length, 1);
assert.match(gemeldet[0].text, /^\[Hintergrundaufgabe abgeschlossen\] Firmen-Import \(2 Firmen\)/);
assert.match(gemeldet[0].text, /ohne Fehler fertig 1, mit Fehler 1/);
assert.match(gemeldet[0].text, /Keine Unternehmenswebseite gefunden/);

// 2) Lebenszeichen verhindern den Abbruch
tx.t2 = { zuletzt: new Date().toISOString(), schritte: [{ c: "C", p: "website", state: "in_progress" }] };
const b = aufgaben.registrieren({ conversationId: "conv2", transactionId: "t2", titel: "Deep Research", quelle: "x" });
await aufgaben.takt();
b.fortschrittAm = Date.now() - STILLSTAND_MS - 60_000; // lange nichts gesehen …
tx.t2.zuletzt = new Date(Date.now() + 5_000).toISOString(); // … aber neues Lebenszeichen (sicher verschieden)
await aufgaben.takt();
assert.equal(b.status, "laeuft", "Lebenszeichen = lebt, kein Abbruch");
assert.equal(abgebrochen.length, 0);

// 3) 60 Minuten gar nichts → Abbruch mit Fehler im Gateway + Meldung
b.fortschrittAm = Date.now() - STILLSTAND_MS - 60_000;
await aufgaben.takt();
assert.equal(b.status, "abgebrochen");
assert.equal(abgebrochen.length, 1); assert.match(abgebrochen[0].grund, /60 Minuten kein Fortschritt/);
assert.equal(tx.t2.schritte[0].state, "failed", "offener Schritt im Gateway auf Fehler");
await aufgaben.takt();
const m2 = gemeldet.find((g) => g.conv === "conv2");
assert.ok(m2, "Abbruch wird gemeldet"); assert.match(m2.text, /^\[Hintergrundaufgabe abgebrochen\] Deep Research/);

// 4) × = nicht mehr verfolgen, kein Abbruch im Gateway
tx.t3 = { zuletzt: new Date().toISOString(), schritte: [{ c: "D", p: "website", state: "pending" }] };
const c = aufgaben.registrieren({ conversationId: "conv1", transactionId: "t3", titel: "Z", quelle: "x" });
assert.equal(aufgaben.abbrechen(c.id), true); assert.equal(c.status, "nicht_verfolgt");
assert.equal(abgebrochen.length, 1);

// 5) Persistenz + Migration alter Zustaende
assert.ok(existsSync(join(ordner, "a.json")));
writeFileSync(join(ordner, "alt.json"), JSON.stringify([{ ...a, id: "x1", status: "haengt" }, { ...a, id: "x2", status: "abgebrochen", stand: null, gemeldet: true }]));
const alt = new HintergrundAufgaben({ gateway, datei: join(ordner, "alt.json"), melden: () => true });
assert.deepEqual(alt.alle().map((x) => x.status), ["abgebrochen", "nicht_verfolgt"]);
assert.ok(!meldungsText(a).includes("undefined"));
console.log("Hintergrundaufgaben-Tests ok");
