// Prueft den Namensabgleich fuer den CRM-Abgleich des Buying Centers
// (src/main/buying-center/interaktionen.ts). Ein falscher Treffer haengt
// die Notizen eines Fremden an die falsche Person — das darf nicht passieren.
import assert from "node:assert/strict";
import I from "../src/main/buying-center/interaktionen.ts";
const { gleicherName, falte, kontaktVorschlag } = I;

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

console.log(fehler === 0 ? "\nAlles gruen." : `\n${fehler} Pruefung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
