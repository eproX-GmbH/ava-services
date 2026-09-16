// Firmen-Verflechtungen (docs/PLAN_VERFLECHTUNGEN.md §5, V6): Personenseite.
// Eine Person aus Gesellschafterlisten und Geschaeftsfuehrung mit allen Rollen
// und Beteiligungen; zeigt, welche Firmen dieselbe Person verbindet. Nur
// Geburtsjahr, kein Geburtsdatum (§8 Nr. 3).

import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch, GatewayError } from "../api/gateway";
import { useFeature } from "../store/policy";

type Person = {
  id: string;
  vorname: string;
  nachname: string;
  geburtsjahr: number | null;
  wohnort: string | null;
  rollen: Array<{ companyId: string; name: string; location: string | null; registerStatus: string | null; insolvencyStatus: string | null; rolle: string; von: string | null; bis: string | null; quelle: string }>;
  beteiligungen: Array<{ companyId: string; name: string; location: string | null; registerStatus: string | null; insolvencyStatus: string | null; listeDatum: string; aktuell: boolean; prozent: number | null; nennbetragEur: number | null }>;
};

const ROLLE: Record<string, string> = { GESCHAEFTSFUEHRER: "Geschäftsführung", GESELLSCHAFTER: "Gesellschafter", PROKURIST: "Prokura" };
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const datum = (s: string | null) => (s ? new Date(s).toLocaleDateString("de-DE") : "–");

function FirmaLink({ companyId, name, registerStatus, insolvencyStatus }: { companyId: string; name: string; registerStatus: string | null; insolvencyStatus: string | null }) {
  const hinweise = [registerStatus === "CLOSED" ? "gelöscht" : null, registerStatus === "LOESCHUNG_ANGEKUENDIGT" ? "Löschung angekündigt" : null, insolvencyStatus && insolvencyStatus !== "NONE" ? `Insolvenz ${insolvencyStatus}` : null].filter(Boolean);
  return (
    <>
      <Link to={`/companies/${encodeURIComponent(companyId)}`}>{name}</Link>
      {hinweise.length > 0 && <span className="muted small"> ({hinweise.join(", ")})</span>}
    </>
  );
}

export function PersonDetail() {
  const { id } = useParams<{ id: string }>();
  const erlaubt = useFeature("verflechtungen");
  const q = useQuery<Person>({
    queryKey: ["person", id],
    queryFn: () => gatewayFetch<Person>(`/v1/verflechtungen/personen/${encodeURIComponent(id ?? "")}`),
    enabled: !!id && erlaubt,
    retry: false,
  });
  if (!erlaubt) return <section className="page"><p className="muted">Firmen-Verflechtungen sind in deiner Organisation nicht freigeschaltet.</p></section>;
  if (q.isLoading) return <section className="page"><p>Lädt…</p></section>;
  if (q.error) {
    const nf = q.error instanceof GatewayError && q.error.status === 404;
    return <section className="page"><p className={nf ? "muted" : "error"}>{nf ? "Person nicht gefunden." : (q.error as Error).message}</p></section>;
  }
  const p = q.data!;
  const aktuelleRollen = p.rollen.filter((r) => !r.bis);
  const fruehereRollen = p.rollen.filter((r) => r.bis);
  const aktuelleBeteiligungen = p.beteiligungen.filter((b) => b.aktuell);
  const firmen = new Set([...p.rollen.map((r) => r.companyId), ...p.beteiligungen.map((b) => b.companyId)]);

  return (
    <section className="page" style={{ display: "grid", gap: "1.5rem" }}>
      <header>
        <p className="muted small" style={{ margin: 0 }}>
          <Link to="/companies">Meine Firmen</Link> · Person
        </p>
        <h2 style={{ margin: "0.2rem 0" }}>
          {p.vorname} {p.nachname}
        </h2>
        <p className="muted" style={{ margin: 0 }}>
          {[p.geburtsjahr ? `Jahrgang ${p.geburtsjahr}` : null, p.wohnort].filter(Boolean).join(" · ") || "Keine weiteren Angaben"} · verbunden mit {firmen.size} {firmen.size === 1 ? "Firma" : "Firmen"}
        </p>
      </header>

      <article className="panel">
        <h3 style={{ marginTop: 0 }}>Rollen</h3>
        {p.rollen.length === 0 && <p className="muted">Keine Rollen bekannt.</p>}
        {aktuelleRollen.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Firma</th>
                <th>Rolle</th>
                <th>Seit</th>
                <th>Quelle</th>
              </tr>
            </thead>
            <tbody>
              {aktuelleRollen.map((r, i) => (
                <tr key={`${r.companyId}-${r.rolle}-${i}`}>
                  <td>
                    <FirmaLink {...r} />
                    {r.location && <span className="muted small"> {r.location}</span>}
                  </td>
                  <td>{ROLLE[r.rolle] ?? r.rolle}</td>
                  <td>{datum(r.von)}</td>
                  <td className="muted small">{r.quelle === "gesellschafterliste" ? "Gesellschafterliste" : "Handelsregister"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {fruehereRollen.length > 0 && (
          <>
            <h4>Frühere Rollen</h4>
            <ul className="muted small">
              {fruehereRollen.map((r, i) => (
                <li key={`${r.companyId}-${r.rolle}-alt-${i}`}>
                  <FirmaLink {...r} />: {ROLLE[r.rolle] ?? r.rolle}, {datum(r.von)} bis {datum(r.bis)}
                </li>
              ))}
            </ul>
          </>
        )}
      </article>

      <article className="panel">
        <h3 style={{ marginTop: 0 }}>Beteiligungen</h3>
        {aktuelleBeteiligungen.length === 0 && <p className="muted">Keine aktuellen Beteiligungen bekannt.</p>}
        {aktuelleBeteiligungen.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Firma</th>
                <th style={{ textAlign: "right" }}>Anteil</th>
                <th style={{ textAlign: "right" }}>Nennbetrag</th>
                <th>Liste vom</th>
              </tr>
            </thead>
            <tbody>
              {aktuelleBeteiligungen.map((b) => (
                <tr key={`${b.companyId}-${b.listeDatum}`}>
                  <td>
                    <FirmaLink {...b} />
                  </td>
                  <td style={{ textAlign: "right" }}>{b.prozent != null ? `${b.prozent.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %` : "–"}</td>
                  <td style={{ textAlign: "right" }}>{b.nennbetragEur != null ? eur.format(b.nennbetragEur) : "–"}</td>
                  <td>{datum(b.listeDatum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {p.beteiligungen.some((b) => !b.aktuell) && (
          <p className="muted small">Ältere Listen: {p.beteiligungen.filter((b) => !b.aktuell).map((b) => `${b.name} (${datum(b.listeDatum)})`).join(", ")}</p>
        )}
      </article>
    </section>
  );
}
