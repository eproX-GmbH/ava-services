// Firmenhistorie (docs/PLAN_FIRMEN_HISTORIE.md): Rollengruppen, echte Wechsel, Pendel.
import assert from "node:assert/strict";
import R0 from "../src/lib/rollengruppe.ts";
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
console.log(fehler ? `\n${fehler} Fehler.` : "\nAlles gruen.");
process.exit(fehler ? 1 : 0);
