// Wer nicht mehr beschaeftigt ist, gehoert nicht in die Kontaktliste
// (src/lib/contact-extraction/ausgeschieden.ts).
import assert from "node:assert/strict";
import A from "../src/lib/contact-extraction/ausgeschieden.ts";
import E from "../src/lib/contact-extraction/employment.ts";
const { istAusgeschieden } = A;
const { seitAlsDatum } = E;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };
console.log("Ausgeschieden");
for (const t of ["Retired", "retired", "Rentner", "im Ruhestand", "Pensionär", "ehemaliger Geschäftsführer", "Former CEO", "Geschäftsführer i. R.", "Geschäftsführer a.D.", "Ex-Vertriebsleiter", "ausgeschieden"]) {
  pruefe(`"${t}" ist ausgeschieden`, () => assert.ok(istAusgeschieden(t)));
}
for (const t of ["Geschäftsführer", "Head of Software Engineering", "Leiterin Personal", "Texter", "Sales Engineer", "", null, undefined, "Export Manager", "Pensionsberater"]) {
  pruefe(`"${t}" bleibt`, () => assert.ok(!istAusgeschieden(t)));
}
console.log("Beschaeftigungsbeginn");
pruefe("JJJJ-MM", () => assert.equal(seitAlsDatum("2015-03").toISOString(), "2015-03-01T00:00:00.000Z"));
pruefe("JJJJ", () => assert.equal(seitAlsDatum("2010").toISOString(), "2010-01-01T00:00:00.000Z"));
pruefe("Unsinn → null", () => { assert.equal(seitAlsDatum("Maerz"), null); assert.equal(seitAlsDatum(null), null); });
console.log(fehler ? `\n${fehler} Fehler.` : "\nAlles gruen.");
process.exit(fehler ? 1 : 0);
