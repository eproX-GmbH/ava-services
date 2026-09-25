import assert from "node:assert/strict";
import S from "../src/main/telegram/sprachantwort.ts";
const { parseAntwortSteuerung } = S;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };
const p = (t) => parseAntwortSteuerung(t);
pruefe("einmal Sprachnachricht", () => {
  const r = p("Wie ist der Umsatz von Strategic IT? Gerne per Sprachnachricht antworten");
  assert.equal(r.modus, "sprache"); assert.equal(r.dauerhaft, false); assert.equal(r.bereinigt, "Wie ist der Umsatz von Strategic IT?");
});
pruefe("immer Sprachnachricht", () => {
  for (const t of ["Ab jetzt immer per Sprachnachricht", "Gerne immer per Sprachnachricht.", "bitte künftig als Sprachnachricht antworten"]) {
    const r = p(t); assert.equal(r.modus, "sprache", t); assert.equal(r.dauerhaft, true, t); assert.equal(r.bereinigt, "", t);
  }
});
pruefe("einmal Text, immer Text", () => {
  const a = p("Was macht die Firma? Gerne per Textnachricht"); assert.equal(a.modus, "text"); assert.equal(a.dauerhaft, false); assert.equal(a.bereinigt, "Was macht die Firma?");
  const b = p("Gerne immer per Textnachricht"); assert.equal(b.modus, "text"); assert.equal(b.dauerhaft, true); assert.equal(b.bereinigt, "");
});
pruefe("keine Anweisung", () => {
  for (const t of ["Schick mir die Kontakte von Betzemeier", "Text der Ausschreibung bitte zusammenfassen", "Wer ist Ansprechpartner?"]) {
    const r = p(t); assert.equal(r.modus, null, t); assert.equal(r.bereinigt, t.trim(), t);
  }
});
pruefe("Anweisung in Klammern und mit Komma", () => {
  const r = p("Zeig mir offene Stellen bei Lufthansa (gerne als Sprachnachricht)"); assert.equal(r.modus, "sprache"); assert.equal(r.bereinigt, "Zeig mir offene Stellen bei Lufthansa");
  const s = p("Umsatz 2024, bitte per Audio"); assert.equal(s.modus, "sprache"); assert.equal(s.bereinigt, "Umsatz 2024");
});
console.log(fehler === 0 ? "Telegram-Sprachantwort-Tests ok" : `${fehler} Fehler`);
process.exit(fehler === 0 ? 0 : 1);
