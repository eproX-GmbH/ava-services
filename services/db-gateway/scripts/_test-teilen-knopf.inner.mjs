// Prueft den Teilen-Knopf-Filter (services/db-gateway/src/lib/
// contact-extraction/teilen-knopf.ts).
//
// Die echten Werte stammen aus dem Produktionsbestand: die vier
// faelschlich als Profil gespeicherten Teilen-Links der JR-Seite und eine
// Auswahl echter Profile, die auf keinen Fall verschwinden duerfen.

import assert from "node:assert/strict";
import T from "../src/lib/contact-extraction/teilen-knopf.ts";
const { istTeilenKnopf } = T;

let fehler = 0;
const pruefe = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); }
};

console.log("Teilen-Knoepfe erkennen (echte Werte aus dem Bestand)");

pruefe("die vier Faelle der JR-Seite", () => {
  for (const u of [
    "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.jr-immobilienverwaltung.de%2F",
    "https://www.linkedin.com/sharing/share-offsite/?url=https://www.jr-immobilienverwaltung.de/",
    "https://api.whatsapp.com/send?text=https://www.jr-immobilienverwaltung.de/",
    "https://www.xing.com/app/user?op=share;url=https%3A%2F%2Fwww.jr-immobilienverwaltung.de%2F",
  ]) assert.ok(istTeilenKnopf(u), u);
});

pruefe("weitere uebliche Anbieter", () => {
  for (const u of [
    "https://twitter.com/intent/tweet?url=https://example.de",
    "https://x.com/intent/post?url=https://example.de",
    "https://t.me/share/url?url=https://example.de",
    "https://www.pinterest.de/pin/create/button/?url=https://example.de",
    "https://www.reddit.com/submit?url=https://example.de",
    "https://wa.me/?text=https://example.de",
    "https://vk.com/share.php?url=https://example.de",
  ]) assert.ok(istTeilenKnopf(u), u);
});

pruefe("unbekannter Anbieter mit weitergereichter Adresse faellt trotzdem auf", () => {
  // Der allgemeine Verrat: Die Adresse traegt eine ANDERE Adresse mit.
  assert.ok(istTeilenKnopf("https://irgendein-dienst.example/teilen?url=https://example.de/seite"));
});

console.log("Echte Profile duerfen NICHT verschwinden");

pruefe("Profile aus dem Produktionsbestand bleiben", () => {
  // Diese Liste ist der eigentliche Schutz: Ein uebersehener Teilen-Knopf
  // ist ein Schoenheitsfehler, ein verworfenes echtes Profil ein
  // Datenverlust.
  for (const u of [
    "https://de-de.facebook.com/LEWAAttendornGmbH/",
    "https://de.linkedin.com/company/diamant-software-gmbh",
    "https://de.linkedin.com/company/r.-scheuchl-gmbh",
    "https://fr.linkedin.com/company/novares-group",
    "https://corporate.hettich.com",
    "https://github.com/jrafflenbeul",
    "https://www.xing.com/pages/musterfirma-gmbh",
    "https://www.instagram.com/musterfirma/",
    "https://www.youtube.com/@musterfirma",
  ]) assert.ok(!istTeilenKnopf(u), `faelschlich verworfen: ${u}`);
});

pruefe("Profil mit harmlosen Parametern bleibt", () => {
  assert.ok(!istTeilenKnopf("https://www.linkedin.com/company/musterfirma/?originalSubdomain=de"));
  assert.ok(!istTeilenKnopf("https://www.facebook.com/musterfirma/?locale=de_DE"));
});

pruefe("Unfug stuerzt nicht ab und gilt als Profil", () => {
  for (const u of ["", null, undefined, "kein-url", "  "]) {
    assert.equal(istTeilenKnopf(u), false, String(u));
  }
});

console.log(fehler === 0 ? "\nAlles gruen." : `\n${fehler} Pruefung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
