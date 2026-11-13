// Burggraben-Punkt 4: Mithelfen-Standard aus dem Sitz, Beitragszeile fuer die Mail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import S from "../src/main/register-delta/settings-store.ts";
import M from "../src/main/onboarding/neuigkeiten-mail.ts";
const { MithelfenSettingsStore } = S;
const { beitragFuerMail, vormonatKennung } = M;

// ---- Standard aus dem Sitz --------------------------------------------------
let sitz = null;
const dir = mkdtempSync(join(tmpdir(), "mithelfen-"));
const store = new MithelfenSettingsStore(dir, () => sitz);
// Sitz unbekannt: aus, Quelle Standard.
assert.equal(store.get().aktiv, false);
assert.equal(store.quelle(), "standard");
// Free: aus.
sitz = false;
assert.equal(store.get().aktiv, false);
// Bezahlter Sitz: an, ohne dass etwas gespeichert wurde.
sitz = true;
assert.equal(store.get().aktiv, true);
assert.equal(store.quelle(), "standard");
assert.equal(store.standardWert(), true);
assert.equal(store.get().nurNetzbetrieb, true, "Akku schonen bleibt Standard an");
// Nutzer schaltet aus: gilt dauerhaft, auch mit bezahltem Sitz.
store.set({ aktiv: false });
assert.equal(store.get().aktiv, false);
assert.equal(store.quelle(), "nutzer");
assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).aktiv, false);
// Neu geladen: die Entscheidung bleibt.
const wieder = new MithelfenSettingsStore(dir, () => true);
assert.equal(wieder.get().aktiv, false);
assert.equal(wieder.quelle(), "nutzer");
// Nutzer schaltet ein, danach Free: bleibt an (Nutzerentscheidung).
wieder.set({ aktiv: true });
const free = new MithelfenSettingsStore(dir, () => false);
assert.equal(free.get().aktiv, true);
assert.equal(free.quelle(), "nutzer");
// Andere Felder aendern setzt `aktiv` nicht fest.
const dir2 = mkdtempSync(join(tmpdir(), "mithelfen-"));
const nur = new MithelfenSettingsStore(dir2, () => true);
nur.set({ nurNetzbetrieb: false });
assert.equal(nur.quelle(), "standard");
assert.equal(nur.get().aktiv, true);
assert.equal(nur.get().nurNetzbetrieb, false);

// ---- Beitragszeile in der Mail ---------------------------------------------
assert.equal(vormonatKennung(new Date("2026-11-13T07:00:00Z")), "2026-10");
assert.equal(vormonatKennung(new Date("2026-01-02T00:00:00Z")), "2025-12");
const beitrag = (vormonat) => ({ geraete: 1, monat: { monat: "2026-11", jobs: 3, abfragen: 40, treffer: 30, neu: 1, geaendert: 2 }, vormonat, gesamt: { jobs: 50, abfragen: 900 } });
assert.equal(beitragFuerMail(null, "2026-10"), null);
assert.equal(beitragFuerMail(beitrag({ monat: "2026-10", jobs: 0, abfragen: 0, treffer: 0, neu: 0, geaendert: 0 }), "2026-10"), null, "ohne Abfragen keine Zeile");
assert.equal(beitragFuerMail(beitrag({ monat: "2026-09", jobs: 5, abfragen: 100, treffer: 80, neu: 2, geaendert: 3 }), "2026-10"), null, "anderer Monat zaehlt nicht");
assert.deepEqual(beitragFuerMail(beitrag({ monat: "2026-10", jobs: 40, abfragen: 1240, treffer: 1100, neu: 12, geaendert: 25 }), "2026-10"), { monat: "2026-10", abfragen: 1240, aenderungen: 37 });

console.log("test-mithelfen: ok");
