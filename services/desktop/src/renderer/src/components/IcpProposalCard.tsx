// I4 ICP-Assistent (docs/PLAN_ICP_ASSISTENT.md, B5/P2) — Erst-Login-Card.
//
// Dezente, NICHT-modale Karte ueber dem Chat, solange kein ICP existiert
// und der Nutzer sie nicht weggeklickt hat. "Spaeter" wird persistiert
// (localStorage — leichte Per-Geraet-Komfortpraeferenz; der Einstieg
// bleibt dauerhaft ueber Firmen → Radar erreichbar).

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const DISMISS_KEY = "ava.icpProposalDismissed";

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function IcpProposalCard(): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (isDismissed()) return;
    let cancelled = false;
    void window.api.discovery
      .getIcp()
      .then((icp) => {
        if (!cancelled && !icp.gesetzt) setVisible(true);
      })
      .catch(() => {
        /* still: Karte lieber nicht zeigen */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="icp-proposal" role="note">
      <div className="icp-proposal__text">
        <strong>In 2 Minuten zum Idealkundenprofil.</strong> Gib nur deine
        Website und deine besten Kunden an — AVA schreibt dir daraus dein
        ICP und der Firmen-Radar findet passende neue Firmen in deiner
        Region.
      </div>
      <div className="icp-proposal__actions">
        <button
          className="proc-toggle radar-import"
          onClick={() => navigate("/icp-assistent")}
        >
          Starten
        </button>
        <button
          className="proc-toggle"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, "1");
            } catch {
              /* ohne Persistenz trotzdem ausblenden */
            }
            setVisible(false);
          }}
        >
          Später
        </button>
      </div>
    </div>
  );
}
