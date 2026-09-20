// Mit dir geteilte Buying Center (docs/PLAN_BUYING_CENTER.md, BC7, 8.3).
//
// Was Kollegen freigegeben haben, bekommt einen eigenen Ort, getrennt von
// allem Eigenen: eine Liste von Firmen, aufklappbar, darunter je Firma die
// Buying Center der einzelnen Kollegen mit Eigentuemer, Anlass und Stand.
// Ein Klick oeffnet einen eigenen Bildschirm mit derselben Karte und
// Seitenleiste — ohne jede Bearbeitung. Oben steht, wem es gehoert.
//
// Der Bereich erscheint in der Navigation nur, wenn mindestens eine
// Freigabe existiert (AppShell fragt dieselbe Route ab).

import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";
import { BuyingCenterKarte } from "../components/BuyingCenterKarte";

interface Eigentuemer { actorId: string; email: string | null; name: string | null }
export interface GeteiltesBuyingCenter {
  id: string; companyId: string; companyName: string | null; anlass: string; status: string;
  eigentuemer: Eigentuemer; angelegtAt: string; updatedAt: string; mitglieder: number;
}

function wer(e: Eigentuemer): string {
  return e.name ?? e.email ?? e.actorId;
}
function datum(iso: string): string {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Ein Abfrageschluessel fuer Seite und Navigation — die Antwort ist dieselbe. */
export function useGeteilteBuyingCenter(enabled = true) {
  return useQuery<{ items: GeteiltesBuyingCenter[] }>({
    queryKey: ["buying-center", "geteilt"],
    queryFn: () => gatewayFetch<{ items: GeteiltesBuyingCenter[] }>("/v1/buying-center-geteilt"),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function BuyingCenterGeteilt() {
  const q = useGeteilteBuyingCenter();
  const firmen = useMemo(() => {
    const map = new Map<string, { companyId: string; name: string; eintraege: GeteiltesBuyingCenter[] }>();
    for (const e of q.data?.items ?? []) {
      const f = map.get(e.companyId) ?? { companyId: e.companyId, name: e.companyName ?? e.companyId, eintraege: [] };
      f.eintraege.push(e);
      map.set(e.companyId, f);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "de"));
  }, [q.data]);

  return (
    <section className="bcg">
      <header>
        <div className="ct-page-header">
          <p className="ct-page-header__eyebrow">Organisation</p>
          <h2 className="ct-page-header__title">
            <span className="ct-gradient-text">Mit dir geteilte Buying Center</span>
          </h2>
          <p className="ct-page-header__lede">
            Was Kollegen dir zum Ansehen freigegeben haben. Jedes Buying Center ist die Einschätzung
            einer einzelnen Person — ändern kann es nur, wem es gehört.
          </p>
        </div>
      </header>

      {q.isLoading && <p className="muted">Wird geladen …</p>}
      {q.error && <p className="muted">Die Liste ist gerade nicht abrufbar. Besteht eine Verbindung?</p>}
      {q.data && firmen.length === 0 && (
        <p className="muted" style={{ maxWidth: "46rem" }}>
          Niemand hat dir ein Buying Center freigegeben. Sobald ein Kollege eines teilt, erscheint es hier.
        </p>
      )}

      {firmen.length > 0 && (
        <div className="bcg-firmen">
          {firmen.map((f) => (
            <details key={f.companyId} className="bcg-firma" open={firmen.length <= 3}>
              <summary>
                <Link to={`/companies/${encodeURIComponent(f.companyId)}`}>{f.name}</Link>
                <span className="muted small">{f.eintraege.length === 1 ? "1 Buying Center" : `${f.eintraege.length} Buying Center`}</span>
              </summary>
              <ul className="bcg-eintraege">
                {f.eintraege.map((e) => (
                  <li key={e.id} className="bcg-eintrag">
                    <Link to={`/buying-center/geteilt/${encodeURIComponent(e.id)}`}>
                      <strong>{wer(e.eigentuemer)}</strong>
                      <span className="muted"> · {e.anlass ? `„${e.anlass}“` : "(ohne Anlass)"}</span>
                      <span className="muted"> · {e.mitglieder} Personen · zuletzt {datum(e.updatedAt)}</span>
                      {e.status !== "aktiv" && <span className="muted"> · {e.status}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

export function BuyingCenterGeteiltDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useGeteilteBuyingCenter();
  const e = q.data?.items.find((x) => x.id === id) ?? null;

  return (
    <section className="bcg">
      <p className="small">
        <Link to="/buying-center/geteilt">← Mit dir geteilte Buying Center</Link>
      </p>
      <header>
        <div className="ct-page-header">
          <p className="ct-page-header__eyebrow">{e ? (e.companyName ?? e.companyId) : "Buying Center"}</p>
          <h2 className="ct-page-header__title">
            <span className="ct-gradient-text">{e ? `Buying Center von ${wer(e.eigentuemer)}` : "Geteiltes Buying Center"}</span>
          </h2>
          {e && (
            <p className="ct-page-header__lede">
              {e.anlass ? `Anlass „${e.anlass}“ · ` : ""}Stand {datum(e.updatedAt)} · nur ansehen. Du siehst die Einschätzungen von{" "}
              {wer(e.eigentuemer)}; ändern kann sie nur {e.eigentuemer.name ?? "der Eigentümer"}. Verschobene Knoten werden nicht gespeichert.
            </p>
          )}
          {q.data && !e && (
            <p className="ct-page-header__lede muted">Dieses Buying Center ist dir nicht (mehr) freigegeben.</p>
          )}
        </div>
      </header>
      {id && <BuyingCenterKarte id={id} />}
    </section>
  );
}
