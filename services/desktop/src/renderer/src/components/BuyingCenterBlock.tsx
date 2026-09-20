// Block-Wrapper fuer einen ```buying-center-Zaun im Chat.
//
// Anders als beim Diagramm traegt der Zaun NUR die Kennung. Die Karte wird
// beim Anzeigen frisch geladen — ein drei Wochen alter Verlauf zeigt den
// heutigen Stand, keinen Schnappschuss von damals.

import { BuyingCenterKarte } from "./BuyingCenterKarte";
import { useFeature } from "../store/policy";

export function BuyingCenterBlock({ raw }: { raw: string }) {
  // BC6 — hat die Organisation das Buying Center abgeschaltet, bleibt auch
  // ein alter Zaun im Verlauf leer: nichts Ausgegrautes, kein Hinweis.
  const erlaubt = useFeature("buyingcenter");
  let id: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(parsed.id)) id = parsed.id;
  } catch {
    /* unten behandelt */
  }
  if (!erlaubt) return null;
  if (!id) {
    return (
      <div className="chart-fallback">
        <div className="hint">Das Buying Center konnte nicht angezeigt werden: Der Block enthält keine gültige Kennung.</div>
      </div>
    );
  }
  return <BuyingCenterKarte id={id} kompakt />;
}
