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
      {mail && <MailAccountSection />}
      {/* Mail-Entwuerfe gelten auch ohne AVAs eigenes Postfach. */}
      <MailEntwurfSection />
      {telegram && <TelegramSection />}
      <WissensquellenTab />
    </>
  );
}
