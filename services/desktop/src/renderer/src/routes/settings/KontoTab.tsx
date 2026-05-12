import {
  PlanSection,
  ProfileSection,
  GeneralMemorySection,
} from "../Settings";

// Konto-Tab — "wer du bist" + Abrechnung + (zukünftig) Erscheinung.
//
// Bündelt Plan & Abrechnung, Profil und General-Memory in einem Tab.
// "Erscheinung" (Theme, später Sprache/Datumsformat) ist hier als
// leerer Anker schon angelegt — der Inhalt zieht in U2 ein.
export function KontoTab() {
  return (
    <>
      <PlanSection />
      <ProfileSection />
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
