import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, X } from "lucide-react";
import { gatewayFetch } from "../api/gateway";

// v0.1.433 — Verarbeitungs-Feed als Slide-in-Panel (von rechts).
//
// Beantwortet die Frage "WELCHE Firma wird gerade verarbeitet?" bei vielen
// Firmen: aktive Schritte zuoberst (mit Puls-Punkt), darunter der
// chronologische Verlauf (fertig/fehlgeschlagen/uebersprungen) — je Eintrag
// Producer, Firmenname (aus der Firmen-Matrix aufgeloest) und Zeitpunkt.
// Pollt alle 5 s, aber NUR solange das Panel offen ist.

interface FeedItem {
  transactionId: string;
  companyId: string;
  /** v0.1.434 — serverseitig aufgeloest (Namens-Cache im Gateway). */
  companyName: string | null;
  producer: string;
  state: string;
  updatedAt: string;
  startedAt: string | null;
  errorMessage: string | null;
  attempts: number | null;
}

const PRODUCER_LABEL: Record<string, string> = {
  "structured-content": "Struktur",
  "company-publication": "Publikation",
  website: "Website",
  "company-profile": "Profil",
  "company-contact": "Kontakt",
  "company-evaluation": "Bewertung",
};

const STATE_LABEL: Record<string, string> = {
  in_progress: "läuft",
  completed: "fertig",
  failed: "fehlgeschlagen",
  skipped: "übersprungen",
};

function stateDot(item: FeedItem): string {
  if (item.state === "in_progress") return "warn";
  if (item.state === "completed") return "ok";
  if (item.state === "skipped") return "muted";
  if (
    item.state === "failed" &&
    (item.errorMessage ?? "").startsWith("Zeitüberschreitung")
  )
    return "timeout";
  return "bad";
}

export function ProcessingFeedPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const feed = useQuery<{ items: FeedItem[] }>({
    queryKey: ["processing-feed"],
    queryFn: () =>
      gatewayFetch<{ items: FeedItem[] }>(
        "/v1/transactions/processing-feed/items?limit=150",
      ),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });

  // Firmennamen aus der Matrix aufloesen (eine Seite, grosszuegig).
  const names = useQuery<{
    companies: { companyId: string; name: string }[];
  }>({
    queryKey: ["companies-matrix", "names-for-feed"],
    queryFn: () =>
      gatewayFetch("/v1/companies/matrix?pageNumber=1&pageSize=200"),
    enabled: open,
    staleTime: 60_000,
  });
  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const co of names.data?.companies ?? []) {
      m.set(co.companyId, co.name);
    }
    return m;
  }, [names.data]);

  if (!open) return null;

  const items = feed.data?.items ?? [];
  const active = items.filter((i) => i.state === "in_progress");
  const history = items.filter((i) => i.state !== "in_progress");

  const row = (item: FeedItem, pulse: boolean): JSX.Element => (
    <li
      key={`${item.transactionId}:${item.companyId}:${item.producer}:${item.updatedAt}`}
      className="pf-row"
      title={item.errorMessage ?? undefined}
    >
      <span className={`dot ${stateDot(item)}${pulse ? " pf-pulse" : ""}`} />
      <div className="pf-row__main">
        <div className="pf-row__title">
          <strong>
            {item.companyName ??
              nameMap.get(item.companyId) ??
              item.companyId}
          </strong>
          <span className="muted"> · {PRODUCER_LABEL[item.producer] ?? item.producer}</span>
        </div>
        <div className="muted small">
          {STATE_LABEL[item.state] ?? item.state}
          {item.attempts && item.attempts > 1
            ? ` · Versuch ${item.attempts}`
            : ""}
          {" · "}
          {formatTime(item.updatedAt)}
          {item.errorMessage && item.state === "failed" && (
            <span className="pf-row__err"> — {item.errorMessage.slice(0, 90)}</span>
          )}
        </div>
      </div>
    </li>
  );

  return (
    <>
      <div className="pf-overlay" onClick={onClose} />
      <aside className="pf-panel" role="dialog" aria-label="Verarbeitungs-Feed">
        <header className="pf-panel__header">
          <Activity size={16} aria-hidden />
          <h3>Verarbeitung</h3>
          <button
            type="button"
            className="pf-panel__close"
            aria-label="Schließen"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {feed.isLoading && <p className="muted">Lädt…</p>}
        {feed.error && (
          <p className="error">
            Feed konnte nicht geladen werden:{" "}
            {(feed.error as Error).message}
          </p>
        )}

        <section>
          <h4>
            Gerade in Arbeit{" "}
            <span className="muted">({active.length})</span>
          </h4>
          {active.length === 0 ? (
            <p className="muted small">Aktuell wird nichts verarbeitet.</p>
          ) : (
            <ul className="pf-list">{active.map((i) => row(i, true))}</ul>
          )}
        </section>

        <section>
          <h4>Verlauf</h4>
          {history.length === 0 ? (
            <p className="muted small">Noch keine abgeschlossenen Schritte.</p>
          ) : (
            <ul className="pf-list">{history.map((i) => row(i, false))}</ul>
          )}
        </section>
      </aside>
    </>
  );
}

/** Eigenstaendiger Oeffnen-Knopf (fuer die Firmenuebersicht-Toolbar). */
export function ProcessingFeedButton(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="proc-toggle pf-open-btn"
        title="Verarbeitungs-Feed anzeigen (wer läuft gerade?)"
        onClick={() => setOpen(true)}
      >
        <Activity className="ct-icon-sm" aria-hidden />
        <span>Verarbeitung</span>
      </button>
      <ProcessingFeedPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const today = new Date();
    const sameDay =
      d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear();
    return sameDay
      ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : d.toLocaleString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
  } catch {
    return iso;
  }
}
