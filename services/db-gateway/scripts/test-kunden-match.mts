import assert from "node:assert/strict";
const { waehleBestMatch } = await import("../src/lib/kunden-match.ts");
const k = (name: string, score: number, companyId = name) => ({ companyId, name, location: "X", score });
// EnKo: eindeutig
let r = waehleBestMatch("EnKo Engineering GmbH", [k("EnKo Engineering GmbH", 40), k("ENKO GmbH Engineering Kontor", 30), k("ENCO Engineering GmbH", 25)]);
assert.equal(r?.name, "EnKo Engineering GmbH"); assert.equal(r?.stufe, "sicher");
// KUKA: mehrere Toechter → unsicher, bester Score
r = waehleBestMatch("KUKA", [k("KUKA Deutschland GmbH", 20), k("KUKA AG", 35), k("KUKA Systems GmbH", 18)]);
assert.equal(r?.name, "KUKA AG"); assert.equal(r?.stufe, "unsicher");
// Audi vs Audio
r = waehleBestMatch("Audi", [k("Audio Service GmbH", 30)]);
assert.equal(r, null);
// Wortueberdeckung ohne Praefix → unsicher
r = waehleBestMatch("Hettich", [k("Paul Hettich GmbH & Co. KG", 22)]);
assert.equal(r?.stufe, "unsicher");
// nichts passt
r = waehleBestMatch("Miele", [k("Mielke Bau GmbH", 10)]);
assert.equal(r, null);
console.log("best-match ok");
