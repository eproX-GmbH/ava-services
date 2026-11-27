import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

// Nachgebauter Objektspeicher: merkt sich Objekte, prueft die Form der Signatur, kann stolpern.
const objekte = new Map();
const anfragen = [];
let stolpern = 0;
const s3 = http.createServer((q, s) => {
  const teile = [];
  q.on("data", (c) => teile.push(c));
  q.on("end", () => {
    const koerper = Buffer.concat(teile);
    anfragen.push({ methode: q.method, pfad: q.url, auth: q.headers.authorization ?? "", hash: q.headers["x-amz-content-sha256"], typ: q.headers["content-type"] });
    if (stolpern > 0) { stolpern--; s.statusCode = 503; return s.end("langsam"); }
    const ok = /^AWS4-HMAC-SHA256 Credential=TESTZUGANG\/\d{8}\/eu-test-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(q.headers.authorization ?? "") && q.headers["x-amz-content-sha256"] === createHash("sha256").update(koerper).digest("hex");
    if (!ok) { s.statusCode = 403; return s.end("<Error><Code>SignatureDoesNotMatch</Code></Error>"); }
    if (q.method === "PUT") { objekte.set(q.url, { koerper, typ: q.headers["content-type"] }); s.statusCode = 200; return s.end(); }
    const o = objekte.get(q.url);
    if (!o) { s.statusCode = 404; return s.end(); }
    s.setHeader("content-type", o.typ);
    s.end(q.method === "HEAD" ? undefined : o.koerper);
  });
});
await new Promise((r) => s3.listen(0, "127.0.0.1", r));

Object.assign(process.env, {
  DATABASE_URL: "postgres://x:y@127.0.0.1:1/x", EVENT_BUS_URL: "amqp://127.0.0.1:1",
  UPSTREAM_MASTER_DATA_URL: "http://127.0.0.1:1", UPSTREAM_COMPANY_PROFILE_URL: "http://127.0.0.1:1", UPSTREAM_COMPANY_CONTACT_URL: "http://127.0.0.1:1",
  UPSTREAM_COMPANY_PUBLICATION_URL: "http://127.0.0.1:1", UPSTREAM_WEBSITE_URL: "http://127.0.0.1:1", UPSTREAM_STRUCTURED_CONTENT_URL: "http://127.0.0.1:1",
  JWT_ISSUER: "https://issuer.test/realms/ava", JWKS_URI: "http://127.0.0.1:1/jwks",
});
const O0 = await import("../src/lib/objektspeicher.ts"); const O = O0.default ?? O0;
const L0 = await import("../src/lib/firmen-logos.ts"); const L = L0.default ?? L0;

let fehler = 0;
const pruefe = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

function png(b, h, bytes = 400) {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(buf);
  buf.writeUInt32BE(b, 16); buf.writeUInt32BE(h, 20);
  return buf;
}
const b64 = (buf) => buf.toString("base64");
const svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 221 27"><rect width="221" height="27"/><circle cx="5" cy="5" r="4"/></svg>';
const zugang = { endpunkt: `http://127.0.0.1:${s3.address().port}`, region: "eu-test-1", bucket: "ava-test", zugang: "TESTZUGANG", geheimnis: "geheim" };

console.log("Objektspeicher");
await pruefe("ohne vollstaendige Angaben ruht der Speicher; nur https gilt", () => {
  assert.equal(O.objektspeicherZugang({}), null);
  assert.equal(O.objektspeicherZugang({ OBJEKTSPEICHER_ENDPUNKT: "http://s3.example", OBJEKTSPEICHER_REGION: "r", OBJEKTSPEICHER_BUCKET: "b", OBJEKTSPEICHER_ZUGANG: "k", OBJEKTSPEICHER_GEHEIMNIS: "s" }), null);
  assert.deepEqual(O.objektspeicherZugang({ OBJEKTSPEICHER_ENDPUNKT: "https://s3.eu-central-2.wasabisys.com/", OBJEKTSPEICHER_REGION: "eu-central-2", OBJEKTSPEICHER_BUCKET: "ava-prod", OBJEKTSPEICHER_ZUGANG: "k", OBJEKTSPEICHER_GEHEIMNIS: "s" }), { endpunkt: "https://s3.eu-central-2.wasabisys.com", region: "eu-central-2", bucket: "ava-prod", zugang: "k", geheimnis: "s" });
});
await pruefe("Signatur ist bei gleicher Eingabe gleich und haengt am Inhalt", () => {
  const t = new Date("2026-11-27T12:00:00Z");
  const a = O.signiere(zugang, "PUT", "logos/ab.png", Buffer.from("x"), { "content-type": "image/png" }, t);
  const b = O.signiere(zugang, "PUT", "logos/ab.png", Buffer.from("x"), { "content-type": "image/png" }, t);
  const c = O.signiere(zugang, "PUT", "logos/ab.png", Buffer.from("y"), { "content-type": "image/png" }, t);
  assert.equal(a.kopf.authorization, b.kopf.authorization);
  assert.notEqual(a.kopf.authorization, c.kopf.authorization);
  assert.equal(a.url, `${zugang.endpunkt}/ava-test/logos/ab.png`);
  assert.match(a.kopf.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
  assert.equal(a.kopf.host, undefined);
});
await pruefe("ablegen, vorhanden, holen; 404 = nicht vorhanden", async () => {
  assert.equal(await O.objektVorhanden("logos/eins.png", zugang), false);
  await O.objektAblegen("logos/eins.png", png(180, 180), "image/png", zugang);
  assert.equal(await O.objektVorhanden("logos/eins.png", zugang), true);
  const o = await O.objektHolen("logos/eins.png", zugang);
  assert.equal(o.inhalt.length, 400);
  assert.equal(o.mime, "image/png");
  assert.equal(await O.objektHolen("logos/fehlt.png", zugang), null);
});
await pruefe("voruebergehender Fehler (503) wird wiederholt", async () => {
  stolpern = 2; const vorher = anfragen.length;
  await O.objektAblegen("logos/zwei.png", png(64, 64), "image/png", zugang);
  assert.equal(anfragen.length - vorher, 3);
  assert.ok(objekte.has("/ava-test/logos/zwei.png"));
});

console.log("Pruefung eines Logos (fremde Eingabe)");
await pruefe("PNG: Bildart aus den Bytes, Pruefsumme selbst gerechnet", () => {
  const buf = png(180, 180);
  const l = L.logoPruefen({ rolle: "zeichen", mime: "image/svg+xml", breite: 180, hoehe: 180, stufe: "apple", quelleUrl: "https://x.de/a.png", klein: false, sha256: "gelogen", inhaltBase64: b64(buf) });
  assert.equal(l.mime, "image/png");
  assert.equal(l.sha256, createHash("sha256").update(buf).digest("hex"));
  assert.equal(l.stufe, "apple");
});
await pruefe("abgelehnt: HTML, zu gross, aktives SVG, falsche Rolle, kein Base64", () => {
  const f = (o) => L.logoPruefen({ rolle: "zeichen", inhaltBase64: b64(png(10, 10)), ...o }).fehler;
  assert.equal(f({ inhaltBase64: b64(Buffer.from("<html><body>" + "404 nicht gefunden ".repeat(10) + "</body></html>")) }), "keine erlaubte Bildart");
  assert.equal(f({ inhaltBase64: b64(png(10, 10, 300_000)) }), "zu gross");
  assert.equal(f({ inhaltBase64: b64(Buffer.from(svgText.replace("<rect", '<script>x()</script><rect'))) }), "SVG mit aktivem Inhalt");
  assert.equal(f({ inhaltBase64: b64(Buffer.from(svgText.replace("<rect", '<rect onclick="x()"'))) }), "SVG mit aktivem Inhalt");
  assert.equal(f({ rolle: "banner" }), "unbekannte Rolle");
  assert.equal(f({ inhaltBase64: "###" }), "kein Base64");
  assert.equal(L.logoPruefen(null).fehler, "kein Objekt");
});
await pruefe("sauberes SVG geht durch; unbekannte Stufe und fremde Quelle werden entschaerft", () => {
  const l = L.logoPruefen({ rolle: "wortmarke", stufe: "erfunden", quelleUrl: "javascript:alert(1)", breite: -5, hoehe: 1e9, inhaltBase64: b64(Buffer.from(svgText)) });
  assert.equal(l.mime, "image/svg+xml");
  assert.equal(l.stufe, "kopf");
  assert.equal(l.quelleUrl, null);
  assert.deepEqual([l.breite, l.hoehe], [0, 0]);
});

// Nachgebaute Website-Datenbank: nur die Abfragen von firmen-logos.ts.
function db({ ohneTabelle = false } = {}) {
  const zeilen = new Map();
  let tabelle = !ohneTabelle;
  return {
    zeilen, sqls: [],
    async query(sql, w = []) {
      this.sqls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (/^\s*CREATE TABLE/i.test(sql)) { tabelle = true; return { rows: [] }; }
      if (/^\s*CREATE INDEX/i.test(sql)) return { rows: [] };
      if (!tabelle) { const e = new Error('relation "CompanyLogo" does not exist'); e.code = "42P01"; throw e; }
      if (/^\s*INSERT INTO "CompanyLogo"/i.test(sql)) { zeilen.set(`${w[0]}|${w[1]}`, { companyId: w[0], rolle: w[1], sha256: w[2], mime: w[3], breite: w[4], hoehe: w[5], bytes: w[6], stufe: w[7], quelleUrl: w[8], klein: w[9] }); return { rows: [] }; }
      if (/WHERE "companyId" = ANY/i.test(sql)) return { rows: [...zeilen.values()].filter((z) => w[0].includes(z.companyId)) };
      if (/WHERE sha256 = \$1/i.test(sql)) return { rows: [...zeilen.values()].filter((z) => z.sha256 === w[0]).slice(0, 1) };
      throw new Error("unerwartete Abfrage: " + sql.slice(0, 60));
    },
  };
}
const speicher = (aktiv = true) => ({ ablagen: [], aktiv: () => aktiv, vorhanden: (k) => O.objektVorhanden(k, zugang), async ablegen(k, i, m) { this.ablagen.push(k); await O.objektAblegen(k, i, m, zugang); }, holen: (k) => O.objektHolen(k, zugang) });

console.log("Uebernehmen und Ausliefern");
const zeichen = png(180, 180), wort = Buffer.from(svgText);
const eingang = [
  { rolle: "zeichen", stufe: "apple", breite: 180, hoehe: 180, klein: false, quelleUrl: "https://www.nexburg.com/apple-touch-icon.png", inhaltBase64: b64(zeichen) },
  { rolle: "wortmarke", stufe: "jsonld", breite: 221, hoehe: 27, klein: false, quelleUrl: "https://www.nexburg.com/logo.svg", inhaltBase64: b64(wort) },
  { rolle: "zeichen", stufe: "favicon", inhaltBase64: b64(png(16, 16)) },
  { rolle: "wortmarke", inhaltBase64: "###" },
];
const d = db(); const sp = speicher();
await pruefe("je Rolle ein Logo, kaputte Eintraege verworfen, Bytes im Speicher unter logos/<sha256>", async () => {
  L.logosZuruecksetzen();
  const r = await L.logosUebernehmen("AACHEN_HRB_18923", eingang, { pool: d, speicher: sp });
  assert.deepEqual(r.gespeichert, ["zeichen", "wortmarke"]);
  assert.deepEqual(r.verworfen, ["kein Base64"]);
  const sha = createHash("sha256").update(zeichen).digest("hex");
  assert.deepEqual(sp.ablagen.sort(), [`logos/${createHash("sha256").update(wort).digest("hex")}.svg`, `logos/${sha}.png`].sort());
  assert.equal(d.zeilen.get("AACHEN_HRB_18923|zeichen").sha256, sha);
  assert.equal(d.zeilen.get("AACHEN_HRB_18923|zeichen").bytes, 400);
});
await pruefe("gleicher Inhalt wird nicht noch einmal hochgeladen (zweite Firma, gleiches Logo)", async () => {
  const vorher = sp.ablagen.length;
  const r = await L.logosUebernehmen("AACHEN_HRB_28936", [eingang[0]], { pool: d, speicher: sp });
  assert.deepEqual(r.gespeichert, ["zeichen"]);
  assert.equal(sp.ablagen.length, vorher);
});
await pruefe("lesen: Angaben je Firma und Rolle", async () => {
  const m = await L.logosLesen(["AACHEN_HRB_18923", "UNBEKANNT_HRB_1"], d);
  assert.deepEqual(Object.keys(m.get("AACHEN_HRB_18923")).sort(), ["wortmarke", "zeichen"]);
  assert.deepEqual(m.get("AACHEN_HRB_18923").wortmarke, { sha256: createHash("sha256").update(wort).digest("hex"), mime: "image/svg+xml", breite: 221, hoehe: 27, klein: false, stufe: "jsonld" });
  assert.equal(m.has("UNBEKANNT_HRB_1"), false);
});
await pruefe("ausliefern nur, was als Logo eingetragen ist", async () => {
  const sha = createHash("sha256").update(zeichen).digest("hex");
  const o = await L.logoInhalt(sha, { pool: d, speicher: sp });
  assert.equal(o.mime, "image/png");
  assert.equal(o.inhalt.length, 400);
  // Liegt im Bucket (aus dem Speicher-Test oben), ist aber kein eingetragenes Logo:
  assert.equal(await L.logoInhalt(createHash("sha256").update(png(64, 64)).digest("hex"), { pool: d, speicher: sp }), null);
  assert.equal(await L.logoInhalt("../../etwas", { pool: d, speicher: sp }), null);
});
await pruefe("ohne Speicher ruht alles; ohne Tabelle leere Antwort statt Fehler", async () => {
  const r = await L.logosUebernehmen("X_HRB_1", eingang, { pool: db(), speicher: speicher(false) });
  assert.deepEqual(r, { gespeichert: [], verworfen: [], ruht: true });
  assert.equal((await L.logosLesen(["X_HRB_1"], db({ ohneTabelle: true }))).size, 0);
  assert.equal(await L.logoInhalt("a".repeat(64), { pool: db({ ohneTabelle: true }), speicher: sp }), null);
});
await pruefe("Listen-Abfrage: nur Firmen mit Logo, unbrauchbare Eingabe wird abgewiesen", async () => {
  const d = db();
  await L.logosUebernehmen("AACHEN_HRB_18923", eingang, { pool: d, speicher: sp });
  const liste = await L.logosFuerListe(["AACHEN_HRB_18923", "UNBEKANNT_HRB_1", "AACHEN_HRB_18923"], d);
  assert.deepEqual(Object.keys(liste), ["AACHEN_HRB_18923"]);
  assert.match(liste.AACHEN_HRB_18923.zeichen?.sha256 ?? liste.AACHEN_HRB_18923.wortmarke?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(await L.logosFuerListe([], d), {});
  assert.equal(await L.logosFuerListe("AACHEN_HRB_18923", d), null);
  assert.equal(await L.logosFuerListe([1, 2], d), null);
  assert.equal(await L.logosFuerListe([""], d), null);
  assert.equal(await L.logosFuerListe(Array.from({ length: L.LOGOS_LISTE_MAX + 1 }, (_, i) => `X_HRB_${i}`), d), null);
  assert.deepEqual(await L.logosFuerListe(["X_HRB_1"], db({ ohneTabelle: true })), {});
});

s3.close();
console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
