// PM-2026-0052: beobachtete Posts — Zeitfenster der Folgelaeufe und Abruf aller Kommentare.
import assert from "node:assert/strict";
import E from "../src/main/linkedin/personen-radar/engagement.ts";
const { zeitfensterSeit, fetchPostEngagement, ENGAGEMENT_DEFAULT_ACTORS } = E;
let fehler = 0;
const pruefe = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { fehler++; console.log(`  FEHL ${name}\n       ${e.message}`); } };
const jetzt = Date.parse("2026-11-16T12:00:00Z");
const vor = (h) => new Date(jetzt - h * 3600_000).toISOString();
const access = { quelle: "eigen", base: "https://api.apify.com/v2", token: "t", headers: {} };
const kommentar = (i) => ({ actor: { linkedinUrl: `https://www.linkedin.com/in/person-${i}`, name: `Person ${i}`, position: "GF" }, commentary: `Kommentar ${i}` });

console.log("Beobachtete Posts: Nachladen");
await pruefe("Zeitfenster deckt die Zeit seit dem letzten Abruf", () => {
  assert.equal(zeitfensterSeit(null, jetzt), null);
  assert.equal(zeitfensterSeit(vor(18), jetzt), "24h");
  assert.equal(zeitfensterSeit(vor(30), jetzt), "week");
  assert.equal(zeitfensterSeit(vor(24 * 10), jetzt), "month");
  assert.equal(zeitfensterSeit(vor(24 * 60), jetzt), "3months");
  assert.equal(zeitfensterSeit(vor(24 * 400), jetzt), null);
});

const aufrufe = [];
const echt = globalThis.fetch;
await pruefe("Folgelauf: Zeitfenster und Antworten nur beim Kommentar-Actor", async () => {
  aufrufe.length = 0;
  globalThis.fetch = async (url, init) => { aufrufe.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return new Response(JSON.stringify([kommentar(1)]), { status: 200 }); };
  const r = await fetchPostEngagement(access, ENGAGEMENT_DEFAULT_ACTORS, "https://www.linkedin.com/posts/x", { reaktionen: 50, kommentare: 50, zeitfenster: "week", antworten: true });
  assert.equal(aufrufe.length, 2);
  assert.deepEqual(aufrufe[0].body, { posts: ["https://www.linkedin.com/posts/x"], maxItems: 50 });
  assert.deepEqual(aufrufe[1].body, { posts: ["https://www.linkedin.com/posts/x"], maxItems: 50, postedLimit: "week", scrapeReplies: true });
  assert.equal(r.kommentare, 1);
  assert.equal(r.reaktionen, 1);
});
await pruefe("Zahl statt Abruf bleibt wie bisher", async () => {
  aufrufe.length = 0;
  await fetchPostEngagement(access, ENGAGEMENT_DEFAULT_ACTORS, "https://www.linkedin.com/posts/x", 30);
  assert.deepEqual(aufrufe.map((a) => a.body.maxItems), [30, 30]);
  assert.ok(aufrufe.every((a) => !("postedLimit" in a.body)));
});
await pruefe("Nachladen: keine Reaktionen, langer Lauf mit Nachfragen und Seiten", async () => {
  aufrufe.length = 0;
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    aufrufe.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
    if (u.includes("/runs?waitForFinish")) return new Response(JSON.stringify({ data: { id: "lauf1", status: "RUNNING", defaultDatasetId: "ds1" } }), { status: 201 });
    if (u.includes("/actor-runs/lauf1")) { polls++; return new Response(JSON.stringify({ data: { status: polls < 2 ? "RUNNING" : "SUCCEEDED" } }), { status: 200 }); }
    if (u.includes("/datasets/ds1/items")) {
      const off = Number(new URL(u).searchParams.get("offset"));
      return new Response(JSON.stringify(Array.from({ length: off === 0 ? 1000 : 26 }, (_, i) => kommentar(off + i))), { status: 200 });
    }
    return new Response("[]", { status: 404 });
  };
  const r = await fetchPostEngagement(access, ENGAGEMENT_DEFAULT_ACTORS, "https://www.linkedin.com/posts/x", { reaktionen: 0, kommentare: 1000, antworten: true, lang: true });
  assert.ok(!aufrufe.some((a) => a.url.includes("post-reactions")), "keine Reaktionen");
  assert.deepEqual(aufrufe[0].body, { posts: ["https://www.linkedin.com/posts/x"], maxItems: 1000, scrapeReplies: true });
  assert.equal(polls, 2);
  assert.equal(r.kommentare, 1026);
  assert.equal(r.engager.length, 1026);
});
await pruefe("Gateway-Limit beim Nachfragen wird als LINKEDIN_LIMIT gemeldet", async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/runs?waitForFinish")) return new Response(JSON.stringify({ data: { id: "l2", status: "RUNNING" } }), { status: 201 });
    return new Response(JSON.stringify({ error: "linkedin_limit_erreicht", meldung: "Limit erreicht." }), { status: 402 });
  };
  await assert.rejects(fetchPostEngagement(access, ENGAGEMENT_DEFAULT_ACTORS, "https://www.linkedin.com/posts/x", { reaktionen: 0, kommentare: 1000, lang: true }), /^Error: LINKEDIN_LIMIT/);
});
globalThis.fetch = echt;

// PM-2026-0053: parallele Zuordnung mit Obergrenze, nichts geht verloren.
const Sup = await import("../src/main/linkedin/personen-radar/supervisor.ts");
const { nebenlaeufig } = Sup.default ?? Sup;
await pruefe("nebenlaeufig: hoechstens n gleichzeitig, alle bearbeitet", async () => {
  let aktiv = 0, spitze = 0;
  const fertig = [];
  await nebenlaeufig(Array.from({ length: 23 }, (_, i) => i), 5, async (x) => {
    aktiv++; spitze = Math.max(spitze, aktiv);
    await new Promise((r) => setTimeout(r, 2 + (x % 4)));
    fertig.push(x); aktiv--;
  });
  assert.equal(spitze, 5);
  assert.deepEqual([...fertig].sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i));
});
await pruefe("nebenlaeufig: leere Liste und weniger Eintraege als Arbeiter", async () => {
  await nebenlaeufig([], 5, async () => { throw new Error("nie"); });
  const f = [];
  await nebenlaeufig([1, 2], 5, async (x) => { f.push(x); });
  assert.deepEqual(f.sort(), [1, 2]);
});
console.log(fehler ? `\n${fehler} Fehler.` : "\nAlles gruen.");
process.exit(fehler ? 1 : 0);
