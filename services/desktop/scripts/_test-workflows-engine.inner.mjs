// v0.1.601 — End-to-End-Test der Workflow-Engine mit Stub-Tools (ohne Electron):
// Radar-Import-Vorlage (Prime + Sub) und alle Logik-Nodes laufen wirklich durch.
const load = async (p) => { const m = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const { WorkflowRunner } = await load("../src/main/workflows/runner.ts");
const { WORKFLOW_TEMPLATES, templateToDefinition } = await load("../src/main/workflows/templates.ts");
const { DEFAULT_WORKFLOW_SETTINGS } = await load("../src/shared/workflow-types.ts");

const calls = [];
const tool = (name, run, parse) => ({
  name, description: name, parameters: { type: "object", properties: {} },
  parseArgs: (raw) => { if (parse) parse(raw); return raw; },
  run: async (args, ctx) => { calls.push({ name, args }); return run(args, ctx); },
  preview: () => name,
});
const TX = "tx_0123456789abcdef";
const tools = new Map([
  ["discovery_candidates", tool("discovery_candidates", () => ({ rows: [
    { discoveryId: "disc_aaaa", name: "Alpha GmbH", matchScore: 95, bereitsInAva: false },
    { discoveryId: "disc_bbbb", name: "Beta AG", matchScore: 70, bereitsInAva: false },
    { discoveryId: "disc_cccc", name: "Gamma KG", matchScore: 85, bereitsInAva: true },
  ] }))],
  ["discovery_decide", tool("discovery_decide", (a) => ({ entschieden: a.decisions.length, importiert: a.decisions.length, ignoriert: 0, transactionId: TX, ohneOrt: [], unbekannt: [] }),
    (raw) => { if (!Array.isArray(raw?.decisions) || raw.decisions.length < 1) throw new Error("invalid args: decisions is a required field"); })],
  ["transaction_entities", tool("transaction_entities", (a) => ({ items: [{ companyId: "c1", state: "completed", name: "Beta AG" }, { companyId: "c2", state: "failed" }] }),
    (raw) => { if (typeof raw?.transactionId !== "string" || !raw.transactionId) throw new Error("invalid args: transactionId is a required field"); })],
  ["telegram_send_message", tool("telegram_send_message", () => ({ ok: true }), (raw) => { if (!raw?.text) throw new Error("invalid args: text is a required field"); })],
  ["company_get", tool("company_get", (a) => ({ id: a.companyId, name: "Beta AG", city: "Herford" }))],
]);
const registry = { get: (n) => tools.get(n), list: () => [...tools.values()] };

const executions = new Map();
const store = {
  saveExecution: (e) => executions.set(e.id, structuredClone(e)),
  getState: () => ({ processedKeys: {}, mailsToday: { day: "", count: 0 }, scopeRuns: {} }),
  saveState: () => {}, pruneExecutions: () => {}, listApprovals: () => [], saveApproval: () => {}, getApproval: () => null,
};
// Stub-Modell: antwortet auf Platzhalter-Anfragen und KI-Nodes mit JSON.
const llmPrompts = [];
const providers = {
  getStatus: () => ({ ready: true }),
  getProducerModelOverride: () => undefined,
  streamChat: async function* ({ messages }) {
    const user = messages.map((m) => m.content).join("\n");
    llmPrompts.push(user);
    const antwort = /Platzhalter|placeholder/i.test(user) && /kassenbestand/.test(user)
      ? JSON.stringify({ kassenbestand: "1,2 Mio. EUR", ansprechpartner_vertrieb: null })
      : JSON.stringify({ text: "KI-Text zu " + (user.match(/zu ([^\n:]+)/)?.[1] ?? "?"), body: "ok" });
    yield { contentDelta: antwort };
    yield { done: true };
  },
};
const defs = new Map();
const frames = [];
const runner = new WorkflowRunner({
  registry, store, providers,
  getAutonomyLevel: () => "mutating",
  emit: (f) => frames.push(f),
  audit: () => {},
  getDefinition: (id) => defs.get(id) ?? null,
  gatewayRequest: async (path) => {
    const cell = (state, errorMessage) => ({ state, errorCount: state === "failed" ? 1 : 0, ...(errorMessage ? { errorMessage } : {}) });
    if (path.includes(`/transactions/${TX}/pipeline`)) return {
      transactionId: TX, totalCompanies: 2, stages: ["masterData", "structuredContent", "companyPublication", "website", "companyProfile", "companyContact", "companyEvaluation"], unavailableStages: [],
      rows: [
        // c1: Handelsregister/Jahresabschluss gescheitert, Profil aber fertig → zaehlt als fertig
        { companyId: "c1", cells: { masterData: cell("completed"), structuredContent: cell("failed", "Zeitueberschreitung: Quelle nicht erreichbar"), companyPublication: cell("failed", "Zeitueberschreitung"), website: cell("completed"), companyProfile: cell("completed"), companyContact: cell("completed"), companyEvaluation: cell("completed") } },
        // c2: Profil fehlgeschlagen
        { companyId: "c2", cells: { masterData: cell("completed"), structuredContent: cell("completed"), companyPublication: cell("completed"), website: cell("failed", "404"), companyProfile: cell("failed", "kein Inhalt"), companyContact: cell("skipped"), companyEvaluation: cell("skipped") } },
      ],
    };
    if (path.includes(`/transactions/tx_stream/pipeline`)) return globalThis.__streamPipeline;
    if (path.includes(`/transactions/tx_publikation_offen/pipeline`)) return {
      transactionId: "tx_publikation_offen", totalCompanies: 1, stages: [], unavailableStages: [],
      rows: [{ companyId: "c1", cells: { masterData: cell("completed"), structuredContent: cell("completed"), companyPublication: cell("pending"), website: cell("completed"), companyProfile: cell("completed"), companyContact: cell("completed"), companyEvaluation: cell("pending") } }],
    };
    throw new Error(`gateway 400 (${path})`);
  },
  notify: () => {},
});

let fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; console.log("  FAIL", msg); } else console.log("  ok", msg); };
const mkDef = (id, partial) => ({ id, version: 1, enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01", ...partial, settings: { ...DEFAULT_WORKFLOW_SETTINGS, ...(partial.settings ?? {}) } });

console.log("Vorlage: Radar-Import-Bericht (Prime + Sub)");
{
  const sub = mkDef("wf_sub", templateToDefinition(WORKFLOW_TEMPLATES.find((t) => t.id === "firmen-kurzprofil-telegram")));
  const prime = mkDef("wf_prime", templateToDefinition(WORKFLOW_TEMPLATES.find((t) => t.id === "radar-import-bericht"), "wf_sub"));
  // Schreib-Nodes freigeben wie im Nutzer-Test
  for (const n of prime.nodes) if (n.type === "tool") n.confirmed = true;
  for (const n of sub.nodes) if (n.type === "tool") n.confirmed = true;
  // KI-Node im Sub durch Felder-setzen ersetzen (kein Modell im Test)
  const ai = sub.nodes.find((n) => n.type === "ai");
  ai.type = "transform"; ai.parameters = { fields: { text: "Kurz: {{ $company.name ?? $json.name }}" } };
  defs.set("wf_sub", sub); defs.set("wf_prime", prime);
  const ex = await runner.run(prime, { trigger: "manual" });
  check(ex.status === "success", `Lauf-Status: ${ex.status} ${ex.error ?? ""}`);
  const runs = Object.fromEntries(Object.entries(ex.nodeRuns).map(([k, v]) => [k, v.at(-1)]));
  check(runs["Score-Filter"]?.outputItems?.[0] === 1, `Score-Filter behaelt 1 von 3 (>=80, nicht in AVA): ${JSON.stringify(runs["Score-Filter"]?.outputItems)}`);
  const decide = calls.find((c) => c.name === "discovery_decide");
  check(decide && decide.args.decisions?.[0]?.discoveryId === "disc_aaaa", `discovery_decide mit decisions-Liste: ${JSON.stringify(decide?.args)}`);
  check(runs["Auf Verarbeitung warten"]?.outputItems?.[0] === 2, `Warten liefert ein Item je Firma (2): ${JSON.stringify(runs["Auf Verarbeitung warten"]?.outputItems)}`);
  check(runs["Nur fertige"]?.outputItems?.[0] === 1, `Nur fertige (Profil completed trotz Teilfehler): 1 von 2: ${JSON.stringify(runs["Nur fertige"]?.outputItems)}`);
  const tg = calls.filter((c) => c.name === "telegram_send_message");
  check(tg.length === 1 && /Beta AG/.test(tg[0].args.text), `Sub-Workflow je fertiger Firma → 1 Telegram mit Firmenname: ${JSON.stringify(tg.map((t) => t.args.text))}`);
  check(runs["Auf Verarbeitung warten"]?.error == null, `Warten-Node ohne Fehler: ${runs["Auf Verarbeitung warten"]?.error ?? "-"}`);
}

console.log("Trockenlauf derselben Vorlage");
{
  calls.length = 0;
  const prime = defs.get("wf_prime");
  const ex = await runner.run(prime, { trigger: "test", dryRun: true });
  check(ex.status === "success", `Status: ${ex.status} ${ex.error ?? ""}`);
  check(!calls.some((c) => c.name === "discovery_decide" || c.name === "telegram_send_message"), `Schreib-Tools im Trockenlauf nicht aufgerufen: ${calls.map((c) => c.name).join(",")}`);
}

console.log("Alle Logik-Nodes");
{
  const kette = (names) => { const c = {}; for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], index: 0 }]] }; return c; };
  const nodes = [
    { name: "Start", type: "trigger", parameters: {} },
    { name: "Kandidaten", type: "tool", mode: "allItems", parameters: { tool: "discovery_candidates", args: {} } },
    { name: "Felder", type: "transform", parameters: { fields: { scoreText: "{{ $json.matchScore + ' Punkte' }}", hoch: "{{ $json.matchScore >= 80 }}" } } },
    { name: "Wenn", type: "if", parameters: { condition: "{{ $json.hoch }}" } },
    { name: "Verzweigung", type: "switch", parameters: { value: "{{ $json.name.split(' ')[1] }}", cases: [{ label: "GmbH", match: "GmbH" }, { label: "AG", match: "AG" }] } },
    { name: "Schleife", type: "loop", parameters: { batchSize: 1 } },
    { name: "Warten kurz", type: "wait", parameters: { minutes: 0 } },
    { name: "Zusammen", type: "merge", parameters: { mode: "append" } },
    { name: "Ende", type: "transform", parameters: { fields: { fertig: "{{ true }}" } } },
  ];
  const connections = {
    Start: { main: [[{ node: "Kandidaten", index: 0 }]] },
    Kandidaten: { main: [[{ node: "Felder", index: 0 }]] },
    Felder: { main: [[{ node: "Wenn", index: 0 }]] },
    Wenn: { main: [[{ node: "Verzweigung", index: 0 }], [{ node: "Zusammen", index: 1 }]] },
    Verzweigung: { main: [[{ node: "Schleife", index: 0 }], [{ node: "Schleife", index: 0 }], [{ node: "Schleife", index: 0 }]] },
    Schleife: { main: [[{ node: "Warten kurz", index: 0 }], [{ node: "Zusammen", index: 0 }]] },
    "Warten kurz": { main: [[{ node: "Schleife", index: 0 }]] },
    Zusammen: { main: [[{ node: "Ende", index: 0 }]] },
  };
  const def = mkDef("wf_logic", { name: "Logik", description: "", nodes: nodes.map((n, i) => ({ id: `n${i}`, position: [i * 200, 0], ...n })), connections, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "none" } });
  const ex = await runner.run(def, { trigger: "manual" });
  check(ex.status === "success", `Status: ${ex.status} ${ex.error ?? ""}`);
  const runs = Object.fromEntries(Object.entries(ex.nodeRuns).map(([k, v]) => [k, v.at(-1)]));
  for (const n of ["Felder", "Wenn", "Verzweigung", "Schleife", "Warten kurz", "Zusammen", "Ende"]) check(runs[n] && !runs[n].error, `Node ${n}: ${runs[n]?.error ?? "ok"} out=${JSON.stringify(runs[n]?.outputItems)}`);
  check(runs["Ende"]?.outputItems?.[0] === 3, `Ende erhaelt alle 3 Items (2 ueber Schleife, 1 ueber sonst-Zweig): ${JSON.stringify(runs["Ende"]?.outputItems)}`);
}

console.log("Stop-Node und Fehlerpfad");
{
  const def = mkDef("wf_stop", { name: "Stop", description: "", nodes: [
    { id: "n0", position: [0, 0], name: "Start", type: "trigger", parameters: {} },
    { id: "n1", position: [200, 0], name: "Abbruch", type: "stop", parameters: { message: "Gewollt: {{ $run.workflowName }}" } },
  ], connections: { Start: { main: [[{ node: "Abbruch", index: 0 }]] } }, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "none" } });
  const ex = await runner.run(def, { trigger: "manual" });
  check(ex.status === "error" && /Gewollt: Stop/.test(ex.error ?? ""), `Stop bricht mit aufgeloester Meldung ab: ${ex.error}`);
}

console.log("KI-Node, Platzhalter und Firmen-Kontext");
{
  calls.length = 0;
  const def = mkDef("wf_ai", { name: "KI", description: "", nodes: [
    { id: "n0", position: [0, 0], name: "Start", type: "trigger", parameters: {} },
    { id: "n1", position: [200, 0], name: "Kurz", type: "ai", mode: "allItems", parameters: { prompt: "Kurzuebersicht zu {{ $company.name }}: Kasse $kassenbestand ?? \"kein Kassenbestand\", Vertrieb $ansprechpartner_vertrieb ?? \"niemand bekannt\"", outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } },
    { id: "n2", position: [400, 0], name: "Senden", type: "tool", mode: "allItems", confirmed: true, parameters: { tool: "telegram_send_message", args: { text: "{{ $json.text }}" } } },
  ], connections: { Start: { main: [[{ node: "Kurz", index: 0 }]] }, Kurz: { main: [[{ node: "Senden", index: 0 }]] } }, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "company" } });
  let ohneFirma = null;
  try { await runner.run(def, { trigger: "manual" }); } catch (e) { ohneFirma = e.message; }
  check(/braucht eine Firma/.test(ohneFirma ?? ""), `Firmen-Workflow ohne Firma wird abgewiesen: ${ohneFirma}`);
  const ex = await runner.run(def, { trigger: "manual", company: { companyId: "c1" } });
  check(ex.status === "success", `Status: ${ex.status} ${ex.error ?? ""}`);
  check(ex.contextQuellen?.includes("company_get"), `Firmen-Kontext geladen aus: ${JSON.stringify(ex.contextQuellen)}`);
  const aiPrompt = llmPrompts.find((p) => /Kurzuebersicht zu/.test(p)) ?? "";
  check(/Kurzuebersicht zu Beta AG/.test(aiPrompt), `$company.name im KI-Prompt aufgeloest: ${aiPrompt.slice(-160)}`);
  check(/1,2 Mio\. EUR/.test(aiPrompt) && /niemand bekannt/.test(aiPrompt) && !/\$kassenbestand/.test(aiPrompt), `Platzhalter befuellt (Wert + Fallback): ${aiPrompt.slice(-160)}`);
  const tg = calls.find((c) => c.name === "telegram_send_message");
  check(tg && /KI-Text/.test(tg.args.text), `KI-Ausgabe erreicht den naechsten Node: ${tg?.args.text}`);
}

console.log("Fehlerpfade: kein Import, Tool-Fehler, Freigabe im Trockenlauf");
{
  tools.set("discovery_decide_leer", tool("discovery_decide_leer", () => ({ entschieden: 1, importiert: 0, ignoriert: 0, transactionId: null, ohneOrt: ["Alpha GmbH"], unbekannt: [] })));
  tools.set("kaputt_tool", tool("kaputt_tool", () => ({ error: "Import fehlgeschlagen — Entscheidungen NICHT gespeichert: 503" })));
  const mk = (id, toolName, extra = []) => mkDef(id, { name: id, description: "", nodes: [
    { id: "n0", position: [0, 0], name: "Start", type: "trigger", parameters: {} },
    { id: "n1", position: [200, 0], name: "Schritt", type: "tool", mode: "allItems", confirmed: true, parameters: { tool: toolName, args: {} } },
    ...extra,
  ], connections: { Start: { main: [[{ node: "Schritt", index: 0 }]] }, ...(extra.length ? { Schritt: { main: [[{ node: extra[0].name, index: 0 }]] } } : {}) }, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "none" } });
  const w = { id: "n2", position: [400, 0], name: "Warten", type: "wait", parameters: { transactionId: "{{ $json.transactionId }}", maxHours: 1 } };
  const ex1 = await runner.run(mk("wf_leer", "discovery_decide_leer", [w]), { trigger: "manual" });
  check(ex1.status === "error" && /kein Vorgang vorhanden/.test(ex1.error ?? "") && /Alpha GmbH/.test(ex1.error ?? ""), `Import ohne Firmen → klare Meldung mit Ursache: ${ex1.error}`);
  const ex1d = await runner.run(mk("wf_leer2", "discovery_decide_leer", [w]), { trigger: "test", dryRun: true });
  check(ex1d.status === "success" && /Trockenlauf endet hier/.test(ex1d.nodeRuns["Warten"]?.at(-1)?.error ?? ""), `Trockenlauf endet sauber am Warten-Node: ${ex1d.status} / ${ex1d.nodeRuns["Warten"]?.at(-1)?.error}`);
  const ex2 = await runner.run(mk("wf_err", "kaputt_tool"), { trigger: "manual" });
  check(ex2.status === "error" && /503/.test(ex2.error ?? ""), `Tool-Ergebnis mit error → Node-Fehler: ${ex2.error}`);
  const h = { id: "n2", position: [400, 0], name: "Freigabe", type: "human", parameters: { prompt: "{{ $input.count }} Items freigeben?" } };
  const ex3 = await runner.run(mk("wf_human", "discovery_candidates", [h]), { trigger: "test", dryRun: true });
  check(ex3.status === "success" && ex3.nodeRuns["Freigabe"]?.at(-1)?.outputItems?.[0] === 3, `Freigabe-Node im Trockenlauf reicht Items durch: ${ex3.status} ${JSON.stringify(ex3.nodeRuns["Freigabe"]?.at(-1)?.outputItems)}`);
}

console.log("Vorgangs-Bewertung (Pipeline-Matrix)");
{
  const { bewertePipeline, beschreibeBefund } = await load("../src/main/transaction-pipeline.ts");
  const cell = (state, errorMessage) => ({ state, errorCount: 0, ...(errorMessage ? { errorMessage } : {}) });
  const row = (id, sc, pub, web, prof, kon, bew) => ({ companyId: id, cells: { masterData: cell("completed"), structuredContent: cell(sc, sc === "failed" ? "Zeitueberschreitung: Dieser Schritt hat zu lange gedauert" : undefined), companyPublication: cell(pub, pub === "failed" ? "Zeitueberschreitung" : undefined), website: cell(web), companyProfile: cell(prof), companyContact: cell(kon), companyEvaluation: cell(bew) } });
  // Nutzer-Screenshot: 4 Firmen mit Register/Publikation fehlgeschlagen, Profil wartet → NICHT abgeschlossen
  const offen = bewertePipeline({ transactionId: "t", totalCompanies: 5, stages: [], rows: [row("a", "failed", "failed", "pending", "pending", "pending", "pending"), row("b", "failed", "failed", "pending", "pending", "pending", "pending"), row("c", "failed", "failed", "completed", "completed", "completed", "completed"), row("d", "failed", "failed", "pending", "pending", "pending", "pending"), row("e", "skipped", "skipped", "completed", "completed", "failed", "skipped")] });
  check(!offen.abgeschlossen && offen.profilOffen === 3 && offen.profilFertig === 2, `Teilfehler + Profil offen → Vorgang laeuft noch: abgeschlossen=${offen.abgeschlossen} offen=${offen.profilOffen} fertig=${offen.profilFertig}`);
  const fertig = bewertePipeline({ transactionId: "t", totalCompanies: 5, stages: [], rows: [row("a", "failed", "failed", "completed", "completed", "completed", "completed"), row("b", "failed", "failed", "completed", "completed", "completed", "completed"), row("c", "failed", "failed", "completed", "completed", "completed", "completed"), row("d", "failed", "failed", "completed", "completed", "completed", "completed"), row("e", "skipped", "skipped", "completed", "completed", "failed", "skipped")] });
  // uebersprungen (bereits verarbeitet) = fertig
  const skip = bewertePipeline({ transactionId: "t", totalCompanies: 1, stages: [], rows: [row("a", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped")] });
  check(skip.abgeschlossen && skip.firmen[0].state === "completed" && skip.profilFertig === 1, `uebersprungenes Profil zaehlt als fertig: ${JSON.stringify({ a: skip.abgeschlossen, s: skip.firmen[0].state })}`);
  const txt = beschreibeBefund(fertig);
  check(fertig.abgeschlossen && fertig.profilFertig === 5 && fertig.profilFehlgeschlagen === 0, `Alle Profile fertig → abgeschlossen, 5 fertig: ${JSON.stringify({ a: fertig.abgeschlossen, f: fertig.profilFertig })}`);
  check(/5 von 5 Firmenprofile fertig, Teilfehler bei Handelsregister, Jahresabschluesse/.test(txt.headline("„X“")), `Headline nennt Teilfehler statt Totalausfall: ${txt.headline("„X“")}`);
  check(txt.zeilen.some((z) => /Zeitueberschreitung/.test(z)) && txt.zeilen.some((z) => /nicht erreichbar/.test(z)), `Meldung nennt Ursache + Quellen-Hinweis: ${txt.zeilen.join(" | ")}`);
  check(txt.warnung, "Teilfehler → Warnstufe");
}

console.log("Abhaengigkeiten zur Laufzeit");
{
  llmPrompts.length = 0;
  const TX2 = "tx_publikation_offen";
  const mk = (id, nodes, connections) => mkDef(id, { name: id, description: "", nodes, connections, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "none" } });
  const ai = { id: "n2", position: [400, 0], name: "Kasse", type: "ai", mode: "allItems", parameters: { prompt: "Kurzuebersicht zu {{ $json.companyId }}: Kasse $kassenbestand ?? \"unbekannt\"", outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } };
  const nodes = [
    { id: "n0", position: [0, 0], name: "Start", type: "trigger", parameters: {} },
    { id: "n1", position: [200, 0], name: "Warten", type: "wait", parameters: { transactionId: TX2, maxHours: 0.1 } },
    ai,
  ];
  const conn = { Start: { main: [[{ node: "Warten", index: 0 }]] }, Warten: { main: [[{ node: "Kasse", index: 0 }]] } };
  // Trockenlauf: Profil fertig, Publikation offen → Warten (automatisch inkl. Jahresabschluesse) meldet "offen: Jahresabschluesse"
  const ex = await runner.run(mk("wf_dep", nodes, conn), { trigger: "test", dryRun: true });
  const hinweis = ex.nodeRuns["Warten"]?.at(-1)?.error ?? "";
  check(/offen: Jahresabschluesse/.test(hinweis), `Warten-Node wartet automatisch auf Jahresabschluesse ($kassenbestand): ${hinweis}`);
  // Nur Profil gefordert → gilt als abgeschlossen
  const nodesBis = nodes.map((n) => (n.name === "Warten" ? { ...n, parameters: { ...n.parameters, bis: ["companyProfile"] } } : n));
  const ex2 = await runner.run(mk("wf_dep2", nodesBis, conn), { trigger: "test", dryRun: true });
  const h2 = ex2.nodeRuns["Warten"]?.at(-1);
  check(!h2?.error && (h2?.hinweise ?? []).some((h) => /Gewartet auf: Firmenprofil/.test(h)), `bis=[Firmenprofil] → abgeschlossen: ${h2?.error ?? h2?.hinweise?.join("|")}`);
  // Firmen-Lauf in laufendem Vorgang: Node mit $kassenbestand wartet (Trockenlauf → Hinweis)
  const def3 = mkDef("wf_dep3", { name: "dep3", description: "", nodes: [{ id: "n0", position: [0, 0], name: "Start", type: "trigger", parameters: {} }, { ...ai, id: "n1", position: [200, 0] }], connections: { Start: { main: [[{ node: "Kasse", index: 0 }]] } }, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "company" } });
  const ex3 = await runner.run(def3, { trigger: "test", dryRun: true, company: { companyId: "c1", transactionId: TX2 } });
  const h3 = ex3.nodeRuns["Kasse"]?.at(-1)?.hinweise ?? [];
  check(ex3.status === "success" && h3.some((h) => /Jahresabschluesse noch in Verarbeitung/.test(h)), `Node mit $kassenbestand in laufendem Vorgang: ${JSON.stringify(h3)} ${ex3.error ?? ""}`);
  // Vorgang mit fertiger Publikation (TX): keine Wartezeit, Hinweis mit Abhaengigkeit
  const ex4 = await runner.run({ ...def3, id: "wf_dep4" }, { trigger: "manual", company: { companyId: "c1", transactionId: TX } });
  const h4 = ex4.nodeRuns["Kasse"]?.at(-1)?.hinweise ?? [];
  check(ex4.status === "success" && h4.some((h) => /Abhaengigkeiten: Jahresabschluesse/.test(h) && /fehlgeschlagen: Jahresabschluesse/.test(h)), `Publikation fehlgeschlagen (Endzustand) → laeuft mit Fallback: ${JSON.stringify(h4)} ${ex4.error ?? ""}`);
}

console.log("Fortsetzen nach Neustart");
{
  calls.length = 0;
  const nodes = [
    { id: "n0", position: [0, 0], name: "Start", type: "trigger", parameters: {} },
    { id: "n1", position: [200, 0], name: "Importieren", type: "transform", parameters: { fields: { transactionId: "{{ '" + TX + "' }}" } } },
    { id: "n2", position: [400, 0], name: "Warten", type: "wait", parameters: { transactionId: "{{ $json.transactionId }}", maxHours: 1 } },
    { id: "n3", position: [600, 0], name: "Nur fertige", type: "filter", parameters: { condition: "{{ $json.state === 'completed' }}" } },
    { id: "n4", position: [800, 0], name: "Senden", type: "tool", mode: "perItem", confirmed: true, parameters: { tool: "telegram_send_message", args: { text: "fertig {{ $json.companyId }} aus {{ $('Importieren').item.json.transactionId }}" } } },
  ];
  const conn = { Start: { main: [[{ node: "Importieren", index: 0 }]] }, Importieren: { main: [[{ node: "Warten", index: 0 }]] }, Warten: { main: [[{ node: "Nur fertige", index: 0 }]] }, "Nur fertige": { main: [[{ node: "Senden", index: 0 }]] } };
  const def = mkDef("wf_resume", { name: "Resume", description: "", nodes, connections: conn, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "none" } });
  // Gespeicherter Lauf, der im Warten-Node abgebrochen wurde (App beendet)
  const t = "2026-09-09T10:00:00.000Z";
  const stored = { id: "ex_resume1", workflowId: def.id, workflowName: def.name, workflowVersion: 1, trigger: "manual", dryRun: false, status: "running", startedAt: t, nodeRuns: {
    Start: [{ startedAt: t, finishedAt: t, status: "success", inputItems: 1, outputItems: [1], output: [[{ json: {}, pairedItem: { item: 0 } }]] }],
    Importieren: [{ startedAt: t, finishedAt: t, status: "success", inputItems: 1, outputItems: [1], output: [[{ json: { transactionId: TX }, pairedItem: { item: 0 } }]] }],
    Warten: [{ startedAt: t, status: "running", inputItems: 1, outputItems: [] }],
  } };
  const ex = await runner.resume(def, stored);
  check(ex.id === "ex_resume1" && ex.status === "success", `Lauf fortgesetzt und beendet: ${ex.id} ${ex.status} ${ex.error ?? ""}`);
  const runs = Object.fromEntries(Object.entries(ex.nodeRuns).map(([k, v]) => [k, v.at(-1)]));
  check(runs["Importieren"]?.finishedAt === t, "fertige Nodes liefen nicht erneut");
  check(runs["Warten"]?.status === "success" && runs["Warten"]?.outputItems?.[0] === 2, `Warten-Node neu gelaufen: ${runs["Warten"]?.status} ${JSON.stringify(runs["Warten"]?.outputItems)}`);
  const tg = calls.filter((c) => c.name === "telegram_send_message");
  check(tg.length === 1 && tg[0].args.text === `fertig c1 aus ${TX}`, `Nachfolger mit gespeicherten Vorgaenger-Ausgaben ($('Importieren')): ${JSON.stringify(tg.map((c) => c.args.text))}`);
  // Unterbrochen in einem Schreib-Node → abgebrochen mit Hinweis
  const stored2 = { ...stored, id: "ex_resume2", nodeRuns: { ...stored.nodeRuns, Warten: [{ startedAt: t, finishedAt: t, status: "success", inputItems: 1, outputItems: [2], output: [[{ json: { companyId: "c1", state: "completed", transactionId: TX } }, { json: { companyId: "c2", state: "failed" } }]] }], "Nur fertige": [{ startedAt: t, finishedAt: t, status: "success", inputItems: 2, outputItems: [1], output: [[{ json: { companyId: "c1", state: "completed" } }]] }], Senden: [{ startedAt: t, status: "running", inputItems: 1, outputItems: [] }] } };
  const ex2 = await runner.resume(def, stored2);
  check(ex2.status === "cancelled" && /Senden/.test(ex2.error ?? ""), `Unterbrochener Schreib-Node → abgebrochen mit Hinweis: ${ex2.status} ${ex2.error}`);
}

console.log("Passives Warten: Firmen einzeln weiterreichen, Lauf pausiert");
{
  calls.length = 0;
  const cell = (state) => ({ state, errorCount: 0 });
  const rowFor = (id, prof) => ({ companyId: id, cells: { masterData: cell("completed"), structuredContent: cell("completed"), companyPublication: cell("completed"), website: cell("completed"), companyProfile: cell(prof), companyContact: cell("completed"), companyEvaluation: cell("completed") } });
  globalThis.__streamPipeline = { transactionId: "tx_stream", totalCompanies: 3, stages: [], unavailableStages: [], rows: [rowFor("s1", "completed"), rowFor("s2", "pending"), rowFor("s3", "pending")] };
  const nodes = [
    { id: "n0", position: [0, 0], name: "Start", type: "trigger", parameters: {} },
    { id: "n1", position: [200, 0], name: "Importieren", type: "transform", parameters: { fields: { transactionId: "{{ 'tx_stream' }}" } } },
    { id: "n2", position: [400, 0], name: "Warten", type: "wait", parameters: { transactionId: "{{ $json.transactionId }}" } },
    { id: "n3", position: [600, 0], name: "Nur fertige", type: "filter", parameters: { condition: "{{ $json.state === 'completed' }}" } },
    { id: "n4", position: [800, 0], name: "Senden", type: "tool", mode: "perItem", confirmed: true, parameters: { tool: "telegram_send_message", args: { text: "Bericht {{ $json.companyId }} ({{ $('Importieren').item.json.transactionId }})" } } },
  ];
  const conn = { Start: { main: [[{ node: "Importieren", index: 0 }]] }, Importieren: { main: [[{ node: "Warten", index: 0 }]] }, Warten: { main: [[{ node: "Nur fertige", index: 0 }]] }, "Nur fertige": { main: [[{ node: "Senden", index: 0 }]] } };
  const def = mkDef("wf_stream", { name: "Stream", description: "", nodes, connections: conn, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "none" } });
  const ex1 = await runner.run(def, { trigger: "manual" });
  const tg1 = calls.filter((c) => c.name === "telegram_send_message").map((c) => c.args.text);
  check(ex1.status === "waiting" && !ex1.finishedAt, `Lauf pausiert mit Status wartet: ${ex1.status} ${ex1.error ?? ""}`);
  check(ex1.waiting?.weitergegeben?.length === 1 && ex1.waiting.weitergegeben[0] === "s1" && ex1.waiting.offen === 2, `1 Firma weitergegeben, 2 offen: ${JSON.stringify(ex1.waiting)}`);
  check(tg1.length === 1 && /Bericht s1 \(tx_stream\)/.test(tg1[0]), `Folge-Schritte liefen fuer s1 sofort: ${JSON.stringify(tg1)}`);
  // nichts Neues → kein Weiterlauf
  const none = await runner.continueWaiting(def, executions.get(ex1.id));
  check(none === null, "ohne neue fertige Firmen passiert nichts");
  // s2 fertig, s3 fehlgeschlagen (Endzustand) → alles abgeschlossen
  globalThis.__streamPipeline.rows = [rowFor("s1", "completed"), rowFor("s2", "completed"), rowFor("s3", "failed")];
  calls.length = 0;
  const ex2 = await runner.continueWaiting(def, executions.get(ex1.id));
  const tg2 = calls.filter((c) => c.name === "telegram_send_message").map((c) => c.args.text);
  check(ex2 && ex2.id === ex1.id && ex2.status === "success" && !ex2.waiting, `Weitergefuehrt und abgeschlossen: ${ex2?.status} ${ex2?.error ?? ""}`);
  check(tg2.length === 1 && /Bericht s2/.test(tg2[0]), `Nur s2 berichtet (s3 gescheitert, s1 nicht doppelt): ${JSON.stringify(tg2)}`);
  check((ex2?.nodeRuns["Warten"]?.length ?? 0) === 2 && (ex2?.nodeRuns["Senden"]?.length ?? 0) === 2, `Warten/Senden je 2 Durchgaenge: ${ex2?.nodeRuns["Warten"]?.length}/${ex2?.nodeRuns["Senden"]?.length}`);
  // Abbrechen waehrend des Wartens
  globalThis.__streamPipeline.rows = [rowFor("s1", "completed"), rowFor("s2", "pending"), rowFor("s3", "pending")];
  const ex3 = await runner.run({ ...def, id: "wf_stream2" }, { trigger: "manual" });
  const c3 = runner.cancelWaiting(executions.get(ex3.id));
  check(ex3.status === "waiting" && c3.status === "cancelled", `Wartenden Lauf abbrechen: ${c3.status}`);
}

console.log("Leere Eingabe: Tool-/KI-/Warten-Node ueberspringen statt Fehler");
{
  calls.length = 0;
  const nodes = [
    { id: "n0", position: [0, 0], name: "Start", type: "trigger", parameters: {} },
    { id: "n1", position: [200, 0], name: "Kandidaten", type: "tool", mode: "allItems", parameters: { tool: "discovery_candidates", args: {} } },
    { id: "n2", position: [400, 0], name: "Nie", type: "filter", parameters: { condition: "{{ $json.matchScore > 1000 }}" } },
    { id: "n3", position: [600, 0], name: "Import starten", type: "tool", mode: "allItems", confirmed: true, parameters: { tool: "discovery_decide", args: { decisions: "{{ $input.all().map(i => ({ discoveryId: i.json.discoveryId, decision: 'imported' })) }}" } } },
    { id: "n4", position: [800, 0], name: "Warten", type: "wait", parameters: { transactionId: "{{ $json.transactionId }}" } },
    { id: "n5", position: [1000, 0], name: "KI", type: "ai", mode: "allItems", parameters: { prompt: "x", outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } },
    { id: "n6", position: [1200, 0], name: "Senden", type: "tool", mode: "perItem", confirmed: true, parameters: { tool: "telegram_send_message", args: { text: "{{ $json.text }}" } } },
  ];
  const conn = {}; for (let i = 0; i < nodes.length - 1; i++) conn[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, index: 0 }]] };
  const def = mkDef("wf_leer_eingabe", { name: "leer", description: "", nodes, connections: conn, trigger: { kind: "manual" }, variables: {}, origin: { kind: "manual" }, settings: { scope: "none" } });
  const ex = await runner.run(def, { trigger: "manual" });
  check(ex.status === "success", `Lauf endet erfolgreich mit 0 Firmen: ${ex.status} ${ex.error ?? ""}`);
  check(!calls.some((c) => c.name === "discovery_decide" || c.name === "telegram_send_message"), `Import/Telegram nicht aufgerufen: ${calls.map((c) => c.name).join(",")}`);
  check((ex.nodeRuns["Import starten"]?.at(-1)?.hinweise ?? []).some((h) => /Keine Eingabe-Items/.test(h)), `Hinweis am uebersprungenen Node: ${JSON.stringify(ex.nodeRuns["Import starten"]?.at(-1)?.hinweise)}`);
}

if (fails > 0) { console.log(`\n${fails} Fehler`); process.exit(1); }
console.log("\nEngine-Tests ok");
