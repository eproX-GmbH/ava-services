// PM-2026-0053: ein Nachlade-Lauf gegen Attrappen — Leads werden in Paketen gespeichert,
// parallele Zuordnung ohne Deckel, Abbruch bei AUTH behaelt Bisheriges und stellt Rest zurueck.
import assert from "node:assert/strict";
import S0 from "../src/main/linkedin/personen-radar/supervisor.ts";
const { PersonenRadarSupervisor } = S0.default ?? S0;
let fehler = 0;
const pruefe = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.stack?.split("\n").slice(0, 3).join(" | ")}`); } };
const POST = "https://www.linkedin.com/posts/test-post";

function speicher() {
  let cfg = { enabled: true, postUrls: [POST], intervalHours: 24, maxItemsPerPost: 50, maxResolvesPerRun: 10, actorIds: { postReactionsActorId: "harvestapi~linkedin-post-reactions", postCommentsActorId: "harvestapi~linkedin-post-comments", profileActorId: "harvestapi~linkedin-profile-scraper", companyActorId: "harvestapi~linkedin-company" }, lastRunAt: null, lastOutcome: null, unklarFreigegebenAm: null, postStand: {} };
  const gesehen = new Set(), offen = new Map(), cache = new Map();
  return {
    offen, gesehen,
    getConfig: () => ({ ...cfg, postStand: { ...cfg.postStand } }),
    setConfig: (p) => (cfg = { ...cfg, ...p }),
    setPostStand: (u, p) => { cfg.postStand = { ...cfg.postStand, [u]: { vollGeladenAt: null, letzterAbrufAt: null, ...(cfg.postStand[u] ?? {}), ...p } }; },
    filterNewPersons: async (k) => new Set(k.filter((x) => !gesehen.has(x))),
    markPersonsSeen: async (k) => k.forEach((x) => gesehen.add(x)),
    getFirmenCache: async () => new Map(cache),
    setFirmenCache: async (u, m) => cache.set(u, m),
    addUnklar: async () => {},
    offeneAblegen: async (es) => es.forEach((e) => offen.set(`${e.profileUrl}|${e.postUrl}`, e)),
    offeneHolen: async () => [...offen.values()],
    offeneEntfernen: async (k) => k.forEach((x) => offen.delete(x)),
    offeneAnzahl: async () => ({ [POST]: offen.size }),
  };
}

function apifyAttrappe(personen, { authAbProfil = Infinity } = {}) {
  let profile = 0;
  return async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    const json = (x, s = 200) => new Response(JSON.stringify(x), { status: s });
    if (u.includes("post-comments/runs?")) return json({ data: { id: "lauf", status: "SUCCEEDED", defaultDatasetId: "ds" } }, 201);
    if (u.includes("/datasets/ds/items")) return json(new URL(u).searchParams.get("offset") === "0" ? Array.from({ length: personen }, (_, i) => ({ actor: { linkedinUrl: `https://www.linkedin.com/in/p${i}`, name: `P ${i}` }, commentary: "Spannend" })) : []);
    if (u.includes("profile-scraper")) {
      profile++;
      if (profile > authAbProfil) return json({ error: "x" }, 401);
      await new Promise((r) => setTimeout(r, 3));
      const i = /p(\d+)/.exec(body.queries[0])[1];
      return json([{ experience: [{ companyName: `Firma ${i}`, companyLinkedinUrl: `https://www.linkedin.com/company/f${i}`, position: "GF", endDate: { text: "Present" } }] }]);
    }
    if (u.includes("linkedin-company")) { const i = /f(\d+)/.exec(body.companies[0])[1]; return json([{ website: `https://firma${i}.de`, name: `Firma ${i}` }]); }
    return json([]);
  };
}

function lauf(store, { gatewayFehler = false } = {}) {
  const pakete = [];
  const gateway = { request: async (pfad, o) => {
    if (pfad === "/v1/linkedin-leads/batch") { if (gatewayFehler) throw new Error("weg"); pakete.push(o.body.leads.length); return { neu: o.body.leads.length, aktualisiert: 0, vorhanden: 0, ids: [] }; }
    if (pfad === "/v1/discovery/candidates/direct") return { added: o.body.candidates.length, updated: 0, known: {} };
    return {};
  } };
  const alerts = [];
  const sup = new PersonenRadarSupervisor({
    providers: { getStatus: () => ({ ready: false }) },
    keyStore: { addMonthItems: () => {} },
    getApifyAccess: async () => ({ quelle: "eigen", base: "https://api.apify.com/v2", token: "t", headers: {} }),
    store, gateway,
    alerts: { add: (a) => (alerts.push(a), a) },
    notify: () => {}, onAlertsChanged: () => {}, isSignedIn: () => true, onCandidatesAdded: () => {}, onAudit: () => {},
  });
  return { sup, pakete, alerts };
}

const echt = globalThis.fetch;
console.log("Beobachtete Posts: Nachlade-Lauf");
await pruefe("23 Kommentare: alle zugeordnet, Leads in Paketen, eine Meldung", async () => {
  globalThis.fetch = apifyAttrappe(23);
  const store = speicher();
  const { sup, pakete, alerts } = lauf(store);
  const r = await sup.runNow("manuell", { nachladen: POST });
  assert.match(r, /23 aufgeloest/);
  assert.ok(pakete.length >= 3, `Pakete: ${pakete}`);
  assert.equal(pakete.reduce((a, n) => a + n, 0), 23);
  assert.equal(alerts.length, 1);
  assert.equal(store.offen.size, 0);
  assert.equal(sup.getFortschritt(), null);
  assert.ok(store.getConfig().postStand[POST].vollGeladenAt);
});
await pruefe("Abbruch bei ungueltigem Zugang: Bisheriges gespeichert, Rest wartet", async () => {
  globalThis.fetch = apifyAttrappe(30, { authAbProfil: 12 });
  const store = speicher();
  const { sup, pakete } = lauf(store);
  const r = await sup.runNow("manuell", { nachladen: POST });
  assert.match(r, /^APIFY_AUTH/);
  const gespeichert = pakete.reduce((a, n) => a + n, 0);
  assert.ok(gespeichert >= 10, `gespeichert ${gespeichert}`);
  assert.equal(gespeichert + store.offen.size, 30, `gespeichert ${gespeichert}, offen ${store.offen.size}`);
  assert.match(store.getConfig().lastOutcome, /Leads bis dahin gespeichert/);
});
await pruefe("Gateway nimmt Leads nicht an: Personen ungesehen und in der Warteschlange", async () => {
  globalThis.fetch = apifyAttrappe(5);
  const store = speicher();
  const { sup } = lauf(store, { gatewayFehler: true });
  await sup.runNow("manuell", { nachladen: POST });
  assert.equal(store.gesehen.size, 0);
  assert.equal(store.offen.size, 5);
});
await pruefe("Vorgemerkt: unterbrochener Lauf hinterlaesst die offenen Personen", async () => {
  globalThis.fetch = apifyAttrappe(8);
  const store = speicher();
  const { sup } = lauf(store);
  // Lauf nach dem Vormerken „abwuergen“: Profil-Abruf haengt nie zurueck.
  globalThis.fetch = async (url, init) => (String(url).includes("profile-scraper") ? new Promise(() => {}) : apifyAttrappe(8)(url, init));
  void sup.runNow("manuell", { nachladen: POST });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(store.offen.size, 8);
  assert.equal(sup.getFortschritt()?.phase, "zuordnen");
});
globalThis.fetch = echt;
console.log(fehler ? `\n${fehler} Fehler.` : "\nAlles gruen.");
process.exit(fehler ? 1 : 0);
