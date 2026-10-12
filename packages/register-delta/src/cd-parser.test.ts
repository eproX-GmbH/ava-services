import { test } from "node:test";
import assert from "node:assert/strict";
import { eintraegeBilden, parseChronologischerAbdruck, spaltenErkennen, type CdSeite, type CdText } from "./cd-parser";

/** Minimaler HRB-Abdruck wie vom Portal (Positionen aus einem echten Abdruck). */
function hrbSeite(): CdSeite {
  const t: CdText[] = [];
  const z = (y: number, x: number, s: string) => t.push({ x, y, s });
  z(26, 12, "Handelsregister B des Amtsgerichts Bad Oeynhausen");
  z(26, 403, "Abdruck");
  z(26, 607, "Nummer der Firma:");
  z(26, 766, "HRB 99999");
  z(59, 17, "Nummer");
  z(59, 53, "a) Firma");
  z(59, 197, "Grund- oder");
  z(59, 242, "a) Allgemeine Vertretungsregelung");
  z(59, 462, "Prokura");
  z(59, 554, "a) Rechtsform, Beginn, Satzung oder Gesellschaftsvertrag");
  z(59, 752, "a) Tag der Eintragung");
  z(70, 26, "der");
  z(70, 194, "Stammkapital");
  z(81, 14, "Eintragung");
  for (const [x, n] of [[29, "1"], [119, "2"], [214, "3"], [316, "4"], [472, "5"], [649, "6"], [789, "7"]] as const) z(122, x, n);
  // Eintragung 1
  z(141, 29, "1");
  z(141, 53, "a)");
  z(141, 193, "500,00 EUR");
  z(141, 242, "a)");
  z(141, 554, "a)");
  z(141, 752, "a)");
  z(152, 53, "Muster Software UG");
  z(152, 242, "Ist nur ein Geschäftsführer bestellt, so vertritt er");
  z(152, 554, "Gesellschaft mit beschränkter Haftung");
  z(152, 752, "13.01.2021");
  z(163, 53, "(haftungsbeschränkt)");
  z(163, 242, "die Gesellschaft allein.");
  z(163, 554, "Musterprotokoll vom 25.11.2020");
  z(185, 53, "b)");
  z(196, 53, "Minden");
  z(207, 53, "Geschäftsanschrift:");
  z(207, 242, "b)");
  z(218, 53, "Hahler Straße 285, 32427 Minden");
  z(218, 242, "Geschäftsführer:");
  z(229, 242, "Mustermann, Max, Minden, *01.02.1990");
  z(240, 53, "c)");
  z(251, 53, "Entwicklung von Software");
  // Eintragung 2: neuer Name, Kapital, zweiter GF, erster ausgeschieden
  z(300, 29, "2");
  z(300, 53, "a)");
  z(300, 193, "25.000,00 EUR");
  z(300, 242, "b)");
  z(300, 554, "a)");
  z(300, 752, "a)");
  z(311, 53, "Muster Software GmbH");
  z(311, 242, "Ausgeschieden als Geschäftsführer:");
  z(311, 554, "Die Gesellschafterversammlung vom 04.12.2023 hat die");
  z(311, 752, "04.01.2024");
  z(322, 242, "Mustermann, Max, Minden, *01.02.1990");
  z(322, 554, "Neufassung des Gesellschaftsvertrages beschlossen");
  z(333, 242, "Bestellt als Geschäftsführerin:");
  z(344, 242, "Beispiel, Erika, Bielefeld, *03.04.1985");
  return { breite: 842, hoehe: 595, texte: t };
}

test("Spalten eines HRB-Abdrucks: zentrierte Ueberschriften werden auf die Inhaltskante korrigiert", () => {
  const sp = spaltenErkennen(hrbSeite());
  assert.deepEqual(
    sp.map((s) => s.spalte),
    ["nummer", "firma", "kapital", "vertretung", "prokura", "rechtsform", "tag"],
  );
  assert.equal(sp.find((s) => s.spalte === "kapital")?.x, 193, "Kapital: Inhaltskante statt Ueberschrift");
});

test("Eintragungen: Nummern trennen Bloecke, Marken a)/b)/c) trennen Abschnitte", () => {
  const e = eintraegeBilden([hrbSeite()]);
  assert.deepEqual(e.map((x) => x.nummer), [1, 2]);
  assert.deepEqual(e[0]!.zellen.firma?.a, ["Muster Software UG", "(haftungsbeschränkt)"]);
  assert.deepEqual(e[0]!.zellen.firma?.c, ["Entwicklung von Software"]);
  assert.deepEqual(e[1]!.zellen.kapital?.["-"], ["25.000,00 EUR"]);
  assert.deepEqual(e[1]!.zellen.tag?.a, ["04.01.2024"]);
});

test("Stand: juengste Werte je Feld, Personen mit Zu- und Abgang, Rechtsform trotz Satzungstext", () => {
  const s = parseChronologischerAbdruck([hrbSeite()]);
  assert.ok(s);
  assert.equal(s.name, "Muster Software GmbH");
  assert.equal(s.legalForm, "Gesellschaft mit beschränkter Haftung");
  assert.equal(s.shareCapital, 25000);
  assert.equal(s.street, "Hahler Straße");
  assert.equal(s.houseNumber, "285");
  assert.equal(s.zipCode, "32427");
  assert.equal(s.city, "Minden");
  assert.equal(s.foundingYear, 2020);
  assert.equal(s.corporatePurpose, "Entwicklung von Software");
  assert.equal(s.lastRegisterEntry, "2024-01-04");
  assert.deepEqual(s.managingDirectors, [{ firstName: "Erika", lastName: "Beispiel", birthDay: "1985-04-03", city: "Bielefeld" }]);
});

test("erwarteter Name schuetzt gegen verwechselte Blaetter; fremde Seite ist kein Abdruck", () => {
  assert.equal(parseChronologischerAbdruck([hrbSeite()], "Andere Firma AG"), null);
  assert.ok(parseChronologischerAbdruck([hrbSeite()], "Muster Software GmbH"));
  assert.equal(parseChronologischerAbdruck([{ breite: 1, hoehe: 1, texte: [{ x: 0, y: 0, s: "Startseite" }] }]), null);
});

test("Fortsetzung auf der Folgeseite gehoert zur letzten Eintragung", () => {
  const s1 = hrbSeite();
  const s2: CdSeite = { breite: 842, hoehe: 595, texte: [] };
  const z = (y: number, x: number, s: string) => s2.texte.push({ x, y, s });
  z(26, 12, "Handelsregister B des Amtsgerichts Bad Oeynhausen");
  z(26, 403, "Abdruck");
  z(59, 17, "Nummer");
  z(59, 53, "a) Firma");
  z(59, 197, "Grund- oder");
  z(59, 242, "a) Allgemeine Vertretungsregelung");
  z(59, 462, "Prokura");
  z(59, 554, "a) Rechtsform, Beginn, Satzung oder Gesellschaftsvertrag");
  z(59, 752, "a) Tag der Eintragung");
  for (const [x, n] of [[29, "1"], [119, "2"], [214, "3"], [316, "4"], [472, "5"], [649, "6"], [789, "7"]] as const) z(122, x, n);
  z(141, 242, "Bestellt als Geschäftsführer:");
  z(152, 242, "Folgeseite, Fritz, Herford, *05.06.1970");
  const s = parseChronologischerAbdruck([s1, s2]);
  assert.ok(s);
  assert.deepEqual(
    s.managingDirectors.map((p) => p.lastName),
    ["Beispiel", "Folgeseite"],
  );
});
