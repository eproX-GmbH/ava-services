// Inner runner (tsx) — W1 Workflows: Expressions, Trace-Compiler,
// Struktur-Validierung. Die Engine selbst haengt an Electron (UiBridge)
// und wird hier nicht instanziiert.

// tsx liefert die TS-Module hier als CJS; Named-Imports scheitern am
// CJS-Lexer fuer einige Dateien — daher ueber default/Namespace laden.
const load = async (p) => {
  const m = await import(p);
  return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m;
};
const { evaluate, resolveValue, referencedNodeNames } = await load("../src/main/workflows/expressions.ts");
const { compileConversation } = await load("../src/main/workflows/compiler.ts");
const { validateDefinition, parseDefinition } = await load("../src/main/workflows/store.ts");
const { resultToItems } = await load("../src/main/workflows/runner-items.ts");

const failures = [];
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    console.log(`  FAIL ${msg}`);
    failures.push(msg);
  }
}
function throws(fn, msg) {
  try {
    fn();
    assert(false, `${msg} (kein Fehler)`);
  } catch {
    assert(true, msg);
  }
}

const ctx = {
  json: { name: "Aumann Beelen GmbH", matchScore: 83, finanzen: { kassenbestand: 250000 }, tags: ["a", "b"] },
  itemIndex: 0,
  inputItems: [{ json: { name: "A", matchScore: 83 } }, { json: { name: "B", matchScore: 12 } }],
  nodeOutput: (n) => (n === "Kandidaten" ? [{ json: { discoveryId: "aumann.com", stadt: "Beelen" } }] : undefined),
  pairedIndex: () => 0,
  vars: { mindestScore: 80 },
  run: { index: 0, executionId: "ex_1", workflowName: "Test", dryRun: false },
};

console.log("Expressions");
assert(evaluate("$json.matchScore >= $vars.mindestScore", ctx) === true, "Vergleich mit $vars");
assert(evaluate("$json.finanzen.kassenbestand > 100000 && $json.name.includes('GmbH')", ctx) === true, "verschachtelt + String-Methode");
assert(evaluate("$('Kandidaten').item.json.discoveryId", ctx) === "aumann.com", "$('Node').item.json");
assert(evaluate("$input.all().filter(i => i.json.matchScore >= 80).length", ctx) === 1, "Pfeilfunktion in filter");
assert(evaluate("$input.count", ctx) === 2, "$input.count");
assert(evaluate("$json.tags.map(t => t.toUpperCase()).join(',')", ctx) === "A,B", "map + join");
assert(evaluate("$json.fehlt ?? 'leer'", ctx) === "leer", "??-Operator");
assert(evaluate("$json.matchScore > 50 ? 'heiss' : 'kalt'", ctx) === "heiss", "Ternaer");
assert(typeof evaluate("$now", ctx) === "string", "$now");
assert(resolveValue("Hallo {{ $json.name }}, Score {{ $json.matchScore }}", ctx) === "Hallo Aumann Beelen GmbH, Score 83", "Interpolation");
assert(resolveValue("{{ $json.finanzen }}", ctx).kassenbestand === 250000, "reine Expression liefert Objekt");
assert(resolveValue({ to: ["{{ $json.name }}"], n: 1 }, ctx).to[0] === "Aumann Beelen GmbH", "rekursiv in Objekten");
throws(() => evaluate("$json.constructor.constructor('return 1')()", ctx), "Prototyp-Zugriff verboten");
throws(() => evaluate("process.exit(1)", ctx), "unbekannter Bezeichner verboten");
throws(() => evaluate("$json.name = 'x'", ctx), "Zuweisung verboten");
assert(referencedNodeNames({ a: "{{ $('Kandidaten').item.json.x }}", b: ["{{ $('Mail').first() }}"] }).sort().join(",") === "Kandidaten,Mail", "referencedNodeNames");

console.log("Platzhalter");
const { findPlaceholders, applyPlaceholders } = await load("../src/main/workflows/placeholders.ts");
const refs = findPlaceholders({ text: 'Kasse: $kassenbestand ?? "kein Kassenbestand bekannt", AP: $ansprechpartner_vertrieb', cond: "{{ $umsatz > 1000000 && $json.x }}", n: 1 });
assert(refs.map((r) => r.name).sort().join(",") === "ansprechpartner_vertrieb,kassenbestand,umsatz", `Platzhalter erkannt (${refs.map((r) => r.name).join(",")})`);
assert(refs.find((r) => r.name === "kassenbestand").fallback === "kein Kassenbestand bekannt", "Fallback geparst");
assert(refs.every((r) => r.name !== "json"), "$json ist kein Platzhalter");
const hw = [];
const applied = applyPlaceholders({ text: 'Kasse: $kassenbestand ?? "kein Kassenbestand bekannt", AP: $ansprechpartner_vertrieb', cond: "{{ $umsatz > 1000000 && $json.x }}" }, { kassenbestand: null, ansprechpartner_vertrieb: "Jonas Bölter", umsatz: 2500000 }, hw);
assert(applied.text === "Kasse: kein Kassenbestand bekannt, AP: Jonas Bölter", `Fallback + Text eingesetzt (${applied.text})`);
assert(applied.cond === "{{ 2500000 > 1000000 && $json.x }}", `in Expression als Literal (${applied.cond})`);
assert(hw.length === 0, "kein Hinweis, wenn Fallback greift");
const hw2 = [];
applyPlaceholders("$fehlt", {}, hw2);
assert(hw2.length === 1, "Hinweis bei fehlendem Wert ohne Fallback");

console.log("resultToItems");
assert(resultToItems({ items: [{ id: 1 }, { id: 2 }] }, undefined, 0).length === 2, "Listen-Schluessel items");
assert(resultToItems({ ok: true, transactionId: "t1" }, undefined, 3)[0].json.transactionId === "t1", "Objekt → ein Item");
assert(resultToItems({ data: { rows: [{ a: 1 }] } }, "data.rows", 0).length === 1, "outputPath");

console.log("Compiler");
const messages = [
  { id: "m1", role: "user", content: "welche ansprechpartner bei aumann?", createdAt: 1 },
  { id: "m2", role: "assistant", content: "", createdAt: 2, toolCalls: [{ id: "c0", name: "tool_load", args: { names: ["x"] } }] },
  { id: "m3", role: "tool", content: JSON.stringify({ loaded: 1 }), toolCallId: "c0", createdAt: 3 },
  { id: "m4", role: "assistant", content: "", createdAt: 4, toolCalls: [{ id: "c1", name: "crm_search_hubspot_companies", args: { query: "Aumann Beelen" } }] },
  { id: "m5", role: "tool", content: JSON.stringify({ items: [{ id: "8626", name: "Aumann Beelen GmbH", domain: "aumann.com" }] }), toolCallId: "c1", createdAt: 5 },
  { id: "m6", role: "assistant", content: "", createdAt: 6, toolCalls: [{ id: "c2", name: "crm_list_hubspot_associations", args: { fromObjectType: "companies", fromObjectId: "8626", toObjectType: "contacts" } }] },
  { id: "m7", role: "tool", content: JSON.stringify({ associations: [{ toObjectId: "111" }, { toObjectId: "222" }] }), toolCallId: "c2", createdAt: 7 },
  { id: "m8", role: "assistant", content: "", createdAt: 8, toolCalls: [{ id: "c3", name: "crm_introspect_hubspot_contact", args: { objectId: "111" } }] },
  { id: "m9", role: "tool", content: JSON.stringify({ properties: { firstname: "Jonas" } }), toolCallId: "c3", createdAt: 9 },
  { id: "m10", role: "assistant", content: "", createdAt: 10, toolCalls: [{ id: "c4", name: "crm_introspect_hubspot_contact", args: { objectId: "222" } }] },
  { id: "m11", role: "tool", content: JSON.stringify({ properties: { firstname: "Christian" } }), toolCallId: "c4", createdAt: 11 },
];
const draft = compileConversation(messages, { toolAllowed: () => true });
assert(draft.nodes.length === 4, `Start + 3 Tool-Nodes (${draft.nodes.length})`);
assert(draft.nodes.every((n) => n.type !== "tool" || n.parameters.tool !== "tool_load"), "Meta-Tool ausgelassen");
const assoc = draft.nodes.find((n) => n.parameters.tool === "crm_list_hubspot_associations");
assert(typeof assoc.parameters.args.fromObjectId === "string" && assoc.parameters.args.fromObjectId.includes("$('"), "ID aus Vorgaenger-Ergebnis → Expression");
const intro = draft.nodes.find((n) => n.parameters.tool === "crm_introspect_hubspot_contact");
assert(intro.mode === "perItem", "wiederholte Aufrufe zu einem perItem-Node gefaltet");
assert(String(intro.parameters.args.objectId).includes("$('"), "variierendes Argument → Expression auf Vorgaenger");
assert(Object.keys(draft.connections).length === 3, "lineare Kanten");

console.log("Schema");
const basis = {
  id: "wf_s", name: "S", description: "", version: 1, enabled: true, createdAt: "x", updatedAt: "x", createdBy: "agent",
  origin: { kind: "chat" }, variables: {}, connections: {},
  nodes: [{ id: "n0", name: "Start", type: "trigger", position: [0, 0], parameters: {} }],
};
let schemaOk = true;
try { parseDefinition({ ...basis, trigger: { kind: "manual" } }); } catch (e) { schemaOk = false; console.log("   ", e.message); }
assert(schemaOk, "manueller Trigger ohne companySource/filter validiert (Regression v0.1.595)");
schemaOk = true;
try { parseDefinition({ ...basis, trigger: { kind: "schedule", at: "07:00", weekdays: [1, 2] } }); } catch (e) { schemaOk = false; console.log("   ", e.message); }
assert(schemaOk, "Zeitplan ohne companySource validiert");
schemaOk = true;
try { parseDefinition({ ...basis, trigger: { kind: "event", event: "radar.newHot" } }); } catch (e) { schemaOk = false; console.log("   ", e.message); }
assert(schemaOk, "Ereignis-Trigger ohne filter validiert");
let schemaFehler = false;
try { parseDefinition({ ...basis, trigger: { kind: "schedule", companySource: { minScore: 80 } } }); } catch { schemaFehler = true; }
assert(schemaFehler, "companySource ohne kind wird abgelehnt");

console.log("Normalisierung (Trigger/Variablen)");
const { normalizeTrigger, normalizeVariables } = await load("../src/main/workflows/store.ts");
{
  const a = normalizeTrigger(undefined); if (a.trigger.kind !== "manual") throw new Error("trigger undefined → manual");
  const b = normalizeTrigger({}); if (b.trigger.kind !== "manual" || !b.hinweis) throw new Error("trigger {} → manual + Hinweis");
  const c = normalizeTrigger({ type: "schedule", at: "07:00" }); if (c.trigger.kind !== "schedule" || c.trigger.at !== "07:00" || "type" in c.trigger) throw new Error("type-Alias");
  const d = normalizeTrigger({ event: "radar.newHot" }); if (d.trigger.kind !== "event") throw new Error("event ohne kind");
  const e = normalizeTrigger("manuell"); if (e.trigger.kind !== "manual") throw new Error("string manuell");
  const v = normalizeVariables({ mindestScore: 90, name: { value: "x" }, voll: { label: "L", type: "number", value: 1 } });
  if (v.mindestScore.type !== "number" || v.mindestScore.value !== 90 || v.mindestScore.label !== "mindestScore") throw new Error("Skalar-Variable");
  if (v.name.type !== "string" || v.name.label !== "name") throw new Error("{value}-Variable");
  if (v.voll.label !== "L") throw new Error("volle Variable unveraendert");
  parseDefinition({ ...basis, trigger: normalizeTrigger({ type: "manual" }).trigger, variables: v });
  console.log("  ok");
}

console.log("Abhaengigkeiten");
{
  const { nodeRequirements, waitStages, dependencyProblems, stagesForPlaceholder } = await load("../src/shared/workflow-dependencies.ts");
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  eq(stagesForPlaceholder("kassenbestand"), ["companyPublication"], "kassenbestand");
  eq(stagesForPlaceholder("umsatz_letztes_jahr"), ["companyPublication"], "umsatz");
  eq(stagesForPlaceholder("geschaeftsfuehrer"), ["structuredContent"], "gf");
  eq(stagesForPlaceholder("ansprechpartner_vertrieb"), ["companyContact"], "ansprechpartner");
  eq(stagesForPlaceholder("branche"), ["companyProfile"], "unbekannt → Profil");
  const ai = { name: "Mail", type: "ai", parameters: { prompt: "Kasse: $kassenbestand ?? \"unbekannt\"; GF {{ $company.register.legalForm }}" } };
  eq(nodeRequirements(ai).map((r) => r.stage).sort(), ["companyPublication", "structuredContent"], "Node-Anforderungen");
  eq(nodeRequirements({ ...ai, dependsOn: ["website"] }).map((r) => r.stage).sort(), ["companyPublication", "structuredContent", "website"], "dependsOn ergaenzt");
  eq(nodeRequirements({ name: "x", type: "filter", parameters: { condition: "{{ $json.a > 1 }}" } }), [], "keine Anforderung");
  const def = { ...basis, nodes: [
    { id: "n0", name: "Start", type: "trigger", position: [0, 0], parameters: {} },
    { id: "n1", name: "Warten", type: "wait", position: [1, 0], parameters: { transactionId: "{{ $json.transactionId }}" } },
    { id: "n2", name: "Bericht", type: "subworkflow", position: [2, 0], parameters: { workflowId: "sub1" } },
  ], connections: { Start: { main: [[{ node: "Warten", index: 0 }]] }, Warten: { main: [[{ node: "Bericht", index: 0 }]] } } };
  const sub1 = { ...basis, id: "sub1", name: "Sub", nodes: [{ id: "s0", name: "Start", type: "trigger", position: [0, 0], parameters: {} }, ai], connections: {} };
  const w = waitStages(def, def.nodes[1], (id) => (id === "sub1" ? sub1 : null));
  eq(w.stufen.sort(), ["companyProfile", "companyPublication", "structuredContent"], "Warten automatisch inkl. Sub-Workflow");
  if (!w.automatisch) throw new Error("automatisch erwartet");
  const defBis = { ...def, nodes: def.nodes.map((n) => (n.name === "Warten" ? { ...n, parameters: { ...n.parameters, bis: ["companyProfile"] } } : n)) };
  const probs = dependencyProblems(defBis, (id) => (id === "sub1" ? sub1 : null));
  if (probs.length !== 1 || !/Jahresabschluesse/.test(probs[0].message)) throw new Error("Validierungs-Hinweis erwartet: " + JSON.stringify(probs));
  if (dependencyProblems(def, (id) => (id === "sub1" ? sub1 : null)).length !== 0) throw new Error("automatisch → kein Hinweis");
  console.log("  ok");
}

console.log("Validierung");
const def = {
  id: "wf_1", name: "T", description: "", version: 1, enabled: true, createdAt: "x", updatedAt: "x", createdBy: "user",
  origin: { kind: "manual" }, variables: {}, trigger: { kind: "manual" },
  settings: { executionOrder: "v1", timeoutMinutes: 60, maxItemsPerRun: 500, autonomy: "inherit", maxMailsPerDay: 20, notifyOnFinish: true },
  nodes: [
    { id: "n0", name: "Start", type: "trigger", position: [0, 0], parameters: {} },
    { id: "n1", name: "Scan", type: "tool", position: [1, 0], parameters: { tool: "discovery_candidates", args: {} } },
    { id: "n2", name: "Filter", type: "filter", position: [2, 0], parameters: { condition: "{{ $('Scan').item.json.x }}" } },
  ],
  connections: { Start: { main: [[{ node: "Scan", index: 0 }]] }, Scan: { main: [[{ node: "Filter", index: 0 }]] } },
};
assert(validateDefinition(def, () => true).length === 0, "gueltige Definition ohne Probleme");
assert(validateDefinition({ ...def, connections: { ...def.connections, Filter: { main: [[{ node: "Scan", index: 0 }]] } } }, () => true).some((p) => p.message.includes("Zyklus")), "Zyklus ohne Loop erkannt");
assert(validateDefinition(def, (t) => t !== "discovery_candidates").some((p) => p.message.includes("nicht verfuegbar")), "unbekanntes Tool gemeldet");
assert(validateDefinition({ ...def, nodes: [...def.nodes, { id: "n3", name: "X", type: "filter", position: [3, 0], parameters: { condition: "{{ $('Gibtsnicht').item }}" } }] }, () => true).some((p) => p.message.includes("unbekannten Node")), "Expression auf unbekannten Node gemeldet");

if (failures.length > 0) {
  console.error(`\n${failures.length} Fehler`);
  process.exit(1);
}
console.log("\nalle Tests ok");
