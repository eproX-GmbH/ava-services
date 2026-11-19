// Netzgrafik der Verflechtungen (2026-11-19): radiales Layout ohne Ueberlappungen, Wurzel im Ursprung.
import assert from "node:assert/strict";
import L0 from "../src/renderer/src/lib/netz-layout.ts";
const L = L0.default ?? L0;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };
const W = "w";
const personen = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, typ: "PERSON", name: `Vorname Nachname ${i}`, tiefe: 1 }));
const netz = (n, firmen = false) => {
  const knoten = [{ id: W, typ: "FIRMA", name: "Berentzen-Gruppe Aktiengesellschaft", tiefe: 0 }, ...personen(n)];
  const kanten = personen(n).map((p) => ({ von: p.id, nach: W }));
  if (firmen) {
    knoten.push({ id: "f1", typ: "FIRMA", name: "Vivaris Getränke GmbH & Co. KG", tiefe: 1 }, { id: "f2", typ: "FIRMA", name: "Doornkaat AG", tiefe: 1 }, { id: "f3", typ: "FIRMA", name: "Pabst & Richarz Vertriebs GmbH", tiefe: 2 });
    kanten.push({ von: W, nach: "f1" }, { von: W, nach: "f2" }, { von: "f1", nach: "f3" });
  }
  return { knoten, kanten };
};
const ueberlappungen = (knoten, pos) => {
  const f = knoten.map((k) => L.flaeche(k, pos.get(k.id), k.id === W, k.name));
  let n = 0;
  for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) {
    const a = f[i], b = f[j];
    if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1) n++;
  }
  return n;
};
console.log("Netzgrafik: Layout");
pruefe("Wurzel im Ursprung, alle Knoten platziert", () => {
  const { knoten, kanten } = netz(13, true);
  const pos = L.radialLayout(knoten, kanten, W);
  assert.deepEqual(pos.get(W), { x: 0, y: 0 });
  assert.equal(pos.size, knoten.length);
});
for (const [n, firmen] of [[13, false], [13, true], [40, true], [3, false]]) {
  pruefe(`keine Ueberlappung: ${n} Personen${firmen ? " plus Firmen" : ""}`, () => {
    const { knoten, kanten } = netz(n, firmen);
    assert.equal(ueberlappungen(knoten, L.radialLayout(knoten, kanten, W)), 0);
  });
}
pruefe("deterministisch", () => {
  const { knoten, kanten } = netz(13, true);
  assert.deepEqual([...L.radialLayout(knoten, kanten, W)], [...L.radialLayout(knoten, kanten, W)]);
});
pruefe("Linie endet am Rand: Kreis und Kasten", () => {
  const k = L.randPunkt({ x: 0, y: 0 }, { x: 100, y: 0 }, { b: 22, h: 22 }, true);
  assert.ok(Math.abs(k.x - 12) < 0.01 && k.y === 0);
  const r = L.randPunkt({ x: 0, y: 0 }, { x: 100, y: 100 }, { b: 200, h: 30 }, false);
  assert.ok(Math.abs(r.y - 15) < 0.01 && Math.abs(r.x - 15) < 0.01);
});
pruefe("Beschriftung zeigt nach aussen", () => {
  assert.equal(L.labelLage({ x: 200, y: 10 }).anker, "start");
  assert.equal(L.labelLage({ x: -200, y: 10 }).anker, "end");
  assert.equal(L.labelLage({ x: 0, y: 150 }).anker, "middle");
});
console.log(fehler ? `\n${fehler} Fehler.` : "\nAlles gruen.");
process.exit(fehler ? 1 : 0);
