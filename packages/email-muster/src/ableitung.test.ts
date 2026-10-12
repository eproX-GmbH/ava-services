import { test } from "node:test";
import assert from "node:assert/strict";
import { ermittleFirmenAdressen, type AbgeleiteteAdresse, type AbleitungDeps, type MusterSpeichern, type ServerMuster } from "./ableitung";
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
  assert.equal(s.aufrufe.length, 2, "Rate-Runde + Einzelpruefung der uebrigen Adressen");
  assert.equal(r.smtpAnfragen, 1 + 2, "Treffer, dann die beiden anderen Adressen einzeln");
  const p1 = gespeichert.find((g) => g.personId === "p1")!;
  assert.equal(p1.art, "smtp");
  assert.equal(p1.smtpCode, 250);
  const p3 = gespeichert.find((g) => g.personId === "p3")!;
  assert.equal(p3.email, "juergen.mueller@muster.de");
  assert.equal(p3.art, "abgelehnt", "einzeln geprueft: der Testserver kennt sie nicht");
  assert.equal(p3.smtpCode, 550);
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
  assert.equal(r.smtpAnfragen, 3 + 2, "Treffer beim dritten RCPT, danach zwei Einzelpruefungen");
});

test("mit Beleg: Muster aus dem Katalog, einmal am Repraesentanten bestaetigt", async () => {
  const s = server({ existiert: ["b.kunz@muster.de"] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte([{ id: "p0", name: "Hans Schmidt", emails: ["h.schmidt@muster.de"] }, ...TEAM.slice(1)]), d);
  assert.equal(r.muster, "v.nachname");
  assert.equal(r.musterHerkunft, "beleg");
  assert.equal(r.urteil, "verifiziert");
  assert.equal(s.aufrufe.length, 2, "Bestaetigung + Einzelpruefung der zweiten Person");
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
  assert.equal(s.aufrufe.length, 2, "Stichprobe + Einzelpruefung der uebrigen drei");
  assert.equal(s.aufrufe[0]!.length, 2);
  assert.equal(gespeichert.filter((g) => g.art === "smtp").length, 2);
  assert.equal(gespeichert.filter((g) => g.art === "abgelehnt").length, 3, "einzeln geprueft, vom Testserver abgelehnt");
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

test("frisch verifiziertes Muster am Gateway: Muster uebernehmen, Adressen trotzdem einzeln pruefen", async () => {
  const s = server({ existiert: ["a.meier@muster.de"] });
  const { d, gespeichert, geteilt } = deps({ pruefe: s.pruefe, serverMuster: { muster: "v.nachname", konfidenz: 0.8, catchAllAt: null, checkedAt: "2026-10-01T00:00:00Z", stats: { verifiziert: true, baseline: "x.y@muster.de" } } });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(s.aufrufe.length, 1, "keine Muster-Bestaetigung, nur die Einzelpruefung");
  assert.equal(r.urteil, "verifiziert");
  assert.equal(gespeichert.find((g) => g.personId === "p1")?.email, "a.meier@muster.de");
  assert.equal(gespeichert.find((g) => g.personId === "p1")?.art, "smtp");
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

test("alle Formate abgelehnt: nichts ableiten", async () => {
  const s = server({ existiert: [] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(r.urteil, "kein_format");
  assert.equal(s.aufrufe.length, 2, "zwei Rate-Runden, dann Schluss");
  assert.equal(gespeichert.length, 0);
});

test("bekannter Befund 'kein Format': nicht erneut raten", async () => {
  const s = server({ existiert: [] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe, serverMuster: { muster: null, konfidenz: 0, catchAllAt: null, checkedAt: "2026-10-10T00:00:00Z", stats: { keinFormat: true } } });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(r.urteil, "kein_format");
  assert.equal(s.aufrufe.length, 0);
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
  const versorgt = await ermittleFirmenAdressen("c1", kontakte([{ id: "p1", name: "Anna Meier", emails: ["anna.meier@muster.de"] }, { id: "p2", name: "Bernd Kunz", emails: ["bernd.kunz@muster.de"] }]), d);
  assert.equal(versorgt.status, "nichts_zu_tun");
});

test("bisher offene Ableitung wird im Lauf einzeln nachgeprueft und bei Treffer als verifiziert gespeichert", async () => {
  const s = server({ existiert: ["bernd.kunz@muster.de"] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe, serverMuster: { muster: "vorname.nachname", konfidenz: 0.8, catchAllAt: null, checkedAt: "2026-10-01T00:00:00Z", stats: { verifiziert: true } } });
  const r = await ermittleFirmenAdressen("c1", kontakte([{ id: "p1", name: "Anna Meier", emails: ["anna.meier@muster.de"] }, { id: "p2", name: "Bernd Kunz", offen: ["bernd.kunz@muster.de"] }, { id: "p3", name: "Clara Vogt", offen: ["clara.vogt@muster.de"] }]), d);
  assert.equal(r.status, "fertig");
  assert.deepEqual(s.aufrufe, [["bernd.kunz@muster.de", "clara.vogt@muster.de"]]);
  assert.deepEqual(gespeichert.map((g) => [g.personId, g.art]), [["p2", "smtp"], ["p3", "abgelehnt"]]);
});

test("Einstellungen: ohne Zuordnung und ohne unverifizierte Adressen", async () => {
  const s = server({ existiert: ["bkunz@muster.de"] });
  const { d, gespeichert } = deps({ pruefe: s.pruefe, zuordnungAktiv: false, ungeprueftSpeichern: false });
  await ermittleFirmenAdressen("c1", kontakte(TEAM, ["ameier@muster.de"]), d);
  assert.ok(!gespeichert.some((g) => g.herkunft === "zuordnung"), "keine Zuordnung");
  assert.ok(gespeichert.every((g) => g.art === "smtp" || g.art === "catchall"), "nur belegte Adressen");
});

test("Domain ohne Mailserver: kein 'kein Format', Adressen offen mit Grund, nichts geteilt", async () => {
  const pruefe = async (_d: string, adressen: string[]): Promise<Map<string, PruefDetails>> =>
    new Map(adressen.map((a) => [a, { ergebnis: "keine_mx" as const, mx: null, code: null, antwort: "Domain hat keinen Mailserver (kein MX-/A-Eintrag)", dauerMs: 1 }]));
  const { d, gespeichert, geteilt } = deps({ pruefe });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.notEqual(r.urteil, "kein_format");
  assert.equal(r.musterHerkunft, "annahme");
  assert.ok(gespeichert.length > 0 && gespeichert.every((g) => g.art === "offen" && /keinen Mailserver/.test(g.hinweis ?? "")));
  assert.equal(geteilt.length, 0, "ohne Mailserver wird kein Befund geteilt");
  assert.equal(r.smtpAnfragen, 0, "ohne MX zaehlt keine Anfrage gegen den Deckel");
});

test("einzelner Mailserver nicht erreichbar, Port 25 sonst offen: keine Netzsperre", async () => {
  const s = server({ gesperrt: true });
  let gemeldet = "";
  const { d, gespeichert } = deps({ pruefe: s.pruefe, netzGesperrt: (g) => (gemeldet = g), netzPruefe: async () => true });
  await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(gemeldet, "", "Gegenprobe ok → nicht das Netz sperren");
  assert.equal(s.aufrufe.length, 1);
  assert.ok(gespeichert.every((g) => g.art === "offen" && /Mailserver der Domain/.test(g.hinweis ?? "")));
});

test("Gegenprobe scheitert auch: Netzsperre wie bisher", async () => {
  const s = server({ gesperrt: true });
  let gemeldet = "";
  const { d } = deps({ pruefe: s.pruefe, netzGesperrt: (g) => (gemeldet = g), netzPruefe: async () => false });
  await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.ok(gemeldet);
});

test("Speichern scheitert technisch bei allen Adressen: status fehler", async () => {
  const s = server({ existiert: ["anna.meier@muster.de"] });
  const protokoll: string[] = [];
  const { d } = deps({
    pruefe: s.pruefe,
    speichereAdresse: async () => {
      throw new Error("gateway 503");
    },
    protokoll: (e) => protokoll.push(`${e.adresse.email}:${e.ergebnis}`),
  });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(r.status, "fehler");
  assert.match(r.zusammenfassung, /gateway 503/);
  assert.equal(r.speicherFehler, 3);
  assert.ok(protokoll.every((p) => p.endsWith(":fehler")));
});

test("Gateway weist ab (kein Fehler): status fertig, abgewiesen gezaehlt", async () => {
  const s = server({ existiert: ["anna.meier@muster.de"] });
  const { d } = deps({ pruefe: s.pruefe, speichereAdresse: async () => "abgewiesen" });
  const r = await ermittleFirmenAdressen("c1", kontakte(TEAM), d);
  assert.equal(r.status, "fertig");
  assert.equal(r.abgewiesen, 3);
});
