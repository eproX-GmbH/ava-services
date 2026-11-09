// Dauer-Erlaubnisse (docs/PLAN_ERLAUBNISSE.md): „Immer erlauben“ im Dialog,
// Loeschendes mit Hinweis, Speicher, Widerruf, Klartext-Titel.
//   ../../node_modules/.bin/tsx scripts/test-erlaubnisse.mts
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AVA_DATA_DIR = mkdtempSync(join(tmpdir(), "ava-erlaubnisse-"));
const load = async (p: string) => { const m: any = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const { UiBridge } = await load("../src/main/agent/ui-bridge.ts");
const { dauerErlaubnis, IMMER_ERLAUBEN } = await load("../src/main/agent/dauer-erlaubnis.ts");
const { werkzeugTitel } = await load("../src/shared/werkzeug-titel.ts");

let fails = 0;
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(`${ok ? "  ok" : "  FAIL"} ${msg}`); };

// Rueckfrage-Kanal wie Telegram: merkt sich die Optionen, antwortet vorgegeben.
let gesehen: Array<{ value: string; label: string }> = [];
let antwort = IMMER_ERLAUBEN;
const fragen = { n: 0 };
const remoteAsk = { askChoice: async (_p: string, o: Array<{ value: string; label: string }>) => { fragen.n++; gesehen = o; return antwort; }, askText: async () => "" };
const bruecke = (werkzeug: string | undefined) => new UiBridge({ emit: () => {}, pending: new Map(), audit: () => {}, werkzeug }, "r1", "c1", true, remoteAsk, "none");
const sig = new AbortController().signal;
const frage = (kind: string) => ({ kind, prompt: "Entwurf an a@b.de ablegen?\nBetreff: Hallo", confirmValue: "ja", options: [{ value: "ja", label: "Ablegen" }, { value: "nein", label: "Abbrechen" }] });

const v1 = await bruecke("mail_entwurf_ablegen").confirmAction(frage("additive"), sig);
check(gesehen.map((o) => o.value).join(",") === `ja,${IMMER_ERLAUBEN},nein`, `„Immer erlauben“ steht direkt hinter der Zustimmung: ${gesehen.map((o) => o.label).join(" / ")}`);
check(v1 === "ja" && dauerErlaubnis.hat("mail_entwurf_ablegen"), "„Immer erlauben“ bestätigt und speichert");
const vorher = fragen.n;
await bruecke("mail_entwurf_ablegen").confirmAction(frage("additive"), sig);
check(fragen.n === vorher, "zweiter Aufruf fragt nicht mehr");
check(dauerErlaubnis.liste()[0]?.beispiel === "Entwurf an a@b.de ablegen?", `Beispiel = erste Zeile der Rückfrage: ${dauerErlaubnis.liste()[0]?.beispiel}`);

await bruecke("crm_delete_contact").confirmAction(frage("destructive"), sig);
check(gesehen.some((o) => /löscht künftig ohne Rückfrage/.test(o.label)), "Löschen: „Immer erlauben“ mit Warnhinweis");
check(dauerErlaubnis.liste().find((e: any) => e.werkzeug === "crm_delete_contact")?.loeschend === true, "Löschen wird als löschend gespeichert");

antwort = "ja";
await bruecke(undefined).confirmAction(frage("additive"), sig);
check(!gesehen.some((o) => o.value === IMMER_ERLAUBEN), "ohne Werkzeug (Mail-Triage, MCP) kein „Immer erlauben“");

check(dauerErlaubnis.widerrufen("mail_entwurf_ablegen") && !dauerErlaubnis.hat("mail_entwurf_ablegen"), "Widerruf einzeln");
const n = fragen.n;
await bruecke("mail_entwurf_ablegen").confirmAction(frage("additive"), sig);
check(fragen.n === n + 1, "nach Widerruf wird wieder gefragt");
check(dauerErlaubnis.alleWiderrufen() === 1 && dauerErlaubnis.liste().length === 0, "Alle zurücknehmen");

check(werkzeugTitel("mail_entwuerfe_ablegen") === "Mail-Entwürfe ablegen" && werkzeugTitel("crm_delete_contact") === "CRM-Einträge löschen" && werkzeugTitel("mcp_close_create_lead") === "Close: Create lead", "Klartext-Titel");

if (fails > 0) { console.log(`\n${fails} Fehler`); process.exit(1); }
console.log("\nErlaubnisse ok");
