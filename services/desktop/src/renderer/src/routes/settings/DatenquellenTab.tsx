import {
  LinkedInSection,
  CrmSection,
  FreshnessSection,
  AlertsSection,
  WatchesSection,
} from "../Settings";

// Datenquellen-Tab — LinkedIn, CRM, Freshness-Scheduler, Meldungen/
// Heartbeat, Watches. Alles, was Daten in AVA hereinholt oder
// benachrichtigt.
export function DatenquellenTab() {
  return (
    <>
      <LinkedInSection />
      <CrmSection />
      <FreshnessSection />
      <WatchesSection />
      <AlertsSection />
    </>
  );
}
