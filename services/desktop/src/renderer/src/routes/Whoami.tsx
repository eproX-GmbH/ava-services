import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { gatewayFetch } from "../api/gateway";
import type {
  ExternalServiceId,
  ExternalServiceStatus,
  ExternalServicesStatus,
} from "../../../shared/types";

const SERVICE_LABELS: Record<ExternalServiceId, string> = {
  unternehmensregister: "Unternehmensregister.de",
  handelsregister: "Handelsregister.de",
};

// Whoami screen — identity only.
//
// Phase 8.g moved the agent provider/key/model UI and the local-models
// panel to the dedicated `/settings` route. This page is back to being a
// thin smoke-test for the gateway URL + auth wiring (kept since Step 6).
//
// v0.1.69 — restored the simple `<dl>` layout. The Corporate Trust
// refresh blew it up into a card grid with icon tiles, which felt
// oversized for what is fundamentally a debugging surface. Tokens
// (typography, spacing, link color) inherit the new palette anyway.

interface WhoamiResponse {
  tenantId: string;
  actorId: string;
  scopes: string[];
  // T4/T5 — vom Gateway seit 20260903_tenants.
  tenantName?: string | null;
  role?: string;
  memberCount?: number;
  email?: string | null;
  tenantSource?: "claim" | "sub";
}

export function Whoami() {
  const whoami = useQuery({
    queryKey: ["whoami"],
    queryFn: () => gatewayFetch<WhoamiResponse>("/v1/whoami"),
  });

  return (
    <section>
      <h2>Status</h2>
      {whoami.isLoading && <p>Lädt…</p>}
      {whoami.error && (
        <p className="error">Fehler: {(whoami.error as Error).message}</p>
      )}
      {whoami.data && (
        <dl>
          <dt>Tenant</dt>
          <dd>
            {whoami.data.tenantName ??
              (whoami.data.tenantId === whoami.data.actorId
                ? "persönlicher Tenant"
                : whoami.data.tenantId)}
            {whoami.data.role && (
              <span className="muted small"> · Rolle: {whoami.data.role}</span>
            )}
            {typeof whoami.data.memberCount === "number" && (
              <span className="muted small">
                {" "}· {whoami.data.memberCount} Mitglied{whoami.data.memberCount === 1 ? "" : "er"}
              </span>
            )}
          </dd>
          <dt>Tenant-ID</dt>
          <dd>
            <code>{whoami.data.tenantId}</code>
            <span className="muted small">
              {" "}
              {whoami.data.tenantSource === "claim"
                ? "· aus dem Token-Claim (Keycloak-Tenant)"
                : "· Kompatibilitäts-Fallback: Tenant = User-ID"}
            </span>
          </dd>
          <dt>Konto</dt>
          <dd>
            {whoami.data.email ?? "—"}{" "}
            <span className="muted small">· Nutzer-ID <code>{whoami.data.actorId}</code></span>
          </dd>
          <dt>Berechtigungen</dt>
          <dd>{whoami.data.scopes.join(" · ")}</dd>
        </dl>
      )}
      <GeraeteKonten />
      <p className="muted small">
        Anbieter, Modell, API-Schlüssel und Gedächtnis findest du unter{" "}
        <a href="#/settings">Einstellungen</a>.
      </p>
      <ExternalServiceDiagnostics />
    </section>
  );
}

// T5 — Konten, die auf diesem Geraet bekannt sind (Account-Spaces).
function GeraeteKonten() {
  const konten = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.accounts.list(),
  });
  if (!konten.data || konten.data.accounts.length === 0) return null;
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h3>Konten auf diesem Gerät</h3>
      <dl>
        {konten.data.accounts.map((a) => (
          <span key={a.sub} style={{ display: "contents" }}>
            <dt>{a.sub === konten.data.active ? "aktiv" : "weiteres Konto"}</dt>
            <dd>
              {a.name ?? a.email ?? a.sub}
              {a.email && a.name && <span className="muted small"> · {a.email}</span>}
              {a.tenantName && <span className="muted small"> · {a.tenantName}</span>}
            </dd>
          </span>
        ))}
      </dl>
      <p className="muted small">
        Wechsel und weitere Konten über das Konto-Menü in der Kopfzeile. Lokale
        Daten, Chats und Schlüssel sind je Konto getrennt; nur lokale KI-Modelle
        werden geteilt.
      </p>
    </section>
  );
}

// v0.1.105 — per-service reachability panel. Lists each probed
// upstream (today: unternehmensregister.de + handelsregister.de) with
// its current state, last-checked time, and last-reachable hint. Live
// via the same IPC the under-topbar banner subscribes to.
function ExternalServiceDiagnostics() {
  const [status, setStatus] = useState<ExternalServicesStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.api.externalService.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const off = window.api.externalService.onStatusChanged((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (!status) return null;

  const services = Object.values(status.services);
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h3>Erreichbarkeit der Quellen</h3>
      <dl>
        {services.map((svc) => (
          <ServiceRow key={svc.service} svc={svc} />
        ))}
      </dl>
    </section>
  );
}

function ServiceRow({ svc }: { svc: ExternalServiceStatus }) {
  const label = SERVICE_LABELS[svc.service] ?? svc.service;
  const stateText =
    svc.state === "reachable"
      ? "erreichbar"
      : svc.state === "unreachable"
        ? "nicht erreichbar"
        : "noch nicht geprüft";
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {stateText}
        {svc.lastCheckedAt && (
          <>
            {" "}
            <span className="muted small">
              · zuletzt geprüft {formatTime(svc.lastCheckedAt)}
            </span>
          </>
        )}
        {svc.state !== "reachable" && svc.lastReachableAt && (
          <>
            {" "}
            <span className="muted small">
              · zuletzt erreichbar {formatTime(svc.lastReachableAt)}
            </span>
          </>
        )}
      </dd>
    </>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
