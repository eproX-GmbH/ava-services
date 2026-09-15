// Insolvenz-Delta — Abschnitt "Insolvenz" in der Firmenuebersicht: Status und
// die gespeicherten Veroeffentlichungen des Insolvenzportals. Erscheint nur,
// wenn es Ereignisse gibt; sonst ein Knopf "Jetzt pruefen".
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";
import { insolvenzText } from "./RegisterStatusBadge";

type Ereignis = { id: number; aktenzeichen: string; insolvenzgericht: string; datum: string; gegenstand: string; text: string };
type Antwort = { insolvencyStatus: string; insolvencyAt: string | null; insolvencyCheckedAt: string | null; events: Ereignis[] };

const GEGENSTAND: Record<string, string> = {
  EROEFFNUNG: "Eröffnung",
  ABWEISUNG_MANGELS_MASSE: "Abweisung mangels Masse",
  SICHERUNGSMASSNAHME: "Sicherungsmaßnahme",
  AUFHEBUNG: "Aufhebung",
  EINSTELLUNG: "Einstellung",
  ENTSCHEIDUNG: "Entscheidung im Verfahren",
  VERTEILUNG: "Verteilungsverzeichnis",
  INSOLVENZPLAN: "Insolvenzplan",
  SONSTIGES: "Sonstiges",
};

export function InsolvenzAbschnitt({ companyId, status }: { companyId: string; status?: string | null }) {
  const qc = useQueryClient();
  const [offen, setOffen] = useState<number | null>(null);
  const [angefordert, setAngefordert] = useState(false);
  const q = useQuery({
    queryKey: ["insolvenz", companyId],
    queryFn: () => gatewayFetch<Antwort>(`/v1/companies/${encodeURIComponent(companyId)}/insolvency-events`),
    enabled: !!companyId,
  });
  const pruefen = async () => {
    setAngefordert(true);
    try {
      await gatewayFetch(`/v1/register-jobs/insolvenz`, { method: "POST", body: { companyIds: [companyId], grund: "firmendetail" } });
    } catch {
      setAngefordert(false);
    }
  };
  const d = q.data;
  const t = insolvenzText(d?.insolvencyStatus ?? status);
  if (!d || (d.events.length === 0 && !t)) {
    return (
      <p className="muted small" style={{ marginBottom: "0.75rem" }}>
        Insolvenzportal: {d?.insolvencyCheckedAt ? `keine Veröffentlichung, zuletzt geprüft am ${new Date(d.insolvencyCheckedAt).toLocaleDateString("de-DE")}.` : "noch nicht geprüft."}{" "}
        <button type="button" className="btn" disabled={angefordert} onClick={() => void pruefen()}>
          {angefordert ? "Prüfung eingereiht" : "Jetzt prüfen"}
        </button>
      </p>
    );
  }
  return (
    <section className="provider-section" style={{ marginBottom: "1rem" }}>
      <h3>
        Insolvenz{t ? `: ${t.text}` : ""}
        {d.insolvencyAt ? <span className="muted small"> seit {new Date(d.insolvencyAt).toLocaleDateString("de-DE")}</span> : null}
      </h3>
      <p className="muted small">
        Quelle: Insolvenzbekanntmachungen der Justiz. {d.insolvencyCheckedAt ? `Zuletzt geprüft am ${new Date(d.insolvencyCheckedAt).toLocaleDateString("de-DE")}.` : ""}{" "}
        <button type="button" className="btn" disabled={angefordert} onClick={() => void pruefen().then(() => qc.invalidateQueries({ queryKey: ["insolvenz", companyId] }))}>
          {angefordert ? "Prüfung eingereiht" : "Erneut prüfen"}
        </button>
      </p>
      <ul className="kv">
        {d.events.map((e: Ereignis) => (
          <li key={e.id}>
            <span className="muted">{new Date(e.datum).toLocaleDateString("de-DE")}</span> · {GEGENSTAND[e.gegenstand] ?? e.gegenstand} · Amtsgericht {e.insolvenzgericht}, {e.aktenzeichen}{" "}
            <button type="button" className="btn" onClick={() => setOffen(offen === e.id ? null : e.id)}>
              {offen === e.id ? "Text ausblenden" : "Text anzeigen"}
            </button>
            {offen === e.id && <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "12px", marginTop: "0.4rem" }}>{e.text}</pre>}
          </li>
        ))}
      </ul>
    </section>
  );
}
