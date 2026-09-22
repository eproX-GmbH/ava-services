// Prueft die Startvorschlaege fuer ein Buying Center
// (src/lib/buying-center-vorschlag.ts) und den Hervorhebungs-Fakt
// (src/lib/contact-extraction/hervorhebung.ts).
//
// Die wichtigste Zusicherung: EINSTELLUNG wird nie vorgeschlagen. Aus einem
// Titel laesst sich Engagement ablesen, nicht Wohlwollen uns gegenueber.
import assert from "node:assert/strict";
import V from "../src/lib/buying-center-vorschlag.ts";
import HV from "../src/lib/contact-extraction/hervorhebung.ts";
const { vorschlaegeAusTitel, vorschlaegeAusBeschreibung, unbesetzteRollen, ohneKontakt, gleicherName, vorschlagAusHervorhebung, vorschlaegeAusRegister, registerFunktion, rangDesTitels } = V;
const { hervorhebungAlsWert, hervorhebungAusWert } = HV;

let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };
const werte = (titel, dim) => vorschlaegeAusTitel(titel).filter((v) => v.dimension === dim).map((v) => v.wert);

console.log("Vorschlaege aus dem Titel");
pruefe("Geschaeftsfuehrer → Entscheider, Einfluss hoch als Vorschlag", () => {
  assert.deepEqual(werte("Geschäftsführer", "rolle"), ["E"]);
  assert.deepEqual(werte("Geschäftsführer", "einfluss"), ["H"]);
  assert.match(vorschlaegeAusTitel("Geschäftsführer").find((v) => v.dimension === "einfluss").grund, /nicht gleich Einfluss/);
});
pruefe("Einkauf → Einkaeufer", () => assert.deepEqual(werte("Leiter Einkauf", "rolle"), ["EK"]));
pruefe("Assistenz → Gatekeeper", () => assert.deepEqual(werte("Assistentin der Geschäftsführung", "rolle"), ["GK"]));
pruefe("IT-Leitung → Spezifizierer UND Beeinflusser", () => assert.deepEqual(werte("Leiter IT", "rolle").sort(), ["B", "S"]));
pruefe("Fachkraft → Nutzer, OHNE Einfluss-Vorschlag", () => {
  assert.deepEqual(werte("Softwareentwickler", "rolle"), ["N"]);
  assert.deepEqual(werte("Softwareentwickler", "einfluss"), []);
});
pruefe("ohne Titel nichts", () => { assert.deepEqual(vorschlaegeAusTitel(""), []); assert.deepEqual(vorschlaegeAusTitel(null), []); });
pruefe("Einstellung wird NIE vorgeschlagen", () => {
  for (const t of ["Geschäftsführer", "Leiter IT", "Einkauf", "Assistentin", "CEO", "Entwickler", "Vertriebsleiter"]) {
    assert.ok(vorschlaegeAusTitel(t).every((v) => v.dimension !== "einstellung"), t);
  }
});
pruefe("jeder Vorschlag nennt seinen Grund", () => {
  for (const v of vorschlaegeAusTitel("Leiter Einkauf")) assert.ok(v.grund.length > 10);
});

console.log("Leitfragen");
pruefe("unbesetzte Rollen: GK und R werden nicht angemahnt", () => {
  assert.deepEqual(unbesetzteRollen([{ rollen: ["E"] }, { rollen: ["N", "B"] }]), ["S", "EK"]);
  assert.deepEqual(unbesetzteRollen([]), ["E", "B", "N", "S", "EK"]);
});
pruefe("ohne Kontakt: null und 0 zaehlen, S nicht", () => {
  assert.deepEqual(ohneKontakt([{ name: "A", kontakt: null }, { name: "B", kontakt: "0" }, { name: "C", kontakt: "S" }]), ["A", "B"]);
});

console.log("Verknuepfen freier Personen (BC5)");
pruefe("gleicher Name trotz Titel und Umlaut", () => assert.ok(gleicherName("Dr. Jörg Müller", "Joerg Mueller")));
pruefe("Reihenfolge egal", () => assert.ok(gleicherName("Rafflenbeul Joyce", "Joyce Rafflenbeul")));
pruefe("Nachname allein reicht nicht", () => assert.ok(!gleicherName("Meier", "Anna Meier")));
pruefe("andere Person", () => assert.ok(!gleicherName("Anna Meier", "Anne Meier")));

console.log("Hervorhebung auf der Website (BC4)");
const H = (platz, von, foto = false, zitat = false, url = "https://beispiel.de/team") => ({ platz, von, foto, zitat, url });
pruefe("erste Stelle mit Foto und Zitat → Einfluss hoch, als Vorschlag mit Grund", () => {
  const v = vorschlagAusHervorhebung([H(1, 12, true, true)]);
  assert.equal(v.dimension, "einfluss");
  assert.equal(v.wert, "H");
  assert.match(v.grund, /beispiel\.de\/team: an erster Stelle von 12 Personen, mit Foto und Zitat/);
  assert.match(v.grund, /nur ein Vorschlag/);
});
pruefe("erste Stelle ohne Foto und Zitat → mittel", () => assert.equal(vorschlagAusHervorhebung([H(1, 5)]).wert, "M"));
pruefe("Platz 1 von 2 sagt nichts", () => assert.equal(vorschlagAusHervorhebung([H(1, 2)]), null));
pruefe("Platz 1 von 1 (Impressum) sagt nichts", () => assert.equal(vorschlagAusHervorhebung([H(1, 1, true)]), null));
pruefe("vorn auf einer langen Seite → mittel", () => assert.equal(vorschlagAusHervorhebung([H(3, 9)]).wert, "M"));
pruefe("weit hinten, nur Foto → nichts", () => assert.equal(vorschlagAusHervorhebung([H(9, 12, true, false)]), null));
pruefe("Foto und Zitat irgendwo → mittel", () => assert.equal(vorschlagAusHervorhebung([H(9, 12, true, true)]).wert, "M"));
pruefe("die staerkste Seite zaehlt", () => {
  const v = vorschlagAusHervorhebung([H(4, 6, false, false, "https://beispiel.de/kontakt"), H(1, 12, true, false)]);
  assert.equal(v.wert, "H");
  assert.match(v.grund, /\/team/);
});
pruefe("Einstellung wird auch hier nicht vorgeschlagen", () => assert.equal(vorschlagAusHervorhebung([H(1, 12, true, true)]).dimension, "einfluss"));
pruefe("leer → nichts", () => assert.equal(vorschlagAusHervorhebung([]), null));

console.log("Hervorhebung als Fakt-Wert");
pruefe("lesbar und rueckparsbar", () => {
  assert.equal(hervorhebungAlsWert({ platz: 1, von: 12, foto: true, zitat: true }), "Platz 1 von 12, mit Foto, mit Zitat");
  for (const h of [
    { platz: 1, von: 12, foto: true, zitat: true },
    { platz: 3, von: 7, foto: false, zitat: false },
    { platz: 2, von: 2, foto: false, zitat: true },
  ]) assert.deepEqual(hervorhebungAusWert(hervorhebungAlsWert(h)), h);
});
pruefe("fremde Werte werden nicht geparst", () => {
  for (const v of ["", "Platz 0 von 3", "Platz 4 von 3", "Geschäftsführer", "Platz 1 von 3, mit Hut", null, undefined]) assert.equal(hervorhebungAusWert(v), null, String(v));
});

console.log(fehler === 0 ? "\nAlles gruen." : `\n${fehler} Pruefung(en) fehlgeschlagen.`);
console.log("Beschreibung von der Website");
pruefe("Beschreibung ergaenzt, was der Titel nicht hergab", () => {
  const titel = vorschlaegeAusTitel("Solution Architecture");
  assert.deepEqual(titel.map((v) => v.wert), ["N"]);
  const aus = vorschlaegeAusBeschreibung("Aktuell bin ich als Solution Architect für unsere Kundenprojekte verantwortlich und betreue die Weiterentwicklung.", titel);
  assert.deepEqual(aus.filter((v) => v.dimension === "rolle").map((v) => v.wert), ["B"]);
  assert.match(aus[0].grund, /^Website-Beschreibung „/);
  assert.ok(aus[0].grund.length < 220, aus[0].grund);
});
pruefe("kein Rueckfall auf N aus einem Satz ohne Aussage", () => {
  assert.deepEqual(vorschlaegeAusBeschreibung("Ich habe immer ein offenes Ohr für unsere Kundinnen und Kunden.", vorschlaegeAusTitel("Customer Service")), []);
});
pruefe("ganze Woerter: Begleitung und Anleitung sind keine Leitung", () => {
  assert.deepEqual(vorschlaegeAusBeschreibung("Ich unterstütze bei der Begleitung von Projekten und schreibe Anleitungen.", []), []);
  assert.deepEqual(vorschlaegeAusBeschreibung("Ich leite das Team Data Analytics.", []).map((v) => v.dimension + v.wert), ["rolleB", "einflussM"]);
});
pruefe("konkreter Titel: Beschreibung schweigt", () => {
  assert.deepEqual(vorschlaegeAusBeschreibung("Gründer und Gesellschafter der Firma.", vorschlaegeAusTitel("Geschäftsführung")), []);
});
pruefe("Assistenz in der Beschreibung → Gatekeeper, nichts doppelt", () => {
  const titel = vorschlaegeAusTitel("Backoffice");
  const aus = vorschlaegeAusBeschreibung("Als Assistentin der Geschäftsführung halte ich den Rücken frei.", titel);
  assert.deepEqual(aus.map((v) => v.wert), ["GK"]);
});
pruefe("leer / null → nichts", () => {
  assert.deepEqual(vorschlaegeAusBeschreibung("", []), []);
  assert.deepEqual(vorschlaegeAusBeschreibung(null, []), []);
});
console.log("Register und Rangfolge");
pruefe("Zweitnamen: Register vs. LinkedIn ist dieselbe Person", () => {
  assert.ok(gleicherName("Michael Erwin Basler", "Michael Basler"));
  assert.ok(gleicherName("Dr. Günter Zimmer", "Guenter Zimmer"));
  assert.ok(!gleicherName("Martin Zimmer", "Jonas Sebastian Zimmer"));
  assert.ok(!gleicherName("Michael Basler", "Michael Erwin Bauer"));
  assert.ok(!gleicherName("Erina B.", "Erina Buck"));
});
pruefe("Geschaeftsfuehrer laut Register → E + Einfluss H", () => {
  const aus = vorschlaegeAusRegister({ name: "x", geschaeftsfuehrer: true, gesellschafter: null });
  assert.deepEqual(aus.map((v) => v.dimension + v.wert), ["rolleE", "einflussH"]);
  assert.match(aus[0].grund, /Handelsregister/);
});
pruefe("Mehrheitsgesellschafter → E + R, Minderheit nur R", () => {
  assert.deepEqual(vorschlaegeAusRegister({ name: "x", geschaeftsfuehrer: false, gesellschafter: { prozent: 51, listeDatum: "2026-01-01" } }).map((v) => v.wert), ["E", "R", "H"]);
  assert.deepEqual(vorschlaegeAusRegister({ name: "x", geschaeftsfuehrer: false, gesellschafter: { prozent: 10, listeDatum: null } }).map((v) => v.wert), ["R", "H"]);
  assert.deepEqual(vorschlaegeAusRegister({ name: "x", geschaeftsfuehrer: true, gesellschafter: { prozent: 60, listeDatum: null } }).map((v) => v.wert), ["E", "R", "H"]);
  assert.deepEqual(vorschlaegeAusRegister({ name: "x", geschaeftsfuehrer: false, gesellschafter: null }), []);
});
pruefe("Funktionstext fuer reine Register-Mitglieder", () => {
  assert.equal(registerFunktion({ name: "x", geschaeftsfuehrer: true, gesellschafter: { prozent: 33.33, listeDatum: null } }), "Geschäftsführer laut Handelsregister, Gesellschafter (33,3 %)");
  assert.equal(registerFunktion({ name: "x", geschaeftsfuehrer: false, gesellschafter: { prozent: null, listeDatum: null } }), "Gesellschafter");
});
pruefe("Rang: Geschaeftsleitung vor Leitung vor Fachkraft vor ohne Titel", () => {
  assert.equal(rangDesTitels("Managing Director"), 1);
  assert.equal(rangDesTitels("Assistentin der Geschäftsführung"), 3);
  assert.equal(rangDesTitels("Head of Software Engineering"), 2);
  assert.equal(rangDesTitels("Projektleiter"), 2);
  assert.equal(rangDesTitels("Design Engineer"), 3);
  assert.equal(rangDesTitels(""), 4);
  assert.equal(rangDesTitels(null), 4);
});
process.exit(fehler === 0 ? 0 : 1);
