import assert from "node:assert/strict";
import K from "../src/main/agent/tools/kontakte-kompakt.ts";
const { kompakteKontakte, emailStatus, emailHerkunft } = K;
const roh = {
  companyName: "Test GmbH", websiteUrl: "https://test.de",
  companyFacts: [
    { entityType: "COMPANY", field: "email", value: "info@test.de", status: "ACTIVE" },
    { entityType: "PERSON", entityId: "p1", field: "fullName", value: "Anna Meier", status: "ACTIVE", lastObsId: "o1" },
    { entityType: "PERSON", entityId: "p1", field: "jobTitle", value: "Geschäftsführerin", status: "ACTIVE", lastObsId: "o2" },
    { entityType: "PERSON", entityId: "p1", field: "jobTitle", value: "Alte Rolle", status: "INACTIVE" },
    { entityType: "PERSON", entityId: "p2", field: "fullName", value: "Bernd Alt", status: "ACTIVE" },
  ],
  companyObservations: [{ id: "o1", source: "agent:website_people" }, { id: "o2", source: "apify:company-profile" }],
  employments: [
    { personId: "p1", isCurrent: false }, { personId: "p1", isCurrent: true },
    { personId: "p2", isCurrent: false },
  ],
  companySignals: [{ id: "s1", big: "x".repeat(10000) }],
};
const k = kompakteKontakte(roh);
assert.equal(k.anzahlPersonen, 1, "nur aktuelle Personen");
assert.equal(k.personen[0].name, "Anna Meier");
assert.equal(k.personen[0].rolle, "Geschäftsführerin", "nur aktive Fakten");
assert.deepEqual(k.personen[0].quelle, ["Firmenwebsite", "LinkedIn"]);
assert.deepEqual(k.firmenkontakt.emails, ["info@test.de"]);
assert.ok(!JSON.stringify(k).includes("xxxx"), "kein Verlauf/keine Signale");
assert.match(k.hinweis, /mitBelegen/);

// E-Mail-Status (2026-11-10): eine Stelle fuer die Belastbarkeit einer Adresse.
assert.equal(emailStatus("pattern:smtp"), "bestätigt");
assert.equal(emailStatus("zuordnung:smtp"), "bestätigt");
assert.equal(emailStatus("pattern:reply"), "bestätigt");
assert.equal(emailStatus("user:angabe"), "bestätigt");
assert.equal(emailStatus("agent:website_people"), "bestätigt");
assert.equal(emailStatus("apify:company-employees"), "bestätigt");
assert.equal(emailStatus(null), "bestätigt");
assert.equal(emailStatus("pattern:catchall"), "wahrscheinlich");
assert.equal(emailStatus("zuordnung:catchall"), "wahrscheinlich");
assert.equal(emailStatus("pattern:offen"), "ungeprüft");
assert.equal(emailStatus("zuordnung:offen"), "ungeprüft");
assert.equal(emailStatus("pattern:abgelehnt"), "abgelehnt");
assert.equal(emailStatus("zuordnung:abgelehnt"), "abgelehnt");
assert.equal(emailStatus("pattern:neu_und_unbekannt"), "ungeprüft", "unbekannte Pruefstufe vorsichtig");
assert.equal(emailHerkunft("pattern:smtp"), "abgeleitet (E-Mail-Muster), vom Mail-Server bestätigt");
assert.equal(emailHerkunft("agent:website"), "Firmenwebsite");
assert.equal(emailHerkunft("user:angabe"), "vom Nutzer angegeben");
assert.equal(emailHerkunft(null), null);

const person = (id, name) => ({ entityType: "PERSON", entityId: id, field: "fullName", value: name, status: "ACTIVE" });
const mail = (id, value, lastSource, extra = {}) => ({ entityType: "PERSON", entityId: id, field: "email", value, status: "ACTIVE", lastSource, ...extra });
const m = kompakteKontakte({
  companyName: "Muster IT GmbH",
  companyFacts: [
    // Der Anlassfall: Adresse aus dem Muster, vom Mailserver bestaetigt.
    person("a", "Christian Beispiel"), mail("a", "christian.beispiel@muster-it.de", "pattern:smtp"),
    // Abgelehnt: darf nie als email erscheinen.
    person("b", "Bea Abgelehnt"), mail("b", "bea.abgelehnt@muster-it.de", "pattern:abgelehnt"),
    // Abgelehnte Ableitung neben gefundener Adresse: die gefundene gewinnt.
    person("c", "Carl Beides"), mail("c", "c.beides@muster-it.de", "pattern:abgelehnt"), mail("c", "carl@muster-it.de", "agent:website_people"),
    // Offen zuerst, bestaetigt danach: Status schlaegt Reihenfolge.
    person("d", "Dora Rang"), mail("d", "dora.rang@muster-it.de", "pattern:offen"), mail("d", "d.rang@muster-it.de", "zuordnung:smtp"),
    // Gleicher Status: die erste (Fakt dieser Firma) bleibt.
    person("e", "Emil Gleich"), mail("e", "emil.gleich@muster-it.de", "pattern:catchall"), mail("e", "e.gleich@muster-it.de", "pattern:catchall"),
    person("f", "Frieda Offen"), mail("f", "frieda.offen@muster-it.de", "pattern:offen"),
    person("g", "Gero Ohne"),
    // Aelteres Gateway ohne lastSource: Rueckfall auf die Beobachtungsliste.
    person("h", "Hanna Alt"), { entityType: "PERSON", entityId: "h", field: "email", value: "hanna.alt@muster-it.de", status: "ACTIVE", lastObsId: "o9" },
    // Inaktive Adresse zaehlt nicht.
    person("i", "Ina Inaktiv"), mail("i", "ina@muster-it.de", "pattern:smtp", { status: "INACTIVE" }),
  ],
  companyObservations: [{ id: "o9", source: "pattern:catchall" }],
  employments: [],
});
const je = Object.fromEntries(m.personen.map((p) => [p.personId, p]));
assert.equal(je.a.email, "christian.beispiel@muster-it.de", "bestaetigte Muster-Adresse wird ausgegeben");
assert.equal(je.a.emailStatus, "bestätigt");
assert.equal(je.a.emailHerkunft, "abgeleitet (E-Mail-Muster), vom Mail-Server bestätigt");
assert.equal(je.b.email, undefined, "abgelehnte Adresse nie als email");
assert.equal(je.b.emailStatus, undefined);
assert.equal(je.b.emailAbgelehnt, "bea.abgelehnt@muster-it.de");
assert.equal(je.c.email, "carl@muster-it.de");
assert.equal(je.c.emailStatus, "bestätigt");
assert.equal(je.c.emailAbgelehnt, undefined, "abgelehnte Adresse entfaellt, wenn es eine brauchbare gibt");
assert.equal(je.d.email, "d.rang@muster-it.de", "bestaetigt schlaegt ungeprueft");
assert.equal(je.d.emailHerkunft, "Firmenadresse, der Person zugeordnet, vom Mail-Server bestätigt");
assert.equal(je.e.email, "emil.gleich@muster-it.de", "bei gleichem Status bleibt die erste");
assert.equal(je.e.emailStatus, "wahrscheinlich");
assert.equal(je.f.emailStatus, "ungeprüft");
assert.equal(je.g.email, undefined);
assert.equal(je.h.emailStatus, "wahrscheinlich", "Quelle aus der Beobachtungsliste");
assert.equal(je.i.email, undefined, "inaktive Fakten bleiben draussen");
assert.ok(!JSON.stringify(m).includes("emailAbgeleitet"), "emailAbgeleitet gibt es nicht mehr");
console.log("Kontakte-kompakt-Tests ok");
