// Sprachmodus (docs/PLAN_SPRACHMODUS.md, S5): reine Funktionen und die
// Instruktionen. Die Sprach-KI selbst laesst sich offline nicht testen; hier
// wird geprueft, dass Relay-Text, Bloecke, Wachwort und Regeln stimmen.
import assert from "node:assert/strict";
import R from "../src/main/sprache/relay.ts";
import I from "../src/main/sprache/instruktionen.ts";
import W from "../src/renderer/src/lib/wachwort.ts";
const { textFuerSprache, bloeckeAus } = R;
const { spracheInstruktionen, spracheWerkzeuge } = I;
const { istWachwort } = W;

let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

console.log("Relay: Text fuer die Sprach-KI");
pruefe("Links werden zu Text, Zaeune verschwinden, Tabellen werden entschaerft", () => {
  const md = "Siehe [Strategic IT](company:X) und https://a.de/x\n```chart\n{\"title\":\"Umsatz\",\"companyId\":\"A_HRB_1\"}\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const t = textFuerSprache(md);
  assert.ok(t.includes("Strategic IT")); assert.ok(!t.includes("company:")); assert.ok(!t.includes("https://")); assert.ok(!t.includes("```")); assert.ok(!t.includes("|"));
});
pruefe("Bloecke mit Kennung, Titel und Bezug", () => {
  const b = bloeckeAus("x\n```chart\n{\"title\":\"Umsatz\",\"companyId\":\"A_HRB_1\"}\n```\n```buying-center\n{\"companyId\":\"A_HRB_1\"}\n```");
  assert.equal(b.length, 2);
  assert.equal(b[0].art, "chart"); assert.equal(b[0].titel, "Diagramm: Umsatz"); assert.equal(b[0].bezug, "A_HRB_1");
  assert.equal(b[1].art, "buying-center"); assert.equal(b[1].bezug, "A_HRB_1");
  assert.notEqual(b[0].id, b[1].id);
});

console.log("Wachwort");
pruefe("Hey AVA in Whisper-Schreibweisen", () => {
  for (const s of ["Hey AVA", "hey, ava!", "He Ava", "Hallo Ava.", "Hey Afa", "Ava"]) assert.ok(istWachwort(s), s);
});
pruefe("kein Wachwort", () => {
  for (const s of ["", "Guten Morgen", "hey Tom", "Umsatz von Strategic IT", "aber ja"]) assert.ok(!istWachwort(s), s);
});

console.log("Instruktionen");
const ins = spracheInstruktionen({ nutzerName: "Joyce" });
pruefe("Fakten nur aus Ergebnissen, keine Tabellen, Ja nur bei eindeutiger Zustimmung, kein Verlassen", () => {
  assert.match(ins, /NUR wieder/); assert.match(ins, /Keine Tabellen/); assert.match(ins, /Ja gibst du nur weiter/);
  assert.match(ins, /nur ueber das X/); assert.match(ins, /weiblich/); assert.match(ins, /kein 'aehm'/);
  assert.match(ins, /Joyce/);
});
pruefe("Werkzeuge: bearbeiten, rueckfrage, anzeigen", () => {
  const w = spracheWerkzeuge().map((t) => t.name);
  assert.deepEqual(w, ["ava_bearbeiten", "ava_rueckfrage_beantworten", "ava_anzeigen"]);
});

console.log(fehler === 0 ? "Sprachmodus-Tests ok" : `${fehler} Fehler`);
process.exit(fehler === 0 ? 0 : 1);
