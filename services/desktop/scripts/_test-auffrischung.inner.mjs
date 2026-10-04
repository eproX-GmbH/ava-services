import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import F from "../src/main/agent/freshness-scheduler.ts";
import P from "../src/main/agent/freshness-prefs-store.ts";
import C from "../src/main/agent/freshness-cursor-store.ts";
const { FreshnessScheduler, relevanzFaktor } = F;
const { FreshnessPrefsStore } = P;
const { FreshnessCursorStore } = C;
const jetzt = new Date("2026-10-04T12:00:00Z");
const vor = (tage) => new Date(jetzt.getTime() - tage * 86_400_000).toISOString();
const zelle = (tage, tx = "TX-ALT") => ({ state: "completed", updatedAt: tage == null ? null : vor(tage), transactionId: tx });
const firma = (id, webTage, extra = {}) => ({
  companyId: id, name: id, held: false, registerStatus: "ACTIVE",
  stages: {
    "structured-content": zelle(5), "company-publication": zelle(5), website: zelle(webTage),
    "company-profile": zelle(1), "company-contact": zelle(1), "company-evaluation": zelle(1),
  },
  ...extra,
});
// 250 Firmen ueber zwei Seiten; frueher sah der Planer nur die 25 neuesten Transaktionen.
const alle = Array.from({ length: 250 }, (_, i) => firma(`F${i}`, 8));
alle.push(firma("KALT_ALT", 40));                      // kalt, aber sehr alt
alle.push(firma("HEISS", 10));                          // heiss, maessig alt
alle.push(firma("ANGEHALTEN", 90, { held: true }));
alle.push(firma("GESCHLOSSEN", 90, { registerStatus: "CLOSED" }));
const seitenAbrufe = [];
const gateway = {
  request: async (path, opts) => {
    if (path === "/v1/companies/matrix") {
      const { pageNumber, pageSize } = opts.query;
      seitenAbrufe.push(pageNumber);
      return { companies: alle.slice((pageNumber - 1) * pageSize, pageNumber * pageSize), count: alle.length };
    }
    throw new Error("unerwartet " + path);
  },
};
const dir = mkdtempSync(join(tmpdir(), "ava-fr-"));
const prefs = new FreshnessPrefsStore(dir);
assert.equal(prefs.get().cadenceDays.companyPublication, 30, "Standard Jahresabschluss 30 Tage");
const versandt = [];
let scheitern = new Set();
const s = new FreshnessScheduler({
  gateway, prefs, cursor: new FreshnessCursorStore(dir), now: () => jetzt, intervalMs: 0,
  relevanz: async (ids) => new Map(ids.filter((i) => i === "HEISS").map((i) => [i, 9])),
  dispatch: async (row) => { if (scheitern.has(row.companyId)) throw new Error("404"); versandt.push(row); },
});
const t = await s.triggerNow();
assert.deepEqual(seitenAbrufe, [1, 2], "ganze Firmenliste seitenweise");
const kandidaten = t.candidates.map((c) => c.companyId);
assert.ok(!kandidaten.includes("ANGEHALTEN") && !kandidaten.includes("GESCHLOSSEN"), "angehalten/geschlossen ausgenommen");
assert.equal(t.candidates[0].companyId, "KALT_ALT", "sehr alt schlaegt heiss: (40-7)/7=4,7 > (10-7)/7*3=1,3");
assert.equal(t.candidates[1].companyId, "HEISS", "heiss vor den normalen 8-Tage-Faellen");
assert.equal(relevanzFaktor(9), 3); assert.equal(relevanzFaktor(7), 2); assert.equal(relevanzFaktor(4), 1.5); assert.equal(relevanzFaktor(null), 1);
assert.ok(versandt.length > 0 && versandt.every((r) => r.transactionId), "Retry mit Transaktion");
// Fehlversuch: Zelle 24 h ruhen lassen
const dir2 = mkdtempSync(join(tmpdir(), "ava-fr2-"));
scheitern = new Set(["KALT_ALT"]);
const s2 = new FreshnessScheduler({ gateway, prefs: new FreshnessPrefsStore(dir2), cursor: new FreshnessCursorStore(dir2), now: () => jetzt, intervalMs: 0, dispatch: async (row) => { if (scheitern.has(row.companyId)) throw new Error("404"); } });
await s2.triggerNow();
const t2 = await s2.triggerNow();
assert.ok(!t2.candidates.some((c) => c.companyId === "KALT_ALT" && c.stage === "website"), "nach Fehlversuch 24 h Pause");
console.log("Auffrischung-Tests ok");
