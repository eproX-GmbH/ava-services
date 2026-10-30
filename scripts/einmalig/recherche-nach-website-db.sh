#!/usr/bin/env bash
# docs/PLAN_RECHERCHE_PERSIST.md R5(a)+(b): Stellen, Expansionen und Karriereseite
# aus der Evaluation-DB in die Website-DB kopieren (je Firma gewinnt die Evaluation-DB,
# weil dort die neueren Laeufe liegen). Vorher Sicherung der Evaluation-DB.
# Voraussetzung: `fly mpg proxy kyzl60xw8qlrpj9g` laeuft auf localhost:16380, PGPASSWORD gesetzt.
set -euo pipefail
H=localhost; P=16380; U=fly-user
EVAL=ava_company_evaluation; WEB=ava_website
SICHERUNG="${1:-$HOME/ava-sicherungen}"; mkdir -p "$SICHERUNG"
STEMPEL=$(date +%Y%m%d-%H%M%S)

echo "== (a) Sicherung $EVAL → $SICHERUNG/$EVAL-$STEMPEL.dump"
pg_dump -h $H -p $P -U $U -Fc -f "$SICHERUNG/$EVAL-$STEMPEL.dump" $EVAL
echo "== Sicherung der drei Zieltabellen in $WEB"
pg_dump -h $H -p $P -U $U -Fc -t '"JobPosting"' -t '"DeepResearch"' -t '"CompanyKarriere"' -f "$SICHERUNG/$WEB-recherche-$STEMPEL.dump" $WEB || true

echo "== (b) Schema in $WEB sicherstellen (wie ensureStellenSchema im Gateway)"
psql -h $H -p $P -U $U -d $WEB -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE "JobPosting" ADD COLUMN IF NOT EXISTS benefits TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE TABLE IF NOT EXISTS "CompanyKarriere" (
  "companyId" TEXT PRIMARY KEY, benefits TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "quelleUrl" TEXT, auszug TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
SQL

echo "== Daten aus $EVAL exportieren"
T=$(mktemp -d)
pg_dump -h $H -p $P -U $U --data-only --column-inserts -t '"JobPosting"' -t '"DeepResearch"' -t '"CompanyKarriere"' $EVAL > "$T/daten.sql"
psql -h $H -p $P -U $U -d $EVAL -Atc 'SELECT DISTINCT "companyId" FROM "JobPosting" UNION SELECT DISTINCT "companyId" FROM "DeepResearch" UNION SELECT DISTINCT "companyId" FROM "CompanyKarriere"' > "$T/firmen.txt"
echo "   Firmen mit Daten in $EVAL: $(wc -l < "$T/firmen.txt")"

echo "== In $WEB einspielen (eine Transaktion; je Firma alte Website-Zeilen ersetzen)"
{
  echo "BEGIN;"
  echo "CREATE TEMP TABLE firmen (id TEXT);"
  sed "s/'/''/g; s/^/INSERT INTO firmen VALUES ('/; s/\$/');/" "$T/firmen.txt"
  echo 'DELETE FROM "JobPosting" WHERE "companyId" IN (SELECT id FROM firmen);'
  echo 'DELETE FROM "DeepResearch" WHERE "companyId" IN (SELECT id FROM firmen);'
  echo 'DELETE FROM "CompanyKarriere" WHERE "companyId" IN (SELECT id FROM firmen);'
  grep -E '^INSERT INTO public\."(JobPosting|DeepResearch|CompanyKarriere)"' "$T/daten.sql"
  echo "COMMIT;"
} | psql -h $H -p $P -U $U -d $WEB -v ON_ERROR_STOP=1 -q

echo "== Ergebnis in $WEB"
psql -h $H -p $P -U $U -d $WEB -Atc 'SELECT ''JobPosting'', count(*), count(DISTINCT "companyId") FROM "JobPosting" UNION ALL SELECT ''DeepResearch'', count(*), count(DISTINCT "companyId") FROM "DeepResearch" UNION ALL SELECT ''CompanyKarriere'', count(*), count(DISTINCT "companyId") FROM "CompanyKarriere"'
rm -rf "$T"
echo "fertig — danach im Gateway den Rueckfall auf die Evaluation-DB entfernen (lib/website-research.ts)."
