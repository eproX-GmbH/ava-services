// Prueft, was aus einem Werkzeugaufruf als Relevanz-Signal herausfaellt
// (docs/PLAN_RELEVANZ.md, 3.4).
//
// Der wichtigste Fall ist die Listenfalle: Wer eine Uebersicht mit fuenfzig
// Firmen aufruft, hat nicht an jedem Eintrag Interesse. Faellt diese
// Schranke, wird der Wert wertlos — dann ist alles gleich warm.

import assert from "node:assert/strict";
// Die App uebersetzt nach CommonJS, deshalb liegen die Exporte am
// Standard-Export und nicht als benannte.
import W from "../src/main/relevanz/aus-werkzeugen.ts";
const { ausArgumenten, ausErgebnis, ausAufruf, TREFFER_GRENZE } = W;
import G from "../src/main/relevanz/gewicht.ts";
const { gewichtFuer } = G;
import R from "../src/main/relevanz/reihenfolge.ts";
const { reihenfolge, alterung } = R;
import A from "../src/main/relevanz/alarmweg.ts";
const { alarmweg } = A;

let fehler = 0;
function pruefe(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); }
}

console.log("Argumente");

pruefe("companyId im Aufruf zaehlt", () => {
  const f = ausArgumenten({ companyId: "DE-371273" });
  assert.deepEqual(f, [{ zielArt: "firma", zielId: "DE-371273" }]);
});

pruefe("Schreibweisen: company_id, firmaId", () => {
  assert.equal(ausArgumenten({ company_id: "DE-1001" }).length, 1);
  assert.equal(ausArgumenten({ firmaId: "DE-1001" }).length, 1);
});

pruefe("Mehrzahl und Verschachtelung", () => {
  assert.equal(ausArgumenten({ companyIds: ["DE-1001", "DE-1002"] }).length, 2);
  assert.equal(ausArgumenten({ filter: { companyId: "DE-1001" } }).length, 1);
});

pruefe("personId wird als Person erkannt", () => {
  assert.deepEqual(ausArgumenten({ personId: "per-1001" }), [{ zielArt: "person", zielId: "per-1001" }]);
});

pruefe("Unfug wird nicht zur ID", () => {
  assert.equal(ausArgumenten({ companyId: "" }).length, 0);
  assert.equal(ausArgumenten({ companyId: "Zimmer Group GmbH" }).length, 0, "Namen sind keine IDs");
  assert.equal(ausArgumenten({ companyId: "https://example.org/x" }).length, 0);
  assert.equal(ausArgumenten({ name: "DE-371273" }).length, 0, "falscher Schluessel");
});

pruefe("sehr kurze Werte gelten nicht als ID", () => {
  // Absicht: "A1" oder "12" stehen in Argumenten viel zu oft fuer etwas
  // anderes. Lieber ein Signal verpassen als eines erfinden.
  assert.equal(ausArgumenten({ companyId: "A1" }).length, 0);
});

pruefe("kein endloses Graben", () => {
  let tief = { companyId: "TIEF" };
  for (let i = 0; i < 30; i++) tief = { a: tief };
  assert.doesNotThrow(() => ausArgumenten(tief));
});

console.log("Ergebnis");

pruefe("ein Treffer im Ergebnis zaehlt", () => {
  assert.deepEqual(ausErgebnis("Gefunden: [Zimmer](company:DE-371273)"),
    [{ zielArt: "firma", zielId: "DE-371273" }]);
});

pruefe(`bis ${TREFFER_GRENZE} Treffer zaehlen`, () => {
  const t = "company:DE-1001 company:DE-1002 company:DE-1003";
  assert.equal(ausErgebnis(t).length, 3);
});

pruefe("mehr Treffer = Liste = nichts", () => {
  const liste = Array.from({ length: 50 }, (_, i) => `company:DE-10${String(i).padStart(2, "0")}`).join(" ");
  assert.equal(ausErgebnis(liste).length, 0,
    "eine Uebersicht darf keine fuenfzig Signale erzeugen");
});

pruefe("dieselbe Firma mehrfach genannt bleibt ein Treffer", () => {
  assert.equal(ausErgebnis("company:DE-1001 ... company:DE-1001 ... company:DE-1001").length, 1);
});

console.log("Zusammenspiel");

pruefe("Argumente und Ergebnis zusammen, ohne Doppel", () => {
  const f = ausAufruf({ companyId: "DE-1001" }, "[X](company:DE-1001)");
  assert.equal(f.length, 1);
});

pruefe("Person bekommt die Firma mit, wenn genau eine im Spiel ist", () => {
  const f = ausAufruf({ companyId: "DE-1001", personId: "per-1001" }, "");
  const person = f.find((x) => x.zielArt === "person");
  assert.equal(person.firmaId, "DE-1001");
});

pruefe("bei mehreren Firmen keine geratene Zuordnung", () => {
  const f = ausAufruf({ companyIds: ["DE-1001", "DE-1002"], personId: "per-1001" }, "");
  const person = f.find((x) => x.zielArt === "person");
  assert.ok(!person.firmaId, "Zuordnung waere geraten");
});

pruefe("ein Bulk-Aufruf erzeugt hoechstens fuenf Signale", () => {
  const viele = Array.from({ length: 100 }, (_, i) => `DE-10${String(i).padStart(2, "0")}`);
  assert.ok(ausAufruf({ companyIds: viele }, "").length <= 5);
});

console.log("Gewicht");

pruefe("ohne Merkmale: 1 — unbekannt, nicht schlecht", () => {
  assert.equal(gewichtFuer({}), 1);
});

pruefe("ICP traegt bis zu 4", () => {
  assert.equal(gewichtFuer({ icpScore: 100 }), 5);
  assert.equal(gewichtFuer({ icpScore: 0 }), 1);
});

pruefe("Statuswarnung allein macht eine Firma beachtlich", () => {
  // Der Punkt: Eine Insolvenz geht den Nutzer an, auch wenn er die Firma
  // nie angesehen hat.
  assert.ok(gewichtFuer({ statusWarnung: true }) >= 4);
});

pruefe("Gewicht bleibt zwischen 1 und 10", () => {
  const alles = gewichtFuer({
    icpScore: 100, statusWarnung: true, meineFirma: true,
    crmVerknuepft: true, groesseImKorridor: true,
  });
  assert.ok(alles <= 10 && alles >= 1);
  assert.equal(gewichtFuer({ icpScore: -50 }), 1, "Unfug darf nicht unter 1 druecken");
  assert.equal(gewichtFuer({ icpScore: NaN }), 1);
});

console.log("Reihenfolge des Heartbeats");

const w = (naehe, gewicht) => ({ naehe, gewicht, rang: 0.6 * naehe + 0.4 * gewicht });

pruefe("heiss zuerst", () => {
  const k = ["kalt", "heiss"];
  const werte = { heiss: w(9, 5), kalt: w(2, 1) };
  assert.equal(reihenfolge(k, (x) => werte[x])[0], "heiss");
});

pruefe("jeder vierte Platz gehoert der Entdeckungsspur", () => {
  // Acht heisse und zwei sachlich starke, nie angesehene Firmen. Ohne die
  // Spur kaemen die beiden nie dran.
  const heiss = Array.from({ length: 8 }, (_, i) => `h${i}`);
  const neu = ["neu1", "neu2"];
  const werte = {};
  for (const h of heiss) werte[h] = w(9, 5);
  for (const n of neu) werte[n] = w(1, 8);
  const r = reihenfolge([...heiss, ...neu], (x) => werte[x]);
  assert.equal(r[3], "neu1", "Platz 4 gehoert der Entdeckungsspur");
  assert.equal(r[7], "neu2", "Platz 8 ebenso");
  assert.ok(r.indexOf("neu1") < 6, "eine kalte Firma mit hohem Gewicht darf nicht hinten liegen");
});

pruefe("leere Entdeckungsspur verschenkt keinen Platz", () => {
  const k = ["a", "b", "c", "d", "e"];
  const werte = Object.fromEntries(k.map((x) => [x, w(9, 5)]));
  const r = reihenfolge(k, (x) => werte[x]);
  assert.equal(r.length, 5, "alle Kandidaten muessen vorkommen");
  assert.equal(new Set(r).size, 5, "keiner doppelt");
});

pruefe("jeder Kandidat kommt genau einmal vor", () => {
  const k = Array.from({ length: 23 }, (_, i) => `k${i}`);
  const werte = Object.fromEntries(
    k.map((x, i) => [x, i % 3 === 0 ? w(1, 9) : w(8, 4)]),
  );
  const r = reihenfolge(k, (x) => werte[x]);
  assert.equal(r.length, 23);
  assert.equal(new Set(r).size, 23);
});

pruefe("Kandidaten ohne Wert gehen nicht verloren", () => {
  const r = reihenfolge(["neu", "heiss", "kalt"], (x) =>
    x === "heiss" ? w(9, 5) : x === "kalt" ? w(1, 1) : undefined);
  assert.equal(r.length, 3);
  assert.ok(r.indexOf("neu") < r.indexOf("kalt"), "Unbekanntes steht vor nachweislich Kaltem");
});

pruefe("Alterung hebt Liegengebliebenes, gedeckelt bei +3", () => {
  assert.equal(alterung(null), 0);
  assert.equal(alterung(30), 0);
  assert.ok(alterung(60) > 0);
  assert.equal(alterung(9999), 3);
});

pruefe("lange nicht beobachtet schlaegt gleichwertig frisch", () => {
  const werte = { alt: w(5, 5), frisch: w(5, 5) };
  const tage = { alt: 400, frisch: 1 };
  const r = reihenfolge(["frisch", "alt"], (x) => werte[x], (x) => tage[x]);
  assert.equal(r[0], "alt");
});

console.log("Alarmweg — nichts wird unterdrueckt");

const e = (rang, severity, kind = "linkedin-signal") => alarmweg({ rang, severity, kind });

pruefe("eine eiskalte Firma meldet Registeraenderungen sofort", () => {
  // Der Geschaeftsfuehrerwechsel aus dem Handelsregister. Er darf NIE
  // zurueckgehalten werden, egal wie kalt die Firma ist.
  assert.equal(e(1, "info", "profile-change").weg, "sofort");
  assert.equal(e(1, "warn", "profile-change").weg, "sofort");
});

pruefe("Insolvenz und Statuswarnung immer sofort", () => {
  assert.equal(e(1, "info", "status").weg, "sofort");
});

pruefe("Jahresabschluesse und Kennzahlen immer sofort", () => {
  assert.equal(e(1, "info", "publication").weg, "sofort");
  assert.equal(e(1, "info", "financial-delta").weg, "sofort");
});

pruefe("ICP- und Best-Match-Treffer immer sofort", () => {
  assert.equal(e(1, "info", "radar-match").weg, "sofort");
  assert.equal(e(1, "info", "evaluation-flag").weg, "sofort");
});

pruefe("nur Feed- und Website-Rauschen bei ruhenden Firmen wird gesammelt", () => {
  assert.equal(e(2, "info", "linkedin-signal").weg, "sammeln");
  assert.equal(e(2, "info", "link-change").weg, "sammeln");
  // Und auch das nur als Information — sobald der Judge warnt, geht es raus.
  assert.equal(e(2, "warn", "linkedin-signal").weg, "sofort");
});

pruefe("ohne Wert wird nie gesammelt", () => {
  // Eine Firma, ueber die AVA nichts weiss, ist nicht dasselbe wie eine,
  // die niemanden interessiert.
  assert.equal(e(null, "info", "linkedin-signal").weg, "sofort");
});

console.log("Alarmweg — bei heissen Firmen wird hochgestuft");

pruefe("heiss: eine Information wird zur Warnung", () => {
  const r = e(8, "info");
  assert.equal(r.severity, "warn");
  assert.ok(r.hochgestuft);
  assert.equal(r.weg, "sofort");
});

pruefe("heiss: eine Warnung wird dringend", () => {
  assert.equal(e(8, "warn").severity, "urgent");
});

pruefe("brennend: alles wird dringend", () => {
  // Der Fall, um den es geht: An einer Firma, an der gerade gearbeitet
  // wird, ist auch eine Nebensaechlichkeit dringend.
  assert.equal(e(9.5, "info").severity, "urgent");
  assert.equal(e(9.5, "info", "link-change").severity, "urgent");
});

pruefe("lauwarm und kalt aendern die Stufe nicht", () => {
  assert.equal(e(5, "info").severity, "info");
  assert.equal(e(5, "info").hochgestuft, false);
  assert.equal(e(1, "warn", "profile-change").severity, "warn");
});

pruefe("urgent bleibt urgent, es gibt nichts darueber", () => {
  assert.equal(e(9.9, "urgent").severity, "urgent");
  assert.equal(e(9.9, "urgent").hochgestuft, false);
});

pruefe("der Positionswechsel-Fall aus der Ausgangsfrage", () => {
  // Bei 2000 Firmen soll nicht jeder neue Titel eines beliebigen
  // Mitarbeiters stoeren — bei DER Firma, an der gerade gearbeitet wird,
  // aber sehr wohl, und dort sogar dringend.
  assert.equal(e(2, "info", "linkedin-signal").weg, "sammeln", "ruhende Firma: gesammelt");
  assert.equal(e(9.2, "info", "linkedin-signal").severity, "urgent", "brennende Firma: dringend");
  // Ein Geschaeftsfuehrerwechsel ist kein Rauschen, auch nicht bei einer
  // Firma, die seit Monaten ruht.
  assert.equal(e(2, "info", "profile-change").weg, "sofort", "GF-Wechsel: immer sofort");
});

console.log(fehler === 0 ? "\nAlles gruen." : `\n${fehler} Pruefung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
