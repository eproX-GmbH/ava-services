import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leseEinstellungen } from "./einstellungen";

test("Schalter aus email-muster.json; fehlende Datei = Standard an; Feature aus schlaegt alles", () => {
  const dir = mkdtempSync(join(tmpdir(), "email-einst-"));
  const datei = join(dir, "email-muster.json");
  assert.deepEqual(leseEinstellungen(datei, true), { aktiv: true, zuordnungAktiv: true, ungeprueftSpeichern: true, pruefungenJeStunde: 300 });
  writeFileSync(datei, JSON.stringify({ enabled: false, zuordnungAktiv: false, ungeprueftAnzeigen: false, pruefungenJeStunde: 600 }));
  assert.deepEqual(leseEinstellungen(datei, true), { aktiv: false, zuordnungAktiv: false, ungeprueftSpeichern: false, pruefungenJeStunde: 600 });
  writeFileSync(datei, JSON.stringify({ pruefungenJeStunde: 1 }));
  assert.equal(leseEinstellungen(datei, true).pruefungenJeStunde, 10, "unter dem Minimum → 10");
  writeFileSync(datei, JSON.stringify({ enabled: true }));
  assert.equal(leseEinstellungen(datei, false).aktiv, false);
  writeFileSync(datei, "{kaputt");
  assert.equal(leseEinstellungen(datei, true).aktiv, true);
});
