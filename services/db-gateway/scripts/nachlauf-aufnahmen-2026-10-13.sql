-- Z8 Nachlauf 2026-10-13: Firmen mit fertigem Firmenprofil, die nie verbucht wurden.
-- Konto org_2bwK5GxYgcQ5 (Enterprise, ohne Rechnungswirkung). Datenbank: ava_db_gateway.
BEGIN;
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','AT_FN142901Z','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 0 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='AT_FN142901Z');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','AT_FN92391W','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 2 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='AT_FN92391W');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','AUGSBURG_HRB_7921','nachlauf',NOW(),'mittel',200,59,'nachlauf: LinkedIn-Profil, 49 ueber Apify, 56 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='AUGSBURG_HRB_7921');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','BERLINCHARLOTTENBURG_HRB_146726','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 11 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='BERLINCHARLOTTENBURG_HRB_146726');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','BIELEFELD_HRA_13976','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 12 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='BIELEFELD_HRA_13976');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','BIELEFELD_HRB_33390','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 3 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='BIELEFELD_HRB_33390');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','BIELEFELD_HRB_35642','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 48 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='BIELEFELD_HRB_35642');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','BIELEFELD_HRB_42310','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 3 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='BIELEFELD_HRB_42310');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','BIELEFELD_HRB_42997','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 11 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='BIELEFELD_HRB_42997');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','BIELEFELD_HRB_44081','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 0 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='BIELEFELD_HRB_44081');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','DRESDEN_HRB_93','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 14 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='DRESDEN_HRB_93');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','FRANKFURTAMMAIN_HRB_30000','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 0 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='FRANKFURTAMMAIN_HRB_30000');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','HAMBURG_HRB_101680','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 16 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='HAMBURG_HRB_101680');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','HAMBURG_HRB_10951','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 0 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='HAMBURG_HRB_10951');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','HAMBURG_HRB_119570','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 0 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='HAMBURG_HRB_119570');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','HILDESHEIM_HRB_110659','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 14 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='HILDESHEIM_HRB_110659');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','LEMGO_HRA_5099','nachlauf',NOW(),'mittel',200,59,'nachlauf: LinkedIn-Profil, 2 ueber Apify, 11 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='LEMGO_HRA_5099');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','OSNABRUECK_HRB_213357','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 0 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='OSNABRUECK_HRB_213357');
INSERT INTO "UsageEntry" ("billingAccountId","periodKey","companyId",source,"createdAt",stufe,"preisCents","direktkostenCents",grund,"zugeordnetAm")
  SELECT 'org_2bwK5GxYgcQ5','2026-10','ULM_HRB_630206','nachlauf',NOW(),'klein',100,11,'nachlauf: kein LinkedIn-Firmenprofil, 0 ueber Apify, 0 Personen',NOW()
  WHERE NOT EXISTS (SELECT 1 FROM "UsageEntry" u WHERE u."billingAccountId"='org_2bwK5GxYgcQ5' AND u."companyId"='ULM_HRB_630206');
COMMIT;
