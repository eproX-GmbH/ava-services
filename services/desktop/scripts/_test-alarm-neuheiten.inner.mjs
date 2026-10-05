import assert from "node:assert/strict";
import S from "../src/main/agent/real-candidate-source.ts";
const { kandidatAus, buildRealCandidateSource } = S;

// 1) Geschaeftsfuehrer-Wechsel
{
  const c = kandidatAus(
    { art: "profile-change", id: "e1", companyId: "X_HRB_1", kind: "managing-directors",
      added: [{ firstName: "Anna", lastName: "Neu" }], removed: [{ firstName: "Bert", lastName: "Alt" }], occurredAt: "2026-10-04T10:00:00.000Z" },
    "Beispiel GmbH",
  );
  assert.equal(c.kind, "profile-change");
  assert.equal(c.sourceRef, "profile-change:e1");
  assert.match(c.summary, /neu: Anna Neu/);
  assert.match(c.summary, /ausgeschieden: Bert Alt/);
}
// 2) Stammdaten-Aenderung (Adresse)
{
  const c = kandidatAus(
    { art: "profile-change", id: "e2", companyId: "X_HRB_1", kind: "address",
      added: [{ value: "Neue Str. 1, 32423 Minden" }], removed: [{ value: "Alte Str. 9, 32423 Minden" }], occurredAt: "2026-10-04T10:00:00.000Z" },
    "Beispiel GmbH",
  );
  assert.match(c.summary, /Anschrift von Beispiel GmbH .*Alte Str\. 9.*Neue Str\. 1/);
  assert.equal(c.payload.aenderung, "address");
}
// 3) Publikation: sourceRef stabil wie frueher, Datum = Periodenende
{
  const p = { art: "publication", id: "77", companyId: "X_HRB_1", name: "Jahresabschluss 2024", year: 2024, begin: "2024-01-01T00:00:00.000Z", end: "2024-12-31T00:00:00.000Z",
    employeeCount: 12, revenueVolume: { value: 1500000, currency: "EUR" }, salesVolume: null, totalAssetsVolume: null, stateOfAffairs: null,
    createdAt: "2026-10-04T08:00:00.000Z", updatedAt: "2026-10-04T08:00:00.000Z" };
  const c = kandidatAus(p, "Beispiel GmbH");
  assert.equal(c.kind, "publication");
  assert.equal(c.sourceRef, "publication:X_HRB_1:2024:2024-01-01T00:00:00.000Z:2024-12-31T00:00:00.000Z:");
  assert.equal(c.occurredAt, "2024-12-31T00:00:00.000Z");
  assert.match(c.summary, /Geschäftsjahr 2024/);
  assert.match(c.summary, /Umsatz: 1\.500\.000 EUR/);
}
// 4) Stellenwechsel
{
  const c = kandidatAus(
    { art: "contact-change", id: "s1", companyId: "X_HRB_1", typ: "job-changed", personName: "Max Muster", title: "Leiter Einkauf",
      before: "Einkäufer", after: "Leiter Einkauf", occurredAt: "2026-10-05T06:00:00.000Z" },
    "Beispiel GmbH",
  );
  assert.equal(c.kind, "contact-change");
  assert.equal(c.sourceRef, "contact-change:s1");
  assert.match(c.summary, /Max Muster bei Beispiel GmbH hat eine neue Funktion/);
}
// 5) Neue Ansprechpartner gebuendelt
{
  const c = kandidatAus(
    { art: "new-contacts", id: "X_HRB_1:2026-10-05", companyId: "X_HRB_1", anzahl: 10,
      personen: [{ name: "A B", title: "Geschäftsführer" }, { name: "C D", title: null }], occurredAt: "2026-10-05T06:00:00.000Z" },
    "Beispiel GmbH",
  );
  assert.equal(c.kind, "contact-change");
  assert.equal(c.sourceRef, "new-contacts:X_HRB_1:2026-10-05");
  assert.match(c.summary, /10 neue Ansprechpartner .* A B \(Geschäftsführer\), C D und 8 weitere/);
}
// 6) Quelle: Firmenliste seitenweise + Buendel ans Gateway, Namen aus der Matrix
{
  const calls = [];
  const gateway = {
    async request(path, opts = {}) {
      calls.push({ path, opts });
      if (path === "/v1/companies/matrix") {
        const seite = opts.query.pageNumber;
        if (seite === 1) return { companies: Array.from({ length: 200 }, (_, i) => ({ companyId: `F${i}`, name: `Firma ${i}` })) };
        return { companies: [{ companyId: "F200", name: "Firma 200" }] };
      }
      if (path === "/v1/alerts/neuheiten") {
        assert.equal(opts.method, "POST");
        return { items: opts.body.companyIds.includes("F200")
          ? [{ art: "contact-change", id: "z", companyId: "F200", typ: "company-email-changed", personName: null, title: null, before: "a@x.de", after: "b@x.de", occurredAt: "2026-10-05T06:00:00.000Z" }]
          : [] };
      }
      throw new Error("unerwartet " + path);
    },
  };
  const src = buildRealCandidateSource(gateway);
  const out = await src(new Date("2026-10-04T00:00:00Z"));
  assert.equal(calls.filter((c) => c.path === "/v1/companies/matrix").length, 2);
  assert.equal(calls.filter((c) => c.path === "/v1/alerts/neuheiten").length, 1, "201 Firmen = ein Buendel von 300");
  assert.equal(calls.find((c) => c.path === "/v1/alerts/neuheiten").opts.body.since, "2026-10-04T00:00:00.000Z");
  assert.equal(out.length, 1);
  assert.equal(out[0].companyName, "Firma 200");
}
console.log("alarm-neuheiten: alle Pruefungen bestanden");
