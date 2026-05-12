import { Link } from "react-router-dom";
import { useUsage, isUnlimited } from "../api/usage";

// Permanent banner that surfaces under the topbar when the user has
// hit their company contingent OR has companies parked waiting on
// quota headroom (Q-track v0.1.137). Mirrors the ExternalServiceBanner
// shape — single line, dismiss-less, deep-links to Settings → Plan &
// Abrechnung for the upgrade CTA.
//
// Quiet on enterprise / loading / under-quota-with-no-parked-rows.
// Three message variants are picked based on `(used >= limit)` and
// `(parkedCount > 0)`:
//
//   - exhausted + parked  → "Kontingent erreicht, X Firmen warten…"
//   - exhausted + 0 parked → legacy "limit erreicht" message
//   - under quota + parked → "X Firmen warten auf den nächsten
//                            Resume-Lauf (passiert automatisch)"

export function QuotaExhaustedBanner() {
  const { data } = useUsage();
  if (!data) return null;
  if (isUnlimited(data)) return null;
  if (data.limit <= 0) return null;

  const exhausted = data.used >= data.limit;
  const hasParked = (data.parkedCount ?? 0) > 0;
  if (!exhausted && !hasParked) return null;

  const periodLabel = labelForPeriod(data.periodKey);
  const message = renderMessage({
    exhausted,
    hasParked,
    used: data.used,
    limit: data.limit,
    parkedCount: data.parkedCount ?? 0,
    periodLabel,
    periodEnd: data.periodEnd,
  });

  return (
    <div className="quota-banner" role="status">
      <span className="quota-banner__icon" aria-hidden>
        <BoltIcon />
      </span>
      <p className="quota-banner__msg">{message}</p>
      <Link to="/settings#plan-section" className="quota-banner__cta">
        Tarif upgraden
      </Link>
    </div>
  );
}

function renderMessage({
  exhausted,
  hasParked,
  used,
  limit,
  parkedCount,
  periodLabel,
  periodEnd,
}: {
  exhausted: boolean;
  hasParked: boolean;
  used: number;
  limit: number;
  parkedCount: number;
  periodLabel: string;
  periodEnd: string | null;
}) {
  if (exhausted && hasParked) {
    const dateLabel = formatPeriodEnd(periodEnd);
    return (
      <>
        Dein Firmen-Kontingent ist erschöpft (<strong>{used}/{limit}</strong>
        {periodLabel ? ` ${periodLabel}` : ""}). <strong>{parkedCount} Firmen</strong>
        {" "}wurden importiert und warten auf Verarbeitung — sie laufen
        automatisch los, sobald du upgradest{dateLabel ? ` oder die Periode am ${dateLabel} zurückgesetzt wird` : ""}.
      </>
    );
  }
  if (exhausted) {
    return (
      <>
        Dein Firmen-Kontingent ist erreicht (<strong>{used}/{limit}</strong>
        {periodLabel ? ` ${periodLabel}` : ""}). Neue Importe werden zwar
        akzeptiert, aber bis zur Periodenrücksetzung oder einem Upgrade
        nicht verarbeitet.
      </>
    );
  }
  // Under quota + parked: queue has leftovers from a previous over-quota run.
  return (
    <>
      <strong>{parkedCount} Firmen</strong> warten noch auf den Resume-Lauf.
      Das passiert automatisch innerhalb der nächsten Minuten.
    </>
  );
}

function labelForPeriod(periodKey: string): string {
  if (periodKey === "lifetime") return "(Lebenszeit-Kontingent)";
  if (periodKey === "unlimited") return "";
  // YYYY-MM
  return `(Periode ${periodKey})`;
}

function formatPeriodEnd(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("de-DE", { day: "numeric", month: "long" });
  } catch {
    return null;
  }
}

function BoltIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}
