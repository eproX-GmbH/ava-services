import { test } from "node:test";
import assert from "node:assert/strict";
import { bereinigeText, insolvenzPortalGericht, kategorieAusText, parseRegistereintrag, parseTrefferliste } from "./insolvenz-parser";
import { fuehreJobAus } from "./jobs";

test("Registereintrag → companyId mit Aliassen", () => {
  assert.equal(parseRegistereintrag("Hamburg, HRA 90794")?.companyId, "HAMBURG_HRA_90794");
  assert.equal(parseRegistereintrag("Berlin, HRB 94497")?.companyId, "BERLINCHARLOTTENBURG_HRB_94497");
  assert.equal(parseRegistereintrag("Münster (Westfalen), HRA 9659")?.companyId, "MUENSTER_HRA_9659");
  assert.equal(parseRegistereintrag("Oldenburg (Oldenburg), HRB 222331")?.companyId, "OLDENBURGOLDENBURG_HRB_222331");
  assert.equal(parseRegistereintrag("Flensburg, HRA 100 FL")?.companyId, "FLENSBURG_HRA_100FL");
  assert.equal(parseRegistereintrag("Gera, HRB 1234")?.gericht, "Jena");
  assert.equal(parseRegistereintrag(""), null);
  assert.equal(insolvenzPortalGericht("Berlin (Charlottenburg)"), "Berlin");
  assert.equal(insolvenzPortalGericht("Münster"), "Münster (Westfalen)");
  assert.equal(insolvenzPortalGericht("Bad Oeynhausen"), "Bad Oeynhausen");
});

test("Trefferliste parsen", () => {
  const z = parseTrefferliste([
    { index: 0, zellen: ["14.09.2026", "67h IN 81/22", "Hamburg", '"travelNet" GmbH & Co.', "Hamburg", "Hamburg, HRA 90794"] },
    { index: 1, zellen: ["14.09.2026", "1504 IK 3300/26", "München", "Abbas, Aram", "München", ""] },
    { index: 2, zellen: ["nur", "drei", "zellen"] },
  ]);
  assert.equal(z.length, 2);
  assert.equal(z[0].datumIso, "2026-09-14");
  assert.equal(z[0].registereintrag?.companyId, "HAMBURG_HRA_90794");
  assert.equal(z[1].registereintrag, null);
});

test("Kategorie aus Text", () => {
  assert.equal(kategorieAusText("… wird das Insolvenzverfahren über das Vermögen der X GmbH eröffnet. Zum Insolvenzverwalter …"), "EROEFFNUNG");
  assert.equal(kategorieAusText("Der Antrag wird mangels Masse abgewiesen."), "ABWEISUNG_MANGELS_MASSE");
  assert.equal(kategorieAusText("Das Insolvenzverfahren wird aufgehoben."), "AUFHEBUNG");
  assert.equal(kategorieAusText("Zum vorläufigen Insolvenzverwalter wird bestellt …"), "SICHERUNGSMASSNAHME");
  assert.equal(kategorieAusText("Termin zur Gläubigerversammlung am …"), "ENTSCHEIDUNG");
  assert.equal(bereinigeText("<p>Amtsgericht&nbsp;Hamburg</p><br>Aktenzeichen: 67h IN 81/22"), "Amtsgericht Hamburg\nAktenzeichen: 67h IN 81/22");
});

test("insolvenz-Job: Suche je Firma, Text je passender Zeile, geprueft nur was bearbeitet wurde", async () => {
  const takt = { warten: async () => {}, frei: () => 60 };
  const gesucht: string[] = [];
  const portal = {
    async suche() { throw new Error("nein"); },
    async bekanntmachungenText() { return { gesperrt: false, text: "" }; },
  };
  const insolvenz = {
    async sucheRegistereintrag(g: string, a: string, n: number | string) {
      gesucht.push(`${g} ${a} ${n}`);
      if (String(n) === "90794")
        return { gesperrt: false, fehler: "", zeilen: parseTrefferliste([
          { index: 0, zellen: ["14.09.2026", "67h IN 81/22", "Hamburg", "travelNet", "Hamburg", "Hamburg, HRA 90794"] },
          { index: 1, zellen: ["14.09.2026", "1 IN 1/26", "Hamburg", "Andere", "Hamburg", "Hamburg, HRA 90794 FL"] },
        ]) };
      return { gesperrt: false, fehler: "", zeilen: [] };
    },
    async ladeText(i: number) { return i === 0 ? "<p>Das Insolvenzverfahren wird aufgehoben.</p>" : ""; },
  };
  const e = await fuehreJobAus(
    { id: "5", art: "insolvenz", schluessel: "", payload: { firmen: [{ companyId: "HAMBURG_HRA_90794", gericht: "Hamburg", art: "HRA", nummer: "90794" }, { companyId: "BADOEYNHAUSEN_HRB_9637", gericht: "Bad Oeynhausen", art: "HRB", nummer: "9637" }], grund: "test" }, prioritaet: 2, leaseUntil: null, versuche: 1, abfragenJeStunde: 60 },
    { workerId: "w1", portal, insolvenz: async () => insolvenz, takt },
  );
  assert.deepEqual(gesucht, ["Hamburg HRA 90794", "Bad Oeynhausen HRB 9637"]);
  assert.equal(e.abfragen, 3);
  assert.equal(e.insolvenz?.meldungen.length, 1);
  assert.equal(e.insolvenz?.meldungen[0].gegenstand, "AUFHEBUNG");
  assert.equal(e.insolvenz?.meldungen[0].datum, "2026-09-14");
  assert.deepEqual(e.insolvenz?.geprueft, ["HAMBURG_HRA_90794", "BADOEYNHAUSEN_HRB_9637"]);
});
