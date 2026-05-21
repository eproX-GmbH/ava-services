import {
  FreshnessSection,
  AlertsSection,
  WatchesSection,
} from "../Settings";

// v0.1.273 — Automatisierungen-Tab.
//
// Sammelt alle "AVA arbeitet im Hintergrund für mich"-Funktionen, die
// bisher überfüllend in DatenquellenTab hingen:
//   - Watches (LLM-Rubrics gegen Heartbeat-Kandidaten)
//   - Scheduler-Jobs (wiederkehrende Mails, etc.) — Phase 2
//   - Freshness-Scheduler (Datenrefresh-Cadences)
//   - Alerts / Heartbeat-Trigger
//
// DatenquellenTab behält die "Quellen-Verbindungen" — LinkedIn, CRM,
// Mail-Konto. Sauberere Trennung: WAS reinkommt vs WAS automatisch
// passiert.
export function AutomatisierungenTab() {
  return (
    <>
      <WatchesSection />
      {/* SchedulerSection kommt mit Phase 2 (v0.1.274). */}
      <FreshnessSection />
      <AlertsSection />
    </>
  );
}
