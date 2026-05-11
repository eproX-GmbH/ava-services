// Workstream C4 — CRM panel for CompanyDetail's Overview tab.
//
// Renders:
//   - "Nicht verknüpft" card with a "Mit CRM verknüpfen" button when no
//     CompanyCrmLink exists for this company.
//   - One sub-card per CRM link otherwise; each sub-card shows the
//     cached enrichment payload (deals, contacts, last activity), a
//     "Im CRM öffnen" link, and an "Aktualisieren" button that triggers
//     a fresh on-device fetch via window.api.crm.enrich().
//
// Data sources:
//   - listLinks: window.api.crm.listLinks(companyId) → /v1/companies/:id/crm
//   - details:   window.api.crm.fetchDetails(...)    → /v1/companies/:id/crm/details
//
// On mount: if a link exists but /details doesn't yet have a payload for
// that CRM (legacy gateway behaviour returns an empty payload stub for
// HubSpot), we kick off window.api.crm.enrich(). When that resolves we
// re-read /details once. Salesforce/Dynamics return notConfigured:true
// and render a static hint.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CrmLinkPicker } from "./CrmLinkPicker";

interface Props {
  companyId: string;
  companyName: string;
}

type CrmKind = "HUBSPOT" | "SALESFORCE" | "DYNAMICS";

interface CrmLinkRow {
  crmType: CrmKind;
  crmExternalId: string;
  crmDisplayName: string | null;
  confirmedAt: string;
  confirmedSource: string;
  lastSyncedAt: string | null;
}

interface CrmDetailRow {
  crmType: CrmKind;
  fetchedAt: string;
  notConfigured?: boolean;
  contacts?: Array<{
    id?: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    jobTitle?: string | null;
    phone?: string | null;
  }>;
  deals?: Array<{
    id?: string;
    name?: string | null;
    amount?: number | null;
    stage?: string | null;
    pipeline?: string | null;
    closeDate?: string | null;
  }>;
  lastActivity?: string | null;
  company?: {
    name?: string | null;
    domain?: string | null;
  };
}

const CRM_LABEL: Record<CrmKind, string> = {
  HUBSPOT: "HubSpot",
  SALESFORCE: "Salesforce",
  DYNAMICS: "Microsoft Dynamics",
};

const CRM_BADGE: Record<CrmKind, string> = {
  HUBSPOT: "HS",
  SALESFORCE: "SF",
  DYNAMICS: "MS",
};

const SOURCE_LABEL: Record<string, string> = {
  EXACT_MATCH: "Exakter Treffer beim Import",
  USER_CONFIRMED: "Vom Nutzer bestätigt",
  MANUAL_LINK: "Manuell verknüpft",
  SINGLE_IMPORT: "Einzelimport",
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("de-DE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "nie";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "nie";
  const diffMs = Date.now() - ts;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days < 30) return `vor ${days} Tag${days === 1 ? "" : "en"}`;
  const months = Math.round(days / 30);
  return `vor ${months} Monat${months === 1 ? "" : "en"}`;
}

function fmtAmount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function CompanyCrmPanel({ companyId, companyName }: Props) {
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  // Track which CRMs we've already auto-triggered an enrichment for in
  // this mount, so a notConfigured: true / empty cache doesn't loop.
  const [autoEnriched, setAutoEnriched] = useState<Record<string, boolean>>({});

  const links = useQuery({
    queryKey: ["crm-links", companyId],
    queryFn: async () => {
      const res = (await window.api.crm.listLinks(companyId)) as {
        links: CrmLinkRow[];
      };
      return res.links;
    },
    enabled: !!companyId,
  });

  const hasLinks = (links.data?.length ?? 0) > 0;

  const details = useQuery({
    queryKey: ["crm-details", companyId],
    queryFn: async () => {
      const res = (await window.api.crm.fetchDetails(companyId)) as {
        details: CrmDetailRow[];
      };
      return res.details;
    },
    enabled: hasLinks,
  });

  const detailsByCrm = useMemo(() => {
    const map: Partial<Record<CrmKind, CrmDetailRow>> = {};
    for (const d of details.data ?? []) map[d.crmType] = d;
    return map;
  }, [details.data]);

  // Auto-trigger enrichment when a HubSpot link is present but the
  // cached payload looks empty (no contacts / no deals / no lastActivity).
  useEffect(() => {
    if (!links.data) return;
    for (const link of links.data) {
      if (link.crmType !== "HUBSPOT") continue;
      if (autoEnriched[link.crmType]) continue;
      const detail = detailsByCrm.HUBSPOT;
      const isEmpty =
        !detail ||
        (!detail.notConfigured &&
          (detail.contacts?.length ?? 0) === 0 &&
          (detail.deals?.length ?? 0) === 0 &&
          !detail.lastActivity);
      if (!isEmpty) continue;
      setAutoEnriched((prev) => ({ ...prev, [link.crmType]: true }));
      void (async () => {
        const res = await window.api.crm.enrich({
          companyId,
          crmExternalId: link.crmExternalId,
          crmType: "hubspot",
        });
        if (res.ok) {
          void queryClient.invalidateQueries({
            queryKey: ["crm-details", companyId],
          });
        }
      })();
    }
  }, [links.data, detailsByCrm, autoEnriched, companyId, queryClient]);

  async function refreshOne(link: CrmLinkRow) {
    if (link.crmType !== "HUBSPOT") return;
    const res = await window.api.crm.enrich({
      companyId,
      crmExternalId: link.crmExternalId,
      crmType: "hubspot",
    });
    if (res.ok) {
      void queryClient.invalidateQueries({
        queryKey: ["crm-details", companyId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["crm-links", companyId],
      });
    }
  }

  function openInCrm(link: CrmLinkRow) {
    if (link.crmType !== "HUBSPOT") return;
    // The portal id isn't on the link row; HubSpot's UI tolerates the
    // 0-placeholder + redirects to the user's portal after auth.
    const url = `https://app.hubspot.com/contacts/0/company/${encodeURIComponent(link.crmExternalId)}`;
    void window.api.shell.openExternal(url);
  }

  return (
    <article className="panel" style={{ gridColumn: "1 / -1" }}>
      <h3>CRM</h3>

      {links.isLoading && <p className="muted">Wird geladen…</p>}
      {links.error && (
        <p className="error">
          Fehler beim Laden: {(links.error as Error).message}
        </p>
      )}

      {links.data && links.data.length === 0 && (
        <>
          <p className="muted">Diese Firma ist mit keinem CRM verknüpft.</p>
          <p>
            <button
              type="button"
              className="primary"
              onClick={() => setPickerOpen(true)}
            >
              Mit CRM verknüpfen
            </button>
          </p>
        </>
      )}

      {links.data && links.data.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {links.data.map((link) => {
            const detail = detailsByCrm[link.crmType];
            return (
              <CrmLinkCard
                key={`${link.crmType}:${link.crmExternalId}`}
                link={link}
                detail={detail}
                onRefresh={() => void refreshOne(link)}
                onOpen={() => openInCrm(link)}
              />
            );
          })}
          <p style={{ margin: 0 }}>
            <button
              type="button"
              className="link"
              onClick={() => setPickerOpen(true)}
            >
              Weitere Verknüpfung hinzufügen
            </button>
          </p>
        </div>
      )}

      <CrmLinkPicker
        open={pickerOpen}
        companyId={companyId}
        defaultQuery={companyName}
        onClose={() => setPickerOpen(false)}
        onLinked={() => setPickerOpen(false)}
      />
    </article>
  );
}

function CrmLinkCard({
  link,
  detail,
  onRefresh,
  onOpen,
}: {
  link: CrmLinkRow;
  detail: CrmDetailRow | undefined;
  onRefresh: () => void;
  onOpen: () => void;
}) {
  const label = CRM_LABEL[link.crmType];
  const sourceLabel = SOURCE_LABEL[link.confirmedSource] ?? link.confirmedSource;
  const lastFetch = detail?.fetchedAt ?? link.lastSyncedAt;

  return (
    <div
      style={{
        border: "1px solid var(--border, #2b3a44)",
        borderRadius: "6px",
        padding: "0.75rem 1rem",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className={`crm-badge crm-badge--${link.crmType.toLowerCase()}`}>
            {CRM_BADGE[link.crmType]}
          </span>
          <strong>{label}</strong>
          {link.crmDisplayName && (
            <span className="muted"> · {link.crmDisplayName}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {link.crmType === "HUBSPOT" && (
            <>
              <button type="button" className="link" onClick={onRefresh}>
                Aktualisieren
              </button>
              <button type="button" className="link" onClick={onOpen}>
                Im CRM öffnen ↗
              </button>
            </>
          )}
        </div>
      </header>

      <p className="muted small" style={{ marginTop: "0.25rem" }}>
        Verbunden seit {fmtDate(link.confirmedAt)} · Quelle: {sourceLabel}
        {" · "}Letzter Abruf: {fmtRelative(lastFetch)}
      </p>

      {detail?.notConfigured && (
        <p className="muted">
          Diese CRM-Integration ist noch nicht eingerichtet.
        </p>
      )}

      {detail && !detail.notConfigured && (
        <CrmDetailBody detail={detail} />
      )}

      {!detail && (
        <p className="muted">Noch keine Daten geladen.</p>
      )}
    </div>
  );
}

function CrmDetailBody({ detail }: { detail: CrmDetailRow }) {
  const contacts = detail.contacts ?? [];
  const deals = detail.deals ?? [];
  const openDealCount = deals.length;
  const contactCount = contacts.length;

  return (
    <div style={{ marginTop: "0.5rem" }}>
      <p style={{ margin: "0 0 0.5rem" }}>
        {openDealCount} {openDealCount === 1 ? "Deal" : "Deals"}
        {" · "}
        {contactCount} {contactCount === 1 ? "Kontakt" : "Kontakte"}
        {detail.lastActivity && (
          <>
            {" · letzte Aktivität "}
            {fmtRelative(detail.lastActivity)}
          </>
        )}
      </p>

      {contacts.length > 0 && (
        <>
          <h4 style={{ margin: "0.5rem 0 0.25rem" }}>Top-Kontakte</h4>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {contacts.slice(0, 5).map((c, i) => {
              const fullName = [c.firstName, c.lastName]
                .filter(Boolean)
                .join(" ");
              const parts: string[] = [];
              if (fullName) parts.push(fullName);
              if (c.jobTitle) parts.push(c.jobTitle);
              if (c.email) parts.push(c.email);
              else if (c.phone) parts.push(c.phone);
              return (
                <li key={c.id ?? i}>
                  {parts.join(" · ") || "(unbenannt)"}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {deals.length > 0 && (
        <>
          <h4 style={{ margin: "0.5rem 0 0.25rem" }}>Aktive Deals</h4>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {deals.slice(0, 5).map((d, i) => {
              const bits: string[] = [];
              if (d.name) bits.push(d.name);
              if (d.amount != null) bits.push(fmtAmount(d.amount));
              if (d.pipeline) bits.push(`Pipeline: ${d.pipeline}`);
              if (d.stage) bits.push(`Phase: ${d.stage}`);
              if (d.closeDate) bits.push(`Close ${fmtDate(d.closeDate)}`);
              return <li key={d.id ?? i}>{bits.join(" · ")}</li>;
            })}
          </ul>
        </>
      )}
    </div>
  );
}
