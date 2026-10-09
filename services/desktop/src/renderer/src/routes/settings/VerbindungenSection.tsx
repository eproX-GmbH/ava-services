// Verbundene Dienste (docs/PLAN_MCP_OEFFNUNG.md, P5): OAuth-Clients, die der
// Nutzer fuer AVA freigegeben hat (Claude, ChatGPT, Claude Code ueber MCP),
// mit Widerruf. Quelle ist Keycloak ueber das Gateway; es sind nur die
// eigenen Einwilligungen des angemeldeten Nutzers.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch, GatewayError } from "../../api/gateway";
import { usePolicyStore } from "../../store/policy";

interface Verbindung {
  clientId: string;
  name: string | null;
  mcp: boolean;
  erteiltAt: string | null;
  zuletztAt: string | null;
  scopes: string[];
}

const datum = (s: string | null) => (s ? new Date(s).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "–");

export function VerbindungenSection() {
  const qc = useQueryClient();
  // Hauptschalter ist standardmaessig aus: nur ausdrueckliches true zaehlt.
  const mcpErlaubt = usePolicyStore((s) => s.policy.features["mcp"] === true);
  const q = useQuery<{ items: Verbindung[] }>({
    queryKey: ["auth", "verbindungen"],
    queryFn: () => gatewayFetch<{ items: Verbindung[] }>("/v1/auth/verbindungen"),
    retry: false,
    staleTime: 30_000,
  });
  const widerruf = useMutation({
    mutationFn: (clientId: string) => gatewayFetch<{ ok: boolean; entfernt: boolean }>(`/v1/auth/verbindungen/${encodeURIComponent(clientId)}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["auth", "verbindungen"] }),
  });
  const items = (q.data?.items ?? []).filter((v) => v.mcp || v.clientId !== "ava-desktop");
  const fehler = q.error instanceof GatewayError && q.error.status === 503 ? "Die Verwaltung der Verbindungen ist auf diesem Gateway nicht eingerichtet." : q.error instanceof Error ? q.error.message : null;

  return (
    <section id="verbindungen" className="provider-section" aria-label="Verbundene Dienste">
      <h3>Verbundene Dienste</h3>
      <p className="muted">
        Claude, ChatGPT oder Claude Code können AVA über MCP nutzen: Firmen lesen, Meldungen abrufen, Importe und
        Recherchen anstoßen. Du verbindest sie dort mit der Adresse{" "}
        <code>https://mcp.ava.bi</code> und meldest dich mit deinem AVA-Konto an. Jeder Dienst sieht nur
        deine eigenen Daten; die Verarbeitung läuft weiter auf diesem Rechner.
      </p>
      {!mcpErlaubt && (
        <p className="muted small">
          Deine Organisation hat den MCP-Zugang nicht freigeschaltet (Einstellungen → Organisation → Module). Bestehende
          Verbindungen erhalten dann keine Werkzeuge.
        </p>
      )}
      {q.isLoading && <p className="muted">Lädt…</p>}
      {fehler && <p className="muted">{fehler}</p>}
      {q.data && items.length === 0 && <p className="muted">Noch kein Dienst verbunden.</p>}
      {items.length > 0 && (
        <table className="kunden-tabelle">
          <thead>
            <tr>
              <th>Dienst</th>
              <th>Verbunden seit</th>
              <th>Zuletzt genutzt</th>
              <th className="kunden-aktion" aria-label="Aktion" />
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.clientId}>
                <td>
                  {v.name ?? v.clientId}
                  {v.mcp && <span className="pill pill--active" style={{ marginLeft: 6 }}>MCP</span>}
                  <div className="muted small">{v.clientId}</div>
                </td>
                <td>{datum(v.erteiltAt)}</td>
                <td>{datum(v.zuletztAt)}</td>
                <td className="kunden-aktion">
                  <button type="button" className="danger" disabled={widerruf.isPending} onClick={() => widerruf.mutate(v.clientId)}>
                    Trennen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {widerruf.error && <p className="error">{(widerruf.error as Error).message}</p>}
    </section>
  );
}
