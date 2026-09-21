// Telegram-Text: Markdown wird Text (src/main/telegram/text.ts).
import assert from "node:assert/strict";
import T from "../src/main/telegram/text.ts";
const { markdownZuText } = T;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };
console.log("Telegram-Text");
pruefe("Fettung und Ueberschrift", () => assert.equal(markdownZuText("## Firma\n**KME SE** – Osnabrück"), "Firma\nKME SE – Osnabrück"));
pruefe("Link als Label: URL", () => assert.equal(markdownZuText("[Seite](https://kme.com/)"), "Seite: https://kme.com/"));
pruefe("Liste mit Punkt", () => assert.equal(markdownZuText("- a\n* b\n+ c"), "• a\n• b\n• c"));
pruefe("kursiv, aber Sterne in Wortmitte bleiben", () => {
  assert.equal(markdownZuText("das ist *wichtig* hier"), "das ist wichtig hier");
  assert.equal(markdownZuText("2*3*4"), "2*3*4");
});
pruefe("Unterstrich in Namen bleibt", () => assert.equal(markdownZuText("company_get und _kursiv_"), "company_get und kursiv"));
pruefe("Codezaun und Inline-Code", () => assert.equal(markdownZuText("```json\n{\"a\":1}\n```\nund `x`"), "{\"a\":1}\nund x"));
pruefe("Tabelle wird Zeilen mit Punkt", () => assert.equal(markdownZuText("| Name | Rolle |\n|---|---|\n| Anna | GF |"), "Name · Rolle\nAnna · GF"));
pruefe("Trennlinie weg, Leerzeilen gedeckelt", () => assert.equal(markdownZuText("a\n\n---\n\n\nb"), "a\n\nb"));
pruefe("nackter Text unveraendert", () => assert.equal(markdownZuText("Kurz: alles gut."), "Kurz: alles gut."));
console.log(fehler ? `\n${fehler} Fehler.` : "\nAlles gruen.");
process.exit(fehler ? 1 : 0);
