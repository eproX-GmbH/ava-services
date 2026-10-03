import assert from "node:assert/strict";
import R from "../src/main/producer-resume.ts";
const { resumeStuckStages, NeustartZaehler } = R;
const vor = (min) => new Date(Date.now() - min * 60_000).toISOString();
let cells = {};
const retries = [];
const gateway = {
  request: async (path, opts) => {
    if (path === "/v1/transactions") return { items: [{ id: "T1", createdAt: new Date().toISOString() }] };
    if (path.endsWith("/pipeline")) return { rows: [{ companyId: "C1", cells }] };
    if (path.endsWith("/retry")) { retries.push(opts.body.stage); return {}; }
    throw new Error(path);
  },
};
const still = { info() {}, warn() {}, debug() {} };
const z = new NeustartZaehler();
// lebt (Lebenszeichen vor 5 Min.) → nicht anfassen
cells = { structuredContent: { state: "in_progress", updatedAt: vor(5) } };
await resumeStuckStages({ gateway, neustartZaehler: z, logger: still });
assert.equal(retries.length, 0, "lebender Schritt bleibt unberuehrt");
// still seit 20 Min. → Neuanstoss, aber hoechstens zweimal
cells = { structuredContent: { state: "in_progress", updatedAt: vor(20) } };
for (let i = 0; i < 4; i++) await resumeStuckStages({ gateway, neustartZaehler: z, logger: still });
assert.equal(retries.length, 2, "hoechstens zwei automatische Neuanstoesse");
console.log("Neustart-Grenze-Tests ok");
