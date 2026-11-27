// Firmenhistorie (docs/PLAN_FIRMEN_HISTORIE.md): Rollengruppen, echte Wechsel, Pendel.
import assert from "node:assert/strict";
import R0 from "../src/lib/rollengruppe.ts";
import Z0 from "../src/lib/fluktuation-zaehlen.ts";
import B0 from "../src/lib/rollenwechsel-beleg.ts";
const B = B0.default ?? B0;
const R = R0.default ?? R0;
const F = R;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };
const rolle = (t) => { const r = R.rolleEinordnen(t); return `${r.gruppe}/${r.ebene}`; };
console.log("Firmenhistorie: Rollengruppen");
for (const [t, e] of [
  ["Vertriebsleiter", "vertrieb/leitung"], ["Head of Sales", "vertrieb/leitung"], ["Leiter Vertrieb", "vertrieb/leitung"],
  ["Gebietsverkaufsleiter", "vertrieb/mitarbeit"], ["Head of Regional Sales", "vertrieb/leitung"], ["Chief Sales Officer (CSO)", "vertrieb/leitung"], ["Sales Manager", "vertrieb/mitarbeit"],
  ["Key-Account-Manager", "vertrieb/mitarbeit"], ["Vertriebsmitarbeiter", "vertrieb/mitarbeit"],
  ["Geschäftsführer", "geschaeftsfuehrung/leitung"], ["Managing Director", "geschaeftsfuehrung/leitung"], ["Vorstand", "geschaeftsfuehrung/leitung"],
  ["Executive Director", "geschaeftsfuehrung/leitung"], ["Vice President Human Resources", "personal/leitung"], ["President & CEO", "geschaeftsfuehrung/leitung"], ["Product Owner Software", "it/mitarbeit"], ["Owner", "geschaeftsfuehrung/leitung"], ["Mitglied des Aufsichtsrats", "aufsicht/leitung"], ["Aufsichtsrat (Supervisory Board Member)", "aufsicht/leitung"],
  ["Assistentin der Geschäftsleitung", "sonstige/mitarbeit"], ["CFO", "finanzen/leitung"], ["Leiter IT", "it/leitung"], ["Softwareentwickler", "it/mitarbeit"],
  ["Strategischer Einkäufer", "einkauf/mitarbeit"], ["Marketing Manager", "marketing/mitarbeit"], ["Personalleiterin", "personal/leitung"],
  ["Konstrukteur", "technik/mitarbeit"], ["Leitung Kundendienst", "service/leitung"], ["Projektleiter", "sonstige/leitung"], ["", "sonstige/mitarbeit"],
]) pruefe(`${t || "(leer)"} → ${e}`, () => assert.equal(rolle(t), e));

console.log("Echte Wechsel");
pruefe("Umformulierung zaehlt nicht", () => {
  assert.equal(R.echterRollenwechsel("Technischer Vertrieb", "Technischer Vertrieb Innendienst"), false);
  assert.equal(R.echterRollenwechsel("Chief Sales Officer (CSO)", "Member of the Board & CSO"), false);
  assert.equal(R.echterRollenwechsel("Aufsichtsrat", "Aufsichtsrat (Supervisory Board Member)"), false);
});
pruefe("Gebietsleiter zu Sales Manager ist derselbe Job", () => assert.equal(R.echterRollenwechsel("Gebietsverkaufsleiter Süd-West", "Sales Manager South West / Switzerland"), false));
pruefe("Aufstieg zaehlt", () => assert.equal(R.echterRollenwechsel("Vertriebsingenieur Systeme", "Vertriebsleitung Systeme / Head of Sales Systems"), true));
pruefe("Wechsel der Gruppe zaehlt", () => assert.equal(R.echterRollenwechsel("Vorstand", "Vorsitzender des Aufsichtsrats"), true));
pruefe("unklarer alter Titel zaehlt nicht", () => assert.equal(R.echterRollenwechsel("Mitarbeiter / mit Erfahrung bei X", "Geschäftsführer"), false));

console.log("Pendel");
const e = (id, tag, von, nach) => { const a = R.rolleEinordnen(von); const b = R.rolleEinordnen(nach); return { id, personId: "p1", zeitpunkt: new Date(Date.UTC(2026, 0, 1) + tag * 86400000).toISOString(), gruppe: b.gruppe, ebene: b.ebene, gruppeVorher: a.gruppe, ebeneVorher: a.ebene }; };
pruefe("hin und zurueck binnen 120 Tagen faellt weg", () => {
  const l = F.pendelEntfernen([e("a", 0, "Vertriebsleiter", "Vertriebsmitarbeiter"), e("b", 30, "Vertriebsmitarbeiter", "Vertriebsleiter")]);
  assert.equal(l.length, 0);
});
pruefe("echter Rueckweg nach einem Jahr bleibt", () => {
  const l = F.pendelEntfernen([e("a", 0, "Vertriebsleiter", "Vertriebsmitarbeiter"), e("b", 400, "Vertriebsmitarbeiter", "Vertriebsleiter")]);
  assert.equal(l.length, 2);
});
pruefe("einfacher Aufstieg bleibt", () => assert.equal(F.pendelEntfernen([e("a", 0, "Vertriebsingenieur", "Vertriebsleiter")]).length, 1));
console.log("Fluktuation");
const Z = Z0.default ?? Z0;
const ev = (art, nach, von = null) => { const b = R.rolleEinordnen(nach); const a = von ? R.rolleEinordnen(von) : null; return { art, gruppe: b.gruppe, ebene: b.ebene, gruppeVorher: a?.gruppe ?? null, ebeneVorher: a?.ebene ?? null }; };
pruefe("neu besetzte Vertriebsleitung = ein Wechsel", () => {
  const g = Z.leitungZaehlen([ev("verlassen", "Vertriebsleiter", "Vertriebsleiter"), ev("neu", "Head of Sales")]);
  assert.deepEqual(g.map((x) => [x.gruppe, x.zugaenge, x.abgaenge, x.wechsel]), [["vertrieb", 1, 1, 1]]);
});
pruefe("Aufstieg zaehlt als Zugang der Leitung, Mitarbeit zaehlt nicht", () => {
  const g = Z.leitungZaehlen([ev("wechsel", "Vertriebsleitung", "Vertriebsingenieur"), ev("neu", "Vertriebsmitarbeiter")]);
  assert.deepEqual(g.map((x) => [x.gruppe, x.zugaenge, x.abgaenge]), [["vertrieb", 1, 0]]);
});
pruefe("Register zaehlt bei der Geschaeftsfuehrung, groessere Quelle gewinnt", () => {
  const g = Z.leitungZaehlen([ev("neu", "Geschäftsführer")], { zu: 2, ab: 1 });
  assert.deepEqual(g.map((x) => [x.gruppe, x.zugaenge, x.abgaenge, x.wechsel]), [["geschaeftsfuehrung", 2, 1, 2]]);
});
pruefe("Hinweis erst, wenn es auffaellt, mit ehrlichen Zahlen", () => {
  const g = Z.leitungZaehlen([ev("neu", "Vertriebsleiter"), ev("neu", "Head of Sales"), ev("verlassen", "Vertriebsleiter", "Vertriebsleiter"), ev("neu", "Leiter IT")]);
  assert.deepEqual(Z.hinweiseAus(g, 24), ["Vertriebsleitung: 2 neu, 1 ausgeschieden in 2 Jahren"]);
  assert.deepEqual(Z.hinweiseAus(Z.leitungZaehlen([ev("neu", "Vertriebsleiter"), ev("neu", "Leiter IT")]), 24), []);
  assert.deepEqual(Z.hinweiseAus(Z.leitungZaehlen([], { zu: 1, ab: 1 }), 24), ["Geschäftsführung: 1 neu, 1 ausgeschieden in 2 Jahren"]);
});

console.log("Rollenwechsel aus Signalen: belegt?");
pruefe("Diermann (2026-11-27): alter Titel nur aus XING-Suchtreffer, neue Rolle laut LinkedIn seit 09/2026", () => {
  const sichtungen = [
    { value: "Technischer Produktdesigner", am: "2026-10-28T10:11:00Z", quelle: "search" },
    { value: "Werkstudent", am: "2026-11-27T13:07:00Z", quelle: "apify:company-profile" },
  ];
  const r = B.rollenwechselBeleg({ vorher: "Technischer Produktdesigner", sichtungen, beginnNeu: B.beginnFuerTitel("Werkstudent", "2026-09-01", "Werkstudent"), signalAm: "2026-11-27T13:07:00Z" });
  assert.deepEqual(r, { belegt: false, grund: "alter_stand_nur_suchtreffer" });
});
pruefe("neue Rolle begann, bevor AVA den alten Titel zum ersten Mal sah: kein beobachteter Wechsel", () => {
  const sichtungen = [{ value: "Konstrukteur", am: "2026-10-28T10:11:00Z", quelle: "agent:website" }];
  const r = B.rollenwechselBeleg({ vorher: "Konstrukteur", sichtungen, beginnNeu: new Date("2026-09-01"), signalAm: "2026-11-27T13:07:00Z" });
  assert.deepEqual(r, { belegt: false, grund: "neue_rolle_aelter_als_alter_stand" });
});
pruefe("echter Wechsel: alter Titel auf der Website gesehen, neue Rolle beginnt danach", () => {
  const sichtungen = [
    { value: "Konstrukteur", am: "2026-06-02T10:00:00Z", quelle: "agent:website" },
    { value: "Konstrukteur", am: "2026-10-01T10:00:00Z", quelle: "search" },
  ];
  assert.deepEqual(B.rollenwechselBeleg({ vorher: "Konstrukteur", sichtungen, beginnNeu: new Date("2026-09-01"), signalAm: "2026-11-27T13:07:00Z" }), { belegt: true });
  // ohne Beginn laut Profil ebenso
  assert.deepEqual(B.rollenwechselBeleg({ vorher: "Konstrukteur", sichtungen, beginnNeu: null, signalAm: "2026-11-27T13:07:00Z" }), { belegt: true });
});
pruefe("Schreibweise des alten Titels egal; Sichtungen nach dem Signal zaehlen nicht", () => {
  const sichtungen = [
    { value: "Geschäftsleitung", am: "2026-05-01T00:00:00Z", quelle: "search" },
    { value: "Geschaeftsleitung", am: "2026-12-01T00:00:00Z", quelle: "agent:website" },
  ];
  assert.equal(B.rollenwechselBeleg({ vorher: "Geschaeftsleitung", sichtungen, beginnNeu: null, signalAm: "2026-11-27T00:00:00Z" }).belegt, false);
});
pruefe("Schreibweise: Umlaute, Aufzaehlungen, Satzzeichen", () => {
  assert.equal(B.schreibweise("Geschäftsführer"), B.schreibweise("Geschaeftsfuehrer"));
  assert.equal(B.schreibweise("Straße"), B.schreibweise("Strasse"));
  assert.equal(B.schreibweise("Vertrieb; Marketing"), B.schreibweise("Vertrieb und Marketing"));
  assert.notEqual(B.schreibweise("Werkstudent"), B.schreibweise("Technischer Produktdesigner"));
});
pruefe("ohne Sichtungen des alten Titels: nichts zu pruefen, Signal bleibt", () => {
  assert.equal(B.rollenwechselBeleg({ vorher: "Konstrukteur", sichtungen: [], beginnNeu: new Date("2020-01-01"), signalAm: "2026-11-27T00:00:00Z" }).belegt, true);
});
pruefe("Beginn laut Profil nur, wenn die Beschaeftigung den neuen Titel traegt", () => {
  assert.equal(B.beginnFuerTitel("Werkstudent", "2026-09-01", "Werkstudent")?.toISOString().slice(0, 10), "2026-09-01");
  assert.equal(B.beginnFuerTitel("Teamleiter", "2026-09-01", "Werkstudent"), null);
  assert.equal(B.beginnFuerTitel("Werkstudent", null, "Werkstudent"), null);
  assert.equal(B.beginnFuerTitel("Werkstudent", "kein datum", "Werkstudent"), null);
});

console.log(fehler ? `\n${fehler} Fehler.` : "\nAlles gruen.");
process.exit(fehler ? 1 : 0);
