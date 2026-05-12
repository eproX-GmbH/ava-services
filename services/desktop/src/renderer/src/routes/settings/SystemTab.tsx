import {
  UpdaterSection,
  PostgresSection,
  ProducersSection,
} from "../Settings";

// System-Tab — Updates, lokale Postgres-Instanz, lokale Producer-
// Subprozesse. Alles, was die Maschine darunter betrifft.
export function SystemTab() {
  return (
    <>
      <UpdaterSection />
      <PostgresSection />
      <ProducersSection />
    </>
  );
}
