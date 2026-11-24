// Echte Aenderung oder andere Schreibweise? Faelle aus der lesenden Prod-Probe vom 2026-11-24
// (Zeitachse zeigte „Kapital 25000.00 → 25000“ zweimal hintereinander).
import assert from "node:assert/strict";
for (const k of ["DATABASE_URL", "UPSTREAM_MASTER_DATA_URL", "UPSTREAM_COMPANY_PROFILE_URL", "UPSTREAM_COMPANY_CONTACT_URL", "UPSTREAM_COMPANY_PUBLICATION_URL", "UPSTREAM_WEBSITE_URL", "UPSTREAM_STRUCTURED_CONTENT_URL", "EVENT_BUS_URL", "JWKS_URI"]) process.env[k] ??= "http://127.0.0.1:9/test";
const V = await import("../src/lib/stammdaten-vergleich.ts");
const P = await import("../src/lib/profile-changes.ts");
const R = await import("../src/lib/register-verlauf.ts");
const echt = (kind, a, n) => V.istEchteAenderung(kind, a, n);

// ---- Kapital ---------------------------------------------------------------------
assert.equal(echt("share-capital", "25000.00", "25000"), false);
assert.equal(echt("share-capital", "4082959.00", "4082959"), false);
assert.equal(echt("share-capital", "25.000,00 EUR", "25000"), false);
assert.equal(echt("share-capital", "25000.00", "50000"), true);
assert.equal(V.zahlWert("1.000.000,50"), 1000000.5);
assert.equal(V.zahlWert("ca. 25000"), null);

// ---- Rechtsform ------------------------------------------------------------------
assert.equal(echt("legal-form", "Gesellschaft mit beschrankter Haftung", "Gesellschaft mit beschränkter Haftung (GmbH)"), false);
assert.equal(echt("legal-form", "Gesellschaft mit beschrankter Haftung", "Gesellschaft mit beschrÃ¤nkter Haftung (GmbH)"), false);
assert.equal(echt("legal-form", "221110", "Gesellschaft mit beschränkter Haftung (GmbH)"), false);
assert.equal(echt("legal-form", "Kommanditgesellschaft (KG)", "Kommanditgesellschaft"), false);
assert.equal(echt("legal-form", "Europaische Aktiengesellschaft (SE)", "Europäische Aktiengesellschaft (SE)"), false);
assert.equal(echt("legal-form", "Aktiengesellschaft", "Aktiengesellschaft (AG)"), false);
// Satzreste aus Bekanntmachungen sind keine neue Rechtsform, und als alter Wert kein Vergleich.
assert.equal(echt("legal-form", "Gesellschaft mit beschränkter Haftung (GmbH)", "ProApp Capital GmbH mit Sitz in"), false);
assert.equal(echt("legal-form", "Gesellschaft mit beschrankter Haftung", "Einfügung einer neuen Ziffer 7 (Gewinnverwendung) und die"), false);
assert.equal(echt("legal-form", "der Firma TGT GmbH mit Sitz in Essen (Amtsgericht Essen,", "Gesellschaft mit beschränkter Haftung (GmbH)"), false);
assert.equal(echt("legal-form", "Gesellschaft mit beschränkter Haftung (GmbH)", "[object Object]"), false);
// Echter Formwechsel bleibt.
assert.equal(echt("legal-form", "Gesellschaft mit beschränkter Haftung (GmbH)", "Aktiengesellschaft (AG)"), true);
assert.equal(echt("legal-form", "Unternehmergesellschaft (haftungsbeschränkt)", "Gesellschaft mit beschränkter Haftung"), true);
assert.equal(echt("legal-form", "Gesellschaft mit beschränkter Haftung", "GmbH & Co. KG"), true);
assert.equal(V.rechtsformKern("Europäische Aktiengesellschaft (SE)"), "se");
assert.equal(V.rechtsformKern("Kommanditgesellschaft auf Aktien"), "kgaa");
assert.equal(V.rechtsformKern("eingetragener Verein (e.V.)"), "ev");
assert.equal(V.rechtsformKern("Einzelkaufmann / Einzelkauffrau"), "ek");
assert.equal(V.rechtsformKern("999999"), null);

// ---- Adresse ---------------------------------------------------------------------
assert.equal(echt("address", "Wohlertstrae 12 - 13, 10115 Berlin", "Wöhlertstraße 12 - 13, 10115 Berlin"), false);
assert.equal(echt("address", "Kurfurstendamm 226, 10719 Berlin", "Kurfürstendamm 226, 10719 Berlin"), false);
assert.equal(echt("address", "Hauptstr. 5, 33602 Bielefeld", "Hauptstraße 5, 33602 Bielefeld"), false);
assert.equal(echt("address", "Muhlenstrae 8 A, 14167 Berlin", ", 14167 Berlin"), false, "verlorene Strasse ist kein Umzug");
assert.equal(echt("address", "Koenigsallee 37 A, 14193 Berlin", "Koenigsallee 37 B, 14193 Berlin"), true);
assert.equal(echt("address", "Porschestrae 38, 38440 Wolfsburg", "Rodelandring 20, 38446 Wolfsburg"), true);
assert.equal(V.adresseGeaendert({ street: "", zipCode: "", city: "" }, { street: "Hauptstr. 1", zipCode: "33602", city: "Bielefeld" }), false, "Erstbefuellung");

// ---- Name und Gegenstand -----------------------------------------------------------
assert.equal(echt("name", "Hamburg Arena Verwaltungs- und Beteiligungs-GmbH", "Hamburg Arena Verwaltungsund Beteiligungs-GmbH"), false);
assert.equal(echt("name", "Muster Medizin-Diagnostik-Sicherheit GmbH", "Muster Medizin-Diagnostik- Sicherheit GmbH"), false);
assert.equal(echt("name", "m21 Bildungsmedien GmbH", "m21 Bildungsmedien GmbH die Konzeptionierung von Produkten in den Bereichen Bildung"), false);
assert.equal(echt("name", "Campanda GmbH", "MAGIX Software GmbH"), true);
assert.equal(echt("name", "Muster GmbH", "Muster GmbH & Co. KG"), true);
assert.equal(echt("purpose", "Verwaltung eigenen Vermogens, Beteiligung als personlich haftende Gesellschafterin", "Verwaltung eigenen Vermögens, Beteiligung als persönlich haftende Gesellschafterin"), false);
assert.equal(echt("purpose", "Verwaltung eigenen Vermögens und Beteiligung an anderen Unternehmen", "Verwaltung eigenen Vermögens und Beteiligung an anderen Unternehmen sowie alle Geschäfte, die …"), false, "abgeschnitten");
assert.equal(echt("purpose", "Handel mit Maschinen", "Entwicklung von Software"), true);
// Leere Seiten sind nie ein Wechsel.
assert.equal(echt("name", "", "Muster GmbH"), false);
assert.equal(echt("share-capital", "25000", ""), false);

// ---- Geschaeftsfuehrung ------------------------------------------------------------
const p = (firstName, lastName) => ({ firstName, lastName });
assert.equal(V.personSchluessel(p("Günter", "Beispiel")), V.personSchluessel(p("Gunter", "Beispiel")));
assert.equal(V.personSchluessel(p("Jana", "Preuß")), V.personSchluessel(p("Jana", "Preu")));
assert.equal(V.personSchluessel(p("Dr. Kai", "Muster")), V.personSchluessel(p("Kai", "Muster")));
assert.equal(V.personSchluessel(p("Murat Şener", "Örnekoğlu")), V.personSchluessel(p("Murat Sener", "Ornekoglu")));
assert.equal(V.personSchluessel(p("Anna Maria", "Beispiel")), V.personSchluessel(p("Anna", "Maria Beispiel")));
assert.notEqual(V.personSchluessel(p("Anna", "Beispiel")), V.personSchluessel(p("Anne", "Beispiel")));
assert.deepEqual(P.diffManagingDirectors([p("Gunter", "Beispiel"), p("Kai", "Muster")], [p("Günter", "Beispiel"), p("Kai", "Muster")]), { added: [], removed: [] });
assert.deepEqual(P.diffManagingDirectors([p("Kai", "Muster")], [p("Kai", "Muster"), p("", "Amtsgericht Hamburg")]), { added: [], removed: [] });
assert.deepEqual(P.diffManagingDirectors([p("Kai", "Muster")], [p("Lea", "Neu")]), { added: [p("Lea", "Neu")], removed: [p("Kai", "Muster")] });

// ---- diffStammdaten (Persist) ------------------------------------------------------
const alt = { name: "Muster GmbH", legalForm: "Gesellschaft mit beschrankter Haftung", street: "Muhlenstrae", houseNumber: "8", zipCode: "33602", city: "Bielefeld", shareCapital: "25000.00", corporatePurpose: "Handel mit Maschinen fur die Landwirtschaft" };
assert.deepEqual(P.diffStammdaten(alt, { ...alt, legalForm: "Gesellschaft mit beschränkter Haftung (GmbH)", street: "Mühlenstraße", shareCapital: 25000, corporatePurpose: "Handel mit Maschinen für die Landwirtschaft" }), []);
assert.deepEqual(P.diffStammdaten(alt, { ...alt, shareCapital: 50000, zipCode: "33604" }).map((a) => a.kind), ["address", "share-capital"]);

// ---- Lesefilter fuer den Altbestand ----------------------------------------------
const zeile = (kind, vorher, nachher) => ({ id: "x", companyId: "DE_1", kind, added: [{ value: nachher }], removed: [{ value: vorher }], createdAt: "2026-11-13T00:00:00Z", bestandVon: null });
assert.equal(P.profilAenderungBereinigen(zeile("share-capital", "25000.00", "25000")), null);
assert.ok(P.profilAenderungBereinigen(zeile("share-capital", "25000.00", "100000")));
const gf = { id: "g", companyId: "DE_1", kind: "managing-directors", added: [p("Günter", "Beispiel"), p("Lea", "Neu")], removed: [p("Gunter", "Beispiel")], createdAt: "2026-11-13T00:00:00Z", bestandVon: null };
assert.deepEqual(P.profilAenderungBereinigen(gf).added, [p("Lea", "Neu")]);
assert.deepEqual(P.profilAenderungBereinigen(gf).removed, []);
assert.equal(P.profilAenderungBereinigen({ ...gf, added: [p("Günter", "Beispiel")] }), null);
assert.ok(P.profilAenderungBereinigen({ ...gf, kind: "managing-directors:konzernabschluss 2024", added: [p("Lea", "Neu")], removed: [] }));

// ---- Register-Snapshots ------------------------------------------------------------
const stand = (x = {}) => ({
  name: "Muster GmbH", legalForm: "Gesellschaft mit beschrankter Haftung", street: "Wohlertstrae", houseNumber: "12", zipCode: "10115", city: "Berlin",
  foundingYear: 2001, corporatePurpose: "Verwaltung eigenen Vermogens", shareCapital: "25000.00", lastRegisterEntry: "2024-01-05", lastRegisterModification: "2025-03-01",
  geschaeftsfuehrung: [p("Gunter", "Beispiel")], ...x,
});
assert.deepEqual(R.registerStandFelder(stand(), stand({ legalForm: "Gesellschaft mit beschränkter Haftung (GmbH)", street: "Wöhlertstraße", corporatePurpose: "Verwaltung eigenen Vermögens", shareCapital: 25000, geschaeftsfuehrung: [p("Günter", "Beispiel")] })), []);
assert.deepEqual(R.registerStandFelder(stand(), stand({ legalForm: "Aktiengesellschaft", city: "Hamburg", zipCode: "20095" })), ["legalForm", "address"]);
// Leerer neuer Wert bleibt eine Aenderung (alter Stand wird gesichert).
assert.deepEqual(R.registerStandFelder(stand(), stand({ legalForm: "" })), ["legalForm"]);

console.log("stammdaten-vergleich: alle Faelle ok");
