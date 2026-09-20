// Prueft den Namensabgleich fuer den CRM-Abgleich des Buying Centers
// (src/main/buying-center/interaktionen.ts). Ein falscher Treffer haengt
// die Notizen eines Fremden an die falsche Person — das darf nicht passieren.
import assert from "node:assert/strict";
import I from "../src/main/buying-center/interaktionen.ts";
import F from "../src/main/buying-center/freigabe.ts";
const { gleicherName, falte, kontaktVorschlag } = I;
const { findeMitglied, mitgliedAnzeige } = F;

let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

console.log("Namensabgleich");
pruefe("gleicher Name, andere Schreibung", () => {
  assert.ok(gleicherName("Jörg Müller", "Joerg Mueller"));
  assert.ok(gleicherName("Müller, Jörg", "Jörg Müller"));
  assert.ok(gleicherName("Dr. Anna Berg", "Anna Berg"));
  assert.ok(gleicherName("ANNA BERG", "anna berg"));
});
pruefe("verschiedene Menschen bleiben verschieden", () => {
  assert.ok(!gleicherName("Anna Berg", "Anna Bergmann"));
  assert.ok(!gleicherName("Jörg Müller", "Jörg Meier"));
  assert.ok(!gleicherName("Anna Berg", "Berg"));
});
pruefe("leer trifft nichts", () => {
  assert.ok(!gleicherName("", "Anna Berg"));
  assert.ok(!gleicherName("Anna Berg", " "));
});
pruefe("Faltung ist stabil", () => {
  assert.equal(falte("Prof. Dr. Jörg-Peter Müßig"), "joerg peter muessig");
});

console.log("Kontaktintensitaet aus Anzahl");
pruefe("Schwellen 0 / 1–2 / 3–8 / >8", () => {
  assert.equal(kontaktVorschlag(0), "0");
  assert.equal(kontaktVorschlag(2), "S");
  assert.equal(kontaktVorschlag(3), "R");
  assert.equal(kontaktVorschlag(8), "R");
  assert.equal(kontaktVorschlag(9), "I");
});

console.log("Freigabe: Mitglied finden (BC7)");
const M = [
  { actorId: "a1", email: "henning@firma.de", name: "Henning Johnsen" },
  { actorId: "a2", email: "patrick@firma.de", name: "Patrick Dettley" },
  { actorId: "a3", email: "h.meier@firma.de", name: "Henning Meier" },
  { actorId: "a4", email: null, name: null },
];
pruefe("E-Mail exakt, Gross/Klein egal", () => assert.deepEqual(findeMitglied(M, "Henning@Firma.de").map((m) => m.actorId), ["a1"]));
pruefe("Kennung exakt", () => assert.deepEqual(findeMitglied(M, "a4").map((m) => m.actorId), ["a4"]));
pruefe("voller Name, Reihenfolge egal", () => assert.deepEqual(findeMitglied(M, "Dettley Patrick").map((m) => m.actorId), ["a2"]));
pruefe("Vorname allein ist mehrdeutig", () => assert.deepEqual(findeMitglied(M, "Henning").map((m) => m.actorId).sort(), ["a1", "a3"]));
pruefe("Teil der E-Mail", () => assert.deepEqual(findeMitglied(M, "h.meier").map((m) => m.actorId), ["a3"]));
pruefe("nichts passt", () => assert.deepEqual(findeMitglied(M, "Zimmer"), []));
pruefe("leer trifft nichts", () => assert.deepEqual(findeMitglied(M, "  "), []));
pruefe("Anzeige: Name (E-Mail), sonst was da ist", () => {
  assert.equal(mitgliedAnzeige(M[0]), "Henning Johnsen (henning@firma.de)");
  assert.equal(mitgliedAnzeige({ actorId: "x", email: "x@y.de", name: null }), "x@y.de");
  assert.equal(mitgliedAnzeige(M[3]), "a4");
});

console.log(fehler === 0 ? "\nAlles gruen." : `\n${fehler} Pruefung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
