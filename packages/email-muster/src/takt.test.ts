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

test("Taktgeber: gleichmaessig gestreckt — erste Anfrage sofort, danach n x Abstand, kein Burst", async () => {
  let t = 1_000_000;
  const schlaf: number[] = [];
  const takt = new Taktgeber(300, () => t, async (ms) => { schlaf.push(ms); t += ms; });
  assert.equal(takt.abstandMs(), 12_000);
  await takt.warten(6);
  assert.deepEqual(schlaf, [], "erste Verbindung sofort");
  await takt.warten(6);
  assert.deepEqual(schlaf, [72_000], "zweite Verbindung erst nach 6 x 12 s");
  t += 100_000; // lange Pause: kein Nachholen in einem Burst
  await takt.warten(1);
  assert.equal(schlaf.length, 1, "nach Leerlauf sofort, aber nur eine Anfrage");
  await takt.warten(1);
  assert.equal(schlaf[1], 12_000);
  assert.equal(takt.verbraucht(), 14);
  takt.setzeRate(2);
  assert.equal(takt.rate(), 10, "unter dem Minimum wird auf 10 gehoben");
  assert.equal(takt.abstandMs(), 360_000);
});
