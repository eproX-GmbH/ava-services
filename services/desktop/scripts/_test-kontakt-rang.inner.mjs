import assert from "node:assert/strict";
const { rangFuerTitel, sortiereNachRang, RANG_TITEL } = await import(
  "../src/renderer/src/routes/kontakt-rang.ts"
);

// Zwilling zu rangFuerTitel im Kontakt-Producer. Weicht einer der beiden ab,
// stimmt die Reihenfolge in der App nicht mehr mit der Auswahl ueberein.
assert.equal(rangFuerTitel("Geschäftsführer"), 3);
assert.equal(rangFuerTitel("Managing Director"), 3);
assert.equal(rangFuerTitel("CEO"), 3);
assert.equal(rangFuerTitel("Prokurist"), 3);
assert.equal(rangFuerTitel("Leitung ORG / IT"), 2);
assert.equal(rangFuerTitel("Head of Marketing"), 2);
assert.equal(rangFuerTitel("Regionalvertriebsleiter Europa"), 2, "leit… schlaegt vertrieb");
assert.equal(rangFuerTitel("Sales Engineer"), 1);
assert.equal(rangFuerTitel("Einkäufer"), 1);
assert.equal(rangFuerTitel("Data Analyst"), 0);
assert.equal(rangFuerTitel("Industriekaufmann"), 0);
console.log("  ok   die vier Stufen stimmen mit dem Producer ueberein");

// Ohne Titel ist der Rang 0 — nicht undefined, sonst bricht die Sortierung.
assert.equal(rangFuerTitel(null), 0);
assert.equal(rangFuerTitel(undefined), 0);
assert.equal(rangFuerTitel(""), 0);
console.log("  ok   fehlende Titel landen bei Null statt zu stoeren");

const p = (name, titel) => ({ name, titel });
const leute = [
  p("Zacharias Weber", "Data Analyst"),
  p("Anna Meier", "Geschäftsführerin"),
  p("Bernd Schulz", null),
  p("Clara Roth", "Head of Sales"),
  p("Dieter Klein", "Vertrieb"),
  p("Albert Zuse", "Geschäftsführer"),
];
const sortiert = sortiereNachRang(leute, (x) => x.titel, (x) => x.name).map((x) => x.name);
assert.deepEqual(
  sortiert,
  ["Albert Zuse", "Anna Meier", "Clara Roth", "Dieter Klein", "Bernd Schulz", "Zacharias Weber"],
  "Rang zuerst, innerhalb des Rangs alphabetisch",
);
console.log("  ok   Geschaeftsleitung oben, ohne Rolle unten, sonst alphabetisch");

// Zweimal sortieren muss dasselbe ergeben, sonst springen die Karten.
const nochmal = sortiereNachRang([...leute].reverse(), (x) => x.titel, (x) => x.name).map((x) => x.name);
assert.deepEqual(nochmal, sortiert, "Reihenfolge darf nicht von der Eingabereihenfolge abhaengen");
console.log("  ok   die Reihenfolge ist stabil");

// Die Eingabe darf nicht veraendert werden — sie ist der React-State.
const vorher = leute.map((x) => x.name);
sortiereNachRang(leute, (x) => x.titel, (x) => x.name);
assert.deepEqual(leute.map((x) => x.name), vorher, "Eingabeliste bleibt unberuehrt");
console.log("  ok   die uebergebene Liste wird nicht veraendert");

assert.equal(RANG_TITEL[3], "Geschäftsleitung");
assert.equal(RANG_TITEL[0], "Weitere");
console.log("  ok   Bezeichnungen vorhanden");

console.log("Kontakt-Rang-Tests ok");
