import { Link } from "react-router-dom";
import { useUsage, isUnlimited } from "../api/usage";

// Permanent banner that surfaces under the topbar when the user has
// hit their company contingent (used >= limit). Mirrors the
// ExternalServiceBanner shape — single line, dismiss-less, deep-links
// to Settings → Plan & Abrechnung for the upgrade CTA.
//
// Quiet on enterprise / loading / under-quota. The smaller topbar
// `UsageChip` covers the 80-99 %-warning band; this banner only
// fires once usage has actually been refused.

export function QuotaExhaustedBanner() {
  const { data } = useUsage();
  if (!data) return null;
  if (isUnlimited(data)) return null;
  if (data.limit <= 0) return null;
  if (data.used < data.limit) return null;

  const periodLabel = labelForPeriod(data.periodKey);
  return (
    <div className="quota-banner" role="status">
      <span className="quota-banner__icon" aria-hidden>
        <BoltIcon />
      </span>
      <p className="quota-banner__msg">
        Dein Firmen-Kontingent ist erreicht (<strong>{data.used}/{data.limit}</strong>
        {periodLabel ? ` ${periodLabel}` : ""}). Neue Importe werden abgelehnt,
        bis du upgradest oder die Periode zurückgesetzt wird.
      </p>
      <Link to="/settings#plan-section" className="quota-banner__cta">
        Tarif upgraden
      </Link>
    </div>
  );
}

function labelForPeriod(periodKey: string): string {
  if (periodKey === "lifetime") return "(Lebenszeit-Kontingent)";
  if (periodKey === "unlimited") return "";
  // YYYY-MM
  return `(Periode ${periodKey})`;
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
