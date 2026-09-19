import assert from "node:assert/strict";
const { istBrauchbarerName, nameIdentityForm } = await import(
  "../src/lib/contact-extraction/sanitize-person.ts"
);

// Echte Namen muessen durchkommen. Ein faelschlich verworfener Mensch faellt
// niemandem auf — der Kontakt fehlt dann einfach.
for (const n of [
  "Heiko Zimmer",
  "Dr. Anna Meier",
  "Juan Carlos López Ordóñez",
  "Anette Sundin",
  "Abhijit Dandekar",
  "Tayfun Aydoğan",
  "Maximiliane-Charlotte von Hohenberg",
  "Li Wei",
  "O'Brien",
]) {
  assert.equal(istBrauchbarerName(n), true, `haette durchkommen muessen: ${n}`);
}
console.log("  ok   echte Namen kommen durch, auch mit Titel und Diakritika");

// Die Platzhalter, die in der Ansicht als "Unbekannte Person" landeten.
for (const n of [
  "LinkedIn Member",
  "linkedin member",
  "LinkedIn User",
  "XING Mitglied",
  "Unbekannte Person",
  "Unknown",
  "Anonymous",
]) {
  assert.equal(istBrauchbarerName(n), false, `haette verworfen werden muessen: ${n}`);
}
console.log("  ok   Portal-Platzhalter werden verworfen");

for (const n of [null, undefined, "", "  ", "ab", "12345", "--", "..."]) {
  assert.equal(istBrauchbarerName(n), false, `haette verworfen werden muessen: ${String(n)}`);
}
console.log("  ok   Leeres, zu Kurzes und Zeichenfolgen ohne Buchstaben fallen raus");

// Die gefaltete Form ist der Anker der Zuordnung: Traegt sie den Titel noch
// mit, findet "Dr. Heiko Zimmer" den bestehenden "Heiko Zimmer" nicht.
assert.equal(nameIdentityForm("Dr. Heiko Zimmer"), nameIdentityForm("Heiko Zimmer"));
assert.equal(nameIdentityForm("HEIKO ZIMMER"), nameIdentityForm("heiko zimmer"));
assert.equal(nameIdentityForm("Heiko  Zimmer "), nameIdentityForm("Heiko Zimmer"));
console.log("  ok   Titel, Grossschreibung und Leerzeichen stoeren die Zuordnung nicht");

// Verschiedene Menschen duerfen NICHT zusammenfallen.
assert.notEqual(nameIdentityForm("Heiko Zimmer"), nameIdentityForm("Jonas Zimmer"));
assert.notEqual(nameIdentityForm("Volker Waldecker"), nameIdentityForm("Volker Waldeck"));
console.log("  ok   verschiedene Namen bleiben verschieden");

console.log("Namens-Tests ok");
