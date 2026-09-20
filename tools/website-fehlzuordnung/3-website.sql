-- Die falsch zugeordnete Website selbst entfernen.
-- Datenbank: ava_website
--
-- Zuletzt, weil die Kontakt- und Profil-Skripte die URL noch brauchen, um
-- die richtigen Zeilen zu erkennen.
--
-- Die Zeile wird geloescht statt auf NULL gesetzt: Das Schema laesst zwar
-- `url IS NULL` zu, aber eine Website-Zeile ohne URL ist nichts Halbes —
-- die Folgestufen pruefen auf das Vorhandensein der Zeile. Die abgelehnte
-- Adresse bleibt im Protokoll erhalten, falls sie jemand nachschlagen will.
--
-- Der CompanySerp-Eintrag geht mit: Er ist der Suchtreffer, aus dem die
-- falsche Zuordnung entstand. Bliebe er stehen, wuerde ein erneuter Lauf
-- moeglicherweise wieder auf ihn zurueckgreifen.

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

INSERT INTO "_website_fehl_protokoll" (companyId, domain, gegenstand, kennung, hinweis)
SELECT w."companyId", f.domain, 'website', w."companyId",
       w.url || ' — ' || coalesce(w."siteName", '')
FROM "Website" w JOIN fehl f ON f.companyId = w."companyId"
WHERE w.url ILIKE '%' || f.domain || '%';

DELETE FROM "Website" w USING fehl f
 WHERE w."companyId" = f.companyId AND w.url ILIKE '%' || f.domain || '%';

INSERT INTO "_website_fehl_protokoll" (companyId, domain, gegenstand, kennung, hinweis)
SELECT s."companyId", f.domain, 'serp', s."companyId", s.url
FROM "CompanySerp" s JOIN fehl f ON f.companyId = s."companyId"
WHERE s.url ILIKE '%' || f.domain || '%';

DELETE FROM "CompanySerp" s USING fehl f
 WHERE s."companyId" = f.companyId AND s.url ILIKE '%' || f.domain || '%';

COMMIT;

-- ---- Kontrolle: 0 Zeilen erwartet ------------------------------------------
SELECT "companyId", url FROM "Website"
 WHERE "companyId" IN ('BADOEYNHAUSEN_HRB_18331','BADOEYNHAUSEN_HRB_17629','PADERBORN_HRB_12935');
SELECT "companyId", url FROM "CompanySerp"
 WHERE "companyId" IN ('BADOEYNHAUSEN_HRB_18331','BADOEYNHAUSEN_HRB_17629','PADERBORN_HRB_12935');

-- Vollstaendiges Protokoll dieses Vorgangs.
SELECT companyId, gegenstand, count(*) FROM "_website_fehl_protokoll"
 GROUP BY 1,2 ORDER BY 1,2;
