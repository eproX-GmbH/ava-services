import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";

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
    </section>
  );
}
