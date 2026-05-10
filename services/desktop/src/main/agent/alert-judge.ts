import * as yup from "yup";
import type { LlmProviderManager } from "./providers";
import type { Judge, JudgeVerdict, HeartbeatCandidate } from "./heartbeat";
import type { AgentMessage } from "../../shared/types";

// LLM-driven alert judge (Phase 8.f2).
//
// Replaces the always-alert stub. Each candidate gets one LLM call with a
// tight, German system prompt that:
//   - Embeds today's date so "alt" vs. "neu" is unambiguous.
//   - Enumerates the alert-worthiness criteria from §8.f.
//   - Forbids JSON keys other than the schema below (loose JSON survives;
//     extra prose around the JSON is tolerated and stripped).
//
// Output is yup-validated. Any failure → `worthAlerting: false` so a
// flaky tick can't poison the alerts file with garbage rows. Cost guard
// is up to the heartbeat (caps candidates per tick); this module just
// runs one judgment.
//
// Why a separate prompt and not a chat-tool: the chat orchestrator drives
// a ReAct loop with tool-calling, big context, and the long company-link
// formatting rules. None of that applies here — we want a one-shot,
// deterministic, JSON-only response. Re-using the chat system prompt
// would 5x the token spend and invite the agent to call tools mid-judge.

const VerdictSchema = yup
  .object({
    worthAlerting: yup.boolean().required(),
    severity: yup
      .string()
      .oneOf(["info", "warn", "urgent"] as const)
      .nullable()
      .defined(),
    headline: yup.string().nullable().defined(),
    // Rationale is required in BOTH branches so the diagnostic log can
    // show the user why a candidate was dropped.
    rationale: yup.string().required(),
  })
  .strict()
  .noUnknown();

export interface BuildJudgeOptions {
  /** Lets the heartbeat short-circuit when no provider is ready. */
  isProviderReady: () => boolean;
  /** Wall-clock injection for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Construct a `Judge` bound to a provider manager. The judge throws
 * `JudgeProviderUnavailable` when no provider is ready — the heartbeat
 * catches that and skips the tick instead of marking every candidate
 * as "not worth alerting" (which would burn the dedup slots).
 */
export function buildLlmAlertJudge(
  providers: LlmProviderManager,
  options: BuildJudgeOptions,
): Judge {
  return async (candidate, ctxNow) => {
    if (!options.isProviderReady()) {
      throw new JudgeProviderUnavailable();
    }
    const today = (options.now ?? (() => ctxNow))();
    const stamp = today.getTime();
    const messages: AgentMessage[] = [
      {
        id: `alert-judge-system-${candidate.sourceRef}`,
        role: "system",
        content: buildSystemPrompt(today),
        createdAt: stamp,
      },
      {
        id: `alert-judge-user-${candidate.sourceRef}`,
        role: "user",
        content: buildUserPrompt(candidate),
        createdAt: stamp,
      },
    ];

    const text = await streamToText(providers, messages);
    const parsed = parseJsonObject(text);
    if (!parsed) {
      console.warn(
        `[alert-judge] no JSON object in LLM response for ${candidate.sourceRef}`,
      );
      return notWorthAlerting(
        "Antwort des Modells enthielt kein gültiges JSON-Objekt.",
      );
    }

    let validated: yup.InferType<typeof VerdictSchema>;
    try {
      validated = await VerdictSchema.validate(parsed, {
        strict: true,
        abortEarly: false,
        stripUnknown: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[alert-judge] yup validation failed for ${candidate.sourceRef}: ${msg}`,
      );
      return notWorthAlerting(
        `JSON-Antwort widerspricht dem Schema: ${msg.slice(0, 200)}`,
      );
    }

    const rationale = validated.rationale.trim();
    if (!validated.worthAlerting) {
      // Carry the LLM's German "warum nicht?" through to the heartbeat
      // decision log so the Settings panel can show transparency
      // ("Bericht von 2011, älter als 4 Jahre" etc.).
      return notWorthAlerting(rationale || "Vom Modell nicht begründet.");
    }

    // worthAlerting=true REQUIRES severity + headline. If either is
    // missing / empty, we downgrade to "not worth alerting" rather than
    // letting an empty headline through to the UI.
    const severity = validated.severity;
    const headline = validated.headline?.trim() ?? "";
    if (!severity || !headline) {
      console.warn(
        `[alert-judge] worthAlerting=true but missing severity/headline for ${candidate.sourceRef}`,
      );
      return notWorthAlerting(
        rationale ||
          "Modell meldete worthAlerting=true ohne severity/headline.",
      );
    }

    return {
      worthAlerting: true,
      severity,
      headline,
      rationale,
    } satisfies JudgeVerdict;
  };
}

export class JudgeProviderUnavailable extends Error {
  constructor() {
    super("alert judge requires a ready LLM provider");
    this.name = "JudgeProviderUnavailable";
  }
}

// ---- Prompts --------------------------------------------------------------

function buildSystemPrompt(today: Date): string {
  const todayIso = today.toISOString().slice(0, 10);
  return [
    "Du bist die Alarm-Bewertungsstufe von AVA, einer Recherche-App für",
    "deutsche Unternehmen.",
    `Heute ist ${todayIso}.`,
    "",
    "Aufgabe: Entscheide, ob der folgende Datenpunkt eine Benachrichtigung",
    "an die Analystin rechtfertigt.",
    "",
    "Alarmwürdig ist ein Punkt nur, wenn BEIDES gilt:",
    "  (a) Aktualitätsregel — kontextabhängig:",
    "      - Jahresabschlüsse / offizielle Bundesanzeiger-Publikationen:",
    "        bis zu 4 Jahre alt sind okay. Hintergrund: deutsche Firmen",
    "        veröffentlichen ihren Abschluss oft erst 2-4 Jahre nach",
    "        Bilanzstichtag. Ein Geschäftsjahr 2022 ist im Mai 2026 also",
    "        immer noch das aktuellste, was öffentlich verfügbar sein kann.",
    "        Nur Berichte 5 Jahre und älter gelten als zu alt.",
    "      - Press / Web-Signale, Stellenanzeigen, C-Level-Wechsel,",
    "        Insolvenzen: maximal 12 Monate alt. Hier kommt es auf",
    "        zeitliche Nähe wirklich an.",
    "  (b) Er weist auf eine relevante Geschäftsentwicklung hin:",
    "      - Expansion / neue Standorte / Übernahmen / Verkäufe",
    "      - Umsatz- oder operative Ergebnis-Veränderung ≥ 15 % YoY",
    "      - Insolvenz / Restrukturierung / Rechtsstreit",
    "      - Wechsel auf C-Level (Geschäftsführung, Vorstand)",
    "      - Auffallender Presse-Zyklus (>3 Publikationen in 30 Tagen)",
    "",
    "Nicht alarmwürdig sind:",
    "  - Routine-HRB-Updates ohne inhaltliche Folgen",
    "  - Marketing- und PR-Selbstdarstellung",
    "  - Firmenjubiläen, Sponsoring, Stellenanzeigen",
    "  - Jahresabschlüsse 5 Jahre und älter (zu alt)",
    "  - Press / Web-Signale älter als 12 Monate",
    "",
    "Severity:",
    "  - info   = nennenswert, aber nicht eilig",
    "  - warn   = sollte zeitnah beachtet werden (Delta 15–29 %, kleinere Restrukturierung)",
    "  - urgent = sofortige Aufmerksamkeit (Delta ≥ 30 %, Insolvenz, C-Level-Wechsel)",
    "",
    "Antworte NUR mit einem einzigen JSON-Objekt nach diesem Schema:",
    "  {",
    '    "worthAlerting": boolean,',
    '    "severity": "info" | "warn" | "urgent" | null,',
    '    "headline": string | null,    // max. 120 Zeichen, Deutsch',
    '    "rationale": string             // max. 500 Zeichen, Deutsch, sachlich',
    "  }",
    "",
    "Regeln für das JSON:",
    "  - Wenn worthAlerting=true, MÜSSEN severity und headline gesetzt sein.",
    "  - Wenn worthAlerting=false, setze severity und headline auf null.",
    "  - rationale MUSS in BEIDEN Fällen gesetzt sein. Bei worthAlerting=false",
    "    erkläre kurz, WARUM der Datenpunkt nicht alarmwürdig ist",
    "    (z. B. 'Jahresabschluss 2019, älter als 5 Jahre' oder",
    "    'Reine Marketing-Meldung ohne Geschäftssubstanz'). Diese",
    "    Begründung wird der Analystin im Diagnostik-Log gezeigt.",
    "  - Keine zusätzlichen Felder. Keine Markdown-Codeblöcke.",
    "  - Keine Begrüßung, kein Kommentar, kein Fließtext um das JSON herum.",
  ].join("\n");
}

function buildUserPrompt(c: HeartbeatCandidate): string {
  return [
    `Kandidat (kind=${c.kind}):`,
    `  Firma:        ${c.companyName} (id: ${c.companyId})`,
    `  Datum:        ${c.occurredAt}`,
    `  Zusammenfassung: ${c.summary}`,
    `  Rohdaten:     ${JSON.stringify(c.payload)}`,
    "",
    "Bewerte diesen Kandidaten gemäß System-Prompt.",
  ].join("\n");
}

// ---- LLM consumption ------------------------------------------------------

async function streamToText(
  providers: LlmProviderManager,
  messages: AgentMessage[],
): Promise<string> {
  const ctrl = new AbortController();
  // Hard ceiling so a runaway model can't wedge a tick. 30 s is generous
  // enough for slow Ollama on a cold machine but tight enough that a
  // wedged provider doesn't hold up the next tick.
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  let buf = "";
  try {
    const stream = providers.streamChat({
      messages,
      signal: ctrl.signal,
    });
    for await (const frame of stream) {
      if (frame.contentDelta) buf += frame.contentDelta;
      if (frame.done) break;
      if (frame.errorMessage) {
        throw new Error(frame.errorMessage);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  return buf;
}

/**
 * Pull the first balanced `{...}` chunk out of an arbitrary string. The
 * model is instructed to return JSON-only, but small models occasionally
 * wrap it in prose or a fenced ```json block. We tolerate both.
 *
 * Returns the parsed object or `null` if no valid JSON object was found.
 */
function parseJsonObject(text: string): unknown {
  if (!text) return null;
  // Strip Markdown fences if present.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/i;
  const m = fenceRe.exec(text);
  const candidate = m ? m[1]! : text;

  // Try whole string first.
  try {
    const parsed = JSON.parse(candidate.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to substring scan.
  }
  // Scan for the first balanced object.
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function notWorthAlerting(rationale = ""): JudgeVerdict {
  // Severity + headline aren't shown when worthAlerting=false; we pick
  // safe defaults so the type stays sound. `rationale` IS surfaced in
  // the heartbeat decision log so the analyst sees why the LLM passed.
  return {
    worthAlerting: false,
    severity: "info",
    headline: "",
    rationale,
  };
}
