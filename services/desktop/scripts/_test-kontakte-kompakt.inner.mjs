import assert from "node:assert/strict";
import K from "../src/main/agent/tools/kontakte-kompakt.ts";
const { kompakteKontakte } = K;
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
console.log("Kontakte-kompakt-Tests ok");
