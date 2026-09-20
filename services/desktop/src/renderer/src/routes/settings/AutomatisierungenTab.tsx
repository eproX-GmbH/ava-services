import {
  FreshnessSection,
  AlertsSection,
  WatchesSection,
} from "../Settings";
import { SchedulerSection } from "./SchedulerSection";
import { LinkMonitorSection } from "./LinkMonitorSection";
import { TelegramSection } from "./TelegramSection";
import { EmailMusterSection } from "./EmailMusterSection";
import { VorschlaegeSection } from "./VorschlaegeSection";
import { MithelfenSection } from "./MithelfenSection";
import { BrowserSection } from "./BrowserSection";
import { RelevanzSection } from "./RelevanzSection";
import { useFeature } from "../../store/policy";

// v0.1.273+ — Automatisierungen-Tab.
//
// Sammelt alle "AVA arbeitet im Hintergrund für mich"-Funktionen:
//   - Watches (LLM-Rubrics gegen Heartbeat-Kandidaten)
//   - Scheduler-Jobs (wiederkehrende Mails — v0.1.274)
//   - Freshness-Scheduler (Datenrefresh-Cadences)
//   - Alerts / Heartbeat-Trigger
export function AutomatisierungenTab() {
  const telegramErlaubt = useFeature("telegram");
  // v0.1.561 — der Scheduler kennt nur Mail-Loops → ohne Mail-Funktion ausblenden.
  const mailErlaubt = useFeature("mail");
  // Abgeschaltet heisst verschwunden, nicht ausgegraut.
  const relevanzErlaubt = useFeature("relevanz");
  return (
    <>
      <WatchesSection />
      <LinkMonitorSection />
      {mailErlaubt && <SchedulerSection />}
      <FreshnessSection />
      <EmailMusterSection />
      <VorschlaegeSection />
      <MithelfenSection />
      <BrowserSection />
      <AlertsSection />
      {relevanzErlaubt && <RelevanzSection />}
      {telegramErlaubt && <TelegramSection />}
    </>
  );
}
