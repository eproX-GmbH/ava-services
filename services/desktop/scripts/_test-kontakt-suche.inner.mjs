import assert from "node:assert/strict";
const { faltung, istTeilfolge, punkte, bewerte } = await import(
  "../src/renderer/src/routes/kontakt-suche.ts"
);

// Dieselbe Faltung wie bei der Kontakt-Zuordnung im Gateway: Wer "Mueller"
// tippt, muss "Müller" finden — und umgekehrt.
assert.equal(faltung("Müller"), faltung("Mueller"));
assert.equal(faltung("Jörg Schäfer"), faltung("Joerg Schaefer"));
assert.equal(faltung("Weiß"), faltung("Weiss"));
assert.equal(faltung("José"), faltung("Jose"));
assert.equal(faltung("  Anna   Meier "), "anna meier");
console.log("  ok   Umlaute, Akzente und Leerraum stoeren die Suche nicht");

// Die Abstufung: je sicherer der Treffer, desto hoeher.
assert.ok(punkte("Vertrieb", "vertrieb") > punkte("Vertriebsinnendienst", "vertrieb"));
assert.ok(punkte("Vertriebsinnendienst", "vertrieb") > punkte("Regional Sales", "sales"));
assert.ok(punkte("Regional Sales Director", "sales") > punkte("Vertrieb", "vrtrb"));
assert.equal(punkte("Geschäftsführer", "xyz"), 0);
console.log("  ok   genaue Treffer wiegen schwerer als ungefaehre");

// Tippfehler und Abkuerzungen.
assert.ok(punkte("Vertrieb", "vrtrb") > 0, "Buchstabenfolge findet trotz fehlender Vokale");
assert.ok(punkte("Geschäftsführer", "gschftsf") > 0);
assert.ok(istTeilfolge("vertrieb", "vrtrb"));
assert.ok(!istTeilfolge("vertrieb", "vertriebx"));
console.log("  ok   Tippfehler und Abkuerzungen werden aufgefangen");

// Zu kurze Eingaben duerfen nicht ueber die Buchstabenfolge treffen, sonst
// findet "ab" halb die Liste.
assert.equal(punkte("Geschäftsführer", "gf"), 0, "zwei Buchstaben reichen nicht fuer eine Folge");
assert.ok(punkte("GF Nord", "gf") > 0, "als Wortanfang aber schon");
console.log("  ok   sehr kurze Eingaben treffen nur bei echtem Vorkommen");

const felder = (name, position, abteilung, quelle) => [
  { wert: name, gewicht: 3 },
  { wert: position, gewicht: 2 },
  { wert: abteilung, gewicht: 1.5 },
  { wert: quelle, gewicht: 1 },
];
const heiko = felder("Heiko Zimmer", "Regionalvertriebsleiter Europa", "Vertrieb", "LinkedIn");
const anna = felder("Anna Meier", "Sachbearbeiterin Vertriebsinnendienst", "Vertrieb", "Websuche");

// Mehrere Begriffe sind UND-verknuepft und duerfen aus verschiedenen Feldern
// kommen — so sucht man einen bestimmten Menschen in einer langen Liste.
assert.ok(bewerte(heiko, "zimmer vertrieb") > 0);
assert.equal(bewerte(heiko, "zimmer einkauf"), 0, "ein Begriff ohne Treffer schliesst aus");
assert.ok(bewerte(anna, "meier vertrieb") > 0);
assert.equal(bewerte(anna, "meier linkedin"), 0);
console.log("  ok   mehrere Begriffe werden UND-verknuepft, ueber Felder hinweg");

// Der Name wiegt schwerer als die Position.
const zimmerImNamen = bewerte(felder("Zimmer Group", "Sales", null, null), "zimmer");
const zimmerInPosition = bewerte(felder("Anna Meier", "Zimmermann", null, null), "zimmer");
assert.ok(zimmerImNamen > zimmerInPosition, "Namenstreffer steht oben");
console.log("  ok   Treffer im Namen wiegen schwerer als in der Position");

// Leere Eingabe laesst alles durch.
assert.ok(bewerte(heiko, "") > 0);
assert.ok(bewerte(heiko, "   ") > 0);
console.log("  ok   ohne Eingabe bleibt die Liste vollstaendig");

// Auch Quelle und Rolleneinordnung sind durchsuchbar.
assert.ok(bewerte(heiko, "linkedin") > 0, "nach Quelle filtern");
assert.equal(bewerte(anna, "linkedin"), 0);
console.log("  ok   Quelle laesst sich mitdurchsuchen");

console.log("Kontakt-Such-Tests ok");
