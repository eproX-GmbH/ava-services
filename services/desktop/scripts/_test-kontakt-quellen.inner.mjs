import assert from "node:assert/strict";
const { quellenGruppe, quellenDerFakten } = await import(
  "../src/renderer/src/routes/kontakt-quellen.ts"
);

// Die Quellwerte, die der Producer heute wirklich schreibt
// (compute-worker.ts + valueserp.ts, Stand 2026-09-18).
assert.equal(quellenGruppe("apify:company-profile"), "LinkedIn");
assert.equal(quellenGruppe("search"), "Websuche");
assert.equal(quellenGruppe("search:linkedin_lookup"), "Websuche");
assert.equal(quellenGruppe("valueserp:google"), "Websuche");
assert.equal(quellenGruppe("agent:website"), "Firmenwebsite");
assert.equal(quellenGruppe("agent:website_people"), "Firmenwebsite");
assert.equal(quellenGruppe("agent:datenschutz"), "Datenschutzerklärung");
console.log("  ok   alle Quellwerte des Producers sind zugeordnet");

// Die LinkedIn-Suche laeuft ueber die Suchmaschine, nicht ueber Apify —
// sie darf NICHT als "LinkedIn" erscheinen, sonst waere die Angabe genau
// in dem Fall falsch, fuer den sie gebaut wurde.
assert.equal(quellenGruppe("search:linkedin_lookup"), "Websuche");
console.log("  ok   LinkedIn-Suche ueber SERP gilt als Websuche, nicht als LinkedIn");

// Unbekanntes und Abgeleitetes bleibt ohne Angabe.
for (const s of [null, undefined, "", "pattern:catchall", "pattern:smtp", "irgendwas"]) {
  assert.equal(quellenGruppe(s), null, `unerwartete Gruppe fuer ${String(s)}`);
}
console.log("  ok   unbekannte und abgeleitete Quellen bleiben ohne Angabe");

const quellen = new Map([
  ["o1", "apify:company-profile"],
  ["o2", "agent:website"],
  ["o3", "search"],
  ["o4", "pattern:smtp"],
]);
assert.deepEqual(
  quellenDerFakten([{ lastObsId: "o3" }, { lastObsId: "o1" }, { lastObsId: "o2" }], quellen),
  ["LinkedIn", "Firmenwebsite", "Websuche"],
  "feste Reihenfolge, unabhaengig von der Reihenfolge der Fakten",
);
assert.deepEqual(
  quellenDerFakten([{ lastObsId: "o1" }, { lastObsId: "o1" }], quellen),
  ["LinkedIn"],
  "keine Wiederholung",
);
console.log("  ok   mehrere Quellen: feste Reihenfolge, keine Wiederholung");

assert.deepEqual(quellenDerFakten([{ lastObsId: "o4" }], quellen), [], "nur abgeleitet = keine Angabe");
assert.deepEqual(quellenDerFakten([{}, { lastObsId: 7 }], quellen), [], "Fakt ohne Beleg");
assert.deepEqual(quellenDerFakten([{ lastObsId: "o1" }], undefined), [], "ohne Quellenkarte");
assert.deepEqual(quellenDerFakten([{ lastObsId: "fehlt" }], quellen), [], "Beleg ohne Beobachtung");
console.log("  ok   fehlende Belege und leere Karten ergeben keine Angabe");

console.log("Kontakt-Quellen-Tests ok");
