# Plan: Vereinigtes Königreich (Companies House)

Stand 2026-09-15. Gleiches Schema wie Österreich (`docs/PLAN_OESTERREICH.md`):
Quellen prüfen, Datenmodell abbilden, Notebook, dann Queue-Jobs und App.
Notebook: `master-data/scripts/uk/companies_house.ipynb`.

## 1. Quellen (geprüft am 2026-09-15)

**Companies House, Weboberfläche** (`find-and-update.company-information.service.gov.uk`)
- Ohne Login, ohne Session, plain GET. Firmenseite `/company/<Nummer>`
  (Sitz, Status, Rechtsform, Gründung, SIC), `/company/<Nummer>/officers`
  (Personen mit Rolle, Status aktiv/zurückgetreten, Bestellung, Rücktritt,
  Geburtsmonat, Nationalität, Korrespondenzadresse) und
  `/company/<Nummer>/insolvency` (Insolvenzfälle mit Art, Antragsdatum,
  Beginn, Abschluss, Auflösung, Insolvenzverwalter). Suche
  `/search/companies?q=` (HTML). Keine robots.txt, keine Ratengrenze
  dokumentiert; für die API gilt 600 Anfragen je 5 Minuten, daran
  orientieren wir uns auch im Web (0,5 je Sekunde wie in Österreich).

**Free Company Data Product** (`download.companieshouse.gov.uk/en_output.html`)
- **Monatlicher Vollabzug aller lebenden Firmen als CSV, kostenlos, ohne
  Konto.** 7 Teil-Dateien (469 MB als eine ZIP), aktualisiert innerhalb von
  5 Werktagen nach Monatsende. Teil 7 allein enthält 589.370 Zeilen, die
  Gesamtmenge liegt bei rund 5,7 Mio. Firmen (Hochrechnung über die
  Dateigrößen).
- 55 Spalten: Name, Nummer, Sitzadresse (Straße, Ort, Grafschaft, Land,
  Postleitzahl), Rechtsform (`CompanyCategory`), Status
  (`CompanyStatus`), Herkunftsland, Gründungs- und Auflösungsdatum,
  Bilanz- und Erklärungsfristen, Anzahl Sicherheiten, bis zu 4 SIC-Codes
  mit Text, bis zu 10 frühere Namen mit Änderungsdatum, URI.
- Aufgelöste Firmen fehlen (nur lebende); Status enthält aber
  Liquidation, Verwaltung und „Proposal to Strike off“. 11 Statuswerte in
  der Stichprobe: Active 90,9 %, Active - Proposal to Strike off 7,2 %,
  Liquidation 1,8 %, In Administration, Receiver Manager, Voluntary
  Arrangement, Administrative Receiver, Receivership, Administration
  Order.
- Damit entfällt jede Aufzählung: Erstimport und monatliches Delta sind
  ein CSV-Vergleich, kein Portal-Scraping.

**Companies House Public Data API** (`api.company-information.service.gov.uk`)
- REST, JSON, kostenloser API-Schlüssel nach Registrierung im Developer
  Hub (HTTP Basic, Schlüssel als Benutzername). 600 Anfragen je 5 Minuten
  je Anwendung, 429 danach; höhere Grenze auf Anfrage.
- Endpunkte: Firmenprofil, Sitzadresse, Officers (Liste), Insolvenz,
  Filing History, Charges, PSC (wirtschaftlich Berechtigte), Suche
  (einfach, erweitert, alphabetisch, aufgelöste Firmen), Officer
  Appointments und Disqualifikationen.
- **Streaming API** (`stream.companieshouse.gov.uk`): Echtzeit-Push
  aller Änderungen als JSON (`/companies`, `/officers`,
  `/insolvency-cases`, `/filings`, `/charges`, `/persons-with-significant-control`),
  gleiche Ressourcen wie die REST-API, mit `timepoint` zum Wiederaufsetzen.
  Gleicher Schlüssel.

**Insolvenzen**
- Companies House selbst führt Insolvenzfälle je Firma (Web und API),
  außerdem spiegelt `CompanyStatus` im Bulk-Abzug den Stand (Liquidation,
  In Administration, Voluntary Arrangement …).
- **The Gazette** (`thegazette.co.uk`, amtliches Verkündungsblatt):
  Atom-Feed ohne Schlüssel, `insolvency/notice/data.feed?text=<Nummer>`
  findet die Bekanntmachungen (Winding-Up Orders, Meetings of Creditors,
  Appointment of Liquidators …); Open Government Licence v3.0, außer
  Personendaten. Der Parameter `company-number` wirkt nicht, die
  Volltextsuche nach der Nummer schon (SODASTREAM LIMITED 00077570 → 1
  Treffer, Winding-Up Order).

**PSC-Snapshot**: tägliche JSON-Dumps aller wirtschaftlich Berechtigten
(32 Teile), kostenlos. Für AVA erst später interessant (Eigentümer).

**Rechtslage** (GOV.UK „Companies House public task and Crown copyright“,
9. August 2019): Registerinformationen sind nach § 47 CDPA und Database
Regulations zur öffentlichen Einsicht bestimmt; „Companies House imposes
no rules or requirements on how the information on the public register is
used“. Einzige Auflagen: keine Krone, Quellenangabe bei Inhalten von
Website oder Leitfäden, eigene Prüfung fremder Urheberrechte. Material
von Companies House selbst steht unter der Open Government Licence v3.0.
Personendaten (Officers, PSC) unterliegen der UK GDPR; wie bei DE gilt
Art. 14 (Informationspflicht) in der App bereits.

## 2. Was das für AVA bedeutet

| Frage | Deutschland | Österreich | UK |
|---|---|---|---|
| Vollabzug | unmöglich (Portal) | Aufzählung 43k Anfragen | **kostenloser Monats-CSV** |
| Delta | Nummernfront + Bekanntmachungen | monatliche Aufzählung | CSV-Vergleich, optional Streaming |
| Detail je Firma | Registerportal (Browser) | JSON-API | Web-HTML oder REST-API (Schlüssel) |
| Geschäftsführung | Registerportal | nur Vollauszug (kostenpflichtig) | **Officers frei** (Web und API) |
| Adresse | Registerportal | JSON-Detail | **im Bulk enthalten** |
| Branche | Profil-LLM | Profil-LLM | **SIC-Codes im Bulk** |
| Insolvenzen | Insolvenzportal | Ediktsdatei | Companies House Insolvency + Gazette |
| Ratengrenze | 60/h je IP | 0,5/s je IP | API 600/5 min; Web nicht dokumentiert, 0,5/s |
| Nutzungsrecht | Nutzungsordnung, Einzelabruf | offen (Servicecenter) | **ausdrücklich frei** |

UK ist die einfachste der drei Quellen: Der Monatsabzug liefert alles,
was `GermanCompany` braucht, plus Adresse, SIC und frühere Namen. Der
Registerdaten-Scrape (structured-content) entfällt wie bei AT; Officers
lassen sich aber ohne Login holen, also gibt es für UK anders als für AT
eine Geschäftsführung aus der Primärquelle.

## 3. Abbildung auf das Datenmodell

| Feld | Regel |
|---|---|
| `companyId` | `UK_<Nummer>` mit der achtstelligen Nummer inklusive Präfix und führender Nullen: `UK_00077570`, `UK_SC123456`, `UK_NI012345`. Die Nummer ist die einzige amtliche Kennung, überall gleich (Bulk, Web, API, Gazette). |
| `country` | `UK` (neuer Wert neben DE, AT, CH; Validator und App erweitern). |
| `registerType` / `registerNumber` | `CH`-Kürzel wäre missverständlich (Schweiz): `registerType = "CRN"` (Company Registration Number), `registerNumber = "00077570"`. Anzeige „CRN 00077570“. |
| `districtCourt` | Registerbehörde nach Nummernkreis: „Companies House Cardiff“ (Ziffern, England und Wales), „Companies House Edinburgh“ (SC, SO, SL …), „Companies House Belfast“ (NI, NC …). |
| `state` | Landesteil aus dem Nummernkreis: England and Wales, Scotland, Northern Ireland; `RegAddress.Country` als Fallback. |
| `location` | `RegAddress.PostTown` (Titel-Schreibweise), Fallback County. |
| `legalForm` | `CompanyCategory` (Langname, z. B. „Private Limited Company“). |
| `registerStatus` | `Active` und alle Insolvenz-Stände → ACTIVE; `Active - Proposal to Strike off` → LOESCHUNG_ANGEKUENDIGT; fehlt eine Firma im neuen Monatsabzug und war vorher da → CLOSED (mit Datum des Abzugs, das Auflösungsdatum kommt beim Refresh aus der Firmenseite). |
| `insolvencyStatus` | aus `CompanyStatus`: Liquidation, In Administration, Administrative Receiver, Receivership, Administration Order → EROEFFNET; Voluntary Arrangement → EROEFFNET (Sanierung); Receiver Manager → VERDACHT. Ereignisse (InsolvencyEvent, `quelle: companieshouse` oder `gazette`) aus der Insolvenzseite und dem Gazette-Feed; Kategorien EROEFFNUNG (Commencement of winding up, Administration), AUFHEBUNG (Conclusion), SONSTIGES. |
| Historie | frühere Namen mit Datum (bis 10) → `GermanCompanyHistory` (order nach Datum). |
| Zusatz | SIC-Codes (bis 4), Straße, PLZ, Gründungsdatum: neue optionale Spalten `sicCodes String[]`, `street`, `zipCode`, `incorporatedAt` (auch für AT-Detail und CH nützlich). |
| Officers | eigene Tabelle `CompanyOfficer` (companyId, name, role, status, appointedAt, resignedAt, birthMonth, nationality, quelle) oder direkt als Geschäftsführung in structured-content. Vorschlag: structured-content bekommt für UK einen Weg ohne Browser, der Officers und Firmenseite per HTTP liest und `managingDirectors` befüllt, damit App und Chat nichts Neues lernen müssen. |

## 4. Umsetzungsskizze

1. **Notebook** (dieser Schritt): Bulk-Abzug laden, Spalten und Mengen,
   companyId-Regel, Abbildung, Status- und Insolvenzableitung, Parser für
   Officers- und Insolvenzseite, Gazette-Feed, Takt.
2. **master-data:** `country` um `UK` erweitern, companyId-Muster
   `^UK_[A-Z]{0,2}[0-9]{6,8}$`, optionale Spalten (sicCodes, street,
   zipCode, incorporatedAt); Import-Route bleibt `register-delta`.
3. **Gateway + Paket:** Job-Art `uk_bulk` (Monatsabzug laden, je Teil
   eine Zeile → Delta in Bündeln zu 1.000 an master-data; Firmen, die im
   Vormonat da waren und jetzt fehlen → CLOSED), `uk_refresh` (Firmen-
   und Officers-Seite je Pool-Firma alle 30 Tage), `uk_insolvenz`
   (Insolvenzseite plus Gazette je Pool-Firma alle 30 Tage). Alles ohne
   Browser, läuft im Fly-Worker `worker_at` (umbenennen in `worker_json`)
   und beim Mithelfen. Streaming-API als späterer Ersatz für den
   Monatsvergleich, wenn ein Schlüssel vorliegt.
4. **structured-content:** UK-Zweig ohne Handelsregister: Officers und
   Sitz per HTTP, `managingDirectors` aus Directors (aktiv), Rechtsform
   und Gründung aus der Firmenseite.
5. **App:** Landeschip UK, Registerkennung „CRN“, Insolvenzabschnitt mit
   Quelle Companies House und Gazette, Link zur Firmenseite (dort ist
   alles kostenlos, anders als in Österreich).

Aufwand grob: Notebook 0,5 Tage, master-data 0,5 Tage, Gateway und
Paket 1,5 Tage (Bulk-Job mit Vergleich ist der größte Teil),
structured-content 1 Tag, App 0,5 Tage.

## 4a. Stand der Umsetzung

- **master-data (2026-09-15, Deploy offen):** Land `UK` im Validator und
  im Listenfilter, companyId-Muster `UK_` plus 8 Zeichen (Präfix, Ziffern,
  Suffix, führende Nullen erhalten), GB-UID. Neue optionale Spalten
  `sicCodes` (Text-Array), `street`, `zipCode`, `incorporatedAt` (Migration
  `20260915180000_uk_zusatzspalten`, reine Katalogänderung). Delta-Zeilen
  dürfen `insolvencyStatus` (NONE, VERDACHT, EROEFFNET) mitgeben; der Wert
  gilt beim Anlegen immer und bei Änderung nur, solange keine
  InsolvencyEvent-Zeilen vorliegen, danach entscheidet die Ableitung aus
  den Ereignissen. Insolvenzquellen `companieshouse` und `gazette`.
  33 Unit-Tests grün.
- **master-data (2026-09-15, zweiter Teil, Deploy offen):** interne Route
  `POST /internal/companies/uk-bulk-abschluss { seitAt, country }` setzt
  Firmen des Landes, die seit `seitAt` nicht gesehen wurden, auf CLOSED
  (in Blöcken zu 5.000, Index nachgezogen).
- **Paket register-delta (2026-09-15):** `uk-companies-house.ts` mit
  companyId-Regel, Registrar je Nummernkreis, Abbildung der Bulk-Zeile,
  RFC-4180-Streaming-CSV-Parser, ZIP-Streaming (`yauzl`) nach `/tmp`,
  Parser für Firmenseite, Insolvenzseite und Gazette-Feed (nur Einträge,
  die die Nummer nennen), Kategorien. Job-Arten `uk_bulk` (Teil-ZIP
  streamen, Bündel zu 1.000 als Teilergebnisse ans Gateway),
  `uk_refresh` (Firmenseite, Bündel 100), `uk_insolvenz` (Insolvenzseite
  plus Gazette, Bündel 50). Takt 0,5/s, kein Browser. `REGISTER_DELTA_UK=0`
  schaltet ab. 7 neue Tests (31 gesamt).
- **Gateway (2026-09-15, Deploy offen):** Route
  `POST /register-jobs/{id}/teilergebnis` (v1 und intern): schreibt das
  Delta, merkt die Teilnummer im Payload (idempotent), verlängert die Lease
  um 20 Minuten. `uk_bulk`-Ergebnis prüft, dass alle gemeldeten Bündel
  angekommen sind (sonst 409, Job fällt zurück) und stößt nach dem letzten
  Teil des Abzugs den Abschluss in master-data an. Monatliche Erzeugung
  (`erzeugeUkJobs`, Cron 02:00 UTC, `UK_JOBS_DISABLED=1`, sofort per HMAC
  `POST /internal/register-jobs/uk/erzeugen`): liest die Download-Seite,
  ein Job je Teil (Schlüssel mit Abzugsdatum), Pool-Refresh und Insolvenz
  für `UK_`-Firmen. `POST /v1/register-jobs/uk` für konkrete Firmen.
- **Fly-Worker:** `worker_at` bedient jetzt auch `uk_*`, der DE-Worker
  nicht (`REGISTER_DELTA_UK=0`).
- **Live seit 2026-09-15 15:09 UTC:** master-data, Gateway und Worker
  deployt, 7 `uk_bulk`-Jobs für den Abzug 2026-09-01 eingereiht. Erster
  Anlauf scheiterte am Delta-Validator (leere Orte in der Historie, und
  parallel AT-Refresh ohne Gericht → leeres Bundesland); Hotfix master-data
  2129fb6: leere `location`/`districtCourt`/`state` erlaubt, Bestand bleibt.
  Danach Teil 1: 47.000 Zeilen in rund 2 Minuten (1.000 je 2,5 s), Teil 1
  ≈ 35 min, alle 7 Teile ≈ 4 Stunden; Cluster bei 44 Verbindungen.
  Beispiel `UK_00004606` mit PLZ, Gründung 1869, SIC 7499.
- **2026-09-15 15:19 UTC, Abbruch bei 70.000 Zeilen:** master-data
  `germanCompanyHistory.createMany` scheiterte an „Unique constraint failed
  on (id)“. Ursache: die Sequenz `GermanCompanyHistory_id_seq` stand seit
  dem Ursprungsimport bei 122.523, die Tabelle hatte Ids bis 1.587.521;
  frühere Inserts trafen zufällig Lücken. Behoben am 2026-09-16 per
  `setval` auf `max(id)` (mit Freigabe), Job 18490 neu eingereiht. Dazu
  brauchte jeder Delta-Aufruf rund 20 s; mit Zeitmessung und Elastic-Refresh
  nur bei kleinen Bündeln (b01e2a9) sind es 0,5 s Datenbank plus 0,3 s Index
  je 1.000 Zeilen, Erstimport damit rund 3 bis 4 Stunden.
- **structured-content (2026-09-16, e134ce9):** `UK_`-Firmen laden
  Firmenseite und Officers per HTTP; aktive Directors werden zur
  Geschäftsführung, Rechtsform, Gründung, Adresse und SIC kommen mit.
- **App (v0.1.662):** Landeschip UK, Kennung „CRN“, Länderfilter in
  Firmensuche und Meine Firmen (Gateway search/list/matrix mit `country`,
  master-data Fuzzy-Filter in Elastic, Altbestand ohne Feld = DE).
- **Nächster Schritt:** Abschluss des Abzugs beobachten, Eisenstadt-Kontrolle
  (AT), UK-Pool-Jobs sobald Nutzer UK-Firmen importieren.

## 5. Offene Entscheidungen

1. **API-Schlüssel ja oder nein?** Web-HTML reicht für Detail, Officers
   und Insolvenz; der Schlüssel bringt JSON statt HTML, die
   Streaming-API und eine dokumentierte Grenze. Vorschlag: Web zuerst,
   Schlüssel als Betreiber-Option für den Fly-Worker (BYOK je Nutzer
   wäre für Mithelfen unnötig).
2. **Welche Rechtsformen aufnehmen?** Private Limited Company stellt
   92 %; dazu PLC, LLP, Limited Partnership, Community Interest Company,
   Registered Society. Charities (CIO), Overseas Entities (OE, Register
   of Overseas Entities) und Establishments (BR/FC) eher nicht.
3. **Aufgelöste Firmen:** Der Bulk enthält nur lebende. Fehlende Firmen
   beim Monatsvergleich auf CLOSED setzen, ja; rückwirkend aufgelöste
   (historisch) nicht importieren.
4. **Officers als eigene Tabelle oder in structured-content?** Vorschlag
   structured-content (siehe §3), weil App und Chat dann unverändert
   funktionieren.
5. **Erstimport-Größe:** 5,7 Mio. Zeilen, 1.000 je Delta-Aufruf → 5.700
   Aufrufe an master-data, Elastic-Bulk je Aufruf. Zeitfenster nachts,
   Bündel bewusst klein wegen des DB-Clusters (PgBouncer-Deckel).
   Alternativ Vorfilter auf Rechtsformen (Entscheidung 2) und Status
   ohne „Proposal to Strike off“, dann rund 5 Mio.
