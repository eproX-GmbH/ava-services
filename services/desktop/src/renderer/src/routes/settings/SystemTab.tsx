import {
  UpdaterSection,
  PostgresSection,
  ProducersSection,
} from "../Settings";
import { OllamaVersionSection } from "../../components/OllamaVersionSection";
import { DiagnoseSection } from "../../components/DiagnoseSection";

// System-Tab — Updates, lokale Postgres-Instanz, Ollama-Laufzeit,
// lokale Producer-Subprozesse, Diagnose-Protokoll. Alles, was die
// Maschine darunter betrifft.
export function SystemTab() {
  return (
    <>
      <UpdaterSection />
      <OllamaVersionSection />
      <PostgresSection />
      <ProducersSection />
      <DiagnoseSection />
    </>
  );
}
