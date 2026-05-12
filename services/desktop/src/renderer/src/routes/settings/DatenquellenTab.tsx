import {
  LinkedInSection,
  CrmSection,
  FreshnessSection,
  AlertsSection,
} from "../Settings";

// Datenquellen-Tab — LinkedIn, CRM, Freshness-Scheduler, Meldungen/
// Heartbeat. Alles, was Daten in AVA hereinholt oder benachrichtigt.
export function DatenquellenTab() {
  return (
    <>
      <LinkedInSection />
      <CrmSection />
      <FreshnessSection />
      <AlertsSection />
    </>
  );
}
