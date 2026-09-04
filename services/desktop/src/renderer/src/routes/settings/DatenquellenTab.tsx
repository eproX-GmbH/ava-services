import { LinkedInSection, CrmSection } from "../Settings";
import { MailAccountSection } from "./MailAccountSection";
import { useFeature } from "../../store/policy";

// v0.1.273 — Datenquellen-Tab.
//
// Nur noch die "externen Quellen-Verbindungen": LinkedIn, CRM, Mail-Konto.
// Watches, Freshness-Scheduler und Alerts sind in den neuen
// "Automatisierungen"-Tab umgezogen — das war hier sonst Mischmasch aus
// "wo kommen Daten her" und "was passiert automatisch damit".
export function DatenquellenTab() {
  // O3 — Organisationsvorgaben blenden ganze Abschnitte aus.
  const linkedin = useFeature("linkedin.beobachter");
  const mail = useFeature("mail");
  return (
    <>
      {linkedin && <LinkedInSection />}
      <CrmSection />
      {mail && <MailAccountSection />}
    </>
  );
}
