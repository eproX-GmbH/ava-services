-- Bereinigung der Kontakt-Dubletten, 2026-09-19.
--
-- Voraussetzung: Die Tabelle "_dubletten_20260919" ist bereits angelegt und
-- enthaelt 32 gepruefte Paare (Schritt 1 lief am 2026-09-19 durch).
--
-- Was hier passiert:
--   1. Doppelte Fakten aufloesen, BELEGE vorher umhaengen.
--   2. Art.-14-Vermerke entdoppeln (der aeltere bleibt).
--   3. Alles Uebrige auf den bleibenden Datensatz umhaengen.
--   4. Die leer gewordenen Personensaetze entfernen.
--   5. Titellose Beschaeftigungen entfernen, neben denen eine gefuellte liegt.
--
-- Alles in EINER Transaktion: Bricht ein Schritt ab, bleibt der Bestand
-- unveraendert. Ein erster Versuch ist genau so abgebrochen — am
-- Unique-Index auf (entityType, entityId, field, normalized) — und hat
-- nichts hinterlassen.
--
-- Ausfuehren mit:
--   PGPASSWORD='…' psql -h localhost -p 16380 -U fly-user \
--     -d ava_company_contact -f tools/dubletten-bereinigung.sql

BEGIN;

-- Keine Ketten (ein "entfernt" darf nirgends "behalten" sein).
DO $$
DECLARE k int;
BEGIN
  SELECT count(*) INTO k FROM "_dubletten_20260919" a
   WHERE EXISTS (SELECT 1 FROM "_dubletten_20260919" b WHERE b.behalten = a.entfernt);
  IF k > 0 THEN RAISE EXCEPTION 'Kette erkannt (% Faelle)', k; END IF;
END $$;

-- ---- 1. Doppelte Fakten ----------------------------------------------------
-- Beide Datensaetze tragen dieselbe Angabe (gleiches Feld, gleicher
-- normalisierter Wert) — etwa die Firmenzuordnung. Der Unique-Index laesst
-- sie nicht zweimal am selben Datensatz zu.
--
-- Der Fakt der weichenden Person wird entfernt, seine BELEGE aber vorher auf
-- den bleibenden Fakt umgehaengt. Sonst verloere der Herkunftsnachweis
-- Beobachtungen — und genau der soll belegen, woher eine Angabe stammt.
CREATE TEMP TABLE doppelte_fakten ON COMMIT DROP AS
SELECT alt.id AS alt_id, neu.id AS bleibt_id
FROM "_dubletten_20260919" d
JOIN "Fact" alt ON alt."entityType" = 'PERSON' AND alt."entityId" = d.entfernt
JOIN "Fact" neu ON neu."entityType" = 'PERSON' AND neu."entityId" = d.behalten
                AND neu.field = alt.field
                AND neu.normalized IS NOT DISTINCT FROM alt.normalized;

INSERT INTO "FactObservationLink" (id, "factId", "observationId")
SELECT gen_random_uuid()::text, df.bleibt_id, l."observationId"
FROM "FactObservationLink" l JOIN doppelte_fakten df ON df.alt_id = l."factId"
ON CONFLICT ("factId", "observationId") DO NOTHING;

INSERT INTO "FactSignalLink" (id, "factId", "signalId")
SELECT gen_random_uuid()::text, df.bleibt_id, l."signalId"
FROM "FactSignalLink" l JOIN doppelte_fakten df ON df.alt_id = l."factId"
ON CONFLICT ("factId", "signalId") DO NOTHING;

DELETE FROM "FactObservationLink" l USING doppelte_fakten df WHERE l."factId" = df.alt_id;
DELETE FROM "FactSignalLink"      l USING doppelte_fakten df WHERE l."factId" = df.alt_id;
DELETE FROM "Fact" f USING doppelte_fakten df WHERE f.id = df.alt_id;

-- ---- 2. Art.-14-Vermerke ---------------------------------------------------
-- Je Mandant nur einer. Der aeltere bleibt: Er belegt die fruehere Information.
DELETE FROM "PersonNotice" n
 USING "_dubletten_20260919" d
 WHERE n."personId" = d.entfernt
   AND EXISTS (SELECT 1 FROM "PersonNotice" b
                WHERE b."personId" = d.behalten AND b."tenantId" = n."tenantId");

-- ---- 3. Umhaengen ----------------------------------------------------------
-- entityId nicht vergessen: Danach richtet sich die Gruppierung in der
-- Firmenansicht. Ohne sie blieben die Karten getrennt.
UPDATE "Fact" f SET "personId" = d.behalten
  FROM "_dubletten_20260919" d WHERE f."personId" = d.entfernt;
UPDATE "Fact" f SET "entityId" = d.behalten
  FROM "_dubletten_20260919" d WHERE f."entityType" = 'PERSON' AND f."entityId" = d.entfernt;

UPDATE "Observation" o SET "personId" = d.behalten
  FROM "_dubletten_20260919" d WHERE o."personId" = d.entfernt;
UPDATE "Observation" o SET "entityId" = d.behalten
  FROM "_dubletten_20260919" d WHERE o."entityType" = 'PERSON' AND o."entityId" = d.entfernt;

UPDATE "Employment"   e SET "personId" = d.behalten FROM "_dubletten_20260919" d WHERE e."personId" = d.entfernt;
UPDATE "PersonNotice" n SET "personId" = d.behalten FROM "_dubletten_20260919" d WHERE n."personId" = d.entfernt;
UPDATE "SignalEvent"  s SET "personId" = d.behalten FROM "_dubletten_20260919" d WHERE s."personId" = d.entfernt;

-- ---- 4. Leere Personensaetze -----------------------------------------------
-- Nur solche, an denen wirklich nichts mehr haengt.
DELETE FROM "Person" p
 WHERE p.id IN (SELECT entfernt FROM "_dubletten_20260919")
   AND NOT EXISTS (SELECT 1 FROM "Fact"         x WHERE x."personId" = p.id)
   AND NOT EXISTS (SELECT 1 FROM "Observation"  x WHERE x."personId" = p.id)
   AND NOT EXISTS (SELECT 1 FROM "Employment"   x WHERE x."personId" = p.id)
   AND NOT EXISTS (SELECT 1 FROM "PersonNotice" x WHERE x."personId" = p.id)
   AND NOT EXISTS (SELECT 1 FROM "SignalEvent"  x WHERE x."personId" = p.id);

-- ---- 5. Titellose Beschaeftigungen -----------------------------------------
-- Reste des Verdopplungsfehlers: Ein Lauf ohne Rollenbezeichnung legte die
-- Beschaeftigung titellos an, der naechste eine zweite mit Titel daneben.
-- Entfernt wird nur die leere, und nur wenn eine gefuellte derselben Person
-- bei derselben Firma daneben liegt.
DELETE FROM "EmploymentSource" es
 USING "Employment" e
 WHERE es."employmentId" = e.id
   AND btrim(coalesce(e.title, '')) = ''
   AND EXISTS (SELECT 1 FROM "Employment" x
                WHERE x."personId" = e."personId" AND x."companyId" = e."companyId"
                  AND x.id <> e.id AND btrim(coalesce(x.title, '')) <> '');

DELETE FROM "Employment" e
 WHERE btrim(coalesce(e.title, '')) = ''
   AND EXISTS (SELECT 1 FROM "Employment" x
                WHERE x."personId" = e."personId" AND x."companyId" = e."companyId"
                  AND x.id <> e.id AND btrim(coalesce(x.title, '')) <> '');

COMMIT;

-- ---- Kontrolle -------------------------------------------------------------
SELECT count(*) AS verbliebene_namens_dubletten FROM (
  SELECT e."companyId", lower(btrim(regexp_replace(p."fullName", '\s+', ' ', 'g'))) AS norm
  FROM "Employment" e JOIN "Person" p ON p.id = e."personId"
  GROUP BY 1, 2 HAVING count(DISTINCT p.id) > 1
) x;

SELECT count(*) AS verbliebene_leere_beschaeftigungen
FROM "Employment" e
WHERE btrim(coalesce(e.title, '')) = ''
  AND EXISTS (SELECT 1 FROM "Employment" x
               WHERE x."personId" = e."personId" AND x."companyId" = e."companyId"
                 AND x.id <> e.id AND btrim(coalesce(x.title, '')) <> '');
