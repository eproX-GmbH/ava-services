// ChatGPT-Plugin (docs/PLAN_CHATGPT_PLUGIN.md): feste Werkzeugliste (Schnappschuss),
// Annotationen, Sperr-Hinweise und schlanke Antworten.
//
// Schnappschuss bewusst erneuern (= neue Plugin-Version, Release-Notiz noetig):
//   SCHNAPPSCHUSS_ERNEUERN=1 npm run test:mcp-plugin
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import P0 from "../src/lib/mcp-plugin.ts";
const P = P0.default ?? P0;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

console.log("ChatGPT-Plugin: Werkzeugliste");
const liste = P.pluginToolListe();
const datei = new URL("../plugin-chatgpt/werkzeuge.snapshot.json", import.meta.url);
if (process.env.SCHNAPPSCHUSS_ERNEUERN === "1" || !existsSync(datei)) {
  writeFileSync(datei, JSON.stringify(liste, null, 2) + "\n");
  console.log("  neu  Schnappschuss geschrieben");
}
pruefe("Liste entspricht dem eingereichten Schnappschuss", () => assert.deepEqual(liste, JSON.parse(readFileSync(datei, "utf8"))));
pruefe("Namen eindeutig", () => assert.equal(new Set(liste.map((t) => t.name)).size, liste.length));
pruefe("ohne Kopf-Relais und Recherche", () => {
  for (const n of ["recherche_anstossen", "ava_fragen", "werkzeug_suchen", "werkzeug_ausfuehren"]) assert.ok(!liste.some((t) => t.name === n), n);
});
for (const t of liste) {
  pruefe(`${t.name}: drei Annotationen gesetzt`, () => {
    for (const k of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof t.annotations[k], "boolean", k);
  });
  pruefe(`${t.name}: Beschreibung englisch, Titel kurz`, () => {
    assert.ok(!/[äöüß]/i.test(t.description + t.title), "Umlaut in Beschreibung/Titel");
    assert.ok(t.title.length <= 40);
    assert.ok(t.description.length >= 40);
  });
}
const schreibend = liste.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
pruefe("schreibend genau Notiz, Import, Neuverarbeitung", () => assert.deepEqual(schreibend, ["import_anlegen", "neu_verarbeiten", "protokoll_ablegen"]));
pruefe("zerstoererisch genau neu_verarbeiten (ueberschreibt eine Stufe, Richtlinie 6.3)", () =>
  assert.deepEqual(liste.filter((t) => t.annotations.destructiveHint).map((t) => t.name), ["neu_verarbeiten"]));
pruefe("Import und Neuverarbeitung offen (Websites, Register)", () => {
  assert.equal(liste.find((t) => t.name === "import_anlegen").annotations.openWorldHint, true);
  assert.equal(liste.find((t) => t.name === "neu_verarbeiten").annotations.openWorldHint, true);
});
pruefe("Annotationen auch fuer /mcp-Werkzeuge vollstaendig", () => {
  for (const n of ["recherche_anstossen", ...liste.map((t) => t.name)]) assert.ok(P.ANNOTATIONEN[n], n);
});

console.log("ChatGPT-Plugin: Freigaben");
const t = (n) => P.PLUGIN_TOOLS.find((x) => x.name === n);
const alles = { aktiv: true, lesen: true, auftraege: true, kontakte: true };
pruefe("alles frei → keine Sperre", () => assert.equal(P.pluginSperre(t("firma_kontakte"), alles), null));
pruefe("MCP aus → Hinweis auf Einstellungen", () => assert.match(P.pluginSperre(t("firma_lesen"), { ...alles, aktiv: false }), /Einstellungen → Organisation → MCP/));
pruefe("Kontakte aus → eigener Hinweis", () => assert.match(P.pluginSperre(t("firma_kontakte"), { ...alles, kontakte: false }), /Ansprechpartner/));
pruefe("Auftraege aus → Import gesperrt, Lesen frei", () => {
  assert.match(P.pluginSperre(t("import_anlegen"), { ...alles, auftraege: false }), /Aufträge/);
  assert.equal(P.pluginSperre(t("firma_lesen"), { ...alles, auftraege: false }), null);
});

console.log("ChatGPT-Plugin: schlanke Antworten");
pruefe("interne Felder weg, Zeit auf Tag, Leeres weg", () => {
  const s = P.saeubern({ tenantId: "t", actorId: "a", _x: 1, name: "ACME", createdAt: "2026-11-02T10:11:12.000Z", leer: [], nichts: null, tief: { traceId: "x", wert: 3, lastObsId: "o" } });
  assert.deepEqual(s, { name: "ACME", createdAt: "2026-11-02", tief: { wert: 3 } });
});
pruefe("Zahlenreihen > 200 weg", () => assert.deepEqual(P.saeubern({ v: Array.from({ length: 300 }, (_, i) => i), a: 1 }), { a: 1 }));
pruefe("companyId und transactionId bleiben (Folgeaufrufe)", () => {
  assert.deepEqual(P.saeubern({ companyId: "DE_X", verarbeitung: { transactionId: "tx1", stand: "laeuft" } }), { companyId: "DE_X", verarbeitung: { transactionId: "tx1", stand: "laeuft" } });
});

const roh = {
  id: "c1", companyName: "Werner GmbH", websiteUrl: "https://werner.de", createdAt: "2026-01-01T00:00:00Z",
  companyFacts: [
    { entityType: "PERSON", entityId: "p1", field: "fullName", value: "Max Schwer", status: "ACTIVE", companyId: "c1", lastSource: "https://werner.de/team", lastObsId: "o1", normalized: "max schwer" },
    { entityType: "PERSON", entityId: "p1", field: "email", value: "max.schwer@werner.de", status: "ACTIVE", companyId: "c1", lastSource: "pattern:vorname.nachname" },
    { entityType: "PERSON", entityId: "p1", field: "linkedinUrl", value: "https://linkedin.com/in/maxschwer", status: "ACTIVE", companyId: null },
    { entityType: "PERSON", entityId: "p2", field: "fullName", value: "Eva Alt", status: "ACTIVE", companyId: "c1" },
    { entityType: "PERSON", entityId: "p3", field: "fullName", value: "Ina Neu", status: "ACTIVE", companyId: "c1", lastSource: "https://werner.de/impressum" },
    { entityType: "PERSON", entityId: "p3", field: "email", value: "i.neu@werner.de", status: "ACTIVE", companyId: "c1", lastSource: "https://werner.de/impressum" },
    { entityType: "PERSON", entityId: "p3", field: "email", value: "alt@werner.de", status: "INACTIVE", companyId: "c1" },
    { entityType: "COMPANY", entityId: "c1", field: "phone", value: "+49 1", status: "ACTIVE", companyId: "c1" },
  ],
  companyObservations: [{ id: "o1", raw: "…" }],
  companySignals: [{ id: "s1" }],
  employments: [
    { personId: "p1", title: "Vertriebsleiter", department: "Vertrieb", isCurrent: true, startDate: "2025-03-01T00:00:00Z", firstSeen: "2025-04-01T00:00:00Z" },
    { personId: "p2", title: "Einkauf", isCurrent: false },
    { personId: "p3", title: "Geschäftsführerin", isCurrent: true },
  ],
  personNotices: [],
};
const k = P.kontakteSchlank(roh, "c1");
pruefe("Kontakte: nur aktuelle Personen, sortiert", () => assert.deepEqual(k.personen.map((p) => p.name), ["Ina Neu", "Max Schwer"]));
pruefe("Kontakte: Musteradresse als abgeleitet, gefundene als gefunden", () => {
  assert.equal(k.personen.find((p) => p.name === "Max Schwer").emailArt, "abgeleitet");
  assert.equal(k.personen.find((p) => p.name === "Ina Neu").emailArt, "gefunden");
  assert.equal(k.personen.find((p) => p.name === "Ina Neu").email, "i.neu@werner.de");
});
pruefe("Kontakte: Rolle, seit, Profil, Quelle", () => {
  const m = k.personen.find((p) => p.name === "Max Schwer");
  assert.deepEqual(m, { personId: "p1", name: "Max Schwer", rolle: "Vertriebsleiter", bereich: "Vertrieb", seit: "2025-03-01", email: "max.schwer@werner.de", emailArt: "abgeleitet", profil: "https://linkedin.com/in/maxschwer", quelle: "https://werner.de/team" });
});
pruefe("Kontakte: keine Rohfakten, Beobachtungen, Signale", () => {
  const s = JSON.stringify(k);
  for (const w of ["companyFacts", "companyObservations", "companySignals", "lastObsId", "normalized", "pattern:"]) assert.ok(!s.includes(w), w);
});

const matrix = { pageNumber: 1, pageSize: 50, count: 2, companies: [
  { held: true, companyId: "DE_1", name: "A GmbH", location: "Bielefeld", country: "DE", registerStatus: "ACTIVE", insolvencyStatus: "NONE", zustand: "aktiv", zugang: { x: 1 }, stages: { website: { state: "done", transactionId: "t" } } },
  { companyId: "DE_2", name: "B AG", location: "Wien", country: "AT", registerStatus: "CLOSED", insolvencyStatus: "OPENED", zustand: "ruhend", stages: {} },
] };
const mf = P.meineFirmenSchlank(matrix, (z) => (z.companyId === "DE_1" ? "vollstaendig" : "fehlt"));
pruefe("Meine Firmen: kompakt", () => assert.deepEqual(mf, { seite: 1, gesamt: 2, firmen: [
  { companyId: "DE_1", name: "A GmbH", ort: "Bielefeld", land: "DE", verarbeitung: "vollstaendig" },
  { companyId: "DE_2", name: "B AG", ort: "Wien", land: "AT", registerStatus: "CLOSED", insolvenz: "OPENED", ruhend: true, verarbeitung: "fehlt" },
] }));
pruefe("pluginAntwort liefert immer ein Objekt", () => {
  assert.deepEqual(P.pluginAntwort("auftraege", [{ id: "t1", tenantId: "x" }], {}, () => "x"), { ergebnis: [{ id: "t1" }] });
});

console.log("ChatGPT-Plugin: keine Plaene/Preise (Richtlinie 5.1)");
const ablehnung = { error: "kontingent_erschoepft", code: "kontingent_erschoepft", fehltCents: 150, passenNoch: ["DE_1"], passenNochAnzahl: 1,
  naechsterPlan: "pro", paygMoeglich: true, kannSelbstWechseln: true, plan: "free", kontingentCents: 500, verbrauchtCents: 450, benoetigtCents: 200,
  meldung: "Dein Kontingent reicht für 1 von 2 Firmen (0,50 € übrig, benötigt 2,00 €)." };
pruefe("Kontingent-Ablehnung neutral, ohne Plan und Betraege", () => {
  const a = P.saeubern({ companyId: "DE_2", aktivierung: { moeglich: false, ablehnung } });
  assert.deepEqual(a.aktivierung.ablehnung, { code: "kontingent_erschoepft", hinweis: "Das Firmen-Kontingent des AVA-Kontos reicht dafür nicht aus. Details stehen in der AVA-App.", passenNochAnzahl: 1, passenNoch: ["DE_1"] });
  assert.ok(!/plan|€|cents/i.test(JSON.stringify(a)), JSON.stringify(a));
});
pruefe("Firmen-Limit neutral", () => assert.match(P.saeubern({ code: "firmen_limit", meldung: "x" }).hinweis, /Firmen-Limit der Organisation/));
pruefe("Hinweis ruhende Firma ohne Planwechsel", () => {
  const h = "Die Firma ruht beim Nutzer: nur Grunddaten, keine Aufbereitung, keine Meldungen. Aktivieren in der AVA-App (Meine Firmen) oder mit import_anlegen (companyIds); reicht das Kontingent nicht, steht der Weg in aktivierung.ablehnung (Plan wechseln, ab Monatswechsel).";
  const s = P.saeubern({ hinweis: h }).hinweis;
  assert.ok(!/Plan/.test(s), s);
  assert.match(s, /sagt AVA das in der App\.$/);
});
pruefe("402-Fehlertext neutral, andere Fehler unveraendert", () => {
  assert.match(P.pluginFehlertext("Gateway 402: kontingent_erschoepft"), /Firmen-Kontingent/);
  assert.match(P.pluginFehlertext("Gateway 402: firmen_limit"), /Firmen-Limit/);
  assert.equal(P.pluginFehlertext("Gateway 404: nicht gefunden"), "Gateway 404: nicht gefunden");
});

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
