// Prueft die Startvorschlaege fuer ein Buying Center
// (src/lib/buying-center-vorschlag.ts).
//
// Die wichtigste Zusicherung: EINSTELLUNG wird nie vorgeschlagen. Aus einem
// Titel laesst sich Engagement ablesen, nicht Wohlwollen uns gegenueber.
import assert from "node:assert/strict";
import V from "../src/lib/buying-center-vorschlag.ts";
const { vorschlaegeAusTitel, unbesetzteRollen, ohneKontakt } = V;

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

console.log(fehler === 0 ? "\nAlles gruen." : `\n${fehler} Pruefung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
