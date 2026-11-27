import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import C0 from "../src/main/logo-cache.ts";
import F0 from "../src/renderer/src/components/FirmenLogo.tsx";
const C = C0.default ?? C0;
const F = F0.default ?? F0;
let fehler = 0;
const pruefe = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };

const SHA = "a".repeat(64), SHA2 = "b".repeat(64);
const bild = Buffer.from("PNG-Inhalt-Platzhalter");
function netz(antworten) {
  const aufrufe = [];
  const fetchFn = async (url, init) => {
    aufrufe.push({ url: String(url), auth: init?.headers?.authorization });
    const a = antworten[String(url).split("/").pop()] ?? { status: 404 };
    return new Response(a.status === 200 ? a.inhalt : "nein", { status: a.status, headers: a.typ ? { "content-type": a.typ } : {} });
  };
  return { fetchFn, aufrufe };
}

console.log("Zwischenspeicher fuer ava-logo://");
const ordner = mkdtempSync(join(tmpdir(), "ava-logo-test-"));
let uhr = 1_000_000;
const quelle = (n, token = "tok") => ({ ordner, gatewayUrl: "https://gw.example/", getAccessToken: async () => token, fetchFn: n.fetchFn, jetzt: () => uhr });
await pruefe("erster Abruf vom Gateway mit Anmeldung, danach aus dem Ordner", async () => {
  C.logoCacheLeeren();
  const n = netz({ [SHA]: { status: 200, inhalt: bild, typ: "image/png" } });
  const a = await C.logoLaden(SHA, quelle(n));
  assert.equal(a.mime, "image/png");
  assert.deepEqual([n.aufrufe.length, n.aufrufe[0].url, n.aufrufe[0].auth], [1, `https://gw.example/v1/logos/${SHA}`, "Bearer tok"]);
  assert.deepEqual(readdirSync(ordner), [`${SHA}.png`]);
  const b = await C.logoLaden(SHA, quelle(n));
  assert.equal(b.inhalt.toString(), bild.toString());
  assert.equal(n.aufrufe.length, 1);
});
await pruefe("gleichzeitige Anfragen laden nur einmal", async () => {
  C.logoCacheLeeren();
  const n = netz({ [SHA2]: { status: 200, inhalt: bild, typ: "image/svg+xml; charset=utf-8" } });
  const [a, b] = await Promise.all([C.logoLaden(SHA2, quelle(n)), C.logoLaden(SHA2, quelle(n))]);
  assert.equal(n.aufrufe.length, 1);
  assert.equal(a.mime, "image/svg+xml");
  assert.equal(b.mime, "image/svg+xml");
});
await pruefe("Fehlschlag: fuenf Minuten Ruhe, danach neuer Versuch", async () => {
  C.logoCacheLeeren();
  const sha = "c".repeat(64);
  const n = netz({});
  assert.equal(await C.logoLaden(sha, quelle(n)), null);
  assert.equal(await C.logoLaden(sha, quelle(n)), null);
  assert.equal(n.aufrufe.length, 1);
  uhr += 5 * 60_000 + 1;
  await C.logoLaden(sha, quelle(n));
  assert.equal(n.aufrufe.length, 2);
});
await pruefe("ohne Anmeldung, falsche Pruefsumme oder fremde Bildart: nichts", async () => {
  C.logoCacheLeeren();
  const n = netz({ ["d".repeat(64)]: { status: 200, inhalt: "<html>", typ: "text/html" } });
  assert.equal(await C.logoLaden("d".repeat(64), quelle(n)), null);
  assert.equal(await C.logoLaden("e".repeat(64), quelle(n, null)), null);
  assert.equal(await C.logoLaden("../../etc/passwd", quelle(n)), null);
  assert.equal(n.aufrufe.length, 1);
});
await pruefe("Antwort des Protokolls: Bild mit Kopfzeilen, sonst 404", async () => {
  C.logoCacheLeeren();
  const n = netz({});
  const ok = await C.logoAntwort(`ava-logo://${SHA}`, quelle(n));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.match(ok.headers.get("cache-control"), /immutable/);
  assert.match(ok.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await C.logoAntwort(`ava-logo://${SHA}.png`, quelle(n))).status, 200);
  assert.equal((await C.logoAntwort("ava-logo://nichts", quelle(n))).status, 404);
  assert.equal((await C.logoAntwort("kein url", quelle(n))).status, 404);
});
rmSync(ordner, { recursive: true, force: true });

console.log("Auswahl fuer die quadratische Flaeche");
const z = { sha256: SHA, breite: 180, hoehe: 180, klein: false };
const w = { sha256: SHA2, breite: 221, hoehe: 27, klein: false };
const k = { sha256: "f".repeat(64), breite: 16, hoehe: 16, klein: true };
await pruefe("gutes Zeichen geht vor", () => assert.equal(F.logoFuerFlaeche({ zeichen: z, wortmarke: w }).art, "zeichen"));
await pruefe("kleines Favicon: lieber die Wortmarke einpassen", () => assert.deepEqual([F.logoFuerFlaeche({ zeichen: k, wortmarke: w }).art, F.logoFuerFlaeche({ zeichen: k, wortmarke: w }).logo.sha256], ["wortmarke", SHA2]));
await pruefe("nur kleines Favicon: das als letzter Ausweg", () => assert.equal(F.logoFuerFlaeche({ zeichen: k }).art, "klein"));
await pruefe("nichts oder kaputte Angabe: Kuerzel", () => { assert.equal(F.logoFuerFlaeche(null), null); assert.equal(F.logoFuerFlaeche({}), null); assert.equal(F.logoFuerFlaeche({ zeichen: { sha256: "kaputt", breite: 1, hoehe: 1, klein: false } }), null); });

await pruefe("Flaeche: quadratisch, nur die Wortmarke darf im Kopf breiter werden (hoechstens 3,2-fach)", () => {
  const wm = (b, h) => ({ logo: { sha256: SHA2, breite: b, hoehe: h, klein: false }, art: "wortmarke" });
  assert.deepEqual(F.flaechenMasse(wm(577, 118), 44, true), { width: 141, height: 44 });
  assert.deepEqual(F.flaechenMasse(wm(290, 130), 44, true), { width: 98, height: 44 });
  assert.deepEqual(F.flaechenMasse(wm(0, 0), 44, true), { width: 106, height: 44 });
  assert.deepEqual(F.flaechenMasse(wm(577, 118), 44, false), { width: 44, height: 44 });
  assert.deepEqual(F.flaechenMasse({ logo: z, art: "zeichen" }, 56, true), { width: 56, height: 56 });
  assert.deepEqual(F.flaechenMasse(null, 28, true), { width: 28, height: 28 });
});

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
