// ava_fragen (docs/PLAN_AVA_CLOUD.md §11.3): fertige Antwort, Rückfrage mit
// Token und Fortsetzung, beschäftigt, laeuft/abholen — gegen einen nachgebauten Orchestrator.
import { EventEmitter } from "node:events";
const load = async (p) => {
  const m = await import(p);
  return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m;
};
const { AvaFragen } = await load("../src/core/relais/ava-fragen.ts");

const failures = [];
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) failures.push(m); };

class FakeAgent extends EventEmitter {
  constructor(skript) { super(); this.skript = skript; this.busy = null; this.n = 0; this.letzte = null; }
  getStatus() { return { ready: true, inFlightRequestId: this.busy }; }
  startAutonomousConversation(input) {
    this.letzte = input;
    const requestId = `r${++this.n}`;
    const conversationId = input.conversationId ?? "neu";
    this.busy = requestId;
    setTimeout(() => this.skript.call(this, { requestId, conversationId, input }), 5);
    return { conversationId, requestId };
  }
  frame(f) { this.emit("stream", f); if (f.kind === "done" || f.kind === "error") this.busy = null; }
}

// 1) einfache Antwort
{
  const a = new FakeAgent(async function ({ requestId, conversationId }) {
    this.frame({ kind: "tool-call", requestId, conversationId, toolCall: { id: "t1", name: "company_get" } });
    this.frame({ kind: "token", requestId, conversationId, messageId: "m", delta: "Strategic IT ist " });
    this.frame({ kind: "token", requestId, conversationId, messageId: "m", delta: "ein Dynamics-Partner." });
    this.frame({ kind: "done", requestId, conversationId, messageId: "m" });
  });
  const f = new AvaFragen(a);
  const r = JSON.parse((await f.ausfuehren({ nachricht: "Wer ist Strategic IT?" })).text);
  ok(r.status === "fertig", "fertig");
  ok(r.antwort === "Strategic IT ist ein Dynamics-Partner.", "Antwort zusammengesetzt");
  ok(Array.isArray(r.werkzeuge) && r.werkzeuge[0] === "company_get", "Werkzeuge gemeldet");
  ok(a.letzte.source === "mcp", "Herkunft mcp");
  ok(typeof r.gespraech === "string" && r.gespraech.startsWith("mcp-"), "gespraech vergeben");
}

// 2) Rückfrage, dann Fortsetzung mit Antwort
{
  const a = new FakeAgent(async function ({ requestId, conversationId, input }) {
    try {
      const v = await input.remoteAsk.askChoice("Workflow X jetzt starten?", [{ value: "ja", label: "Starten" }, { value: "nein", label: "Abbrechen" }]);
      this.frame({ kind: "token", requestId, conversationId, messageId: "m", delta: v === "ja" ? "Gestartet." : "Nicht gestartet." });
    } catch (e) {
      this.frame({ kind: "token", requestId, conversationId, messageId: "m", delta: "Ich brauche deine Bestätigung." });
    }
    this.frame({ kind: "done", requestId, conversationId, messageId: "m" });
  });
  const f = new AvaFragen(a);
  const r1 = JSON.parse((await f.ausfuehren({ nachricht: "Starte Workflow X" })).text);
  ok(r1.status === "rueckfrage" && r1.rueckfragen?.length === 1, "Rückfrage gemeldet");
  const t = r1.rueckfragen[0].token;
  ok(r1.rueckfragen[0].optionen?.length === 2, "Optionen mitgeliefert");
  const r2 = JSON.parse((await f.ausfuehren({ gespraech: r1.gespraech, antworten: { [t]: "ja" } })).text);
  ok(r2.status === "fertig" && r2.antwort === "Gestartet.", "Fortsetzung mit Antwort 'ja'");
  ok(a.letzte.conversationId === r1.gespraech, "dieselbe Konversation fortgesetzt");
  ok(/Starten/.test(a.letzte.initialMessage), "Antwort im Klartext an das Modell");
}

// 3) beschäftigt
{
  const a = new FakeAgent(async function () {});
  a.busy = "fremd";
  const f = new AvaFragen(a);
  const r = await f.ausfuehren({ nachricht: "Hallo" });
  ok(r.isError === true && /gerade etwas anderes/.test(r.text), "beschäftigt → klare Meldung, nichts eingereiht");
  ok(a.n === 0, "kein Start bei beschäftigt");
}

// 4) läuft noch → abholen (Wartezeit verkürzt über eigene Instanz)
{
  let fertigMachen;
  const a = new FakeAgent(async function ({ requestId, conversationId }) {
    fertigMachen = () => {
      this.frame({ kind: "token", requestId, conversationId, messageId: "m", delta: "Spät, aber fertig." });
      this.frame({ kind: "done", requestId, conversationId, messageId: "m" });
    };
  });
  const f = new AvaFragen(a);
  f.warten = (l, ms) => Promise.race([l.fertig, new Promise((r) => setTimeout(r, 30))]);
  const r1 = JSON.parse((await f.ausfuehren({ nachricht: "Langer Auftrag" })).text);
  ok(r1.status === "laeuft", "läuft noch");
  fertigMachen();
  const r2 = JSON.parse((await f.ausfuehren({ gespraech: r1.gespraech })).text);
  ok(r2.status === "fertig" && r2.antwort === "Spät, aber fertig.", "Ergebnis abgeholt");
  ok(a.n === 1, "kein zweiter Zug beim Abholen");
}

if (failures.length) { console.log(`\n${failures.length} Fehler`); process.exit(1); }
console.log("\nava_fragen: alle Prüfungen bestanden");
