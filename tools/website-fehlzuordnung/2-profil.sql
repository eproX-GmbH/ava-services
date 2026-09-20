-- Firmenprofile entfernen, die aus einer falsch zugeordneten Website
-- erzeugt wurden. Datenbank: ava_company_profile
--
-- Das Profil (Leistungen, Anwendungsfaelle, USPs, Keywords) ist vollstaendig
-- aus dem Seiteninhalt abgeleitet. Stimmt die Seite nicht, stimmt nichts
-- davon — es beschreibt eine fremde Firma.
--
-- Sicherung gegen Kollateralschaden: Es wird nur geloescht, wenn die
-- gespeicherte `url` des Profils tatsaechlich die falsche Domain traegt.
-- Wurde das Profil zwischenzeitlich aus einer anderen Quelle neu gebaut,
-- bleibt es stehen.

BEGIN;

CREATE TEMP TABLE fehl (companyId text, domain text) ON COMMIT DROP;
INSERT INTO fehl VALUES
  ('BADOEYNHAUSEN_HRB_18331', 'jr-immobilienverwaltung.de'),
  ('BADOEYNHAUSEN_HRB_17629', 'fair-immobilien.de'),
  ('PADERBORN_HRB_12935',     'enspar.de');

CREATE TABLE IF NOT EXISTS "_website_fehl_protokoll" (
  companyId  text        NOT NULL,
  domain     text        NOT NULL,
  gegenstand text        NOT NULL,
  kennung    text        NOT NULL,
  hinweis    text,
  zeitpunkt  timestamptz NOT NULL DEFAULT now()
);

CREATE TEMP TABLE profile_weg ON COMMIT DROP AS
SELECT cp.id, cp.url, cp."businessPurposeId", f.domain
FROM "CompanyProfile" cp
JOIN fehl f ON f.companyId = cp.id
WHERE cp.url ILIKE '%' || f.domain || '%';

INSERT INTO "_website_fehl_protokoll" (companyId, domain, gegenstand, kennung, hinweis)
SELECT pw.id, pw.domain, 'profil', pw.id, pw.url FROM profile_weg pw;

-- Keywords haengen an der FIRMA, nicht am Profil-Datensatz — sie werden
-- aber aus demselben Seiteninhalt gewonnen und sind damit genauso falsch.
DELETE FROM "CompanyKeyword" k WHERE k."companyId" IN (SELECT id FROM profile_weg);
DELETE FROM "CompanyProfile" cp WHERE cp.id IN (SELECT id FROM profile_weg);
DELETE FROM "CompanyBusinessPurpose" bp
 WHERE bp.id IN (SELECT "businessPurposeId" FROM profile_weg WHERE "businessPurposeId" IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM "CompanyProfile" x WHERE x."businessPurposeId" = bp.id);

COMMIT;

-- ---- Kontrolle: 0 Zeilen erwartet ------------------------------------------
SELECT id, url FROM "CompanyProfile"
 WHERE id IN ('BADOEYNHAUSEN_HRB_18331','BADOEYNHAUSEN_HRB_17629','PADERBORN_HRB_12935');

SELECT gegenstand, count(*) FROM "_website_fehl_protokoll"
 WHERE zeitpunkt > now() - interval '5 minutes' GROUP BY 1;
