// Tab „Verbindungen“ (docs/PLAN_EINSTELLUNGEN_UI.md §3): Welche Werkzeuge
// haengen an AVA? CRM, LinkedIn (mit Kalibrierung), E-Mail (Konto, Entwuerfe),
// Telegram, Notizen (Notion, Obsidian).
import { CrmSection, LinkedInCalibrationNote, LinkedInSection } from "../Settings";
import { MailAccountSection } from "./MailAccountSection";
import { MailEntwurfSection } from "./MailEntwurfSection";
import { TelegramSection } from "./TelegramSection";
import { WissensquellenTab } from "./WissensquellenTab";
import { useFeature } from "../../store/policy";

export function VerbindungenTab() {
  // Organisationsvorgaben blenden ganze Abschnitte aus (abgeschaltet heisst verschwunden).
  const linkedin = useFeature("linkedin.beobachter");
  const mail = useFeature("mail");
  const telegram = useFeature("telegram");
  return (
    <>
      <CrmSection />
      {linkedin && <LinkedInSection />}
      {linkedin && <LinkedInCalibrationNote />}
      <section id="mail-section" className="provider-section">
        <h3>E-Mail</h3>
        <p className="muted">
          Ein Postfach, das AVA selbst liest und beantwortet, und Entwürfe, die du mit einem Klick in deinem Mailprogramm öffnest.
        </p>
        {mail && <MailAccountSection />}
        {/* Mail-Entwuerfe gelten auch ohne AVAs eigenes Postfach. */}
        <MailEntwurfSection />
      </section>
      {telegram && <TelegramSection />}
      <WissensquellenTab />
    </>
  );
}
