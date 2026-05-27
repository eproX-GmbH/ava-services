// LinkedIn-Beobachter Phase L3 — text-topic extraction worker.
//
// Sequentially walks the linkedin_signal queue and asks the user's
// configured LLM for a structured JSON payload (signal_kind, summary,
// topics, entities, strength). Output is validated with yup before
// landing in the DB so a malformed response never poisons the table.
//
// Single-flight: a module-scoped `running` flag plus an AbortController
// guard against concurrent drains. Cancellation is checked between
// posts. No parallelism: tier-S cloud models could fan out, but tier-C
// local Ollama can't and the simpler code wins.
//
// TODO L7: parallelism for cloud tiers if rate-limit allows.

import { generateText } from "ai";
import { createLLM, tierForModel } from "@ava/ai-provider";
import * as yup from "yup";
import {
  getDb,
  loadSignalCandidate,
  nextPendingSignals,
  recordSignalFailure,
  resetFailedSignalsToPending,
  resetFailedImageAnalysesToPending,
  recordSignalSkipped,
  recordSignalSuccess,
  resetSkippedToPending,
  signalCounts,
  type SignalCandidatePost,
  type SignalPayload,
} from "./db";
import type { LlmProviderManager } from "../agent/providers";
import type { ProviderConfigStore } from "../agent/providers/store";
import {
  attachImageProviders,
  drainImageQueue,
  imageStatusSnapshot,
  resetSkippedImagesIfRunnable,
  type ImageAnalysisStatus,
} from "./image-extractor";
import { drainEntityLinks } from "./linker";

export interface ExtractionStatus {
  running: boolean;
  pending: number;
  extracted: number;
  failed: number;
  skipped: number;
  lastRunAt: number | null;
  lastError: string | null;
}

let providersRef: LlmProviderManager | null = null;
let storeRef: ProviderConfigStore | null = null;

let running = false;
let activeAbort: AbortController | null = null;
let lastRunAt: number | null = null;
let lastError: string | null = null;

export function attachProviders(
  providers: LlmProviderManager,
  store: ProviderConfigStore,
): void {
  providersRef = providers;
  storeRef = store;
  attachImageProviders(providers, store);

  // When the user changes their LLM provider/model OR a key appears, give
  // skipped rows another chance and trigger a drain. Phase 2 (images)
  // gets the same treatment — switching to a vision-capable model should
  // resurrect skipped image rows so the next drain re-processes them.
  const onConfigChange = (): void => {
    void (async () => {
      try {
        const db = await getDb();
        await resetSkippedToPending(db);
      } catch (err) {
        console.warn(
          "[linkedin/extractor] reset skipped failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      await resetSkippedImagesIfRunnable();
      void drainQueue().catch(() => undefined);
    })();
  };

  store.on("configChanged", onConfigChange);
  store.on("keyChanged", onConfigChange);

  // v0.1.324 — Real-Run-Report (Windows): "LinkedIn-Scraper läuft,
  // Screenshots zeigen Scroll, aber keine Signale sichtbar". Ursache:
  // wenn `drainQueue()` direkt nach dem Scrape feuert während Ollama
  // auf Windows noch hochfährt (langsamere Disk-IO, längere Boot-Zeit),
  // findet resolveActiveLlm() keinen ready Provider → alle pending
  // Posts werden als `skipped` markiert. configChanged/keyChanged
  // greift erst wenn der User selbst was in den Settings ändert.
  // Lösung: auf den `status`-Event vom LlmProviderManager hören. Wenn
  // der Provider von "not-ready" auf "ready" wechselt, automatisch
  // skipped → pending zurücksetzen und drainen.
  let wasReady = providers.getStatus().ready;
  providers.on("status", (s) => {
    const nowReady = s.ready;
    if (!wasReady && nowReady) {
      console.info(
        "[linkedin/extractor] provider became ready — re-arming skipped signals",
      );
      onConfigChange();
    }
    wasReady = nowReady;
  });

  // v0.1.324 → v0.1.329 — Boot-Drain entfernt. Real-Run-Report (User
  // mit 194 'kein LLM'-skipped Posts auf v0.1.326): direkt nach dem
  // LinkedIn-Scheduler-Initial-Tick haengt AVA komplett. Verdacht:
  // 194 parallel angestossene LLM-Calls + gleichzeitig anlaufender
  // Scraper saettigen Main-Process/Anthropic-Rate-Limits.
  //
  // Auto-Rearm bei provider 'status'-Change (oben) bleibt drin -
  // wenn der User in den Whoami-Settings sein LLM aktiviert, werden
  // die skipped Posts trotzdem nachgeholt. Wir verlieren nur den
  // 'Boot startet automatisch eine alte Queue'-Komfort.
  //
  // Wer skipped Posts manuell nachholen will: 'LinkedIn-Auswertung
  // jetzt ausfuehren'-Button im Settings → Verlauf.
}

/** External hook for the LinkedIn settings IPC: when imageAnalysis flips
 *  off → on (or local→cloud, etc.) we want to reset skipped rows and
 *  re-trigger drain. Called from `linkedin:settings:update`. */
export function onLinkedInSettingsChanged(): void {
  void (async () => {
    await resetSkippedImagesIfRunnable();
    void drainQueue().catch(() => undefined);
  })();
}

export function isDraining(): boolean {
  return running;
}

export function getExtractionStatus(): ExtractionStatus {
  // Synchronous stub used by IPC callers; real numbers come from
  // statusSnapshot() which hits the DB.
  return {
    running,
    pending: 0,
    extracted: 0,
    failed: 0,
    skipped: 0,
    lastRunAt,
    lastError,
  };
}

export async function statusSnapshot(): Promise<ExtractionStatus> {
  try {
    const db = await getDb();
    const counts = await signalCounts(db);
    return {
      running,
      pending: counts.pending,
      extracted: counts.extracted,
      failed: counts.failed,
      skipped: counts.skipped,
      lastRunAt,
      lastError,
    };
  } catch (err) {
    return {
      running,
      pending: 0,
      extracted: 0,
      failed: 0,
      skipped: 0,
      lastRunAt,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function cancelDrain(): boolean {
  if (!activeAbort) return false;
  activeAbort.abort();
  return true;
}

interface ResolvedLlm {
  provider: "openai" | "anthropic" | "google" | "mistral" | "ollama";
  model: string;
  apiKey: string | null;
  baseURL?: string;
  /** v0.1.326 — OAuth-Bearer-Token für Anthropic-Subscription-Mode.
   *  Wird statt apiKey von createLLM benutzt wenn gesetzt. */
  anthropicSubscriptionToken?: string;
}

/** Resolve the user's currently-active LLM the same way the chat agent
 *  does. Returns null when nothing is configured (no key + ollama not
 *  ready / no model).
 *
 *  v0.1.326 — Anthropic-OAuth-Subscription-Pfad zusätzlich gehandhabt.
 *  Vorher hat die Funktion stur `storeRef.getKey(kind)` geprüft und
 *  null zurückgegeben, wenn kein API-Key da war. User mit Claude-Abo
 *  (Subscription-Modus) haben aber per Definition KEINEN API-Key — der
 *  Auth läuft über einen OAuth-Token, der separat gespeichert ist.
 *  Folge: Extractor meldete "Kein LLM konfiguriert" obwohl der Chat
 *  mit demselben Provider einwandfrei lief. Jetzt: wenn `status.ready`
 *  true ist (Provider hat sich selbst als ready gemeldet, inkl. OAuth-
 *  Resolve), genügt das — wir geben apiKey=null durch wie bei Ollama,
 *  der LLM-Caller (siehe llm.ts) holt sich den OAuth-Token selbst über
 *  den Manager.
 */
async function resolveActiveLlm(): Promise<ResolvedLlm | null> {
  if (!providersRef || !storeRef) return null;
  const status = providersRef.getStatus();
  if (!status.ready || !status.model) return null;
  const kind = status.kind;
  if (kind === "ollama") {
    return { provider: "ollama", model: status.model, apiKey: null };
  }
  // Anthropic-Subscription: kein API-Key nötig, Auth via OAuth-Token.
  // Wir holen den Token hier und reichen ihn als anthropicSubscriptionToken
  // an callLlm weiter (createLLM weiß damit umzugehen — siehe
  // ai-sdk-provider.ts in der Chat-Pipeline).
  if (kind === "anthropic") {
    const cfg = storeRef.getConfig?.();
    const isSubscription =
      (cfg?.anthropicAuthMode ?? "api-key") === "subscription";
    if (isSubscription) {
      const token = await storeRef.getAnthropicSubscriptionToken();
      if (token) {
        return {
          provider: "anthropic",
          model: status.model,
          apiKey: null,
          anthropicSubscriptionToken: token,
        };
      }
      return null; // Subscription-Modus aber kein Token gespeichert
    }
  }
  const key = await storeRef.getKey(kind);
  if (!key) return null;
  return { provider: kind, model: status.model, apiKey: key };
}

const SIGNAL_KINDS = [
  "personnel_change",
  "company_event",
  "factory_visit",
  "new_product",
  "partnership",
  "event_attendance",
  "hiring",
  "award",
  "press_mention",
  "none",
] as const;

const SIGNAL_SCHEMA = yup
  .object({
    signal_kind: yup.string().oneOf(SIGNAL_KINDS).required(),
    signal_strength: yup.number().integer().min(1).max(5).required(),
    // LLMs ignorieren das 240-Zeichen-Limit aus dem Prompt regelmäßig.
    // Statt den gesamten Signal-Datensatz wegen ein paar Zeichen zu
    // verwerfen, kürzen wir hier weich (240 minus '…').
    summary: yup
      .string()
      .transform((v: unknown) => {
        if (typeof v !== "string") return v;
        const trimmed = v.trim();
        if (trimmed.length <= 240) return trimmed;
        return trimmed.slice(0, 239).replace(/\s+\S*$/, "").trimEnd() + "…";
      })
      .required(),
    topics: yup.array().of(yup.string().max(40)).min(0).max(5).required(),
    entities: yup
      .object({
        companies: yup
          .array()
          .of(yup.string().max(120))
          .default([])
          .required(),
        people: yup
          .array()
          .of(yup.string().max(120))
          .default([])
          .required(),
        locations: yup.array().of(yup.string().max(120)).default([]),
      })
      .required(),
  })
  .strict()
  .noUnknown();

const SYSTEM_PROMPT = `Du bist die Signal-Erkennung von AVA, einer Recherche-App für deutsche
B2B-Vertriebler. Aufgabe: Werte einen LinkedIn-Beitrag aus und extrahiere
maschinenlesbare Signale für die Frage "Wann wen kontaktieren?".

Antworte NUR mit einem einzigen JSON-Objekt nach diesem Schema:
  {
    "signal_kind": "personnel_change" | "company_event" | "factory_visit"
                 | "new_product" | "partnership" | "event_attendance"
                 | "hiring" | "award" | "press_mention" | "none",
    "signal_strength": 1 | 2 | 3 | 4 | 5,
    "summary": string,           // EIN Satz, deutsch, max. 240 Zeichen
    "topics": string[],          // 1-5 deutsche Stichwörter
    "entities": {
      "companies": string[],     // genannte Firmennamen, Originalschreibweise
      "people":    string[],     // genannte Personen, "Vorname Nachname"
      "locations": string[]      // optional, Städte oder Länder
    }
  }

Regeln:
- Wenn der Beitrag keine vertriebsrelevante Substanz hat (Marketing-PR,
  Selfie, allgemeine Inspiration), setze signal_kind="none" und
  signal_strength=1, topics=["allgemein"], entities mit leeren Listen.
- signal_strength: 1=irrelevant, 3=interessant, 5=jetzt-handeln.
  Faktoren, die Stärke erhöhen: Bezug zur Geschäftsführung, konkrete
  Investition/Übernahme/Insolvenz, Werksbesuch bei einer Konkurrenz oder
  einem Lieferanten, Personalbewegung auf Entscheider-Ebene.
- entities aus dem TEXT extrahieren, nicht aus deinem Vorwissen erfinden.
- Verwende KEINE Geviertstriche (—). Nutze Komma, Doppelpunkt, Punkt
  oder Klammern.
- Keine zusätzlichen Felder. Keine Markdown-Codeblöcke. Keine Begrüßung.`;

function buildUserPrompt(post: SignalCandidatePost): string {
  const lines: string[] = [];
  const author = post.author.headline
    ? `${post.author.displayName} · ${post.author.headline}`
    : post.author.displayName;
  lines.push(`Beitrag von: ${author}`);
  lines.push(`Beitragsart: ${post.postKind ?? "text"}`);
  if (post.postedAtRelative) lines.push(`Verfasst: ${post.postedAtRelative}`);
  lines.push("Inhalt:");
  const text = post.text.length > 4000 ? post.text.slice(0, 4000) : post.text;
  lines.push(text);
  if (post.surfacedInteractions.length > 0) {
    lines.push("");
    lines.push("Sichtbare Interaktionen:");
    for (const i of post.surfacedInteractions) {
      const suffix = i.commentText ? ` ${i.commentText}` : "";
      lines.push(`${i.actor} hat ${i.kind}${suffix}`);
    }
  }
  return lines.join("\n");
}

function extractJsonObject(raw: string): string {
  // Strip markdown fences if the model ignored the "no codeblocks" rule.
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  // Find first '{' and matching last '}' — cheaper than a full parser
  // and tolerates trailing prose.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

async function callLlm(
  llm: ResolvedLlm,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const model = createLLM({
    provider: llm.provider,
    model: llm.model,
    apiKey: llm.apiKey ?? undefined,
    baseURL: llm.baseURL,
    // v0.1.326 — OAuth-Subscription-Token mitschicken wenn der User
    // im Subscription-Mode ist (Claude-Abo statt API-Key). Ohne das
    // hat createLLM zwar einen "anthropic"-Provider, kann aber den
    // Bearer-Header nicht setzen → 401.
    ...(llm.anthropicSubscriptionToken
      ? { anthropicSubscriptionToken: llm.anthropicSubscriptionToken }
      : {}),
  });
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt,
    abortSignal: signal,
    // Hosted providers honour json mode via responseFormat where
    // supported; AI SDK's `generateText` doesn't expose that uniformly,
    // so we parse defensively below.
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

export async function drainQueue(opts?: {
  limit?: number;
  signal?: AbortSignal;
  /** Manual run from the Settings button. When true, exhausted-failed
   *  rows (status='failed', attempts>=MAX_ATTEMPTS) get reset to
   *  pending before the drain so the user can nudge stuck rows
   *  without flipping settings. Background scan-tail + scheduled
   *  drains do NOT pass manual=true; they only chew through the
   *  legitimately-pending queue. */
  manual?: boolean;
}): Promise<ExtractionStatus> {
  if (running) {
    return await statusSnapshot();
  }
  running = true;
  activeAbort = new AbortController();
  if (opts?.signal) {
    if (opts.signal.aborted) activeAbort.abort();
    else
      opts.signal.addEventListener(
        "abort",
        () => activeAbort?.abort(),
        { once: true },
      );
  }
  const signal = activeAbort.signal;
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));

  try {
    const db = await getDb();
    if (opts?.manual === true) {
      // User explicitly asked for a re-run. Un-park exhausted-failed
      // rows for both phases so the drain actually has something to
      // re-evaluate. Each helper returns the row count for log
      // purposes if needed; we don't surface it.
      await resetFailedSignalsToPending(db);
      await resetFailedImageAnalysesToPending(db);
    }
    const llm = await resolveActiveLlm();

    if (!llm) {
      // No LLM configured: mark all pending rows as skipped so the UI
      // can surface the count. Rows transition back to pending when
      // the provider settings change.
      const pending = await nextPendingSignals(db, 1000);
      for (const postUrn of pending) {
        await recordSignalSkipped(db, postUrn, "Kein LLM konfiguriert.");
      }
      lastError = pending.length > 0 ? "Kein LLM konfiguriert." : null;
      lastRunAt = Date.now();
      return await statusSnapshot();
    }

    const tier = tierForModel(llm.provider, llm.model);
    const queue = await nextPendingSignals(db, limit);
    let firstError: string | null = null;

    for (const postUrn of queue) {
      if (signal.aborted) break;
      const post = await loadSignalCandidate(db, postUrn);
      if (!post) {
        await recordSignalFailure(db, postUrn, "Beitrag nicht gefunden.");
        continue;
      }
      try {
        const raw = await callLlm(llm, buildUserPrompt(post), signal);
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
        const validated = (await SIGNAL_SCHEMA.validate(parsed, {
          stripUnknown: false,
          abortEarly: true,
        })) as SignalPayload;
        await recordSignalSuccess(db, postUrn, validated, tier, llm.model);
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.message === "aborted")
        ) {
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (!firstError) firstError = msg;
        await recordSignalFailure(db, postUrn, msg);
      }
      // Jittered backoff so we don't hammer Ollama on a hot subprocess.
      try {
        await sleep(150 + Math.floor(Math.random() * 200), signal);
      } catch {
        break;
      }
    }

    lastError = firstError;
    lastRunAt = Date.now();

    // Phase 2 (L4): vision-LLM image analysis. Same single-flight, same
    // signal. The image worker handles all its own setting-gating + skip
    // bookkeeping internally.
    if (!signal.aborted) {
      try {
        await drainImageQueue({ limit, signal });
      } catch (err) {
        if (
          !(
            err instanceof Error &&
            (err.name === "AbortError" || err.message === "aborted")
          )
        ) {
          console.warn(
            "[linkedin/extractor] image drain failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // Phase 3 (L5): entity linking. Re-uses the same `running` flag — the
    // linker module honours the abort signal and runs sequentially.
    if (!signal.aborted) {
      try {
        await drainEntityLinks({
          limit,
          signal,
          manual: opts?.manual === true,
        });
      } catch (err) {
        if (
          !(
            err instanceof Error &&
            (err.name === "AbortError" || err.message === "aborted")
          )
        ) {
          console.warn(
            "[linkedin/extractor] entity link drain failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    return await statusSnapshot();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    lastRunAt = Date.now();
    return await statusSnapshot();
  } finally {
    activeAbort = null;
    running = false;
  }
}

/** L4: image-analysis status snapshot. The "running" flag is shared
 *  with phase 1 (text) — both phases share the same single-flight
 *  drain — so callers see "running" while either phase is active. */
export async function imageAnalysisStatusSnapshot(): Promise<ImageAnalysisStatus> {
  return await imageStatusSnapshot(running);
}
