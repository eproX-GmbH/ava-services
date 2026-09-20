// Prueft die Rechnung aus docs/PLAN_RELEVANZ.md Abschnitt 5 gegen die
// Beispieltabelle. Die Zahlen dort sind ein Versprechen an den Nutzer:
// "drei Aufrufe an drei Tagen fuehlen sich heiss an". Wer die Konstanten
// aendert, muss hier vorbeikommen.

import assert from "node:assert/strict";
// Das Gateway uebersetzt nach CommonJS (tsconfig "module": "commonjs"),
// deshalb liegen die Exporte am Standard-Export, nicht als benannte.
import R from "../src/lib/relevanz-score.ts";
const { naehe, rohwert, wiederkehr, rang, naeheMitVererbung, begruendung, WARM_AB } = R;

const JETZT = new Date("2026-09-20T12:00:00Z");
const tageVorher = (n) => new Date(JETZT.getTime() - n * 86_400_000);
const ansicht = (d) => ({ art: "firma.ansicht", punkte: 3, halbwertT: 21, zeitpunkt: d });

let fehler = 0;
function pruefe(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); }
}
/** Naehe darf um 0,3 abweichen — die Tabelle im Plan ist gerundet. */
function nahBei(ist, soll, name) {
  assert.ok(Math.abs(ist - soll) <= 0.3, `${name}: ${ist} statt ~${soll}`);
}

console.log("Beispieltabelle aus Abschnitt 5.1");

pruefe("einmal geoeffnet -> ~4,6 (lauwarm)", () => {
  nahBei(naehe([ansicht(JETZT)], JETZT), 4.6, "einmal");
});

pruefe("dreimal am selben Tag -> ~7,0, kein Wiederkehr-Bonus", () => {
  const s = [ansicht(JETZT), ansicht(JETZT), ansicht(JETZT)];
  assert.equal(wiederkehr(s, JETZT), 0, "gleicher Tag darf keinen Bonus geben");
  nahBei(naehe(s, JETZT), 7.0, "dreimal am Tag");
});

pruefe("an drei Tagen geoeffnet -> ~8,6 (heiss)", () => {
  const s = [ansicht(JETZT), ansicht(tageVorher(1)), ansicht(tageVorher(2))];
  nahBei(naehe(s, JETZT), 8.6, "drei Tage");
  assert.ok(naehe(s, JETZT) >= WARM_AB, "drei Tage muessen warm sein");
});

pruefe("Wiederkehr schlaegt blosse Menge am selben Tag", () => {
  const dreiTage = [ansicht(JETZT), ansicht(tageVorher(1)), ansicht(tageVorher(2))];
  const dreiAmTag = [ansicht(JETZT), ansicht(JETZT), ansicht(JETZT)];
  assert.ok(naehe(dreiTage, JETZT) > naehe(dreiAmTag, JETZT),
    "Zurueckkommen muss mehr wiegen als mehrfach klicken");
});

pruefe("Wiederkehr-Deckel bei fuenf zusaetzlichen Tagen", () => {
  const viele = Array.from({ length: 12 }, (_, i) => ansicht(tageVorher(i)));
  assert.ok(wiederkehr(viele, JETZT) <= 20.001, "Deckel +20 verletzt");
});

pruefe("uebernommen + Kontakt ins CRM -> nahe 10", () => {
  const s = [
    { art: "firma.uebernommen", punkte: 12, halbwertT: 120, zeitpunkt: JETZT },
    { art: "person.crm", punkte: 16, halbwertT: 180, zeitpunkt: JETZT },
  ];
  nahBei(naehe(s, JETZT), 9.8, "uebernommen+crm");
});

console.log("Verfall");

pruefe("ohne neues Signal faellt eine 8,6 in drei Wochen auf ~7", () => {
  const s = [ansicht(tageVorher(21)), ansicht(tageVorher(22)), ansicht(tageVorher(23))];
  nahBei(naehe(s, JETZT), 7.0, "nach drei Wochen");
});

pruefe("sehr alte Signale sind praktisch weg", () => {
  assert.ok(naehe([ansicht(tageVorher(400))], JETZT) < 1.2, "400 Tage alt muss kalt sein");
});

pruefe("kein Signal -> 1 (kalt), nicht 0 oder NaN", () => {
  assert.equal(naehe([], JETZT), 1);
});

console.log("Malus");

pruefe("weggewischte Alarme druecken die Naehe", () => {
  const nur = [ansicht(JETZT), ansicht(tageVorher(1))];
  const mitMalus = [...nur,
    { art: "alarm.weggewischt", punkte: -3, halbwertT: 30, zeitpunkt: JETZT },
    { art: "alarm.weggewischt", punkte: -3, halbwertT: 30, zeitpunkt: JETZT }];
  assert.ok(naehe(mitMalus, JETZT) < naehe(nur, JETZT), "Malus wirkt nicht");
});

pruefe("Malus kann die Naehe nicht unter 1 druecken", () => {
  const s = [{ art: "alarm.weggewischt", punkte: -3, halbwertT: 30, zeitpunkt: JETZT }];
  assert.equal(naehe(s, JETZT), 1);
  assert.equal(rohwert(s, JETZT), 0);
});

console.log("Rang");

pruefe("Rang mischt Naehe und Gewicht 60/40", () => {
  assert.equal(rang(10, 10, null), 10);
  assert.equal(rang(10, 5, null), 8);
});

pruefe("hohes Gewicht haelt eine kalte Firma im Rennen", () => {
  // Die Entdeckungsspur braucht das: sachlich passende, nie angesehene
  // Firmen duerfen nicht hinter jeder lauwarmen verschwinden.
  assert.ok(rang(1, 10, null) > rang(4.6, 1, null));
});

pruefe("Alterung verhindert Verhungern, gedeckelt bei +3", () => {
  assert.equal(rang(5, 5, 30), 5);
  assert.ok(rang(5, 5, 60) > rang(5, 5, 30));
  assert.equal(rang(5, 5, 9999) - rang(5, 5, 30), 3);
});

console.log("Vererbung und Begruendung");

pruefe("Person erbt die halbe Naehe ihrer Firma", () => {
  assert.equal(naeheMitVererbung(1, 8.6), 4.3);
  assert.equal(naeheMitVererbung(9, 4), 9, "eigene Naehe darf nicht sinken");
  assert.equal(naeheMitVererbung(3, null), 3);
});

pruefe("Begruendung nennt hoechstens drei Treiber, staerkster zuerst", () => {
  const s = [ansicht(JETZT), ansicht(tageVorher(1)),
    { art: "firma.uebernommen", punkte: 12, halbwertT: 120, zeitpunkt: JETZT },
    { art: "chat.erwaehnt", punkte: 5, halbwertT: 30, zeitpunkt: JETZT }];
  const b = begruendung(s, JETZT);
  assert.ok(b.length <= 3, "hoechstens drei");
  assert.equal(b[0].art, "firma.uebernommen", "staerkster Treiber zuerst");
  assert.ok(b.every((x, i) => i === 0 || Math.abs(x.anteil) <= Math.abs(b[i - 1].anteil)));
});

console.log(fehler === 0 ? "\nAlles gruen." : `\n${fehler} Pruefung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
