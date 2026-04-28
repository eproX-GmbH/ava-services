import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { gatewayFetch, GatewayError } from "../api/gateway";

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
  { key: "overview", label: "Overview", workflow: "W8/W10" },
  { key: "financials", label: "Financials", workflow: "W11" },
  { key: "management", label: "Management", workflow: "W13" },
  { key: "contacts", label: "Contacts", workflow: "W12" },
  { key: "insights", label: "Insights", workflow: "W11" },
  { key: "jobs", label: "Jobs", workflow: "W10" },
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

// ---- Helpers ---------------------------------------------------------------

const euro = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function numVal(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    const n = (v as { value?: unknown }).value;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  }
  return null;
}

function currencySymbol(c?: string | null): string {
  switch ((c ?? "").toUpperCase()) {
    case "EUR":
      return "€";
    case "USD":
      return "$";
    case "GBP":
      return "£";
    default:
      return c ? ` ${c}` : " €";
  }
}

function fmtMoney(v: unknown): string {
  const n = numVal(v);
  if (n == null) return "—";
  const cur =
    typeof v === "object" && v !== null && "currency" in v
      ? ((v as { currency?: string | null }).currency ?? null)
      : null;
  const sym = currencySymbol(cur);
  // Symbol + value for €/$/£; trailing-code form for unknown currencies.
  if (sym === "€" || sym === "$" || sym === "£") return `${euro.format(n)} ${sym}`;
  return `${euro.format(n)}${sym}`;
}

function fmtDateRange(begin?: string | null, end?: string | null): string {
  const fmt = (d?: string | null) => {
    if (!d) return null;
    try {
      return new Date(d).toLocaleDateString("de-DE");
    } catch {
      return d;
    }
  };
  const b = fmt(begin);
  const e = fmt(end);
  if (b && e) return `${b} – ${e}`;
  return b ?? e ?? "";
}

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

// ---- Page ------------------------------------------------------------------

export function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<TabKey>("overview");

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

  const pubs = publications.data?.items ?? [];
  const sorted = [...pubs].sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;

  return (
    <section>
      {/* ---- Hero ---------------------------------------------------------- */}
      <header className="company-hero">
        <h2 style={{ marginBottom: "0.25rem" }}>
          {structured.data?.name ?? summary.data?.name ?? "Company"}{" "}
          <span className="muted">
            <code>{id?.slice(0, 12)}…</code>
          </span>
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
          <KpiTile label="Location">
            {[structured.data?.zipCode, structured.data?.city]
              .filter(Boolean)
              .join(" ") || "—"}
          </KpiTile>
          {structured.data?.foundingYear && (
            <KpiTile label="Founded">{String(structured.data.foundingYear)}</KpiTile>
          )}
          {latest?.employeeCount != null && (
            <KpiTile label="Employees">
              {latest.employeeCount.toLocaleString()}
            </KpiTile>
          )}
          {website.data?.companySerp?.url && (
            <KpiTile label="Website">
              <a href={website.data.companySerp.url} target="_blank" rel="noreferrer">
                Visit ↗
              </a>
            </KpiTile>
          )}
        </div>
      </header>

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
        return "Tender";
      case "PROCUREMENT":
        return "Procurement";
      default:
        return "Other";
    }
  };

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h3 style={{ marginBottom: "0.25rem" }}>Recent events &amp; signals</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Expansions, tenders and procurement opportunities
      </p>
      <div className="grid-2" style={{ marginTop: "1rem" }}>
        {shown.map((r, i) => (
          <article key={i} className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
              <span className="badge">{labelFor(r.type)}</span>
              {r.company && <span className="muted">{r.company}</span>}
            </div>
            <h4 style={{ margin: "0.5rem 0 0.25rem" }}>{r.title ?? "Untitled"}</h4>
            <div className="muted" style={{ fontSize: 12, marginBottom: "0.5rem" }}>
              {[r.country, r.date].filter(Boolean).join(" · ")}
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
            {expanded ? "Show less" : `Show all (${items.length})`}
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
    return <p className="muted">No data yet.</p>;
  }
  return (
    <div className="grid-2">
      <article className="panel">
        <h3>Company profile</h3>
        {profile?.profile ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{profile.profile}</p>
        ) : (
          <p className="muted">No profile yet.</p>
        )}
        {profile?.businessPurpose && (
          <>
            <h4>Business purpose</h4>
            <p className="muted">{profile.businessPurpose}</p>
          </>
        )}
        <dl className="tx-summary" style={{ marginTop: "1rem" }}>
          <div>
            <dt>Founding year</dt>
            <dd>{structured?.foundingYear ?? "—"}</dd>
          </div>
          <div>
            <dt>Share capital</dt>
            <dd>{structured?.shareCapital ?? "—"}</dd>
          </div>
          <div>
            <dt>Legal form</dt>
            <dd>{structured?.legalForm ?? "—"}</dd>
          </div>
          <div>
            <dt>SERP category</dt>
            <dd>{website?.companySerp?.category ?? "—"}</dd>
          </div>
        </dl>
      </article>

      <article className="panel">
        <h3>Contact &amp; location</h3>
        <h4>Address</h4>
        <p>
          {[structured?.street, structured?.houseNumber].filter(Boolean).join(" ") || "—"}
          <br />
          {[structured?.zipCode, structured?.city].filter(Boolean).join(" ") || "—"}
        </p>
        {website?.companySerp?.phone && (
          <>
            <h4>Phone</h4>
            <p>{website.companySerp.phone}</p>
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
            <h4>Rating</h4>
            <p>
              {String(website.companySerp.rating)} ★{" "}
              {website.companySerp.reviewCount != null && (
                <span className="muted">({website.companySerp.reviewCount} reviews)</span>
              )}
            </p>
          </>
        )}
      </article>
    </div>
  );
}

function FinancialsTab({ pubs }: { pubs: Publication[] }) {
  if (pubs.length === 0) {
    return <p className="muted">No publications yet.</p>;
  }

  // Build per-series rows for the four mini bar-charts. Each series is
  // skipped if every value is missing.
  const series: Array<{ title: string; format: "eur" | "num"; data: Array<{ year: number | null; value: number | null }> }> = [
    {
      title: "Revenue",
      format: "eur",
      data: pubs.map((p) => ({ year: p.year ?? null, value: numVal(p.revenueVolume) })),
    },
    {
      title: "Sales",
      format: "eur",
      data: pubs.map((p) => ({ year: p.year ?? null, value: numVal(p.salesVolume) })),
    },
    {
      title: "Total assets",
      format: "eur",
      data: pubs.map((p) => ({ year: p.year ?? null, value: numVal(p.totalAssetsVolume) })),
    },
    {
      title: "Employees",
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
        <h3>Yearly breakdown</h3>
        <table className="matrix">
          <thead>
            <tr>
              <th>Year</th>
              <th>Revenue</th>
              <th>Sales</th>
              <th>Total assets</th>
              <th>Employees</th>
            </tr>
          </thead>
          <tbody>
            {[...pubs].reverse().map((p, i) => (
              <tr key={i}>
                <td>{p.year ?? "—"}</td>
                <td>{fmtMoney(p.revenueVolume)}</td>
                <td>{fmtMoney(p.salesVolume)}</td>
                <td>{fmtMoney(p.totalAssetsVolume)}</td>
                <td>{p.employeeCount ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>

      {/* Per-publication detail: each year's KPIs, period, and full
          stateOfAffairs aggregate (topic, bullets, guidance, risks &
          opportunities, KPIs). Reverse-chronological so the latest is on top. */}
      <section style={{ gridColumn: "1 / -1", display: "grid", gap: "1rem" }}>
        <h3 style={{ margin: 0 }}>Annual reports</h3>
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
          {pub.year ?? "—"}
          {pub.name && (
            <span className="muted" style={{ fontWeight: 400, marginLeft: "0.5rem" }}>
              {pub.name}
            </span>
          )}
        </h3>
        {period && <span className="muted">{period}</span>}
      </header>

      <div className="kpi-grid">
        <KpiTile label="Revenue">{fmtMoney(pub.revenueVolume)}</KpiTile>
        <KpiTile label="Sales">{fmtMoney(pub.salesVolume)}</KpiTile>
        <KpiTile label="Total assets">{fmtMoney(pub.totalAssetsVolume)}</KpiTile>
        <KpiTile label="Employees">
          {pub.employeeCount != null ? pub.employeeCount.toLocaleString() : "—"}
        </KpiTile>
      </div>

      {soa?.isRelevant ? (
        <div style={{ marginTop: "1rem" }}>
          {soa.topic && soa.topic.toUpperCase() !== "NOTHING" && (
            <p style={{ margin: "0 0 0.75rem" }}>
              <span className="badge">{topicLabel(soa.topic)}</span>
            </p>
          )}
          <BulletList title="Key points" items={soa.bullets} />
          <BulletList title="Guidance" items={soa.guidance} />
          <BulletList title="Risks &amp; opportunities" items={soa.risksOpportunities} />
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
          No state-of-affairs narrative for this report.
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
  if (filtered.length === 0) return <p className="muted">No data.</p>;
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
            {format === "eur" ? `${euro.format(d.value!)} €` : d.value!.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

function ManagementTab({ structured }: { structured?: StructuredContent }) {
  const dirs = structured?.managingDirectors ?? [];
  if (dirs.length === 0) {
    return <p className="muted">No management information.</p>;
  }
  return (
    <div className="grid-2">
      {dirs.map((d, i) => (
        <article key={d.id ?? i} className="panel">
          <h3 style={{ margin: 0 }}>
            {[d.firstName, d.lastName].filter(Boolean).join(" ") || "Unknown"}
          </h3>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            Managing director
          </p>
          {d.city && (
            <p className="muted" style={{ fontSize: 12 }}>
              {d.city}
            </p>
          )}
          {d.birthDay && (
            <p className="muted" style={{ fontSize: 12 }}>
              Born {d.birthDay}
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

  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) {
    if (q.error instanceof GatewayError && q.error.status === 404) {
      return <p className="muted">No contacts yet.</p>;
    }
    return <p className="error">{(q.error as Error).message}</p>;
  }
  const data = q.data;
  if (!data || !Array.isArray(data.companyFacts) || data.companyFacts.length === 0) {
    return <p className="muted">No contacts yet.</p>;
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
        <h3 style={{ marginTop: 0 }}>Contacts &amp; people</h3>
        <div className="kpi-grid">
          <KpiTile label="Phone numbers">{phones.length}</KpiTile>
          <KpiTile label="Email addresses">{emails.length}</KpiTile>
          <KpiTile label="People">{Object.keys(byPerson).length}</KpiTile>
        </div>
      </article>

      <FactGroup title="Phones" facts={phones} />
      <FactGroup title="Emails" facts={emails} />
      <FactGroup title="Addresses" facts={addresses} />

      {Object.keys(byPerson).length > 0 && (
        <section>
          <h3>Associated people ({Object.keys(byPerson).length})</h3>
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

function FactGroup({ title, facts }: { title: string; facts: Fact[] }) {
  if (facts.length === 0) return null;
  return (
    <article className="panel">
      <h3 style={{ marginTop: 0 }}>
        {title} ({facts.length})
      </h3>
      <ul className="list">
        {facts.map((f, i) => (
          <li key={f.id ?? i} className="fact-row">
            <span className="fact-value">{f.value ?? "—"}</span>
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
  const name = find("fullName")?.value ?? "Unknown person";
  const job = facts.find((f) => f.field === "jobTitle" && f.status === "ACTIVE");
  const dept = find("department");
  const xing = find("xingUrl");
  const linkedin = find("linkedinUrl");

  const display = facts.filter(
    (f) => !["fullName", "identityKey", "employmentCompanyId"].includes(f.field ?? ""),
  );

  return (
    <article className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div>
          <h4 style={{ margin: 0 }}>{name}</h4>
          {job && (
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              {job.value}
              {dept && ` — ${dept.value}`}
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {xing?.value && (
            <a href={xing.value} target="_blank" rel="noreferrer" title="XING">
              X↗
            </a>
          )}
          {linkedin?.value && (
            <a href={linkedin.value} target="_blank" rel="noreferrer" title="LinkedIn">
              in↗
            </a>
          )}
        </div>
      </div>
      {display.length > 0 && (
        <ul className="list" style={{ marginTop: "0.75rem" }}>
          {display.map((f, i) => (
            <li key={f.id ?? i} className="fact-row">
              <span className="muted">{fieldLabel(f.field ?? "")}:</span>
              <span className="fact-value">{f.value ?? "—"}</span>
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
    phone: "Phone",
    email: "Email",
    address: "Address",
    fullName: "Name",
    jobTitle: "Title",
    department: "Department",
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
        <h3 style={{ marginTop: 0 }}>Company insights</h3>
        <dl className="tx-summary">
          <div>
            <dt>Industry position</dt>
            <dd>{website?.companySerp?.category ?? "—"}</dd>
          </div>
          <div>
            <dt>Company age</dt>
            <dd>{age != null ? `${age} years in business` : "—"}</dd>
          </div>
          <div>
            <dt>Corporate purpose</dt>
            <dd>{structured?.corporatePurpose ?? "—"}</dd>
          </div>
        </dl>
      </article>

      <article className="panel">
        <h3 style={{ marginTop: 0 }}>Latest financials</h3>
        {latest ? (
          <dl className="tx-summary">
            <div>
              <dt>Latest report year</dt>
              <dd>{latest.year ?? "—"}</dd>
            </div>
            <div>
              <dt>Employees</dt>
              <dd>{latest.employeeCount?.toLocaleString() ?? "—"}</dd>
            </div>
            <div>
              <dt>Revenue</dt>
              <dd>{fmtMoney(latest.revenueVolume)}</dd>
            </div>
            <div>
              <dt>Sales</dt>
              <dd>{fmtMoney(latest.salesVolume)}</dd>
            </div>
            <div>
              <dt>Total assets</dt>
              <dd>{fmtMoney(latest.totalAssetsVolume)}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">No publications yet.</p>
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
      return "Economic state";
    case "FORECAST":
      return "Forecast";
    case "ALL":
      return "Full overview";
    default:
      return t ?? "—";
  }
}

function JobsTab({ jobs }: { jobs: JobPosting[] }) {
  const [expanded, setExpanded] = useState(false);
  if (jobs.length === 0) return <p className="muted">No jobs yet.</p>;
  const more = jobs.length > 4;
  const shown = expanded ? jobs : jobs.slice(0, 4);
  return (
    <>
      <div className="grid-2">
        {shown.map((j, i) => (
          <article key={i} className="panel">
            <h3 style={{ marginTop: 0 }}>{j.title ?? "Untitled role"}</h3>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
              {[j.location, j.workingModel, j.releaseDate].filter(Boolean).join(" · ")}
            </p>
            {j.sourceUrl && (
              <p>
                <a href={j.sourceUrl} target="_blank" rel="noreferrer">
                  Open source ↗
                </a>
              </p>
            )}
            {j.description && <p>{j.description}</p>}
            {Array.isArray(j.requirements) && j.requirements.length > 0 && (
              <>
                <h4>Requirements</h4>
                <ul>
                  {j.requirements.map((r, k) => (
                    <li key={k}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {Array.isArray(j.technologies) && j.technologies.length > 0 && (
              <>
                <h4>Technologies</h4>
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
            {expanded ? "Show less" : `Show all (${jobs.length})`}
          </button>
        </div>
      )}
    </>
  );
}
