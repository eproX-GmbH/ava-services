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

  // „Blockierend" = das Kontingent ist voll. In diesem Zustand verarbeitet
  // AVA keine neuen Firmen mehr — sie bleiben in der Firmenübersicht auf
  // „in Bearbeitung" (gelb) hängen. Das ist der Fall, den der Nutzer
  // unübersehbar gemeldet bekommen soll: laute, rote Voll-Fehlermeldung,
  // role="alert". Der reine „Reste aus einem früheren Lauf warten noch und
  // laufen automatisch weiter"-Fall (under quota + parked) bleibt dagegen
  // die ruhige, informative Variante.
  const blocking = exhausted;

  const periodLabel = labelForPeriod(data.periodKey);
  const message = renderMessage({
    exhausted,
    hasParked,
    used: data.used,
    limit: data.limit,
    parkedCount: data.parkedCount ?? 0,
    periodLabel,
    periodKey: data.periodKey,
    periodEnd: data.periodEnd,
  });

  return (
    <div
      className={`quota-banner${blocking ? " quota-banner--blocking" : ""}`}
      role={blocking ? "alert" : "status"}
    >
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
  periodKey,
  periodEnd,
}: {
  exhausted: boolean;
  hasParked: boolean;
  used: number;
  limit: number;
  parkedCount: number;
  periodLabel: string;
  periodKey: string;
  periodEnd: string | null;
}) {
  // Wie sich das Kontingent „erholt": Lifetime-Kontingent (Free) wird nie
  // automatisch zurückgesetzt — nur ein Upgrade hilft. Monats-Perioden
  // setzen sich am periodEnd zurück.
  const recovery = recoveryHint(periodKey, periodEnd);

  if (exhausted) {
    return (
      <>
        <strong>Kontingent aufgebraucht</strong> (<strong>{used}/{limit}</strong>
        {periodLabel ? ` ${periodLabel}` : ""}). AVA verarbeitet aktuell{" "}
        <strong>keine neuen Firmen</strong> mehr — Importe bleiben in der
        Firmenübersicht auf „in Bearbeitung" (gelb) hängen
        {hasParked ? (
          <>
            {" "}(<strong>{parkedCount}</strong> warten bereits)
          </>
        ) : null}
        . Das bleibt so, {recovery}
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

/** Satz-Fortsetzung nach „Das bleibt so, …" — abhängig vom Perioden-Typ. */
function recoveryHint(periodKey: string, periodEnd: string | null): string {
  if (periodKey === "lifetime") {
    return "bis du deinen Tarif upgradest.";
  }
  const dateLabel = formatPeriodEnd(periodEnd);
  if (dateLabel) {
    return `bis die Periode am ${dateLabel} zurückgesetzt wird oder du deinen Tarif upgradest.`;
  }
  return "bis sich dein Kontingent zurücksetzt oder du deinen Tarif upgradest.";
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
