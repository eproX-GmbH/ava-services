import assert from "node:assert/strict";
import m from "../src/shared/adresse.ts";
const { adressZeilen, kartenSuche } = m.default ?? m;

// Alter UK-Datensatz (vor dem Parser-Fix): Land als Ort, Grafschaft und Doppelzeile in der Strasse.
const alt = { street: "Finway Road, Finway Road, Hemel Hempstead Industrial Estate, Hemel Hempstead, Hertfordshire", houseNumber: "1", zipCode: "HP2 7PT", city: "England" };
assert.deepEqual(adressZeilen(alt, "UK"), ["1 Finway Road, Hemel Hempstead Industrial Estate", "Hemel Hempstead HP2 7PT"]);
// Neuer UK-Datensatz bleibt stabil.
assert.deepEqual(adressZeilen({ street: "Finway Road, Hemel Hempstead Industrial Estate", houseNumber: "1", zipCode: "HP2 7PT", city: "Hemel Hempstead" }, "UK"), ["1 Finway Road, Hemel Hempstead Industrial Estate", "Hemel Hempstead HP2 7PT"]);
// Deutschland: Strasse Nr / PLZ Ort.
assert.deepEqual(adressZeilen({ street: "Marienplatz", houseNumber: "1", zipCode: "80331", city: "München" }, "DE"), ["Marienplatz 1", "80331 München"]);
assert.deepEqual(adressZeilen({ street: null, houseNumber: null, zipCode: null, city: null }, "DE"), []);
// Kartensuche mit Landesname, ohne Doppelung.
assert.equal(kartenSuche(["Marienplatz 1", "80331 München"], "DE"), "Marienplatz 1, 80331 München, Deutschland");
assert.equal(kartenSuche(["1 Finway Road", "Hemel Hempstead HP2 7PT"], "UK"), "1 Finway Road, Hemel Hempstead HP2 7PT, United Kingdom");
assert.equal(kartenSuche(["Some Street 1, London, England"], "UK"), "Some Street 1, London, England");
assert.equal(kartenSuche([], "DE"), null);
console.log("Adress-Tests ok");
