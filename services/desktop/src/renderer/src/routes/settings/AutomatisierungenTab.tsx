import {
  FreshnessSection,
  AlertsSection,
  WatchesSection,
} from "../Settings";
import { SchedulerSection } from "./SchedulerSection";

// v0.1.273+ — Automatisierungen-Tab.
//
// Sammelt alle "AVA arbeitet im Hintergrund für mich"-Funktionen:
//   - Watches (LLM-Rubrics gegen Heartbeat-Kandidaten)
//   - Scheduler-Jobs (wiederkehrende Mails — v0.1.274)
//   - Freshness-Scheduler (Datenrefresh-Cadences)
//   - Alerts / Heartbeat-Trigger
export function AutomatisierungenTab() {
  return (
    <>
      <WatchesSection />
      <SchedulerSection />
      <FreshnessSection />
      <AlertsSection />
    </>
  );
}
