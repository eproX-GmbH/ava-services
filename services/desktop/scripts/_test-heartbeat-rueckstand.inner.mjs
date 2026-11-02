// Heartbeat-Rueckstand (2026-11-02, Befund Patrick "0 Kandidaten"): Fundstellen
// ueber maxPerTick hinaus werden in den Folgetakten abgearbeitet, bis alle
// beurteilt sind; nach einem Neustart laufen beurteilte Fundstellen nicht
// erneut durch das Modell; faellt das Modell aus, bleibt der Rest im Rueckstand.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as H from "../src/main/agent/heartbeat.ts";
import * as A from "../src/main/agent/alerts-store.ts";
import * as U from "../src/main/agent/heartbeat-urteile.ts";
import * as J from "../src/main/agent/alert-judge.ts";
import * as T from "../src/shared/meldungs-pruefung-text.ts";

const Heartbeat = H.Heartbeat ?? H.default?.Heartbeat;
const AlertsStore = A.AlertsStore ?? A.default?.AlertsStore;
const HeartbeatUrteile = U.HeartbeatUrteile ?? U.default?.HeartbeatUrteile;
const JudgeProviderUnavailable = J.JudgeProviderUnavailable ?? J.default?.JudgeProviderUnavailable;
const laufZusammenfassung = T.laufZusammenfassung ?? T.default?.laufZusammenfassung;

const ANZAHL = 50;
function fundstellen() {
  return Array.from({ length: ANZAHL }, (_, i) => ({
    kind: "profile-change",
    companyId: `FIRMA_${i}`,
    companyName: `Firma ${i}`,
    sourceRef: `profile-change:c-${String(i).padStart(2, "0")}`,
    occurredAt: "2026-11-01T10:00:00.000Z",
    summary: `Fundstelle ${i}`,
    payload: {},
  }));
}

function bauen({ dir, quelle, judge }) {
  const store = new AlertsStore(dir);
  store.probe();
  const urteile = new HeartbeatUrteile(dir);
  const hb = new Heartbeat({ store, urteile, intervalMs: 0, maxPerTick: 20, source: quelle, judge });
  return { hb, store, urteile };
}

const dir = mkdtempSync(join(tmpdir(), "ava-heartbeat-"));

// 1) Erster Lauf holt 50, beurteilt 20, 30 warten; zwei weitere Laeufe raeumen auf.
{
  let abrufe = 0;
  const quelle = async (since) => {
    abrufe += 1;
    return since === null ? fundstellen() : [];
  };
  const beurteilt = [];
  const judge = async (c) => {
    beurteilt.push(c.sourceRef);
    return c.sourceRef.endsWith("c-07")
      ? { worthAlerting: true, severity: "warn", headline: "Wechsel bei Firma 7", rationale: "Testgrund" }
      : { worthAlerting: false, severity: "info", headline: "", rationale: "Nicht wichtig" };
  };
  const { hb, store } = bauen({ dir, quelle, judge });

  const t1 = await hb.triggerNow();
  assert.equal(t1.skipped, false);
  assert.equal(t1.candidatesSeen, 50);
  assert.equal(t1.beurteilt, 20);
  assert.equal(t1.rueckstand, 30);
  assert.equal(t1.alertsCreated, 1);
  assert.equal(hb.getStatus().rueckstand, 30);
  assert.equal(laufZusammenfassung(t1), "50 neue Fundstellen · 20 bewertet · 1 neue Meldung · 30 warten auf den nächsten Lauf");

  const t2 = await hb.triggerNow();
  assert.equal(t2.candidatesSeen, 0, "Folgelauf: Fenster seit letztem Lauf, nichts Neues");
  assert.equal(t2.beurteilt, 20);
  assert.equal(t2.rueckstand, 10);
  assert.equal(laufZusammenfassung(t2), "keine neuen Fundstellen · 20 bewertet · 10 warten auf den nächsten Lauf");

  const t3 = await hb.triggerNow();
  assert.equal(t3.beurteilt, 10);
  assert.equal(t3.rueckstand, 0);

  const t4 = await hb.triggerNow();
  assert.equal(t4.beurteilt, 0);
  assert.equal(laufZusammenfassung(t4), "keine neuen Fundstellen · nichts zu bewerten");

  assert.equal(abrufe, 4);
  assert.equal(beurteilt.length, 50, "jede Fundstelle genau einmal beurteilt");
  assert.equal(new Set(beurteilt).size, 50);
  assert.equal(store.list().length, 1);
}

// 2) Neustart: dieselben 50 kommen wieder (30-Tage-Fenster), aber nichts laeuft
//    erneut durch das Modell — 1 bereits gemeldet, 49 schon beurteilt.
{
  let aufrufe = 0;
  const judge = async () => {
    aufrufe += 1;
    return { worthAlerting: false, severity: "info", headline: "", rationale: "" };
  };
  const { hb } = bauen({ dir, quelle: async () => fundstellen(), judge });
  const t = await hb.triggerNow();
  assert.equal(t.candidatesSeen, 50);
  assert.equal(t.duplicates, 1);
  assert.equal(t.bereitsBeurteilt, 49);
  assert.equal(t.beurteilt, 0);
  assert.equal(t.rueckstand, 0);
  assert.equal(aufrufe, 0, "Urteilsgedaechtnis spart alle Modellaufrufe");
  assert.equal(laufZusammenfassung(t), "50 neue Fundstellen · 1 bereits gemeldet · 49 schon früher bewertet");
}

// 3) Modell faellt mitten im Lauf aus: Rest bleibt im Rueckstand, der naechste
//    Lauf (Fenster unveraendert, Quelle liefert erneut) beurteilt ohne Doppelte.
{
  const dir2 = mkdtempSync(join(tmpdir(), "ava-heartbeat-"));
  let bereit = false;
  const gesehen = [];
  const judge = async (c) => {
    if (!bereit && gesehen.length >= 5) throw new JudgeProviderUnavailable("kein Modell");
    gesehen.push(c.sourceRef);
    return { worthAlerting: false, severity: "info", headline: "", rationale: "" };
  };
  let abrufeSince = [];
  const quelle = async (since) => {
    abrufeSince.push(since);
    return fundstellen().slice(0, 12);
  };
  const { hb } = bauen({ dir: dir2, quelle, judge });
  const t1 = await hb.triggerNow();
  assert.equal(t1.skipped, true);
  assert.equal(t1.reason, "kein Sprachmodell bereit");
  assert.equal(t1.beurteilt, 5);
  assert.equal(t1.rueckstand, 7);
  assert.equal(laufZusammenfassung(t1), "übersprungen (kein Sprachmodell bereit)");

  bereit = true;
  const t2 = await hb.triggerNow();
  assert.equal(abrufeSince[1], null, "nach Ausfall bleibt das Fenster offen");
  assert.equal(t2.skipped, false);
  assert.equal(t2.candidatesSeen, 12);
  assert.equal(t2.bereitsBeurteilt, 5);
  assert.equal(t2.beurteilt, 7);
  assert.equal(t2.rueckstand, 0);
  assert.equal(new Set(gesehen).size, 12);
  assert.equal(gesehen.length, 12, "keine Fundstelle doppelt beurteilt");
}

console.log("Heartbeat-Rueckstand-Tests ok");
