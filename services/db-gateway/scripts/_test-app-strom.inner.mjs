// App-Kanal im Gateway (docs/PLAN_APP_PWA.md §3.2): echter WebSocket-Kopf am
// Relais, App-Anfrage hin und zurück, Frames in den App-Strom mit Ringpuffer
// und Wiederaufsetzen nach Last-Event-ID, Abo-Meldung an den Kopf.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
for (const datei of ["../.env", "../.env.example"]) {
  let text = "";
  try { text = readFileSync(new URL(datei, import.meta.url), "utf8"); } catch { continue; }
  for (const z of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(z.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
process.env.LOG_LEVEL = "warn";
const load = async (p) => {
  const m = await import(p);
  return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m;
};
const { kopfRelais } = await load("../src/lib/kopf-relais.ts");
const { AppStrom } = await load("../src/lib/app-strom.ts");
const { WebSocket } = await import("ws");

let fehler = 0;
const ok = (b, t) => { console.log(`${b ? "✓" : "✗"} ${t}`); if (!b) fehler++; };

const aboMeldungen = [];
const strom = new AppStrom((actorId, an) => { aboMeldungen.push([actorId, an]); void kopfRelais.appAnfrage(actorId, "abo", { an }, { timeoutMs: 2000 }); });
kopfRelais.onAppFrame((actorId, instanzId, frame) => strom.veroeffentlichen(actorId, { instanz: instanzId, ...frame }));

const server = createServer();
kopfRelais.attach(server, async (t) => (t === "gut" ? { actorId: "nutzer-1", tenantId: "t-1" } : null));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// Nachgebauter Kopf
const kopf = new WebSocket(`ws://127.0.0.1:${port}/kopf-relais?access_token=gut`);
const beimKopf = [];
await new Promise((r) => kopf.on("open", r));
kopf.send(JSON.stringify({ typ: "hallo", version: "0.1.801", instanz: { id: "instanz-server-1", art: "server", name: "Test-Server" }, werkzeuge: [], zustand: {} }));
kopf.on("message", (roh) => {
  const n = JSON.parse(String(roh));
  beimKopf.push(n);
  if (n.typ === "app") {
    const antwort = n.art === "kaputt" ? { typ: "ergebnis", id: n.id, text: JSON.stringify({ code: "beschaeftigt", message: "voll" }), isError: true } : { typ: "ergebnis", id: n.id, text: JSON.stringify({ art: n.art, daten: n.daten }) };
    kopf.send(JSON.stringify(antwort));
  }
});
await new Promise((r) => setTimeout(r, 100));

const r = await kopfRelais.appAnfrage("nutzer-1", "stand", { x: 1 });
ok(r && !r.isError && JSON.parse(r.text).art === "stand" && r.instanz.name === "Test-Server", "App-Anfrage erreicht den Kopf und kommt zurück");
const f = await kopfRelais.appAnfrage("nutzer-1", "kaputt", {});
ok(f.isError && JSON.parse(f.text).code === "beschaeftigt", "Fehler des Kopfs kommt mit Code zurück");
ok((await kopfRelais.appAnfrage("nutzer-2", "stand", {})) === null, "fremder Nutzer: keine AVA");

// Strom: Abonnent, Frames, Abo-Meldung an den Kopf
const empfangen = [];
const ab = strom.abonnieren("nutzer-1", null, (e) => empfangen.push(e));
await new Promise((r) => setTimeout(r, 100));
ok(aboMeldungen.length === 1 && beimKopf.some((n) => n.typ === "app" && n.art === "abo"), "erster Abonnent meldet das Abo beim Kopf");
for (let i = 0; i < 3; i++) kopf.send(JSON.stringify({ typ: "app-frame", frame: { kanal: "agent", frame: { kind: "token", delta: String(i) } } }));
await new Promise((r) => setTimeout(r, 100));
ok(empfangen.length === 3 && JSON.parse(empfangen[0].daten).instanz === "instanz-server-1", "Frames des Kopfs landen im Strom (mit Instanz)");
ab();

// Wiederaufsetzen: verpasste Frames nach Last-Event-ID
kopf.send(JSON.stringify({ typ: "app-frame", frame: { kanal: "agent", frame: { kind: "token", delta: "verpasst" } } }));
await new Promise((r) => setTimeout(r, 100));
const nach = [];
strom.abonnieren("nutzer-1", empfangen[2].id, (e) => nach.push(e));
ok(nach.length === 1 && JSON.parse(nach[0].daten).frame.delta === "verpasst", "nach Last-Event-ID nur die verpassten Frames");
const fremd = [];
strom.abonnieren("nutzer-2", 0, (e) => fremd.push(e));
ok(fremd.length === 0, "andere Nutzer sehen keine Frames");

strom.stopp();
kopf.close();
server.close();
console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
