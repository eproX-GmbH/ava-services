// App-Kanal gegen einen nachgebauten Orchestrator: Abo, Senden, Warteschlange,
// Abbrechen, Gesprächsansicht, Teil-Upload; dazu die echte Anhang-Aufbereitung.
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const load = async (p) => {
  const m = await import(p);
  return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m;
};
const { AppKanal } = await load("../src/core/relais/app-kanal.ts");
const { AttachmentStore } = await load("../src/main/agent/attachment-store.ts");
const { anhangAufbereiten } = await load("../src/main/app/anhang.ts");
const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));

let fehler = 0;
const ok = (b, t) => { console.log(`${b ? "✓" : "✗"} ${t}`); if (!b) fehler++; };

class FakeAgent extends EventEmitter {
  constructor() { super(); this.inFlight = null; this.conv = null; this.gesendet = []; this.antworten = []; this.abgebrochen = []; }
  getStatus() { return { ready: true, model: "m", ollamaHost: null, inFlightRequestId: this.inFlight, inFlightConversationId: this.conv, errorMessage: null }; }
  send(input) { if (this.inFlight) throw new Error("Another request is already in flight."); this.inFlight = `r${this.gesendet.length + 1}`; this.conv = input.conversationId; this.gesendet.push(input); this.emit("status", this.getStatus()); return { requestId: this.inFlight }; }
  fertig() { this.inFlight = null; this.conv = null; this.emit("status", this.getStatus()); }
  abort(id) { this.abgebrochen.push(id); }
  answerChoice(c, v) { this.antworten.push([c, v]); }
  getPendingPrompts() { return []; }
}
const agent = new FakeAgent();
const frames = [];
let uploadBytes = null;
const kanal = new AppKanal({
  agent,
  gespraeche: {
    list: () => [{ conversationId: "c1", modifiedAt: 0, label: "Test" }],
    load: () => [
      { id: "1", role: "user", content: "Hallo", createdAt: 0, images: [{ base64: "AAAA", mimeType: "image/png", filename: "x.png" }] },
      { id: "2", role: "assistant", content: "", createdAt: 1, toolCalls: [{ id: "t", name: "company_search", args: {} }] },
      { id: "3", role: "tool", content: "riesig", createdAt: 2 },
      { id: "4", role: "assistant", content: "Antwort", createdAt: 3 },
    ],
    delete: () => true,
  },
  senden: (f) => frames.push(f),
  instanzName: () => "Test-AVA",
  extras: { anhang: async (i) => { uploadBytes = i.bytes; return { id: "att-1", marker: "[attachment]" }; } },
});

agent.emit("stream", { kind: "token", requestId: "x", conversationId: "c", messageId: "m", delta: "a" });
ok(frames.length === 0, "ohne Abo keine Frames");
await kanal.anfrage("abo", { an: true });
agent.emit("stream", { kind: "token", requestId: "x", conversationId: "c", messageId: "m", delta: "b" });
ok(frames.length === 1 && frames[0].kanal === "agent", "mit Abo werden Agent-Frames weitergereicht");

frames.length = 0;
const r1 = await kanal.anfrage("senden", { conversationId: "conv-123456", nachricht: "Hi" });
ok(r1.status === "gestartet" && agent.gesendet[0].quelle === "app", "Senden startet sofort mit Quelle app");
ok(frames.some((f) => f.kanal === "agent" && f.frame.kind === "user-message" && f.frame.source === "app"), "Nutzernachricht als Frame für alle Oberflächen");
ok(frames.some((f) => f.kanal === "app" && f.ereignis.art === "durchlauf" && f.ereignis.aktiv), "Durchlauf-Beginn gemeldet");

const r2 = await kanal.anfrage("senden", { conversationId: "conv-123456", nachricht: "Zweite" });
ok(r2.status === "wartet" && r2.position === 1, "beschäftigt → Warteschlange");
await kanal.anfrage("senden", { nachricht: "3" });
await kanal.anfrage("senden", { nachricht: "4" });
let voll = false;
try { await kanal.anfrage("senden", { nachricht: "5" }); } catch (e) { voll = e.code === "beschaeftigt"; }
ok(voll, "Warteschlange höchstens 3");

frames.length = 0;
agent.fertig();
ok(agent.gesendet.length === 2 && agent.gesendet[1].message === "Zweite", "nächste Nachricht startet automatisch");
ok(frames.some((f) => f.kanal === "app" && f.ereignis.art === "gestartet" && f.ereignis.warteId === r2.warteId), "Start aus der Warteschlange gemeldet");

const a1 = await kanal.anfrage("abbrechen", { requestId: "fremd" });
const a2 = await kanal.anfrage("abbrechen", { requestId: agent.inFlight });
ok(!a1.abgebrochen && a2.abgebrochen && agent.abgebrochen.length === 1, "Abbrechen nur den genannten Durchlauf");

await kanal.anfrage("antwort", { choiceId: "c", wert: "ja" });
ok(agent.antworten[0][1] === "ja", "Rückfrage-Antwort über answerChoice");

const g = await kanal.anfrage("gespraech", { conversationId: "c1" });
ok(g.nachrichten.length === 3 && !g.nachrichten.some((n) => n.rolle === "tool"), "Gespräch ohne Werkzeug-Rohdaten");
ok(!JSON.stringify(g).includes("AAAA") && g.nachrichten[0].bilder[0].filename === "x.png", "Bilddaten werden nicht übertragen");
ok(g.nachrichten[1].werkzeuge[0] === "company_search", "Werkzeugnamen bleiben sichtbar");

const daten = Buffer.from("Hallo Welt, das ist ein Test.".repeat(50));
const t1 = daten.subarray(0, 700).toString("base64");
const t2 = daten.subarray(700).toString("base64");
await kanal.anfrage("anhang_teil", { uploadId: "upload-123", index: 1, base64: t2 });
await kanal.anfrage("anhang_teil", { uploadId: "upload-123", index: 0, base64: t1 });
await kanal.anfrage("anhang_fertig", { uploadId: "upload-123", teile: 2, filename: "a.txt" });
ok(uploadBytes && Buffer.from(uploadBytes).equals(daten), "Teil-Upload wird in richtiger Reihenfolge zusammengesetzt");

let nv = false;
try { await kanal.anfrage("meldungen", {}); } catch (e) { nv = e.code === "nicht_verfuegbar"; }
ok(nv, "fehlende Fähigkeit → nicht_verfuegbar");

// Echte Anhang-Aufbereitung
const store = new AttachmentStore(mkdtempSync(join(tmpdir(), "ava-anhang-")));
const csv = await anhangAufbereiten(store, { filename: "firmen.csv", bytes: new Uint8Array(Buffer.from("Name;Ort\nHettich;Kirchlengern\nMiele;Gütersloh\n")) });
ok(csv.typ === "tabelle" && csv.marker.includes("Columns:") && csv.marker.includes(`id: ${csv.id}`), "CSV → Tabellen-Marker mit Handle");
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Firma", "Stadt"], ["A GmbH", "Bielefeld"]]), "Liste");
const xlsx = await anhangAufbereiten(store, { filename: "liste.xlsx", bytes: new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })) });
ok(xlsx.marker.includes('Sheet "Liste" (1 data row)') && xlsx.marker.includes('"A GmbH"'), "Excel → Blatt, Spalten, Musterzeile");
const txt = await anhangAufbereiten(store, { filename: "notiz.md", bytes: new Uint8Array(Buffer.from("# Notiz\nWichtiger Kunde")) });
ok(txt.typ === "text" && txt.marker.includes("Kurzansicht:"), "Text → Kurzansicht");
ok(store.get(txt.id)?.seiten?.[0]?.includes("Wichtiger Kunde"), "Datei-Handle für datei_lesen abgelegt");

console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
