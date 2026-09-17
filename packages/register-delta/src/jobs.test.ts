import { test } from "node:test";
import assert from "node:assert/strict";
import { fuehreJobAus, leereBekanntmachungsCache, meldungenJeNummer } from "./jobs";
import type { Treffer } from "./parser";

function treffer(nummer: number, name = `Firma ${nummer}`, extra: Partial<Treffer> = {}): Treffer {
  return { kopf: "", kopfGeparst: true, bundesland: "NRW", gericht: "Bad Oeynhausen", art: "HRB", nummer, zusatz: "", frueher: "", name, sitz: "Herford", status: "ACTIVE", statusText: "aktuell", historie: [], ...extra };
}

const takt = { warten: async () => {}, frei: () => 60 };

test("front: zaehlt hoch, bricht nach maxFehltreffer ab, merkt Luecken unterhalb der Front", async () => {
  const vorhanden = new Set([101, 103, 104]);
  const abgefragt: number[] = [];
  const portal = {
    async suche(_g: string, _a: string, n: number | string) {
      abgefragt.push(Number(n));
      return { gesperrt: false, treffer: vorhanden.has(Number(n)) ? [treffer(Number(n))] : [], trefferRoh: 0, dauerMs: 1 };
    },
    async bekanntmachungenText() {
      return { gesperrt: false, text: "" };
    },
  };
  const e = await fuehreJobAus(
    { id: "1", art: "front", schluessel: "", payload: { gericht: "Bad Oeynhausen", art: "HRB", abNummer: 101, maxFehltreffer: 3 }, prioritaet: 3, leaseUntil: null, versuche: 1, abfragenJeStunde: 60 },
    { workerId: "w1", portal, takt },
  );
  assert.deepEqual(abgefragt, [101, 102, 103, 104, 105, 106, 107]);
  assert.equal(e.treffer.length, 3);
  assert.deepEqual(e.front, { maxNummer: 104, offeneLuecken: [102], zusaetze: undefined });
});

test("front: alte Luecken werden einmal nachgeprueft", async () => {
  const portal = {
    async suche(_g: string, _a: string, n: number | string) {
      return { gesperrt: false, treffer: Number(n) === 90 ? [treffer(90)] : [], trefferRoh: 0, dauerMs: 1 };
    },
    async bekanntmachungenText() {
      return { gesperrt: false, text: "" };
    },
  };
  const e = await fuehreJobAus(
    { id: "1", art: "front", schluessel: "", payload: { gericht: "X", art: "HRB", abNummer: 101, maxFehltreffer: 2, offeneLuecken: [90, 91] }, prioritaet: 3, leaseUntil: null, versuche: 1, abfragenJeStunde: 60 },
    { workerId: "w1", portal, takt },
  );
  assert.equal(e.treffer.length, 1);
  assert.equal(e.front?.maxNummer, 100);
  assert.deepEqual(e.front?.offeneLuecken, []);
});

test("front: Sperre beendet den Job mit gesperrt", async () => {
  const portal = {
    async suche() {
      return { gesperrt: true, treffer: [], trefferRoh: null, dauerMs: 1 };
    },
    async bekanntmachungenText() {
      return { gesperrt: false, text: "" };
    },
  };
  const e = await fuehreJobAus(
    { id: "1", art: "front", schluessel: "", payload: { gericht: "X", art: "HRB", abNummer: 1 }, prioritaet: 3, leaseUntil: null, versuche: 1, abfragenJeStunde: 60 },
    { workerId: "w1", portal, takt },
  );
  assert.equal(e.gesperrt, true);
  assert.equal(e.abfragen, 1);
});

test("refresh: Loeschungshinweis setzt Status, Zusatzfilter greift", async () => {
  const portal = {
    async suche(_g: string, _a: string, n: number | string) {
      return { gesperrt: false, treffer: [treffer(Number(n), "A", { zusatz: "FL" }), treffer(Number(n), "B", { zusatz: "SL" })], trefferRoh: 2, dauerMs: 1 };
    },
    async bekanntmachungenText() {
      return { gesperrt: false, text: "" };
    },
  };
  const e = await fuehreJobAus(
    { id: "2", art: "refresh", schluessel: "", payload: { firmen: [{ gericht: "Flensburg", art: "HRA", nummer: 100, zusatz: "FL", hinweis: "loeschung_angekuendigt" }] }, prioritaet: 2, leaseUntil: null, versuche: 1, abfragenJeStunde: 60 },
    { workerId: "w1", portal, takt },
  );
  assert.equal(e.treffer.length, 1);
  assert.equal(e.treffer[0].status, "LOESCHUNG_ANGEKUENDIGT");
});

test("bekanntmachungen: Seite wird je Prozess nur einmal geladen", async () => {
  leereBekanntmachungsCache();
  let laden = 0;
  const text = ["04.09.2026", "Löschungsankündigung", "Bremen Amtsgericht Bremen HRB 1", "A – Bremen", "03.09.2026", "Löschungsankündigung", "Bremen Amtsgericht Bremen HRB 2", "B – Bremen"].join("\n");
  const portal = { async suche() { throw new Error("nein"); }, async bekanntmachungenText() { laden++; return { gesperrt: false, text }; } };
  const job = (tag: string) => ({ id: "9", art: "bekanntmachungen" as const, schluessel: "", payload: { tag }, prioritaet: 1, leaseUntil: null, versuche: 1, abfragenJeStunde: 60 });
  const a = await fuehreJobAus(job("2026-09-04"), { workerId: "w1", portal, takt });
  const b = await fuehreJobAus(job("2026-09-03"), { workerId: "w1", portal, takt });
  assert.equal(laden, 1);
  assert.equal(a.abfragen, 1);
  assert.equal(b.abfragen, 0);
  assert.equal(b.bekanntmachungen?.[0].nummer, 2);
  leereBekanntmachungsCache();
});

test("bekanntmachungen: nur der Tag des Jobs", async () => {
  leereBekanntmachungsCache();
  const text = ["04.09.2026", "Löschungsankündigung", "Bremen Amtsgericht Bremen HRB 1", "A – Bremen", "03.09.2026", "Löschungsankündigung", "Bremen Amtsgericht Bremen HRB 2", "B – Bremen"].join("\n");
  const portal = { async suche() { throw new Error("nein"); }, async bekanntmachungenText() { return { gesperrt: false, text }; } };
  const e = await fuehreJobAus(
    { id: "3", art: "bekanntmachungen", schluessel: "", payload: { tag: "2026-09-03" }, prioritaet: 1, leaseUntil: null, versuche: 1, abfragenJeStunde: 60 },
    { workerId: "w1", portal, takt },
  );
  assert.equal(e.abfragen, 1);
  assert.equal(e.bekanntmachungen?.length, 1);
  assert.equal(e.bekanntmachungen?.[0].nummer, 2);
});

test("Ids je Nummer: einzelnes Altgerichts-Blatt ohne Anhang, bei aktuellem Blatt mit Anhang", () => {
  const allein = meldungenJeNummer([treffer(100001, "Stadtwerke Emden", { frueher: "Emden", gericht: "Aurich" })], "Aurich");
  assert.equal(allein[0].frueherSuffix, false);
  assert.equal(allein[0].gericht, "Aurich");
  const drei = meldungenJeNummer([treffer(2400, "A"), treffer(2400, "B", { frueher: "Herford" }), treffer(2400, "C", { frueher: "Minden" })], "Bad Oeynhausen");
  assert.deepEqual(drei.map((m) => m.frueherSuffix), [false, true, true]);
  const zus = meldungenJeNummer([treffer(100, "A", { zusatz: "FL" }), treffer(100, "B", { zusatz: "SL" })], "Flensburg");
  assert.deepEqual(zus.map((m) => m.frueherSuffix), [false, false]);
});

// ---- S8: strukturierter Registerinhalt im refresh -------------------------

const SI_XML = `<?xml version="1.0"?><tns:n xmlns:tns="http://www.xjustiz.de"><tns:basisdatenRegister><tns:bezeichnung.aktuell>Firma 7</tns:bezeichnung.aktuell><tns:rechtsform><code>221110</code></tns:rechtsform><tns:strasse>Weg</tns:strasse><tns:hausnummer>1</tns:hausnummer><tns:postleitzahl>32545</tns:postleitzahl><tns:ort>Herford</tns:ort></tns:basisdatenRegister><tns:beteiligung><tns:natuerlichePerson><tns:vorname>Anna</tns:vorname><tns:nachname>Muster</tns:nachname></tns:natuerlichePerson></tns:beteiligung></tns:n>`;

function refreshJob(firmen: Array<{ gericht: string; art: string; nummer: number }>) {
  return { id: "9", art: "refresh" as const, schluessel: "", payload: { firmen, grund: "test" }, prioritaet: 2, leaseUntil: null, versuche: 1, abfragenJeStunde: 60 };
}

test("refresh mit SI: haengt den Inhalt an die Meldung, zaehlt zwei Abfragen je Firma", async () => {
  const zeilen: number[] = [];
  const portal = {
    async suche(_g: string, _a: string, n: number | string) {
      return { gesperrt: false, treffer: [treffer(Number(n), `Firma ${n}`, { frueher: "Altstadt" }), treffer(Number(n))], trefferRoh: 2, dauerMs: 1 };
    },
    async bekanntmachungenText() {
      return { gesperrt: false, text: "" };
    },
    async strukturierterInhalt(zeile: number) {
      zeilen.push(zeile);
      return SI_XML;
    },
  };
  const e = await fuehreJobAus(refreshJob([{ gericht: "Bad Oeynhausen", art: "HRB", nummer: 7 }]), { workerId: "w1", portal, takt, si: true });
  assert.equal(e.abfragen, 2);
  assert.deepEqual(zeilen, [1]); // das aktuelle Blatt, nicht die Altgerichts-Zeile
  const aktuell = e.treffer.find((t) => !t.frueher);
  assert.equal(aktuell?.si?.name, "Firma 7");
  assert.equal(aktuell?.si?.managingDirectors[0]?.lastName, "Muster");
  assert.equal(e.treffer.find((t) => t.frueher)?.si, undefined);
  assert.deepEqual(e.si, { geladen: 1, ohneLink: 0, fehler: 0 });
});

test("refresh mit SI: Fehler, fehlender Link und unlesbares XML lassen die Treffer unberuehrt", async () => {
  let aufruf = 0;
  const portal = {
    async suche(_g: string, _a: string, n: number | string) {
      return { gesperrt: false, treffer: [treffer(Number(n))], trefferRoh: 1, dauerMs: 1 };
    },
    async bekanntmachungenText() {
      return { gesperrt: false, text: "" };
    },
    async strukturierterInhalt() {
      aufruf++;
      if (aufruf === 1) throw new Error("SI: keine XML-Datei innerhalb von 60 s");
      if (aufruf === 2) return null;
      return "<html>Fehler</html>";
    },
  };
  const firmen = [1, 2, 3].map((nummer) => ({ gericht: "Bad Oeynhausen", art: "HRB", nummer }));
  const e = await fuehreJobAus(refreshJob(firmen), { workerId: "w1", portal, takt, si: true });
  assert.equal(e.treffer.length, 3);
  assert.ok(e.treffer.every((t) => t.si === undefined));
  assert.deepEqual(e.si, { geladen: 0, ohneLink: 1, fehler: 2 });
  assert.equal(e.gesperrt, undefined);
});

test("refresh mit SI: Portalsperre beim SI-Abruf stellt den Job zurueck", async () => {
  const portal = {
    async suche(_g: string, _a: string, n: number | string) {
      return { gesperrt: false, treffer: [treffer(Number(n))], trefferRoh: 1, dauerMs: 1 };
    },
    async bekanntmachungenText() {
      return { gesperrt: false, text: "" };
    },
    async strukturierterInhalt() {
      throw new Error("SI: Portal gesperrt");
    },
  };
  const e = await fuehreJobAus(refreshJob([{ gericht: "Bad Oeynhausen", art: "HRB", nummer: 1 }]), { workerId: "w1", portal, takt, si: true });
  assert.equal(e.gesperrt, true);
});

test("refresh: Firmen ueber dem Abfragebudget kommen als unbearbeitet zurueck; ohne si bleibt alles wie vorher", async () => {
  const portal = {
    async suche(_g: string, _a: string, n: number | string) {
      return { gesperrt: false, treffer: [treffer(Number(n))], trefferRoh: 1, dauerMs: 1 };
    },
    async bekanntmachungenText() {
      return { gesperrt: false, text: "" };
    },
    async strukturierterInhalt() {
      return SI_XML;
    },
  };
  const firmen = [1, 2, 3, 4].map((nummer) => ({ gericht: "Bad Oeynhausen", art: "HRB", nummer }));
  const mitSi = await fuehreJobAus(refreshJob(firmen), { workerId: "w1", portal, takt, si: true, maxAbfragenJeJob: 5 });
  assert.equal(mitSi.abfragen, 4);
  assert.equal(mitSi.treffer.length, 2);
  assert.deepEqual(mitSi.unbearbeitet?.map((f) => f.nummer), [3, 4]);
  const ohneSi = await fuehreJobAus(refreshJob(firmen), { workerId: "w1", portal, takt, maxAbfragenJeJob: 5 });
  assert.equal(ohneSi.abfragen, 4);
  assert.equal(ohneSi.treffer.length, 4);
  assert.equal(ohneSi.si, undefined);
  assert.equal(ohneSi.unbearbeitet, undefined);
});
