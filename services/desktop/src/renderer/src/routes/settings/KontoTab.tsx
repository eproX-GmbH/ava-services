import {
  PlanSection,
  ProfileSection,
  LinkedInCalibrationNote,
  GeneralMemorySection,
} from "../Settings";
import { useFeature } from "../../store/policy";

// Konto-Tab — "wer du bist" + Abrechnung + (zukünftig) Erscheinung.
//
// Bündelt Plan & Abrechnung, Profil und General-Memory in einem Tab.
// "Erscheinung" (Theme, später Sprache/Datumsformat) ist hier als
// leerer Anker schon angelegt — der Inhalt zieht in U2 ein.
export function KontoTab() {
  const beobachterErlaubt = useFeature("linkedin.beobachter");
  return (
    <>
      <PlanSection />
      <ProfileSection />
      {beobachterErlaubt && <LinkedInCalibrationNote />}
      <GeneralMemorySection />
      <section
        id="erscheinung"
        className="provider-section"
        aria-label="Erscheinung"
      >
        {/* Phase U2 — Theme-Toggle, Sprache, Datumsformat ziehen hier ein.
            Anker bereits vorhanden, damit Deep-Links jetzt schon zielen. */}
      </section>
    </>
  );
}
