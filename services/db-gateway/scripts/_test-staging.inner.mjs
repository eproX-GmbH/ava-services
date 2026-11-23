// Staging/UAT (docs/PLAN_STAGING.md): Kanal-Logik, Zielversionen, Weiche (HTTP gestreamt, SSE,
// WebSocket) und Wächter gegen einen nachgebauten Staging-Server. Keine Datenbank nötig.
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { WebSocketServer, WebSocket } from "ws";
import { Hono } from "hono";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const jwks = http.createServer((_q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => jwks.listen(0, "127.0.0.1", r));
const ISS = "https://issuer.test/realms/ava";
Object.assign(process.env, {
  DATABASE_URL: "postgres://x:y@127.0.0.1:1/x", EVENT_BUS_URL: "amqp://127.0.0.1:1",
  UPSTREAM_MASTER_DATA_URL: "http://127.0.0.1:1", UPSTREAM_COMPANY_PROFILE_URL: "http://127.0.0.1:1", UPSTREAM_COMPANY_CONTACT_URL: "http://127.0.0.1:1",
  UPSTREAM_COMPANY_PUBLICATION_URL: "http://127.0.0.1:1", UPSTREAM_WEBSITE_URL: "http://127.0.0.1:1", UPSTREAM_STRUCTURED_CONTENT_URL: "http://127.0.0.1:1",
  JWT_ISSUER: ISS, JWKS_URI: `http://127.0.0.1:${jwks.address().port}/jwks`,
});
const token = (sub, email) => new SignJWT({ scope: "openid", ...(email ? { email } : {}) }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setSubject(sub).setIssuer(ISS).setIssuedAt().setExpirationTime("5m").sign(privateKey);

const K = (await import("../src/lib/kanal.ts")).default ?? (await import("../src/lib/kanal.ts"));
const W = (await import("../src/lib/staging-weiche.ts")).default ?? (await import("../src/lib/staging-weiche.ts"));

let ok = 0, fehl = 0;
async function pruefe(name, f) {
  try { await f(); ok++; console.log("  ok  ", name); } catch (e) { fehl++; console.log("  FEHL", name, "\n      ", e?.message ?? e); }
}

await pruefe("Muster: Plus-Adressen, ganze Adresse, ohne Groß/klein", () => {
  assert.ok(K.musterPasst("Joyce+T1@quikk.de", "joyce+*@quikk.de"));
  assert.ok(!K.musterPasst("joyce@quikk.de", "joyce+*@quikk.de"));
  assert.ok(!K.musterPasst("xjoyce+1@quikk.de", "joyce+*@quikk.de"));
  assert.ok(!K.musterPasst("joyce+1@quikk.de.evil.com", "joyce+*@quikk.de"));
  assert.ok(K.musterPasst("test.a@eprox-gmbh.de", "test.*@eprox-gmbh.de"));
  assert.ok(!K.musterPasst("testXa@eprox-gmbh.de", "test.*@eprox-gmbh.de"), "Punkt ist wörtlich");
});

await pruefe("Zielversion: Prod nur freigegeben (Altbestand darunter zählt), Staging neuester nicht verworfener", () => {
  const tags = ["0.1.975", "0.1.976", "0.1.977", "0.1.978"];
  const zeilen = [{ version: "0.1.976", status: "freigegeben" }, { version: "0.1.977", status: "kandidat" }, { version: "0.1.978", status: "verworfen" }];
  assert.equal(K.zielVersion(tags, zeilen, "prod"), "0.1.976");
  assert.equal(K.zielVersion(tags, zeilen, "staging"), "0.1.977");
  assert.equal(K.zielVersion(tags, [...zeilen, { version: "0.1.977", status: "freigegeben" }].filter((z, i, a) => a.findLastIndex((x) => x.version === z.version) === i), "prod"), "0.1.977");
  assert.equal(K.zielVersion(["0.1.900"], [{ version: "0.1.976", status: "freigegeben" }], "prod"), "0.1.900", "ältere Tags gelten als freigegeben");
});

await pruefe("Neue Kandidaten: nur jenseits der höchsten Freigabe und noch ohne Zeile", () => {
  assert.deepEqual(K.neueKandidaten(["v0.1.970", "v0.1.977", "0.1.978", "0.1.976"], [{ version: "0.1.976", status: "freigegeben" }, { version: "0.1.978", status: "kandidat" }]), ["0.1.977"]);
});

await pruefe("Kanal: nur mit Eintrag UND Weiche; Zuständigkeit je Rolle; Notschalter", () => {
  K.kanalStandSetzen({ zugang: [["a-staging", { kanal: "staging", testZahlung: true }]], routing: false });
  assert.equal(K.kanalVon("a-staging"), "prod", "Weiche aus");
  K.kanalStandSetzen({ zugang: [["a-staging", { kanal: "staging", testZahlung: true }]], routing: true });
  assert.equal(K.kanalVon("a-staging"), "staging");
  assert.equal(K.kanalVon("a-prod"), "prod");
  delete process.env.GATEWAY_ROLLE;
  assert.ok(K.bedientKonto("a-prod") && !K.bedientKonto("a-staging"));
  process.env.GATEWAY_ROLLE = "staging";
  assert.ok(!K.bedientKonto("a-prod") && K.bedientKonto("a-staging"));
  delete process.env.GATEWAY_ROLLE;
  process.env.STAGING_ROUTING = "0";
  assert.equal(K.kanalVon("a-staging"), "prod", "Notschalter");
  delete process.env.STAGING_ROUTING;
  K.kanalStandSetzen({ muster: ["joyce+*@quikk.de"] });
  assert.ok(K.testAdresse("joyce+x@quikk.de") && !K.testAdresse("kunde@firma.de") && !K.testAdresse(null));
});

await pruefe("Update-Feed: relative Dateien werden absolute GitHub-Adressen, absolute bleiben", async () => {
  const U = (await import("../src/routes/v1/updates-feed.ts")).default ?? (await import("../src/routes/v1/updates-feed.ts"));
  const yml = "version: 0.1.977\nfiles:\n  - url: AVA-0.1.977-arm64-mac.zip\n    sha512: abc\n    size: 1\n  - url: 'AVA 0.1.977.dmg'\npath: AVA-0.1.977-arm64-mac.zip\nsha512: abc\nreleaseDate: '2026-11-23T10:00:00.000Z'";
  const aus = U.ymlAbsolut(yml, "0.1.977", "o/r");
  assert.match(aus, /  - url: https:\/\/github.com\/o\/r\/releases\/download\/v0.1.977\/AVA-0.1.977-arm64-mac.zip/);
  assert.match(aus, /AVA%200.1.977.dmg/);
  assert.match(aus, /^path: https:\/\/github.com\/o\/r\/releases\/download\/v0.1.977\/AVA-0.1.977-arm64-mac.zip$/m);
  assert.match(aus, /releaseDate: '2026-11-23T10:00:00.000Z'/);
  assert.equal(U.ymlAbsolut("  - url: https://x/y.zip", "1.0.0", "o/r"), "  - url: https://x/y.zip");
});

// ---- Weiche gegen einen nachgebauten Staging-Server ---------------------------------------
const gesehen = [];
const staging = http.createServer((q, s) => {
  if (q.url.startsWith("/sse")) {
    s.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0; const t = setInterval(() => { s.write(`data: ${++n}\n\n`); if (n === 3) { clearInterval(t); s.end(); } }, 20);
    return;
  }
  let laenge = 0;
  q.on("data", (c) => { laenge += c.length; });
  q.on("end", () => {
    gesehen.push({ url: q.url, weiter: q.headers["x-ava-weitergeleitet"], laenge, auth: !!q.headers.authorization });
    s.writeHead(201, { "content-type": "application/json", "x-eigen": "ja" });
    s.end(JSON.stringify({ von: "staging", laenge }));
  });
});
const wss = new WebSocketServer({ noServer: true });
staging.on("upgrade", (q, sock, head) => wss.handleUpgrade(q, sock, head, (ws) => { ws.send(`hallo ${q.headers["x-ava-weitergeleitet"] ?? "-"}`); ws.on("message", (m) => ws.send(`echo ${m}`)); }));
await new Promise((r) => staging.listen(0, "127.0.0.1", r));
process.env.STAGING_GATEWAY_URL = `http://127.0.0.1:${staging.address().port}`;
K.kanalStandSetzen({ zugang: [["a-staging", { kanal: "staging", testZahlung: false }]], routing: true });

const app = new Hono();
app.use("*", W.stagingWeiche);
app.use("*", W.stagingWaechter);
app.all("*", (c) => c.json({ von: "prod" }));
const { serve } = await import("@hono/node-server");
const prod = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((r) => prod.once("listening", r));
const P = `http://127.0.0.1:${prod.address().port}`;
const tS = await token("a-staging"), tP = await token("a-prod");

await pruefe("Weiche: Prod-Konto bleibt, Staging-Konto geht weiter (Status, Kopfzeilen, Kennzeichen)", async () => {
  assert.deepEqual(await (await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${tP}` } })).json(), { von: "prod" });
  const r = await fetch(`${P}/v1/x?a=1`, { headers: { authorization: `Bearer ${tS}` } });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("x-eigen"), "ja");
  assert.equal(r.headers.get("x-ava-gateway"), "staging");
  assert.equal((await r.json()).von, "staging");
  assert.equal(gesehen.at(-1).url, "/v1/x?a=1");
  assert.equal(gesehen.at(-1).weiter, "1");
  assert.ok(gesehen.at(-1).auth);
});

await pruefe("Weiche: 3 MB Körper gestreamt (Fly-Replay könnte nur 1 MB)", async () => {
  const body = Buffer.alloc(3 * 1024 * 1024, 7);
  const r = await fetch(`${P}/v1/upload`, { method: "POST", headers: { authorization: `Bearer ${tS}`, "content-type": "application/octet-stream" }, body });
  assert.equal((await r.json()).laenge, body.length);
});

await pruefe("Weiche: SSE kommt Stück für Stück durch", async () => {
  const r = await fetch(`${P}/sse`, { headers: { authorization: `Bearer ${tS}` } });
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const text = await r.text();
  assert.equal(text, "data: 1\n\ndata: 2\n\ndata: 3\n\n");
});

await pruefe("Weiche: ohne Token, ungültiges Token, Webhook und Health bleiben in Prod", async () => {
  assert.equal((await (await fetch(`${P}/v1/cloud/angebot`)).json()).von, "prod");
  assert.equal((await (await fetch(`${P}/v1/x`, { headers: { authorization: "Bearer kaputt.x.y" } })).json()).von, "prod");
  assert.equal((await (await fetch(`${P}/v1/billing/webhook`, { method: "POST", headers: { authorization: `Bearer ${tS}` }, body: "{}" })).json()).von, "prod");
  assert.equal((await (await fetch(`${P}/health`, { headers: { authorization: `Bearer ${tS}` } })).json()).von, "prod");
});

await pruefe("Weiche: Weiche aus → alles Prod; Staging weg → 503 mit Hinweis", async () => {
  K.kanalStandSetzen({ zugang: [["a-staging", { kanal: "staging", testZahlung: false }]], routing: false });
  assert.equal((await (await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${tS}` } })).json()).von, "prod");
  K.kanalStandSetzen({ zugang: [["a-staging", { kanal: "staging", testZahlung: false }]], routing: true });
  const alt = process.env.STAGING_GATEWAY_URL;
  process.env.STAGING_GATEWAY_URL = "http://127.0.0.1:1";
  const r = await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${tS}` } });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "staging_nicht_erreichbar");
  process.env.STAGING_GATEWAY_URL = alt;
});

await pruefe("Test-Adresse: erste Anfrage (vor whoami) geht schon nach Staging; Mitglieder und fremde Adressen nicht", async () => {
  K.kanalStandSetzen({ zugang: [["a-staging", { kanal: "staging", testZahlung: false }]], muster: ["durchlauf*@ava-staging.test"], routing: true });
  const mitglieder = new Set(["a-mitglied"]), zugaenge = new Set(), abfragen = [];
  W.weicheDbSetzen(() => ({ query: async (_sql, [id]) => { abfragen.push(id); if (!mitglieder.has(id)) zugaenge.add(id); return { rows: [{ drin: zugaenge.has(id) }] }; } }));
  const neu = await fetch(`${P}/v1/cloud/kaufen`, { method: "POST", headers: { authorization: `Bearer ${await token("a-neu", "Durchlauf-1@ava-staging.test")}` } });
  assert.equal(neu.headers.get("x-ava-gateway"), "staging");
  assert.ok(zugaenge.has("a-neu") && K.kanalVon("a-neu") === "staging" && K.testZahlungFuer("a-neu"));
  const alt = await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${await token("a-mitglied", "durchlauf-2@ava-staging.test")}` } });
  assert.equal((await alt.json()).von, "prod", "schon Mitglied (z. B. vom Betreiber aus Staging genommen) bleibt draußen");
  await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${await token("a-mitglied", "durchlauf-2@ava-staging.test")}` } });
  assert.equal(abfragen.filter((x) => x === "a-mitglied").length, 1, "Absage wird gemerkt, keine Abfrage je Anfrage");
  const fremd = await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${await token("a-fremd", "joyce@quikk.de")}` } });
  assert.equal((await fremd.json()).von, "prod");
  assert.ok(!abfragen.includes("a-fremd"), "fremde Adresse ohne Datenbank");
  process.env.GATEWAY_ROLLE = "staging";
  const w = await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${await token("a-neu2", "durchlauf-3@ava-staging.test")}` } });
  assert.notEqual(w.status, 403, "Wächter lässt neue Test-Adresse durch");
  delete process.env.GATEWAY_ROLLE;
  K.kanalStandSetzen({ zugang: [["a-staging", { kanal: "staging", testZahlung: false }]], routing: true });
});

await pruefe("Wächter: gerade eingetragenes Konto (Stand noch alt) wird nachgeladen, fremdes bleibt 403 ohne Dauerabfrage", async () => {
  K.kanalStandSetzen({ zugang: [], routing: false });
  const zeilen = new Map([["a-frisch", { kanal: "staging", testZahlung: true }]]), abfragen = [];
  W.weicheDbSetzen(() => ({ query: async (sql, [id]) => { abfragen.push(id); if (/INSERT/.test(sql)) return { rows: [{ drin: false }] }; return { rows: zeilen.has(id) ? [zeilen.get(id)] : [] }; } }));
  process.env.GATEWAY_ROLLE = "staging";
  const r = await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${await token("a-frisch")}` } });
  assert.notEqual(r.status, 403, "Prod hat schon weitergeleitet, Staging-Stand ist noch alt");
  assert.equal(K.zugangVon("a-frisch")?.kanal, "staging");
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${await token("a-weg")}` } })).status, 403);
  assert.equal(abfragen.filter((x) => x === "a-weg").length, 1);
  delete process.env.GATEWAY_ROLLE;
  K.kanalStandSetzen({ zugang: [["a-staging", { kanal: "staging", testZahlung: false }]], routing: true });
});

await pruefe("Wächter (Rolle staging): fremdes Konto 403, Staging-Konto und ohne Token durch", async () => {
  process.env.GATEWAY_ROLLE = "staging";
  const r = await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${tP}` } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "kein_staging_zugang");
  assert.equal((await (await fetch(`${P}/v1/x`, { headers: { authorization: `Bearer ${tS}` } })).json()).von, "prod", "Staging-Konto wird bedient (hier: Endpunkt antwortet)");
  assert.equal((await (await fetch(`${P}/v1/cloud/angebot`)).json()).von, "prod");
  delete process.env.GATEWAY_ROLLE;
});

await pruefe("Relais: WebSocket eines Staging-Kontos wird durchgereicht, Prod-Konto nicht", async () => {
  const relaisServer = http.createServer();
  const { KopfRelais } = await import("../src/lib/kopf-relais.ts");
  const relais = new KopfRelais("/kopf-relais");
  let lokal = 0;
  relais.attach(relaisServer, async (t) => ({ actorId: t === "S" ? "a-staging" : "a-prod", tenantId: "t" }), (q, sock, head, wer) => { const r = W.relaisWeiche(q, sock, head, wer); if (!r) lokal++; return r; });
  await new Promise((r) => relaisServer.listen(0, "127.0.0.1", r));
  const ws = new WebSocket(`ws://127.0.0.1:${relaisServer.address().port}/kopf-relais?access_token=S`);
  const nachrichten = [];
  await new Promise((res, rej) => {
    ws.on("message", (m) => { nachrichten.push(String(m)); if (nachrichten.length === 1) ws.send("ping"); else { ws.close(); res(); } });
    ws.on("error", rej);
    setTimeout(() => rej(new Error("Zeitüberschreitung")), 3000);
  });
  assert.deepEqual(nachrichten, ["hallo 1", "echo ping"]);
  const ws2 = new WebSocket(`ws://127.0.0.1:${relaisServer.address().port}/kopf-relais?access_token=P`);
  await new Promise((res) => { ws2.on("open", () => { ws2.close(); res(); }); ws2.on("error", () => res()); setTimeout(res, 1500); });
  assert.equal(lokal, 1, "Prod-Konto bleibt im lokalen Relais");
  relais.stop?.();
  relaisServer.close();
});

prod.close(); staging.close(); jwks.close(); wss.close();
console.log(fehl ? `\n${fehl} FEHLGESCHLAGEN, ${ok} ok` : `\nalles gruen (${ok})`);
process.exit(fehl ? 1 : 0);
