// Hinweisband: AVA läuft im Worker-Modus und verarbeitet ausschließlich
// Handelsregister-Jobs. Alles andere ruht, deshalb soll das dauerhaft sichtbar
// sein und sich nicht wegklicken lassen: sonst wundert man sich, warum keine
// Vorgänge laufen.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { MithelfenStatus } from "../../../shared/register-delta-types";

export function WorkerModusBanner() {
  const [status, setStatus] = useState<MithelfenStatus | null>(null);
  useEffect(() => {
    void window.api.registerDelta.status().then(setStatus).catch(() => undefined);
    return window.api.registerDelta.onStatus(setStatus);
  }, []);
  if (!status?.nurRegister) return null;
  return (
    <div className="worker-modus-banner" role="status">
      <span className="worker-modus-banner__icon" aria-hidden>
        ⚙️
      </span>
      <p className="worker-modus-banner__msg">
        <strong>Worker-Modus.</strong> AVA verarbeitet gerade nur Handelsregister-Jobs. Vorgänge, Recherchen, Abläufe, Mail und Radar ruhen.
      </p>
      <Link to="/settings/automatisierungen#mithelfen-section" className="worker-modus-banner__cta">
        Einstellung öffnen
      </Link>
    </div>
  );
}
