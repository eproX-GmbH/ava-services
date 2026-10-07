CREATE OR REPLACE FUNCTION firmen_schluessel(s text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT regexp_replace(
    lower(
      translate(
        replace(replace(replace(replace(replace(replace(replace(coalesce(s,''),
          'ä','ae'),'ö','oe'),'ü','ue'),'ß','ss'),'Ä','Ae'),'Ö','Oe'),'Ü','Ue'),
        'àáâãåāçèéêëēìíîïīñòóôõøōùúûūýÿžšćčđłńśźżÀÁÂÃÅĀÇÈÉÊËĒÌÍÎÏĪÑÒÓÔÕØŌÙÚÛŪÝŽŠĆČĐŁŃŚŹŻ',
        'aaaaaaceeeeeiiiiinoooooouuuuyyzsccdlnszzAAAAAACEEEEEIIIIINOOOOOOUUUUYZSCCDLNSZZ'
      )
    ),
    '[^a-z0-9]', '', 'g');
$$;
SELECT firmen_schluessel('Öhrmann - Maschinenbaufabrik GmbH') AS a, firmen_schluessel('Oehrmann-Maschinenbaufabrik GmbH') AS b, firmen_schluessel('EnKo Engineering GmbH') AS c, firmen_schluessel('Straße & Söhne Ltd.') AS d;
-- Angelegt in ava_master_data am 2026-10-07 (Operator-Freigabe). Indizes:
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS "GermanCompany_schluessel_idx" ON "GermanCompany" (firmen_schluessel(name));
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS "GermanCompanyHistory_schluessel_idx" ON "GermanCompanyHistory" (firmen_schluessel(name));
