// AVA Cloud Z1 (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md): Maschinen-Konfiguration und Instanz-Abläufe
// gegen eine Fly-Attrappe und eine Datenbank im Speicher.
import assert from "node:assert/strict";
import K0 from "../src/lib/cloud/konfig.ts";
import I0 from "../src/lib/cloud/instanzen.ts";
import A0 from "../src/lib/cloud/abgleich.ts";
import AB0 from "../src/lib/cloud/posten.ts";
import V0 from "../src/lib/mail/vorlagen.ts";
const K = K0.default ?? K0;
const I = I0.default ?? I0;
const A = A0.default ?? A0;
const AB = AB0.default ?? AB0;
const V = V0.default ?? V0;
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
    async appsListe() { return [...apps, "ava-kunden-image"]; },
    gesundWert: true,
    async gesund() { return this.gesundWert; },
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
async function aufbau(zufall) {
  const repo = speicherRepo(); const fly = flyAttrappe(); const betrieb = new I.CloudBetrieb(repo, fly, { zufall: () => zufall });
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

console.log(fehler ? `\n${fehler} Fehler` : "\nalles gruen");
process.exit(fehler ? 1 : 0);
