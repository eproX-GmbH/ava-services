// Prueft, was aus einem Werkzeugaufruf als Relevanz-Signal herausfaellt
// (docs/PLAN_RELEVANZ.md, 3.4).
//
// Der wichtigste Fall ist die Listenfalle: Wer eine Uebersicht mit fuenfzig
// Firmen aufruft, hat nicht an jedem Eintrag Interesse. Faellt diese
// Schranke, wird der Wert wertlos — dann ist alles gleich warm.

import assert from "node:assert/strict";
// Die App uebersetzt nach CommonJS, deshalb liegen die Exporte am
// Standard-Export und nicht als benannte.
import W from "../src/main/relevanz/aus-werkzeugen.ts";
const { ausArgumenten, ausErgebnis, ausAufruf, TREFFER_GRENZE } = W;

let fehler = 0;
function pruefe(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); }
}

console.log("Argumente");

pruefe("companyId im Aufruf zaehlt", () => {
  const f = ausArgumenten({ companyId: "DE-371273" });
  assert.deepEqual(f, [{ zielArt: "firma", zielId: "DE-371273" }]);
});

pruefe("Schreibweisen: company_id, firmaId", () => {
  assert.equal(ausArgumenten({ company_id: "DE-1001" }).length, 1);
  assert.equal(ausArgumenten({ firmaId: "DE-1001" }).length, 1);
});

pruefe("Mehrzahl und Verschachtelung", () => {
  assert.equal(ausArgumenten({ companyIds: ["DE-1001", "DE-1002"] }).length, 2);
  assert.equal(ausArgumenten({ filter: { companyId: "DE-1001" } }).length, 1);
});

pruefe("personId wird als Person erkannt", () => {
  assert.deepEqual(ausArgumenten({ personId: "per-1001" }), [{ zielArt: "person", zielId: "per-1001" }]);
});

pruefe("Unfug wird nicht zur ID", () => {
  assert.equal(ausArgumenten({ companyId: "" }).length, 0);
  assert.equal(ausArgumenten({ companyId: "Zimmer Group GmbH" }).length, 0, "Namen sind keine IDs");
  assert.equal(ausArgumenten({ companyId: "https://example.org/x" }).length, 0);
  assert.equal(ausArgumenten({ name: "DE-371273" }).length, 0, "falscher Schluessel");
});

pruefe("sehr kurze Werte gelten nicht als ID", () => {
  // Absicht: "A1" oder "12" stehen in Argumenten viel zu oft fuer etwas
  // anderes. Lieber ein Signal verpassen als eines erfinden.
  assert.equal(ausArgumenten({ companyId: "A1" }).length, 0);
});

pruefe("kein endloses Graben", () => {
  let tief = { companyId: "TIEF" };
  for (let i = 0; i < 30; i++) tief = { a: tief };
  assert.doesNotThrow(() => ausArgumenten(tief));
});

console.log("Ergebnis");

pruefe("ein Treffer im Ergebnis zaehlt", () => {
  assert.deepEqual(ausErgebnis("Gefunden: [Zimmer](company:DE-371273)"),
    [{ zielArt: "firma", zielId: "DE-371273" }]);
});

pruefe(`bis ${TREFFER_GRENZE} Treffer zaehlen`, () => {
  const t = "company:DE-1001 company:DE-1002 company:DE-1003";
  assert.equal(ausErgebnis(t).length, 3);
});

pruefe("mehr Treffer = Liste = nichts", () => {
  const liste = Array.from({ length: 50 }, (_, i) => `company:DE-10${String(i).padStart(2, "0")}`).join(" ");
  assert.equal(ausErgebnis(liste).length, 0,
    "eine Uebersicht darf keine fuenfzig Signale erzeugen");
});

pruefe("dieselbe Firma mehrfach genannt bleibt ein Treffer", () => {
  assert.equal(ausErgebnis("company:DE-1001 ... company:DE-1001 ... company:DE-1001").length, 1);
});

console.log("Zusammenspiel");

pruefe("Argumente und Ergebnis zusammen, ohne Doppel", () => {
  const f = ausAufruf({ companyId: "DE-1001" }, "[X](company:DE-1001)");
  assert.equal(f.length, 1);
});

pruefe("Person bekommt die Firma mit, wenn genau eine im Spiel ist", () => {
  const f = ausAufruf({ companyId: "DE-1001", personId: "per-1001" }, "");
  const person = f.find((x) => x.zielArt === "person");
  assert.equal(person.firmaId, "DE-1001");
});

pruefe("bei mehreren Firmen keine geratene Zuordnung", () => {
  const f = ausAufruf({ companyIds: ["DE-1001", "DE-1002"], personId: "per-1001" }, "");
  const person = f.find((x) => x.zielArt === "person");
  assert.ok(!person.firmaId, "Zuordnung waere geraten");
});

pruefe("ein Bulk-Aufruf erzeugt hoechstens fuenf Signale", () => {
  const viele = Array.from({ length: 100 }, (_, i) => `DE-10${String(i).padStart(2, "0")}`);
  assert.ok(ausAufruf({ companyIds: viele }, "").length <= 5);
});

console.log(fehler === 0 ? "\nAlles gruen." : `\n${fehler} Pruefung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
