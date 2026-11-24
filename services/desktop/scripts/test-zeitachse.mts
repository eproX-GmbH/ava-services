// Zeitachse zeigt nur echte Änderungen (Befund 2026-11-24: „Kapital 25000.00 → 25000“ zweimal
// bei derselben Firma, „beschrankter → beschränkter Haftung (GmbH)“, „Gunter → Günter“).
// Aufruf: ../../node_modules/.bin/tsx scripts/test-zeitachse.mts
import assert from "node:assert/strict";
import * as Z0 from "../src/renderer/src/lib/zeitachse.ts";

// Wie test-wissen.mts: unter tsx kommt das Modul je nach Umgebung als Namespace oder als default.
const Z = ((Z0 as any).echteAenderung ? Z0 : (Z0 as any).default) as typeof import("../src/renderer/src/lib/zeitachse.ts");
const { echteAenderung, eintraegeProfil, eintraegeRegister, schreibweise } = Z;

const fall = (name: string, f: () => void) => {
  f();
  console.log(`  ok  ${name}`);
};

const pa = (id: string, kind: string, vorher: unknown, nachher: unknown, createdAt = "2026-11-13T08:00:00Z") => ({
  id, kind, added: [{ value: nachher }], removed: [{ value: vorher }], createdAt, bestandVon: "2026-10-13T08:00:00Z",
});

fall("Kapital mit und ohne Nachkommastellen ist kein Eintrag", () => {
  assert.equal(echteAenderung("share-capital", "25000.00", "25000"), false);
  assert.equal(eintraegeProfil([pa("a", "share-capital", "25000.00", 25000), pa("b", "share-capital", "25000.00", "25000", "2026-10-13T08:00:00Z")], "DE", "Firma").length, 0);
});

fall("echte Kapitalerhöhung bleibt", () => {
  const e = eintraegeProfil([pa("a", "share-capital", "25000.00", "50000")], "DE", "Firma");
  assert.equal(e.length, 1);
  assert.equal(e[0]!.titel, "Kapital geändert");
  assert.notEqual(e[0]!.aenderungen![0]!.vorher, e[0]!.aenderungen![0]!.nachher);
});

fall("Rechtsform, Sitz und Gegenstand nur anders geschrieben", () => {
  assert.equal(echteAenderung("legal-form", "Gesellschaft mit beschrankter Haftung", "Gesellschaft mit beschränkter Haftung (GmbH)"), false);
  assert.equal(echteAenderung("legal-form", "221110", "Gesellschaft mit beschränkter Haftung (GmbH)"), false);
  assert.equal(echteAenderung("legal-form", "Gesellschaft mit beschrankter Haftung", "Gesellschaft mit beschrÃ¤nkter Haftung (GmbH)"), false);
  assert.equal(echteAenderung("address", "Wohlertstrae 12 - 13, 10115 Berlin", "Wöhlertstraße 12 - 13, 10115 Berlin"), false);
  assert.equal(echteAenderung("address", "Hauptstr. 5, 33602 Bielefeld", "Hauptstraße 5, 33602 Bielefeld"), false);
  assert.equal(echteAenderung("address", "Muhlenstrae 8 A, 14167 Berlin", ", 14167 Berlin"), false);
  assert.equal(echteAenderung("purpose", "Verwaltung eigenen Vermogens", "Verwaltung eigenen Vermögens"), false);
  assert.equal(echteAenderung("name", "Arena Verwaltungs- und Beteiligungs-GmbH", "Arena Verwaltungsund Beteiligungs-GmbH"), false);
  assert.equal(schreibweise("Straße"), schreibweise("Str."));
});

fall("echter Umzug und Formwechsel bleiben", () => {
  assert.equal(echteAenderung("address", "Porschestraße 38, 38440 Wolfsburg", "Rodelandring 20, 38446 Wolfsburg"), true);
  assert.equal(echteAenderung("legal-form", "Gesellschaft mit beschränkter Haftung", "Aktiengesellschaft"), true);
});

fall("Geschäftsführung: gleiche Person anders geschrieben ist kein Wechsel", () => {
  const gf = (added: object[], removed: object[]) => ({ id: "g", kind: "managing-directors", added, removed, createdAt: "2026-11-13T08:00:00Z", bestandVon: null }) as never;
  assert.equal(eintraegeProfil([gf([{ firstName: "Günter", lastName: "Beispiel" }], [{ firstName: "Gunter", lastName: "Beispiel" }])], "DE", "Firma").length, 0);
  const e = eintraegeProfil([gf([{ firstName: "Günter", lastName: "Beispiel" }, { firstName: "Lea", lastName: "Neu" }], [{ firstName: "Gunter", lastName: "Beispiel" }])], "DE", "Firma");
  assert.equal(e[0]!.titel, "Neu in der Geschäftsführung");
  assert.equal(e[0]!.aenderungen![0]!.nachher, "+ Lea Neu");
});

fall("Register-Snapshot: nur echte Felder, sonst kein Eintrag", () => {
  const alt = { name: "Muster GmbH", legalForm: "Gesellschaft mit beschrankter Haftung", street: "Wohlertstrae", houseNumber: "12", zipCode: "10115", city: "Berlin", shareCapital: "25000.00", foundingYear: null, lastRegisterEntry: "2024-01-05", geschaeftsfuehrung: [{ firstName: "Gunter", lastName: "Beispiel" }] };
  const aktuell = { ...alt, legalForm: "Gesellschaft mit beschränkter Haftung (GmbH)", street: "Wöhlertstraße", shareCapital: 25000, foundingYear: 2014, managingDirectors: [{ firstName: "Günter", lastName: "Beispiel" }] };
  const sn = (felder: string[]) => ({ id: "1", quelle: "x", felder, bestandVon: null, ersetztAm: "2026-11-13T08:00:00Z", stand: alt }) as never;
  assert.equal(eintraegeRegister([sn(["legalForm", "address", "foundingYear", "shareCapital", "geschaeftsfuehrung"])], aktuell as never, "DE", "Firma").length, 0);
  const mitEintrag = eintraegeRegister([sn(["legalForm", "lastRegisterEntry"])], { ...aktuell, lastRegisterEntry: "2026-11-01" } as never, "DE", "Firma");
  assert.equal(mitEintrag.length, 1);
  assert.equal(mitEintrag[0]!.titel, "Registerstand geändert: Letzte Eintragung");
  const umzug = eintraegeRegister([sn(["address"])], { ...aktuell, street: "Rodelandring", zipCode: "38446", city: "Wolfsburg" } as never, "DE", "Firma");
  assert.equal(umzug[0]!.titel, "Registerstand geändert: Sitz");
});

console.log("Zeitachse: alle Fälle ok");
