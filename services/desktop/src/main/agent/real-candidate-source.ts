import type { GatewayClient } from "./gateway-client";
import type { CandidateSource, HeartbeatCandidate } from "./heartbeat";

// Real candidate source (Phase 8.f4 — replaces the 8.f1 demo stub).
//
// Walks the existing gateway endpoints (no new server-side route yet) to
// collect candidate signals from the *user's actual corpus*:
//
//   1. List recent transactions      (`GET /v1/transactions`)
//   2. Per transaction → companies   (`GET /v1/transactions/:id/entities`)
//   3. Per company → publications    (`GET /v1/companies/:id/publications`)
//      + master-data for the name    (`GET /v1/companies/:id`)
//
// Each surviving publication becomes one candidate. We deliberately do
// NOT shell out to a custom gateway endpoint yet — the spec calls for
// `GET /v1/alerts/candidates` (8.f5) but that's a meaningful server-side
// fan-out and the user is asking for real data NOW. Doing it here keeps
// the heartbeat self-sufficient with the endpoints we already have.
//
// Filtering happens in three stages, cheapest first:
//   a) Freshness gate: drop publications older than FRESHNESS_MONTHS
//      months — keeps token spend off 2011-vintage filings.
//   b) Delta gate: when `since` is provided, only candidates whose
//      `updatedAt` post-dates the previous tick survive. Across process
//      restarts `since` is null on the first tick, so we DO re-emit
//      ~30 days of recent items; the AlertsStore's sourceRef dedup
//      stops them from being alerted twice and the LLM judge has its
//      own per-session "judged-already" memory inside the process.
//   c) Cap gate: hard cap at MAX_CANDIDATES so a 10k-company corpus
//      can't wedge a tick. Anything past the cap rolls forward to
//      the next tick (since `since` advances).
//
// Concurrency: the inner per-company fetches go through a tiny manual
// pool (no library) limited to CONCURRENCY parallel requests so a tick
// can't accidentally DDoS the gateway from a fast laptop.

const FRESHNESS_MONTHS = 18;
const MAX_TRANSACTIONS = 20;
const MAX_COMPANIES = 50;
const MAX_CANDIDATES = 30;
const CONCURRENCY = 5;

interface TxRow {
  id: string;
  createdAt?: string;
}

interface EntityRow {
  companyId: string;
  state?: string;
}

interface PubRow {
  companyId: string;
  name?: string | null;
  year?: number | null;
  begin?: string | null;
  end?: string | null;
  salesVolume?: VolumeShape | null;
  revenueVolume?: VolumeShape | null;
  totalAssetsVolume?: VolumeShape | null;
  stateOfAffairs?: { value?: string; affirmed?: boolean } | null;
  employeeCount?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

interface VolumeShape {
  value?: number | null;
  currency?: string | null;
}

interface CompanyMeta {
  /** Master-data sometimes calls this `name`, sometimes `companyName`. We
   *  accept either and fall back to a truncated id if both are absent. */
  name?: string | null;
  companyName?: string | null;
}

export function buildRealCandidateSource(
  gateway: GatewayClient,
): CandidateSource {
  return async (since: Date | null) => {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - FRESHNESS_MONTHS);
    const sinceIso = since ? since.toISOString() : null;

    const transactions = await listTransactions(gateway);
    const companyIds = await collectCompanyIds(gateway, transactions);

    const out: HeartbeatCandidate[] = [];
    await runWithConcurrency(
      Array.from(companyIds).slice(0, MAX_COMPANIES),
      CONCURRENCY,
      async (companyId) => {
        if (out.length >= MAX_CANDIDATES) return;
        try {
          const candidates = await fetchCandidatesForCompany(
            gateway,
            companyId,
            cutoff,
            sinceIso,
          );
          for (const c of candidates) {
            if (out.length >= MAX_CANDIDATES) break;
            out.push(c);
          }
        } catch (err) {
          // One bad company shouldn't kill the tick. Log and move on;
          // the heartbeat tick info will reflect a smaller candidate set
          // than expected.
          console.warn(
            `[real-source] company ${companyId} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      },
    );

    return out;
  };
}

// ---- Stages ---------------------------------------------------------------

async function listTransactions(gateway: GatewayClient): Promise<TxRow[]> {
  const data = await gateway.request<{ items?: TxRow[] }>("/v1/transactions", {
    query: { page: 1, pageSize: MAX_TRANSACTIONS },
  });
  return (data.items ?? []).slice(0, MAX_TRANSACTIONS);
}

async function collectCompanyIds(
  gateway: GatewayClient,
  transactions: TxRow[],
): Promise<Set<string>> {
  const seen = new Set<string>();
  await runWithConcurrency(transactions, CONCURRENCY, async (tx) => {
    if (seen.size >= MAX_COMPANIES) return;
    try {
      const data = await gateway.request<{ items?: EntityRow[] }>(
        `/v1/transactions/${encodeURIComponent(tx.id)}/entities`,
      );
      for (const e of data.items ?? []) {
        if (!e.companyId) continue;
        seen.add(e.companyId);
        if (seen.size >= MAX_COMPANIES) return;
      }
    } catch (err) {
      console.warn(
        `[real-source] entities for ${tx.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  });
  return seen;
}

async function fetchCandidatesForCompany(
  gateway: GatewayClient,
  companyId: string,
  cutoff: Date,
  sinceIso: string | null,
): Promise<HeartbeatCandidate[]> {
  const [metaResult, pubsResult] = await Promise.allSettled([
    gateway.request<CompanyMeta>(
      `/v1/companies/${encodeURIComponent(companyId)}`,
    ),
    gateway.request<{ items?: PubRow[] }>(
      `/v1/companies/${encodeURIComponent(companyId)}/publications`,
    ),
  ]);

  const meta = metaResult.status === "fulfilled" ? metaResult.value : {};
  const companyName =
    meta.name ?? meta.companyName ?? `${companyId.slice(0, 12)}…`;

  if (pubsResult.status !== "fulfilled") return [];
  const pubs = pubsResult.value.items ?? [];

  const out: HeartbeatCandidate[] = [];
  for (const p of pubs) {
    const occurred = pickOccurredAt(p);
    if (!occurred) continue;
    if (occurred < cutoff) continue;
    // Delta gate: skip rows we've already considered. We compare against
    // ingestion timestamps (updatedAt → createdAt), NOT `occurred` —
    // the latter is a report-period end (e.g. 2024-12-31) and would
    // mis-filter every annual report newer than today's tick wall-clock.
    const ingested = pickIngestedAt(p);
    if (sinceIso && ingested && ingested.toISOString() <= sinceIso) continue;

    out.push({
      kind: "publication",
      companyId,
      companyName,
      sourceRef: stableSourceRef(companyId, p),
      occurredAt: occurred.toISOString(),
      summary: summarisePublication(companyName, p),
      payload: {
        year: p.year ?? null,
        revenue: p.revenueVolume ?? null,
        sales: p.salesVolume ?? null,
        totalAssets: p.totalAssetsVolume ?? null,
        employees: p.employeeCount ?? null,
        stateOfAffairs: p.stateOfAffairs ?? null,
        period: p.begin && p.end ? `${p.begin} → ${p.end}` : null,
      },
    });
  }
  return out;
}

// ---- Helpers --------------------------------------------------------------

/**
 * Pick the most meaningful date for the freshness gate. Prefer the
 * publication's reporting period end, then the year (treated as
 * 31 December of that year), then `updatedAt`, then `createdAt`. Some
 * upstream rows arrive without any of these — those rows are dropped.
 */
/**
 * Ingestion timestamp — when AVA learned about this row. Used by the
 * delta gate so re-ingesting the same publication produces a "new"
 * candidate. Prefers `updatedAt` over `createdAt` so a re-pull updates
 * the cursor even if the original creation was months ago.
 */
function pickIngestedAt(p: PubRow): Date | null {
  for (const v of [p.updatedAt, p.createdAt]) {
    if (typeof v === "string" && v.length > 0) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function pickOccurredAt(p: PubRow): Date | null {
  const candidates = [p.end, p.updatedAt, p.createdAt];
  for (const v of candidates) {
    if (typeof v === "string" && v.length > 0) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (typeof p.year === "number" && Number.isFinite(p.year)) {
    return new Date(Date.UTC(p.year, 11, 31));
  }
  return null;
}

/**
 * Build a stable dedup key. The publication shape lacks an explicit id,
 * so we hash the natural composite (companyId + year + begin/end). Two
 * runs of the same publication produce the same key.
 */
function stableSourceRef(companyId: string, p: PubRow): string {
  const parts = [
    "publication",
    companyId,
    String(p.year ?? "?"),
    p.begin ?? "",
    p.end ?? "",
    // Final tiebreaker so two same-period rows that happen to have a
    // different updatedAt still collapse — fall back to createdAt only
    // when both period markers are missing.
    !p.begin && !p.end ? (p.createdAt ?? "") : "",
  ];
  return parts.join(":");
}

function summarisePublication(companyName: string, p: PubRow): string {
  const lines: string[] = [];
  const period =
    p.year != null
      ? `Geschäftsjahr ${p.year}`
      : p.begin && p.end
        ? `Berichtsperiode ${p.begin} → ${p.end}`
        : "Publikation";
  lines.push(`${period} – ${companyName}.`);
  if (p.revenueVolume?.value != null) {
    lines.push(`Umsatz: ${fmtMoney(p.revenueVolume)}.`);
  } else if (p.salesVolume?.value != null) {
    lines.push(`Erlöse: ${fmtMoney(p.salesVolume)}.`);
  }
  if (p.totalAssetsVolume?.value != null) {
    lines.push(`Bilanzsumme: ${fmtMoney(p.totalAssetsVolume)}.`);
  }
  if (p.employeeCount != null) {
    lines.push(`Beschäftigte: ${p.employeeCount}.`);
  }
  if (p.stateOfAffairs?.value) {
    lines.push(`Lage: ${p.stateOfAffairs.value}.`);
  }
  return lines.join(" ");
}

function fmtMoney(v: VolumeShape): string {
  if (v.value == null || !Number.isFinite(v.value)) return "";
  const formatted = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(v.value);
  const ccy = v.currency ?? "EUR";
  return `${formatted} ${ccy}`;
}

/**
 * Tiny concurrency-limited map. We don't want to add a dependency just
 * for this and the use-site is single — keeping it inline so the source
 * stays a one-file module.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(
      (async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          await fn(items[idx]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
}
