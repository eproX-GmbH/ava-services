// Workstream C4 — inline CRM-link badge.
//
// Renders a tiny pill next to a company name when the row has at least
// one CompanyCrmLink. Tooltip lists the linked CRMs + their display
// names ("HubSpot · ACME GmbH"). Click is a no-op — the badge is a
// visual cue only; the CompanyDetail page is the surface for inspecting
// links + deals.

import type { CSSProperties } from "react";

type CrmKind = "HUBSPOT" | "SALESFORCE" | "DYNAMICS";

interface BadgeLink {
  crmType: CrmKind;
  crmDisplayName: string | null;
}

const CRM_SHORT: Record<CrmKind, string> = {
  HUBSPOT: "HS",
  SALESFORCE: "SF",
  DYNAMICS: "MS",
};

const CRM_LABEL: Record<CrmKind, string> = {
  HUBSPOT: "HubSpot",
  SALESFORCE: "Salesforce",
  DYNAMICS: "Microsoft Dynamics",
};

const baseStyle: CSSProperties = {
  display: "inline-block",
  marginLeft: "0.4rem",
  padding: "0.05rem 0.4rem",
  borderRadius: "999px",
  fontSize: "0.7rem",
  fontWeight: 600,
  letterSpacing: "0.04em",
  background: "var(--brand-deep-teal, #11484c)",
  color: "white",
  verticalAlign: "middle",
};

export function CrmBadgeRow({ links }: { links: BadgeLink[] }) {
  if (!links || links.length === 0) return null;
  const title = links
    .map((l) => `${CRM_LABEL[l.crmType]}${l.crmDisplayName ? ` · ${l.crmDisplayName}` : ""}`)
    .join(", ");
  return (
    <span title={title} aria-label={title}>
      {links.map((l) => (
        <span
          key={l.crmType}
          className={`crm-badge crm-badge--${l.crmType.toLowerCase()}`}
          style={baseStyle}
        >
          {CRM_SHORT[l.crmType]}
        </span>
      ))}
    </span>
  );
}
