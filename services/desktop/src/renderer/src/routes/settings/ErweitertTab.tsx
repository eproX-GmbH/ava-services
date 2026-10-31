// Tab „Erweitert“ (docs/PLAN_EINSTELLUNGEN_UI.md §3): fuer Fortgeschrittene und
// den Support. Skills, wiederkehrende Aufgaben, Verlauf, Updates, Speicherplatz,
// Diagnose, Dienste auf diesem Rechner, Zuruecksetzen.
import { PostgresSection, ProducersSection, UpdaterSection } from "../Settings";
import { SettingsSkills } from "../SettingsSkills";
import { SchedulerSection } from "./SchedulerSection";
import { VerlaufTab } from "./VerlaufTab";
import { BrowserSection } from "./BrowserSection";
import { StorageSection } from "../../components/StorageSection";
import { DiagnoseSection } from "../../components/DiagnoseSection";
import { DangerZoneSection } from "../../components/DangerZoneSection";
import { useFeature } from "../../store/policy";

export function ErweitertTab() {
  const mail = useFeature("mail");
  return (
    <>
      <SettingsSkills />
      {mail && <SchedulerSection />}
      <VerlaufTab />
      <UpdaterSection />
      <StorageSection />
      <DiagnoseSection />
      <section id="dienste-section" className="provider-section">
        <h3>Dienste auf diesem Rechner</h3>
        <p className="muted">
          AVA verarbeitet deine Firmen auf diesem Rechner. Hier siehst du, ob alles läuft.
        </p>
        <PostgresSection />
        <ProducersSection />
        <BrowserSection />
      </section>
      <DangerZoneSection />
    </>
  );
}
