// Einstellungen → Konto → Erlaubnisse (docs/PLAN_ERLAUBNISSE.md §2.4): was AVA
// dauerhaft ohne Rueckfrage darf („Immer erlauben“) und welche Workflows
// selbststaendig laufen; beides einzeln oder ganz zuruecknehmen.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { bestaetigen } from "../../components/Bestaetigung";
import { werkzeugTitel } from "../../../../shared/werkzeug-titel";

const datum = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

export function ErlaubnisseSection() {
  const qc = useQueryClient();
  const erlaubnisse = useQuery({ queryKey: ["erlaubnisse"], queryFn: () => window.api.erlaubnisse.liste() });
  const workflows = useQuery({ queryKey: ["workflows", "liste"], queryFn: () => window.api.workflows.list() });
  const liste = erlaubnisse.data ?? [];
  const selbst = (workflows.data ?? []).filter((w) => w.autonomous);
  const neuLaden = () => void qc.invalidateQueries({ queryKey: ["erlaubnisse"] });

  const widerrufen = async (werkzeug: string) => {
    await window.api.erlaubnisse.widerrufen(werkzeug);
    neuLaden();
  };
  const alleWiderrufen = async () => {
    if (!(await bestaetigen({ titel: "Alle dauerhaften Erlaubnisse zurücknehmen?", text: "AVA fragt danach wieder bei jeder Aktion nach.", bestaetigen: "Alle zurücknehmen" }))) return;
    await window.api.erlaubnisse.alleWiderrufen();
    neuLaden();
  };
  const vorherFragen = async (id: string) => {
    const def = await window.api.workflows.get(id);
    if (!def) return;
    await window.api.workflows.patch(id, { settings: { ...def.settings, autonomous: false } });
    void qc.invalidateQueries({ queryKey: ["workflows"] });
  };

  return (
    <section id="erlaubnisse-section" className="provider-section" aria-label="Erlaubnisse">
      <h3>Erlaubnisse</h3>
      <p className="muted">
        Wenn AVA vor einer Aktion fragt, kannst du „Immer erlauben“ wählen. Diese Aktionen führt AVA danach ohne Rückfrage aus, im Chat, über Telegram und in
        Workflows. Hier nimmst du eine Erlaubnis jederzeit zurück; AVA fragt dann wieder.
      </p>
      {erlaubnisse.isLoading && <p className="muted">Lädt …</p>}
      {erlaubnisse.data && liste.length === 0 && <p className="muted">Noch nichts dauerhaft erlaubt. Wählst du bei einer Rückfrage „Immer erlauben“, steht die Aktion hier.</p>}
      {liste.length > 0 && (
        <table className="kunden-tabelle">
          <thead>
            <tr>
              <th>Aktion</th>
              <th>Erlaubt seit</th>
              <th className="kunden-aktion" aria-label="Zurücknehmen" />
            </tr>
          </thead>
          <tbody>
            {liste.map((e) => (
              <tr key={e.werkzeug}>
                <td>
                  {werkzeugTitel(e.werkzeug)}
                  {e.loeschend && <span className="pill pill--paused" style={{ marginLeft: 6 }}>löscht ohne Rückfrage</span>}
                  {e.beispiel && <div className="muted small">zuletzt gefragt: „{e.beispiel}“</div>}
                </td>
                <td>{datum(e.seit)}</td>
                <td className="kunden-aktion">
                  <button type="button" onClick={() => void widerrufen(e.werkzeug)}>
                    Zurücknehmen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {liste.length > 1 && (
        <div className="u-row" style={{ marginTop: 8 }}>
          <button type="button" onClick={() => void alleWiderrufen()}>
            Alle zurücknehmen
          </button>
        </div>
      )}
      {selbst.length > 0 && (
        <>
          <h4>Workflows, die selbstständig laufen</h4>
          <p className="muted small">Diese Workflows führen alle Schritte ohne Rückfrage aus, auch Löschen und Mail-Versand.</p>
          <table className="kunden-tabelle">
            <tbody>
              {selbst.map((w) => (
                <tr key={w.id}>
                  <td>
                    <Link to={`/workflows/${w.id}`}>{w.name}</Link>
                  </td>
                  <td className="kunden-aktion">
                    <button type="button" onClick={() => void vorherFragen(w.id)}>
                      Wieder vorher fragen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
