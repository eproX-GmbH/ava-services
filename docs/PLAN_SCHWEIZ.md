# Bewertung: Schweiz als zweites Land (Zefix, LINDAS, kantonale Auszüge)

Stand 2026-09-15, Bestandsaufnahme vor einer Umsetzung. Frage: Lässt sich
das Schweizer Handelsregister so in AVA aufnehmen wie das deutsche
(Stammdatenliste in master-data, Registerauszug je Firma als strukturierter
Inhalt), und wie wird auf das bestehende Datenmodell abgebildet?

## 1. Quellen (geprüft am 2026-09-15)

**Zefix Public REST API** (`https://www.zefix.admin.ch/ZefixPublicREST/api/v1`,
OpenAPI 3.1, Version 2.7.2.3, Lizenz „OGD Open use, Quelle nennen“)
- Endpunkte: `POST /company/search`, `GET /company/uid/{uid}`,
  `GET /company/ehraid/{id}`, `GET /company/chid/{id}`,
  `GET /sogc/bydate/{date}` (alle SHAB-Publikationen eines Tages),
  `GET /sogc/{id}`, `GET /legalForm`, `GET /registryOfCommerce`,
  `GET /community`.
- Zugang: HTTP Basic mit kostenlosem Konto beim Bundesamt für Justiz
  (Antrag per E-Mail an zefix@bj.admin.ch; ohne Konto 401). Testsystem
  `zefixintg.admin.ch`. Ratengrenzen werden nicht genannt; abklären.
- **`CompanyFull`** liefert je Firma: name, uid, ehraid, chid, legalSeat,
  registryOfCommerceId, legalForm, status, sogcDate, deletionDate,
  translation (Namen in anderen Sprachen), **purpose** (Zweck), sogcPub
  (SHAB-Meldungen mit Text und Mutationsarten), address (Strasse, Nummer,
  PLZ, Ort), canton, **capitalNominal, capitalCurrency**, headOffices,
  branchOffices, hasTakenOver, wasTakenOverBy, auditCompanies, oldNames,
  cantonalExcerptWeb, zefixDetailWeb.
- Nicht enthalten: **Personen** (Verwaltungsrat, Geschäftsführung,
  Zeichnungsberechtigte).

**LINDAS (Linked Data des Bundes, `https://lindas.admin.ch/query`, SPARQL, ohne Konto)**
- Graph `<https://lindas.admin.ch/foj/zefix>`: **793.364 aktive
  Rechtseinheiten** (Klasse `ZefixOrganisation`), täglich aktualisiert.
- Je Firma: `schema:legalName`, `schema:name` (Sprachvarianten),
  `schema:description` (Zweck), `schema:identifier` (UID `CHE101602521`,
  CHID, EHRAID), `schema:additionalType` (Rechtsform nach eCH-0097, z. B.
  0106 AG 250.946, 0107 GmbH 291.621, 0101 Einzelunternehmen 180.188,
  0110 Verein 17.784, 0151 Zweigniederlassung 15.356, 0109 Stiftung 13.535,
  0103 Kollektivgesellschaft 11.209, 0108 Genossenschaft 7.957),
  `schema:address` (Strasse, Hausnummer, PLZ, Ort, Kanton),
  `admin:municipality` (BFS-Gemeinde).
- Das ist die „schnell beziehbare Liste“: vollständiger Abzug in einer
  Stunde per SPARQL in Seiten, ohne Portal, ohne Takt.

**Kantonale Auszüge (`<kanton>.chregister.ch/cr-portal/auszug/auszug.xhtml?uid=CHE-…`)**
- Öffentlich, ohne Anmeldung, JSF-Seite (Inhalt wird per JavaScript
  gerendert; Selenium wie beim deutschen Handelsregister). Geprüft mit
  Roche Holding AG (BS): Firma, Rechtsform, Sitz, UID, Eintragungsdatum,
  Aktienkapital mit Liberierung und Stückelung, PS-Kapital,
  Domiziladresse, Zweck, Bemerkungen, Statutendaten, Besondere
  Tatbestände, Publikationsorgan, Tagebuch/SHAB-Referenzen, **Personalangaben
  mit Funktion und Zeichnungsart** (z. B. „Hoffmann, André, von Basel, in
  Vaux-sur-Morges, Vizepräsident des Verwaltungsrates, Kollektivunterschrift
  zu zweien“), Revisionsstelle. Gestrichene Einträge sind markiert
  (Spalten Ei/Ae/Lö).
- Alle Kantone nutzen dieses gemeinsame Portal (Unterdomänen je Kanton);
  der Link steht in Zefix als `cantonalExcerptWeb`.
- Nutzungsordnung der Portale ist zu prüfen (Takt wie beim deutschen
  Register, 60 je Stunde, als Obergrenze).

**SHAB/SOGC** (Schweizerisches Handelsamtsblatt): alle Mutationen
(Neueintragungen, Änderungen, Löschungen, Konkurse) als tägliche
Publikationen über `GET /sogc/bydate/{date}` mit Text und Mutationsart.
Das ist das Delta, das in Deutschland fehlt: **Neueintragungen sind
enthalten**, eine Nummernfront ist nicht nötig.

## 2. Abbildung auf das Datenmodell

### 2.1 `GermanCompany` (master-data) → Schweizer Firma

| Feld (heute, DE) | Schweiz | Bemerkung |
|---|---|---|
| `companyId` | `CH_<UID ohne Punkte>` = `CH_CHE101602521` | siehe 2.3 |
| `name` | `legalName` | Zefix-Firma, exakt |
| `nameNormalized` | wie heute | |
| `location` | `legalSeat` (Sitzgemeinde) | Domiziladresse separat |
| `registerNumber` | UID `CHE-101.602.521` | Es gibt keine HRB-Nummer; die CH-Nummer (`CH-270.3.005.159-0`) ist veraltet, EHRAID intern |
| `registerType` | Rechtsform-Kürzel (`AG`, `GmbH`, `EU`, `KolG`, `Gen`, `Stiftung`, `Verein`, `ZN`) | In DE steht hier HRA/HRB; für CH die Rechtsform, damit Filter „HRB = Kapitalgesellschaft“ eine Entsprechung haben |
| `districtCourt` | kantonales Handelsregisteramt (`registryOfCommerce`, z. B. „Basel-Stadt“) | Rolle des Amtsgerichts |
| `state` (Bundesland) | Kanton (`BS`, `ZH`, …) | |
| `registerStatus` | `status` (ACTIVE / CANCELLED → CLOSED), `deletionDate` → `closedAt` | |
| `formerCourt` | leer | |
| `source` | `zefix` | |
| neu: `country` | `DE` / `CH` | **fehlt heute**; Default `DE` |
| neu: `legalForm` | eCH-0097-Code plus Kürzel | in DE heute nur in StructuredContent |
| neu: `uid` | `CHE-101.602.521` | offizielle, stabile Unternehmens-ID; für DE leer |

`GermanCompanyHistory` (Namens- und Sitzhistorie): aus `oldNames` und den
SHAB-Meldungen; Zefix liefert frühere Namen direkt.

### 2.2 `StructuredContent` (Registerauszug) → kantonaler Auszug

| Feld | Quelle CH |
|---|---|
| `corporatePurpose` | Zefix `purpose` (Zweck), identisch mit dem Auszug |
| `shareCapital` | Zefix `capitalNominal` (Aktien-/Stammkapital), `capitalCurrency` neu (CHF statt EUR) |
| `legalForm` | Zefix `legalForm.shortName` |
| `street`, `houseNumber`, `zipCode`, `city` | Zefix `address` |
| `foundingYear` | Auszug „Eingetragen am“ oder erste SHAB-Publikation |
| `lastRegisterEntry`, `lastRegisterModification` | Zefix `sogcDate` / letzter Tagebucheintrag |
| `managingDirectors` (Vorname, Nachname, Wohnort) | **nur aus dem kantonalen Auszug** („Personalangaben“); Funktion und Zeichnungsart als neue Felder, sonst geht Information verloren |

Folge: Zweck, Kapital, Adresse, Rechtsform, Historie kommen **ohne
Browser** aus der API oder LINDAS. Nur die Personen (Organe) brauchen den
kantonalen Auszug per Selenium, genau wie heute das deutsche SI-XML.

### 2.3 Reproduzierbare companyId

- Die Schweizer UID (`CHE-123.456.789`, Prüfziffer, unveränderlich, auch
  im MwSt- und AHV-Kontext) ist die einzige stabile, amtliche Kennung.
  HRB-Nummern gibt es nicht; die kantonale Tagebuchnummer ist je Mutation
  neu, die alte CH-Nummer wird nicht mehr geführt.
- Vorschlag: `companyId = "CH_" + UID ohne Bindestrich und Punkte`
  (`CH_CHE101602521`). Eindeutig, reproduzierbar aus jeder Quelle (Zefix,
  LINDAS, SHAB, Auszug), kollidiert nie mit deutschen Ids
  (`GERICHT_ART_NUMMER`), Länderpräfix macht die Herkunft sichtbar.
  Zweigniederlassungen haben eigene UIDs (Rechtsform 0151), also eigene
  Zeilen; Verweis auf den Hauptsitz über `headOffices`.
- Deutsche Ids bleiben unverändert (kein `DE_`-Präfix nachträglich, das
  bräche Verweise in allen Producern). Das Land steht in der neuen Spalte.

## 3. Was am Modell und den Diensten zu ändern wäre

1. **master-data:** Spalten `country`, `uid`, `legalForm`,
   `capitalCurrency`-nahe Felder; Namensraum „switzerland“ neben „germany“
   (`src/application/switzerland`, Controller `/api/switzerland/v1/…`) oder
   ein länderneutraler Namensraum `companies` mit `country`-Filter. Die
   Suche (Elasticsearch) bekommt `country` als Feld; die App filtert nach
   Land.
2. **Import CH:** Skript wie das deutsche Seed: LINDAS-Abzug (793k) →
   Upsert mit dem bestehenden Delta-Pfad (`upsertManyDelta`, source
   `zefix`). Danach täglich `sogc/bydate` (Zefix-Konto) für Neueintragungen,
   Mutationen, Löschungen, Konkurse. Eine eigene Nummernfront ist
   unnötig; die Register-Delta-Queue bekommt eine Job-Art `ch-sogc`
   (ein Job je Tag, läuft auf Fly, weil das Zefix-Konto beim Betreiber
   liegt).
3. **structured-content:** Länderweiche: für `country = CH` die Felder aus
   Zefix (`/company/uid/{uid}`, Betreiber-Konto über das Gateway als
   Proxy, damit das Konto nicht auf Nutzerrechner kommt) plus Selenium auf
   `cantonalExcerptWeb` für die Personen. Domain-Allowlist um
   `chregister.ch` und `zefix.admin.ch` erweitern
   (`docs/SICHERHEIT_HINTERGRUND_BROWSER.md`).
4. **Publikationen / Finanzen:** Es gibt keinen Bundesanzeiger; Jahresabschlüsse
   sind in der Schweiz nicht öffentlich (Ausnahme kotierte
   Gesellschaften). `company-publication` liefert für CH nichts; die
   Finanzkennzahlen-Tabs bleiben leer. Das muss die App zeigen, nicht
   verschweigen.
5. **Insolvenz:** Konkurse stehen im SHAB (Mutationsart), also im selben
   Delta; kein eigenes Portal.
6. **App:** Länderkennzeichen an der Firma (Chip „CH“), Register-Anzeige
   „UID“ statt „HRB“, Kanton statt Bundesland, Währung CHF bei Kapital,
   Import-Suche nach Land. Bestehende deutsche Ansichten bleiben.

## 4. Aufwand (grob)

| Baustein | Aufwand |
|---|---|
| master-data Schema, Namensraum, LINDAS-Import | 2 bis 3 Tage |
| Zefix-Konto beantragen, Gateway-Proxy, SOGC-Tagesjob in der Queue | 2 Tage |
| structured-content Länderweiche (API-Felder, Auszug-Selenium für Personen) | 3 bis 4 Tage |
| App (Land, UID, Kanton, CHF, leere Finanzen erklären) | 2 Tage |
| Notebook vorab (LINDAS-Abzug, Zefix-API, ein Auszug je Kanton, SOGC-Tag) | 1 Tag |

## 5. Offene Entscheidungen

1. companyId-Form `CH_CHE…` (Vorschlag) oder reine UID.
2. Namensraum: eigener Pfad „switzerland“ (spiegelt „germany“) oder
   länderneutral mit `country`-Feld. Vorschlag: länderneutral im Modell,
   eigener Controller-Pfad je Land nur dort, wo die Quelle es verlangt.
3. Zefix-Konto: Antrag beim BJ (Betreiber), Nutzung nur serverseitig.
4. Personen aus dem Auszug: alle Organe mit Funktion und Zeichnungsart
   speichern (neue Felder an `ManagingDirector`) oder nur Geschäftsführung
   wie in DE.
5. Einzelunternehmen (180k) und Vereine/Stiftungen mit aufnehmen oder auf
   Kapital- und Personengesellschaften beschränken.

Empfehlung: erst ein Notebook wie beim Register-Delta (I0-Muster), dann
master-data, dann structured-content, dann App.
