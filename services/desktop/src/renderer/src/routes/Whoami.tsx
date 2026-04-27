import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";

// Smoke-test screen: hits the gateway's /v1/whoami endpoint (kept in v1.ts
// precisely for this purpose). Confirms the auth pipeline + the gateway URL
// wiring before we trust any business endpoint.

interface WhoamiResponse {
  tenantId: string;
  actorId: string;
  scopes: string[];
}

export function Whoami() {
  const q = useQuery({
    queryKey: ["whoami"],
    queryFn: () => gatewayFetch<WhoamiResponse>("/v1/whoami"),
  });

  return (
    <section>
      <h2>Whoami</h2>
      {q.isLoading && <p>Loading…</p>}
      {q.error && <p className="error">Error: {(q.error as Error).message}</p>}
      {q.data && (
        <dl>
          <dt>Tenant</dt><dd>{q.data.tenantId}</dd>
          <dt>Actor</dt><dd>{q.data.actorId}</dd>
          <dt>Scopes</dt><dd>{q.data.scopes.join(" · ")}</dd>
        </dl>
      )}
    </section>
  );
}
