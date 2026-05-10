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
          <dt>Mandant</dt>
          <dd>{whoami.data.tenantId}</dd>
          <dt>Akteur</dt>
          <dd>{whoami.data.actorId}</dd>
          <dt>Berechtigungen</dt>
          <dd>{whoami.data.scopes.join(" · ")}</dd>
        </dl>
      )}
      <p className="muted small">
        Anbieter, Modell, API-Schlüssel und Gedächtnis findest du unter{" "}
        <a href="#/settings">Einstellungen</a>.
      </p>
      <ExternalServiceDiagnostics />
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
