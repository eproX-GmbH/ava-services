import { test } from "node:test";
import assert from "node:assert/strict";
import { historieAusTexten, parseBekanntmachungen, parseZeile, statusAusText, trefferzahl, KOPF_RE } from "./parser";
import { companyIdAus } from "./ids";

test("Kopfzeile: Zusatz, frueheres Gericht, drei Buchstaben", () => {
  const a = KOPF_RE.exec("Nordrhein-Westfalen Amtsgericht Bad Oeynhausen HRB 2400 früher Amtsgericht Herford")!.groups!;
  assert.equal(a.gericht, "Bad Oeynhausen");
  assert.equal(a.nummer, "2400");
  assert.equal(a.frueher, "Herford");
  const b = KOPF_RE.exec("Schleswig-Holstein Amtsgericht Flensburg HRA 100 FL")!.groups!;
  assert.equal(b.zusatz, "FL");
  const c = KOPF_RE.exec("Bremen Amtsgericht Bremen HRB 2514 BHV")!.groups!;
  assert.equal(c.zusatz, "BHV");
  assert.equal(KOPF_RE.exec("Brandenburg Amtsgericht Neuruppin"), null);
});

test("companyId wie im Bestand", () => {
  assert.equal(companyIdAus("Bad Oeynhausen", "HRB", 2400), "BADOEYNHAUSEN_HRB_2400");
  assert.equal(companyIdAus("Kempten (Allgäu)", "HRB", 1), "KEMPTENALLGAEU_HRB_1");
  assert.equal(companyIdAus("Flensburg", "HRA", 100, "FL"), "FLENSBURG_HRA_100FL");
  assert.equal(companyIdAus("Bad Oeynhausen", "HRB", 2400, "", "Herford"), "BADOEYNHAUSEN_HRB_2400_FHERFORD");
});

test("Status und Historie", () => {
  assert.equal(statusAusText(["aktuell"]).status, "ACTIVE");
  assert.equal(statusAusText(["geschlossenes Registerblatt"]).status, "CLOSED");
  assert.deepEqual(historieAusTexten(["Firma", "Historie", "1.) Anders GmbH", "1.) Enger", "2.) A³ GmbH", "2.) Bielefeld", "Sonstiges"]), [
    { order: 1, name: "Anders GmbH", sitz: "Enger" },
    { order: 2, name: "A³ GmbH", sitz: "Bielefeld" },
  ]);
});

test("parseZeile bildet Gerichts-Alias auf Bestand ab", () => {
  const t = parseZeile({
    kopf: "Brandenburg  Amtsgericht Frankfurt (Oder) HRB 12 ",
    name: " Test GmbH ",
    sitz: "Frankfurt (Oder)",
    statusTexte: ["aktuell"],
    texte: [],
  });
  assert.equal(t.gericht, "Frankfurt/Oder");
  assert.equal(t.kopfGeparst, true);
  assert.equal(t.name, "Test GmbH");
});

test("Trefferzahl", () => {
  assert.equal(trefferzahl("Seite 1-3 von 3 Treffer"), 3);
  assert.equal(trefferzahl("nichts"), null);
});

test("Bekanntmachungen: Filteroptionen vorne und hinten ignorieren, Firma – Sitz trennen", () => {
  const text = [
    "Löschungsankündigung",
    "Einreichung neuer Dokumente",
    "04.09.2026",
    "Löschungsankündigung",
    "Nordrhein-Westfalen Amtsgericht Bad Oeynhausen HRB 2400 früher Amtsgericht Herford",
    "Alt GmbH – Herford",
    "Sonderregisterbekanntmachung OHNE Bezug zum elektr. Register",
    "Brandenburg Amtsgericht Neuruppin",
    "HRB 1648 NP",
    "03.09.2026",
    "Einreichung neuer Dokumente",
    "Bremen Amtsgericht Bremen HRB 2514 BHV",
    "BIS GmbH – Bremerhaven",
    "Löschungsankündigung",
    "Einreichung neuer Dokumente",
    "Bitte warten Sie",
  ].join("\n");
  const e = parseBekanntmachungen(text);
  assert.equal(e.length, 3);
  assert.deepEqual(
    e.map((x) => [x.tagIso, x.gericht, x.nummer, x.zusatz, x.frueher, x.firma, x.sitz, x.geparst]),
    [
      ["2026-09-04", "Bad Oeynhausen", 2400, "", "Herford", "Alt GmbH", "Herford", true],
      ["2026-09-04", null, null, "", "", "HRB 1648 NP", "", false],
      ["2026-09-03", "Bremen", 2514, "BHV", "", "BIS GmbH", "Bremerhaven", true],
    ],
  );
});
