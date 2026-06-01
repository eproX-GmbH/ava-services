// LinkedIn-Beobachter Phase L4 — vision-LLM image analysis worker.
//
// Sequentially walks the linkedin_image_analysis queue and asks the
// user's configured vision-capable LLM for a structured JSON payload
// (description, visible_text, detected_logos, detected_products,
// environment). Output is validated with yup before landing in the DB.
//
// Same single-flight + sequential pattern as the L3 text extractor.
// Cancellation via the same module-scoped AbortController plumbing
// owned by extractor.ts; this file exposes only `drainImageQueue` and
// the status helpers — extractor.ts is the single drain entry point.
//
// TODO L7: parallelism for cloud tiers if rate-limit allows.

import { generateText } from "ai";
import { nativeImage } from "electron";
import { hasVision, tierForModel } from "@ava/ai-provider";
import {
  resolveActiveLlm as resolveSharedLlm,
  buildLinkedInModel,
  type ResolvedLlm,
} from "./llm";
import * as yup from "yup";
import {
  getDb,
  imageAnalysisCounts,
  nextPendingImageAnalyses,
  recordImageAnalysisFailure,
  recordImageAnalysisSkipped,
  recordImageAnalysisSuccess,
  resetSkippedImageAnalysesToPending,
  type ImageAnalysisCandidate,
  type ImageAnalysisPayload,
} from "./db";
import { read as readSettings } from "./store";
import type { LlmProviderManager } from "../agent/providers";
import type { ProviderConfigStore } from "../agent/providers/store";

export interface ImageAnalysisStatus {
  running: boolean;
  pending: number;
  analyzed: number;
  failed: number;
  skipped: number;
  lastRunAt: number | null;
  lastError: string | null;
}

let providersRef: LlmProviderManager | null = null;
let storeRef: ProviderConfigStore | null = null;

let lastRunAt: number | null = null;
let lastError: string | null = null;

/** Called from extractor.ts on attachProviders so this module sees the
 *  same active LLM the text extractor does. */
export function attachImageProviders(
  providers: LlmProviderManager,
  store: ProviderConfigStore,
): void {
  providersRef = providers;
  storeRef = store;
}

export function getImageLastRunAt(): number | null {
  return lastRunAt;
}
export function getImageLastError(): string | null {
  return lastError;
}

export async function imageStatusSnapshot(
  running: boolean,
): Promise<ImageAnalysisStatus> {
  try {
    const db = await getDb();
    const counts = await imageAnalysisCounts(db);
    return {
      running,
      pending: counts.pending,
      analyzed: counts.analyzed,
      failed: counts.failed,
      skipped: counts.skipped,
      lastRunAt,
      lastError,
    };
  } catch (err) {
    return {
      running,
      pending: 0,
      analyzed: 0,
      failed: 0,
      skipped: 0,
      lastRunAt,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

// v0.1.357 — delegiert an den gemeinsamen Resolver (extractor + image-
// extractor teilen sich jetzt llm.ts), damit BEIDE Abo-Pfade (Claude +
// ChatGPT) UND API-Keys greifen. Vorher kannte dieser Resolver nur den
// API-Key-Pfad → „No LLM defined" für alle Abo-Nutzer bei der Bildanalyse.
async function resolveActiveLlm(): Promise<ResolvedLlm | null> {
  if (!providersRef || !storeRef) return null;
  return resolveSharedLlm(providersRef, storeRef);
}

const ENVIRONMENT_VALUES = [
  "factory",
  "office",
  "trade_show",
  "conference",
  "outdoor",
  "studio",
  "other",
  "unknown",
] as const;

const IMAGE_SCHEMA = yup
  .object({
    description: yup.string().min(60).max(500).required(),
    visible_text: yup.string().max(2000).default(""),
    detected_logos: yup.array().of(yup.string().max(120)).default([]),
    detected_products: yup.array().of(yup.string().max(160)).default([]),
    environment: yup.string().oneOf(ENVIRONMENT_VALUES).required(),
  })
  .strict()
  .noUnknown();

const SYSTEM_PROMPT = `Du bist die Bildanalyse von AVA, einer Recherche-App für deutsche
B2B-Vertriebler. Aufgabe: Werte ein Bild aus einem LinkedIn-Beitrag aus
und liefere maschinenlesbare Hinweise für die Frage "Wann wen
kontaktieren?".

Antworte NUR mit einem einzigen JSON-Objekt nach diesem Schema:
  {
    "description":       string,           // 1 Absatz, deutsch, 80-300 Zeichen
    "visible_text":      string,           // Sichtbarer Text (Schilder, Folien, Untertitel). Leerer String wenn keiner.
    "detected_logos":    string[],         // Sichtbar erkennbare Markenlogos. Leeres Array wenn keine.
    "detected_products": string[],         // Sichtbare Produkte oder Maschinen mit Hersteller, falls erkennbar.
    "environment":       "factory" | "office" | "trade_show" | "conference"
                       | "outdoor" | "studio" | "other" | "unknown"
  }

Regeln:
- Erfinde KEINE Logos oder Produkte, die im Bild nicht sichtbar sind.
  Wenn unsicher, lass das Array leer.
- description: keine Spekulation, kein Marketing-Geschwurbel; nur was
  sichtbar ist und für B2B-Vertrieb relevant sein könnte.
- visible_text: WORTGETREU übernehmen, soweit lesbar; nicht zusammenfassen.
- environment="unknown" ist erlaubt und besser als geraten.
- Verwende KEINE Geviertstriche (—). Nutze Komma, Doppelpunkt, Punkt
  oder Klammern.
- Keine zusätzlichen Felder. Keine Markdown-Codeblöcke.`;

const PER_POST_IMAGE_CAP = 5;
const MAX_DATA_URL_BYTES = 1_000_000;

interface PreprocessedImage {
  dataUrl: string;
  mediaType: string;
}

/** Resize the image with Electron's nativeImage. Tries 768 max edge,
 *  falls back to 512 if the encoded data URL is over 1 MB. Returns null
 *  when even 512 isn't small enough. */
function preprocessImage(absolutePath: string): PreprocessedImage | null {
  try {
    const img = nativeImage.createFromPath(absolutePath);
    if (img.isEmpty()) return null;
    for (const edge of [768, 512]) {
      const resized = img.resize({ width: edge, height: edge, quality: "good" });
      const dataUrl = resized.toDataURL();
      if (dataUrl.length <= MAX_DATA_URL_BYTES) {
        return { dataUrl, mediaType: "image/png" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const m = /^data:[^;]+;base64,(.*)$/.exec(dataUrl);
  if (!m || !m[1]) return null;
  try {
    return Buffer.from(m[1], "base64");
  } catch {
    return null;
  }
}

function buildUserText(postUrn: string): string {
  return `Bild aus dem LinkedIn-Beitrag ${postUrn}`;
}

function extractJsonObject(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

async function callVisionLlm(
  llm: ResolvedLlm,
  postUrn: string,
  image: PreprocessedImage,
  signal: AbortSignal,
): Promise<string> {
  const model = buildLinkedInModel(llm);
  // The AI SDK's `generateText` accepts a `messages` array with image
  // parts. Anthropic + Google + OpenAI + Mistral all accept the
  // canonical `{ type: "image", image: <Buffer | dataUrl> }` part shape;
  // Ollama via `ollama-ai-provider-v2` likewise.
  const buf = dataUrlToBuffer(image.dataUrl);
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    abortSignal: signal,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildUserText(postUrn) },
          // Pass a Buffer when we have one (more compact); otherwise the
          // data URL string. Both are accepted by the SDK.
          { type: "image", image: buf ?? image.dataUrl },
        ],
      },
    ],
  });
  return result.text ?? "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Drain the image-analysis queue. Idempotent: callers (extractor.ts
 *  phase 2) wrap this in the shared single-flight flag. */
export async function drainImageQueue(opts: {
  limit: number;
  signal: AbortSignal;
}): Promise<void> {
  const { limit, signal } = opts;
  const settings = readSettings();
  const db = await getDb();

  // Off-state: flip ALL pending rows to skipped and bail.
  if (settings.imageAnalysis === "off") {
    const pending = await nextPendingImageAnalyses(db, 1000);
    for (const c of pending) {
      await recordImageAnalysisSkipped(
        db,
        c.mediaId,
        "Bildanalyse ist ausgeschaltet.",
      );
    }
    lastError = pending.length > 0 ? "Bildanalyse ist ausgeschaltet." : null;
    lastRunAt = Date.now();
    return;
  }

  const llm = await resolveActiveLlm();
  if (!llm) {
    const pending = await nextPendingImageAnalyses(db, 1000);
    for (const c of pending) {
      await recordImageAnalysisSkipped(db, c.mediaId, "Kein LLM konfiguriert.");
    }
    lastError = pending.length > 0 ? "Kein LLM konfiguriert." : null;
    lastRunAt = Date.now();
    return;
  }

  // Vision capability check.
  if (!hasVision(llm.provider, llm.model)) {
    const pending = await nextPendingImageAnalyses(db, 1000);
    for (const c of pending) {
      await recordImageAnalysisSkipped(
        db,
        c.mediaId,
        "Aktives Modell unterstützt keine Bildanalyse.",
      );
    }
    lastError =
      pending.length > 0
        ? "Aktives Modell unterstützt keine Bildanalyse."
        : null;
    lastRunAt = Date.now();
    return;
  }

  // Local-only constraint.
  if (settings.imageAnalysis === "local" && llm.provider !== "ollama") {
    const reason = `Bildanalyse ist auf lokal eingeschränkt; aktiver Anbieter ist ${llm.provider}.`;
    const pending = await nextPendingImageAnalyses(db, 1000);
    for (const c of pending) {
      await recordImageAnalysisSkipped(db, c.mediaId, reason);
    }
    lastError = pending.length > 0 ? reason : null;
    lastRunAt = Date.now();
    return;
  }

  // Cloud opt-in defence in depth (IPC validator should have caught this).
  if (settings.imageAnalysis === "cloud" && !settings.imageAnalysisCloudOptIn) {
    const reason = "Cloud-Bildanalyse ist nicht freigegeben.";
    const pending = await nextPendingImageAnalyses(db, 1000);
    for (const c of pending) {
      await recordImageAnalysisSkipped(db, c.mediaId, reason);
    }
    lastError = pending.length > 0 ? reason : null;
    lastRunAt = Date.now();
    return;
  }

  const tier = tierForModel(llm.provider, llm.model);
  const queue = await nextPendingImageAnalyses(db, limit);

  // Per-post 5-image cap. The queue is sorted by media_id, not post_urn,
  // so we tally as we go.
  const perPost = new Map<string, number>();
  let firstError: string | null = null;

  for (const cand of queue) {
    if (signal.aborted) break;

    const seen = perPost.get(cand.postUrn) ?? 0;
    if (seen >= PER_POST_IMAGE_CAP) {
      await recordImageAnalysisSkipped(
        db,
        cand.mediaId,
        "Limit von 5 Bildern pro Beitrag.",
      );
      continue;
    }
    perPost.set(cand.postUrn, seen + 1);

    try {
      const image = preprocessImage(cand.localPath);
      if (!image) {
        await recordImageAnalysisFailure(
          db,
          cand.mediaId,
          "Bild konnte nicht hinreichend verkleinert werden.",
        );
        continue;
      }
      const raw = await callVisionLlm(llm, cand.postUrn, image, signal);
      const json = extractJsonObject(raw);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        throw new Error(
          `JSON-Parsing fehlgeschlagen: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      const validated = (await IMAGE_SCHEMA.validate(parsed, {
        stripUnknown: false,
        abortEarly: true,
      })) as ImageAnalysisPayload;
      await recordImageAnalysisSuccess(
        db,
        cand.mediaId,
        validated,
        tier,
        llm.model,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.message === "aborted")
      ) {
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!firstError) firstError = msg;
      await recordImageAnalysisFailure(db, cand.mediaId, msg);
    }
    try {
      await sleep(150 + Math.floor(Math.random() * 200), signal);
    } catch {
      break;
    }
  }

  lastError = firstError;
  lastRunAt = Date.now();
}

/** Re-eligibilise skipped rows. Called by extractor.ts when settings
 *  change makes images runnable again. */
export async function resetSkippedImagesIfRunnable(): Promise<void> {
  try {
    const settings = readSettings();
    if (settings.imageAnalysis === "off") return;
    const db = await getDb();
    await resetSkippedImageAnalysesToPending(db);
  } catch (err) {
    console.warn(
      "[linkedin/image-extractor] reset skipped failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export type { ImageAnalysisCandidate };
