import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Building2, User2, KeyRound } from "lucide-react";
import { gatewayFetch } from "../api/gateway";

// Whoami screen — identity only.
//
// Phase 8.g moved the agent provider/key/model UI and the local-models
// panel to the dedicated `/settings` route. This page is back to being a
// thin smoke-test for the gateway URL + auth wiring (kept since Step 6).
//
// Visual: Corporate Trust hero header (gradient title + lede + soft
// blob) plus a card grid with colored icon tiles for each identity row.
// Logic + data flow are unchanged.

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
    <section className="page">
      <header className="ct-page-header">
        <p className="ct-page-header__eyebrow">Sitzung</p>
        <h2 className="ct-page-header__title">
          Angemeldet als <span className="ct-gradient-text">aktiver Akteur</span>
        </h2>
        <p className="ct-page-header__lede">
          Identitäts- und Berechtigungs-Smoke-Test gegen das Gateway. Anbieter,
          Modell, API-Schlüssel und Gedächtnis findest du unter{" "}
          <a href="#/settings">Einstellungen</a>.
        </p>
      </header>
      {whoami.isLoading && <div className="loading">Lädt…</div>}
      {whoami.error && (
        <div className="ct-card" role="alert">
          <p className="error">Fehler: {(whoami.error as Error).message}</p>
        </div>
      )}
      {whoami.data && (
        <div className="ct-grid">
          <IdentityCard
            icon={<Building2 className="ct-icon" aria-hidden="true" />}
            label="Mandant"
            value={whoami.data.tenantId}
          />
          <IdentityCard
            icon={<User2 className="ct-icon" aria-hidden="true" />}
            label="Akteur"
            value={whoami.data.actorId}
          />
          <IdentityCard
            icon={<KeyRound className="ct-icon" aria-hidden="true" />}
            label="Berechtigungen"
            value={whoami.data.scopes.join(" · ") || "—"}
          />
          <IdentityCard
            icon={<ShieldCheck className="ct-icon" aria-hidden="true" />}
            label="Status"
            value="aktiv · authentifiziert"
            tone="emerald"
          />
        </div>
      )}
    </section>
  );
}

function IdentityCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "indigo" | "emerald";
}) {
  return (
    <div className="ct-card ct-card-lift identity-card">
      <span
        className={
          "ct-icon-tile" +
          (tone === "emerald" ? " ct-icon-tile--emerald" : "")
        }
        aria-hidden="true"
      >
        {icon}
      </span>
      <div>
        <div className="identity-card__label">{label}</div>
        <div className="identity-card__value">{value}</div>
      </div>
    </div>
  );
}
