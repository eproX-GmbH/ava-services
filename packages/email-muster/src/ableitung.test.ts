import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ermittleFirmenAdressen, type AbgeleiteteAdresse, type AbleitungDeps, type MusterSpeichern, type ServerMuster } from "./ableitung";
import { TagesBudget } from "./budget";
import type { FirmenKontakte } from "./kontakte";
import type { PruefDetails, PruefOptionen } from "./smtp-verify";

const PROBE = "ava-probe@muster.de";

/** Simulierter Mailserver: kennt `existiert`, oder nimmt alles an (catchAll), oder ist nicht erreichbar. */
function server(opts: { existiert?: string[]; catchAll?: boolean; gesperrt?: boolean; unbekannt?: boolean }) {
  const aufrufe: string[][] = [];
  const pruefe = async (_d: string, adressen: string[], o: PruefOptionen): Promise<Map<string, PruefDetails>> => {
    aufrufe.push([...adressen]);
    const out = new Map<string, PruefDetails>();
    const d = (ergebnis: PruefDetails["ergebnis"], code: number | null): PruefDetails => ({ ergebnis, mx: opts.gesperrt ? null : "mx.muster.de", code, antwort: null, dauerMs: 1 });
    if (opts.gesperrt) {
      for (const a of adressen) out.set(a, d("gesperrt", null));
      return out;
    }
    if (opts.catchAll && o.catchAllProbe) {
      for (const a of adressen) out.set(a, d("catch_all", 250));
      return out;
    }
    for (const a of adressen.slice(0, 5)) {
      if (opts.unbekannt) out.set(a, d("unbekannt", 450));
      else if (opts.existiert?.includes(a)) {
        out.set(a, d("existiert", 250));
        if (o.bisErsterTreffer) break;
      } else out.set(a, d("existiert_nicht", 550));
    }
    return out;
  };
  return { pruefe, aufrufe };
}

function kontakte(personen: Array<{ id: string; name: string; emails?: string[]; offen?: string[] }>, firmenEmails: string[] = []): FirmenKontakte {
  return {
    name: "Muster GmbH",
    websiteUrl: "https://www.muster.de",
    firmenEmails,
    personen: personen.map((p) => ({ personId: p.id, fullName: p.name, emails: p.emails ?? [], offeneEmails: p.offen ?? [] })),
  };
}

function deps(over: Partial<AbleitungDeps> & { serverMuster?: ServerMuster | null } = {}) {
  const gespeichert: AbgeleiteteAdresse[] = [];
  const geteilt: MusterSpeichern[] = [];
  const log: string[] = [];
  const d: AbleitungDeps = {
    netzOk: () => true,
    budget: new TagesBudget(null, 50),
    urteil: null,
    holeMuster: async () => over.serverMuster ?? null,
    speichereMuster: async (_dom, body) => {
      geteilt.push(body);
    },
    speichereAdresse: async (a) => {
      gespeichert.push(a);
      return "gespeichert";
    },
    log: (m) => log.push(m),
    probe: () => PROBE,
    jetzt: () => new Date("2026-10-11T12:00:00Z"),
    ...over,
  };
  return { d, gespeichert, geteilt, log };
}

const TEAM = [
  { id: "p1", name: "Anna Meier" },
  { id: "p2", name: "Bernd Kunz" },
  { id: "p3", name: "Jürgen Müller" },
];

test("ohne Beleg: Formate an EINER Person raten, Treffer auf alle anwenden", async () => {
  const s = server({ existiert: ["anna.meier@muster.de"] });
  const { d, gespeichert, geteilt } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(r.status, "fertig");
  assert.equal(r.muster, "vorname.nachname");
  assert.equal(r.musterHerkunft, "smtp");
  assert.equal(r.urteil, "verifiziert");
  assert.equal(s.aufrufe.length, 1, "genau eine SMTP-Verbindung");
  assert.equal(r.smtpAnfragen, 1, "nach dem ersten Treffer Schluss");
  const p1 = gespeichert.find((g) => g.personId === "p1")!;
  assert.equal(p1.art, "smtp");
  assert.equal(p1.smtpCode, 250);
  const p3 = gespeichert.find((g) => g.personId === "p3")!;
  assert.equal(p3.email, "juergen.mueller@muster.de");
  assert.equal(p3.art, "offen", "nicht einzeln geprueft");
  assert.match(p3.hinweis ?? "", /per SMTP bestaetigt/);
  assert.equal(p3.beleg, "anna.meier@muster.de");
  assert.equal(geteilt.length, 1);
  assert.equal(geteilt[0]!.muster, "vorname.nachname");
  assert.equal(geteilt[0]!.stats?.verifiziert, true);
});

test("Raten probiert der Reihe nach: vorname. → vorname → v.nachname", async () => {
  const s = server({ existiert: ["a.meier@muster.de"] });
  const { d } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(r.muster, "v.nachname");
  assert.deepEqual(s.aufrufe[0], ["anna.meier@muster.de", "anna@muster.de", "a.meier@muster.de", "meier@muster.de"]);
  assert.equal(r.smtpAnfragen, 3, "Treffer beim dritten RCPT");
});

test("mit Beleg: Muster aus dem Katalog, einmal am Repraesentanten bestaetigt", async () => {
  const s = server({ existiert: ["b.kunz@muster.de"] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte([{ id: "p0", name: "Hans Schmidt", emails: ["h.schmidt@muster.de"] }, ...TEAM.slice(1)]), d);
  assert.equal(r.muster, "v.nachname");
  assert.equal(r.musterHerkunft, "beleg");
  assert.equal(r.urteil, "verifiziert");
  assert.equal(s.aufrufe.length, 1);
  assert.equal(s.aufrufe[0]!.length, 1, "nur der Repraesentant, keine Stichprobe bei 2 Personen");
  assert.equal(gespeichert.length, 2);
  assert.equal(gespeichert.find((g) => g.personId === "p3")?.email, "j.mueller@muster.de");
  assert.equal(gespeichert.find((g) => g.personId === "p3")?.beleg, "h.schmidt@muster.de");
});

test("Stichprobe ab 5 Personen: zwei Adressen in derselben Verbindung", async () => {
  const viele = ["Anna Meier", "Bernd Kunz", "Clara Vogt", "Dieter Wolf", "Eva Roth"].map((name, i) => ({ id: `q${i}`, name }));
  const s = server({ existiert: ["anna.meier@muster.de", "bernd.kunz@muster.de"] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte([{ id: "p0", name: "Hans Schmidt", emails: ["hans.schmidt@muster.de"] }, ...viele]), d);
  assert.equal(r.urteil, "verifiziert");
  assert.equal(s.aufrufe.length, 1);
  assert.equal(s.aufrufe[0]!.length, 2);
  assert.equal(gespeichert.filter((g) => g.art === "smtp").length, 2);
  assert.equal(gespeichert.filter((g) => g.art === "offen").length, 3);
});

test("Stichprobe widerspricht dem Muster: neu raten statt blind anwenden", async () => {
  // Ein einzelner Beleg "hans@" spricht fuer "vorname"; der Server kennt aber vorname.nachname.
  const s = server({ existiert: ["bernd.kunz@muster.de"] });
  const { d, gespeichert, log } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte([{ id: "p0", name: "Hans Schmidt", emails: ["hans@muster.de"] }, { id: "p2", name: "Bernd Kunz" }]), d);
  assert.equal(r.muster, "vorname.nachname");
  assert.equal(r.musterHerkunft, "smtp");
  assert.equal(s.aufrufe.length, 2, "Bestaetigung + eine Rate-Runde");
  assert.deepEqual(s.aufrufe[0], ["bernd@muster.de"]);
  assert.ok(!s.aufrufe[1]!.includes("bernd@muster.de"), "abgelehnte Adresse nicht erneut");
  assert.equal(gespeichert[0]?.email, "bernd.kunz@muster.de");
  assert.equal(gespeichert[0]?.art, "smtp");
  assert.ok(log.some((l) => /widerlegt/.test(l)));
});

test("Catch-all: Muster aus Belegen als unbestaetigt, Befund geteilt", async () => {
  const s = server({ catchAll: true });
  const { d, gespeichert, geteilt } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte([{ id: "p0", name: "Hans Schmidt", emails: ["hans.schmidt@muster.de"] }, ...TEAM]), d);
  assert.equal(r.urteil, "catchall");
  assert.equal(r.smtpAnfragen, 1, "nur die Probe zaehlt");
  assert.ok(gespeichert.every((g) => g.art === "catchall"));
  assert.equal(geteilt[0]?.catchAll, true);
  assert.equal(geteilt[0]?.muster, "vorname.nachname");
});

test("Catch-all ohne Beleg: Annahme als unverifiziert, nur der Catch-all-Befund wird geteilt", async () => {
  const s = server({ catchAll: true });
  const { d, gespeichert, geteilt } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(r.musterHerkunft, "annahme");
  assert.ok(gespeichert.every((g) => g.art === "offen" && /Catch-all-Domain ohne Beleg/.test(g.hinweis ?? "")));
  assert.deepEqual(geteilt.map((g) => [g.muster, g.catchAll]), [[null, true]]);
});

test("bekannter Catch-all am Gateway: keine SMTP-Verbindung", async () => {
  const s = server({ catchAll: true });
  const { d, gespeichert } = deps({ pruefe: s.pruefe, serverMuster: { muster: "vorname.nachname", konfidenz: 0.85, catchAllAt: "2026-09-01T00:00:00Z", checkedAt: "2026-09-01T00:00:00Z" } });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(s.aufrufe.length, 0);
  assert.equal(r.musterHerkunft, "cache");
  assert.ok(gespeichert.every((g) => g.art === "catchall"));
});

test("frisch verifiziertes Muster am Gateway: anwenden ohne Pruefung", async () => {
  const s = server({});
  const { d, gespeichert, geteilt } = deps({ pruefe: s.pruefe, serverMuster: { muster: "v.nachname", konfidenz: 0.8, catchAllAt: null, checkedAt: "2026-10-01T00:00:00Z", stats: { verifiziert: true, baseline: "x.y@muster.de" } } });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(s.aufrufe.length, 0);
  assert.equal(r.urteil, "verifiziert");
  assert.equal(gespeichert.find((g) => g.personId === "p1")?.email, "a.meier@muster.de");
  assert.equal(geteilt.length, 0, "nichts Neues zu teilen");
});

test("Port 25 gesperrt: keine Pruefung, Annahme als unverifiziert", async () => {
  const s = server({});
  const { d, gespeichert, geteilt } = deps({ pruefe: s.pruefe, netzOk: () => false });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(s.aufrufe.length, 0);
  assert.equal(r.musterHerkunft, "annahme");
  assert.ok(gespeichert.every((g) => g.art === "offen" && /in diesem Netz nicht moeglich/.test(g.hinweis ?? "")));
  assert.equal(geteilt.length, 0, "eine Annahme wird nie geteilt");
});

test("Verbindung scheitert am Netz: gemeldet, alles offen", async () => {
  const s = server({ gesperrt: true });
  let gemeldet = "";
  const { d, gespeichert } = deps({ pruefe: s.pruefe, netzGesperrt: (g) => (gemeldet = g) });
  await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.ok(gemeldet);
  assert.equal(s.aufrufe.length, 1, "nach der Sperre keine zweite Verbindung");
  assert.ok(gespeichert.every((g) => g.art === "offen"));
});

test("Tages-Deckel erreicht: keine Pruefung, Grund im Hinweis", async () => {
  const s = server({ existiert: ["anna.meier@muster.de"] });
  const budget = new TagesBudget(null, 1);
  budget.verbrauche(1);
  const { d, gespeichert } = deps({ pruefe: s.pruefe, budget });
  await ermittleFirmenAdressen("c1", kontakte([{ id: "p0", name: "Hans Schmidt", emails: ["hans.schmidt@muster.de"] }, ...TEAM]), d);
  assert.equal(s.aufrufe.length, 0);
  assert.ok(gespeichert.every((g) => /Tages-Deckel/.test(g.hinweis ?? "")));
});

test("alle Formate abgelehnt: nichts ableiten", async () => {
  const s = server({ existiert: [] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(r.urteil, "kein_format");
  assert.equal(s.aufrufe.length, 2, "zwei Rate-Runden, dann Schluss");
  assert.equal(gespeichert.length, 0);
});

test("Firmenadresse mit Namen wird zugeordnet und zaehlt als Beleg", async () => {
  const s = server({ existiert: ["bkunz@muster.de"] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM, ["ameier@muster.de", "info@muster.de"]), d);
  assert.equal(r.muster, "vnachname");
  const anna = gespeichert.find((g) => g.personId === "p1")!;
  assert.equal(anna.herkunft, "zuordnung");
  assert.equal(anna.email, "ameier@muster.de");
  assert.equal(gespeichert.find((g) => g.personId === "p2")?.art, "smtp");
});

test("ohne Domain bzw. ohne unversorgte Personen: nichts zu tun", async () => {
  const { d } = deps();
  const ohneDomain = await ermittleFirmenAdressen("c1", { ...kontakte(TEAM), websiteUrl: null }, d);
  assert.equal(ohneDomain.status, "keine_domain");
  const versorgt = await ermittleFirmenAdressen("c1", kontakte([{ id: "p1", name: "Anna Meier", emails: ["anna.meier@muster.de"] }, { id: "p2", name: "Bernd Kunz", offen: ["bernd.kunz@muster.de"] }]), d);
  assert.equal(versorgt.status, "nichts_zu_tun");
});

test("Tages-Budget: zwei Prozesse zaehlen in dieselbe Datei, neuer Tag beginnt bei null", () => {
  const datei = join(mkdtempSync(join(tmpdir(), "email-budget-")), "budget.json");
  let tag = "2026-10-11";
  const a = new TagesBudget(datei, 5, () => tag);
  const b = new TagesBudget(datei, 5, () => tag);
  a.verbrauche(2);
  b.verbrauche(2);
  assert.equal(a.verbraucht(), 4);
  assert.equal(b.frei(), 1);
  tag = "2026-10-12";
  assert.equal(a.frei(), 5);
});
