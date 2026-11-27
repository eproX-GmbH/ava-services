import assert from "node:assert/strict";
Object.assign(process.env, {
  DATABASE_URL: "postgres://x:y@127.0.0.1:1/x", EVENT_BUS_URL: "amqp://127.0.0.1:1",
  UPSTREAM_MASTER_DATA_URL: "http://127.0.0.1:1", UPSTREAM_COMPANY_PROFILE_URL: "http://127.0.0.1:1", UPSTREAM_COMPANY_CONTACT_URL: "http://127.0.0.1:1",
  UPSTREAM_COMPANY_PUBLICATION_URL: "http://127.0.0.1:1", UPSTREAM_WEBSITE_URL: "http://127.0.0.1:1", UPSTREAM_STRUCTURED_CONTENT_URL: "http://127.0.0.1:1",
  JWT_ISSUER: "https://issuer.test/realms/ava", JWKS_URI: "http://127.0.0.1:1/jwks",
});
const M0 = await import("../src/lib/firma-nach-website.ts");
const M = M0.default ?? M0;
let fehler = 0;
const pruefe = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

// Nachgebaute Tabellen: ILIKE '%x%' wie Postgres (Gross/Klein egal, \ maskiert).
const ilike = (wert, muster) => {
  const kern = muster.slice(1, -1).replace(/\\([\\%_])/g, "$1");
  return (wert ?? "").toLowerCase().includes(kern.toLowerCase());
};
const db = (zeilen) => ({
  sqls: [],
  async query(sql, werte) {
    this.sqls.push(sql);
    if (sql.includes('"CompanyProfile"')) return { rows: (zeilen.profil ?? []).filter((z) => ilike(z.url, werte[0])) };
    if (sql.includes('FROM "Website"')) return { rows: (zeilen.website ?? []).filter((z) => ilike(z.url, werte[0])) };
    if (sql.includes('"WebsiteVorgabe"')) return { rows: (zeilen.vorgabe ?? []).filter((z) => werte.includes(z.domain)) };
    throw new Error("unerwartete Abfrage");
  },
});

console.log("Domain aus der Eingabe");
await pruefe("nexburg.com", () => assert.equal(M.websiteDomain("nexburg.com"), "nexburg.com"));
await pruefe("URL mit www und Pfad", () => assert.equal(M.websiteDomain("https://www.nexburg.com/de/karriere"), "nexburg.com"));
await pruefe("E-Mail ist keine Website", () => assert.equal(M.websiteDomain("info@nexburg.com"), null));
await pruefe("Unsinn", () => assert.equal(M.websiteDomain("nexburg"), null));

console.log("Firmen mit dieser Website");
const profil = db({
  profil: [
    { id: "AACHEN_HRB_18923", url: "http://www.nexburg.com/" },
    { id: "X_HRB_1", url: "https://www.nexburg.com.example.org/" },
    { id: "X_HRB_2", url: "https://shop.notnexburg.com/" },
  ],
});
await pruefe("Nexburg GmbH ueber das Firmenprofil (Fall PM-2026-0059)", async () => {
  const r = await M.firmenMitWebsite("nexburg.com", 5, { profil, website: db({}) });
  assert.deepEqual(r, [{ companyId: "AACHEN_HRB_18923", url: "http://www.nexburg.com/", quelle: "profil" }]);
});
await pruefe("Website-Stufe und Vorgabe ergaenzen, ohne Doppelte, Register vor WEB", async () => {
  const website = db({
    website: [{ companyId: "WEB_NEXBURG_COM", url: "https://nexburg.com" }, { companyId: "AACHEN_HRB_18923", url: "https://nexburg.com/" }],
    vorgabe: [{ companyId: "AACHEN_HRB_28936", url: "https://www.nexburg.com/", domain: "www.nexburg.com" }],
  });
  const r = await M.firmenMitWebsite("nexburg.com", 5, { profil, website });
  assert.deepEqual(r.map((f) => [f.companyId, f.quelle]), [["AACHEN_HRB_18923", "profil"], ["AACHEN_HRB_28936", "vorgabe"], ["WEB_NEXBURG_COM", "website"]]);
});
await pruefe("Unterstrich in der Domain wird im Muster maskiert", async () => {
  const p = db({ profil: [] });
  await M.firmenMitWebsite("my_firma.de", 5, { profil: p, website: null });
  assert.ok(p.sqls.length === 1);
});
await pruefe("kaputte Quelle wird uebersprungen", async () => {
  const kaputt = { async query() { throw new Error("weg"); } };
  const r = await M.firmenMitWebsite("nexburg.com", 5, { profil: kaputt, website: db({ website: [{ companyId: "AACHEN_HRB_18923", url: "nexburg.com" }] }) });
  assert.deepEqual(r.map((f) => f.companyId), ["AACHEN_HRB_18923"]);
});
await pruefe("nichts gefunden", async () => assert.deepEqual(await M.firmenMitWebsite("gibtsnicht.de", 5, { profil, website: null }), []));

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
