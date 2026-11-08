// Tab „Konto“ (docs/PLAN_EINSTELLUNGEN_UI.md §3): Wer bin ich, was zahle ich?
// Profil, Langzeitgedaechtnis, Plan & Abrechnung, Organisation, meine Geraete und
// verbundene Apps.
import { GeneralMemorySection, PlanSection, ProfileSection } from "../Settings";
import { VerbindungenSection } from "./VerbindungenSection";
import { InstanzenSection } from "./InstanzenSection";
import { KonsoleSection } from "./KonsoleSection";
import { KontoLoeschenSection } from "./KontoLoeschenSection";

export function KontoTab() {
  return (
    <>
      <ProfileSection />
      <PlanSection />
      <GeneralMemorySection />
      <KonsoleSection />
      <InstanzenSection />
      <VerbindungenSection />
      {/* Konto loeschen: bewusst ganz unten und dezent (docs/PLAN_KONTO_LOESCHEN.md). */}
      <KontoLoeschenSection />
    </>
  );
}
