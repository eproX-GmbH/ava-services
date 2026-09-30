import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import S from "../src/main/agent/attachment-store.ts";
import D from "../src/main/agent/tools/dateien.ts";
const { AttachmentStore } = S; const { buildDateiTools } = D;
const ordner = mkdtempSync(join(tmpdir(), "ava-anh-"));
const store = new AttachmentStore(ordner);
const bytes = new TextEncoder().encode("hallo");
const a = store.stage({ filename: "Rechnung-2026-001.pdf", bytes, sheets: [], conversationId: "c1", seiten: ["Seite eins mit Rechnungsnummer 2026-001", "Seite zwei Betrag 1.200 EUR", "Seite drei"] });
const b = store.stage({ filename: "Rechnung-2026-002.pdf", bytes, sheets: [], conversationId: "c1", seiten: ["andere"] });
store.stage({ filename: "foto.png", bytes, sheets: [], conversationId: "c1" });
store.stage({ filename: "fremd.pdf", bytes, sheets: [], conversationId: "c2", seiten: ["x"] });
assert.equal(a.typ, "pdf"); assert.equal(a.mimeType, "application/pdf"); assert.match(a.kurzansicht, /^Seite eins/);
// D3 Aufloesen
assert.equal(store.aufloesen("c1", a.id).datei.id, a.id);
assert.equal(store.aufloesen("c1", "rechnung-2026-002.pdf").datei.id, b.id, "exakter Name, Gross/klein egal");
assert.equal(store.aufloesen("c1", "002").datei.id, b.id, "eindeutiger Namensteil");
const mehrdeutig = store.aufloesen("c1", "Rechnung"); assert.ok("fehler" in mehrdeutig && mehrdeutig.kandidaten.length === 2);
const fremd = store.aufloesen("c1", "fremd"); assert.ok("fehler" in fremd, "andere Unterhaltung unsichtbar");
assert.equal(store.listeFuer("c1").length, 3);
// Platte: neuer Store liest zurueck
const store2 = new AttachmentStore(ordner);
assert.equal(store2.size(), 4); assert.equal(store2.get(a.id).seiten.length, 3); assert.equal(new TextDecoder().decode(store2.get(a.id).bytes), "hallo");
store2.discard(a.id); assert.equal(new AttachmentStore(ordner).size(), 3);
// D2 Werkzeuge
const tools = Object.fromEntries(buildDateiTools({ attachments: store }).map((t) => [t.name, t]));
const ctx = { signal: new AbortController().signal, log() {}, ui: {}, conversationId: "c1" };
const liste = await tools.datei_info.run({}, ctx); assert.equal(liste.anzahl, 3);
const inf = await tools.datei_info.run({ datei: "001" }, ctx); assert.equal(inf.seiten, 3); assert.equal(inf.typ, "pdf");
const s1 = await tools.datei_suchen.run({ datei: "001", begriff: "betrag" }, ctx); assert.equal(s1.anzahlGesamt, 1); assert.equal(s1.treffer[0].seite, 2);
const l1 = await tools.datei_lesen.run({ datei: "001", seiten: "2-3" }, ctx); assert.match(l1.text, /Seite 2 ---\nSeite zwei/); assert.equal(l1.weiter, "Ende der Datei.");
const l2 = await tools.datei_lesen.run({ datei: "001", von: 0, bis: 5 }, ctx); assert.equal(l2.text, "Seite"); assert.match(l2.weiter, /von: 5/);
const bild = await tools.datei_lesen.run({ datei: "foto.png" }, ctx); assert.match(bild.error, /keinen lesbaren Text/);
const nix = await tools.datei_info.run({ datei: "gibtsnicht" }, ctx); assert.match(nix.error, /Keine Datei/);
console.log("Dateien-Tests ok");
