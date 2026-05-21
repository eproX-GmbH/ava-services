import { LinkedInSection, CrmSection } from "../Settings";
import { MailAccountSection } from "./MailAccountSection";

// v0.1.273 — Datenquellen-Tab.
//
// Nur noch die "externen Quellen-Verbindungen": LinkedIn, CRM, Mail-Konto.
// Watches, Freshness-Scheduler und Alerts sind in den neuen
// "Automatisierungen"-Tab umgezogen — das war hier sonst Mischmasch aus
// "wo kommen Daten her" und "was passiert automatisch damit".
export function DatenquellenTab() {
  return (
    <>
      <LinkedInSection />
      <CrmSection />
      <MailAccountSection />
    </>
  );
}
