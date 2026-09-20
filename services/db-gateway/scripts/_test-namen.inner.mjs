import assert from "node:assert/strict";
const { istBrauchbarerName, nameIdentityForm } = await import(
  "../src/lib/contact-extraction/sanitize-person.ts"
);
const { falteUmlaute, normalizeLinkedInProfileUrl, personIdentityKey } = await import(
  "../src/lib/contact-extraction/employee-contact.ts"
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

// Befund 2026-09-19: "robin rögner" lag zweimal bei derselben Firma — einmal
// unter xing.com/profile/robin_roegner, einmal unter …/robin_rögner. Beide
// Portale erlauben beide Schreibweisen und leiten aufeinander um; es ist
// dasselbe Profil, aber zwei Zeichenketten und damit zwei Schluessel.
assert.equal(falteUmlaute("robin_rögner"), "robin_roegner");
assert.equal(falteUmlaute("jörg_müller_gießen"), "joerg_mueller_giessen");
assert.equal(falteUmlaute("ohne umlaute"), "ohne umlaute");
console.log("  ok   Umlaute werden zur ausgeschriebenen Form gefaltet");

assert.equal(
  normalizeLinkedInProfileUrl("https://www.linkedin.com/in/jörg-müller"),
  normalizeLinkedInProfileUrl("https://linkedin.com/in/joerg-mueller"),
  "dieselbe Person, zwei Schreibweisen",
);
assert.equal(
  normalizeLinkedInProfileUrl("https://WWW.LinkedIn.com/in/Heiko-Zimmer/"),
  normalizeLinkedInProfileUrl("linkedin.com/in/heiko-zimmer"),
  "Gross-/Kleinschreibung, Schema und Schraegstrich stoeren nicht",
);
console.log("  ok   Profil-Adressen werden einheitlich normalisiert");

// Zwei verschiedene Profile duerfen NICHT zusammenfallen — das war der
// Grund, die strittigen Faelle von der Bereinigung auszunehmen.
assert.notEqual(
  normalizeLinkedInProfileUrl("https://www.linkedin.com/in/heiko-zimmer-3653473"),
  normalizeLinkedInProfileUrl("https://www.linkedin.com/in/heiko-zimmer-5619b9104"),
);
console.log("  ok   verschiedene Profile bleiben verschieden");

// Der Identitaets-Schluessel erbt die Faltung.
const k1 = personIdentityKey({ companyId: "X", fullName: "Robin Rögner", xingUrl: "https://www.xing.com/profile/robin_rögner" });
const k2 = personIdentityKey({ companyId: "X", fullName: "Robin Roegner", xingUrl: "https://www.xing.com/profile/robin_roegner" });
assert.equal(k1, k2, "derselbe Schluessel trotz verschiedener Schreibweise");
console.log("  ok   der Identitaets-Schluessel faellt fuer beide Schreibweisen gleich aus");

console.log("Namens-Tests ok");