import { test } from "node:test";
import assert from "node:assert/strict";
import { kontakteAusAntwort } from "./kontakte";

test("kontakteAusAntwort trennt belastbare und offene Adressen", () => {
  const k = kontakteAusAntwort("c1", {
    companyName: "Muster GmbH",
    websiteUrl: "https://www.muster.de",
    employments: [{ personId: "p1" }, { personId: "p2" }],
    companyObservations: [
      { id: "o1", source: "website" },
      { id: "o2", source: "pattern:offen" },
    ],
    companyFacts: [
      { status: "ACTIVE", entityType: "COMPANY", field: "email", value: "Info@Muster.de" },
      { status: "ACTIVE", entityType: "PERSON", personId: "p1", field: "fullName", value: "Anna Meier" },
      { status: "ACTIVE", entityType: "PERSON", personId: "p1", field: "email", value: "anna.meier@muster.de", lastObsId: "o1" },
      { status: "ACTIVE", entityType: "PERSON", personId: "p2", field: "fullName", value: "Bernd Kunz" },
      { status: "ACTIVE", entityType: "PERSON", personId: "p2", field: "email", value: "bernd.kunz@muster.de", lastObsId: "o2" },
      { status: "ACTIVE", entityType: "PERSON", personId: "p9", field: "fullName", value: "Fremd Person" },
      { status: "INACTIVE", entityType: "PERSON", personId: "p1", field: "email", value: "alt@muster.de" },
    ],
  });
  assert.equal(k.name, "Muster GmbH");
  assert.deepEqual(k.firmenEmails, ["info@muster.de"]);
  assert.equal(k.personen.length, 2, "p9 ist nicht beschaeftigt");
  assert.deepEqual(k.personen.find((p) => p.personId === "p1")?.emails, ["anna.meier@muster.de"]);
  assert.deepEqual(k.personen.find((p) => p.personId === "p2")?.offeneEmails, ["bernd.kunz@muster.de"]);
});

test("kontakteAusAntwort ohne Personen und ohne Namen", () => {
  const k = kontakteAusAntwort("c2", {});
  assert.equal(k.name, "c2");
  assert.equal(k.websiteUrl, null);
  assert.deepEqual(k.personen, []);
});
