import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const load = async (p) => { const m = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const F = await load("../src/main/suggestions/faehigkeiten.ts");
const N = await load("../src/main/suggestions/nutzerstand.ts");
let fails = 0;
const check = (c, msg) => { if (!c) { fails++; console.log("  FAIL", msg); } else console.log("  ok  ", msg); };

console.log("Faehigkeitsgruppen");
const dir = join(process.cwd(), "src/main/agent/tools");
const namen = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".ts") || f === "index.ts") continue;
  const s = readFileSync(join(dir, f), "utf8");
  for (const m of s.matchAll(/name:\s*"([a-z0-9_]+)"/g)) namen.push(m[1]);
}
const offen = F.nichtZugeordnet(namen);
check(namen.length > 200, `${namen.length} Tool-Namen gefunden`);
check(offen.length === 0, `alle Tools einer Gruppe zugeordnet${offen.length ? ": FEHLT " + offen.join(", ") : ""}`);
const alle = F.verfuegbareFaehigkeiten(namen, []);
check(alle.every((g) => !g.verwaltung), "Verwaltung ohne Opt-in ausgeblendet");
check(F.verfuegbareFaehigkeiten(namen, ["mail", "telegram"]).every((g) => g.id !== "mail" && g.id !== "telegram"), "gesperrte Module fallen raus");
check(F.verfuegbareFaehigkeiten(["company_get"], []).length === 1, "nur Gruppen mit geladenen Tools");
const text = F.faehigkeitenText(alle);
check(text.length / 3.5 < 900, `Prompt-Text ${text.length} Zeichen (≈ ${Math.round(text.length / 3.5)} Token) unter 900 Token`);

console.log("Nutzerstand");
const deps = {
  angemeldet: () => true,
  gatewayRequest: async (p) => (p.startsWith("/v1/companies/matrix") ? { count: 73 } : { candidates: [{ discoveryId: "d1", name: "Muster GmbH" }] }),
  mailVerbunden: async () => true,
  telegramVerbunden: () => false,
  crmStatus: () => [{ provider: "hubspot", connected: true }],
  knowledgeStatus: () => [{ kind: "notion", connected: false }, { kind: "obsidian", connected: true }],
  linkedinAktiv: () => true,
  icp: () => ({ gesetzt: true, vollstaendig: false }),
  radarConfig: () => ({ enabled: true, lastRunAt: "2026-09-14T08:00:00.000Z" }),
  matches: () => ({ d1: { score: 88 }, d2: { score: 40 } }),
  workflows: () => [{ lastRun: { startedAt: "2026-09-13T10:00:00.000Z" } }, { lastRun: null }],
  skillsEigene: () => 3,
  watchlistAnzahl: async () => 2,
  emailAbleitungAktiv: () => true,
  modell: () => ({ ready: true, kind: "anthropic", model: "claude-x", sStufe: true }),
  tier: () => "enterprise",
  featureAn: (k) => k !== "telegram",
  featureKeys: () => ["mail", "telegram", "workflows"],
  organisation: () => true,
};
const svc = new N.NutzerstandService(deps);
const s = await svc.get();
check(s.verbindungen.hubspot === "verbunden" && s.verbindungen.notion === "offen" && s.verbindungen.obsidian === "verbunden", "Verbindungen aus CRM/Wissen");
check(s.verbindungen.telegram === "gesperrt", "gesperrtes Modul → gesperrt (nicht offen)");
check(s.gesperrteModule.join() === "telegram", "gesperrteModule aus Policy");
check(s.icp === "unvollstaendig", "ICP unvollstaendig");
check(s.radar.heisseTreffer === 1 && s.radar.topTreffer?.name === "Muster GmbH" && s.radar.topTreffer.score === 88, "Top-Treffer mit Name");
check(s.firmen.importiert === 73 && s.workflows.anzahl === 2 && s.workflows.letzterLaufAt?.startsWith("2026-09-13"), "Firmenzahl + Workflows");
check(s.plan === "enterprise" && s.modell.sStufe && s.organisation.mitglied, "Plan/Modell/Organisation");
const t = N.nutzerstandText(s);
check(t.includes("hubspot=verbunden") && t.includes("Gesperrt: telegram") && t.length / 3.5 < 250, `Textform ${t.length} Zeichen`);
const s2 = await svc.get();
check(s2 === s, "Cache greift");
svc.invalidate();
check((await svc.get()) !== s, "invalidate erzwingt Neuaufbau");

console.log("Chip-Erzeugung: harte Schranke + feste Liste");
const E = await load("../src/main/suggestions/erzeugung.ts");
const fae = F.verfuegbareFaehigkeiten(namen, s.gesperrteModule);
const roh = [
  { titel: "HubSpot verbinden", auftrag: "Verbinde HubSpot.", gruppe: "hubspot" },
  { titel: "Mit Facebook verbinden", auftrag: "Verbinde mein Facebook-Konto.", gruppe: "hubspot" },
  { titel: "Telegram verbinden", auftrag: "Richte Telegram ein.", gruppe: "telegram" },
  { titel: "Abo auf Pro wechseln", auftrag: "Wechsle mein Abrechnungsmodell.", gruppe: "organisation" },
  { titel: "Radar starten", auftrag: "Starte den Firmen-Radar in Herford.", gruppe: "radar" },
  { titel: "Radar starten", auftrag: "Nochmal.", gruppe: "radar" },
  { titel: "Analyse Muster GmbH", auftrag: "Erstelle eine ICP- und Marktanalyse zu Muster GmbH.", gruppe: "radar" },
  { titel: "Notion verbinden", auftrag: "Verbinde Notion.", gruppe: "notion" },
];
const gep = E.harteSchranke(roh, fae, s);
const titel = gep.map((c) => c.titel);
check(!titel.includes("HubSpot verbinden"), "erledigt (HubSpot verbunden) faellt weg");
check(!titel.includes("Mit Facebook verbinden"), "unbekannte Integration faellt weg");
check(!titel.includes("Telegram verbinden"), "gesperrtes Modul (Gruppe nicht verfuegbar) faellt weg");
check(!titel.includes("Abo auf Pro wechseln"), "Verwaltungsgruppe faellt weg");
check(titel.filter((t) => t === "Radar starten").length === 1, "Duplikate zusammengefasst");
check(titel.includes("Analyse Muster GmbH") && titel.includes("Notion verbinden"), "gueltige Chips bleiben: " + titel.join(" | "));
check(gep.length <= 4, "hoechstens vier Chips");
const fest = E.festeChips(s, fae);
check(fest.length > 0 && fest.length <= 4 && fest.every((c) => c.gruppe !== "hubspot"), "feste Liste ohne erledigte Verbindungen: " + fest.map((c) => c.titel).join(" | "));
const standNeu = { ...s, modell: { ...s.modell, bereit: false }, verbindungen: { ...s.verbindungen, hubspot: "offen" }, icp: "fehlt", radar: { ...s.radar, heisseTreffer: 0, topTreffer: null } };
const festNeu = E.festeChips(standNeu, fae);
check(festNeu[0]?.titel === "KI-Modell einrichten" && festNeu.some((c) => c.titel === "HubSpot verbinden") && festNeu.some((c) => c.titel === "Idealkundenprofil erstellen"), "feste Liste fuer Neueinsteiger: " + festNeu.map((c) => c.titel).join(" | "));

console.log(fails === 0 ? "\nSuggestions-Tests ok" : `\n${fails} Test(s) fehlgeschlagen`);
process.exit(fails === 0 ? 0 : 1);
