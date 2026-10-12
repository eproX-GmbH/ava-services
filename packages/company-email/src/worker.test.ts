import { test } from "node:test";
import assert from "node:assert/strict";
import { type AbleitungsErgebnis, type ermittleFirmenAdressen } from "@ava/email-muster";
import type { GatewayClient } from "./gateway";
import type { ProgressEingabe } from "./progress";
import { makeWorker, type TriggerEreignis } from "./worker";

const ERGEBNIS: AbleitungsErgebnis = {
  status: "fertig",
  domain: "muster.de",
  muster: "vorname.nachname",
  musterHerkunft: "smtp",
  urteil: "verifiziert",
  baseline: "anna.meier@muster.de",
  smtpVerbindungen: 1,
  smtpAnfragen: 1,
  gespeichert: 2,
  vorhanden: 0,
  abgewiesen: 0,
  speicherFehler: 0,
  letzterFehler: null,
  arten: { smtp: 1, catchall: 0, offen: 1, abgelehnt: 0 },
  zusammenfassung: "Muster GmbH (muster.de): 1 verifiziert, 1 abgeleitet",
};

function gateway(over: Partial<GatewayClient> = {}): GatewayClient {
  return {
    holeKontakte: async () => ({ companyName: "Muster GmbH", websiteUrl: null, companyFacts: [] }),
    holeStand: async () => ({ "company-contact": { updatedAt: "2026-10-11T12:00:10Z" } }),
    holeMuster: async () => null,
    speichereMuster: async () => undefined,
    speichereAdresse: async () => "gespeichert",
    ...over,
  };
}

function aufbau(over: { gateway?: GatewayClient; ableiten?: typeof ermittleFirmenAdressen; persistWartenMs?: number } = {}) {
  const progress: ProgressEingabe[] = [];
  const aufrufe: Array<{ companyId: string; websiteUrl: string | null; name: string }> = [];
  let uhr = Date.parse("2026-10-11T12:00:00Z");
  const geschlafen: number[] = [];
  const verarbeite = makeWorker({
    gateway: over.gateway ?? gateway(),
    netz: { ok: () => true, aktualisiere: async () => undefined, gesperrt: () => undefined },
    urteil: null,
    persistWartenMs: over.persistWartenMs ?? 30_000,
    progress: async (p) => {
      progress.push(p);
    },
    ableiten:
      over.ableiten ??
      (async (companyId, k) => {
        aufrufe.push({ companyId, websiteUrl: k.websiteUrl, name: k.name });
        return ERGEBNIS;
      }),
    schlafe: async (ms) => {
      geschlafen.push(ms);
      uhr += ms;
    },
    jetzt: () => uhr,
  });
  return { verarbeite, progress, aufrufe, geschlafen };
}

const TRIGGER: TriggerEreignis = {
  subject: "c1",
  transaction: "t1",
  data: { companyName: "Muster GmbH", url: "https://muster.de", kontakteGeaendert: true, contactRunAt: "2026-10-11T12:00:00Z" },
};

test("Trigger: Kontakte lesen, ableiten, completed melden; Website aus dem Trigger als Rueckfall", async () => {
  const { verarbeite, progress, aufrufe } = aufbau();
  assert.equal(await verarbeite(TRIGGER), "completed");
  assert.deepEqual(progress.map((p) => p.state), ["in_progress", "completed"]);
  assert.equal(aufrufe[0]?.websiteUrl, "https://muster.de");
  assert.equal(aufrufe[0]?.name, "Muster GmbH");
});

test("wartet, bis das Gateway den Contact-Lauf verarbeitet hat", async () => {
  let n = 0;
  const g = gateway({ holeStand: async () => ({ "company-contact": { updatedAt: ++n < 3 ? "2026-10-10T00:00:00Z" : "2026-10-11T12:00:30Z" } }) });
  const { verarbeite, geschlafen } = aufbau({ gateway: g });
  assert.equal(await verarbeite(TRIGGER), "completed");
  assert.equal(geschlafen.length, 2);
});

test("Persist bleibt aus: nach der Frist mit dem aktuellen Stand weiter", async () => {
  const g = gateway({ holeStand: async () => ({ "company-contact": { updatedAt: null } }) });
  const { verarbeite, geschlafen } = aufbau({ gateway: g, persistWartenMs: 30_000 });
  assert.equal(await verarbeite(TRIGGER), "completed");
  assert.equal(geschlafen.reduce((a, b) => a + b, 0), 30_000);
});

test("uebersprungener Contact-Lauf: kein Warten", async () => {
  let gefragt = 0;
  const g = gateway({ holeStand: async () => (gefragt++, null) });
  const { verarbeite } = aufbau({ gateway: g });
  assert.equal(await verarbeite({ ...TRIGGER, data: { ...TRIGGER.data, kontakteGeaendert: false } }), "completed");
  assert.equal(gefragt, 0);
});

test("nichts zu tun → skipped mit Grund", async () => {
  const { verarbeite, progress } = aufbau({ ableiten: async () => ({ ...ERGEBNIS, status: "nichts_zu_tun", zusammenfassung: "alle Personen haben bereits eine Adresse" }) });
  assert.equal(await verarbeite(TRIGGER), "skipped");
  assert.equal(progress.at(-1)?.state, "skipped");
  assert.match(progress.at(-1)?.errorMessage ?? "", /bereits eine Adresse/);
});

test("Fehler bleibt in der E-Mail-Stufe → failed", async () => {
  const g = gateway({ holeKontakte: async () => Promise.reject(new Error("gateway /contacts: status 503")) });
  const { verarbeite, progress } = aufbau({ gateway: g });
  assert.equal(await verarbeite(TRIGGER), "failed");
  assert.equal(progress.at(-1)?.state, "failed");
  assert.match(progress.at(-1)?.errorMessage ?? "", /503/);
});

test("Doppel-Dispatch desselben runId wird verworfen; ungueltige Trigger auch", async () => {
  let freigeben: () => void = () => undefined;
  const { verarbeite } = aufbau({
    ableiten: () =>
      new Promise((r) => {
        freigeben = () => r(ERGEBNIS);
      }),
  });
  const erster = verarbeite({ ...TRIGGER, data: { ...TRIGGER.data, kontakteGeaendert: false } });
  await new Promise((r) => setImmediate(r));
  assert.equal(await verarbeite({ ...TRIGGER, data: { ...TRIGGER.data, kontakteGeaendert: false } }), "duplikat");
  freigeben();
  assert.equal(await erster, "completed");
  assert.equal(await verarbeite({ data: {} }), "ungueltig");
});

test("ausgeschaltet (Person oder Organisation): skipped, keine Ableitung", async () => {
  const progress: ProgressEingabe[] = [];
  let abgeleitet = false;
  const verarbeite = makeWorker({
    gateway: gateway(),
    netz: { ok: () => true, aktualisiere: async () => undefined, gesperrt: () => undefined },
    urteil: null,
    persistWartenMs: 0,
    einstellungen: () => ({ aktiv: false, zuordnungAktiv: true, ungeprueftSpeichern: true }),
    progress: async (p) => {
      progress.push(p);
    },
    ableiten: async () => {
      abgeleitet = true;
      return ERGEBNIS;
    },
  });
  assert.equal(await verarbeite(TRIGGER), "skipped");
  assert.equal(abgeleitet, false);
  assert.match(progress.at(-1)?.errorMessage ?? "", /ausgeschaltet/);
});

test("Ableitung meldet 'fehler' (nichts gespeichert): Stufe failed mit Grund", async () => {
  const { verarbeite, progress } = aufbau({
    ableiten: async () => ({ ...ERGEBNIS, status: "fehler", gespeichert: 0, speicherFehler: 2, letzterFehler: "gateway 503", zusammenfassung: "Muster GmbH (muster.de): 2 Adresse(n) konnten nicht gespeichert werden — gateway 503" }),
  });
  const ausgang = await verarbeite({ subject: "c1", transaction: "t1", data: { companyName: "Muster GmbH", kontakteGeaendert: false } });
  assert.equal(ausgang, "failed");
  const letzter = progress.at(-1)!;
  assert.equal(letzter.state, "failed");
  assert.match(letzter.errorMessage ?? "", /gateway 503/);
});

test("Trigger mit kaputten Nutzdaten wird verworfen", async () => {
  const { verarbeite, progress } = aufbau();
  const ausgang = await verarbeite({ subject: "c1", transaction: "t1", data: { kontakteGeaendert: "ja" as never } });
  assert.equal(ausgang, "ungueltig");
  assert.equal(progress.length, 0);
});
