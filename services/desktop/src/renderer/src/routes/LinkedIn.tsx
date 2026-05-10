import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ExternalLink } from "lucide-react";
import type {
  LinkedInSettings,
  LinkedInSignalListFilter,
  LinkedInSignalListRow,
} from "../../../shared/types";

// Phase L6 — /linkedin route.
//
// Filter bar + paginated card list of LinkedIn-Beobachter signals.
// Read-only data; the only mutation is dismiss/restore.
// The route gracefully handles three "not visible" states: master
// switch off, switch on but no posts scraped yet, switch on but no
// signals match the current filter.

const FILTER_STORAGE_KEY = "ava.linkedin.filters";

const SIGNAL_KIND_LABEL: Record<string, string> = {
  any: "Alle",
  personnel_change: "Personalwechsel",
  company_event: "Firmen-Event",
  factory_visit: "Werksbesuch",
  new_product: "Produkt-News",
  partnership: "Partnerschaft",
  event_attendance: "Veranstaltung",
  hiring: "Stellenanzeige",
  award: "Auszeichnung",
  press_mention: "Pressemeldung",
  none: "Kein Signal",
};

const SIGNAL_KIND_TONE: Record<string, string> = {
  personnel_change: "ct-pill--accent",
  company_event: "ct-pill--accent",
  factory_visit: "ct-pill--accent",
  new_product: "ct-pill--accent",
  partnership: "ct-pill--accent",
  event_attendance: "ct-pill--muted",
  hiring: "ct-pill--muted",
  award: "ct-pill--accent",
  press_mention: "ct-pill--muted",
  none: "ct-pill--muted",
};

interface FilterState {
  kind: string;
  strengthMin: number;
  knownCompaniesOnly: boolean;
  includeDismissed: boolean;
  sinceDays: number;
}

const DEFAULT_FILTERS: FilterState = {
  kind: "any",
  strengthMin: 3,
  knownCompaniesOnly: false,
  includeDismissed: false,
  sinceDays: 14,
};

function loadFilters(): FilterState {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<FilterState>;
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(f: FilterState): void {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

function relTime(ts: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 60) return `vor ${Math.max(1, min)} Min.`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days < 30) return `vor ${days} Tg.`;
  const months = Math.round(days / 30);
  return `vor ${months} Mon.`;
}

function tierLetter(tier: number | null): string | null {
  if (tier === null) return null;
  return ({ 4: "S", 3: "A", 2: "B", 1: "C" } as const)[tier as 1 | 2 | 3 | 4] ?? null;
}

export function LinkedIn() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<FilterState>(loadFilters);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const settingsQuery = useQuery<LinkedInSettings>({
    queryKey: ["linkedin", "settings"],
    queryFn: () => window.api.linkedin.getSettings(),
    refetchOnWindowFocus: true,
  });

  const filterPayload: LinkedInSignalListFilter = useMemo(
    () => ({
      kind: filters.kind === "any" ? "any" : (filters.kind as LinkedInSignalListFilter["kind"]),
      strengthMin: filters.strengthMin,
      knownCompaniesOnly: filters.knownCompaniesOnly,
      includeDismissed: filters.includeDismissed,
      sinceDays: filters.sinceDays,
      limit: 50,
    }),
    [filters],
  );

  const signalsQuery = useQuery<LinkedInSignalListRow[]>({
    queryKey: ["linkedin", "signals", filterPayload],
    queryFn: () => window.api.linkedin.feed.listSignals(filterPayload),
    enabled: settingsQuery.data?.enabled === true,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const enabled = settingsQuery.data?.enabled === true;

  const updateFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const onDismissToggle = async (postUrn: string, dismissed: boolean) => {
    await window.api.linkedin.signals.dismiss(postUrn, !dismissed);
    await queryClient.invalidateQueries({ queryKey: ["linkedin", "signals"] });
  };

  return (
    <section className="page" style={{ paddingBottom: "2rem" }}>
      <header className="ct-page-header">
        <p className="ct-page-header__eyebrow">
          <Activity className="ct-icon-sm" aria-hidden="true" /> Portfolio
        </p>
        <h2 className="ct-page-header__title">
          <span className="ct-gradient-text">LinkedIn-Signale</span>
        </h2>
        <p className="ct-page-header__lede">
          Was sich in den Beiträgen aus deinem LinkedIn-Feed zu deinen
          Zielfirmen tut. Stärke, Art und gematchte Firmen aus deinem
          Stammdaten-Bestand.
        </p>
      </header>

      {!settingsQuery.isLoading && !enabled && (
        <div className="ct-card" style={{ padding: "1rem", marginTop: "1rem" }}>
          <p>
            LinkedIn-Beobachter ist nicht aktiv.{" "}
            <Link to="/settings#linkedin-section" className="link">
              Einschalten
            </Link>
            .
          </p>
        </div>
      )}

      {enabled && (
        <>
          <div
            className="ct-card"
            style={{
              padding: "0.75rem 1rem",
              marginTop: "1rem",
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              alignItems: "center",
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span className="muted">Art:</span>
              <select
                value={filters.kind}
                onChange={(e) => updateFilter("kind", e.target.value)}
              >
                {Object.entries(SIGNAL_KIND_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span className="muted">Mindeststärke:</span>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={filters.strengthMin}
                onChange={(e) => updateFilter("strengthMin", Number(e.target.value))}
              />
              <span className="ct-pill ct-pill--muted">{filters.strengthMin}</span>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span className="muted">Zeitraum:</span>
              <select
                value={filters.sinceDays}
                onChange={(e) => updateFilter("sinceDays", Number(e.target.value))}
              >
                <option value={14}>Letzte 14 Tage</option>
                <option value={30}>Letzter Monat</option>
                <option value={90}>Letzte 3 Monate</option>
              </select>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <input
                type="checkbox"
                checked={filters.knownCompaniesOnly}
                onChange={(e) => updateFilter("knownCompaniesOnly", e.target.checked)}
              />
              Nur bekannte Firmen
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <input
                type="checkbox"
                checked={filters.includeDismissed}
                onChange={(e) => updateFilter("includeDismissed", e.target.checked)}
              />
              Verworfene anzeigen
            </label>

            {signalsQuery.data && (
              <span className="ct-pill ct-pill--muted" style={{ marginLeft: "auto" }}>
                {signalsQuery.data.length} Signal
                {signalsQuery.data.length === 1 ? "" : "e"}
              </span>
            )}
          </div>

          {signalsQuery.isLoading && <p style={{ marginTop: "1rem" }}>Wird geladen…</p>}
          {signalsQuery.error && (
            <p className="error" style={{ marginTop: "1rem" }}>
              Fehler beim Laden: {(signalsQuery.error as Error).message}
            </p>
          )}
          {signalsQuery.data && signalsQuery.data.length === 0 && (
            <div
              className="ct-card"
              style={{ padding: "1rem", marginTop: "1rem" }}
            >
              <p className="muted">Keine Signale für diese Auswahl.</p>
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              marginTop: "1rem",
            }}
          >
            {signalsQuery.data?.map((row) => (
              <SignalCard
                key={row.postUrn}
                row={row}
                expanded={expanded[row.postUrn] === true}
                onToggleExpanded={() =>
                  setExpanded((p) => ({ ...p, [row.postUrn]: !p[row.postUrn] }))
                }
                onDismissToggle={() => onDismissToggle(row.postUrn, row.dismissed)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

interface SignalCardProps {
  row: LinkedInSignalListRow;
  expanded: boolean;
  onToggleExpanded: () => void;
  onDismissToggle: () => void;
}

function SignalCard({ row, expanded, onToggleExpanded, onDismissToggle }: SignalCardProps) {
  const kindKey = row.signalKind ?? "none";
  const kindLabel = SIGNAL_KIND_LABEL[kindKey] ?? kindKey;
  const kindTone = SIGNAL_KIND_TONE[kindKey] ?? "ct-pill--muted";
  const tier = tierLetter(row.llmTier);
  const text = row.text ?? "";
  const truncated = text.length > 240;
  const visibleText = expanded || !truncated ? text : text.slice(0, 240) + "…";

  const permalink =
    row.permalink ??
    (row.postUrn
      ? `https://www.linkedin.com/feed/update/${encodeURIComponent(row.postUrn)}/`
      : null);

  return (
    <article
      className="ct-card"
      style={{
        padding: "0.9rem 1rem",
        opacity: row.dismissed ? 0.6 : 1,
        borderStyle: row.dismissed ? "dashed" : undefined,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        {row.author.profileUrl ? (
          <a
            href={row.author.profileUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="link"
            style={{ fontWeight: 600 }}
          >
            {row.author.displayName}
          </a>
        ) : (
          <strong>{row.author.displayName}</strong>
        )}
        {row.author.headline && (
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {row.author.headline}
          </span>
        )}
        <span className="muted" style={{ fontSize: "0.85rem", marginLeft: "auto" }}>
          {relTime(row.postedAt ?? row.scrapedAt)}
        </span>
      </header>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginTop: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <span className={`ct-pill ${kindTone}`}>{kindLabel}</span>
        <StrengthDots value={row.signalStrength ?? 0} />
        {tier && row.llmModel && (
          <span
            className="ct-pill ct-pill--muted"
            title={`Diese Auswertung wurde mit ${row.llmModel} durchgeführt.`}
            style={{ fontSize: "0.75rem" }}
          >
            Tier {tier} · {row.llmModel}
          </span>
        )}
      </div>

      {row.summary && (
        <p style={{ marginTop: "0.6rem", fontSize: "1.05rem", fontWeight: 500 }}>
          {row.summary}
        </p>
      )}

      {row.matchedCompanies.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.4rem",
            marginTop: "0.5rem",
          }}
        >
          {row.matchedCompanies.map((c) => (
            <Link
              key={c.companyId}
              to={`/companies/${encodeURIComponent(c.companyId)}`}
              className="ct-pill ct-pill--accent"
              title={
                c.sourceValue && c.sourceValue !== c.name
                  ? `Erwähnt als „${c.sourceValue}"`
                  : c.name
              }
              style={{ textDecoration: "none" }}
            >
              {c.name}
            </Link>
          ))}
        </div>
      )}

      {row.matchedContacts.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.4rem",
            marginTop: "0.4rem",
          }}
        >
          {row.matchedContacts.map((c) => (
            <span
              key={c.contactId}
              className="ct-pill ct-pill--muted"
              title={
                c.sourceValue && c.sourceValue !== c.display
                  ? `Erwähnt als „${c.sourceValue}"`
                  : c.display
              }
            >
              {c.display}
            </span>
          ))}
        </div>
      )}

      {row.images.length > 0 && (
        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.6rem" }}>
          {row.images.map((img) => (
            <img
              key={img.mediaId}
              src={window.api.linkedin.feed.mediaUrl(img.relPath)}
              alt={img.description ?? ""}
              style={{
                width: "100px",
                height: "100px",
                objectFit: "cover",
                borderRadius: "4px",
              }}
              loading="lazy"
            />
          ))}
        </div>
      )}

      {visibleText && (
        <p style={{ marginTop: "0.6rem", whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>
          {visibleText}
          {truncated && (
            <>
              {" "}
              <button
                type="button"
                className="link"
                onClick={onToggleExpanded}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
              >
                {expanded ? "weniger anzeigen" : "mehr anzeigen"}
              </button>
            </>
          )}
        </p>
      )}

      <footer
        style={{
          display: "flex",
          gap: "1rem",
          marginTop: "0.7rem",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {permalink && (
          <a
            href={permalink}
            target="_blank"
            rel="noreferrer noopener"
            className="link"
          >
            Auf LinkedIn öffnen <ExternalLink className="ct-icon-sm" aria-hidden="true" />
          </a>
        )}
        <button type="button" className="link" onClick={onDismissToggle}>
          {row.dismissed ? "Zurückholen" : "Verwerfen"}
        </button>
      </footer>
    </article>
  );
}

function StrengthDots({ value }: { value: number }) {
  const v = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span
      aria-label={`Stärke ${v} von 5`}
      style={{ display: "inline-flex", gap: "2px", alignItems: "center" }}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: n <= v ? "var(--ct-aqua, #0ad)" : "var(--ct-muted-bg, #ddd)",
          }}
        />
      ))}
    </span>
  );
}
