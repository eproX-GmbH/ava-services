-- Organisationsvorgabe: Duerfen Mitglieder den Apify-Token der Organisation
-- mit einem eigenen ueberschreiben? true = eigener Token zuerst, Organisation
-- als Rueckfall. false = ausschliesslich der Token der Organisation.
--
-- Standard true, weil das dem bisherigen Verhalten entspricht (ohne
-- Anbieter-Sperre galt schon immer der eigene Token zuerst). Bestehende
-- Organisationen aendern sich dadurch nicht.
ALTER TABLE "TenantPolicy"
  ADD COLUMN IF NOT EXISTS "apifyEigenerErlaubt" BOOLEAN NOT NULL DEFAULT true;
