// LinkedIn signal-strength calibration worker (v0.1.345).
//
// Turns the user's raw per-signal 👍/👎 feedback into ONE compact,
// size-capped calibration note — the only thing that ever reaches the
// scoring prompt. Raw votes accumulate unbounded in the DB; this worker
// MERGES new votes into the existing note (never re-reads full history)
// and the LLM is told to consolidate + drop stale rules, so the note
// stays bounded forever.
//
// Trigger: debounced. Every vote calls `scheduleDistillation()`; after a
// short quiet window the worker folds ALL pending votes in one LLM call,
// so a burst of clicks costs one pass, not N. A manual `distillNow()`
// backs the "Jetzt aus Feedback lernen" button. Single-flight guarded.

import * as yup from "yup";
import { getDb } from "./db";
import {
  countUnsynthesizedFeedback,
  markFeedbackSynthesized,
  nextUnsynthesizedFeedback,
  type UnsynthesizedFeedback,
} from "./db";
import {
  CALIBRATION_NOTE_CAP,
  readCalibration,
  writeCalibration,
} from "./calibration-store";
import { runActiveLlm } from "./extractor";

const DEBOUNCE_MS = 75_000; // quiet window before a background distill
const BATCH = 30; // max votes folded per pass

let debounceTimer: NodeJS.Timeout | null = null;
let running = false;

export interface CalibrationStatus {
  note: string;
  updatedAt: string | null;
  pending: number;
  running: boolean;
}

export async function calibrationStatus(): Promise<CalibrationStatus> {
  const stored = readCalibration();
  let pending = 0;
  try {
    pending = await countUnsynthesizedFeedback(await getDb());
  } catch {
    /* db not ready */
  }
  return {
    note: stored.note,
    updatedAt: stored.updatedAt,
    pending,
    running,
  };
}

/** Called after every vote. Coalesces a burst of votes into one pass. */
export function scheduleDistillation(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runDistillation().catch((err) => {
      console.warn(
        "[linkedin/calibration] scheduled distill failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }, DEBOUNCE_MS);
  if (typeof debounceTimer.unref === "function") debounceTimer.unref();
}

/** Manual "learn now" — runs immediately (still single-flight guarded). */
export async function distillNow(): Promise<CalibrationStatus> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  await runDistillation();
  return calibrationStatus();
}

const OUTPUT_SCHEMA = yup
  .object({ note: yup.string().default("") })
  .noUnknown();

async function runDistillation(): Promise<void> {
  if (running) return;
  running = true;
  const abort = new AbortController();
  try {
    const db = await getDb();
    const votes = await nextUnsynthesizedFeedback(db, BATCH);
    if (votes.length === 0) return;

    const current = readCalibration().note;
    const raw = await runActiveLlm(
      SYNTH_SYSTEM_PROMPT,
      buildSynthUserPrompt(current, votes),
      abort.signal,
    );
    if (raw == null) {
      // No LLM configured/ready — leave votes pending; a later pass (or
      // the provider-ready re-arm) picks them up. Do NOT mark synthesized.
      console.info(
        "[linkedin/calibration] no LLM ready — deferring distillation",
      );
      return;
    }

    const json = extractJsonObject(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      console.warn("[linkedin/calibration] LLM output not JSON; skipping");
      return;
    }
    const validated = (await OUTPUT_SCHEMA.validate(parsed, {
      stripUnknown: true,
    })) as { note: string };

    const note = (validated.note ?? "").trim().slice(0, CALIBRATION_NOTE_CAP);
    // Persist even an empty note (the model may have decided nothing is
    // worth keeping) — that's a valid "no calibration" state.
    writeCalibration(note);
    await markFeedbackSynthesized(
      db,
      votes.map((v) => v.postUrn),
    );
    console.info(
      `[linkedin/calibration] folded ${votes.length} vote(s) → note ${note.length} chars`,
    );
  } finally {
    running = false;
  }
}

const SYNTH_SYSTEM_PROMPT = `Du pflegst eine KOMPAKTE Kalibrierungs-Notiz, die AVA hilft, die
Signalstärke (1–5) von LinkedIn-Beiträgen besser an die persönlichen
Vorlieben EINES B2B-Vertrieblers anzupassen.

Du bekommst die AKTUELLE Notiz und eine Liste neuer 👍/👎-Bewertungen
(mit Kontext: war die Stärke laut Nutzer zu hoch/zu niedrig, Beitragsart,
Themen, optionaler Freitext-Kommentar). Falte die neue Evidenz in die
Notiz ein:
  - konsolidiere und verallgemeinere zu konkreten Stärke-Regeln,
  - streiche veraltete oder widersprochene Regeln,
  - behalte nur die stärksten, wiederkehrenden Muster.

Format der Notiz: max. 8 sehr kurze Stichpunkte, INSGESAMT max. 700
Zeichen, deutsch. Beispiele für gute Regeln:
  - "Generische Hiring-Posts ohne Entscheider-Bezug → eher Stärke 1–2."
  - "Werksbesuche/Investitionen bei Wettbewerbern → Stärke 5."
  - "Award-/Jubiläums-Posts interessieren den Nutzer nicht (niedrig)."

Antworte NUR mit einem JSON-Objekt: {"note": "<die-aktualisierte-Notiz>"}.
Keine Begrüßung, keine Erklärung, keine Markdown-Codeblöcke. Wenn die
neue Evidenz nichts Belastbares hergibt, gib die bisherige Notiz
unverändert zurück (oder "" wenn sie leer war).`;

function buildSynthUserPrompt(
  current: string,
  votes: UnsynthesizedFeedback[],
): string {
  const lines: string[] = [];
  lines.push("AKTUELLE NOTIZ:");
  lines.push(current.trim() ? current.trim() : "(leer)");
  lines.push("");
  lines.push(`NEUE BEWERTUNGEN (${votes.length}):`);
  for (const v of votes) {
    const parts: string[] = [];
    parts.push(v.vote === "up" ? "👍 passte" : "👎 passte NICHT");
    if (v.strengthAtVote != null) parts.push(`Stärke war ${v.strengthAtVote}`);
    if (v.direction === "too_high") parts.push("Nutzer: zu hoch");
    if (v.direction === "too_low") parts.push("Nutzer: zu niedrig");
    if (v.signalKind) parts.push(`Art: ${v.signalKind}`);
    if (v.matchedInterests.length > 0)
      parts.push(`Interessen-Treffer: ${v.matchedInterests.join(", ")}`);
    if (v.topics.length > 0) parts.push(`Themen: ${v.topics.join(", ")}`);
    let line = `- ${parts.join("; ")}`;
    if (v.summary) line += `\n  Beitrag: ${v.summary}`;
    if (v.comment) line += `\n  Kommentar des Nutzers: "${v.comment}"`;
    lines.push(line);
  }
  return lines.join("\n");
}

/** Same defensive JSON-extraction as the signal extractor. */
function extractJsonObject(rawText: string): string {
  let s = rawText.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}
