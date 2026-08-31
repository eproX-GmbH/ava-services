// Phase 3 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — ICP-Match.
//
// Laeuft komplett LOKAL (das ICP ist privat, A3/A5):
//   1. Profilierte, offene Kandidaten vom Gateway holen — inkl. der
//      beim Ingest berechneten Embeddings (Muster publication-blocks:
//      das Gateway braucht keinen Embedder und keinen ANN-Index).
//      Optional geo-gefiltert ueber den ersten ICP-Ort.
//   2. ICP-Text lokal einbetten, Kosinus-Vorranking → Top-K.
//   3. LLM-Urteil (guenstiges Producer-Modell) fuer die Top-K in
//      kleinen Batches: Score 0-100 + Ein-Satz-Begruendung, WARUM die
//      Firma zum ICP passt.
//   4. Ergebnisse in den lokalen MatchStore (nutzerbezogen).

import * as yup from "yup";
import type { GatewayClient } from "../agent/gateway-client";
import type { LlmProviderManager } from "../agent/providers";
import type { IcpStore } from "../agent/icp-store";
import { MatchStore, type MatchEntry } from "./match-store";
import type { CustomerProfileStore } from "./customer-profiles";
import { crawlSite, buildProfile, renderProfileText } from "./profiler";
import {
  buildMessages,
  parseJsonObject,
  streamToText,
} from "../link-monitor/llm";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const TOP_K = 20;
const JUDGE_BATCH = 8;

interface ProfiledCandidate {
  discoveryId: string;
  name: string;
  city: string | null;
  category: string | null;
  profileText: string | null;
  embedding: number[] | null;
}

export interface MatchResultRow {
  discoveryId: string;
  name: string;
  ort: string | null;
  score: number;
  begruendung: string;
}

export interface MatchSummary {
  kandidatenMitProfil: number;
  bewertet: number;
  ergebnisse: MatchResultRow[];
  hinweise: string[];
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

async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embeddinggemma:latest", input: [text] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { embeddings?: number[][] };
    return json.embeddings?.[0] ?? null;
  } catch {
    return null;
  }
}

const judgeSchema = yup.array().of(
  yup.object({
    id: yup.string().trim().min(1).required(),
    score: yup.number().min(0).max(100).required(),
    begruendung: yup.string().trim().min(5).max(400).required(),
  }),
);

/** Ein Batch Kandidaten gegen das ICP bewerten. */
async function judgeBatch(
  providers: LlmProviderManager,
  icpText: string,
  feedbackText: string,
  batch: ProfiledCandidate[],
  /** I5 — discoveryId → Hinweis-Zeile ("sehr aehnlich zu Bestandskunde X"). */
  hints: Map<string, string>,
): Promise<Map<string, { score: number; begruendung: string }>> {
  const out = new Map<string, { score: number; begruendung: string }>();
  const system =
    "Du bewertest, wie gut Firmen zum Idealkundenprofil (ICP) eines " +
    "B2B-Vertrieblers passen. Fuer JEDE Firma: score 0-100 (100 = " +
    "perfekter Fit; unter 40 = kein Fit) und EIN kurzer deutscher Satz " +
    "als Begruendung, der konkret benennt, WARUM die Firma (nicht) " +
    "passt — bezogen auf das ICP, nicht generisch. Beruecksichtige " +
    "Ausschluesse im ICP hart (Ausschluss getroffen → score unter 20). " +
    "Falls fruehere Verwerf-Gruende des Nutzers mitgeliefert werden: " +
    "aehnliche Firmen entsprechend niedriger bewerten. " +
    'Antworte NUR als JSON: {"bewertungen": [{"id": "...", "score": 0, ' +
    '"begruendung": "..."}]}';
  const user =
    `ICP:\n${icpText}\n` +
    (feedbackText ? `\nFruehere Verwerf-Gruende des Nutzers:\n${feedbackText}\n` : "") +
    `\nFirmen:\n` +
    batch
      .map((c) => {
        const hint = hints.get(c.discoveryId);
        return (
          `- id: ${c.discoveryId}\n  ${c.profileText?.slice(0, 1200) ?? c.name}` +
          (hint ? `\n  Hinweis: ${hint}` : "")
        );
      })
      .join("\n");
  try {
    const raw = await streamToText(
      providers,
      buildMessages(system, user, "discmatch"),
      {
        timeoutMs: 90_000,
        ...(providers.getProducerModelOverride()
          ? { modelOverride: providers.getProducerModelOverride() }
          : {}),
      },
    );
    const parsed = parseJsonObject(raw) as { bewertungen?: unknown } | null;
    const rows = judgeSchema.validateSync(parsed?.bewertungen ?? [], {
      abortEarly: true,
    });
    for (const r of rows ?? []) {
      out.set(r.id, { score: Math.round(r.score), begruendung: r.begruendung });
    }
  } catch (err) {
    console.warn("[discovery-match] Urteil-Batch fehlgeschlagen:", err);
  }
  return out;
}

// ---- I5: Top-Kunden-Aehnlichkeit -------------------------------------------

const CUSTOMER_SIM_THRESHOLD = 0.65;

interface CustomerVec {
  name: string;
  embedding: number[];
}

/** Kundenprofile fuer die ICP-K9-Domains sicherstellen: fehlende werden
 *  lazy gecrawlt + profiliert (manuell eingetragene Kunden ohne
 *  Assistent-Analyse). Best-effort — liefert nur, was Embeddings hat. */
async function ensureCustomerVecs(
  providers: LlmProviderManager,
  icp: IcpStore,
  store: CustomerProfileStore,
  hinweise: string[],
): Promise<CustomerVec[]> {
  const beispiele = icp.get().kundenBeispiele;
  const out: CustomerVec[] = [];
  for (const b of beispiele) {
    let profile = store.get(b.domain);
    if (!profile) {
      const siteText = await crawlSite(b.domain);
      if (siteText) {
        const mini = await buildProfile(
          providers,
          { name: b.name ?? b.domain, city: b.ort ?? null, category: null },
          siteText,
        );
        if (mini) {
          const profileText = renderProfileText(b.name ?? b.domain, b.ort ?? null, mini);
          const embedding = await embedText(profileText);
          store.set(b.domain, { profileText, embedding });
          profile = store.get(b.domain);
        }
      }
      if (!profile) {
        hinweise.push(`Top-Kunde ${b.domain} nicht profilierbar — ohne Aehnlichkeits-Signal.`);
        continue;
      }
    }
    if (profile.embedding) {
      out.push({ name: b.name ?? b.domain, embedding: profile.embedding });
    }
  }
  return out;
}

/** v0.1.474 — stabiler Kurz-Hash (djb2) fuer den ICP-Text. */
function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export async function runMatch(
  gateway: GatewayClient,
  providers: LlmProviderManager,
  icp: IcpStore,
  matchStore: MatchStore,
  /** I5 — lokale Top-Kunden-Profile fuers Aehnlichkeits-Signal. */
  customerStore?: CustomerProfileStore,
  /** v0.1.474 — "incremental": nur Kandidaten OHNE bestehenden Score
   *  bewerten (Paket c: der Profil-Worker stoesst das nach jedem
   *  Drain an — frische Treffer troepfeln laufend rein, der teure
   *  Volllauf bleibt fuer ICP-Aenderungen). Bei geaendertem ICP wird
   *  automatisch auf einen Volllauf mit Score-Reset umgeschaltet. */
  opts?: { mode?: "full" | "incremental" },
): Promise<MatchSummary | { error: string }> {
  if (!icp.isSet()) {
    return {
      error:
        "Kein ICP hinterlegt. Bitte zuerst das Idealkundenprofil festlegen (icp_set / Frage aus der Begruessung beantworten).",
    };
  }
  const hinweise: string[] = [];
  const icpText = icp.renderText();

  // v0.1.474 — ICP-Drift erkennen: Scores gehoeren immer zu GENAU
  // einem ICP-Stand. Weicht der Hash ab, sind alle alten Scores
  // wertlos → verwerfen und voll neu bewerten.
  const icpHash = hashText(icpText);
  let mode: "full" | "incremental" = opts?.mode ?? "full";
  if (matchStore.getIcpHash() !== icpHash) {
    if (mode === "incremental") mode = "full";
    matchStore.clear();
    hinweise.push("ICP hat sich geaendert — alle Kandidaten werden neu bewertet.");
  }

  // Geo-Eingrenzung ueber den ersten ICP-Ort (optional).
  let geoParams = "";
  const ort = icp.get().orte[0];
  if (ort) {
    try {
      const qs = new URLSearchParams({ near: ort, radiusKm: String(icp.get().radiusKm) });
      const geo = await gateway.request<{ origin: { lat: number; lon: number } }>(
        `/v1/geo/places?${qs.toString()}`,
      );
      geoParams = `&lat=${geo.origin.lat}&lon=${geo.origin.lon}&radiusKm=${icp.get().radiusKm}`;
    } catch {
      hinweise.push(`ICP-Ort "${ort}" nicht aufloesbar — Match ohne Geo-Filter.`);
    }
  }

  let candidates: ProfiledCandidate[];
  try {
    const r = await gateway.request<{ candidates: ProfiledCandidate[] }>(
      `/v1/discovery/candidates?limit=300&withProfiles=true${geoParams}`,
    );
    candidates = r.candidates;
  } catch (err) {
    return {
      error: `Kandidaten-Abruf fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (candidates.length === 0) {
    return {
      kandidatenMitProfil: 0,
      bewertet: 0,
      ergebnisse: [],
      hinweise: [
        ...hinweise,
        "Keine profilierten offenen Kandidaten — erst discovery_scan und discovery_profile_run laufen lassen.",
      ],
    };
  }

  // Inkrementell: bereits bewertete Kandidaten (gleicher ICP-Stand)
  // ueberspringen. Wiederholte Laeufe arbeiten so den Rest-Backlog ab,
  // weil bewertete IDs jeweils rausfallen.
  const gesamtMitProfil = candidates.length;
  if (mode === "incremental") {
    const existing = matchStore.getAll();
    candidates = candidates.filter((c) => !(c.discoveryId in existing));
    if (candidates.length === 0) {
      return {
        kandidatenMitProfil: gesamtMitProfil,
        bewertet: 0,
        ergebnisse: [],
        hinweise: [...hinweise, "Keine neuen Kandidaten zu bewerten."],
      };
    }
  }

  // I5 — Top-Kunden-Vektoren (best-effort, lazy nachprofiliert).
  const kundenVecs = customerStore
    ? await ensureCustomerVecs(providers, icp, customerStore, hinweise)
    : [];

  // Kosinus-Vorranking (lokal): ICP-Naehe + Aehnlichkeit zum naechsten
  // Top-Kunden (I5). Ohne Embedder: Reihenfolge unveraendert.
  let ranked = candidates;
  const nearestCustomer = new Map<string, { name: string; sim: number }>();
  const icpVec = await embedText(icpText);
  if (icpVec) {
    ranked = candidates
      .map((c) => {
        const cosIcp = c.embedding ? cosine(icpVec, c.embedding) : -1;
        let best: { name: string; sim: number } | null = null;
        if (c.embedding) {
          for (const k of kundenVecs) {
            const sim = cosine(k.embedding, c.embedding);
            if (!best || sim > best.sim) best = { name: k.name, sim };
          }
        }
        if (best) nearestCustomer.set(c.discoveryId, best);
        const sim =
          best && kundenVecs.length > 0
            ? 0.6 * cosIcp + 0.4 * best.sim
            : cosIcp;
        return { c, sim };
      })
      .sort((a, b) => b.sim - a.sim)
      .map((x) => x.c);
  } else {
    hinweise.push(
      "Lokales Embedding nicht verfuegbar (Ollama/embeddinggemma) — LLM-Urteil ohne Vorranking.",
    );
  }
  const topK = ranked.slice(0, TOP_K);

  // Feedback-Loop (Phase 4): juengste Verwerf-Gruende als Praeferenz-
  // Signal in den Urteils-Prompt. Best-effort.
  let feedbackText = "";
  try {
    const fb = await gateway.request<{
      dismissals: Array<{ name: string; reason: string }>;
    }>("/v1/discovery/dismissals?limit=10");
    feedbackText = fb.dismissals
      .map((d) => `- ${d.name}: ${d.reason}`)
      .join("\n");
  } catch {
    /* Feedback ist optional */
  }

  // I5 — Aehnlichkeits-Hinweise fuers Urteil (nur bei starker Naehe).
  const hints = new Map<string, string>();
  for (const [id, best] of nearestCustomer) {
    if (best.sim >= CUSTOMER_SIM_THRESHOLD) {
      hints.set(id, `Profil sehr aehnlich zu Bestandskunde "${best.name}".`);
    }
  }

  // LLM-Urteil in Batches.
  const judged = new Map<string, { score: number; begruendung: string }>();
  for (let i = 0; i < topK.length; i += JUDGE_BATCH) {
    const part = await judgeBatch(
      providers,
      icpText,
      feedbackText,
      topK.slice(i, i + JUDGE_BATCH),
      hints,
    );
    for (const [k, v] of part) judged.set(k, v);
  }
  if (judged.size === 0 && topK.length > 0) {
    return {
      error:
        "LLM-Urteil fehlgeschlagen (kein Provider bereit oder unparsbare Antwort) — bitte erneut versuchen.",
    };
  }

  const now = new Date().toISOString();
  const entries: Record<string, MatchEntry> = {};
  const ergebnisse: MatchResultRow[] = [];
  for (const c of topK) {
    const j = judged.get(c.discoveryId);
    if (!j) continue;
    // I5 — Aehnlichkeit sichtbar machen, falls das Urteil sie nicht
    // schon selbst erwaehnt.
    const near = nearestCustomer.get(c.discoveryId);
    let begruendung = j.begruendung;
    if (
      near &&
      near.sim >= CUSTOMER_SIM_THRESHOLD &&
      !begruendung.toLowerCase().includes(near.name.toLowerCase())
    ) {
      begruendung = `${begruendung} Ähnelt deinem Bestandskunden ${near.name}.`;
    }
    entries[c.discoveryId] = {
      score: j.score,
      begruendung,
      matchedAt: now,
    };
    ergebnisse.push({
      discoveryId: c.discoveryId,
      name: c.name,
      ort: c.city,
      score: j.score,
      begruendung,
    });
  }
  matchStore.setMany(entries);
  matchStore.setIcpHash(icpHash);
  ergebnisse.sort((a, b) => b.score - a.score);

  return {
    kandidatenMitProfil: gesamtMitProfil,
    bewertet: ergebnisse.length,
    ergebnisse,
    hinweise,
  };
}
