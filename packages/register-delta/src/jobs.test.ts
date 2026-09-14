import { test } from "node:test";
import assert from "node:assert/strict";
import { fuehreJobAus, leereBekanntmachungsCache } from "./jobs";
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
