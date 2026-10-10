// Doppelte Kontakte, AVA-Teil: Abgleich je Firma, KI-Urteil nur fuer Kandidaten, Urteil gemerkt.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const m = await import("../src/main/contacts/personen-abgleich.ts");
const { PersonenAbgleich } = m.default ?? m;
let fehler = 0;
const ok = (b, t) => { console.log(`${b ? "✓" : "✗"} ${t}`); if (!b) fehler++; };

const aufrufe = [];
const karte = (id, name, titel) => ({ personId: id, fullName: name, titel, abteilung: null, beschreibung: null, linkedin: null, quellen: ["agent:website"] });
const gateway = async (path, opts) => {
  aufrufe.push({ path, body: opts?.body });
  if (path.endsWith("/contacts/abgleich")) return { firma: "QUIKK Software GmbH", personen: 5, zusammengefuehrt: [{ behalten: "Christian Krebel", aufgeloest: "Christian", regel: "profil-name", grund: "Slug" }], kandidaten: [{ vorname: karte("n", "Niklas", "Backend & RAG"), voll: karte("m", "Niklas Meyer", "Backend Developer") }, { vorname: karte("c", "Christoph", "Infrastructure"), voll: karte("v", "Christoph Vogel", "Vertrieb") }] };
  if (path.endsWith("/contacts/zusammenfuehren")) return { behalten: "Niklas Meyer", aufgeloest: "Niklas" };
  throw new Error("unerwartet " + path);
};
let gefragt = 0;
const urteil = async (_s, user) => { gefragt++; return user.includes("Niklas") ? '{"gleich": true, "begruendung": "beide Backend"}' : '{"gleich": false, "begruendung": "Vertrieb gegen Infrastruktur"}'; };
const pa = new PersonenAbgleich({ gatewayRequest: gateway, isSignedIn: () => true, isLlmBusy: () => false, urteil, log: () => {}, audit: () => {} }, mkdtempSync(join(tmpdir(), "ava-pa-")));
const r = await pa.tick("q");
ok(r.includes("Christian → Christian Krebel") && r.includes("Niklas → Niklas Meyer (KI-Urteil)") && !r.includes("Christoph"), "sichere Paare vom Gateway, Vorname nur bei „gleich“");
const zus = aufrufe.filter((a) => a.path.endsWith("/zusammenfuehren"));
ok(zus.length === 1 && zus[0].body.vornameId === "n" && zus[0].body.vollId === "m" && zus[0].body.grund.startsWith("KI-Urteil"), "Zusammenführung nach Urteil mit Begründung");
ok(gefragt === 2, "zwei Kandidaten, zwei Urteile");
await pa.tick("q");
ok(gefragt === 2, "dasselbe Paar wird nicht erneut beurteilt");
const ohneKi = new PersonenAbgleich({ gatewayRequest: gateway, isSignedIn: () => true, isLlmBusy: () => false, urteil: null, log: () => {}, audit: () => {} }, mkdtempSync(join(tmpdir(), "ava-pa-")));
aufrufe.length = 0;
await ohneKi.tick("q");
ok(!aufrufe.some((a) => a.path.endsWith("/zusammenfuehren")), "ohne KI kein Zusammenführen nach Vornamen");
const kaputt = new PersonenAbgleich({ gatewayRequest: gateway, isSignedIn: () => true, isLlmBusy: () => false, urteil: async () => "vielleicht", log: () => {}, audit: () => {} }, mkdtempSync(join(tmpdir(), "ava-pa-")));
aufrufe.length = 0;
await kaputt.tick("q");
ok(!aufrufe.some((a) => a.path.endsWith("/zusammenfuehren")), "unlesbares Urteil gilt als nein");
console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
