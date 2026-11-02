// Tab „Recherche“ (docs/PLAN_EINSTELLUNGEN_UI.md §3): Wonach sucht AVA bei
// meinen Firmen? Fokus-Themen, Beobachtungen, Link-Ueberwachung, E-Mail-Adressen,
// Stammdaten mitpflegen. Stellen/Ausschreibungen laufen seit 2026-11-02 immer
// (Stufe Standard, Betreiber-Spur) und sind keine Einstellung mehr.
import { WatchesSection } from "../Settings";
import { ThemenSection } from "./ThemenSection";
import { LinkMonitorSection } from "./LinkMonitorSection";
import { EmailMusterSection } from "./EmailMusterSection";
import { MithelfenSection } from "./MithelfenSection";

export function RechercheTab() {
  return (
    <>
      <ThemenSection />
      <WatchesSection />
      <LinkMonitorSection />
      <EmailMusterSection />
      <MithelfenSection />
    </>
  );
}
