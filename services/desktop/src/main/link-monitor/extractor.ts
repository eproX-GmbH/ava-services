// LM3 — Extractor: rohen Seitentext → strukturierte Beobachtungen.
//
// Aus dem Browse-Ergebnis (sichtbarer Text) destilliert ein LLM-Call
// gemäß den Nutzer-Anweisungen eine kompakte, vergleichsstabile Liste
// von Beobachtungen. Diese Liste ist die Diff-Basis: zwei Durchläufe
// werden über ihre Beobachtungen verglichen, nicht über rohes HTML
// (das sich bei jedem Aufruf durch Tracking-IDs etc. ändert).
//
// Zusätzlich wird ein Inhalts-Hash über den Rohtext gebildet — der
// dient als Schnellpfad „nichts hat sich geändert" ohne LLM.

import { createHash } from "node:crypto";
import * as yup from "yup";
import type { LlmProviderManager } from "../agent/providers";
import type { BrowseResult } from "./browser";
import { buildMessages, parseJsonObject, streamToText } from "./llm";

/** Strukturierte Beobachtungen eines Durchlaufs. Bewusst schlank +
 *  textuell, damit der Diff robust gegen Layout-Rauschen ist. */
export interface LinkObservations {
  /** Deutsche Ein-Zeilen-Zusammenfassung des aktuellen Seitenzustands. */
  summary: string;
  /** Salient, vergleichsstabile Fakten (eine Zeile je Eintrag), z. B.
   *  "Produkt 'Acme X' — verfügbar" oder "Stellenanzeige: Senior Dev". */
  items: string[];
}

const ObsSchema = yup
  .object({
    summary: yup.string().defined(),
    items: yup.array().of(yup.string().defined()).defined(),
  })
  .strict()
  .noUnknown();

const MAX_ITEMS = 60;

export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ExtractInput {
  providers: LlmProviderManager;
  url: string;
  instructions: string;
  browse: BrowseResult;
  signal?: AbortSignal;
}

export interface ExtractResult {
  observations: LinkObservations;
  contentHash: string;
}

/**
 * Extrahiert Beobachtungen aus dem Browse-Ergebnis. Fällt nie hart aus:
 * ohne LLM oder bei Parser-Fehlern wird ein Fallback-Snapshot aus dem
 * Rohtext gebaut (gekürzte Zeilen), sodass der Diff trotzdem etwas zum
 * Vergleichen hat.
 */
export async function extractObservations(
  input: ExtractInput,
): Promise<ExtractResult> {
  const { providers, url, instructions, browse } = input;
  const contentHash = hashContent(browse.text);

  if (!providers.getStatus().ready || !browse.text.trim()) {
    return { observations: fallbackObservations(browse), contentHash };
  }

  const system = buildExtractSystemPrompt(instructions);
  const user = buildExtractUserPrompt(url, browse);
  let raw = "";
  try {
    raw = await streamToText(
      providers,
      buildMessages(system, user, "extract"),
      { signal: input.signal, timeoutMs: 45_000 },
    );
  } catch {
    return { observations: fallbackObservations(browse), contentHash };
  }
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return { observations: fallbackObservations(browse), contentHash };
  }
  try {
    const validated = await ObsSchema.validate(parsed, {
      strict: true,
      stripUnknown: false,
    });
    return {
      observations: {
        summary: (validated.summary ?? "").slice(0, 280),
        items: (validated.items ?? [])
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, MAX_ITEMS),
      },
      contentHash,
    };
  } catch {
    return { observations: fallbackObservations(browse), contentHash };
  }
}

/** Ohne LLM: erste sinnvolle Textzeilen als Beobachtungen. */
function fallbackObservations(browse: BrowseResult): LinkObservations {
  const lines = browse.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 3)
    .slice(0, MAX_ITEMS);
  return {
    summary: (browse.title || browse.finalUrl).slice(0, 280),
    items: lines,
  };
}

function buildExtractSystemPrompt(instructions: string): string {
  const focus = instructions.trim()
    ? `Der Nutzer achtet besonders auf:\n  ${instructions.trim()}`
    : "Der Nutzer hat keine spezielle Anweisung gegeben — erfasse die inhaltlich wesentlichen, wiederkehrend prüfbaren Fakten der Seite.";
  return [
    "Du extrahierst aus dem sichtbaren Text einer Webseite eine kompakte,",
    "vergleichsstabile Liste von Beobachtungen. Diese Liste wird beim",
    "nächsten Aufruf erneut erstellt und verglichen, um ÄNDERUNGEN zu",
    "erkennen.",
    "",
    focus,
    "",
    "Antworte NUR mit einem JSON-Objekt:",
    "  {",
    '    "summary": string,   // 1 Satz Deutsch, Zustand der Seite jetzt',
    '    "items": string[]    // je Eintrag EIN konkreter, stabiler Fakt',
    "  }",
    "",
    "Regeln:",
    "  - items sind kurze, eigenständige Fakten (z. B. ein Produkt + sein",
    "    Status, eine Stellenanzeige, ein Preis, ein Datum). Formuliere sie",
    "    so, dass derselbe Fakt beim nächsten Mal IDENTISCH formuliert wird.",
    "  - KEINE flüchtigen Werte (Session-IDs, Zeitstempel 'vor 2 Min',",
    "    Cookie-Banner, Werbung, Navigationsmenüs).",
    "  - Wenn der Nutzer eine Anweisung gab, priorisiere passende Fakten.",
    "  - Maximal 60 items. Keine Markdown-Codeblöcke, kein Text um das JSON.",
  ].join("\n");
}

function buildExtractUserPrompt(url: string, browse: BrowseResult): string {
  return [
    `URL: ${url}`,
    `Titel: ${browse.title || "—"}`,
    browse.pagesVisited > 1
      ? `(Inhalt aus ${browse.pagesVisited} Seiten/Pagination aggregiert)`
      : "",
    "",
    "Sichtbarer Seitentext:",
    "<<<",
    browse.text,
    ">>>",
  ]
    .filter(Boolean)
    .join("\n");
}
