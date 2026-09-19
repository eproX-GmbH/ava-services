import { LinkedInSection, CrmSection } from "../Settings";
import { MailAccountSection } from "./MailAccountSection";
import { ApifySection } from "./ApifySection";
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
  const kontakte = useFeature("kontakte");
  return (
    <>
      {linkedin && <LinkedInSection />}
      {/* Apify gehoert zu "wo kommen Daten her": es liefert die
          Ansprechpartner. Der Token war bisher nur im LinkedIn-Bereich
          setzbar und dort nicht zu finden. */}
      {kontakte && <ApifySection />}
      <CrmSection />
      {mail && <MailAccountSection />}
    </>
  );
}
