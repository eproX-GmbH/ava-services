// Tab „Konto“ (docs/PLAN_EINSTELLUNGEN_UI.md §3): Wer bin ich, was zahle ich?
// Profil, Langzeitgedaechtnis, Erlaubnisse, Plan & Abrechnung, Organisation, meine Geraete und
// verbundene Apps.
import { GeneralMemorySection, PlanSection, ProfileSection } from "../Settings";
import { VerbindungenSection } from "./VerbindungenSection";
import { InstanzenSection } from "./InstanzenSection";
import { KonsoleSection } from "./KonsoleSection";
import { KontoLoeschenSection } from "./KontoLoeschenSection";
import { ErlaubnisseSection } from "./ErlaubnisseSection";

export function KontoTab() {
  return (
    <>
      <ProfileSection />
      <PlanSection />
      <GeneralMemorySection />
      <ErlaubnisseSection />
      <KonsoleSection />
      <InstanzenSection />
      <VerbindungenSection />
      {/* Konto loeschen: bewusst ganz unten und dezent (docs/PLAN_KONTO_LOESCHEN.md). */}
      <KontoLoeschenSection />
    </>
  );
}
