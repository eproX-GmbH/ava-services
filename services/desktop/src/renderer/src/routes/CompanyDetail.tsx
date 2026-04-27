import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { gatewayFetch, GatewayError } from "../api/gateway";

// W8–W13 — single company drill-down.
//
// Tabs map 1:1 to the §4.1 endpoints. We lazy-load each tab's data only when
// it's selected — the per-service upstreams are independent, and
// pre-fetching all six on every page view would be wasteful for users who
// only care about (say) the website tab.
//
// 404s from upstream are normal here ("this company has no profile yet" —
// pipeline hasn't run / tenant scope mismatch / etc.). We surface those as
// an empty state per tab rather than a hard error.

type TabKey =
  | "profile"
  | "keywords"
  | "website"
  | "publications"
  | "contacts"
  | "structured";

const TABS: Array<{ key: TabKey; label: string; workflow: string }> = [
  { key: "profile", label: "Profile", workflow: "W8" },
  { key: "keywords", label: "Keywords", workflow: "W9" },
  { key: "website", label: "Website", workflow: "W10" },
  { key: "publications", label: "Publications", workflow: "W11" },
  { key: "contacts", label: "Contacts", workflow: "W12" },
  { key: "structured", label: "Structured", workflow: "W13" },
];

export function CompanyDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<TabKey>("profile");

  const summary = useQuery({
    queryKey: ["company", id],
    queryFn: () => gatewayFetch<{ id: string; name?: string; city?: string }>(`/v1/companies/${id}`),
    enabled: !!id,
  });

  return (
    <section>
      <h2>
        {summary.data?.name ?? "Company"}{" "}
        <span className="muted">
          <code>{id?.slice(0, 12)}…</code>
        </span>
      </h2>
      {summary.data?.city && <p className="muted">{summary.data.city}</p>}

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
        {tab === "profile" && <ProfileTab id={id!} />}
        {tab === "keywords" && <KeywordsTab id={id!} />}
        {tab === "website" && <WebsiteTab id={id!} />}
        {tab === "publications" && <PublicationsTab id={id!} />}
        {tab === "contacts" && <ContactsTab id={id!} />}
        {tab === "structured" && <StructuredTab id={id!} />}
      </div>
    </section>
  );
}

// ---- Tabs ------------------------------------------------------------------

function useTabQuery<T>(key: string, id: string, path: string) {
  return useQuery<T>({
    queryKey: ["company", id, key],
    queryFn: () => gatewayFetch<T>(path),
    retry: (count, err) => {
      // Don't hammer 404s — those mean "no data yet", not a transient failure.
      if (err instanceof GatewayError && err.status === 404) return false;
      return count < 1;
    },
  });
}

function TabState({
  q,
  empty,
  children,
}: {
  q: { isLoading: boolean; error: unknown; data: unknown };
  empty?: string;
  children: React.ReactNode;
}) {
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) {
    if (q.error instanceof GatewayError && q.error.status === 404) {
      return <p className="muted">{empty ?? "No data yet."}</p>;
    }
    return <p className="error">{(q.error as Error).message}</p>;
  }
  return <>{children}</>;
}

interface CompanyProfile {
  companyId: string;
  text?: string | null;
  businessPurpose?: string | null;
}
function ProfileTab({ id }: { id: string }) {
  const q = useTabQuery<CompanyProfile>("profile", id, `/v1/companies/${id}/profile`);
  return (
    <TabState q={q} empty="No profile extracted yet.">
      {q.data && (
        <dl>
          <dt>Profile</dt>
          <dd>{q.data.text || <span className="muted">—</span>}</dd>
          <dt>Business purpose</dt>
          <dd>{q.data.businessPurpose || <span className="muted">—</span>}</dd>
        </dl>
      )}
    </TabState>
  );
}

interface Keyword {
  keyword: string;
  weight?: number | null;
}
function KeywordsTab({ id }: { id: string }) {
  const q = useTabQuery<{ items: Keyword[] }>("keywords", id, `/v1/companies/${id}/keywords`);
  return (
    <TabState q={q} empty="No keywords yet.">
      {q.data && q.data.items.length === 0 && <p className="muted">No keywords.</p>}
      {q.data && q.data.items.length > 0 && (
        <ul className="chips">
          {q.data.items.map((k, i) => (
            <li key={i} className="chip" title={k.weight != null ? `${k.weight}` : undefined}>
              {k.keyword}
            </li>
          ))}
        </ul>
      )}
    </TabState>
  );
}

interface Website {
  domain?: string | null;
  url?: string | null;
  metadata?: unknown;
}
function WebsiteTab({ id }: { id: string }) {
  const q = useTabQuery<Website>("website", id, `/v1/companies/${id}/website`);
  return (
    <TabState q={q} empty="No website detected yet.">
      {q.data && (
        <dl>
          <dt>Domain</dt>
          <dd>{q.data.domain ?? <span className="muted">—</span>}</dd>
          <dt>URL</dt>
          <dd>
            {q.data.url ? (
              <a href={q.data.url} target="_blank" rel="noreferrer">
                {q.data.url}
              </a>
            ) : (
              <span className="muted">—</span>
            )}
          </dd>
          {q.data.metadata != null && (
            <>
              <dt>Metadata</dt>
              <dd>
                <pre>{JSON.stringify(q.data.metadata, null, 2)}</pre>
              </dd>
            </>
          )}
        </dl>
      )}
    </TabState>
  );
}

interface Publication {
  year?: number | null;
  revenue?: number | null;
  employees?: number | null;
  [k: string]: unknown;
}
function PublicationsTab({ id }: { id: string }) {
  const q = useTabQuery<{ items: Publication[] }>(
    "publications",
    id,
    `/v1/companies/${id}/publications`,
  );
  return (
    <TabState q={q} empty="No publications yet.">
      {q.data && q.data.items.length === 0 && <p className="muted">No publications.</p>}
      {q.data && q.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Year</th>
              <th>Revenue</th>
              <th>Employees</th>
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((p, i) => (
              <tr key={i}>
                <td>{p.year ?? "—"}</td>
                <td>{p.revenue ?? "—"}</td>
                <td>{p.employees ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TabState>
  );
}

interface Contact {
  fullName?: string | null;
  email?: string | null;
  role?: string | null;
}
function ContactsTab({ id }: { id: string }) {
  const q = useTabQuery<{ items: Contact[] }>("contacts", id, `/v1/companies/${id}/contacts`);
  return (
    <TabState q={q} empty="No contacts yet.">
      {q.data && q.data.items.length === 0 && <p className="muted">No contacts.</p>}
      {q.data && q.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Email</th>
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((c, i) => (
              <tr key={i}>
                <td>{c.fullName ?? "—"}</td>
                <td>{c.role ?? <span className="muted">—</span>}</td>
                <td>{c.email ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TabState>
  );
}

interface StructuredContent {
  legalForm?: string | null;
  shareCapital?: string | null;
  managingDirectors?: Array<{ name: string }> | null;
  [k: string]: unknown;
}
function StructuredTab({ id }: { id: string }) {
  const q = useTabQuery<StructuredContent>(
    "structured",
    id,
    `/v1/companies/${id}/structured-content`,
  );
  return (
    <TabState q={q} empty="No structured content yet.">
      {q.data && (
        <dl>
          <dt>Legal form</dt>
          <dd>{q.data.legalForm ?? <span className="muted">—</span>}</dd>
          <dt>Share capital</dt>
          <dd>{q.data.shareCapital ?? <span className="muted">—</span>}</dd>
          <dt>Directors</dt>
          <dd>
            {q.data.managingDirectors && q.data.managingDirectors.length > 0
              ? q.data.managingDirectors.map((d) => d.name).join(", ")
              : <span className="muted">—</span>}
          </dd>
        </dl>
      )}
    </TabState>
  );
}
