import assert from "node:assert/strict";
import C from "../src/main/agent/tools/companies.ts";
const { buildCompanyTools } = C;
const aufrufe = [];
const gateway = {
  request: async (path) => {
    aufrufe.push(path);
    if (path === "/v1/companies/X") return { companyId: "X", name: "Test GmbH", country: "DE", registerStatus: "ACTIVE" };
    if (path.endsWith("/profile")) return { branche: "IT" };
    if (path.endsWith("/publications")) return { items: [{ year: 2025, name: "JA 2025", employeeCount: 12, salesVolume: { value: 1500000, currency: "EURO" }, stateOfAffairs: { topic: "GROWTH", bullets: ["Umsatz gestiegen"], kpis: [{ name: "EBIT", value: "100" }], guidance: ["x"], risksOpportunities: ["y"] } }] };
    if (path.endsWith("/contacts")) return { companyName: "Test GmbH", companyFacts: [], companyObservations: [], employments: [] };
    if (path.endsWith("/structured-content")) throw new Error("gateway 404: nicht da");
    return {};
  },
};
const tools = Object.fromEntries(buildCompanyTools({ gateway, getTenantCompanyIds: async () => [] }).map((t) => [t.name, t]));
const ctx = { signal: new AbortController().signal, log() {}, ui: {}, conversationId: "c" };
const nur = await tools.company_get.run({ companyId: "X" }, ctx);
assert.equal(nur.name, "Test GmbH"); assert.equal(nur.bereiche, undefined);
const r = await tools.company_get.run({ companyId: "X", bereiche: ["profil", "publikationen", "kontakte", "register", "profil"] }, ctx);
assert.equal(r.bereiche.profil.branche, "IT");
assert.equal(r.bereiche.publikationen.items[0].umsatz, "1.500.000 EUR", "kompakt: Betrag formatiert");
assert.equal(r.bereiche.publikationen.items[0].guidance, undefined, "kompakt: keine Prognose");
assert.equal(r.bereiche.kontakte.anzahlPersonen, 0);
assert.match(r.bereiche.register.fehler, /404/, "Fehler je Bereich, nicht der ganze Aufruf");
assert.equal(aufrufe.filter((p) => p.endsWith("/profile")).length, 1, "doppelter Bereich nur einmal");
const voll = await tools.company_get.run({ companyId: "X", bereiche: ["publikationen"], ansicht: "voll" }, ctx);
assert.deepEqual(voll.bereiche.publikationen.items[0].stateOfAffairs.guidance, ["x"], "voll: Rohdaten");
assert.match(tools.company_get.preview(r), /\+ profil, publikationen, kontakte, register/);
console.log("company_get-Tests ok");
