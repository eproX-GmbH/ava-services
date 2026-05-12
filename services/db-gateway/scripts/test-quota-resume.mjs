// Q-track v0.1.137 — manual smoke test for the internal-quota surface.
//
// USAGE (against a local gateway with INTERNAL_HMAC_SECRET set):
//   INTERNAL_HMAC_SECRET=... node scripts/test-quota-resume.mjs
//
// Exercises:
//   - POST /internal/quota/try-reserve  (granted path)
//   - POST /internal/quota/park
//   - GET  /internal/quota/parked-batch
//   - GET  /internal/quota/parked-count
//   - DELETE /internal/quota/parked/:tenantId/:germanCompanyId
//
// Not part of any CI; intentionally script-style so the operator can
// run it after a deploy as a "did the wiring actually land" check.

import { createHmac } from "node:crypto";

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:8080";
const SECRET = process.env.INTERNAL_HMAC_SECRET;
if (!SECRET) {
  console.error("Set INTERNAL_HMAC_SECRET in the environment first.");
  process.exit(1);
}

function sign(body) {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
}

async function callJson(method, path, body) {
  const raw = body ? JSON.stringify(body) : "";
  const sig = sign(raw);
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      "x-internal-signature": sig,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? raw : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const tenantId = "smoketest-tenant";
const germanCompanyId = "TEST_HRB_42";

console.log("1. try-reserve");
console.log(await callJson("POST", "/internal/quota/try-reserve", { tenantId, count: 1 }));

console.log("2. park");
console.log(await callJson("POST", "/internal/quota/park", { tenantId, germanCompanyId, transactionId: "test-tx" }));

console.log("3. parked-count");
console.log(await callJson("GET", `/internal/quota/parked-count?tenantId=${tenantId}`));

console.log("4. parked-batch");
console.log(await callJson("GET", `/internal/quota/parked-batch?tenantId=${tenantId}&limit=5`));

console.log("5. delete parked");
console.log(await callJson("DELETE", `/internal/quota/parked/${encodeURIComponent(tenantId)}/${encodeURIComponent(germanCompanyId)}`));

console.log("6. parked-count after delete");
console.log(await callJson("GET", `/internal/quota/parked-count?tenantId=${tenantId}`));
