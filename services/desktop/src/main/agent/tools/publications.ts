import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import type { Tool } from "../types";
import {
  buildMessages,
  parseJsonObject,
  streamToText,
} from "../../link-monitor/llm";

// v0.1.427 — PB3: Chat-Suche ueber die zentral gespeicherten
// Publikations-Bloecke (Jahresabschluss-Volltext).
//
// Ablauf von publication_search:
//   1. ZERLEGUNG — ein kleiner LLM-Aufruf macht aus der Nutzerfrage 3-5
//      konkrete deutsche Suchqueries ("Geht's der Firma gut?" →
//      "Umsatzentwicklung", "Jahresfehlbetrag", "Fortfuehrungsprognose",
//      "Risikobericht"). Faellt bei Fehlern auf die Rohfrage zurueck.
//   2. BM25 ZENTRAL — das Gateway sucht per deutschem Volltext ueber alle
//      gespeicherten Bloecke der Firma und liefert Kandidaten samt ihrer
//      beim Ingest berechneten Embeddings.
//   3. RERANK LOKAL — Queries werden lokal eingebettet (embeddinggemma via
//      Ollama), Kandidaten per Kosinus + RRF fusioniert. Ohne lokalen
//      Embedder gilt die BM25-Reihenfolge.
//
// Damit zahlt niemand mehr fuer die Voranalyse aller >1.000 Bloecke —
// der relevante Kontext wird on-the-fly geholt (Lazy-RAG-Plan).

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

interface SearchCandidate {
  runId: string;
  ordinal: number;
  year: number | null;
  docName: string | null;
  type: string;
  text: string;
  truncated: boolean;
  bm25Ranks: (number | null)[];
  embedding: number[] | null;
}

export interface PublicationToolDeps {
  gateway: GatewayClient;
  providers: LlmProviderManager;
}

/** Nutzerfrage → 3-5 konkrete Suchqueries (LLM, validiert, mit Fallback). */
async function decomposeQuestion(
  providers: LlmProviderManager,
  companyName: string | undefined,
  question: string,
): Promise<string[]> {
  const fallback = [question.slice(0, 200)];
  if (!providers.getStatus().ready) return fallback;
  try {
    const system =
      "Du hilfst bei einer Volltext-Suche ueber deutsche Jahresabschluesse " +
      "(Bundesanzeiger: Bilanz, GuV, Anhang, Lagebericht). Zerlege die " +
      "Frage des Nutzers in 3 bis 5 kurze, konkrete deutsche Suchanfragen " +
      "(je 2-6 Woerter), wie sie woertlich in solchen Dokumenten stehen " +
      "koennten — Fachbegriffe bevorzugen (z. B. Umsatzerloese, " +
      "Jahresueberschuss, Eigenkapitalquote, Fortfuehrungsprognose, " +
      "Risikobericht, Mitarbeiterzahl). KEINEN Firmennamen in die Queries " +
      'aufnehmen. Antworte NUR als JSON: {"queries": ["...", "..."]}';
    const user = companyName
      ? `Firma: ${companyName}\nFrage: ${question}`
      : `Frage: ${question}`;
    const raw = await streamToText(
      providers,
      buildMessages(system, user, "pubsearch"),
      { timeoutMs: 25_000 },
    );
    const parsed = parseJsonObject(raw) as { queries?: unknown } | null;
    if (parsed && Array.isArray(parsed.queries)) {
      const qs = parsed.queries
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter((q) => q.length >= 2 && q.length <= 200)
        .slice(0, 5);
      if (qs.length > 0) return qs;
    }
  } catch (err) {
    console.warn("[publications] Query-Zerlegung fehlgeschlagen:", err);
  }
  return fallback;
}

/** Queries lokal einbetten. null, wenn Ollama/Modell nicht verfuegbar. */
async function embedQueries(queries: string[]): Promise<number[][] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embeddinggemma:latest", input: queries }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { embeddings?: number[][] };
    return Array.isArray(json.embeddings) ? json.embeddings : null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function buildPublicationTools(deps: PublicationToolDeps): Tool[] {
  const { gateway, providers } = deps;

  const search = defineTool({
    name: "publication_search",
    description:
      "Semantische Volltext-Suche ueber die gespeicherten Jahresabschluss-" +
      "Bloecke (Bundesanzeiger) einer Firma: Bilanzposten, GuV, Anhang, " +
      "Lagebericht, Prognosen, Risiken. Nutze dieses Tool fuer JEDE " +
      "Detailfrage zu Jahresabschluessen/Publikationen (Zahlen, Trends, " +
      "wirtschaftliche Lage), bevor du sagst, dass Daten fehlen. Die Frage " +
      "wird automatisch in mehrere Suchanfragen zerlegt und hybrid " +
      "(BM25 + Vektor) gesucht. companyId wie von company_search geliefert.",
    parameters: {
      type: "object",
      required: ["companyId", "question"],
      properties: {
        companyId: { type: "string" },
        question: {
          type: "string",
          description:
            "Die inhaltliche Frage (z. B. 'Wie hat sich der Umsatz entwickelt und wie ist der Ausblick?').",
        },
        companyName: {
          type: "string",
          description: "Optional, verbessert die Query-Zerlegung.",
        },
        topK: {
          type: "integer",
          description: "Wie viele Treffer (Default 10, max 20).",
        },
      },
    },
    schema: yup.object({
      companyId: yup.string().trim().min(1).required(),
      question: yup.string().trim().min(3).max(500).required(),
      companyName: yup.string().trim().max(200).optional(),
      topK: yup.number().integer().min(3).max(20).optional(),
    }),
    run: async (args) => {
      const topK = args.topK ?? 10;
      const queries = await decomposeQuestion(
        providers,
        args.companyName,
        args.question,
      );

      const { candidates } = await gateway.request<{
        candidates: SearchCandidate[];
      }>(`/v1/companies/${encodeURIComponent(args.companyId)}/publication-blocks/search`, {
        method: "POST",
        body: { queries, perQuery: 30 },
      });

      if (candidates.length === 0) {
        return {
          queries,
          hits: [],
          note:
            "Keine gespeicherten Publikations-Bloecke gefunden. Die Firma " +
            "wurde evtl. noch nicht (neu) verarbeitet — Bloecke entstehen " +
            "seit v0.1.426 bei jeder Publikations-Verarbeitung.",
        };
      }

      // Rerank: RRF ueber BM25-Raenge + Kosinus zur besten Query.
      const queryVecs = await embedQueries(queries);
      const scored = candidates.map((cand) => {
        let rrf = 0;
        for (const r of cand.bm25Ranks) {
          if (r !== null) rrf += 1 / (60 + r);
        }
        let cos = 0;
        if (queryVecs && cand.embedding) {
          for (const qv of queryVecs) {
            const cv = cosine(qv, cand.embedding);
            if (cv > cos) cos = cv;
          }
        }
        // Gewichtung: BM25 traegt Praezision (exakte Begriffe/Zahlen),
        // der Vektor Umschreibungen. Ohne Embeddings zaehlt nur RRF.
        const score = queryVecs ? 0.5 * rrf * 20 + 0.5 * cos : rrf * 20;
        return { cand, score, cos };
      });
      scored.sort((a, b) => b.score - a.score);

      return {
        queries,
        reranked: queryVecs !== null,
        hits: scored.slice(0, topK).map(({ cand, score }) => ({
          year: cand.year,
          document: cand.docName,
          type: cand.type,
          score: Number(score.toFixed(4)),
          text: cand.text.length > 1500 ? `${cand.text.slice(0, 1500)}…` : cand.text,
          truncated: cand.truncated || cand.text.length > 1500,
        })),
      };
    },
    preview: (r) =>
      r.hits.length === 0
        ? "Publikations-Suche: keine Treffer"
        : `Publikations-Suche: ${r.hits.length} Treffer (${r.queries.length} Queries${r.reranked ? ", reranked" : ""})`,
  });

  return [search];
}
