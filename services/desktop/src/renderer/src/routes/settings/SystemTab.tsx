import {
  UpdaterSection,
  PostgresSection,
  ProducersSection,
} from "../Settings";
import { OllamaVersionSection } from "../../components/OllamaVersionSection";

// System-Tab — Updates, lokale Postgres-Instanz, Ollama-Laufzeit,
// lokale Producer-Subprozesse. Alles, was die Maschine darunter
// betrifft.
export function SystemTab() {
  return (
    <>
      <UpdaterSection />
      <OllamaVersionSection />
      <PostgresSection />
      <ProducersSection />
    </>
  );
}
