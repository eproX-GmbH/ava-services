// Tab „Recherche“ (docs/PLAN_EINSTELLUNGEN_UI.md §3): Wonach sucht AVA bei
// meinen Firmen? Fokus-Themen, Stellen/Ausschreibungen/Expansion, Beobachtungen,
// Link-Ueberwachung, Auffrischung, E-Mail-Adressen, Stammdaten mitpflegen.
import { WatchesSection } from "../Settings";
import { ThemenSection } from "./ThemenSection";
import { ResearchFeaturesSection } from "./ResearchFeaturesSection";
import { LinkMonitorSection } from "./LinkMonitorSection";
import { EmailMusterSection } from "./EmailMusterSection";
import { MithelfenSection } from "./MithelfenSection";

export function RechercheTab() {
  return (
    <>
      <ThemenSection />
      <ResearchFeaturesSection />
      <WatchesSection />
      <LinkMonitorSection />
      <EmailMusterSection />
      <MithelfenSection />
    </>
  );
}
