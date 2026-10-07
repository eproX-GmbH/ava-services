import assert from "node:assert/strict";
const load = async (p) => { const m = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const { ordneDeterministisch, ordneFirmenadressen, beurteileMuster, vorlageAnwenden, bildeAdresseAllgemein } = await load("../src/main/contacts/email-muster/zuordnung.ts");

const personen = [
  { personId: "p1", fullName: "Patrick Dettlev" },
  { personId: "p2", fullName: "Henning Johnsen" },
  { personId: "p3", fullName: "Joyce Marvin Rafflenbeul" },
];
assert.equal(ordneDeterministisch("pdettlev@eprox-gmbh.de", personen)?.personId, "p1");
assert.equal(ordneDeterministisch("patrick@eprox-gmbh.de", personen)?.personId, "p1");
assert.equal(ordneDeterministisch("dettlev@eprox-gmbh.de", personen)?.personId, "p1");
assert.equal(ordneDeterministisch("p.dettlev@eprox-gmbh.de", personen)?.personId, "p1");
assert.equal(ordneDeterministisch("info@eprox-gmbh.de", personen), null);
assert.equal(ordneDeterministisch("rechnung@eprox-gmbh.de", personen), null);
const zwei = [{ personId: "a", fullName: "Anna Mueller" }, { personId: "b", fullName: "Bernd Müller" }];
assert.equal(ordneDeterministisch("mueller@firma.de", zwei), "mehrdeutig");
{
  const urteil = async () => JSON.stringify([{ email: "martin@martin-gmbh.de", art: "funktion", personId: null, begruendung: "Firmenname" }, { email: "xy@martin-gmbh.de", art: "person", personId: "m1", begruendung: "geraten" }]);
  const r = await ordneFirmenadressen({ firmenEmails: ["martin@martin-gmbh.de", "xy@martin-gmbh.de", "info@martin-gmbh.de"], personen: [{ personId: "m1", fullName: "Klaus Berger" }], firmenname: "Martin GmbH", urteil });
  assert.deepEqual(r.zuordnungen, []);
  assert.ok(r.funktion.includes("info@martin-gmbh.de") && r.funktion.includes("martin@martin-gmbh.de"));
  assert.ok(r.unklar.includes("xy@martin-gmbh.de"), "geratene Zuordnung ohne Namensbezug wird verworfen");
}
{
  const r = await ordneFirmenadressen({ firmenEmails: ["info@eprox-gmbh.de", "rechnung@eprox-gmbh.de", "pdettlev@eprox-gmbh.de"], personen, firmenname: "eproX GmbH", urteil: null });
  assert.equal(r.zuordnungen.length, 1);
  assert.equal(r.zuordnungen[0].personId, "p1");
  assert.equal(r.zuordnungen[0].wie, "deterministisch");
  assert.equal(r.funktion.length, 2);
}
{
  // Judge ordnet plausibel zu
  const urteil = async () => JSON.stringify([{ email: "hjohn@eprox-gmbh.de", art: "person", personId: "p2", begruendung: "Initial + Nachnamenanfang" }]);
  const r = await ordneFirmenadressen({ firmenEmails: ["hjohn@eprox-gmbh.de"], personen, firmenname: "eproX GmbH", urteil });
  assert.equal(r.zuordnungen[0]?.personId, "p2");
  assert.equal(r.zuordnungen[0]?.wie, "judge");
}
{
  const belege = [{ fullName: "Patrick Dettlev", email: "pdettlev@eprox-gmbh.de" }];
  const gut = await beurteileMuster({ domain: "eprox-gmbh.de", belege, alternativen: ["vnachname"], urteil: async () => '{"muster":"{v}{nachname}","baseline":"pdettlev@eprox-gmbh.de","begruendung":"Initial plus Nachname"}' });
  assert.equal(gut?.muster, "{v}{nachname}");
  assert.equal(gut?.baseline, "pdettlev@eprox-gmbh.de");
  const katalog = await beurteileMuster({ domain: "eprox-gmbh.de", belege, alternativen: ["vnachname"], urteil: async () => '{"muster":"vnachname","baseline":"pdettlev@eprox-gmbh.de","begruendung":"x"}' });
  assert.equal(katalog?.muster, "vnachname");
  const schlecht = await beurteileMuster({ domain: "eprox-gmbh.de", belege, alternativen: [], urteil: async () => '{"muster":"{vorname}.{nachname}","baseline":"pdettlev@eprox-gmbh.de","begruendung":"x"}' });
  assert.equal(schlecht, null);
  const kaputt = await beurteileMuster({ domain: "eprox-gmbh.de", belege, alternativen: [], urteil: async () => "keine Ahnung" });
  assert.equal(kaputt, null);
}
assert.equal(vorlageAnwenden("{v}{nachname}", "Joyce Marvin Rafflenbeul"), "jrafflenbeul");
assert.equal(bildeAdresseAllgemein("vnachname", "Henning Johnsen", "eprox-gmbh.de"), "hjohnsen@eprox-gmbh.de");
assert.equal(bildeAdresseAllgemein("{vorname}.{n}", "Henning Johnsen", "eprox-gmbh.de"), "henning.j@eprox-gmbh.de");
console.log("email-zuordnung: alle Pruefungen bestanden");
