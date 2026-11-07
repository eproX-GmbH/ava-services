// L0 (docs/PLAN_LOESUNGSKARTEN.md): Groesse des statischen Systemprompts je Abschnitt.
// Aufruf: ../../node_modules/.bin/tsx scripts/prompt-groesse.mts
// Ohne Profil, Gedaechtnis, ICP und Werkzeugliste; die vollen Werte je Lauf stehen
// als "[kontext]" im Protokoll der App.
import * as P0 from "../src/main/agent/prompts.ts";
import * as M0 from "../src/main/agent/kontext-messung.ts";

const P = ((P0 as any).buildSystemPrompt ? P0 : (P0 as any).default) as typeof import("../src/main/agent/prompts.ts");
const M = ((M0 as any).promptAbschnitte ? M0 : (M0 as any).default) as typeof import("../src/main/agent/kontext-messung.ts");
const leer = { list: () => [] } as unknown as Parameters<typeof P.buildSystemPrompt>[0];
const text = P.buildSystemPrompt(leer, null, { skills: [], activeSkill: null, rememberedFacts: [], availableToolNames: new Set() } as never);
console.log(`Systemprompt (statisch): ${text.length} Zeichen, etwa ${M.tok(text.length)} Tokens\n`);
for (const [name, n] of M.promptAbschnitte(text)) console.log(String(n).padStart(6), " ", name);
