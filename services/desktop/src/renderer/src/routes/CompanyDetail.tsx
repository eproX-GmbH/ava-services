import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { gatewayFetch, GatewayError } from "../api/gateway";
import {
  fmtMoney,
  fmtShareCapital,
  fmtDate,
  fmtDateRange,
  numVal,
  telHref,
  mailHref,
  mapsHref,
  looksLikeEmail,
  looksLikePhone,
} from "../lib/format";
import { ExternalLink } from "../components/ExternalLink";
import {
  GlobeIcon,
  LinkedInIcon,
  XingIcon,
} from "../components/icons";

// W8–W13 — single company drill-down, ported from the legacy ava-v2 web app.
//
// The legacy page was a 1000-line shadcn/recharts UI; here we keep the
// structure (hero block, deep-research strip, six tabs: Overview, Financials,
// Management, Contacts, Insights, Jobs) but render it with the Desktop-App's
// plain CSS classes. The point of this page is to surface the data — KPIs,
// stateOfAffairs, fact-rows — not to re-implement the design system.
//
// Notes on data shape:
//   - Volume fields (salesVolume / revenueVolume / totalAssetsVolume) come
//     from upstream as `{value, currency}` value-objects. We tolerate a bare
//     number too (older rows / future flattening) via numVal().
//   - stateOfAffairs is a `{topic, isRelevant, bullets, guidance,
//     risksOpportunities, kpis}` aggregate.
//   - companyFacts / companyObservations / companySignals are `Fact[]`
//     arrays. Renderer groups by entityType + field.
//
// Per-tab queries lazy-load on tab activation (the upstreams are independent
// and pre-fetching all six on every page view would be wasteful).

type TabKey =
  | "overview"
  | "financials"
  | "management"
  | "contacts"
  | "insights"
  | "jobs";

const TABS: Array<{ key: TabKey; label: string; workflow: string }> = [
  { key: "overview", label: "Übersicht", workflow: "W8/W10" },
  { key: "financials", label: "Finanzen", workflow: "W11" },
  { key: "management", label: "Geschäftsführung", workflow: "W13" },
  { key: "contacts", label: "Kontakte", workflow: "W12" },
  { key: "insights", label: "Erkenntnisse", workflow: "W11" },
  { key: "jobs", label: "Stellenanzeigen", workflow: "W10" },
];

// ---- Shared hooks ----------------------------------------------------------

function useTabQuery<T>(key: string, id: string, path: string, enabled = true) {
  return useQuery<T>({
    queryKey: ["company", id, key],
    queryFn: () => gatewayFetch<T>(path),
    enabled,
    retry: (count, err) => {
      // Don't hammer 404s — those mean "no data yet", not a transient failure.
      if (err instanceof GatewayError && err.status === 404) return false;
      return count < 1;
    },
  });
}

// Helpers — see `lib/format.ts` for the centralised formatters.

// Numeric formatter for plain integer-style values (employee counts,
// review counts) — money / dates / contacts go through `lib/format`.
const numFmt = new Intl.NumberFormat("de-DE");

// ---- Types — kept loose since gateway passes upstream JSON through ---------

interface CompanyProfile {
  id?: string;
  profile?: string | null;
  url?: string | null;
  businessPurpose?: string | null;
  keywords?: string[];
}

interface ManagingDirector {
  id?: string;
  firstName?: string;
  lastName?: string;
  birthDay?: string | null;
  city?: string | null;
}

interface StructuredContent {
  companyId?: string;
  name?: string | null;
  corporatePurpose?: string | null;
  shareCapital?: string | null;
  legalForm?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  zipCode?: string | null;
  city?: string | null;
  foundingYear?: string | number | null;
  managingDirectors?: ManagingDirector[];
}

interface CompanySerp {
  url?: string | null;
  category?: string | null;
  phone?: string | null;
  rating?: number | string | null;
  reviewCount?: number | null;
}
interface WebsiteCore {
  url?: string | null;
  siteName?: string | null;
}
interface DeepResearch {
  type?: string;
  title?: string;
  company?: string | null;
  country?: string | null;
  date?: string | null;
  url?: string | null;
  citations?: string[];
  [k: string]: unknown;
}
interface JobPosting {
  title?: string;
  location?: string | null;
  workingModel?: string | null;
  releaseDate?: string | null;
  sourceUrl?: string | null;
  description?: string | null;
  requirements?: string[];
  technologies?: string[];
  [k: string]: unknown;
}
interface Website {
  website?: WebsiteCore | null;
  companySerp?: CompanySerp | null;
  deepResearches?: DeepResearch[];
  jobPostings?: JobPosting[];
}

interface KpiItem {
  name: string;
  value: string;
  period?: string | null;
}
interface StateOfAffairs {
  topic?: string | null;
  isRelevant?: boolean | null;
  bullets?: string[];
  guidance?: string[];
  risksOpportunities?: string[];
  kpis?: KpiItem[];
}
interface Publication {
  name?: string | null;
  year?: number | null;
  begin?: string | null;
  end?: string | null;
  salesVolume?: { value?: number | null; currency?: string | null } | number | null;
  revenueVolume?: { value?: number | null; currency?: string | null } | number | null;
  totalAssetsVolume?:
    | { value?: number | null; currency?: string | null }
    | number
    | null;
  stateOfAffairs?: StateOfAffairs | null;
  employeeCount?: number | null;
}

interface Fact {
  id?: string;
  entityType?: "COMPANY" | "PERSON" | string;
  entityId?: string;
  field?: string;
  value?: string;
  normalized?: string;
  confidence?: number;
  status?: "ACTIVE" | "INACTIVE" | string;
  [k: string]: unknown;
}
interface CompanyContact {
  id?: string;
  companyName?: string | null;
  websiteUrl?: string | null;
  companyFacts?: Fact[];
}

// v0.1.65 — per-stage LLM provenance.
//
// `llmTier` (1..4 → C/B/A/S, see /MODEL_TIERS.md) is the reliability
// bucket the persist-bus uses for write/skip decisions. `llmModel` is
// the exact model id ("gpt-4o", "qwen2.5:7b", …) — the audit trail.
// Both null on non-LLM stages (structured-content, company-publication)
// and on rows written before the column landed.
interface StageState {
  updatedAt: string | null;
  llmTier: number | null;
  llmModel: string | null;
}
interface CompanyStateResponse {
  companyId: string;
  stages: Record<string, StageState>;
}

const TIER_LETTER: Record<number, string> = { 4: "S", 3: "A", 2: "B", 1: "C" };
const TIER_LABEL: Record<number, string> = {
  4: "Tier S · Frontier",
  3: "Tier A · Strong cloud",
  2: "Tier B · Solid cloud / large local",
  1: "Tier C · Lokal / klein",
};
const TIER_DESCRIPTION =
  "AVA klassifiziert jedes LLM in einen Tier S/A/B/C, siehe MODEL_TIERS.md. " +
  "Höhere Tiers liefern verlässlichere Daten; tiefe Tiers können halluzinieren.";
const STAGE_LABEL: Record<string, string> = {
  "structured-content": "Stamm-Daten",
  "company-publication": "Publikationen",
  website: "Website",
  "company-profile": "Profil",
  "company-contact": "Kontakt",
  "company-evaluation": "Bewertung",
};
/** Map tier 1..4 onto the `.dot.<class>` palette. */
const TIER_DOT: Record<number, string> = {
  4: "ok",
  3: "ok",
  2: "warn",
  1: "bad",
};

// ---- Page ------------------------------------------------------------------

export function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<TabKey>("overview");

  // Phase 8.r4 — interest signal. Pinging on every CompanyDetail mount
  // tells the freshness scheduler the user is paying attention to this
  // company; its stale cells get a 0–1 boost in the score formula so
  // they sort to the top of the next refresh tick. Fire-and-forget;
  // a failure here shouldn't block the page render.
  useEffect(() => {
    if (!id) return;
    void window.api.interest.record(id);
  }, [id]);

  // Hero data — always fetch profile + structured-content + website so the
  // hero (name/keywords/KPI tiles) has something even before the user clicks
  // around. These are the same calls the legacy page eager-loaded.
  const summary = useQuery({
    queryKey: ["company", id],
    queryFn: () => gatewayFetch<{ id: string; name?: string; city?: string }>(`/v1/companies/${id}`),
    enabled: !!id,
  });
  const profile = useTabQuery<CompanyProfile>("profile", id!, `/v1/companies/${id}/profile`, !!id);
  const structured = useTabQuery<StructuredContent>(
    "structured",
    id!,
    `/v1/companies/${id}/structured-content`,
    !!id,
  );
  const website = useTabQuery<Website>("website", id!, `/v1/companies/${id}/website`, !!id);
  const publications = useTabQuery<{ items: Publication[] }>(
    "publications",
    id!,
    `/v1/companies/${id}/publications`,
    !!id,
  );
  // v0.1.65 — per-stage LLM provenance for the "Datenqualität" banner
  // and per-cell tooltips. One row per stage in ContentFreshness;
  // tier (1..4 / null) + exact model id (gpt-4o, qwen2.5:7b, …) + freshness.
  const stageState = useTabQuery<CompanyStateResponse>(
    "state",
    id!,
    `/v1/companies/${id}/state`,
    !!id,
  );

  const pubs = publications.data?.items ?? [];
  const sorted = [...pubs].sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;

  return (
    <section>
      {/* ---- Hero ---------------------------------------------------------- */}
      <header className="company-hero">
        <h2 style={{ marginBottom: "0.25rem" }}>
          {structured.data?.name ?? summary.data?.name ?? "Firma"}
        </h2>

        {(structured.data?.corporatePurpose || profile.data?.profile) && (
          <p className="muted" style={{ maxWidth: "60ch" }}>
            {(structured.data?.corporatePurpose ?? profile.data?.profile ?? "")
              .slice(0, 240)}
            {(structured.data?.corporatePurpose ?? profile.data?.profile ?? "")
              .length > 240 && "…"}
          </p>
        )}

        {profile.data?.keywords && profile.data.keywords.length > 0 && (
          <ul className="chips" style={{ marginTop: "0.5rem" }}>
            {profile.data.keywords.slice(0, 8).map((k) => (
              <li key={k} className="chip">
                {k}
              </li>
            ))}
          </ul>
        )}

        <div className="kpi-grid">
          <KpiTile label="Standort">
            <AddressLink
              parts={[structured.data?.zipCode, structured.data?.city]}
            />
          </KpiTile>
          {structured.data?.foundingYear && (
            <KpiTile label="Gegründet">
              {String(structured.data.foundingYear)}
            </KpiTile>
          )}
          {latest?.employeeCount != null && (
            <KpiTile label="Mitarbeiter">
              {numFmt.format(latest.employeeCount)}
            </KpiTile>
          )}
          {website.data?.companySerp?.url && (
            <KpiTile label="Website">
              <a href={website.data.companySerp.url} target="_blank" rel="noreferrer">
                Aufrufen ↗
              </a>
            </KpiTile>
          )}
        </div>
      </header>

      {/* ---- Datenqualität (v0.1.65) ------------------------------------- */}
      {stageState.data && (
        <DataQualityBanner stages={stageState.data.stages} />
      )}

      {/* ---- Deep-research strip ------------------------------------------ */}
      {website.data?.deepResearches && website.data.deepResearches.length > 0 && (
        <DeepResearchStrip items={website.data.deepResearches} />
      )}

      {/* ---- Tabs --------------------------------------------------------- */}
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
            title={t.workflow}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="tab-body">
        {tab === "overview" && (
          <OverviewTab
            profile={profile.data}
            structured={structured.data}
            website={website.data}
          />
        )}
        {tab === "financials" && <FinancialsTab pubs={sorted} />}
        {tab === "management" && <ManagementTab structured={structured.data} />}
        {tab === "contacts" && <ContactsTab id={id!} />}
        {tab === "insights" && (
          <InsightsTab structured={structured.data} website={website.data} latest={latest} />
        )}
        {tab === "jobs" && <JobsTab jobs={website.data?.jobPostings ?? []} />}
      </div>
    </section>
  );
}

function KpiTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kpi-tile">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{children}</div>
    </div>
  );
}

// ---- Datenqualität banner (v0.1.65) ---------------------------------------
//
// Surfaces per-stage LLM provenance: the tier (S/A/B/C) and exact
// model id that produced each cell. Top line shows the *worst* tier
// across all stages — that's the trustworthy signal for the page as a
// whole ("this company's data is only as good as its weakest source").
// Per-stage rows below give the model + freshness on hover.
//
// Rationale (recommended in the LLM-tracking design pass): a single
// banner + hover tooltips beats inline pills next to every cell — keeps
// the existing dense layout readable while making provenance one click
// away. Hidden entirely when no LLM stage has run yet (all-null state).

function DataQualityBanner({ stages }: { stages: Record<string, StageState> }) {
  const llmStages = Object.entries(stages).filter(
    ([, s]) => s.llmTier != null,
  );
  if (llmStages.length === 0) return null;

  // Worst tier = lowest number. tier=null is filtered above.
  const worstTier = Math.min(
    ...llmStages.map(([, s]) => s.llmTier as number),
  );
  const worstStages = llmStages
    .filter(([, s]) => s.llmTier === worstTier)
    .map(([k]) => STAGE_LABEL[k] ?? k);

  return (
    <div
      className="ct-card data-quality"
      style={{
        marginTop: "1rem",
        padding: "0.75rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
      title={TIER_DESCRIPTION}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span
          className={`dot ${TIER_DOT[worstTier]}`}
          aria-hidden="true"
          style={{ flex: "0 0 auto" }}
        />
        <strong>Datenqualität: {TIER_LABEL[worstTier]}</strong>
        <span className="muted small">
          · schwächste Quelle: {worstStages.join(", ")}
        </span>
      </div>
      <ul
        className="data-quality__stages"
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem 1.25rem",
        }}
      >
        {Object.entries(stages).map(([key, s]) => (
          <DataQualityRow key={key} stageKey={key} stage={s} />
        ))}
      </ul>
    </div>
  );
}

function DataQualityRow({
  stageKey,
  stage,
}: {
  stageKey: string;
  stage: StageState;
}) {
  const label = STAGE_LABEL[stageKey] ?? stageKey;
  const tierLetter = stage.llmTier ? TIER_LETTER[stage.llmTier] : null;
  const dotClass = stage.llmTier ? TIER_DOT[stage.llmTier] : "muted";
  const updated = stage.updatedAt ? fmtDate(stage.updatedAt) : null;
  const tooltip = [
    label,
    stage.llmModel ? `Modell: ${stage.llmModel}` : "kein Modell",
    tierLetter ? `Tier ${tierLetter}` : "tier-frei",
    updated ? `aktualisiert: ${updated}` : "noch nicht erzeugt",
  ].join(" · ");

  return (
    <li
      style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
      title={tooltip}
    >
      <span className={`dot ${dotClass}`} aria-hidden="true" />
      <span>{label}</span>
      <span className="muted small">
        {stage.llmModel ?? (stage.llmTier === null && stage.updatedAt ? "scrape" : "")}
        {tierLetter ? ` · Tier ${tierLetter}` : ""}
      </span>
    </li>
  );
}

// ---- Deep-research strip ---------------------------------------------------

function DeepResearchStrip({ items }: { items: DeepResearch[] }) {
  const [expanded, setExpanded] = useState(false);
  const more = items.length > 4;
  const shown = expanded ? items : items.slice(0, 4);

  const labelFor = (t?: string) => {
    switch ((t ?? "").toUpperCase()) {
      case "EXPANSION":
        return "Expansion";
      case "TENDER":
        return "Ausschreibung";
      case "PROCUREMENT":
        return "Beschaffung";
      default:
        return "Sonstiges";
    }
  };

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h3 style={{ marginBottom: "0.25rem" }}>Aktuelle Ereignisse &amp; Signale</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Expansionen, Ausschreibungen und Beschaffungschancen
      </p>
      <div className="grid-2" style={{ marginTop: "1rem" }}>
        {shown.map((r, i) => (
          <article key={i} className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
              <span className="badge">{labelFor(r.type)}</span>
              {r.company && <span className="muted">{r.company}</span>}
            </div>
            <h4 style={{ margin: "0.5rem 0 0.25rem" }}>{r.title ?? "Ohne Titel"}</h4>
            <div className="muted" style={{ fontSize: 12, marginBottom: "0.5rem" }}>
              {[r.country, r.date ? fmtDate(r.date) : null]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {Array.isArray(r.citations) && r.citations.length > 0 && (
              <ul className="list" style={{ marginBottom: "0.5rem" }}>
                {r.citations.slice(0, 3).map((c, j) => (
                  <li key={j} style={{ wordBreak: "break-all" }}>
                    <a href={c} target="_blank" rel="noreferrer">
                      {c}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {r.url && (
              <a href={r.url} target="_blank" rel="noreferrer">
                Details ↗
              </a>
            )}
          </article>
        ))}
      </div>
      {more && (
        <div style={{ marginTop: "0.75rem" }}>
          <button type="button" className="tab" onClick={() => setExpanded((p) => !p)}>
            {expanded ? "Weniger anzeigen" : `Alle anzeigen (${items.length})`}
          </button>
        </div>
      )}
    </section>
  );
}

// ---- Tabs ------------------------------------------------------------------

function OverviewTab({
  profile,
  structured,
  website,
}: {
  profile?: CompanyProfile;
  structured?: StructuredContent;
  website?: Website;
}) {
  if (!profile && !structured && !website) {
    return <p className="muted">Noch keine Daten.</p>;
  }
  // Address parts get reused for the maps link AND the visible string.
  const street = [structured?.street, structured?.houseNumber]
    .filter(Boolean)
    .join(" ");
  const cityLine = [structured?.zipCode, structured?.city]
    .filter(Boolean)
    .join(" ");
  const mapsUrl = mapsHref([street, cityLine]);

  return (
    <div className="grid-2">
      <article className="panel">
        <h3>Firmenprofil</h3>
        {profile?.profile ? (
          <div className="markdown">
            <ReactMarkdown>{profile.profile}</ReactMarkdown>
          </div>
        ) : (
          <p className="muted">Noch kein Profil.</p>
        )}
        {profile?.businessPurpose && (
          <>
            <h4>Geschäftszweck</h4>
            <p className="muted">{profile.businessPurpose}</p>
          </>
        )}
        <dl className="tx-summary" style={{ marginTop: "1rem" }}>
          <div>
            <dt>Gründungsjahr</dt>
            <dd>{structured?.foundingYear ?? ""}</dd>
          </div>
          <div>
            <dt>Stammkapital</dt>
            <dd>{fmtShareCapital(structured?.shareCapital)}</dd>
          </div>
          <div>
            <dt>Rechtsform</dt>
            <dd>{structured?.legalForm ?? ""}</dd>
          </div>
          <div>
            <dt>SERP-Kategorie</dt>
            <dd>{website?.companySerp?.category ?? ""}</dd>
          </div>
        </dl>
      </article>

      <article className="panel">
        <h3>Kontakt &amp; Standort</h3>
        <h4>Adresse</h4>
        <p>
          {mapsUrl ? (
            <a href={mapsUrl} target="_blank" rel="noreferrer">
              {street || ""}
              <br />
              {cityLine || ""}{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                (Karte ↗)
              </span>
            </a>
          ) : (
            <>
              {street || ""}
              <br />
              {cityLine || ""}
            </>
          )}
        </p>
        {website?.companySerp?.phone && (
          <>
            <h4>Telefon</h4>
            <p>
              <a href={telHref(website.companySerp.phone)}>
                {website.companySerp.phone}
              </a>
            </p>
          </>
        )}
        {website?.website?.url && (
          <>
            <h4>Website</h4>
            <p>
              <a href={website.website.url} target="_blank" rel="noreferrer">
                {website.website.url.replace(/^https?:\/\//, "")} ↗
              </a>
            </p>
          </>
        )}
        {website?.companySerp?.rating != null && (
          <>
            <h4>Bewertung</h4>
            <p>
              {String(website.companySerp.rating)} ★{" "}
              {website.companySerp.reviewCount != null && (
                <span className="muted">
                  ({numFmt.format(website.companySerp.reviewCount)} Bewertungen)
                </span>
              )}
            </p>
          </>
        )}
      </article>
    </div>
  );
}

/** Render `parts` as a Google-Maps link when at least one part is non-empty. */
function AddressLink({
  parts,
}: {
  parts: Array<string | null | undefined>;
}) {
  const text = parts.filter(Boolean).join(" ");
  const url = mapsHref(parts);
  if (!text) return <></>;
  if (!url) return <>{text}</>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
}

function FinancialsTab({ pubs }: { pubs: Publication[] }) {
  if (pubs.length === 0) {
    return <p className="muted">Noch keine Veröffentlichungen.</p>;
  }

  // Build per-series rows for the four mini bar-charts. Each series is
  // skipped if every value is missing.
  const series: Array<{
    title: string;
    format: "eur" | "num";
    data: Array<{ year: number | null; value: number | null }>;
  }> = [
    {
      title: "Umsatz",
      format: "eur",
      data: pubs.map((p) => ({ year: p.year ?? null, value: numVal(p.revenueVolume) })),
    },
    {
      title: "Erlöse",
      format: "eur",
      data: pubs.map((p) => ({ year: p.year ?? null, value: numVal(p.salesVolume) })),
    },
    {
      title: "Bilanzsumme",
      format: "eur",
      data: pubs.map((p) => ({ year: p.year ?? null, value: numVal(p.totalAssetsVolume) })),
    },
    {
      title: "Mitarbeiter",
      format: "num",
      data: pubs.map((p) => ({ year: p.year ?? null, value: p.employeeCount ?? null })),
    },
  ];

  return (
    <div className="grid-2">
      {series
        .filter((s) => s.data.some((d) => d.value != null && d.value !== 0))
        .map((s) => (
          <article key={s.title} className="panel">
            <h3>{s.title}</h3>
            <BarChart data={s.data} format={s.format} />
          </article>
        ))}

      <article className="panel" style={{ gridColumn: "1 / -1" }}>
        <h3>Jahresübersicht</h3>
        <table className="matrix">
          <thead>
            <tr>
              <th>Jahr</th>
              <th>Umsatz</th>
              <th>Erlöse</th>
              <th>Bilanzsumme</th>
              <th>Mitarbeiter</th>
            </tr>
          </thead>
          <tbody>
            {[...pubs].reverse().map((p, i) => (
              <tr key={i}>
                <td>{p.year ?? ""}</td>
                <td>{fmtMoney(p.revenueVolume)}</td>
                <td>{fmtMoney(p.salesVolume)}</td>
                <td>{fmtMoney(p.totalAssetsVolume)}</td>
                <td>
                  {p.employeeCount != null ? numFmt.format(p.employeeCount) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      {/* Per-publication detail: each year's KPIs, period, and full
          stateOfAffairs aggregate. Reverse-chronological so the latest
          is on top. */}
      <section style={{ gridColumn: "1 / -1", display: "grid", gap: "1rem" }}>
        <h3 style={{ margin: 0 }}>Jahresberichte</h3>
        {[...pubs].reverse().map((p, i) => (
          <PublicationCard key={i} pub={p} />
        ))}
      </section>
    </div>
  );
}

function PublicationCard({ pub }: { pub: Publication }) {
  const soa = pub.stateOfAffairs;
  const period = fmtDateRange(pub.begin, pub.end);
  return (
    <article className="panel">
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
        }}
      >
        <h3 style={{ margin: 0 }}>
          {pub.year ?? ""}
          {pub.name && (
            <span className="muted" style={{ fontWeight: 400, marginLeft: "0.5rem" }}>
              {pub.name}
            </span>
          )}
        </h3>
        {period && <span className="muted">{period}</span>}
      </header>

      <div className="kpi-grid">
        <KpiTile label="Umsatz">{fmtMoney(pub.revenueVolume)}</KpiTile>
        <KpiTile label="Erlöse">{fmtMoney(pub.salesVolume)}</KpiTile>
        <KpiTile label="Bilanzsumme">{fmtMoney(pub.totalAssetsVolume)}</KpiTile>
        <KpiTile label="Mitarbeiter">
          {pub.employeeCount != null ? numFmt.format(pub.employeeCount) : ""}
        </KpiTile>
      </div>

      {soa?.isRelevant ? (
        <div style={{ marginTop: "1rem" }}>
          {soa.topic && soa.topic.toUpperCase() !== "NOTHING" && (
            <p style={{ margin: "0 0 0.75rem" }}>
              <span className="badge">{topicLabel(soa.topic)}</span>
            </p>
          )}
          <BulletList title="Kernpunkte" items={soa.bullets} />
          <BulletList title="Ausblick" items={soa.guidance} />
          <BulletList
            title="Risiken &amp; Chancen"
            items={soa.risksOpportunities}
          />
          {soa.kpis && soa.kpis.length > 0 && (
            <>
              <h4>KPIs</h4>
              <div className="kpi-grid">
                {soa.kpis.map((k, i) => (
                  <div key={i} className="kpi-tile">
                    <div className="kpi-label">{k.name}</div>
                    <div className="kpi-value">{k.value}</div>
                    {k.period && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {k.period}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <p className="muted" style={{ marginTop: "1rem", marginBottom: 0 }}>
          Keine Lagebericht-Zusammenfassung für diesen Bericht.
        </p>
      )}
    </article>
  );
}

function BarChart({
  data,
  format,
}: {
  data: Array<{ year: number | null; value: number | null }>;
  format: "eur" | "num";
}) {
  const filtered = data.filter((d) => d.value != null);
  if (filtered.length === 0) return <p className="muted">Keine Daten.</p>;
  const max = Math.max(...filtered.map((d) => d.value!));
  return (
    <div className="bar-chart">
      {filtered.map((d, i) => (
        <div key={i} className="bar-row">
          <span className="bar-label">{d.year ?? "?"}</span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{ width: max > 0 ? `${(d.value! / max) * 100}%` : "0%" }}
            />
          </span>
          <span className="bar-value">
            {format === "eur" ? fmtMoney(d.value!) : numFmt.format(d.value!)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ManagementTab({ structured }: { structured?: StructuredContent }) {
  const dirs = structured?.managingDirectors ?? [];
  if (dirs.length === 0) {
    return <p className="muted">Keine Angaben zur Geschäftsführung.</p>;
  }
  return (
    <div className="grid-2">
      {dirs.map((d, i) => (
        <article key={d.id ?? i} className="panel">
          <h3 style={{ margin: 0 }}>
            {[d.firstName, d.lastName].filter(Boolean).join(" ") || "Unbekannt"}
          </h3>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            Geschäftsführer:in
          </p>
          {d.city && (
            <p className="muted" style={{ fontSize: 12 }}>
              {d.city}
            </p>
          )}
          {d.birthDay && (
            <p className="muted" style={{ fontSize: 12 }}>
              Geboren am {fmtDate(d.birthDay)}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}

// Contacts tab — fact-based view ported from legacy <Contacts/>. Groups
// company-level facts by field (phone/email/address) and person-level facts
// by entityId. Each fact row shows status + confidence.

function ContactsTab({ id }: { id: string }) {
  const q = useTabQuery<CompanyContact>("contacts", id, `/v1/companies/${id}/contacts`);

  if (q.isLoading) return <p>Lädt…</p>;
  if (q.error) {
    if (q.error instanceof GatewayError && q.error.status === 404) {
      return <p className="muted">Noch keine Kontakte.</p>;
    }
    return <p className="error">{(q.error as Error).message}</p>;
  }
  const data = q.data;
  if (!data || !Array.isArray(data.companyFacts) || data.companyFacts.length === 0) {
    return <p className="muted">Noch keine Kontakte.</p>;
  }

  const facts = data.companyFacts;
  const companyFacts = facts.filter((f) => f.entityType === "COMPANY");
  const personFacts = facts.filter((f) => f.entityType === "PERSON");

  const byField = groupBy(companyFacts, (f) => f.field ?? "other");
  const byPerson = groupBy(personFacts, (f) => f.entityId ?? "?");

  const phones = (byField.phone ?? []).filter((f) => f.status === "ACTIVE");
  const emails = (byField.email ?? []).filter((f) => f.status === "ACTIVE");
  const addresses = (byField.address ?? []).filter((f) => f.status === "ACTIVE");

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <article className="panel">
        <h3 style={{ marginTop: 0 }}>Kontakte &amp; Personen</h3>
        <div className="kpi-grid">
          <KpiTile label="Telefonnummern">{numFmt.format(phones.length)}</KpiTile>
          <KpiTile label="E-Mail-Adressen">{numFmt.format(emails.length)}</KpiTile>
          <KpiTile label="Personen">
            {numFmt.format(Object.keys(byPerson).length)}
          </KpiTile>
        </div>
      </article>

      <FactGroup title="Telefon" kind="phone" facts={phones} />
      <FactGroup title="E-Mail" kind="email" facts={emails} />
      <FactGroup title="Adressen" kind="address" facts={addresses} />

      {Object.keys(byPerson).length > 0 && (
        <section>
          <h3>
            Zugeordnete Personen ({numFmt.format(Object.keys(byPerson).length)})
          </h3>
          <div className="grid-2">
            {Object.entries(byPerson).map(([pid, pf]) => (
              <PersonCard key={pid} facts={pf} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Render a fact's value as a clickable link when its `kind` (or content
 * sniff) maps to a URI scheme: phones → `tel:`, emails → `mailto:`,
 * addresses → Google Maps. Falls back to plain text otherwise.
 */
function FactValue({
  value,
  kind,
}: {
  value: string;
  kind?: "phone" | "email" | "address" | "url";
}) {
  const isPhone = kind === "phone" || (kind === undefined && looksLikePhone(value));
  const isEmail = kind === "email" || (kind === undefined && looksLikeEmail(value));
  // URL kind sniff: explicit `kind === "url"` (set on linkedinUrl /
  // xingUrl / websiteUrl fields) wins; otherwise auto-detect any
  // http(s) value so a stray URL in a generic fact still becomes
  // clickable. The explicit kind controls icon choice; the auto-
  // detected branch falls back to a generic globe.
  const isUrl =
    kind === "url" || (kind === undefined && looksLikeHttpUrl(value));
  if (isPhone) {
    return <a href={telHref(value)}>{value}</a>;
  }
  if (isEmail) {
    return <a href={mailHref(value)}>{value}</a>;
  }
  if (kind === "address") {
    const url = mapsHref([value]);
    return url ? (
      <a href={url} target="_blank" rel="noreferrer">
        {value}
      </a>
    ) : (
      <>{value}</>
    );
  }
  if (isUrl) {
    return (
      <ExternalLink href={value} className="fact-url">
        <UrlIcon href={value} />
        <span className="fact-url__label">{value}</span>
      </ExternalLink>
    );
  }
  return <>{value}</>;
}

function UrlIcon({ href }: { href: string }) {
  const host = (() => {
    try {
      return new URL(href).host.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (/(^|\.)linkedin\.com$/.test(host)) return <LinkedInIcon size={14} />;
  if (/(^|\.)xing\.com$/.test(host)) return <XingIcon size={14} />;
  return <GlobeIcon size={14} />;
}

function looksLikeHttpUrl(value: string): boolean {
  if (!value) return false;
  return /^https?:\/\/[^\s]+$/i.test(value.trim());
}

function FactGroup({
  title,
  facts,
  kind,
}: {
  title: string;
  facts: Fact[];
  kind?: "phone" | "email" | "address";
}) {
  if (facts.length === 0) return null;
  return (
    <article className="panel">
      <h3 style={{ marginTop: 0 }}>
        {title} ({numFmt.format(facts.length)})
      </h3>
      <ul className="list">
        {facts.map((f, i) => (
          <li key={f.id ?? i} className="fact-row">
            <span className="fact-value">
              {f.value ? <FactValue value={f.value} kind={kind} /> : ""}
            </span>
            {f.normalized && f.normalized !== f.value && (
              <span className="muted fact-normalized">{f.normalized}</span>
            )}
            <span className="fact-meta">
              <StatusPill status={f.status} />
              <ConfidenceBar confidence={f.confidence} />
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function PersonCard({ facts }: { facts: Fact[] }) {
  const find = (field: string) => facts.find((f) => f.field === field);
  const name = find("fullName")?.value ?? "Unbekannte Person";
  const job = facts.find((f) => f.field === "jobTitle" && f.status === "ACTIVE");
  const dept = find("department");
  const xing = find("xingUrl");
  const linkedin = find("linkedinUrl");

  const display = facts.filter(
    (f) => !["fullName", "identityKey", "employmentCompanyId"].includes(f.field ?? ""),
  );

  // Map a fact `field` → the link kind so contact rows on a person card
  // also dial / open mail / open maps / open URL with the right icon
  // and (for LinkedIn) the warning gate.
  const kindFor = (
    field?: string,
  ): "phone" | "email" | "address" | "url" | undefined => {
    switch (field) {
      case "phone":
      case "mobilePhone":
        return "phone";
      case "email":
        return "email";
      case "address":
        return "address";
      case "linkedinUrl":
      case "xingUrl":
      case "websiteUrl":
      case "homepage":
      case "url":
        return "url";
      default:
        return undefined;
    }
  };

  return (
    <article className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div>
          <h4 style={{ margin: 0 }}>{name}</h4>
          {job && (
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              {job.value}
              {dept && ` · ${dept.value}`}
            </p>
          )}
        </div>
        <div className="person-card__socials">
          {xing?.value && (
            <ExternalLink
              href={xing.value}
              className="social-icon-link"
              title="XING-Profil öffnen"
            >
              <span className="visually-hidden">XING</span>
              <XingIcon size={18} />
            </ExternalLink>
          )}
          {linkedin?.value && (
            <ExternalLink
              href={linkedin.value}
              className="social-icon-link"
              title="LinkedIn-Profil öffnen"
            >
              <span className="visually-hidden">LinkedIn</span>
              <LinkedInIcon size={18} />
            </ExternalLink>
          )}
        </div>
      </div>
      {display.length > 0 && (
        <ul className="list" style={{ marginTop: "0.75rem" }}>
          {display.map((f, i) => (
            <li key={f.id ?? i} className="fact-row">
              <span className="muted">{fieldLabel(f.field ?? "")}:</span>
              <span className="fact-value">
                {f.value ? <FactValue value={f.value} kind={kindFor(f.field)} /> : ""}
              </span>
              <span className="fact-meta">
                <StatusPill status={f.status} />
                <ConfidenceBar confidence={f.confidence} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function StatusPill({ status }: { status?: string }) {
  if (!status) return null;
  const cls = status === "ACTIVE" ? "ok" : "warn";
  return <span className={`badge ${cls}`}>{status}</span>;
}

function ConfidenceBar({ confidence }: { confidence?: number }) {
  if (confidence == null) return null;
  const pct = Math.round(confidence * 100);
  return (
    <span className="confidence">
      <span className="confidence-track">
        <span className="confidence-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="muted" style={{ fontSize: 11 }}>
        {pct}%
      </span>
    </span>
  );
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    phone: "Telefon",
    mobilePhone: "Mobil",
    email: "E-Mail",
    address: "Adresse",
    fullName: "Name",
    jobTitle: "Position",
    department: "Abteilung",
    xingUrl: "XING",
    linkedinUrl: "LinkedIn",
  };
  return labels[field] ?? field;
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce(
    (acc, it) => {
      const k = key(it);
      (acc[k] ??= []).push(it);
      return acc;
    },
    {} as Record<string, T[]>,
  );
}

// Insights — derived signals (industry position, company age) plus a
// latest-financials snapshot. The full per-publication stateOfAffairs
// narrative lives on the Financials tab now (one card per year), so we
// don't duplicate it here.

function InsightsTab({
  structured,
  website,
  latest,
}: {
  structured?: StructuredContent;
  website?: Website;
  latest?: Publication;
}) {
  const founding = structured?.foundingYear
    ? Number(structured.foundingYear)
    : null;
  const age =
    founding && Number.isFinite(founding) ? new Date().getFullYear() - founding : null;

  return (
    <div className="grid-2">
      <article className="panel">
        <h3 style={{ marginTop: 0 }}>Erkenntnisse</h3>
        <dl className="tx-summary">
          <div>
            <dt>Branche</dt>
            <dd>{website?.companySerp?.category ?? ""}</dd>
          </div>
          <div>
            <dt>Firmenalter</dt>
            <dd>{age != null ? `${age} Jahre am Markt` : ""}</dd>
          </div>
          <div>
            <dt>Unternehmensgegenstand</dt>
            <dd>{structured?.corporatePurpose ?? ""}</dd>
          </div>
        </dl>
      </article>

      <article className="panel">
        <h3 style={{ marginTop: 0 }}>Aktuelle Finanzen</h3>
        {latest ? (
          <dl className="tx-summary">
            <div>
              <dt>Letztes Berichtsjahr</dt>
              <dd>{latest.year ?? ""}</dd>
            </div>
            <div>
              <dt>Mitarbeiter</dt>
              <dd>
                {latest.employeeCount != null
                  ? numFmt.format(latest.employeeCount)
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Umsatz</dt>
              <dd>{fmtMoney(latest.revenueVolume)}</dd>
            </div>
            <div>
              <dt>Erlöse</dt>
              <dd>{fmtMoney(latest.salesVolume)}</dd>
            </div>
            <div>
              <dt>Bilanzsumme</dt>
              <dd>{fmtMoney(latest.totalAssetsVolume)}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">Noch keine Veröffentlichungen.</p>
        )}
      </article>
    </div>
  );
}

function BulletList({ title, items }: { title: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul>
        {items.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
    </>
  );
}

function topicLabel(t?: string | null): string {
  switch ((t ?? "").toUpperCase()) {
    case "ECONOMIC_STATE":
      return "Wirtschaftslage";
    case "FORECAST":
      return "Prognose";
    case "ALL":
      return "Gesamtüberblick";
    default:
      return t ?? "";
  }
}

function JobsTab({ jobs }: { jobs: JobPosting[] }) {
  const [expanded, setExpanded] = useState(false);
  if (jobs.length === 0) return <p className="muted">Noch keine Stellenanzeigen.</p>;
  const more = jobs.length > 4;
  const shown = expanded ? jobs : jobs.slice(0, 4);
  return (
    <>
      <div className="grid-2">
        {shown.map((j, i) => (
          <article key={i} className="panel">
            <h3 style={{ marginTop: 0 }}>{j.title ?? "Ohne Titel"}</h3>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              {[
                j.location,
                j.workingModel,
                j.releaseDate ? fmtDate(j.releaseDate) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {j.sourceUrl && (
              <p>
                <a href={j.sourceUrl} target="_blank" rel="noreferrer">
                  Quelle öffnen ↗
                </a>
              </p>
            )}
            {j.description && <p>{j.description}</p>}
            {Array.isArray(j.requirements) && j.requirements.length > 0 && (
              <>
                <h4>Anforderungen</h4>
                <ul>
                  {j.requirements.map((r, k) => (
                    <li key={k}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {Array.isArray(j.technologies) && j.technologies.length > 0 && (
              <>
                <h4>Technologien</h4>
                <ul className="chips">
                  {j.technologies.map((t, k) => (
                    <li key={k} className="chip">
                      {t}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </article>
        ))}
      </div>
      {more && (
        <div style={{ marginTop: "0.75rem" }}>
          <button type="button" className="tab" onClick={() => setExpanded((p) => !p)}>
            {expanded ? "Weniger anzeigen" : `Alle anzeigen (${jobs.length})`}
          </button>
        </div>
      )}
    </>
  );
}
