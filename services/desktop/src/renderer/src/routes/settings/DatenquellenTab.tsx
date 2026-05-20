import {
  LinkedInSection,
  CrmSection,
  FreshnessSection,
  AlertsSection,
  WatchesSection,
} from "../Settings";
import { MailAccountSection } from "./MailAccountSection";

// Datenquellen-Tab — LinkedIn, CRM, Freshness-Scheduler, Meldungen/
// Heartbeat, Watches, Mail-Konto. Alles, was Daten in AVA hereinholt
// oder benachrichtigt.
export function DatenquellenTab() {
  return (
    <>
      <LinkedInSection />
      <CrmSection />
      <MailAccountSection />
      <FreshnessSection />
      <WatchesSection />
      <AlertsSection />
    </>
  );
}
