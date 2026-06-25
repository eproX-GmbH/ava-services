// LM3 — Diff: erkennt eine relevante Änderung zwischen zwei Durchläufen.
//
// Vergleicht die Beobachtungen des vorherigen mit denen des aktuellen
// Durchlaufs. Drei Stufen:
//   1. Kein Vorlauf → Baseline, keine Änderung (nur speichern).
//   2. Inhalts-Hash identisch → garantiert keine Änderung (kein LLM).
//   3. Sonst → LLM-Semantik-Diff, geführt durch die Nutzer-Anweisung.
//      Liefert bool + deutsche Ein-Zeilen-Zusammenfassung der Änderung.
//
// Ohne LLM fällt Stufe 3 auf einen einfachen Mengen-Diff der items
// zurück (neue/entfallene Einträge), damit auch offline etwas erkannt
// wird.

import * as yup from "yup";
import type { LlmProviderManager } from "../agent/providers";
import type { LinkObservations } from "./extractor";
import { buildMessages, parseJsonObject, streamToText } from "./llm";

const DiffSchema = yup
  .object({
    changed: yup.boolean().required(),
    summary: yup.string().nullable().defined(),
  })
  .strict()
  .noUnknown();

export interface DiffInput {
  providers: LlmProviderManager;
  instructions: string;
  previous: LinkObservations | null;
  previousHash: string | null;
  current: LinkObservations;
  currentHash: string;
  signal?: AbortSignal;
}

export interface DiffResult {
  changed: boolean;
  /** Deutsche Ein-Zeilen-Zusammenfassung; nur gesetzt wenn changed. */
  summary: string | null;
}

export async function detectChange(input: DiffInput): Promise<DiffResult> {
  const { providers, previous, previousHash, current, currentHash } = input;

  // Stufe 1 — erste Beobachtung: Baseline, keine Änderung.
  if (!previous) return { changed: false, summary: null };

  // Stufe 2 — Hash identisch: garantiert keine Änderung.
  if (previousHash && previousHash === currentHash) {
    return { changed: false, summary: null };
  }

  // Stufe 3 — LLM-Semantik-Diff.
  if (!providers.getStatus().ready) {
    return naiveDiff(previous, current);
  }

  const system = buildDiffSystemPrompt(input.instructions);
  const user = buildDiffUserPrompt(previous, current);
  let raw = "";
  try {
    raw = await streamToText(providers, buildMessages(system, user, "diff"), {
      signal: input.signal,
      timeoutMs: 45_000,
    });
  } catch {
    return naiveDiff(previous, current);
  }
  const parsed = parseJsonObject(raw);
  if (!parsed) return naiveDiff(previous, current);
  try {
    const v = await DiffSchema.validate(parsed, {
      strict: true,
      stripUnknown: false,
    });
    if (!v.changed) return { changed: false, summary: null };
    const summary = (v.summary ?? "").trim();
    return {
      changed: true,
      summary: summary ? summary.slice(0, 280) : "Inhalt hat sich geändert.",
    };
  } catch {
    return naiveDiff(previous, current);
  }
}

/** Offline-Fallback: reiner Mengen-Diff der items. Eine Änderung gilt,
 *  wenn Einträge hinzugekommen oder entfallen sind. */
function naiveDiff(
  previous: LinkObservations,
  current: LinkObservations,
): DiffResult {
  const prev = new Set(previous.items.map(norm));
  const curr = new Set(current.items.map(norm));
  const added = current.items.filter((i) => !prev.has(norm(i)));
  const removed = previous.items.filter((i) => !curr.has(norm(i)));
  if (added.length === 0 && removed.length === 0) {
    return { changed: false, summary: null };
  }
  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} neu (z. B. „${added[0]}")`);
  if (removed.length) parts.push(`${removed.length} entfallen`);
  return { changed: true, summary: parts.join(", ").slice(0, 280) };
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildDiffSystemPrompt(instructions: string): string {
  const focus = instructions.trim()
    ? `Relevant ist für den Nutzer besonders:\n  ${instructions.trim()}`
    : "Es gibt keine spezielle Anweisung — werte jede inhaltlich bedeutsame Änderung als relevant.";
  return [
    "Du vergleichst zwei Zustände derselben Webseite (vorher/jetzt) und",
    "entscheidest, ob eine für den Nutzer RELEVANTE Änderung vorliegt.",
    "",
    focus,
    "",
    "Antworte NUR mit einem JSON-Objekt:",
    "  {",
    '    "changed": boolean,',
    '    "summary": string|null   // wenn changed: 1 Satz Deutsch, WAS sich',
    "                             // änderte (z. B. \"Produkt X ist jetzt",
    '                             // verfügbar"). Sonst null.',
    "  }",
    "",
    "Regeln:",
    "  - changed=true NUR bei inhaltlich bedeutsamer Änderung (neuer/",
    "    entfallener Eintrag, geänderter Status/Preis/Verfügbarkeit, neuer",
    "    Inhalt). Reine Reihenfolge, Formatierung, Zähler oder Werbung",
    "    sind KEINE Änderung.",
    "  - summary ist konkret und nennt das Wesentliche, nicht „etwas hat",
    "    sich geändert“.",
    "  - Keine Markdown-Codeblöcke, kein Text um das JSON.",
  ].join("\n");
}

function buildDiffUserPrompt(
  previous: LinkObservations,
  current: LinkObservations,
): string {
  return [
    "VORHER:",
    `  Zusammenfassung: ${previous.summary}`,
    "  Einträge:",
    ...previous.items.map((i) => `    - ${i}`),
    "",
    "JETZT:",
    `  Zusammenfassung: ${current.summary}`,
    "  Einträge:",
    ...current.items.map((i) => `    - ${i}`),
    "",
    "Liegt eine relevante Änderung vor?",
  ].join("\n");
}
