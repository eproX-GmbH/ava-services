// Tab „KI & Kosten“ (docs/PLAN_EINSTELLUNGEN_UI.md §3): Welches Modell arbeitet
// fuer mich, was kostet es? Anbieter und Modell, Schluessel, Modelle auf diesem
// Rechner (mit Ollama-Stand), Verbrauch, Sprechen mit AVA.
import { ProviderSection, VoiceSection } from "../Settings";
import { OllamaVersionSection } from "../../components/OllamaVersionSection";
import { VerbrauchTab } from "./VerbrauchTab";
import { SprachmodusSection } from "./SprachmodusSection";

export function KiTab() {
  return (
    <>
      <ProviderSection />
      <OllamaVersionSection />
      <VerbrauchTab />
      <SprachmodusSection />
      <VoiceSection />
    </>
  );
}
