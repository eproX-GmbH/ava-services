// Tab „Meldungen“ (docs/PLAN_EINSTELLUNGEN_UI.md §3): Was meldet AVA mir, wann
// und wo? Meldungen und Ruhezeiten, Naehe und Vorrang, Vorschlaege im Chat.
// Die Zustellung aufs Handy steht bei der Telegram-Verbindung (Tab Verbindungen).
import { AlertsSection } from "../Settings";
import { RelevanzSection } from "./RelevanzSection";
import { VorschlaegeSection } from "./VorschlaegeSection";
import { useFeature } from "../../store/policy";

export function MeldungenTab() {
  const relevanz = useFeature("relevanz");
  return (
    <>
      <AlertsSection />
      {relevanz && <RelevanzSection />}
      <VorschlaegeSection />
    </>
  );
}
