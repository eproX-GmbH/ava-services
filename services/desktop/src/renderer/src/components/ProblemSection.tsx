// docs/PLAN_PROBLEM_MELDEN.md — Einstellungen → Erweitert: Einstieg zu „Problem melden“
// und „Meine Problemmeldungen“ (derselbe Dialog wie unten links im Chat).
import { LifeBuoy } from "lucide-react";
import { problemMeldenOeffnen, useProblemUngelesen } from "./ProblemMeldenDialog";

export function ProblemSection() {
  const ungelesen = useProblemUngelesen();
  return (
    <section id="problem-section" className="ct-card u-mb-2">
      <header className="ct-card__header">
        <h3><LifeBuoy className="ct-icon-sm" aria-hidden="true" /> Problem melden</h3>
        <p className="muted">Etwas funktioniert nicht oder du hast einen Wunsch? Beschreibe es kurz; Protokolle und Angaben zu deinem Gerät gehen automatisch mit, Schlüssel und Passwörter werden maskiert. Das AVA-Team antwortet dir hier in AVA.</p>
      </header>
      <div className="u-row">
        <button type="button" className="btn btn--primaer" onClick={() => problemMeldenOeffnen({ ansicht: "neu" })}>Problem melden</button>
        <button type="button" className="btn" onClick={() => problemMeldenOeffnen({ ansicht: "liste" })}>
          Meine Meldungen{ungelesen > 0 ? ` (${ungelesen} neu)` : ""}
        </button>
      </div>
    </section>
  );
}
