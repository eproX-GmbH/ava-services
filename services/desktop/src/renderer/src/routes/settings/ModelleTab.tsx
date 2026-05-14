import { ProviderSection, VoiceSection } from "../Settings";
import { ResearchFeaturesSection } from "./ResearchFeaturesSection";

// Modelle-Tab — LLM-Provider + Spracherkennung (Whisper) +
// Erweiterte Recherche-Funktionen (v0.1.172).
//
// ProviderSection rendert intern auch InstalledModelsSection
// ("Installierte Modelle"). ResearchFeaturesSection (Phase B+C+G)
// kommt darunter, weil sie konzeptionell auf der allgemeinen
// Modell-Konfiguration aufsetzt -- die "Allgemeine Modell-
// Konfiguration"-Übernehmen-Option in der Key-Auswahl referenziert
// genau den Provider-Key, den ProviderSection verwaltet.
export function ModelleTab() {
  return (
    <>
      <ProviderSection />
      <ResearchFeaturesSection />
      <VoiceSection />
    </>
  );
}
