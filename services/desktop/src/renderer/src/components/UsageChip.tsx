import { Link } from "react-router-dom";
import { useUsage, isUnlimited } from "../api/usage";

// Topbar usage pill (M2).
//
// Visible only when the user is at ≥ 80 % of their quota — keeps the
// topbar quiet during normal use, surfaces a warning before the next
// import gets refused. Hidden entirely on enterprise (no enforcement)
// and during the loading window. Click → Settings → Plan & Abrechnung.
//
// Styled like WatchChip so the two pills read as a pair when both are
// visible. We deliberately don't show the period or tier inline — the
// Settings section has the room for that.

const WARN_THRESHOLD = 0.8;

export function UsageChip() {
  const { data, isLoading } = useUsage();
  if (isLoading || !data) return null;
  if (isUnlimited(data)) return null;
  if (data.limit <= 0) return null;
  const ratio = data.used / data.limit;
  if (ratio < WARN_THRESHOLD) return null;
  const bucket = ratio >= 1 ? "red" : ratio >= 0.95 ? "red" : "orange";
  const label = `${data.used} / ${data.limit} verbraucht`;
  return (
    <Link
      to="/settings#plan-section"
      className={`watch-chip__btn watch-chip__btn--${bucket}`}
      aria-label={label}
      title={label}
      style={{ textDecoration: "none" }}
    >
      <BoltIcon />
      <span className="watch-chip__count">
        {data.used}/{data.limit}
      </span>
      <span className={`watch-chip__dot watch-chip__dot--${bucket}`} aria-hidden />
    </Link>
  );
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
