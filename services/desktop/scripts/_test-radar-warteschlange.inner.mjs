import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const load = async (p) => { const m = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const W = await load("../src/main/discovery/import-warteschlange.ts");
let fails = 0;
const check = (c, msg) => { if (!c) { fails++; console.log("  FAIL", msg); } else console.log("  ok  ", msg); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Gateway-Attrappe: Register kennt "Alpha GmbH|Herford", sonst nichts; Website-Anlage scheitert fuer "kaputt.de".
function gateway(log) {
  return {
    request: async (pfad, opts = {}) => {
      log.push(pfad);
      const body = opts.body ?? {};
      if (pfad.startsWith("/v1/discovery/candidates")) throw new Error("Nachschlagen sollte entfallen");
      if (pfad === "/v1/imports/from-list" && body.dryRun) {
        return { unmatched: body.companies.filter((c) => c.name !== "Alpha GmbH").map((c) => ({ name: c.name, location: c.city, candidates: [] })) };
      }
      if (pfad === "/v1/imports/from-list") return { transactionId: "tx-1" };
      if (pfad === "/v1/companies/web") { if (body.website === "kaputt.de") throw new Error("nicht erreichbar"); return { companyId: `WEB_${body.website}`, neu: true }; }
      if (pfad === "/v1/imports/by-ids") return { transactionId: "tx-2" };
      if (pfad === "/v1/discovery/decisions") return { saved: body.decisions.length };
      throw new Error("unerwartet: " + pfad);
    },
  };
}

console.log("Sammeln, Rückgängig, ein Lauf");
const dir = mkdtempSync(join(tmpdir(), "radar-ws-"));
const log = [];
let laeufe = 0;
const q = new W.RadarImportWarteschlange({ gateway: gateway(log), dir, verzoegerungMs: 200, nachLauf: () => laeufe++ });
const k = (id, name, city, domain) => ({ discoveryId: id, name, city, domain });
q.hinzufuegen([k("a", "Alpha GmbH", "Herford", "alpha.de")], "imported");
q.hinzufuegen([k("b", "Beta GmbH", "Herford", "beta.de")], "imported");
q.hinzufuegen([k("c", "Gamma GmbH", "Herford", "kaputt.de")], "imported");
q.hinzufuegen([k("d", "Delta GmbH", null, "delta.de")], "imported");
q.hinzufuegen([k("e", "Epsilon GmbH", "Herford", "eps.de")], "dismissed");
q.hinzufuegen([k("f", "Zeta GmbH", "Herford", "zeta.de")], "imported");
check(q.stand().eintraege.every((e) => e.status === "wartet"), "alles wartet vor Ablauf der Pause");
q.rueckgaengig("f");
check(!q.stand().eintraege.some((e) => e.discoveryId === "f"), "Rückgängig nimmt Eintrag heraus");
await pause(500);
const st = q.stand();
check(laeufe === 1, `genau ein Lauf (${laeufe})`);
check(!log.some((p) => p.startsWith("/v1/discovery/candidates")), "kein Nachladen der Kandidatenliste");
check(!st.eintraege.some((e) => ["a", "b", "e"].includes(e.discoveryId)), "importierte und ignorierte verlassen die Warteschlange");
const fehler = Object.fromEntries(st.eintraege.filter((e) => e.status === "fehler").map((e) => [e.discoveryId, e.grund]));
check(!!fehler.c && /Website/.test(fehler.c), "Website-Anlage gescheitert → Fehler mit Grund");
check(!!fehler.d && /Kein Ort/.test(fehler.d), "ohne Ort → Fehler mit Grund");
check(st.zuletzt?.importiert === 2 && st.zuletzt?.ignoriert === 1, `Ergebnis: ${st.zuletzt?.importiert} importiert, ${st.zuletzt?.ignoriert} ignoriert`);
check(st.zuletzt?.transactionId === "tx-1", "Vorgang verlinkbar");
const entschieden = log.filter((p) => p === "/v1/discovery/decisions").length;
check(entschieden === 1, "Entscheidungen in einem Aufruf");

console.log("Fehler: erneut, ignorieren, zurück");
q.erneut("c", "dismissed");
check(q.stand().eintraege.find((e) => e.discoveryId === "c")?.status === "wartet", "erneut als Ignorieren → wartet");
q.verwerfen("d");
check(!q.stand().eintraege.some((e) => e.discoveryId === "d"), "Zurück in die Liste entfernt den Fehler");
await pause(500);
check(!q.stand().eintraege.some((e) => e.discoveryId === "c"), "ignoriert nach zweitem Lauf");

console.log("Neustart");
q.hinzufuegen([k("g", "Eta GmbH", "Herford", "eta.de")], "imported");
q.stop();
check(existsSync(join(dir, "radar-warteschlange.json")), "Stand gespeichert");
const log2 = [];
const q2 = new W.RadarImportWarteschlange({ gateway: gateway(log2), dir, verzoegerungMs: 100 });
check(q2.stand().eintraege.some((e) => e.discoveryId === "g"), "Klick übersteht Neustart");
await pause(400);
check(!q2.stand().eintraege.some((e) => e.discoveryId === "g") && log2.includes("/v1/imports/by-ids"), "nach Neustart abgeschickt");
q2.stop();

console.log(fails === 0 ? "\nRadar-Warteschlange ok" : `\n${fails} Fehler`);
process.exit(fails === 0 ? 0 : 1);
