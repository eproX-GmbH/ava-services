# Plan: Skandinavien (Norwegen, Finnland, Schweden, Dänemark)

Stand 2026-10-29. Freigabe Joyce: „leg los mit Norwegen, alle skandinavischen
Länder nacheinander nach Schweregrad“. Hintergrund in docs/PLAN_EUROPA_REGISTER.md.
Muster ist die Schweiz (docs/PLAN_SCHWEIZ.md §6): Adapter im Register-Worker,
Treffer-Abbildung im Gateway, drei Job-Arten je Land, eigene Fly-Maschine,
Land als Präfix der Firmen-ID, Filter in Desktop, app.ava.bi und admin.ava.bi,
Radar mit GeoNames-Ortsgraph.

## 1. Reihenfolge nach Schweregrad

| # | Land | Zugang | Warum in dieser Reihenfolge |
|---|---|---|---|
| 1 | Norwegen | Brønnøysundregistrene, offene REST-API ohne Schlüssel, Gesamtdownload, Änderungsfeed, Rollen, Abschlüsse | kein Antrag, alles offen, bestes Datenmodell |
| 2 | Finnland | PRH Open Data v3, offene REST-API ohne Schlüssel | kein Antrag; kein Gesamtdownload, Erstabzug über Abfragen nach Registrierungsdatum |
| 3 | Schweden | Bolagsverket „Värdefulla datamängder“, kostenlos nach Registrierung; SCB kostenpflichtig (nicht geplant) | Registrierung nötig, Basisdaten ohne Personen |
| 4 | Dänemark | CVR System-zu-System (Elasticsearch bei Virk), kostenlos nach Antrag bei Erhvervsstyrelsen | Antrag mit Wartezeit, dafür Personen und XBRL-Abschlüsse |

Anträge für 3 und 4 sofort stellen (Betreiber), damit sie bis dahin da sind.

## 2. Gemeinsames Datenmodell je Land

| Feld | Norwegen | Finnland | Schweden | Dänemark |
|---|---|---|---|---|
| companyId | `NO_<9-stellige Orgnr>` | `FI_<Y-Tunnus ohne Bindestrich, 8 Stellen>` | `SE_<Orgnr 10 Stellen>` | `DK_<CVR 8 Stellen>` |
| registerType | Organisationsform-Kürzel (AS, ASA, ENK, NUF, …) | Unternehmensform-Kürzel (OY, OYJ, KY, …) | Rechtsform-Kürzel (AB, HB, EF, …) | Virksomhedsform-Kürzel (A/S, ApS, …) |
| registerNumber | Orgnr `916 627 939` | Y-Tunnus `0194099-3` | Orgnr `556016-0680` | CVR `10150817` |
| location | poststed des Geschäftssitzes | Ort der Registeradresse | postort | by |
| state | Fylke aus Kommunenummer | Region (maakunta) | Län | Region |
| districtCourt | „Brønnøysundregistrene“ | „Patentti- ja rekisterihallitus“ | „Bolagsverket“ | „Erhvervsstyrelsen“ |
| registerStatus | slettedato → CLOSED; underAvvikling/Tvangsavvikling → LOESCHUNG_ANGEKUENDIGT | endDate → CLOSED; Liquidation → LOESCHUNG_ANGEKUENDIGT | avregistrerad → CLOSED; likvidation → LOESCHUNG_ANGEKUENDIGT | ophørt → CLOSED; under likvidation → LOESCHUNG_ANGEKUENDIGT |
| insolvencyStatus | konkurs → EROEFFNET | konkurssi → EROEFFNET | konkurs → EROEFFNET | konkurs → EROEFFNET |
| uid | `NO<Orgnr>MVA` wenn im MVA-Register | `FI<8 Stellen>` | `SE<Orgnr>01` | `DK<CVR>` |
| Personen (SI) | Rollen-Endpunkt (DAGL, LEDE, …) | Vertretungsberechtigte im Datensatz | keine (Basis) | Deltagere |
| Zweck (SI) | vedtektsfestetFormaal | Geschäftszweck im Datensatz | nicht in der Basis | Formål |
| Abschlüsse (später) | Regnskapsregisteret offen | PRH Tilinpäätös offen | kostenpflichtig | CVR XBRL offen |

## 3. Norwegen (N1 bis N5)

Quelle: `https://data.brreg.no/enhetsregisteret/api` (Enheter, keine Unterenheter).

| Stufe | Inhalt | Stand |
|---|---|---|
| N1 | Adapter `packages/register-delta/src/no-brreg.ts`: Client (Einheit, Rollen, Änderungsfeed, Gesamtdownload als Stream), Abbildung Einheit → Treffer, Fylke aus Kommunenummer, Rechtsformen | 2026-10-29 |
| N2 | Job-Arten `no_bulk` (ein Job, Gesamtdownload gestreamt, Bündel je 500 als Teilergebnisse, Fortsetzen nach Neustart), `no_oppdatering` (Änderungsfeed eines Tages: Ny/Endring/Sletting, Detail je Orgnr), `no_refresh` (Detail plus Rollen je Pool-Firma → strukturierter Inhalt mit Geschäftsführung) | 2026-10-29 |
| N3 | Gateway: TrefferNo, companyIdNo, Abbildung, Cron (täglich Vortag, monatlich Pool), Anforderung beim Import und aus dem Chat, Routen; master-data Validator (NO, UID-Muster) | 2026-10-29 |
| N4 | Oberflächen: Land NO in Desktop (Import, Filter, Chip, Register-Zeile, Insolvenz-Quelle, Finanzen-Hinweis), app.ava.bi, admin.ava.bi; Radar (GeoNames NO, google.no, Sprache nb) | 2026-10-29 |
| N5 | Maschine `worker_no`, Erstabzug (rund 1,1 Mio. Einheiten) | 2026-10-29 |

Takt: 2 Abfragen je Sekunde (keine amtliche Grenze dokumentiert, höflich bleiben).
Änderungsfeed liefert nur Orgnr und Art; das Detail wird je Orgnr nachgeladen
(einige Tausend je Tag, rund eine Stunde).

## 4. Finnland (F1 bis F5)

Quelle: `https://avoindata.prh.fi/opendata-ytj-api/v3`. Kein Gesamtdownload:
Erstabzug über `companies?registrationDateStart/End` in Monatsscheiben (ab
1900), je Seite 100 Treffer; rund 0,7 Mio. Firmen. Delta über
`companies?...` mit Änderungsdatum. Personen und Zweck stehen im Datensatz.

## 5. Schweden (S1 bis S5)

Quelle: Bolagsverket API „Värdefulla datamängder“ (Grunddaten, kostenlos,
Schlüssel nach Registrierung). Erstabzug über die Massendatei (CSV), Delta über
die Änderungsliste. Keine Personen in der kostenlosen Basis; SCB bewusst nicht.

## 6. Dänemark (D1 bis D5)

Quelle: CVR System-zu-System (Elasticsearch `distribution.virk.dk`,
Benutzername/Passwort nach Antrag). Erstabzug über Scroll-Suche, Delta über
`sidstOpdateret`. Deltagere → Personen, XBRL → Abschlüsse (später).

## 7. Verallgemeinerung (einmal, mit Norwegen)

- Sprache je Land im Radar und in den Prompts (nb, fi, sv, da statt nur de/en).
- Rechtsformen und Registerbezeichnungen je Land als Tabelle im Worker-Adapter,
  Chip und Kennung in der App lesen `registerType` und `country`, kein Code je Land.
- Länderlisten in Desktop, PWA, Konsole und Gateway-Schemas aus einer Konstante
  je Codebasis (`LAENDER`), damit ein neues Land eine Zeile ist.
