import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGatewayClient } from "./gateway";
import { buildProgressEvent } from "./progress";
import { userScopedBindingKey, userScopedQueueName, TRIGGER } from "./routing";

function fakeFetch(antworten: Record<string, { status: number; body?: unknown }>) {
  const aufrufe: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    const pfad = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    aufrufe.push({ url: pfad, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get("authorization") });
    const a = antworten[`${init?.method ?? "GET"} ${pfad}`] ?? { status: 404 };
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { f, aufrufe };
}

const ADRESSE = { personId: "p1", email: "a.b@muster.de", muster: "vorname.nachname", beleg: "a.b@muster.de", baseline: "a.b@muster.de", herkunft: "muster" as const, art: "offen" as const, domainQuelle: "website" as const, checkedAt: "2026-10-11T12:00:00.000Z" };

test("derived-email: 200 gespeichert, 409 vorhanden, 422 abgewiesen, 500 wirft", async () => {
  for (const [status, erwartet] of [[200, "gespeichert"], [409, "vorhanden"], [422, "abgewiesen"]] as const) {
    const { f, aufrufe } = fakeFetch({ "POST /v1/companies/c1/contacts/derived-email": { status, body: {} } });
    const g = makeGatewayClient({ url: "https://gw.test", token: "tok", fetch: f });
    assert.equal(await g.speichereAdresse("c1", ADRESSE), erwartet);
    assert.equal(aufrufe[0]?.auth, "Bearer tok");
    assert.equal((aufrufe[0]?.body as { email: string }).email, "a.b@muster.de");
  }
  const { f } = fakeFetch({ "POST /v1/companies/c1/contacts/derived-email": { status: 500 } });
  await assert.rejects(makeGatewayClient({ url: "https://gw.test", token: "tok", fetch: f }).speichereAdresse("c1", ADRESSE), /status 500/);
});

test("Muster: 404 = unbekannt, 401 wirft mit 'status 401' (Supervisor erneuert das Token)", async () => {
  const leer = fakeFetch({});
  assert.equal(await makeGatewayClient({ url: "https://gw.test", token: "tok", fetch: leer.f }).holeMuster("muster.de"), null);
  const abgelaufen = fakeFetch({ "GET /v1/email-patterns/muster.de": { status: 401, body: { error: "invalid_token" } } });
  await assert.rejects(makeGatewayClient({ url: "https://gw.test", token: "tok", fetch: abgelaufen.f }).holeMuster("muster.de"), /status 401/);
});

test("ohne Token keine Anfrage", async () => {
  const { f, aufrufe } = fakeFetch({});
  await assert.rejects(makeGatewayClient({ url: "https://gw.test", token: null, fetch: f }).holeKontakte("c1"), /PRODUCER_GATEWAY_TOKEN/);
  assert.equal(aufrufe.length, 0);
});

test("Routing und Fortschritt folgen dem Producer-Muster", () => {
  assert.equal(userScopedQueueName("upsert-company-email", "u1"), "upsert-company-email-u1");
  assert.equal(userScopedBindingKey(TRIGGER, "u1"), "companyContact.createEmailVerification.u1");
  assert.equal(userScopedBindingKey(TRIGGER, ""), TRIGGER);
  const e = buildProgressEvent({ transactionId: "t1", companyId: "c1", state: "completed" }, "ten");
  assert.equal(e.type, "transaction.progress");
  assert.equal(e.subject, "c1");
  assert.deepEqual({ ...(e.data as Record<string, unknown>), updatedAt: undefined }, { transactionId: "t1", tenantId: "ten", service: "company-email", companyId: "c1", state: "completed", errorMessage: undefined, updatedAt: undefined });
});
