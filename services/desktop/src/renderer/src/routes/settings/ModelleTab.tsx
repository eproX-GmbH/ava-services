import { ProviderSection, VoiceSection } from "../Settings";

// Modelle-Tab — LLM-Provider + Spracherkennung (Whisper).
//
// ProviderSection rendert intern auch InstalledModelsSection
// ("Installierte Modelle"), darum reichen hier zwei Aufrufe.
export function ModelleTab() {
  return (
    <>
      <ProviderSection />
      <VoiceSection />
    </>
  );
}
