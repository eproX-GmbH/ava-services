// AVA Cloud Z1 (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md): Maschinen-Konfiguration und Instanz-Abläufe
// gegen eine Fly-Attrappe und eine Datenbank im Speicher.
import assert from "node:assert/strict";
import K0 from "../src/lib/cloud/konfig.ts";
import I0 from "../src/lib/cloud/instanzen.ts";
const K = K0.default ?? K0;
const I = I0.default ?? I0;
let fehler = 0;
const pruefe = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.stack?.split("\n").slice(0, 3).join("\n       ")}`); } };

console.log("Cloud: Maschinen-Konfiguration");
const cfg = K.maschinenKonfig({ instanzId: "i1", tenantId: "t1", actorId: "Actor-1", flyApp: "ava-u-abc", version: "v0.1.975", volumeId: "vol_1", groesse: "standard" });
await pruefe("Autostart aus, Neustart nur nach Absturz", () => {
  assert.equal(cfg.services[0].autostart, false);
  assert.equal(cfg.services[0].autostop, "off");
  assert.equal(cfg.restart.policy, "on-failure");
});
await pruefe("Image aus der Kunden-Registry, Ollama fest", () => {
  assert.equal(cfg.image, "registry.fly.io/ava-kunden-image:v0.1.975");
  assert.equal(cfg.containers.find((c) => c.name === "ollama").image, "ollama/ollama:0.40.5");
});
await pruefe("Secrets nur im AVA-Container", () => {
  assert.deepEqual(cfg.containers.find((c) => c.name === "ava").secrets.map((s) => s.env_var), ["AVA_SECRETS_KEY", "AVA_SETUP_TOKEN", "AVA_KONTO"]);
  assert.equal(cfg.containers.find((c) => c.name === "ollama").secrets, undefined);
});
await pruefe("Ollama über localhost, Volume /data, 4 GB", () => {
  assert.equal(cfg.env.AVA_OLLAMA_HOST, "127.0.0.1");
  assert.deepEqual(cfg.mounts, [{ volume: "vol_1", path: "/data" }]);
  assert.equal(cfg.guest.memory_mb, 4096);
});
await pruefe("Kontobindung lesbar in Metadaten (klein geschrieben)", () => assert.equal(cfg.metadata.ava_konto, "actor-1"));

// ---- Attrappen ------------------------------------------------------------------------
function speicherRepo() {
  const zeilen = new Map(); const ereignisse = [];
  return {
    ereignisseAlle: ereignisse,
    async holen(id) { return zeilen.has(id) ? structuredClone(zeilen.get(id)) : null; },
    async fuerMitglied(t, a) { return [...zeilen.values()].find((z) => z.tenantId === t && z.actorId === a && !z.geloeschtAt) ?? null; },
    async einfuegen(z) { zeilen.set(z.id, structuredClone(z)); },
    async aendern(id, teil) { zeilen.set(id, { ...zeilen.get(id), ...structuredClone(teil) }); },
    async ereignis(id, art, quelle, details) { ereignisse.push({ id, art, quelle, details }); },
    async ereignisse() { return []; },
    async liste() { return [...zeilen.values()]; },
  };
}
function flyAttrappe({ scheitertBei } = {}) {
  const aufrufe = []; const maschinen = new Map(); let n = 0; const apps = new Set();
  const merk = (name, ...a) => { aufrufe.push([name, ...a]); if (scheitertBei?.has(name)) { scheitertBei.delete(name); throw new Error(`Fly ${name} gescheitert`); } };
  return {
    aufrufe, maschinen,
    async appVorhanden(app) { merk("appVorhanden", app); return apps.has(app); },
    async appAnlegen(app, netz) { merk("appAnlegen", app, netz); apps.add(app); },
    async secretsSetzen(app, w) { merk("secretsSetzen", app, Object.keys(w).sort()); },
    async volumeAnlegen(app, gb) { merk("volumeAnlegen", app, gb); return "vol_x"; },
    async ipsZuweisen(app) { merk("ipsZuweisen", app); },
    async maschineAnlegen(app, config) { merk("maschineAnlegen", app, config.mounts[0].volume); const id = `m${++n}`; maschinen.set(id, { id, state: "started", config }); return maschinen.get(id); },
    async maschineHolen(app, id) { merk("maschineHolen", app, id); return maschinen.get(id) ?? null; },
    async cordon(app, id) { merk("cordon", id); },
    async uncordon(app, id) { merk("uncordon", id); },
    async stoppen(app, id) { merk("stoppen", id); maschinen.get(id).state = "stopped"; },
    async starten(app, id) { merk("starten", id); maschinen.get(id).state = "started"; },
    async warte(app, id, zustand) { merk("warte", id, zustand); return maschinen.get(id)?.state === zustand; },
    async maschineLoeschen(app, id) { merk("maschineLoeschen", id); maschinen.delete(id); },
    async volumeLoeschen(app, v) { merk("volumeLoeschen", v); },
    async appLoeschen(app) { merk("appLoeschen", app); apps.delete(app); },
    async neuesteVersion() { merk("neuesteVersion"); return "0.1.975"; },
  };
}
const namen = (fly) => fly.aufrufe.map((a) => a[0]);

console.log("Cloud: Instanz-Abläufe");
await pruefe("App-Name ohne Personenbezug", () => {
  assert.match(I.appName(() => "a1b2c3d4e5"), /^ava-u-[0-9a-f]{10}$/);
});
await pruefe("anlegen ist idempotent je Mitglied", async () => {
  const repo = speicherRepo(); const b = new I.CloudBetrieb(repo, flyAttrappe(), { zufall: () => "aaaaaaaaaa" });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  const c = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  assert.equal(a.id, c.id); assert.equal(a.zustand, "wird_angelegt"); assert.equal(a.soll, "laufen");
});
await pruefe("fortsetzen: alle Schritte in Reihenfolge, Secrets mit Kontobindung", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe(); const b = new I.CloudBetrieb(repo, fly, { zufall: () => "bbbbbbbbbb" });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  const z = await b.fortsetzen(a.id, "betreiber");
  assert.deepEqual(namen(fly), ["appVorhanden", "appAnlegen", "secretsSetzen", "volumeAnlegen", "ipsZuweisen", "neuesteVersion", "maschineAnlegen", "warte"]);
  assert.deepEqual(fly.aufrufe[2][2], ["AVA_KONTO", "AVA_SECRETS_KEY", "AVA_SETUP_TOKEN"]);
  assert.equal(fly.aufrufe[1][2], "ava-u-bbbbbbbbbb-netz");
  assert.equal(z.zustand, "wartet_auf_verbindung"); assert.equal(z.imageVersion, "0.1.975");
  assert.ok(repo.ereignisseAlle.some((e) => e.art === "angelegt"));
});
await pruefe("fortsetzen nach Abbruch: erledigte Schritte werden nicht wiederholt", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe({ scheitertBei: new Set(["volumeAnlegen"]) }); const b = new I.CloudBetrieb(repo, fly, { zufall: () => "cccccccccc" });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  await assert.rejects(() => b.fortsetzen(a.id, "betreiber"), /volumeAnlegen/);
  const zwischen = await repo.holen(a.id);
  assert.match(zwischen.letzterFehler, /volumeAnlegen/); assert.equal(zwischen.zustand, "wird_angelegt");
  fly.aufrufe.length = 0;
  await b.fortsetzen(a.id, "betreiber");
  assert.ok(!namen(fly).includes("appAnlegen") && !namen(fly).includes("secretsSetzen"), namen(fly).join(","));
  assert.equal((await repo.holen(a.id)).letzterFehler, null);
});
await pruefe("stoppen → ruhen → starten legt Maschine mit altem Volume neu an", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe(); const b = new I.CloudBetrieb(repo, fly, { zufall: () => "dddddddddd" });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  await b.fortsetzen(a.id, "betreiber");
  fly.aufrufe.length = 0;
  const g = await b.stoppen(a.id, "zahlung", "abgleicher");
  assert.deepEqual(namen(fly), ["maschineHolen", "cordon", "stoppen", "warte"]);
  assert.equal(g.zustand, "gestoppt"); assert.equal(g.soll, "gestoppt"); assert.equal(g.grund, "zahlung");
  const r = await b.ruhen(a.id, "abgleicher");
  assert.equal(r.zustand, "ruht"); assert.equal(fly.maschinen.size, 0);
  fly.aufrufe.length = 0;
  const s = await b.starten(a.id, "abgleicher");
  assert.ok(namen(fly).includes("maschineAnlegen")); assert.equal(fly.aufrufe.find((x) => x[0] === "maschineAnlegen")[2], "vol_x");
  assert.equal(s.zustand, "wartet_auf_verbindung"); assert.equal(s.soll, "laufen"); assert.equal(s.grund, null);
});
await pruefe("ruhen nur aus gestoppt", async () => {
  const repo = speicherRepo(); const b = new I.CloudBetrieb(repo, flyAttrappe(), { zufall: () => "eeeeeeeeee" });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  await b.fortsetzen(a.id, "betreiber");
  await assert.rejects(() => b.ruhen(a.id, "betreiber"), /gestoppte/);
});
await pruefe("loeschen räumt Maschine, Volume und App; Mitglied kann neu anlegen", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe(); let k = 0; const b = new I.CloudBetrieb(repo, fly, { zufall: () => `f${++k}`.padEnd(10, "0") });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  await b.fortsetzen(a.id, "betreiber");
  const l = await b.loeschen(a.id, "betreiber");
  assert.equal(l.zustand, "geloescht"); assert.ok(l.geloeschtAt);
  assert.ok(["maschineLoeschen", "volumeLoeschen", "appLoeschen"].every((n) => namen(fly).includes(n)));
  const neu = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  assert.notEqual(neu.id, a.id);
});
await pruefe("nie zwei Vorgänge gleichzeitig je Instanz", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe(); const b = new I.CloudBetrieb(repo, fly, { zufall: () => "gggggggggg" });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  const erst = b.fortsetzen(a.id, "betreiber");
  await assert.rejects(() => b.stoppen(a.id, "admin", "admin"), /bereits ein Vorgang/);
  await erst;
});

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
