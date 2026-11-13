import assert from "node:assert/strict";
// Die Module laden die Gateway-Umgebung: Platzhalter, es wird nichts verbunden.
for (const k of ["DATABASE_URL", "UPSTREAM_MASTER_DATA_URL", "UPSTREAM_COMPANY_PROFILE_URL", "UPSTREAM_COMPANY_CONTACT_URL", "UPSTREAM_COMPANY_PUBLICATION_URL", "UPSTREAM_WEBSITE_URL", "UPSTREAM_STRUCTURED_CONTENT_URL", "EVENT_BUS_URL", "JWKS_URI"]) process.env[k] ??= "http://127.0.0.1:9/test";
const V = await import("../src/lib/register-verlauf.ts");
const N = await import("../src/lib/neuigkeiten-cron.ts");
const M = await import("../src/lib/mail/vorlagen.ts");

// ---- Burggraben 1: Register-Snapshots nur bei echter Aenderung ---------------
const stand = (x = {}) => ({
  name: "Muster GmbH", legalForm: "GmbH", street: "Hauptstr.", houseNumber: "1", zipCode: "33602", city: "Bielefeld",
  foundingYear: 2001, corporatePurpose: "Maschinenbau", shareCapital: "25000", lastRegisterEntry: "2024-01-05", lastRegisterModification: "2025-03-01",
  geschaeftsfuehrung: [{ firstName: "Anna", lastName: "Beispiel" }, { firstName: "Kai", lastName: "Muster" }],
  ...x,
});
// Gleicher Stand, andere Schreibweise: kein Snapshot.
assert.deepEqual(V.registerStandFelder(stand(), stand({ name: "  muster   gmbh ", shareCapital: 25000, lastRegisterEntry: "2024-01-05T00:00:00.000Z", geschaeftsfuehrung: [{ firstName: "Kai", lastName: "Muster", birthDay: "1970-01-01" }, { firstName: "anna", lastName: "BEISPIEL" }] })), []);
// Kapitalerhoehung + Umzug + neuer GF: drei Felder.
assert.deepEqual(V.registerStandFelder(stand(), stand({ shareCapital: "100000", city: "Gütersloh", geschaeftsfuehrung: [{ firstName: "Anna", lastName: "Beispiel" }] })), ["address", "shareCapital", "geschaeftsfuehrung"]);
// Neuer Lauf ohne Gegenstand (leer): zaehlt als Aenderung, der alte Stand bleibt so erhalten.
assert.deepEqual(V.registerStandFelder(stand(), stand({ corporatePurpose: null })), ["corporatePurpose"]);
// Gruendungsjahr und Registerdatum.
assert.deepEqual(V.registerStandFelder(stand(), stand({ foundingYear: 2002, lastRegisterModification: "2026-11-01" })), ["foundingYear", "lastRegisterModification"]);

// ---- Burggraben 3: Cron-Entscheidung ------------------------------------------
const berlin = (s) => new Date(s);
// 08:00 Berlin (07:00Z im Winter), AVA seit 2 Tagen still, nie gemailt: senden.
assert.equal(N.cronEntscheidung({ jetzt: berlin("2026-11-12T07:00:00Z"), letzterVersand: null, appZuletztAt: berlin("2026-11-10T07:00:00Z") }).senden, true);
// Nachts: nicht senden.
assert.equal(N.cronEntscheidung({ jetzt: berlin("2026-11-12T01:00:00Z"), letzterVersand: null, appZuletztAt: null }).grund, "ausserhalb des Zeitfensters");
// AVA lief vor 3 Stunden: der Desktop-Takt mailt selbst.
assert.equal(N.cronEntscheidung({ jetzt: berlin("2026-11-12T07:00:00Z"), letzterVersand: null, appZuletztAt: berlin("2026-11-12T04:00:00Z") }).grund, "AVA des Nutzers laeuft");
// Vor 10 Stunden gemailt (egal von wem): zu frueh.
assert.equal(N.cronEntscheidung({ jetzt: berlin("2026-11-12T07:00:00Z"), letzterVersand: berlin("2026-11-11T21:00:00Z"), appZuletztAt: null }).grund, "zu frueh");
// Sommerzeit: 09:30 Berlin = 07:30Z.
assert.equal(N.cronEntscheidung({ jetzt: berlin("2026-07-12T07:30:00Z"), letzterVersand: null, appZuletztAt: null }).senden, true);
assert.equal(N.cronEntscheidung({ jetzt: berlin("2026-07-12T03:30:00Z"), letzterVersand: null, appZuletztAt: null }).senden, false);

// ---- Burggraben 3: Neuheiten → Meldungen (regelbasiert, ohne Urteil) ----------
const namen = new Map([["DE_1", "Muster GmbH"], ["DE_2", "Beispiel AG"]]);
const items = [
  { art: "new-contacts", id: "x", companyId: "DE_1", anzahl: 5, personen: [], occurredAt: "2026-11-11T10:00:00Z" },
  { art: "job-postings", id: "j", companyId: "DE_2", anzahl: 2, stellen: [{ title: "Vertriebsingenieur", location: "Bielefeld", benefits: [], sourceUrl: "https://beispiel.ag/jobs/1" }], leistungen: [], occurredAt: "2026-11-11T09:00:00Z" },
  { art: "publication", id: "p", companyId: "DE_2", name: "Jahresabschluss 2025", year: 2025, begin: null, end: null, employeeCount: 120, revenueVolume: { value: 15000000, currency: "EUR" }, salesVolume: null, totalAssetsVolume: null, stateOfAffairs: null, createdAt: "2026-11-10T09:00:00Z", updatedAt: "2026-11-10T09:00:00Z" },
  { art: "profile-change", id: "g", companyId: "DE_1", kind: "managing-directors", added: [{ firstName: "Neu", lastName: "Person" }], removed: [{ firstName: "Alt", lastName: "Person" }], occurredAt: "2026-11-11T08:00:00Z", bestandVon: "2026-10-01T00:00:00Z" },
  { art: "profile-change", id: "k", companyId: "DE_1", kind: "share-capital", added: [{ value: "100000" }], removed: [{ value: "25000" }], occurredAt: "2026-11-11T08:00:00Z", bestandVon: "2026-10-01T00:00:00Z" },
  { art: "contact-change", id: "c", companyId: "DE_2", typ: "job-changed", personName: "Erika Beispiel", title: "Leiterin Einkauf", before: "Einkäuferin", after: "Leiterin Einkauf", occurredAt: "2026-11-11T07:00:00Z", seit: null, bekanntSeit: null, vorherGesehenAm: null, quellen: [{ url: "https://beispiel.ag/team", titel: "Website" }] },
  { art: "new-customers", id: "n", companyId: "DE_1", anzahl: 1, kunden: [{ name: "Kunde X", art: "kunde", match: null, quelle: "https://muster.de/referenzen" }], occurredAt: "2026-11-11T06:00:00Z" },
];
const m = N.neuheitenZuMeldungen(items, namen);
// new-contacts bleibt draussen (ohne Urteil zu laut); Reihenfolge nach Gewicht.
assert.deepEqual(m.map((x) => x.art), ["Stammdaten", "Stammdaten", "Veröffentlichung", "Ansprechpartner", "Kunden", "Stellen"]);
assert.equal(m[0].firma, "Muster GmbH");
assert.equal(m[0].titel, "Geschäftsführung geändert");
assert.match(m[0].text, /Neu: Neu Person/);
assert.match(m[0].text, /Ausgeschieden: Alt Person/);
assert.equal(m[1].titel, "Stammkapital: 25000 → 100000");
assert.match(m[2].text, /120 Mitarbeitende/);
assert.equal(m[3].quelleUrl, "https://beispiel.ag/team");
assert.equal(m[5].quelleUrl, "https://beispiel.ag/jobs/1");
assert.ok(m.every((x) => x.companyId));
// Deckel 12 und unbekannter Name faellt auf die Kennung zurueck.
const viele = Array.from({ length: 20 }, (_, i) => ({ art: "publication", id: String(i), companyId: `DE_${i + 10}`, name: "JA", year: 2025, begin: null, end: null, employeeCount: null, revenueVolume: null, salesVolume: null, totalAssetsVolume: null, stateOfAffairs: null, createdAt: "2026-11-10T09:00:00Z", updatedAt: "2026-11-10T09:00:00Z" }));
const v = N.neuheitenZuMeldungen(viele, new Map());
assert.equal(v.length, 12);
assert.equal(v[0].firma, "DE_10");

// ---- Burggraben 4: Beitragszeile in der Neuigkeiten-Mail ----------------------
assert.equal(M.monatsName("2026-10"), "Oktober");
assert.equal(M.beitragSatz({ monat: "2026-10", abfragen: 1240, aenderungen: 37 }), "Dein Rechner hat im Oktober 1.240 Register-Abfragen beigetragen, daraus 37 Änderungen für alle AVA-Nutzer. Danke fürs Mithelfen.");
assert.match(M.beitragSatz({ monat: "2026-03", abfragen: 5, aenderungen: 1 }), /im März 5 Register-Abfragen beigetragen, daraus eine Änderung/);
const mail = M.neuigkeitenMail({ vorname: "Joyce", meldungen: [{ firma: "Muster GmbH", titel: "Geschäftsführung geändert", text: "", art: "Stammdaten", quelleUrl: null, companyId: "DE_X" }], beitrag: { monat: "2026-10", abfragen: 12, aenderungen: 0 }, appBasis: "https://app.ava.bi", abmeldenUrl: "https://x/abmelden" });
assert.match(mail.text, /im Oktober 12 Register-Abfragen/);
assert.match(mail.html, /im Oktober 12 Register-Abfragen/);
const ohne = M.neuigkeitenMail({ vorname: null, meldungen: [{ firma: "Muster GmbH", titel: "x", text: "", art: "Stammdaten", quelleUrl: null }], beitrag: { monat: "2026-10", abfragen: 0, aenderungen: 0 }, appBasis: "https://app.ava.bi", abmeldenUrl: "https://x/abmelden" });
assert.doesNotMatch(ohne.text, /Register-Abfragen/);

console.log("test-burggraben: ok");
