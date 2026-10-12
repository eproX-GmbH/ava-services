import { test } from "node:test";
import assert from "node:assert/strict";
import { pruefungenJeStunde, Taktgeber } from "./takt";

test("Rate aus Einstellung: Standard, Grenzen, Rundung", () => {
  assert.equal(pruefungenJeStunde(undefined), 300);
  assert.equal(pruefungenJeStunde("abc"), 300);
  assert.equal(pruefungenJeStunde(0), 300);
  assert.equal(pruefungenJeStunde(3), 10);
  assert.equal(pruefungenJeStunde(99999), 3600);
  assert.equal(pruefungenJeStunde("120.4"), 120);
});

test("Taktgeber: bucht Bloecke, wartet bei erschoepfter Stunde bis alte Eintraege fallen", async () => {
  let t = 1_000_000;
  const schlaf: number[] = [];
  const takt = new Taktgeber(10, () => t, async (ms) => { schlaf.push(ms); t += ms; });
  await takt.warten(5);
  await takt.warten(5);
  assert.equal(takt.frei(), 0);
  assert.deepEqual(schlaf, [], "innerhalb der Rate kein Warten");
  await takt.warten(3);
  assert.equal(schlaf.length, 1, "einmal gewartet");
  assert.ok(t >= 1_000_000 + 3_600_000, "bis das Fenster alte Eintraege freigibt");
  assert.equal(takt.verbraucht(), 3);
  takt.setzeRate(2);
  assert.equal(takt.rate(), 10 > 2 ? 10 : 2, "unter dem Minimum wird auf 10 gehoben");
});
