// Schreibt den LLM-Modellkatalog (@ava/ai-provider) als TypeScript-Datei in
// den Gateway, der ihn unter GET /v1/modelle ausliefert (Web-Konsole,
// docs/PLAN_ADMIN_WEB.md §3.3). Nach jeder Katalogänderung ausführen:
//   pnpm -F @ava/ai-provider build && node scripts/modell-katalog-export.mjs
// Liest die gebaute Fassung (CommonJS); tsx scheitert unter Node 24 an der Interop.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { listCatalog } = createRequire(import.meta.url)("../packages/ai-provider/dist/catalog.js");

const eintraege = listCatalog({ role: "llm", toolsOnly: true }).map((e) => ({
  provider: e.provider,
  id: e.id,
  label: e.label,
  tools: e.capabilities.tools,
  vision: e.capabilities.vision,
  contextWindow: e.capabilities.contextWindow,
  costClass: e.costClass,
  recommended: e.recommended ?? false,
  tier: e.tier,
}));

const ziel = new URL("../services/db-gateway/src/lib/modell-katalog.generated.ts", import.meta.url);
writeFileSync(
  ziel,
  `// ERZEUGT von scripts/modell-katalog-export.mjs — nicht von Hand ändern.\n` +
    `// Quelle: packages/ai-provider/src/catalog.ts (role llm, nur mit Werkzeugen).\n\n` +
    `export interface ModellKatalogEintrag {\n  provider: string;\n  id: string;\n  label: string;\n  tools: boolean;\n  vision: boolean;\n  contextWindow: number;\n  costClass: "free" | "cheap" | "mid" | "high";\n  recommended: boolean;\n  tier: 1 | 2 | 3 | 4;\n}\n\n` +
    `export const MODELL_KATALOG: readonly ModellKatalogEintrag[] = ${JSON.stringify(eintraege, null, 2)};\n`,
);
console.log(`${eintraege.length} Modelle → ${ziel.pathname}`);
