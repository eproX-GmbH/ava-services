import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ExternalLink } from "lucide-react";
import type {
  LinkedInSettings,
  LinkedInSignalListFilter,
  LinkedInSignalListRow,
  LinkedInSignalFeedbackInput,
  LinkedInSignalFeedbackDirection,
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

/** Single image we're previewing in the lightbox. null when closed. */
interface LightboxImage {
  src: string;
  alt: string;
  caption: string | null;
}

// Session-only suppression key for the open-warning modal. We use
// sessionStorage on purpose — the warning should come back the next
// time the app launches, even if the user dismissed it last session.
const OPEN_WARNING_SUPPRESS_KEY = "ava.linkedinOpenWarning.suppress";

function useLinkedInOpenConfirm() {
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const openLinkedIn = useCallback((href: string) => {
    if (!href) return;
    let suppressed = false;
    try {
      suppressed = sessionStorage.getItem(OPEN_WARNING_SUPPRESS_KEY) === "1";
    } catch {
      // sessionStorage may be unavailable in obscure contexts — fail open.
    }
    if (suppressed) {
      window.open(href, "_blank", "noreferrer,noopener");
      return;
    }
    setPendingHref(href);
  }, []);

  const cancel = useCallback(() => setPendingHref(null), []);

  const confirm = useCallback(
    (suppressForSession: boolean) => {
      if (suppressForSession) {
        try {
          sessionStorage.setItem(OPEN_WARNING_SUPPRESS_KEY, "1");
        } catch {
          // ignore
        }
      }
      if (pendingHref) {
        window.open(pendingHref, "_blank", "noreferrer,noopener");
      }
      setPendingHref(null);
    },
    [pendingHref],
  );

  return { pendingHref, openLinkedIn, cancel, confirm };
}

interface LinkedInOpenWarningModalProps {
  href: string | null;
  onCancel: () => void;
  onConfirm: (suppressForSession: boolean) => void;
}

function LinkedInOpenWarningModal({
  href,
  onCancel,
  onConfirm,
}: LinkedInOpenWarningModalProps) {
  const [suppress, setSuppress] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const open = href !== null;

  // Reset the checkbox each time the modal opens.
  useEffect(() => {
    if (open) setSuppress(false);
  }, [open]);

  // Focus the primary action on open so Enter confirms.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  // ESC closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="linkedin-consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="linkedin-open-warning-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="linkedin-consent-panel">
        <header className="linkedin-consent-header">
          <h3 id="linkedin-open-warning-title">LinkedIn-Link öffnen</h3>
        </header>
        <p>
          LinkedIn wertet ungewöhnliche Zugriffsmuster gelegentlich als
          verdächtig aus, etwa wenn viele Beiträge in kurzer Folge über
          externe Tools angesteuert werden. Im Normalfall passiert nichts,
          aber bei intensiver Nutzung kann das Konto vorübergehend
          gedrosselt oder geprüft werden.
        </p>
        <p>
          Wir empfehlen, Links bewusst und in moderatem Takt zu öffnen und
          über AVA gefundene Inhalte vor allem als Anhaltspunkt zu nutzen.
          Trotzdem öffnen?
        </p>

        <label className="linkedin-consent-check">
          <input
            type="checkbox"
            checked={suppress}
            onChange={(e) => setSuppress(e.target.checked)}
          />
          <span>Hinweis nicht mehr anzeigen (für diese Sitzung)</span>
        </label>

        <div className="linkedin-consent-actions">
          <button type="button" className="link" onClick={onCancel}>
            Abbrechen
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="primary"
            onClick={() => onConfirm(suppress)}
          >
            LinkedIn öffnen
          </button>
        </div>
      </div>
    </div>
  );
}

export function LinkedIn() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<FilterState>(loadFilters);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const openConfirm = useLinkedInOpenConfirm();

  // Esc closes the lightbox. Mounted at route level so it works
  // regardless of which card opened the image.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

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

  // v0.1.345 — 👍/👎 feedback. `feedback: null` removes the vote.
  const onVote = async (
    postUrn: string,
    feedback: LinkedInSignalFeedbackInput | null,
  ) => {
    await window.api.linkedin.feed.vote(postUrn, feedback);
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
                onVote={(feedback) => onVote(row.postUrn, feedback)}
                onOpenImage={(img) => setLightbox(img)}
                onOpenLinkedIn={openConfirm.openLinkedIn}
              />
            ))}
          </div>
        </>
      )}
      <LinkedInOpenWarningModal
        href={openConfirm.pendingHref}
        onCancel={openConfirm.cancel}
        onConfirm={openConfirm.confirm}
      />
      {lightbox && (
        <div
          className="shot-lightbox"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-label="Bildvorschau"
        >
          <img src={lightbox.src} alt={lightbox.alt} />
          {lightbox.caption && (
            <div className="shot-lightbox__caption muted">
              {lightbox.caption}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface SignalCardProps {
  row: LinkedInSignalListRow;
  expanded: boolean;
  onToggleExpanded: () => void;
  onDismissToggle: () => void;
  onVote: (feedback: LinkedInSignalFeedbackInput | null) => void;
  onOpenImage: (img: LightboxImage) => void;
  onOpenLinkedIn: (href: string) => void;
}

function SignalCard({
  row,
  expanded,
  onToggleExpanded,
  onDismissToggle,
  onVote,
  onOpenImage,
  onOpenLinkedIn,
}: SignalCardProps) {
  const kindKey = row.signalKind ?? "none";
  const kindLabel = SIGNAL_KIND_LABEL[kindKey] ?? kindKey;
  const kindTone = SIGNAL_KIND_TONE[kindKey] ?? "ct-pill--muted";
  const tier = tierLetter(row.llmTier);
  const text = row.text ?? "";
  const truncated = text.length > 240;
  const visibleText = expanded || !truncated ? text : text.slice(0, 240) + "…";

  // v0.1.113: LinkedIn's new DOM no longer exposes a usable permalink
  // for most feed posts (the React permalink lives off-DOM, every <a>
  // points at the placeholder /feed/ href). When `row.permalink` is
  // null, fall back to the actor's profile URL so "Auf LinkedIn
  // öffnen" at least lands the user on the right person/company page.
  // Synthesising a /feed/update/<postKey>/ URL from the new postKey
  // would produce a 404 — postKey is not a `urn:li:` activity URN.
  const permalink = row.permalink ?? row.author.profileUrl ?? null;

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
            className="link"
            style={{ fontWeight: 600 }}
            onClick={(e) => {
              e.preventDefault();
              onOpenLinkedIn(row.author.profileUrl as string);
            }}
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

      {/* v0.1.344 — gematchte nutzerdefinierte Relevanz-Kriterien aus dem
          Profil. Erklärt, WARUM dieses Signal (mit-)hochbewertet wurde. */}
      {row.matchedInterests.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.4rem",
            marginTop: "0.5rem",
          }}
        >
          <span className="muted small">Passt zu deinem Interesse:</span>
          {row.matchedInterests.map((interest) => (
            <span
              key={interest}
              className="ct-pill ct-pill--accent"
              title="Nutzerdefiniertes Relevanz-Kriterium aus deinem Profil"
            >
              {interest}
            </span>
          ))}
        </div>
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
          {row.images.map((img) => {
            const src = window.api.linkedin.feed.mediaUrl(img.relPath);
            const alt = img.description ?? "";
            return (
              <button
                key={img.mediaId}
                type="button"
                onClick={() =>
                  onOpenImage({
                    src,
                    alt,
                    caption: img.description ?? null,
                  })
                }
                title="Vergrößern"
                style={{
                  padding: 0,
                  border: 0,
                  background: "transparent",
                  cursor: "zoom-in",
                  borderRadius: "4px",
                  overflow: "hidden",
                }}
              >
                <img
                  src={src}
                  alt={alt}
                  style={{
                    width: "100px",
                    height: "100px",
                    objectFit: "cover",
                    display: "block",
                  }}
                  loading="lazy"
                />
              </button>
            );
          })}
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
          <button
            type="button"
            className="link"
            onClick={() => onOpenLinkedIn(permalink)}
            style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
          >
            Auf LinkedIn öffnen <ExternalLink className="ct-icon-sm" aria-hidden="true" />
          </button>
        )}
        <button type="button" className="link" onClick={onDismissToggle}>
          {row.dismissed ? "Zurückholen" : "Verwerfen"}
        </button>
      </footer>

      <FeedbackBar row={row} onVote={onVote} />
    </article>
  );
}

// v0.1.345 — 👍/👎-Feedback zur Signalstärke. 👍 = passte; 👎 öffnet
// Richtung (zu hoch/zu niedrig) + optionalen Kommentar. Beide erlauben
// einen optionalen Kommentar. Erneuter Klick auf den aktiven Daumen
// nimmt den Vote zurück. Das destillierte Feedback kalibriert künftige
// Signalstärken (siehe calibration.ts), beeinflusst also auch, was zur
// Notification wird.
function FeedbackBar({
  row,
  onVote,
}: {
  row: LinkedInSignalListRow;
  onVote: (feedback: LinkedInSignalFeedbackInput | null) => void;
}) {
  const fb = row.userFeedback;
  const [open, setOpen] = useState(fb?.vote === "down");
  const [comment, setComment] = useState(fb?.comment ?? "");
  const [direction, setDirection] = useState<
    LinkedInSignalFeedbackDirection | null
  >(fb?.direction ?? null);

  // Re-sync when the server row changes (refetch after a vote).
  useEffect(() => {
    setComment(row.userFeedback?.comment ?? "");
    setDirection(row.userFeedback?.direction ?? null);
    setOpen(row.userFeedback?.vote === "down");
  }, [row.userFeedback]);

  const submit = (
    vote: "up" | "down",
    dir: LinkedInSignalFeedbackDirection | null,
  ) => {
    onVote({ vote, direction: dir, comment: comment.trim() || null });
  };

  // Explizite, theme-sichere Styles: aktive Auswahl wird klar gefüllt +
  // umrandet, inaktiv als Ghost-Button. (Die ct-pill--accent/--bad-
  // Modifier existieren im CSS NICHT, daher hier hartkodiert.)
  const baseBtn: CSSProperties = {
    cursor: "pointer",
    borderRadius: "999px",
    padding: "0.32rem 0.8rem",
    fontSize: "0.9rem",
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    lineHeight: 1.2,
    transition: "background 120ms ease, border-color 120ms ease",
  };
  const voteStyle = (active: boolean, tone: "up" | "down"): CSSProperties => {
    const color = tone === "up" ? "#10b981" : "#ef4444";
    return active
      ? {
          ...baseBtn,
          border: `2px solid ${color}`,
          background:
            tone === "up" ? "rgba(16,185,129,0.18)" : "rgba(239,68,68,0.18)",
          color: "var(--ct-text, #111)",
          fontWeight: 700,
          boxShadow: `0 0 0 1px ${color} inset`,
        }
      : {
          ...baseBtn,
          border: "1.5px solid var(--ct-border, rgba(120,120,120,0.4))",
          background: "transparent",
          color: "var(--ct-muted, #8a8a8a)",
          fontWeight: 500,
          opacity: 0.8,
        };
  };
  const chipStyle = (active: boolean): CSSProperties =>
    active
      ? {
          ...baseBtn,
          padding: "0.24rem 0.7rem",
          fontSize: "0.82rem",
          fontWeight: 700,
          border: "2px solid var(--ct-aqua, #0aa)",
          background: "rgba(0,170,200,0.16)",
          color: "var(--ct-text, #111)",
        }
      : {
          ...baseBtn,
          padding: "0.24rem 0.7rem",
          fontSize: "0.82rem",
          fontWeight: 500,
          border: "1.5px solid var(--ct-border, rgba(120,120,120,0.4))",
          background: "transparent",
          color: "var(--ct-muted, #8a8a8a)",
        };

  return (
    <div
      style={{
        marginTop: "0.6rem",
        paddingTop: "0.5rem",
        borderTop: "1px solid var(--ct-border, #eee)",
        display: "flex",
        flexDirection: "column",
        gap: "0.45rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <span className="muted small" style={{ marginRight: "0.1rem" }}>
          Stärke passend?
        </span>
        <button
          type="button"
          aria-pressed={fb?.vote === "up"}
          title="Stärke passte"
          style={voteStyle(fb?.vote === "up", "up")}
          onClick={() => {
            if (fb?.vote === "up") onVote(null);
            else {
              setDirection(null);
              setOpen(true);
              submit("up", null);
            }
          }}
        >
          <span aria-hidden>👍</span> Passt
        </button>
        <button
          type="button"
          aria-pressed={fb?.vote === "down"}
          title="Stärke passte nicht"
          style={voteStyle(fb?.vote === "down", "down")}
          onClick={() => {
            if (fb?.vote === "down") onVote(null);
            else {
              setOpen(true);
              submit("down", direction);
            }
          }}
        >
          <span aria-hidden>👎</span> Passt nicht
        </button>
        {fb && (
          <span
            className="small"
            style={{ color: "#10b981", fontWeight: 600 }}
            title="Dein Feedback wurde gespeichert und fließt in die Kalibrierung ein"
          >
            ✓ gespeichert
          </span>
        )}
        {fb && (
          <button
            type="button"
            className="link small"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "weniger" : "Begründung"}
          </button>
        )}
      </div>

      {fb && open && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          {fb.vote === "down" && (
            <div
              style={{
                display: "flex",
                gap: "0.45rem",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span className="muted small">Stärke war:</span>
              {(
                [
                  ["too_high", "zu hoch"],
                  ["too_low", "zu niedrig"],
                ] as Array<[LinkedInSignalFeedbackDirection, string]>
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  aria-pressed={direction === val}
                  style={chipStyle(direction === val)}
                  onClick={() => {
                    setDirection(val);
                    submit("down", val);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <textarea
            rows={2}
            maxLength={500}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onBlur={() => {
              if ((fb.comment ?? "") !== comment.trim())
                submit(fb.vote, fb.vote === "down" ? direction : null);
            }}
            placeholder="Warum? (optional) — hilft AVA, deine Signalstärke besser zu treffen"
            style={{ width: "100%", resize: "vertical" }}
          />
        </div>
      )}
    </div>
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
