# Falsch zugeordnete Websites bereinigen

Hintergrund: docs/PLAN_WEBSITE_ZUORDNUNG.md

Der Website-Dienst hat drei Firmen die Website einer FREMDEN Firma
zugeordnet — gleicher oder aehnlicher Name, anderer Ort, andere
Rechtsform. Ab diesem Punkt war alles Weitere falsch: Firmenprofil,
Leistungen, Kontakte.

| Firma laut Register | falsch zugeordnete Website | Impressum nennt |
| --- | --- | --- |
| JR Immobilien Verwaltung GmbH, Am Hahler Hafen 14, 32427 Minden (GF Justin Rafflenbeul) | jr-immobilienverwaltung.de | JR Immobilienverwaltung **e. Kfr.**, Jessica Redder, 28195 Bremen, AG Bremen HRA 28758 |
| FAIR Immobilien & Verwaltungsgesellschaft mbH, Im Romerlager 26, 32457 Porta Westfalica | fair-immobilien.de | Fair Immobilien **Projektgesellschaft** mbH, 21640 Horneburg |
| Biogas Volkmarsen UG, Tewesweg 2, 33181 Bad Wuennenberg | enspar.de | **ASM Rahden GmbH**, 32369 Rahden |

Alle drei wurden von Hand im Impressum geprueft.

## Was entfernt wird

- die Website-Zeile (URL, Seitenname, Beschreibung, Social-Links),
- das daraus erzeugte Firmenprofil,
- die Kontakte, die AUS DIESER WEBSITE stammen.

## Was bleibt

Register, Anschrift, Geschaeftsfuehrer, Gruendungsjahr, Stammkapital,
Insolvenzstand — alles, was aus dem Handelsregister kommt. Ebenso
Kontakte aus anderen Quellen (LinkedIn/Apify), sofern es sie gibt.

## Reihenfolge

```
PG='PGPASSWORD=… psql -h localhost -p 16380 -U fly-user'

1. $PG -d ava_company_contact -f 1-kontakte.sql
2. $PG -d ava_company_profile -f 2-profil.sql
3. $PG -d ava_website        -f 3-website.sql
```

Kontakte zuerst: Sie brauchen die Website-URL noch, um die richtigen
Beobachtungen zu erkennen. Jedes Skript laeuft in EINER Transaktion und
ist wiederholbar — ein zweiter Lauf findet nichts mehr und aendert
nichts.
