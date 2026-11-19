// Erstansprache (docs/PLAN_ERSTANSPRACHE.md A0/A3): Pruefsatz mit echtem Fall IEF-Werner (Patrick, 19.11.).
import assert from "node:assert/strict";
import L0 from "../src/main/agent/ansprache-logik.ts";
const L = L0.default ?? L0;
let fehler = 0;
const pruefe = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

const heute = new Date("2026-11-19T12:00:00Z");
const roh = {
  heute,
  empfaengerName: "Thomas Schwer",
  ereignisse: [
    { art: "wechsel", person: "Jan Beispiel", rolleVorher: "Vertriebsingenieur Systeme", rolle: "Vertriebsleitung Systeme / Head of Sales Systems", zeitpunkt: "2026-11-01", zeitpunktArt: "laut_profil", quelle: "LinkedIn", url: "https://linkedin.com/in/x" },
    { art: "neu", person: "Alt Fall", rolle: "Leiter Einkauf", zeitpunkt: "2024-01-01", zeitpunktArt: "laut_profil" },
  ],
  meldungen: [{ kind: "workflow", headline: "Workflow fertig", createdAt: "2026-11-18" }],
  expansion: [],
  stellen: { anzahl: 4, titel: ["Vertriebsingenieur Palettierer", "Servicetechniker"] },
  fokus: [],
  finanzen: [{ jahr: 2024, umsatz: "41.500.000 EUR", mitarbeiter: 230 }, { jahr: 2023, umsatz: "36.000.000 EUR", mitarbeiter: 215 }],
  fluktuation: [],
  kunden: ["Bosch", "Continental"],
  produkte: "Systemvertrieb für Palettierer und Mikromontage, Transportsysteme, Radmesstechnik, Linearachsen",
  linkedin: [],
};
const a = L.aufhaengerBilden(roh);

console.log("Aufhaenger");
pruefe("frischer Personalwechsel zuerst, alter (>365 Tage) faellt weg", () => {
  assert.equal(a[0].art, "personal");
  assert.ok(a[0].fakt.includes("Vertriebsleitung Systeme"));
  assert.ok(a[0].fakt.includes("laut Profil"));
  assert.ok(!a.some((x) => x.fakt.includes("Alt Fall")));
});
pruefe("Workflow-Meldungen sind kein Anlass", () => assert.ok(!a.some((x) => x.art === "meldung")));
pruefe("Finanzen mit Entwicklung zum Vorjahr", () => {
  const f = a.find((x) => x.art === "finanzen");
  assert.ok(f, "Finanzen fehlen");
  assert.match(f.fakt, /41,5 Mio\. EUR \(\+15 % zum Vorjahr\), 230 Mitarbeitende/);
  assert.equal(f.staerke, 3);
});
pruefe("hoechstens fuenf, je Art hoechstens zwei", () => {
  assert.ok(a.length <= 5);
  const n = {}; for (const x of a) n[x.art] = (n[x.art] ?? 0) + 1;
  assert.ok(Object.values(n).every((v) => v <= 2));
});

console.log("Pruefung");
// Patricks Endfassung (gekuerzt wiedergegeben, Laenge wie das Original): zu lang, ueberwachend.
const patrick = [
  "Sehr geehrter Herr Schwer,",
  ("Ihre Vertriebsorganisation reicht vom Systemvertrieb für Palettierer und Mikromontage über Transportsysteme und Radmesstechnik bis zum regionalen Außendienst. " +
   "Ihre ausgewiesenen Gebietsverantwortlichen betreuen zusammen weite Teile Deutschlands sowie Österreich und die Schweiz. ").repeat(8) +
  "AVA hat IEF-Werner bereits analysiert einschließlich Ihrer Produktbereiche. Sind Sie bereit, diese These gemeinsam an einem Ihrer Zielkunden zu überprüfen?",
  "Beste Grüße",
  "Patrick",
].join("\n");
pruefe("lange Fassung faellt durch (Laenge), Ueberwachungston als Hinweis", () => {
  const r = L.anspracheTextPruefen(patrick, a, { kanal: "mail", empfaengerName: "Thomas Schwer" });
  assert.equal(r.bestanden, false);
  assert.ok(r.maengel.some((m) => m.startsWith("Zu lang")), JSON.stringify(r.maengel));
  assert.ok(r.hinweise.some((h) => h.includes("Überwachung")), JSON.stringify(r.hinweise));
});
const gut = [
  "Sehr geehrter Herr Schwer,",
  "Sie haben die Vertriebsleitung Systeme zum 1. November neu besetzt, und IEF-Werner ist 2024 auf 41,5 Mio. EUR Umsatz gewachsen.",
  "Mit 230 Mitarbeitenden und Produktbereichen von Palettierer bis Radmesstechnik verbringen Ihre Vertriebsingenieure viel Zeit mit Vorarbeit statt mit Kunden.",
  "AVA übernimmt diese Recherche: passende Zielfirmen, Entscheider und aktuelle Anlässe, fertig für das Gespräch.",
  "Ich würde Ihnen das in 20 Minuten an einem Ihrer echten Zielkunden aus dem Systemgeschäft zeigen.",
  "Passt Ihnen ein Termin in der kommenden Woche?",
  "Beste Grüße",
  "Patrick Dettlev",
].join("\n");
pruefe("kurze Fassung mit Anlass und Fakten besteht", () => {
  const r = L.anspracheTextPruefen(gut, a, { kanal: "mail", empfaengerName: "Thomas Schwer" });
  assert.equal(r.bestanden, true, JSON.stringify(r.maengel));
  assert.ok(r.genutzteAufhaenger.length >= 2);
});
pruefe("generischer Einstieg und Floskeln fallen durch", () => {
  const t = "Sehr geehrter Herr Schwer,\nich hoffe, diese Mail erreicht Sie gut. Mein Name ist Patrick und wir bieten innovative Lösungen.\nIhr Umsatz von 41,5 Mio. EUR und 230 Mitarbeitende zeigen Wachstum. Passt ein Termin?\nBeste Grüße\nPatrick";
  const r = L.anspracheTextPruefen(t, a, { kanal: "mail" });
  assert.equal(r.bestanden, false);
  assert.ok(r.maengel.some((m) => m.startsWith("Floskeln")));
  assert.ok(r.maengel.some((m) => m.includes("Einstieg")));
});
pruefe("Platzhalter fallen durch", () => {
  const r = L.anspracheTextPruefen(gut.replace("Patrick Dettlev", "[Ihr Name]"), a, { kanal: "mail" });
  assert.ok(r.maengel.some((m) => m.includes("Platzhalter")));
});
pruefe("LinkedIn hat engere Laenge", () => {
  const r = L.anspracheTextPruefen(gut, a, { kanal: "linkedin" });
  assert.equal(r.bestanden, true, JSON.stringify(r.maengel));
  const lang = L.anspracheTextPruefen(gut + "\n" + gut, a, { kanal: "linkedin" });
  assert.ok(lang.maengel.some((m) => m.startsWith("Zu lang")));
});
console.log(fehler ? `\n${fehler} Fehler.` : "\nAlles gruen.");
process.exit(fehler ? 1 : 0);
