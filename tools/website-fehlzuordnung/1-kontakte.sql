-- Kontakte entfernen, die aus einer falsch zugeordneten Website stammen.
-- Hintergrund und Faelle: siehe README.md daneben.
--
-- Datenbank: ava_company_contact
--
-- Merkmal einer betroffenen Beschaeftigung: Sie haengt an der betroffenen
-- Firma, mindestens ein Beleg zeigt auf die falsche Domain, und es gibt
-- KEINEN unabhaengigen Beleg.
--
-- Was als unabhaengig zaehlt, ist der springende Punkt. Ein Beleg ist nur
-- dann ein eigener Fund, wenn er eine URL traegt, die woanders hinzeigt.
-- Die Quellen `search:linkedin_lookup` und `search` tragen im gesamten
-- Bestand NIE eine URL (571 bzw. 530 Belege, alle ohne) — sie sind
-- Anreicherungen zu einer bereits gefundenen Person, kein zweiter Fund.
-- Jessica Redder etwa hat vier solcher Nachschlage-Belege; sie entstanden
-- NUR, weil sie zuvor auf der falschen Website stand. Wuerden sie als
-- unabhaengig gelten, bliebe die Bremer Einzelunternehmerin als
-- Ansprechpartnerin der Mindener GmbH stehen — also genau der Fehler, den
-- wir beseitigen wollen.
--
-- Quellen mit URL (`agent:website`, `apify:company-profile`,
-- `valueserp:google`) zaehlen dagegen sehr wohl: Zeigt eine davon
-- woandershin, gibt es einen echten zweiten Anhaltspunkt, und die
-- Beschaeftigung bleibt stehen.
--
-- Alles in EINER Transaktion. Bricht ein Schritt ab, bleibt der Bestand
-- unveraendert. Wiederholbar: Ein zweiter Lauf findet nichts mehr.

BEGIN;

-- Die betroffenen Firmen mit ihrer falschen Domain. Nur hier pflegen.
CREATE TEMP TABLE fehl (companyId text, domain text) ON COMMIT DROP;
INSERT INTO fehl VALUES
  ('BADOEYNHAUSEN_HRB_18331', 'jr-immobilienverwaltung.de'),
  ('BADOEYNHAUSEN_HRB_17629', 'fair-immobilien.de'),
  ('PADERBORN_HRB_12935',     'enspar.de');

CREATE TABLE IF NOT EXISTS "_website_fehl_protokoll" (
  companyId  text        NOT NULL,
  domain     text        NOT NULL,
  gegenstand text        NOT NULL,   -- person | beschaeftigung | fakt | beobachtung
  kennung    text        NOT NULL,
  hinweis    text,
  zeitpunkt  timestamptz NOT NULL DEFAULT now()
);

-- ---- Betroffene Beschaeftigungen -------------------------------------------
CREATE TEMP TABLE betroffen ON COMMIT DROP AS
SELECT e.id AS employment_id, e."personId", e."companyId", f.domain
FROM "Employment" e
JOIN fehl f ON f.companyId = e."companyId"
WHERE EXISTS (
        SELECT 1 FROM "EmploymentSource" es
         WHERE es."employmentId" = e.id AND es.url ILIKE '%' || f.domain || '%')
  -- ... und kein unabhaengiger Beleg: eine URL, die woanders hinzeigt.
  -- Belege OHNE URL zaehlen bewusst nicht als unabhaengig (siehe oben).
  AND NOT EXISTS (
        SELECT 1 FROM "EmploymentSource" es
         WHERE es."employmentId" = e.id
           AND es.url IS NOT NULL AND es.url <> ''
           AND es.url NOT ILIKE '%' || f.domain || '%');

INSERT INTO "_website_fehl_protokoll" (companyId, domain, gegenstand, kennung, hinweis)
SELECT b."companyId", b.domain, 'beschaeftigung', b.employment_id,
       (SELECT p."fullName" FROM "Person" p WHERE p.id = b."personId")
FROM betroffen b;

-- ---- Fakten und Beobachtungen dieser Personen, die aus der Domain stammen --
-- Belegketten zuerst loesen, sonst haengen verwaiste Verknuepfungen.
CREATE TEMP TABLE obs_weg ON COMMIT DROP AS
SELECT DISTINCT o.id
FROM "Observation" o
JOIN betroffen b ON b."personId" = o."personId"
-- Die Beobachtung traegt ihre Fundstelle in `evidenceUrl`.
WHERE o."evidenceUrl" ILIKE '%' || b.domain || '%';

CREATE TEMP TABLE fakt_weg ON COMMIT DROP AS
SELECT DISTINCT fa.id
FROM "Fact" fa
JOIN betroffen b ON b."personId" = fa."personId"
-- Nur Fakten, deren SAEMTLICHE Belege aus der falschen Domain kommen.
WHERE EXISTS (SELECT 1 FROM "FactObservationLink" l JOIN obs_weg ow ON ow.id = l."observationId"
               WHERE l."factId" = fa.id)
  AND NOT EXISTS (SELECT 1 FROM "FactObservationLink" l
                   WHERE l."factId" = fa.id AND l."observationId" NOT IN (SELECT id FROM obs_weg));

INSERT INTO "_website_fehl_protokoll" (companyId, domain, gegenstand, kennung)
SELECT b."companyId", b.domain, 'fakt', fw.id
FROM fakt_weg fw
JOIN "Fact" fa ON fa.id = fw.id
JOIN betroffen b ON b."personId" = fa."personId";

DELETE FROM "FactObservationLink" l WHERE l."factId" IN (SELECT id FROM fakt_weg);
DELETE FROM "FactSignalLink"      l WHERE l."factId" IN (SELECT id FROM fakt_weg);
DELETE FROM "Fact" f WHERE f.id IN (SELECT id FROM fakt_weg);

-- Verbliebene Verknuepfungen auf die weichenden Beobachtungen loesen.
DELETE FROM "FactObservationLink" l WHERE l."observationId" IN (SELECT id FROM obs_weg);
DELETE FROM "Observation" o WHERE o.id IN (SELECT id FROM obs_weg);

-- ---- Beschaeftigungen entfernen --------------------------------------------
DELETE FROM "EmploymentSource" es
 WHERE es."employmentId" IN (SELECT employment_id FROM betroffen);
DELETE FROM "Employment" e
 WHERE e.id IN (SELECT employment_id FROM betroffen);

-- ---- Personen, die dadurch heimatlos werden --------------------------------
-- Wer nach dem vorigen Schritt NIRGENDWO mehr beschaeftigt ist, war
-- ausschliesslich ueber die falsche Website bei uns. Eine Person, die auch
-- bei einer anderen Firma gefuehrt wird, bleibt dagegen stehen: Der Fehler
-- lag bei der Zuordnung zu DIESER Firma, nicht an der Person.
CREATE TEMP TABLE personen_weg ON COMMIT DROP AS
SELECT DISTINCT b."personId" AS id
FROM betroffen b
WHERE NOT EXISTS (SELECT 1 FROM "Employment" x WHERE x."personId" = b."personId");

INSERT INTO "_website_fehl_protokoll" (companyId, domain, gegenstand, kennung, hinweis)
SELECT b."companyId", b.domain, 'person', pw.id,
       (SELECT p."fullName" FROM "Person" p WHERE p.id = pw.id)
FROM personen_weg pw JOIN betroffen b ON b."personId" = pw.id;

-- Auch die Reste, die nicht an der falschen Domain haengen: Nachschlage-
-- Belege (`search:linkedin_lookup`) tragen keine Fundstelle und bleiben von
-- der Domain-Pruefung oben unberuehrt. Sie entstanden aber ALLE erst,
-- nachdem die Person faelschlich dieser Firma zugeordnet worden war.
--
-- Das ist kein Aufraeumen aus Ordnungsliebe: Es sind Privatpersonen, die
-- nur durch eine Verwechslung in unseren Bestand geraten sind. Eine Person
-- ohne Beschaeftigung ist in der Oberflaeche zwar unsichtbar — ihre Daten
-- lagen aber weiter bei uns, ohne jeden Zweck.
DELETE FROM "FactObservationLink" l
 WHERE l."factId" IN (SELECT id FROM "Fact" WHERE "personId" IN (SELECT id FROM personen_weg));
DELETE FROM "FactSignalLink" l
 WHERE l."factId" IN (SELECT id FROM "Fact" WHERE "personId" IN (SELECT id FROM personen_weg));
DELETE FROM "Fact"        f WHERE f."personId" IN (SELECT id FROM personen_weg);
DELETE FROM "Observation" o WHERE o."personId" IN (SELECT id FROM personen_weg);
DELETE FROM "PersonNotice" n WHERE n."personId" IN (SELECT id FROM personen_weg);
DELETE FROM "SignalEvent"  s WHERE s."personId" IN (SELECT id FROM personen_weg);
DELETE FROM "Person"       p WHERE p.id         IN (SELECT id FROM personen_weg);

COMMIT;

-- ---- Kontrolle --------------------------------------------------------------
-- Erwartung: 0 Zeilen. Bleibt hier etwas stehen, hat die Person einen Beleg
-- ausserhalb der falschen Website — dann ist das Stehenbleiben richtig, aber
-- ansehen lohnt sich.
SELECT e."companyId", p."fullName",
       (SELECT string_agg(DISTINCT es.source, ', ') FROM "EmploymentSource" es
         WHERE es."employmentId" = e.id) AS verbliebene_quellen
FROM "Employment" e
JOIN "Person" p ON p.id = e."personId"
WHERE e."companyId" IN ('BADOEYNHAUSEN_HRB_18331','BADOEYNHAUSEN_HRB_17629','PADERBORN_HRB_12935');

-- Was dieser Lauf angefasst hat.
SELECT gegenstand, count(*) FROM "_website_fehl_protokoll"
 WHERE zeitpunkt > now() - interval '5 minutes' GROUP BY 1 ORDER BY 1;
