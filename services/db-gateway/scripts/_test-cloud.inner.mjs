// AVA Cloud Z1 (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md): Maschinen-Konfiguration und Instanz-Abläufe
// gegen eine Fly-Attrappe und eine Datenbank im Speicher.
import assert from "node:assert/strict";
import K0 from "../src/lib/cloud/konfig.ts";
import I0 from "../src/lib/cloud/instanzen.ts";
import A0 from "../src/lib/cloud/abgleich.ts";
import AB0 from "../src/lib/cloud/posten.ts";
import V0 from "../src/lib/mail/vorlagen.ts";
import AN0 from "../src/lib/cloud/anmeldung.ts";
import RO0 from "../src/lib/cloud/rollout.ts";
const K = K0.default ?? K0;
const I = I0.default ?? I0;
const A = A0.default ?? A0;
const AB = AB0.default ?? AB0;
const V = V0.default ?? V0;
const AN = AN0.default ?? AN0;
const RO = RO0.default ?? RO0;
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
    async zustandWechseln(id, von, nach) {
      const z = zeilen.get(id); if (!z || z.geloeschtAt || z.zustand !== von) return false;
      zeilen.set(id, { ...z, zustand: nach }); return true;
    },
    async verbindungMelden(id) {
      const z = zeilen.get(id);
      if (!z || z.geloeschtAt || (z.verbundenAt && z.zustand !== "wartet_auf_verbindung")) return "nichts";
      const neu = !z.verbundenAt; const s = { ...z.schritte }; delete s.wartetSeit; delete s.m3_30m; delete s.m3_24h;
      zeilen.set(id, { ...z, verbundenAt: z.verbundenAt ?? new Date().toISOString(), zustand: z.zustand === "wartet_auf_verbindung" ? "laeuft" : z.zustand, schritte: s });
      return neu ? "neu" : "wieder";
    },
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
    async maschineAktualisieren(app, id, config) { merk("maschineAktualisieren", id, config.image); const m = maschinen.get(id); m.config = config; m.state = "started"; },
    async cordon(app, id) { merk("cordon", id); },
    async uncordon(app, id) { merk("uncordon", id); },
    async stoppen(app, id) { merk("stoppen", id); maschinen.get(id).state = "stopped"; },
    async starten(app, id) { merk("starten", id); maschinen.get(id).state = "started"; },
    async warte(app, id, zustand) { merk("warte", id, zustand); return maschinen.get(id)?.state === zustand; },
    async maschineLoeschen(app, id) { merk("maschineLoeschen", id); maschinen.delete(id); },
    async volumeLoeschen(app, v) { merk("volumeLoeschen", v); },
    async appLoeschen(app) { merk("appLoeschen", app); apps.delete(app); },
    versionWert: "0.1.975",
    async neuesteVersion() { merk("neuesteVersion"); return this.versionWert; },
    async appsListe() { return [...apps, "ava-kunden-image"]; },
    gesundWert: true,
    async gesund() { return this.gesundWert; },
    anmeldungWert: null,
    async anmeldung(app, tok) { merk("anmeldung", tok); return this.anmeldungWert; },
    apps,
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

console.log("Cloud: Soll-Regeln (Z2)");
const basis = { gewuenscht: "laufen", grund: null };
await pruefe("Wunsch laufen, alles in Ordnung → laufen", () => assert.deepEqual(A.sollBestimmen(basis, { kontoSperre: null, abrechnung: "active" }), { soll: "laufen", grund: null }));
await pruefe("ohne Abrechnungszeile → laufen (Betreiber-Instanz)", () => assert.equal(A.sollBestimmen(basis, { kontoSperre: null, abrechnung: null }).soll, "laufen"));
await pruefe("past_due → läuft noch (Frist kommt mit Z3)", () => assert.equal(A.sollBestimmen(basis, { kontoSperre: null, abrechnung: "past_due" }).soll, "laufen"));
await pruefe("suspended → gestoppt/zahlung", () => assert.deepEqual(A.sollBestimmen(basis, { kontoSperre: null, abrechnung: "suspended" }), { soll: "gestoppt", grund: "zahlung" }));
await pruefe("canceled → gestoppt/kuendigung", () => assert.deepEqual(A.sollBestimmen(basis, { kontoSperre: null, abrechnung: "canceled" }), { soll: "gestoppt", grund: "kuendigung" }));
await pruefe("Konto gesperrt schlägt alles", () => assert.deepEqual(A.sollBestimmen(basis, { kontoSperre: "gesperrt", abrechnung: "active" }), { soll: "gestoppt", grund: "konto" }));
await pruefe("Wunsch gestoppt behält Grund admin", () => assert.deepEqual(A.sollBestimmen({ gewuenscht: "gestoppt", grund: "admin" }, { kontoSperre: null, abrechnung: "active" }), { soll: "gestoppt", grund: "admin" }));

console.log("Cloud: nächste Aktion (Z2)");
const R = { ruheTage: 7, loeschTage: 30, autoLoeschen: false, maxVersuche: 5, fristTage: 7 };
const T = Date.parse("2026-12-01T12:00:00Z");
const inst = (teil) => ({ id: "x", flyApp: "ava-u-x", zustand: "laeuft", soll: "laufen", gewuenscht: "laufen", grund: null, schritte: {}, gestopptAt: null, maschineId: "m1", ...teil });
const tage = (n) => new Date(T - n * 86_400_000).toISOString();
await pruefe("läuft wie gewünscht → Gesundheit prüfen", () => assert.equal(A.naechsteAktion(inst({}), "laufen", "started", T, R).art, "gesundheit"));
await pruefe("soll gestoppt, läuft → stoppen", () => assert.deepEqual(A.naechsteAktion(inst({}), "gestoppt", "started", T, R), { art: "stoppen", wiederGestartet: false }));
await pruefe("gestoppt, aber Fly hat gestartet → stoppen + Meldung", () => assert.deepEqual(A.naechsteAktion(inst({ zustand: "gestoppt" }), "gestoppt", "started", T, R), { art: "stoppen", wiederGestartet: true }));
await pruefe("gestoppt seit 6 Tagen → nichts", () => assert.equal(A.naechsteAktion(inst({ zustand: "gestoppt", gestopptAt: tage(6) }), "gestoppt", "stopped", T, R).art, "nichts"));
await pruefe("gestoppt seit 7 Tagen → ruhen", () => assert.equal(A.naechsteAktion(inst({ zustand: "gestoppt", gestopptAt: tage(7) }), "gestoppt", "stopped", T, R).art, "ruhen"));
await pruefe("ruht seit 30 Tagen → nur Meldung ohne CLOUD_AUTO_LOESCHEN", () => assert.equal(A.naechsteAktion(inst({ zustand: "ruht", maschineId: null, gestopptAt: tage(30) }), "gestoppt", null, T, R).art, "loeschen_faellig"));
await pruefe("ruht seit 30 Tagen + Auto-Löschen → löschen", () => assert.equal(A.naechsteAktion(inst({ zustand: "ruht", maschineId: null, gestopptAt: tage(30) }), "gestoppt", null, T, { ...R, autoLoeschen: true }).art, "loeschen"));
await pruefe("soll laufen, ruht → starten", () => assert.deepEqual(A.naechsteAktion(inst({ zustand: "ruht", maschineId: null }), "laufen", null, T, R), { art: "starten", warum: "soll_laufen" }));
await pruefe("läuft laut Datensatz, Fly gestoppt → neu starten (Absturz)", () => assert.deepEqual(A.naechsteAktion(inst({}), "laufen", "stopped", T, R), { art: "starten", warum: "unerwartet_gestoppt" }));
await pruefe("Anlegen: fortsetzen, nach 5 Fehlversuchen nicht mehr", () => {
  assert.equal(A.naechsteAktion(inst({ zustand: "wird_angelegt", schritte: { versuche: 4 } }), "laufen", null, T, R).art, "fortsetzen");
  assert.equal(A.naechsteAktion(inst({ zustand: "wird_angelegt", schritte: { versuche: 5 } }), "laufen", null, T, R).art, "nichts");
});
await pruefe("Anlegen wird bei Soll gestoppt nicht fortgesetzt", () => assert.equal(A.naechsteAktion(inst({ zustand: "wird_angelegt" }), "gestoppt", null, T, R).art, "nichts"));

console.log("Cloud: Abgleich-Läufe (Z2)");
async function aufbau(zufall, opt = {}) {
  const repo = speicherRepo(); const fly = flyAttrappe(); const betrieb = new I.CloudBetrieb(repo, fly, { zufall: () => zufall, ...opt });
  const a = await betrieb.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  await betrieb.fortsetzen(a.id, "betreiber");
  const lage = { kontoSperre: null, abrechnung: "active" }; const meldungen = []; let uhr = T;
  const deps = { repo, fly, betrieb, fakten: async () => lage, melden: async (t) => { meldungen.push(t); }, regeln: R, jetzt: () => uhr, pause: async () => {} };
  return { repo, fly, betrieb, id: a.id, lage, meldungen, deps, setzeUhr: (u) => { uhr = u; } };
}
await pruefe("Zahlung ausgesetzt → gestoppt, Wunsch bleibt; bezahlt → läuft wieder", async () => {
  const w = await aufbau("h000000001");
  w.lage.abrechnung = "suspended";
  await A.abgleichen(w.deps);
  let z = await w.repo.holen(w.id);
  assert.equal(z.zustand, "gestoppt"); assert.equal(z.soll, "gestoppt"); assert.equal(z.grund, "zahlung"); assert.equal(z.gewuenscht, "laufen");
  w.lage.abrechnung = "active";
  await A.abgleichen(w.deps);
  z = await w.repo.holen(w.id);
  assert.equal(z.soll, "laufen"); assert.ok(["wartet_auf_verbindung", "laeuft"].includes(z.zustand), z.zustand);
});
await pruefe("Fly startet gestoppte Maschine → wieder gestoppt, eine Meldung je 6 h", async () => {
  const w = await aufbau("h000000002");
  await w.betrieb.stoppen(w.id, "admin", "admin", { absicht: true });
  const mid = (await w.repo.holen(w.id)).maschineId;
  w.fly.maschinen.get(mid).state = "started"; // Fly hat sie von selbst gestartet
  await A.abgleichen(w.deps);
  assert.equal(w.fly.maschinen.get(mid).state, "stopped");
  assert.equal(w.meldungen.filter((m) => m.includes("lief, obwohl")).length, 1);
  w.fly.maschinen.get(mid).state = "started";
  w.setzeUhr(T + 60 * 60_000);
  await A.abgleichen(w.deps);
  assert.equal(w.fly.maschinen.get(mid).state, "stopped");
  assert.equal(w.meldungen.filter((m) => m.includes("lief, obwohl")).length, 1, "keine zweite Meldung binnen 6 h");
  assert.ok(w.repo.ereignisseAlle.filter((e) => e.art === "wieder_gestoppt").length === 2);
});
await pruefe("nach 7 Tagen gestoppt → ruht (Maschine weg)", async () => {
  const w = await aufbau("h000000003");
  await w.betrieb.stoppen(w.id, "admin", "admin", { absicht: true });
  await w.repo.aendern(w.id, { gestopptAt: new Date(T - 8 * 86_400_000).toISOString() });
  await A.abgleichen(w.deps);
  const z = await w.repo.holen(w.id);
  assert.equal(z.zustand, "ruht"); assert.equal(z.maschineId, null); assert.equal(w.fly.maschinen.size, 0);
});
await pruefe("ruht 30 Tage: ohne Auto-Löschen nur Meldung, mit Auto-Löschen gelöscht", async () => {
  const w = await aufbau("h000000004");
  await w.betrieb.stoppen(w.id, "admin", "admin", { absicht: true });
  await w.betrieb.ruhen(w.id, "admin");
  await w.repo.aendern(w.id, { gestopptAt: new Date(T - 31 * 86_400_000).toISOString() });
  await A.abgleichen(w.deps);
  assert.equal((await w.repo.holen(w.id)).zustand, "ruht");
  assert.ok(w.meldungen.some((m) => m.includes("Löschung fällig")));
  await A.abgleichen({ ...w.deps, regeln: { ...R, autoLoeschen: true } });
  let z = await w.repo.holen(w.id);
  assert.equal(z.zustand, "ruht", "erst Vorwarnung (M11), nicht sofort löschen");
  assert.ok(z.schritte.m11);
  await w.repo.aendern(w.id, { schritte: { ...z.schritte, m11: new Date(T - 8 * 86_400_000).toISOString() } });
  await A.abgleichen({ ...w.deps, regeln: { ...R, autoLoeschen: true } });
  assert.equal((await w.repo.holen(w.id)).zustand, "geloescht");
});
await pruefe("Absturz: läuft laut Datensatz, Fly gestoppt → neu gestartet + Meldung", async () => {
  const w = await aufbau("h000000005");
  await w.repo.aendern(w.id, { zustand: "laeuft", verbundenAt: new Date(T).toISOString() });
  const mid = (await w.repo.holen(w.id)).maschineId;
  w.fly.maschinen.get(mid).state = "stopped";
  await A.abgleichen(w.deps);
  assert.equal(w.fly.maschinen.get(mid).state, "started");
  assert.ok(w.meldungen.some((m) => m.includes("unerwartet aus")));
  assert.equal((await w.repo.holen(w.id)).zustand, "laeuft");
});
await pruefe("ungesund > 15 Min → Meldung; gesund → gesundAt", async () => {
  const w = await aufbau("h000000006");
  await A.abgleichen(w.deps);
  assert.ok((await w.repo.holen(w.id)).gesundAt);
  w.fly.gesundWert = false;
  await A.abgleichen(w.deps);
  assert.equal(w.meldungen.length, 0);
  w.setzeUhr(T + 16 * 60_000);
  await A.abgleichen(w.deps);
  assert.ok(w.meldungen.some((m) => m.includes("/healthz")));
});
await pruefe("Konto gesperrt → gestoppt/konto", async () => {
  const w = await aufbau("h000000007");
  w.lage.kontoSperre = "gesperrt";
  await A.abgleichen(w.deps);
  const z = await w.repo.holen(w.id);
  assert.equal(z.zustand, "gestoppt"); assert.equal(z.grund, "konto");
});
await pruefe("Fly-App ohne Datensatz wird gemeldet, Image-App nicht", async () => {
  const w = await aufbau("h000000008");
  w.fly.apps.add("ava-u-verwaist01");
  const b = await A.abgleichen(w.deps);
  assert.deepEqual(b.waisen, ["ava-u-verwaist01"]);
});
await pruefe("Abgleich-Fehler: einzelner Fehler ohne Alarm, erst nach 10 Minuten am Stück; Erfolg setzt zurück", async () => {
  const w = await aufbau("h00000000f");
  let kaputt = true;
  w.deps.fakten = async () => { if (kaputt) throw new Error("Fly 404 machine not found"); return w.lage; };
  await A.abgleichen(w.deps);
  assert.equal(w.meldungen.length, 0, "erster Fehler: keine Mail");
  assert.ok((await w.repo.holen(w.id)).schritte.abgleichFehlerSeit);
  w.setzeUhr(T + 5 * 60_000); await A.abgleichen(w.deps);
  assert.equal(w.meldungen.length, 0, "nach 5 Minuten noch keine Mail");
  w.setzeUhr(T + 10 * 60_000); await A.abgleichen(w.deps);
  assert.equal(w.meldungen.filter((m) => /seit 10 Minuten/.test(m)).length, 1, "nach 10 Minuten am Stück: Mail");
  kaputt = false; w.setzeUhr(T + 15 * 60_000); await A.abgleichen(w.deps);
  assert.equal((await w.repo.holen(w.id)).schritte.abgleichFehlerSeit, undefined, "Erfolg vergisst die Serie");
  kaputt = true; w.setzeUhr(T + 20 * 60_000); await A.abgleichen(w.deps);
  assert.equal(w.meldungen.filter((m) => /fehl/.test(m)).length, 1, "neue Serie beginnt ohne Mail");
});
await pruefe("Instanz mit laufendem Vorgang wird übersprungen", async () => {
  const w = await aufbau("h000000009");
  const p = w.betrieb.stoppen(w.id, "admin", "admin", { absicht: true });
  const b = await A.abgleichen(w.deps);
  await p;
  assert.equal(b.geprueft, 0);
});

console.log("Cloud: Abrechnung und Fristen (Z3)");
const tag = 86_400_000;
await pruefe("offene Zahlung: 6 Tage läuft, ab 7 Tagen gestoppt/zahlung", () => {
  assert.equal(A.sollBestimmen(basis, { kontoSperre: null, abrechnung: "past_due", offenSeit: new Date(T - 6 * tag).toISOString() }, T, 7).soll, "laufen");
  assert.deepEqual(A.sollBestimmen(basis, { kontoSperre: null, abrechnung: "past_due", offenSeit: new Date(T - 7 * tag).toISOString() }, T, 7), { soll: "gestoppt", grund: "zahlung" });
});
await pruefe("abbestellt: bis Zyklusende laufen, danach gestoppt/abbestellt", () => {
  assert.equal(A.sollBestimmen({ ...basis, abbestelltZum: new Date(T + tag).toISOString() }, { kontoSperre: null, abrechnung: "active" }, T).soll, "laufen");
  assert.deepEqual(A.sollBestimmen({ ...basis, abbestelltZum: new Date(T - 1).toISOString() }, { kontoSperre: null, abrechnung: "active" }, T), { soll: "gestoppt", grund: "abbestellt" });
});
await pruefe("Erinnerungsstufen 0/3/6", () => {
  assert.equal(A.zahlungsStufe(null, T), null);
  assert.equal(A.zahlungsStufe(new Date(T - 2 * tag).toISOString(), T), 0);
  assert.equal(A.zahlungsStufe(new Date(T - 3 * tag).toISOString(), T), 3);
  assert.equal(A.zahlungsStufe(new Date(T - 6.5 * tag).toISOString(), T), 6);
});
await pruefe("zahlung_offen: Abgleicher tut nichts", () => assert.equal(A.naechsteAktion(inst({ zustand: "zahlung_offen", maschineId: null }), "laufen", null, T, R).art, "nichts"));
await pruefe("Stripe-Posten: anlegen, hoch, runter, entfernen, nichts", () => {
  assert.deepEqual(AB.postenAktion([{ id: "si_pro", priceId: "p_pro", quantity: 2 }], "p_cloud", 1), { art: "anlegen", menge: 1 });
  assert.deepEqual(AB.postenAktion([{ id: "si_c", priceId: "p_cloud", quantity: 1 }], "p_cloud", 2), { art: "menge", itemId: "si_c", menge: 2, hoch: true });
  assert.deepEqual(AB.postenAktion([{ id: "si_c", priceId: "p_cloud", quantity: 2 }], "p_cloud", 1), { art: "menge", itemId: "si_c", menge: 1, hoch: false });
  assert.deepEqual(AB.postenAktion([{ id: "si_c", priceId: "p_cloud", quantity: 1 }], "p_cloud", 0), { art: "entfernen", itemId: "si_c" });
  assert.deepEqual(AB.postenAktion([], "p_cloud", 0), { art: "nichts" });
});
await pruefe("freigeben: zahlung_offen → wird_angelegt, sonst nichts", async () => {
  const repo = speicherRepo(); const b = new I.CloudBetrieb(repo, flyAttrappe(), { zufall: () => "kkkkkkkkkk" });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "admin", zahlungOffen: true });
  assert.equal(a.zustand, "zahlung_offen");
  assert.equal((await b.freigeben(a.id, "webhook")).zustand, "wird_angelegt");
  assert.equal(await b.freigeben(a.id, "webhook"), null);
});
await pruefe("freigeben: zwei Webhooks gleichzeitig → genau einer gibt frei (eine Mail M1)", async () => {
  const repo = speicherRepo(); const b = new I.CloudBetrieb(repo, flyAttrappe(), { zufall: () => "kkkkkkkkk2" });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "webhook", zahlungOffen: true });
  const r = await Promise.all([b.freigeben(a.id, "webhook"), b.freigeben(a.id, "webhook")]);
  assert.equal(r.filter(Boolean).length, 1);
  assert.equal(repo.ereignisseAlle.filter((e) => e.art === "bezahlt").length, 1);
});
async function mitMails(zufall) {
  const w = await aufbau(zufall); const mails = [];
  w.deps.benachrichtigen = async (art, i, extra) => { mails.push({ art, ...extra }); };
  return { ...w, mails };
}
await pruefe("Zahlungsverlauf: Tag 0/3/6 Erinnerung, Tag 7 Pause + Mail, bezahlt → läuft wieder + Mail", async () => {
  const w = await mitMails("m000000001");
  const seit = new Date(T).toISOString();
  w.lage.abrechnung = "past_due"; w.lage.offenSeit = seit;
  await A.abgleichen(w.deps); await A.abgleichen(w.deps);
  assert.deepEqual(w.mails.map((m) => `${m.art}:${m.stufe}`), ["zahlung_offen:0"], "Tag 0 genau einmal");
  w.setzeUhr(T + 3 * tag); await A.abgleichen(w.deps);
  w.setzeUhr(T + 6 * tag); await A.abgleichen(w.deps);
  assert.deepEqual(w.mails.map((m) => `${m.art}:${m.stufe}`), ["zahlung_offen:0", "zahlung_offen:3", "zahlung_offen:6"]);
  w.setzeUhr(T + 7 * tag); await A.abgleichen(w.deps);
  let z = await w.repo.holen(w.id);
  assert.equal(z.zustand, "gestoppt"); assert.equal(z.grund, "zahlung");
  assert.equal(w.mails.at(-1).art, "pausiert"); assert.equal(w.mails.at(-1).grund, "zahlung");
  w.setzeUhr(T + 8 * tag); await A.abgleichen(w.deps);
  assert.equal(w.mails.filter((m) => m.art === "pausiert").length, 1, "Pause nur einmal gemeldet");
  w.lage.abrechnung = "active"; w.lage.offenSeit = null;
  await A.abgleichen(w.deps);
  z = await w.repo.holen(w.id);
  assert.equal(z.soll, "laufen"); assert.equal(w.mails.at(-1).art, "laeuft_wieder");
});
await pruefe("Betreiber-Stopp und gesperrtes Konto: keine Nutzer-Mail", async () => {
  const w = await mitMails("m000000002");
  await w.betrieb.stoppen(w.id, "betreiber", "betreiber", { absicht: true });
  await A.abgleichen(w.deps);
  const w2 = await mitMails("m000000003");
  w2.lage.kontoSperre = "gesperrt";
  await A.abgleichen(w2.deps);
  assert.equal(w.mails.length + w2.mails.length, 0);
});
await pruefe("abbestellt: nach Zyklusende pausiert + Mail mit Grund abbestellt", async () => {
  const w = await mitMails("m000000004");
  await w.repo.aendern(w.id, { abbestelltZum: new Date(T - 1000).toISOString() });
  await A.abgleichen(w.deps);
  const z = await w.repo.holen(w.id);
  assert.equal(z.zustand, "gestoppt"); assert.equal(w.mails[0].art, "pausiert"); assert.equal(w.mails[0].grund, "abbestellt");
});

console.log("Cloud: Mails (Z3)");
const verboten = /Instanz|Maschine|Fly|Volume|Container|PLAN_|Z3|Webhook/;
const basisMail = { vorname: "Eva", appUrl: "https://app.ava.bi" };
const mails = [
  V.serverBezahltMail(basisMail),
  V.serverZahlungOffenMail({ ...basisMail, stufe: 0, pauseAm: "2026-12-08T10:00:00Z", zahlungUrl: "https://admin.ava.bi/abrechnung" }),
  V.serverZahlungOffenMail({ ...basisMail, stufe: 6, pauseAm: "2026-12-08T10:00:00Z", zahlungUrl: "https://admin.ava.bi/abrechnung" }),
  V.serverPausiertMail({ ...basisMail, grund: "zahlung", loeschenAb: "2027-01-07T10:00:00Z", zahlungUrl: "https://admin.ava.bi/abrechnung" }),
  V.serverPausiertMail({ ...basisMail, grund: "abbestellt", loeschenAb: "2027-01-07T10:00:00Z", zahlungUrl: "x" }),
  V.serverLaeuftWiederMail(basisMail),
];
await pruefe("keine Fachbegriffe, mit Umlauten, Anrede und genau einem Knopf", () => {
  for (const m of mails) {
    assert.ok(!verboten.test(m.betreff + m.text), `${m.betreff}: ${(m.betreff + m.text).match(verboten)}`);
    assert.match(m.html, /Hallo Eva,/);
    assert.equal((m.html.match(/border-radius:8px;">\s*<a /g) ?? []).length, 1, m.betreff);
  }
  assert.ok(mails.some((m) => /ä|ö|ü/.test(m.text)));
});
await pruefe("Datum deutsch, Stufe 6 kündigt die Pause für morgen an", () => {
  assert.match(mails[2].betreff, /Morgen pausiere ich/);
  assert.match(mails[1].text, /8\. Dezember 2026/);
  assert.match(mails[3].text, /7\. Januar 2027/);
});

console.log("Cloud: Ein-Klick-Bestätigung (Z4)");
const REALM = "https://auth.ava.bi/realms/ava";
const LINK = `${REALM}/device?user_code=ABCD-EFGH`;
await pruefe("Konfig: AVA_GATEWAY_TOKEN nur, wenn gesetzt", () => {
  const mit = K.maschinenKonfig({ instanzId: "i1", tenantId: "t1", actorId: "a1", flyApp: "ava-u-abc", version: "0.1.980", volumeId: "vol_1", groesse: "standard", gatewayToken: true });
  assert.deepEqual(mit.containers.find((c) => c.name === "ava").secrets.map((s) => s.env_var), ["AVA_SECRETS_KEY", "AVA_SETUP_TOKEN", "AVA_KONTO", "AVA_GATEWAY_TOKEN"]);
});
await pruefe("Tokens: ohne Geheimnis aus, mit Geheimnis fest; Mail-Link prüft Signatur und Ablauf", () => {
  const alt = process.env.INTERNAL_HMAC_SECRET;
  try {
    delete process.env.INTERNAL_HMAC_SECRET;
    assert.equal(AN.instanzToken("x"), null);
    assert.equal(AN.bestaetigenToken("x", T), null);
    process.env.INTERNAL_HMAC_SECRET = "test-geheim";
    const id = "0b0f7c1e-1234-4a5b-9c8d-0123456789ab";
    assert.equal(AN.instanzToken(id), AN.instanzToken(id));
    assert.notEqual(AN.instanzToken(id), AN.instanzToken(id.replace("0b", "0c")));
    const t = AN.bestaetigenToken(id, T + 60_000);
    assert.equal(AN.bestaetigenTokenPruefen(t, T), id);
    assert.equal(AN.bestaetigenTokenPruefen(t, T + 120_000), null, "abgelaufen");
    assert.equal(AN.bestaetigenTokenPruefen(t.slice(0, -2) + "xx", T), null, "Signatur verändert");
    const [teil, sig] = t.split(".");
    const fremd = Buffer.from(`${id.replace("0b", "0c")}.${Buffer.from(teil, "base64url").toString().split(".")[1]}`).toString("base64url");
    assert.equal(AN.bestaetigenTokenPruefen(`${fremd}.${sig}`, T), null, "andere Instanz");
    assert.notEqual(AN.instanzToken(id), t.split(".")[1], "Zwecke getrennt");
  } finally {
    if (alt === undefined) delete process.env.INTERNAL_HMAC_SECRET; else process.env.INTERNAL_HMAC_SECRET = alt;
  }
});
await pruefe("Link nur auf die Gerätebestätigung des eigenen Anmeldedienstes", () => {
  assert.equal(AN.linkErlaubt(LINK, REALM), true);
  assert.equal(AN.linkErlaubt(LINK, REALM + "/"), true);
  assert.equal(AN.linkErlaubt("https://boese.example/realms/ava/device?user_code=X", REALM), false);
  assert.equal(AN.linkErlaubt(`${REALM}/account`, REALM), false);
  assert.equal(AN.linkErlaubt(LINK.replace("https:", "http:"), REALM), false);
  assert.equal(AN.linkErlaubt(LINK, undefined), false);
  assert.deepEqual(AN.bestaetigungsLink({ angemeldet: false, link: LINK, bis: "b" }, REALM), { link: LINK, bis: "b" });
  assert.equal(AN.bestaetigungsLink({ angemeldet: true, link: LINK }, REALM), null);
});
await pruefe("Anlegen mit Token: Secret gesetzt, Maschine bekommt es, wartet seit jetzt", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe(); const b = new I.CloudBetrieb(repo, fly, { zufall: () => "tttttttttt", token: (id) => `tok-${id}` });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  await b.fortsetzen(a.id, "betreiber");
  const z = await repo.holen(a.id);
  assert.ok(fly.aufrufe.find((x) => x[0] === "secretsSetzen")[2].includes("AVA_GATEWAY_TOKEN"));
  assert.equal(z.schritte.gatewayToken, true); assert.ok(z.schritte.wartetSeit);
  const cfgM = [...fly.maschinen.values()][0].config;
  assert.ok(cfgM.containers.find((c) => c.name === "ava").secrets.some((s) => s.env_var === "AVA_GATEWAY_TOKEN"));
  assert.equal(z.zustand, "wartet_auf_verbindung");
});
await pruefe("Anlegen ohne Geheimnis: kein Token-Secret (Z4 aus, alles andere wie bisher)", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe(); const b = new I.CloudBetrieb(repo, fly, { zufall: () => "uuuuuuuuuu", token: () => null });
  const a = await b.anlegen({ tenantId: "t1", actorId: "a1", quelle: "betreiber" });
  await b.fortsetzen(a.id, "betreiber");
  assert.ok(!fly.aufrufe.find((x) => x[0] === "secretsSetzen")[2].includes("AVA_GATEWAY_TOKEN"));
  assert.ok(!(await repo.holen(a.id)).schritte.gatewayToken);
});
const mitToken = async (zufall) => {
  const w = await mitMailsOpt(zufall, { token: (id) => `tok-${id}` });
  w.fly.anmeldungWert = { angemeldet: false, link: LINK, bis: null };
  return w;
};
async function mitMailsOpt(zufall, opt) {
  const w = await aufbau(zufall, opt); const mails = [];
  w.deps.benachrichtigen = async (art, i, extra) => { mails.push({ art, ...extra }); };
  return { ...w, mails };
}
await pruefe("angemeldet → läuft, M2 genau einmal", async () => {
  const w = await mitToken("v000000001");
  w.fly.anmeldungWert = { angemeldet: true };
  await A.abgleichen(w.deps); await A.abgleichen(w.deps);
  const z = await w.repo.holen(w.id);
  assert.equal(z.zustand, "laeuft"); assert.ok(z.verbundenAt);
  assert.deepEqual(w.mails.map((m) => m.art), ["laeuft"]);
  assert.ok(w.repo.ereignisseAlle.some((e) => e.art === "verbunden"));
});
await pruefe("M3: sofort, sobald der Server auf die Bestätigung wartet, Erinnerung nach 24 Stunden, je einmal", async () => {
  const w = await mitToken("v000000002");
  await w.repo.aendern(w.id, { schritte: { ...(await w.repo.holen(w.id)).schritte, wartetSeit: new Date(T).toISOString() } });
  for (const min of [1, 10, 31, 120, 25 * 60, 30 * 60]) { w.setzeUhr(T + min * 60_000); await A.abgleichen(w.deps); }
  assert.deepEqual(w.mails.map((m) => `${m.art}:${m.stufe}`), ["bestaetigen:bereit", "bestaetigen:24h"]);
});
await pruefe("M3: Instanz mit alter erster Mail (vor der Umstellung) bekommt keine zweite, nur die Erinnerung", async () => {
  const w = await mitToken("v000000012");
  await w.repo.aendern(w.id, { schritte: { ...(await w.repo.holen(w.id)).schritte, wartetSeit: new Date(T).toISOString(), m3_30m: new Date(T + 30 * 60_000).toISOString() } });
  for (const min of [40, 120, 25 * 60]) { w.setzeUhr(T + min * 60_000); await A.abgleichen(w.deps); }
  assert.deepEqual(w.mails.map((m) => `${m.art}:${m.stufe}`), ["bestaetigen:24h"]);
});
await pruefe("M3 nicht ohne Ein-Klick-Endpunkt (älteres Image)", async () => {
  const w = await mitToken("v000000003");
  w.fly.anmeldungWert = null;
  await w.repo.aendern(w.id, { schritte: { ...(await w.repo.holen(w.id)).schritte, wartetSeit: new Date(T - 2 * 86_400_000).toISOString() } });
  await A.abgleichen(w.deps);
  assert.equal(w.mails.length, 0);
});
await pruefe("Anmeldung verloren → wartet; wieder angemeldet → läuft ohne zweite M2", async () => {
  const w = await mitToken("v000000004");
  w.fly.anmeldungWert = { angemeldet: true }; await A.abgleichen(w.deps);
  w.fly.anmeldungWert = { angemeldet: false, link: LINK }; await A.abgleichen(w.deps);
  assert.equal((await w.repo.holen(w.id)).zustand, "wartet_auf_verbindung");
  w.fly.anmeldungWert = { angemeldet: false, link: null }; await A.abgleichen(w.deps);
  w.fly.anmeldungWert = { angemeldet: true }; await A.abgleichen(w.deps);
  assert.equal((await w.repo.holen(w.id)).zustand, "laeuft");
  assert.deepEqual(w.mails.map((m) => m.art), ["laeuft"]);
  assert.ok(w.repo.ereignisseAlle.some((e) => e.art === "abgemeldet") && w.repo.ereignisseAlle.some((e) => e.art === "wieder_verbunden"));
});
await pruefe("Anmeldung verloren: Bestätigungs-Mail erst nach 30 Minuten, nicht sofort", async () => {
  const w = await mitToken("v000000014");
  w.fly.anmeldungWert = { angemeldet: true }; await A.abgleichen(w.deps);
  w.fly.anmeldungWert = { angemeldet: false, link: LINK };
  w.setzeUhr(T + 60_000); await A.abgleichen(w.deps);
  w.setzeUhr(T + 10 * 60_000); await A.abgleichen(w.deps);
  assert.deepEqual(w.mails.map((m) => m.art), ["laeuft"], "kurz nach dem Verlust keine Mail");
  w.setzeUhr(T + 32 * 60_000); await A.abgleichen(w.deps);
  assert.deepEqual(w.mails.map((m) => `${m.art}${m.stufe ? ":" + m.stufe : ""}`), ["laeuft", "bestaetigen:bereit"]);
});
await pruefe("Neustart ohne Link (Token wird geladen): bleibt läuft", async () => {
  const w = await mitToken("v000000005");
  w.fly.anmeldungWert = { angemeldet: true }; await A.abgleichen(w.deps);
  w.fly.anmeldungWert = { angemeldet: false, link: null, phase: "komposition" }; await A.abgleichen(w.deps);
  assert.equal((await w.repo.holen(w.id)).zustand, "laeuft");
});

console.log("Cloud: Ausfall und Wiederkehr (Z4)");
await pruefe("M4 ab 10 Minuten, Wackeln = eine Mail, M5 nach 5 Minuten stabil mit Dauer", async () => {
  const w = await mitMails("w000000001");
  await w.repo.aendern(w.id, { zustand: "laeuft", verbundenAt: new Date(T).toISOString() });
  const lauf = async (min, gesund) => { w.setzeUhr(T + min * 60_000); w.fly.gesundWert = gesund; await A.abgleichen(w.deps); };
  await lauf(0, false); assert.equal(w.mails.length, 0);
  await lauf(11, false);
  assert.deepEqual(w.mails.map((m) => m.art), ["nicht_erreichbar"]);
  assert.ok(w.meldungen.some((m) => m.includes("10 Minuten")), "Betreiber informiert");
  await lauf(16, false); await lauf(20, true); await lauf(22, false); await lauf(30, true);
  assert.deepEqual(w.mails.map((m) => m.art), ["nicht_erreichbar"], "kein M5 vor 5 Minuten stabil");
  await lauf(36, true); await lauf(45, true);
  assert.deepEqual(w.mails.map((m) => m.art), ["nicht_erreichbar", "wieder_erreichbar"]);
  assert.equal(w.mails[1].dauerMin, 30);
});
await pruefe("kein Ausfall während Update (Fly nicht „started“)", async () => {
  const w = await mitMails("w000000002");
  await w.repo.aendern(w.id, { zustand: "laeuft", verbundenAt: new Date(T).toISOString() });
  const mid = (await w.repo.holen(w.id)).maschineId;
  w.fly.maschinen.get(mid).state = "replacing"; w.fly.gesundWert = false;
  for (const min of [0, 20, 40]) { w.setzeUhr(T + min * 60_000); await A.abgleichen(w.deps); }
  assert.equal(w.mails.length, 0); assert.equal(w.meldungen.length, 0);
  assert.equal((await w.repo.holen(w.id)).schritte.ungesundSeit, undefined);
});
await pruefe("noch nie verbunden: Ausfall nur an den Betreiber", async () => {
  const w = await mitMails("w000000003");
  w.fly.gesundWert = false;
  for (const min of [0, 12]) { w.setzeUhr(T + min * 60_000); await A.abgleichen(w.deps); }
  assert.equal(w.mails.length, 0); assert.equal(w.meldungen.length, 1);
});

console.log("Cloud: Löschung mit Vorwarnung (Z4)");
await pruefe("Standard: Auto-Löschen an, mit CLOUD_AUTO_LOESCHEN=0 aus", () => {
  const alt = process.env.CLOUD_AUTO_LOESCHEN;
  delete process.env.CLOUD_AUTO_LOESCHEN; assert.equal(A.regelnAusEnv().autoLoeschen, true);
  process.env.CLOUD_AUTO_LOESCHEN = "0"; assert.equal(A.regelnAusEnv().autoLoeschen, false);
  if (alt === undefined) delete process.env.CLOUD_AUTO_LOESCHEN; else process.env.CLOUD_AUTO_LOESCHEN = alt;
});
await pruefe("M11 am 23. Tag, Löschen frühestens 7 Tage danach, dann M12", async () => {
  const w = await mitMails("l000000001");
  w.deps.regeln = { ...R, autoLoeschen: true };
  await w.betrieb.stoppen(w.id, "admin", "admin", { absicht: true });
  await w.betrieb.ruhen(w.id, "admin");
  await w.repo.aendern(w.id, { gestopptAt: new Date(T - 22 * tag).toISOString() });
  await A.abgleichen(w.deps); assert.equal(w.mails.length, 0, "Tag 22: noch nichts");
  await w.repo.aendern(w.id, { gestopptAt: new Date(T - 24 * tag).toISOString() });
  await A.abgleichen(w.deps);
  assert.deepEqual(w.mails.map((m) => m.art), ["loeschung_angekuendigt"]);
  assert.equal(w.mails[0].loeschenAm, new Date(T + 7 * tag).toISOString(), "frühestens 7 Tage nach der Mail");
  w.setzeUhr(T + 6 * tag); await A.abgleichen(w.deps);
  assert.equal((await w.repo.holen(w.id)).zustand, "ruht", "Tag 30, aber Mail erst 6 Tage alt");
  w.setzeUhr(T + 7 * tag); await A.abgleichen(w.deps);
  assert.equal((await w.repo.holen(w.id)).zustand, "geloescht");
  assert.deepEqual(w.mails.map((m) => m.art), ["loeschung_angekuendigt", "geloescht"]);
});
await pruefe("Betreiber-Stopp: nie automatisch löschen, keine Mail", async () => {
  const w = await mitMails("l000000002");
  w.deps.regeln = { ...R, autoLoeschen: true };
  await w.betrieb.stoppen(w.id, "betreiber", "betreiber", { absicht: true });
  await w.betrieb.ruhen(w.id, "betreiber");
  await w.repo.aendern(w.id, { gestopptAt: new Date(T - 40 * tag).toISOString() });
  await A.abgleichen(w.deps);
  assert.equal((await w.repo.holen(w.id)).zustand, "ruht");
  assert.equal(w.mails.length, 0); assert.ok(w.meldungen.some((m) => m.includes("Löschung fällig")));
});
await pruefe("Löschdatum für die Anzeige", () => {
  assert.equal(A.loeschDatum({ gestopptAt: null, schritte: {} }, R), null);
  assert.equal(A.loeschDatum({ gestopptAt: new Date(T).toISOString(), schritte: {} }, R), new Date(T + 30 * tag).toISOString());
  assert.equal(A.loeschDatum({ gestopptAt: new Date(T).toISOString(), schritte: { m11: new Date(T + 25 * tag).toISOString() } }, R), new Date(T + 32 * tag).toISOString());
});

console.log("Cloud: Mails (Z4)");
const mailsZ4 = [
  V.serverLaeuftMail(basisMail),
  V.serverBestaetigenMail({ ...basisMail, stufe: "bereit", bestaetigenUrl: "https://ava-db-gateway.fly.dev/cloud/bestaetigen?t=abc" }),
  V.serverBestaetigenMail({ ...basisMail, stufe: "24h", bestaetigenUrl: "https://ava-db-gateway.fly.dev/cloud/bestaetigen?t=abc" }),
  V.serverNichtErreichbarMail({ ...basisMail, seit: "2026-12-01T11:00:00Z" }),
  V.serverWiederErreichbarMail({ ...basisMail, dauerMin: 30 }),
  V.serverLoeschungMail({ ...basisMail, grund: "zahlung", loeschenAm: "2027-01-07T10:00:00Z", zahlungUrl: "https://admin.ava.bi/abrechnung", fuerAdmin: true }),
  V.serverLoeschungMail({ ...basisMail, grund: "admin", loeschenAm: "2027-01-07T10:00:00Z", zahlungUrl: "x", fuerAdmin: false }),
  V.serverGeloeschtMail(basisMail),
];
await pruefe("keine Fachbegriffe, Anrede, höchstens ein Knopf", () => {
  for (const m of mailsZ4) {
    assert.ok(!verboten.test(m.betreff + m.text), `${m.betreff}: ${(m.betreff + m.text).match(verboten)}`);
    assert.match(m.html, /Hallo Eva,/);
    assert.ok((m.html.match(/border-radius:8px;">\s*<a /g) ?? []).length <= 1, m.betreff);
  }
});
await pruefe("M3 mit Link, M4 mit Uhrzeit, M5 mit Dauer, M11 mit Datum und passendem Knopf", () => {
  assert.ok(mailsZ4[1].html.includes("cloud/bestaetigen?t=abc")); assert.match(mailsZ4[2].betreff, /Erinnerung/);
  assert.match(mailsZ4[3].text, /seit 12:00 Uhr/);
  assert.match(mailsZ4[4].text, /etwa 30 Minuten/);
  assert.match(mailsZ4[5].text, /7\. Januar 2027/); assert.match(mailsZ4[5].text, /Zahlung aktualisieren/);
  assert.match(mailsZ4[6].text, /sprich bitte vorher mit ihr/);
  assert.equal(V.dauerText(150), "etwa 3 Stunden"); assert.equal(V.dauerText(3000), "etwa 2 Tage"); assert.equal(V.dauerText(1), "etwa eine Minute");
});

console.log("Cloud: Updates mit Rücknahme (Z7)");
const schnell = { updateWarteSek: 0.01, pruefMs: 1, pause: async () => {} };
await pruefe("Update gesund → neue Version, Ereignis aktualisiert", async () => {
  const w = await aufbau("u000000001", schnell);
  const erg = await w.betrieb.aktualisieren(w.id, "0.1.980", "abgleicher");
  assert.equal(erg.ergebnis, "ok");
  const z = await w.repo.holen(w.id);
  assert.equal(z.imageVersion, "0.1.980");
  assert.equal(w.fly.maschinen.get(z.maschineId).config.image, "registry.fly.io/ava-kunden-image:v0.1.980");
  assert.ok(w.repo.ereignisseAlle.some((e) => e.art === "aktualisiert"));
});
await pruefe("Update nicht gesund → automatisch zurück auf die alte Version", async () => {
  const w = await aufbau("u000000002", schnell);
  w.fly.gesundWert = false;
  const erg = await w.betrieb.aktualisieren(w.id, "0.1.980", "abgleicher");
  assert.equal(erg.ergebnis, "zurueck");
  const z = await w.repo.holen(w.id);
  assert.equal(z.imageVersion, "0.1.975");
  assert.equal(w.fly.maschinen.get(z.maschineId).config.image, "registry.fly.io/ava-kunden-image:v0.1.975");
  assert.deepEqual(w.fly.aufrufe.filter((a) => a[0] === "maschineAktualisieren").map((a) => a[2]), ["registry.fly.io/ava-kunden-image:v0.1.980", "registry.fly.io/ava-kunden-image:v0.1.975"]);
});
await pruefe("verbundene Instanz gilt erst als gesund, wenn sie wieder angemeldet ist", async () => {
  const w = await aufbau("u000000003", { ...schnell, token: (id) => `tok-${id}` });
  await w.repo.aendern(w.id, { zustand: "laeuft", verbundenAt: new Date(T).toISOString() });
  w.fly.anmeldungWert = { angemeldet: false, link: null };
  assert.equal((await w.betrieb.aktualisieren(w.id, "0.1.980", "abgleicher")).ergebnis, "zurueck");
  w.fly.anmeldungWert = { angemeldet: true };
  assert.equal((await w.betrieb.aktualisieren(w.id, "0.1.980", "abgleicher")).ergebnis, "ok");
});

console.log("Cloud: Wellen (Z7)");
const RR = { stunden: 24, prozent: 10, parallel: 2, fensterVon: 2, fensterBis: 5, maxFehlerQuote: 0.05 };
const NACHT = Date.parse("2026-12-02T02:30:00Z"); // 03:30 Berlin
const MITTAG = Date.parse("2026-12-02T11:00:00Z");
await pruefe("Versionen, Fenster 02–05 Uhr Berlin", () => {
  assert.equal(RO.versionAelter("0.1.975", "0.1.980"), true);
  assert.equal(RO.versionAelter("0.1.980", "0.1.975"), false);
  assert.equal(RO.versionAelter("0.2.0", "0.1.999"), false);
  assert.equal(RO.imFenster(NACHT, RR), true);
  assert.equal(RO.imFenster(MITTAG, RR), false);
  assert.equal(RO.imFenster(Date.parse("2026-07-02T00:30:00Z"), RR), true, "Sommerzeit: 02:30 Berlin");
});
const instanzWelle = (id, teil = {}) => ({ id, tenantId: "kunde", flyApp: `ava-u-${id}`, zustand: "laeuft", soll: "laufen", maschineId: "m", imageVersion: "0.1.975", schritte: {}, ...teil });
await pruefe("Welle: 10 %, aber mindestens eine Kunden-Instanz; Betreiber immer dabei", () => {
  const liste = Array.from({ length: 30 }, (_, n) => instanzWelle(`k${n}`)).concat([instanzWelle("op1", { tenantId: "op" })]);
  const welle = RO.zielePhase("welle", liste, "op", "0.1.980", 10);
  assert.ok(welle.some((i) => i.id === "op1"));
  assert.ok(welle.length >= 2 && welle.length <= 10, String(welle.length));
  assert.equal(RO.zielePhase("welle", [instanzWelle("einzig")], "op", "0.1.980", 10).length, 1);
  assert.equal(RO.zielePhase("betreiber", liste, "op", "0.1.980", 10).length, 1);
  assert.equal(RO.zielePhase("alle", liste, "op", "0.1.980", 10).length, 31);
  assert.equal(RO.zielePhase("alle", [instanzWelle("x", { schritte: { updateFehler: "0.1.980" } })], "op", "0.1.980", 10).length, 0, "gescheiterte nicht erneut");
  assert.equal(RO.zielePhase("alle", [instanzWelle("x", { zustand: "gestoppt" })], "op", "0.1.980", 10).length, 0, "pausierte nicht");
});
await pruefe("Phasen: 24 h je Stufe, Abbruch bei Fehlern", () => {
  const r = (teil) => ({ version: "0.1.980", phase: "betreiber", phaseAt: new Date(NACHT - 25 * 3_600_000).toISOString(), erfolge: 0, fehler: 0, hinweis: null, grund: null, ...teil });
  assert.deepEqual(RO.naechstePhase(r({}), 0, NACHT, RR), { phase: "welle" });
  assert.equal(RO.naechstePhase(r({ phaseAt: new Date(NACHT - 3_600_000).toISOString() }), 0, NACHT, RR), null, "noch keine 24 h");
  assert.equal(RO.naechstePhase(r({}), 1, NACHT, RR), null, "noch offen");
  assert.equal(RO.naechstePhase(r({ fehler: 1 }), 0, NACHT, RR).phase, "angehalten");
  assert.deepEqual(RO.naechstePhase(r({ phase: "welle" }), 0, NACHT, RR), { phase: "alle" });
  assert.equal(RO.naechstePhase(r({ phase: "alle", erfolge: 40, fehler: 1 }), 0, NACHT, RR).phase, "fertig");
  assert.equal(RO.naechstePhase(r({ phase: "alle", erfolge: 10, fehler: 1 }), 3, NACHT, RR).phase, "angehalten");
});
function rolloutRepo() {
  const m = new Map();
  return {
    m,
    async holen(v) { return m.get(v) ?? null; },
    async anlegen(v) { if (!m.has(v)) m.set(v, { version: v, phase: "betreiber", phaseAt: new Date(uhrRO).toISOString(), erfolge: 0, fehler: 0, hinweis: null, grund: null }); return m.get(v); },
    async phase(v, phase, grund = null) { Object.assign(m.get(v), { phase, grund, phaseAt: new Date(uhrRO).toISOString() }); },
    async zaehlen(v, art) { m.get(v)[art]++; },
    async hinweis(v, t) { m.get(v).hinweis = t; },
    async liste() { return [...m.values()]; },
  };
}
let uhrRO = NACHT;
await pruefe("Ablauf: Betreiber-Phase 24 h, Welle, Rest, fertig; M7 einmal je Woche", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe(); let k = 0;
  const betrieb = new I.CloudBetrieb(repo, fly, { zufall: () => `r${++k}`.padEnd(10, "0"), ...schnell });
  const ids = [];
  for (let n = 0; n < 12; n++) { const a = await betrieb.anlegen({ tenantId: "kunde", actorId: `a${n}`, quelle: "betreiber" }); await betrieb.fortsetzen(a.id, "betreiber"); await repo.aendern(a.id, { zustand: "laeuft", verbundenAt: new Date(T).toISOString() }); ids.push(a.id); }
  fly.versionWert = "0.1.980";
  const rollouts = rolloutRepo(); const laeufe = []; const mails = []; const meldungen = [];
  const d = { repo, fly, betrieb, rollouts, betreiberTenant: "op", melden: async (t) => meldungen.push(t), benachrichtigen: async (art, i, x) => mails.push({ art, id: i.id, ...x }), regeln: RR, jetzt: () => uhrRO, starte: (p) => laeufe.push(p) };
  const lauf = async () => { const b = await RO.rolloutSchritt(d, await repo.liste()); await Promise.all(laeufe.splice(0)); return b; };
  uhrRO = NACHT;
  let b = await lauf();
  assert.equal(b.phase, "betreiber"); assert.equal(b.gestartet, 0);
  uhrRO = NACHT + 24 * 3_600_000; b = await lauf();
  assert.equal(b.phase, "welle"); assert.ok(b.gestartet >= 1 && b.gestartet <= 2, String(b.gestartet));
  const nachWelle = (await repo.liste()).filter((i) => i.imageVersion === "0.1.980").length;
  assert.ok(nachWelle >= 1 && nachWelle <= 2);
  uhrRO = NACHT + 48 * 3_600_000;
  for (let n = 0; n < 10; n++) await lauf();
  assert.equal((await repo.liste()).filter((i) => i.imageVersion === "0.1.980").length, 12);
  b = await lauf();
  assert.equal(rollouts.m.get("0.1.980").phase, "fertig");
  assert.equal(rollouts.m.get("0.1.980").erfolge, 12);
  assert.equal(mails.filter((m) => m.art === "aktualisiert").length, 12, "M7 je Instanz");
  // nächstes Update binnen einer Woche: kein zweites M7
  fly.versionWert = "0.1.981"; uhrRO = NACHT + 3 * 24 * 3_600_000;
  await rollouts.anlegen("0.1.981"); await rollouts.phase("0.1.981", "alle");
  for (let n = 0; n < 8; n++) await lauf();
  assert.equal(mails.filter((m) => m.art === "aktualisiert").length, 12);
  assert.equal(meldungen.length, 0);
});
await pruefe("Fehlschlag: zurück, markiert, gemeldet, Welle angehalten", async () => {
  const repo = speicherRepo(); const fly = flyAttrappe(); let k = 0;
  const betrieb = new I.CloudBetrieb(repo, fly, { zufall: () => `s${++k}`.padEnd(10, "0"), ...schnell });
  for (let n = 0; n < 3; n++) { const a = await betrieb.anlegen({ tenantId: "kunde", actorId: `a${n}`, quelle: "betreiber" }); await betrieb.fortsetzen(a.id, "betreiber"); }
  fly.versionWert = "0.1.980"; fly.gesundWert = false;
  const rollouts = rolloutRepo(); await rollouts.anlegen("0.1.980"); await rollouts.phase("0.1.980", "alle");
  const laeufe = []; const meldungen = [];
  const d = { repo, fly, betrieb, rollouts, betreiberTenant: "op", melden: async (t) => meldungen.push(t), regeln: RR, jetzt: () => NACHT, starte: (p) => laeufe.push(p) };
  await RO.rolloutSchritt(d, await repo.liste()); await Promise.all(laeufe.splice(0));
  assert.equal(rollouts.m.get("0.1.980").fehler, 2);
  assert.ok(meldungen.some((t) => t.includes("nicht gesund")));
  await RO.rolloutSchritt(d, await repo.liste());
  assert.equal(rollouts.m.get("0.1.980").phase, "angehalten");
  assert.ok(meldungen.some((t) => t.includes("angehalten")));
  assert.equal((await repo.liste()).filter((i) => i.imageVersion === "0.1.975").length, 3, "alle auf alter Version");
});
await pruefe("außerhalb des Fensters kein Update; M6 am Vorabend nur mit Hinweis", async () => {
  const w = await aufbau("v000000009", schnell);
  await w.repo.aendern(w.id, { zustand: "laeuft", verbundenAt: new Date(T).toISOString() });
  w.fly.versionWert = "0.1.980";
  const rollouts = rolloutRepo(); await rollouts.anlegen("0.1.980"); await rollouts.phase("0.1.980", "alle");
  const mails = []; const laeufe = [];
  const abend = Date.parse("2026-12-02T17:30:00Z"); // 18:30 Berlin
  const d = { repo: w.repo, fly: w.fly, betrieb: w.betrieb, rollouts, betreiberTenant: "op", melden: async () => {}, benachrichtigen: async (art) => mails.push(art), regeln: RR, jetzt: () => abend, starte: (p) => laeufe.push(p) };
  let b = await RO.rolloutSchritt(d, await w.repo.liste());
  assert.equal(b.gestartet, 0); assert.equal(mails.length, 0, "ohne Hinweis keine M6");
  await rollouts.hinweis("0.1.980", "Neue Statuskarte in der App");
  await RO.rolloutSchritt(d, await w.repo.liste()); await RO.rolloutSchritt(d, await w.repo.liste());
  assert.deepEqual(mails, ["update_hinweis"]);
});
await pruefe("Staging-Kanal: Kandidat sofort, ohne Wellen/Fenster; Prod-Kanal nimmt die Zielversion statt des neuesten Tags", async () => {
  const w = await aufbau("v00000000s", schnell);
  await w.repo.aendern(w.id, { zustand: "laeuft", verbundenAt: new Date(T).toISOString() });
  w.fly.versionWert = "0.1.990"; // neuester Tag (Kandidat)
  const rollouts = rolloutRepo(); const laeufe = [];
  const mittag = Date.parse("2026-12-02T11:00:00Z"); // außerhalb des Nachtfensters
  const basis = { repo: w.repo, fly: w.fly, betrieb: w.betrieb, rollouts, betreiberTenant: "op", melden: async () => {}, regeln: RR, jetzt: () => mittag, starte: (p) => laeufe.push(p) };
  const s = await RO.rolloutSchritt({ ...basis, kanal: "staging", zielVersion: async () => "0.1.990" }, await w.repo.liste());
  assert.equal(s.gestartet, 1); assert.equal(s.phase, "alle");
  assert.equal(await rollouts.holen("0.1.990"), null, "keine Wellen-Zeile für Staging");
  await Promise.all(laeufe);
  assert.equal((await w.repo.holen(w.id)).imageVersion, "0.1.990");
  const p = await RO.rolloutSchritt({ ...basis, kanal: "prod", zielVersion: async () => "0.1.976" }, await w.repo.liste());
  assert.equal(p, null, "Prod-Ziel älter als die Instanz: kein Rollout, kein Zurückdrehen");
});
await pruefe("Jetzt aktualisieren: sofort, auch außerhalb des Fensters; nicht wenn angehalten", async () => {
  const w = await aufbau("v000000010", schnell);
  w.fly.versionWert = "0.1.980";
  const rollouts = rolloutRepo(); const laeufe = [];
  const d = { repo: w.repo, fly: w.fly, betrieb: w.betrieb, rollouts, betreiberTenant: null, melden: async () => {}, regeln: RR, jetzt: () => MITTAG, starte: (p) => laeufe.push(p) };
  const i = await w.repo.holen(w.id);
  assert.equal((await RO.jetztAktualisieren(d, i)).gestartet, true);
  await Promise.all(laeufe.splice(0));
  assert.equal((await w.repo.holen(w.id)).imageVersion, "0.1.980");
  assert.equal((await RO.jetztAktualisieren(d, await w.repo.holen(w.id))).gestartet, false, "schon aktuell");
  w.fly.versionWert = "0.1.981"; await rollouts.anlegen("0.1.981"); await rollouts.phase("0.1.981", "angehalten");
  assert.equal((await RO.jetztAktualisieren(d, await w.repo.holen(w.id))).gestartet, false);
});
await pruefe("Update-Mails: abbestellbar (Abmeldelink), ohne Fachbegriffe", () => {
  const m6 = V.serverUpdateHinweisMail({ ...basisMail, hinweis: "Neue Statuskarte", abmeldenUrl: "https://x/mail/abmelden?t=1" });
  const m7 = V.serverAktualisiertMail({ ...basisMail, hinweis: null, abmeldenUrl: "https://x/mail/abmelden?t=1" });
  for (const m of [m6, m7]) {
    assert.ok(!verboten.test(m.betreff + m.text), m.betreff);
    assert.ok(m.html.includes("mail/abmelden?t=1"));
    assert.match(m.html, /Hallo Eva,/);
  }
  assert.match(m6.text, /zwischen 2 und 5 Uhr/);
});

console.log("Cloud: Enterprise mit Vertrag");
await pruefe("Weg: Enterprise ohne Stripe-Abo → vertrag, nie kaufen; mit Abo buchen; Mitglied fragt an; Kauf und Buchung abgelehnt", async () => {
  // Die Abrechnung lädt die Gateway-Konfiguration; für den Test genügen Platzhalter (nichts wird aufgerufen).
  for (const k of ["DATABASE_URL", "EVENT_BUS_URL", "UPSTREAM_MASTER_DATA_URL", "UPSTREAM_COMPANY_PROFILE_URL", "UPSTREAM_COMPANY_CONTACT_URL", "UPSTREAM_COMPANY_PUBLICATION_URL", "UPSTREAM_WEBSITE_URL", "UPSTREAM_STRUCTURED_CONTENT_URL"]) {
    process.env[k] ??= k === "DATABASE_URL" ? "postgres://x:y@127.0.0.1:1/x" : k === "EVENT_BUS_URL" ? "amqp://127.0.0.1:1" : "http://127.0.0.1:1";
  }
  process.env.JWT_ISSUER ??= "https://issuer.test/realms/ava"; process.env.JWKS_URI ??= "http://127.0.0.1:1/jwks";
  const Ab0 = await import("../src/lib/cloud/abrechnung.ts");
  const Ab = Ab0.default ?? Ab0;
  const konten = {
    ent: { tenantId: "ent", kind: "organisation", mode: "enterprise", tier: "enterprise", status: "active", stripeSubscriptionId: null },
    entTier: { tenantId: "entTier", kind: "organisation", mode: "none", tier: "enterprise", status: "active", stripeSubscriptionId: null },
    entAbo: { tenantId: "entAbo", kind: "organisation", mode: "enterprise", tier: "enterprise", status: "active", stripeSubscriptionId: "sub_1" },
    neu: { tenantId: "neu", kind: "organisation", mode: "none", tier: "free", status: "active", stripeSubscriptionId: null },
    pro: { tenantId: "pro", kind: "organisation", mode: "sitze", tier: "pro", status: "active", stripeSubscriptionId: "sub_2" },
  };
  const gesehen = [];
  const q = { query: async (sql, p = []) => {
    gesehen.push(String(sql));
    if (/FROM "TenantBilling"/.test(sql)) return { rows: konten[p[0]] ? [konten[p[0]]] : [], rowCount: konten[p[0]] ? 1 : 0 };
    if (/FROM "TenantMember"/.test(sql)) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  assert.equal(await Ab.cloudWeg(q, "ent", true), "vertrag");
  assert.equal(await Ab.cloudWeg(q, "entTier", true), "vertrag", "auch wenn nur die Stufe enterprise ist");
  assert.equal(await Ab.cloudWeg(q, "entAbo", true), "buchen", "Enterprise mit Stripe-Abo bucht wie alle");
  assert.equal(await Ab.cloudWeg(q, "neu", true), "kaufen");
  assert.equal(await Ab.cloudWeg(q, "pro", true), "buchen");
  assert.equal(await Ab.cloudWeg(q, "unbekannt", true), "kaufen", "ohne Abrechnungskonto: Neukunde");
  assert.equal(await Ab.cloudWeg(q, "ent", false), "anfragen", "Mitglieder fragen ihre Admins");
  assert.equal(await Ab.cloudUeberVertrag(q, "ent"), true);
  assert.equal(await Ab.cloudUeberVertrag(q, "pro"), false);
  // Buchen für ein Mitglied und der Neukunden-Kauf brechen ab, bevor Stripe oder Fly berührt werden.
  process.env.STRIPE_PRICE_CLOUD = "price_test_cloud"; process.env.STRIPE_PRICE_PRO = "price_test_pro";
  const betrieb = { anlegen: async () => { throw new Error("darf nicht anlegen"); }, stand: async () => null };
  await assert.rejects(() => Ab.cloudEinschalten(q, betrieb, { tenantId: "ent", actorId: "a1", von: "a1" }), (e) => e.code === "vertrag" && /über den Vertrag/.test(e.message));
  gesehen.length = 0;
  await assert.rejects(() => Ab.cloudCheckout(q, { tenantId: "ent", actorId: "a1", email: "a@firma.test", appUrl: "https://app.test" }), (e) => e.code === "vertrag");
  assert.ok(!gesehen.some((x) => /INSERT|UPDATE/.test(x)), "kein Schreibzugriff beim abgelehnten Kauf");
});

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
