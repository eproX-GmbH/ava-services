// "Gerade Thema" — welche Firmen die Organisation beschaeftigen
// (docs/PLAN_RELEVANZ.md, Abschnitt 10).
//
// Der Teil, der Kollegen zusammenbringt: Zwei Leute, die unabhaengig
// voneinander an derselben Firma arbeiten, erfahren sonst nie voneinander.
//
// Gezeigt wird je Firma eine ANZAHL, nie ein Name. "Wer genau?" waere
// etwas anderes — eine Auswertung einzelner Mitarbeiter durch ihre
// Kollegen. Wer es wissen will, fragt im Team und erfaehrt es von einem
// Menschen, der zustimmt.
//
// Drei Schranken gegen Rueckschluss auf Einzelne setzt das Gateway
// (ab 2 warmen Mitgliedern, nur in Organisationen ab 3, kein Verlauf);
// diese Seite zeigt nur, was zurueckkommt, und erklaert, wenn nichts
// zurueckkommt.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";
import type { RelevanzThema } from "../../../shared/types";

const GRUENDE: Record<string, string> = {
  funktion_abgeschaltet:
    "Deine Organisation hat die Relevanz-Funktion abgeschaltet.",
  aggregat_abgeschaltet:
    "Deine Organisation zeigt diese Übersicht nicht an.",
  organisation_zu_klein:
    "Diese Übersicht gibt es erst ab drei Mitgliedern. Bei weniger ließe sich aus einer Zahl auf eine einzelne Person schließen — und dann wäre es keine Übersicht mehr, sondern eine Auswertung.",
  nicht_erreichbar:
    "Die Übersicht ist gerade nicht abrufbar. Besteht eine Verbindung?",
};

export function Thema() {
  const thema = useQuery({
    queryKey: ["relevanzThema"],
    queryFn: (): Promise<RelevanzThema> => window.api.relevanz.thema(100),
    staleTime: 2 * 60_000,
  });

  const ids = useMemo(
    () => (thema.data?.firmen ?? []).map((f) => f.companyId).sort(),
    [thema.data],
  );

  // Namen einzeln nachladen — dasselbe Muster wie in der
  // Heartbeat-Historie. Das Aggregat traegt bewusst nur Kennungen: Es
  // entsteht aus einer Zaehlung, nicht aus einer Firmenabfrage.
  const namen = useQuery({
    queryKey: ["themaNamen", ids],
    queryFn: async () => {
      const map = new Map<string, string>();
      await Promise.all(
        ids.map(async (cid) => {
          try {
            const d = await gatewayFetch<{ name?: string | null }>(
              `/v1/companies/${encodeURIComponent(cid)}`,
            );
            if (d.name?.trim()) map.set(cid, d.name.trim());
          } catch {
            /* ohne Namen bleibt die Kennung stehen */
          }
        }),
      );
      return map;
    },
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
  });

  const daten = thema.data;

  return (
    <section className="thema">
      <header>
        <div className="ct-page-header">
          <p className="ct-page-header__eyebrow">Organisation</p>
          <h2 className="ct-page-header__title">
            <span className="ct-gradient-text">Gerade Thema</span>
          </h2>
          <p className="ct-page-header__lede">
            Welche Firmen deine Organisation beschäftigen: je Firma die Anzahl
            der Mitglieder, die sie derzeit warm haben. Ohne Namen — wer genau
            dranhängt, steht hier bewusst nicht. Deine eigenen Firmen sind
            mitgezählt.
          </p>
        </div>
      </header>

      {thema.isLoading && <p className="muted">Wird geladen …</p>}

      {!thema.isLoading && !daten?.verfuegbar && (
        <p className="muted" style={{ maxWidth: "46rem" }}>
          {GRUENDE[daten?.grund ?? "nicht_erreichbar"] ??
            "Die Übersicht ist nicht verfügbar."}
        </p>
      )}

      {daten?.verfuegbar && daten.firmen.length === 0 && (
        <p className="muted" style={{ maxWidth: "46rem" }}>
          Zurzeit arbeitet an keiner Firma mehr als ein Mitglied. Sobald sich
          zwei mit derselben Firma befassen, erscheint sie hier.
        </p>
      )}

      {daten?.verfuegbar && daten.firmen.length > 0 && (
        <ul className="thema-liste">
          {daten.firmen.map((f) => (
            <li key={f.companyId} className="thema-eintrag">
              <Link
                to={`/companies/${encodeURIComponent(f.companyId)}`}
                className="thema-eintrag__name"
              >
                {namen.data?.get(f.companyId) ?? f.companyId}
              </Link>
              <span className="thema-eintrag__anzahl">
                {f.anzahl}{" "}
                <span className="muted small">
                  {f.anzahl === 1 ? "Mitglied" : "Mitglieder"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
