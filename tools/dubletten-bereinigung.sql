-- Bereinigung der Kontakt-Dubletten. Wiederholbar: Das Skript sucht die
-- Paare jedes Mal neu, es setzt keine vorbereitete Tabelle voraus.
--
-- Was als Dublette gilt: zwei Personensaetze mit gleichem Namen (gefaltet,
-- ohne Titel und Diakritika), die bei DERSELBEN Firma beschaeftigt sind.
-- Namensgleichheit im gesamten Bestand waere zu wenig; innerhalb einer Firma
-- ist sie ein starkes Indiz.
--
-- Wer ausgenommen bleibt: Gruppen, in denen zwei VERSCHIEDENE Profile
-- desselben Portals vorkommen. Das koennen zwei Menschen sein. Verglichen
-- wird dabei mit gefalteten Umlauten, sonst gaelten `robin_roegner` und
-- `robin_rögner` als Widerspruch — es ist aber dasselbe Profil.
--
-- Alles in EINER Transaktion: Bricht ein Schritt ab, bleibt der Bestand
-- unveraendert.
--
-- Ausfuehren mit:
--   PGPASSWORD='…' psql -h localhost -p 16380 -U fly-user \
--     -d ava_company_contact -f tools/dubletten-bereinigung.sql

BEGIN;

-- Protokoll: welcher Satz auf welchen zusammengefuehrt wurde.
CREATE TABLE IF NOT EXISTS "_dubletten_protokoll" (
  firma     text        NOT NULL,
  norm      text        NOT NULL,
  behalten  text        NOT NULL,
  entfernt  text        NOT NULL,
  zeitpunkt timestamptz NOT NULL DEFAULT now()
);

CREATE TEMP TABLE paare ON COMMIT DROP AS
WITH falte AS (
  SELECT p.id,
         e."companyId" AS firma,
         lower(btrim(regexp_replace(p."fullName", '\s+', ' ', 'g'))) AS norm,
         p."createdAt"
  FROM "Employment" e
  JOIN "Person" p ON p.id = e."personId"
  GROUP BY p.id, e."companyId", p."fullName", p."createdAt"
),
mehrfach AS (
  SELECT f.* FROM falte f
  WHERE (SELECT count(*) FROM falte x WHERE x.firma = f.firma AND x.norm = f.norm) > 1
),
-- Widerspruechliche Profile im SELBEN Portal, mit gefalteten Umlauten.
strittig AS (
  SELECT m.firma, m.norm
  FROM mehrfach m
  JOIN "Fact" fa ON fa."personId" = m.id
  WHERE fa.field IN ('linkedinUrl', 'xingUrl') AND fa.status = 'ACTIVE'
  GROUP BY m.firma, m.norm, fa.field
  HAVING count(DISTINCT replace(replace(replace(replace(lower(fa.value),
           'ä','ae'), 'ö','oe'), 'ü','ue'), 'ß','ss')) > 1
),
sicher AS (
  SELECT m.*,
         row_number() OVER (PARTITION BY m.firma, m.norm ORDER BY m."createdAt", m.id) AS rang
  FROM mehrfach m
  WHERE NOT EXISTS (SELECT 1 FROM strittig s WHERE s.firma = m.firma AND s.norm = m.norm)
)
SELECT j.firma, j.norm,
       (SELECT a.id FROM sicher a WHERE a.firma = j.firma AND a.norm = j.norm AND a.rang = 1) AS behalten,
       j.id AS entfernt
FROM sicher j
WHERE j.rang > 1;

INSERT INTO "_dubletten_protokoll" (firma, norm, behalten, entfernt)
SELECT firma, norm, behalten, entfernt FROM paare;

-- Keine Ketten (ein "entfernt" darf nirgends "behalten" sein).
DO $$
DECLARE k int;
BEGIN
  SELECT count(*) INTO k FROM paare a WHERE EXISTS (SELECT 1 FROM paare b WHERE b.behalten = a.entfernt);
  IF k > 0 THEN RAISE EXCEPTION 'Kette erkannt (% Faelle)', k; END IF;
END $$;

-- ---- Doppelte Fakten -------------------------------------------------------
-- Beide Saetze tragen dieselbe Angabe (gleiches Feld, gleicher normalisierter
-- Wert). Der Unique-Index auf (entityType, entityId, field, normalized) laesst
-- sie nicht zweimal am selben Satz zu. Der Fakt des weichenden Satzes wird
-- entfernt, seine BELEGE aber vorher umgehaengt — sonst verloere der
-- Herkunftsnachweis Beobachtungen, und der soll ja gerade belegen, woher eine
-- Angabe stammt.
CREATE TEMP TABLE doppelte_fakten ON COMMIT DROP AS
SELECT alt.id AS alt_id, neu.id AS bleibt_id
FROM paare d
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

-- ---- Art.-14-Vermerke ------------------------------------------------------
-- Je Mandant nur einer. Der aeltere bleibt: Er belegt die fruehere Information.
DELETE FROM "PersonNotice" n USING paare d
 WHERE n."personId" = d.entfernt
   AND EXISTS (SELECT 1 FROM "PersonNotice" b
                WHERE b."personId" = d.behalten AND b."tenantId" = n."tenantId");

-- ---- Umhaengen -------------------------------------------------------------
-- entityId nicht vergessen: Danach richtet sich die Gruppierung in der
-- Firmenansicht. Ohne sie blieben die Karten getrennt.
UPDATE "Fact" f SET "personId" = d.behalten FROM paare d WHERE f."personId" = d.entfernt;
UPDATE "Fact" f SET "entityId" = d.behalten FROM paare d
 WHERE f."entityType" = 'PERSON' AND f."entityId" = d.entfernt;

UPDATE "Observation" o SET "personId" = d.behalten FROM paare d WHERE o."personId" = d.entfernt;
UPDATE "Observation" o SET "entityId" = d.behalten FROM paare d
 WHERE o."entityType" = 'PERSON' AND o."entityId" = d.entfernt;

UPDATE "Employment"   e SET "personId" = d.behalten FROM paare d WHERE e."personId" = d.entfernt;
UPDATE "PersonNotice" n SET "personId" = d.behalten FROM paare d WHERE n."personId" = d.entfernt;
UPDATE "SignalEvent"  s SET "personId" = d.behalten FROM paare d WHERE s."personId" = d.entfernt;

-- ---- Beschaeftigungen entdoppeln -------------------------------------------
-- Nach dem Umhaengen liegen die Beschaeftigungen beider Saetze nebeneinander.
-- Gleiche Person, gleiche Firma, gleicher Titel: die aeltere bleibt.
DELETE FROM "EmploymentSource" es USING "Employment" e
 WHERE es."employmentId" = e.id
   AND EXISTS (SELECT 1 FROM "Employment" x
                WHERE x."personId" = e."personId" AND x."companyId" = e."companyId"
                  AND btrim(coalesce(x.title,'')) = btrim(coalesce(e.title,''))
                  AND (x."firstSeen" < e."firstSeen" OR (x."firstSeen" = e."firstSeen" AND x.id < e.id)));

DELETE FROM "Employment" e
 WHERE EXISTS (SELECT 1 FROM "Employment" x
                WHERE x."personId" = e."personId" AND x."companyId" = e."companyId"
                  AND btrim(coalesce(x.title,'')) = btrim(coalesce(e.title,''))
                  AND (x."firstSeen" < e."firstSeen" OR (x."firstSeen" = e."firstSeen" AND x.id < e.id)));

-- Titellose neben gefuellten: Reste des fruehreren Verdopplungsfehlers.
DELETE FROM "EmploymentSource" es USING "Employment" e
 WHERE es."employmentId" = e.id
   AND btrim(coalesce(e.title,'')) = ''
   AND EXISTS (SELECT 1 FROM "Employment" x
                WHERE x."personId" = e."personId" AND x."companyId" = e."companyId"
                  AND x.id <> e.id AND btrim(coalesce(x.title,'')) <> '');

DELETE FROM "Employment" e
 WHERE btrim(coalesce(e.title,'')) = ''
   AND EXISTS (SELECT 1 FROM "Employment" x
                WHERE x."personId" = e."personId" AND x."companyId" = e."companyId"
                  AND x.id <> e.id AND btrim(coalesce(x.title,'')) <> '');

-- ---- Leer gewordene Personensaetze -----------------------------------------
DELETE FROM "Person" p
 WHERE p.id IN (SELECT entfernt FROM paare)
   AND NOT EXISTS (SELECT 1 FROM "Fact"         x WHERE x."personId" = p.id)
   AND NOT EXISTS (SELECT 1 FROM "Observation"  x WHERE x."personId" = p.id)
   AND NOT EXISTS (SELECT 1 FROM "Employment"   x WHERE x."personId" = p.id)
   AND NOT EXISTS (SELECT 1 FROM "PersonNotice" x WHERE x."personId" = p.id)
   AND NOT EXISTS (SELECT 1 FROM "SignalEvent"  x WHERE x."personId" = p.id);

COMMIT;

-- ---- Kontrolle: beide Zahlen sollen 0 sein ---------------------------------
SELECT count(*) AS verbliebene_dubletten FROM (
  SELECT e."companyId", lower(btrim(regexp_replace(p."fullName", '\s+', ' ', 'g'))) AS norm
  FROM "Employment" e JOIN "Person" p ON p.id = e."personId"
  GROUP BY 1, 2 HAVING count(DISTINCT p.id) > 1
) x;

SELECT count(*) AS verbliebene_leere_beschaeftigungen
FROM "Employment" e
WHERE btrim(coalesce(e.title,'')) = ''
  AND EXISTS (SELECT 1 FROM "Employment" x
               WHERE x."personId" = e."personId" AND x."companyId" = e."companyId"
                 AND x.id <> e.id AND btrim(coalesce(x.title,'')) <> '');

-- Was bewusst stehen blieb: Gruppen mit zwei verschiedenen Profilen desselben
-- Portals. Diese Liste ist zu sichten, nicht zu bereinigen.
SELECT DISTINCT e."companyId" AS firma,
       lower(btrim(regexp_replace(p."fullName", '\s+', ' ', 'g'))) AS norm
FROM "Employment" e JOIN "Person" p ON p.id = e."personId"
GROUP BY 1, 2 HAVING count(DISTINCT p.id) > 1;
