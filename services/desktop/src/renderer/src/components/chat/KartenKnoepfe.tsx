// L4 (docs/PLAN_LOESUNGSKARTEN.md): Knoepfe der Loesungskarte unter AVAs Antwort.
// Gleiche Optik wie "Nächster Schritt". Öffnen springt direkt auf die Seite,
// Zugang zeigt die sichere Zugangskarte ohne Umweg ueber das Modell, ein
// Vorschlag geht als Nachricht an AVA.
import { useState } from "react";
import type { AgentKartenAktion } from "../../../../shared/types";
import type { ZugangErgebnis } from "../../../../shared/dienst-vorlagen";
import { ZugangKarte } from "./ZugangKarte";

const AKTION_TEXT: Record<AgentKartenAktion["art"], string> = {
  app_oeffnen: "Öffnen",
  zugang_anfordern: "Eingeben",
  chat_vorschlag: "Los",
};

export function KartenKnoepfe({ aktionen, onOeffnen, onAuftrag, gesperrt }: { aktionen: AgentKartenAktion[]; onOeffnen: (pfad: string) => void; onAuftrag: (text: string) => void; gesperrt?: boolean }) {
  const [zugang, setZugang] = useState<{ aktion: AgentKartenAktion; ergebnis?: ZugangErgebnis } | null>(null);
  if (aktionen.length === 0) return null;
  const klick = (a: AgentKartenAktion) => {
    if (a.art === "app_oeffnen" && a.pfad) onOeffnen(a.pfad);
    else if (a.art === "zugang_anfordern") setZugang({ aktion: a });
    else if (a.art === "chat_vorschlag" && a.auftrag) onAuftrag(a.auftrag);
  };
  return (
    <>
      <div className="vs-chips vs-chips--kompakt karten-knoepfe" role="list" aria-label="Passende Schritte">
        {aktionen.map((a) => (
          <div key={`${a.art}-${a.label}`} className="vs-chip" role="listitem">
            <button type="button" className="vs-chip__main" onClick={() => klick(a)} disabled={gesperrt && a.art === "chat_vorschlag"} title={a.auftrag ?? a.label}>
              <span className="vs-chip__stufe" aria-hidden="true">
                ›
              </span>
              <span className="vs-chip__text">
                <span className="vs-chip__titel">{a.label}</span>
              </span>
              <span className="vs-chip__aktion">{AKTION_TEXT[a.art]}</span>
            </button>
          </div>
        ))}
      </div>
      {zugang && (
        <ZugangKarte
          anfrage={{ ...(zugang.aktion.vorlage ? { vorlage: zugang.aktion.vorlage } : {}), ...(zugang.aktion.dienst ? { name: zugang.aktion.dienst } : {}) }}
          ergebnis={zugang.ergebnis}
          onFertig={(e) => setZugang((z) => (z ? (e.abgebrochen ? null : { ...z, ergebnis: e }) : z))}
        />
      )}
    </>
  );
}
