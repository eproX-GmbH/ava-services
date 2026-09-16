# Plan: Firmen-Verflechtungen (Deutschland)

Stand 2026-09-16. Ziel: Firmengeflechte mit allen Beteiligten transparent
machen, wie North Data es zeigt: verbundene Firmen, Geschäftsführung,
Gesellschafter (Personen und Firmen), gemeinsame Adressen. Fokus zunächst
nur Deutschland. Notebook: `master-data/scripts/de/gesellschafterlisten.ipynb`.

## 1. Quelle: Gesellschafterlisten im Registerportal (geprüft am 2026-09-16)

**Weg im Portal** (handelsregister.de, Erweiterte Suche wie beim Register-Delta):
Suche nach Gericht, Registerart und Nummer, in der Trefferzeile statt „SI“
den Knopf **„DK“** (Dokumente). Die Seite „Suchergebnis - Freigegebene
Dokumente“ zeigt einen PrimeFaces-Baum `dk_form:dktree`, dessen Knoten erst
beim Aufklappen laden:

```
Dokumente zum Rechtsträger
  Dokumente zur Registernummer
    Gesellschaftsvertrag / Satzung / Statut
    Liste der Gesellschafter
      Liste der Gesellschafter - Aufnahme in den Registerordner am 09.05.2022
      Liste der Gesellschafter - Aufnahme in den Registerordner am 04.05.2022
      ...
    Jahresabschluss / Bilanz  (nur manchmal)
    Weitere Urkunden / Unterlagen
    Anzeige nach Eintragung / Anzeige nach Eingang
```

Nach Auswahl eines Blatts erscheint rechts die Download-Karte: Format-Radios
(`dk_form:radio_dkbuttons`, Beschriftungen „zip“ und „pdf“ **oder** „zip“
und „tiff“), Dateigröße, Dokumentart, „Erstellt zum“, „Eingegangen am“,
„Aufnahme in den Registerordner am“, Knopf „Download“ (`dk_form:j_idt205`).
Pro Anfrage genau ein Dokument. Die Datei heißt
`NW-Bad_Oeynhausen_HRB_17968+Liste_der_Gesellschafter_-_Aufnahme_in_den_R-<Zeit>.pdf`.

**Vier Abrufe im Notebook** (je Abruf 4 Portal-Requests: Suche, DK, zwei
Baumknoten, dazu der Download):

| Firma | Liste vom | Format | Inhalt |
|---|---|---|---|
| eproX GmbH, Bad Oeynhausen HRB 17968 | 09.05.2022 (3 Fassungen) | PDF, 2 Seiten, **nur Bild**, um 90° gedreht; Textebene nur im Notarvermerk | 2 Personen mit Geburtsdatum und Wohnort, 1 Firma: „QUIKK Software & Webdesign UG (haftungsbeschränkt) HRB 17559 AG Bad Oeynhausen“, je 12.500 EUR, 33,38 % |
| QUIKK Software GmbH, Bad Oeynhausen HRB 17559 | 04.01.2024 (1 Fassung) | PDF mit **Textebene** (pdftotext liest die Tabelle direkt) | 1 Person mit Geburtsdatum und Wohnort, 2 Anteile (500 + 24.500 EUR), Kapitalerhöhung |
| TradeMax GmbH, Bad Oeynhausen HRB 17084 | 02.11.2023 (2 Fassungen) | PDF mit Textebene | Tabelle „Angaben zum Gesellschafter / Angaben zum Geschäftsanteil / Veränderungen“ |
| tc85 GmbH, Lemgo HRB 9501 | 16.12.2019 (2 Fassungen) | **nur „zip“ oder „tiff“**, ZIP enthält eine TIFF (Group 4, 2480×3507, 2 Seiten) | Torben Calenberg, geb. 27.11.1985, Anteile 1–25.000 und 25.001–26.000 |
| 14. EMH Grundstücksverwaltung GmbH & Co. KG, Bad Oeynhausen HRA 9641 | keine | Baum ohne Knoten „Liste der Gesellschafter“ (Personengesellschaft) | **sauberer Abbruch**: „keine Gesellschafterliste“ |

Weitere Beobachtungen:
- Layouts sind je Notar unterschiedlich (Spalten, Reihenfolge, Hoch- oder
  Querformat, Fließtext statt Tabelle). Feste Regex-Parser reichen nicht,
  gemeinsam ist nur der Inhalt: Gesellschafter (Person mit Geburtsdatum und
  Wohnort oder Firma mit Registerangabe), Nummern der Geschäftsanteile,
  Nennbetrag, Prozent, Veränderungen, Stammkapital.
- Firmen als Gesellschafter nennen fast immer Gericht und Nummer („HRB 17559
  AG Bad Oeynhausen“, „AG Bad Oeynhausen HR B 17559“): daraus wird die
  companyId nach der Original-Regel (`BADOEYNHAUSEN_HRB_17559`).
- Die Portal-Nutzungsordnung (60 Abfragen je Stunde und IP) gilt auch hier;
  ein Listenabruf kostet 4 bis 5 Abfragen, also rund 12 Listen je Stunde
  und Worker.
- Die Listen sind öffentlich und ohne Login abrufbar; sie enthalten
  Geburtsdaten natürlicher Personen (DSGVO: Verarbeitung nach Art. 6 Abs. 1
  f, Informationspflicht Art. 14 wie bei den Kontakten bereits gelöst).

**OCR-Befund:** Tesseract ließ sich per Homebrew nicht installieren
(Command Line Tools zu alt, braucht `sudo`). RapidOCR (ONNX, rein lokal,
Python 3.10) liest die gedrehte eproX-Seite und die tc85-TIFF zeilenweise in
1,4 bis 2 Sekunden je Seite: Zahlen, Prozentwerte, Registerangaben und
Namen kommen sauber, Umlaute fehlen („Veranderungen“, „Kapitalerhohung“).
Für die strukturierte Auswertung reicht das als Vorstufe; die Zuordnung zu
Feldern übernimmt das LLM des Nutzers (Text plus Bild bei Vision-Modellen).

## 2. Was daraus wird

Ein Graph aus vier Kantenarten je Firma:

| Kante | Quelle | Stand |
|---|---|---|
| **Gesellschafter → Firma** (Person oder Firma, Anteil in EUR und %) | Gesellschafterliste (neu) | dieser Plan |
| **Geschäftsführer → Firma** | structured-content (Registerportal SI) | vorhanden, Personen noch nicht firmenübergreifend verknüpft |
| **Firma ↔ Firma über dieselbe Adresse** | master-data (Straße, PLZ, Ort aus SI; UK bereits, DE nachziehen) | Straße/PLZ in master-data vorhanden (`street`, `zipCode`), DE-Befüllung aus structured-content fehlt |
| **Firma → Firma über Beteiligung** | Gesellschafterliste, Firma als Gesellschafter | dieser Plan |

Jahresabschlüsse (Beteiligungsspiegel im Anhang) werden bewusst
zurückgestellt: teuer, uneinheitlich, oft nur „Anteilsbesitz > 20 %“.

## 3. Datenmodell (master-data)

```
Shareholding                     -- eine Zeile je Gesellschafter je Liste
  id, companyId (Beteiligte Firma), listeDatum (Aufnahme in den Registerordner),
  typ: PERSON | FIRMA,
  personName, geburtsdatum (Date, nullable), wohnort,
  gesellschafterCompanyId (nullable; aufgelöst über Registerangabe),
  gesellschafterFirmaText (Rohtext, falls nicht auflösbar),
  anteileNummern (Text "1-12500"), nennbetragEur (Decimal), prozent (Decimal),
  veraenderung (Text), quelleDokument (Dateiname), konfidenz (0..1), createdAt
  @@index([companyId, listeDatum]), @@index([gesellschafterCompanyId])

ShareholderListCheck             -- je Firma: letzter Stand
  companyId PK, geprueftAt, listeDatum (nullable), ergebnis: LISTE | KEINE | FEHLER,
  format (pdf|tiff), textebene (bool), ocr (bool), fehler (Text)

Person (neu, firmenübergreifend)  -- Zusammenführung von Geschäftsführern und Gesellschaftern
  id, vorname, nachname, geburtsdatum (nullable), wohnort (nullable), normKey
  (nachname|vorname|geburtsdatum bzw. |wohnort), createdAt
PersonRole
  personId, companyId, rolle: GESCHAEFTSFUEHRER | GESELLSCHAFTER | PROKURIST,
  von, bis (nullable), quelle
```

Zusammenführung von Personen: gleicher Name plus Geburtsdatum ist eindeutig
(North Data arbeitet genauso); ohne Geburtsdatum (Geschäftsführer aus dem
Registerportal haben oft nur Geburtsmonat oder Wohnort) gleicher Name plus
Wohnort, sonst zwei Knoten mit Hinweis „möglicherweise dieselbe Person“.
Adresse: `street` + `zipCode` normalisiert (Klein, ohne Leerraum,
„str.“ = „straße“) als Schlüssel; Treffer nur bei identischem Schlüssel.

## 4. Pipeline

**Architektur (korrigiert 2026-09-16):** Die Gesellschafterliste wird im
**structured-content-Producer** auf dem Rechner des Nutzers geholt und
ausgewertet, nicht im Gateway oder Register-Worker. Nur dort liegt der
KI-Schlüssel des Nutzers (Producer-Umgebung `LLM_PROVIDER`, `OPENAI_API_KEY`
usw. aus dem ProducerSupervisor), und nur dort ist die Registerportal-
Navigation bis „SI“/„DK“ schon vorhanden. Ein erster Ansatz über Job-Art
`gesellschafter` im Gateway wurde vollständig zurückgenommen (Reverts
6204c2f, f9d8216, master-data a04eb01).

1. **Auslöser:** Jeder normale structured-content-Lauf einer deutschen
   HRB-Firma (Pool-Aufnahme, Refresh). Bedingung: Org-Feature
   `verflechtungen` aktiv (Desktop reicht `AVA_VERFLECHTUNGEN=1` in die
   Producer-Umgebung). HRA-Firmen haben keine Liste und werden übersprungen.
2. **Webdriver `gesellschafterliste()`** (`handelsregister-webdriver.ts`):
   Erweiterte Suche, Trefferzeile, DK, Baum „Dokumente zur Registernummer“ →
   „Liste der Gesellschafter“, neuestes Blatt nach Datum, Format `pdf`
   wenn angeboten, sonst `zip` (TIFF), Download-Knopf. Der Download landet
   im bestehenden `HR_DOWNLOAD_DIR` (Freigabe des Nutzers 2026-09-16: gleiche
   Ausnahme wie für die XML-Dateien; nur handelsregister.de, nur nach Klick,
   Magic-Bytes-Prüfung, bis 20 MB, Datei wird nach dem Lesen gelöscht, nie
   ausgeführt). Ohne Knoten → Ergebnis `KEINE`.
3. **Dokumentprüfung** (`verflechtungen/dokument.ts`): PDF, TIFF oder ZIP mit
   PDF/TIFF, erkannt an den Magic Bytes; ZIP im Speicher ohne Bibliothek (die
   Portal-ZIPs tragen einen fehlerhaften Kommentar-Längeneintrag). SHA-256
   als Beleg-Schlüssel.
4. **Auswertung mit dem Modell des Nutzers** (`verflechtungen/auswertung.ts`):
   `getLLM()` aus `@ava/ai-provider`. Seiten werden **lokal gerendert**
   (`pdf-bild.ts`: pdfjs + @napi-rs/canvas, etwa 200 dpi, OpenAI
   `imageDetail=high`; TIFF über utif2 auf dieselbe Canvas), weil die
   Anbieter eingebettete PDFs stark verkleinern und Namen dann verlesen
   werden (Live-Befund 2026-09-16). Eine vorhandene Textebene (pdf-parse)
   wird als Hilfstext beigelegt. Ohne Vision-Modell und ohne Textebene →
   `UNSICHER`, nie geraten. **Zwei unabhängige Lesungen** (Seitenreihenfolge
   und Leseanweisung anders); nur was beide gleich lesen, gilt. Dann JSON →
   Yup-Schema (§6) → Qualitätsfilter (§6a, inkl. Kopf-Abgleich mit dem
   Firmennamen aus dem Registerlauf und Zusammenführen mehrerer Anteile
   eines Gesellschafters) → `LISTE` oder `UNSICHER` mit Gründen.
   Befund: gpt-5.4-mini liest eproX und tc85 korrekt; gpt-4o-mini liefert
   plausible, aber falsche Namen und wird über die abweichenden Lesungen
   und den Kopf-Abgleich verworfen.
   **Modell-Gate (Entscheidung 2026-09-16):** unterhalb Stufe A oder ohne
   Bildverständnis wird der Schritt komplett blockiert (kein Download,
   kein Aufruf; `pruefeVerflechtungenModell` in `@ava/ai-provider`), und
   Einstellungen → Modelle zeigt den Grund. GPT-5.6 Luna wurde dafür auf
   Stufe A gehoben (docs/MODEL_TIERS.md). Remote-Modelle (OpenAI über den
   Schlüssel des Nutzers) sind ausdrücklich erlaubt.
5. **Persist-Ereignis** `tenant.persist.shareholders.v1` (nach den drei
   Downstream-Ereignissen): `{ companyId, ergebnis: KEINE | LISTE | UNSICHER,
   listeDatum, format, liste, gruende, warnungen, modell, dokument }`. Das
   Gateway (`persist-bus.ts`, `applyShareholders`, Feature-Gate
   `verflechtungen`) ruft `POST /internal/companies/shareholders` in
   master-data: `KEINE` und `UNSICHER` setzen nur den Stand (UNSICHER als
   `FEHLER` mit Gründen), `LISTE` speichert Beteiligungen, Personen, Rollen
   und den Beleg. Fehler im Producer werden nur geloggt; der normale
   Lauf bleibt davon unberührt.
6. **Firmen-Gesellschafter und Rekursion (umgesetzt 2026-09-16, ohne LLM
   im Gateway):** Der Gateway löst Firmen-Gesellschafter über die Original-
   Regel (`companyIdAus`, wie im Register-Delta) zur companyId auf, bevor
   master-data die Liste speichert; master-data zieht die Kanten für
   bekannte Firmen und meldet unbekannte. Danach `nachListe()` in
   `lib/verflechtungen.ts`: offener Besuch dieser Firma im Tenant → dessen
   Kontext, sonst neuer **Wurzelkontext** (automatischer Lauf je Pool-Firma,
   `maxTiefe` 1). Kinder kommen in die **Besuchsliste** (`VerflechtungBesuch`,
   je Kontext höchstens einmal, Schleifen enden hier) und werden über
   master-data `POST /internal/verflechtungen/anstossen` für den Nutzer des
   Ursprungslaufs angestoßen: eigener Vorgang „Verflechtungen <Firma>“, nur
   der Register-Trigger mit Marker `verflechtungen` im `services`-Header, so
   dass structured-content nur Register plus Liste liest (auch wenn der
   Bestand frisch ist) und keine Folge-Producer (Website, Profil, Kontakte)
   startet. Unbekannte Firmen bekommen einen Register-Refresh (Job-Art
   `refresh`, Grund `verflechtungen`) und stehen als `wartetRegister`; ein
   stündlicher Cron stößt sie erneut an, nach 14 Tagen `abgebrochen`.
   Notbremsen je Kontext: `maxTiefe` (1 automatisch, 6 auf Wunsch, bis 12),
   `maxFirmen` 200, `ohneBremse` hebt beides auf. Route
   `POST /v1/verflechtungen/kontexte` (companyId, maxTiefe, ohneBremse) für
   App und Chat, `GET /v1/verflechtungen/kontexte?companyId=` und
   `GET /v1/verflechtungen/kontexte/{kontext}` für den Stand.
7. **Aufwärts:** Wer hält die Ausgangsfirma? Das steht nur in *ihrer* Liste
   (§5). Der Graph füllt sich von unten nach oben mit jedem verarbeiteten
   Pool; „Firmen, an denen X beteiligt ist“ ist eine Abfrage über
   `gesellschafterCompanyId`.
8. **Aktualität:** master-data `GET /internal/companies/shareholders/due`
   liefert Firmen, deren Prüfung fehlt oder älter als 90 Tage ist; der
   Gateway stößt dafür den structured-content-Refresh an (offen).

## 5. Darstellung

- **Firmendetails, Reiter „Verflechtungen“ (neu):** Netzgrafik wie North
  Data (Firmen als Gebäude-Knoten, Personen als Personen-Knoten, aktuelle
  Kanten farbig, frühere grau; Kantenarten Beteiligung mit Prozent,
  Geschäftsführung, gemeinsame Adresse gestrichelt). Darunter Tabelle der
  Gesellschafter mit Anteil, Datum der Liste und Link zum Dokument.
  Layout mit einer kleinen Kraft-Simulation (d3-force ist im Renderer
  bereits verfügbar? sonst eigene 200-Zeilen-Variante), Filter je Kantenart.
- **Personenseite** (neu, klein): Name, Geburtsjahr, Rollen je Firma.
- **Chat-Tools:** `company_shareholders(companyId)` (Liste plus Stand),
  `company_network(companyId, tiefe)` (Knoten und Kanten, textuell),
  `company_shareholders_refresh` (Job einreihen, confirmAction), Chip
  „Verflechtungen (n Firmen)“ im Firmenprofil-Kontext; Statuswächter meldet
  neue Gesellschafter bei Pool-Firmen als Alert „Gesellschafterwechsel“.
- Fähigkeitsgruppe „verflechtungen“ für die Chat-Vorschläge.

## 6. Yup-Schema des LLM-Ergebnisses (Kern)

```
{ firma: { name, gericht, art, nummer }, listeDatum, stammkapitalEur,
  gesellschafter: [ { typ: PERSON|FIRMA, name, geburtsdatum?, wohnort?,
    registerGericht?, registerArt?, registerNummer?, anteileNummern,
    nennbetragEur, prozent, veraenderung?, konfidenz } ],
  hinweise: [string] }
```
Plausibilitäten: Summe Nennbeträge = Stammkapital (± 1 %), Summe Prozent
≈ 100, Geburtsdatum vor 1900 oder in der Zukunft → Zeile als unsicher.

## 6a. Qualitätsfilter („lieber keine Daten als Schrottdaten“)

Jede Liste durchläuft nach der Strukturierung diese Prüfungen; scheitert
eine harte, wird die **ganze Liste** als `ergebnis: UNSICHER` abgelegt
(Rohtext bleibt zur Nachsicht), es entstehen keine Shareholding-Zeilen:

Harte Regeln (Liste verwerfen):
- Firma stimmt: Registerangabe im Kopf (Gericht, Art, Nummer) muss zur
  angefragten companyId passen, sonst falsches Dokument.
- Summen: Nennbeträge addieren sich auf das Stammkapital (± 1 %), Prozent
  auf 100 (± 1 Punkt); fehlt das Stammkapital, muss die Prozentsumme passen.
- Jeder Gesellschafter hat Typ, Namen und mindestens eine Mengenangabe
  (Nennbetrag oder Prozent).
- Geburtsdaten zwischen 1900 und heute minus 14 Jahre; Prozent zwischen 0
  und 100; Nennbeträge > 0 und Vielfache von 1 EUR (Cent nur bei alten
  DM-Umstellungen, dann Hinweis).
- Firmen-Gesellschafter: Registerangabe muss sich zu einer companyId
  auflösen lassen (Gericht im Portal-Select, Nummer vorhanden) oder die
  Firma wird als `gesellschafterFirmaText` ohne Kante gespeichert; eine
  Kante gibt es nur mit aufgelöster companyId.
- Modell-Konfidenz je Zeile ≥ 0,7; darunter Zeile streichen, Summe neu
  prüfen.

Weiche Regeln (Zeile markieren, App zeigt „unsicher“):
- Namen ohne Vor- und Nachname, Namen mit Ziffern, Wohnort gleich
  Namensbestandteil, Datum nur mit Monat.
- OCR ohne Textebene und Konfidenz unter 0,85.

Zweite Meinung: Bei UNSICHER wird einmal mit strengerem Prompt (nur Bild,
Zeilenweise) wiederholt; stimmen beide Läufe in Namen und Summen überein,
gilt die Liste, sonst bleibt sie UNSICHER. Ein Zähler je Notar-Layout hilft
später, wiederkehrende Fehlermuster zu erkennen.

## 6b. Abschaltbar auf Organisationsebene

Neues Org-Feature `verflechtungen` (ORG_FEATURES, Feature-Policy wie
`stammdaten.mithelfen`): abgeschaltet heißt kein Reiter, keine Chat-Tools,
keine `gesellschafter`-Jobs aus dem Pool dieser Organisation, keine
Meldungen. Gesperrtes wird komplett ausgeblendet (Regel „Gesperrte UI
ausblenden“). Zusätzlich ein Betreiber-Schalter im Gateway
(`VERFLECHTUNGEN_DISABLED=1`), der die Job-Erzeugung global stoppt.

## 7. Schritte und Aufwand

| Schritt | Inhalt | Aufwand |
|---|---|---|
| V0 | Notebook (dieser Stand): DK-Weg, Formate, OCR, Beispiele | erledigt |
| V1 | master-data: Tabellen Shareholding, ShareholderListCheck, ShareholderListDocument, Person, PersonRole; interne Routen; Yup und Qualitätsfilter | **erledigt 2026-09-16** (Migration `20260916100000_verflechtungen`, 41 Tests, Deploy offen) |
| V2 | structured-content: `gesellschafterliste()` im Handelsregister-Webdriver, Dokumentprüfung (Magic Bytes, ZIP im Speicher), Tests | **erledigt 2026-09-16** (structured-content 5d0ac71) |
| V3 | LLM-Auswertung im Producer mit dem Modell des Nutzers (PDF/TIFF als Bild, Textebene, Yup, Qualitätsfilter), Persist-Ereignis, Gateway-Binding mit Feature-Gate, Desktop-Flag `AVA_VERFLECHTUNGEN` | **erledigt 2026-09-16** (Ende-zu-Ende-Test mit echter Firma offen) |
| V4 | Gateway/master-data: Firmen-Gesellschafter auflösen, fehlende Firmen per Register-Refresh anlegen, structured-content-Trigger je Kontext mit Besuchsliste und Notbremse (ohne LLM) | **erledigt 2026-09-16** (Gateway `lib/verflechtungen.ts`, master-data `/internal/verflechtungen/anstossen`, structured-content Marker; Deploy und Ende-zu-Ende-Test offen) |
| V5 | Geschäftsführer aus structured-content in Person/PersonRole spiegeln; Adress-Schlüssel für DE aus structured-content | 1 Tag |
| V6 | App: Reiter Verflechtungen mit Netzgrafik, Gesellschaftertabelle, Personenseite | 3 Tage |
| V7 | Chat-Tools, Statuswächter „Gesellschafterwechsel“, Fähigkeitsgruppe, Org-Feature `verflechtungen` und Betreiber-Schalter | 1,5 Tage |

## 8. Entscheidungen (2026-09-16)

1. **Download-Ausnahme:** bestätigt. Für die Gesellschafterlisten gilt
   dieselbe Freigabe wie für die bereits geladenen XML-Dateien des
   Registerportals: nur handelsregister.de, nur nach Klick auf den
   Download-Knopf, nur PDF/ZIP/TIFF bis 20 MB, temporäres Verzeichnis,
   Magic-Bytes-Prüfung, nie ausgeführt. Nachtrag in
   `docs/SICHERHEIT_HINTERGRUND_BROWSER.md` mit V2.
2. **OCR/LLM:** Remote-Modelle erlaubt (Nutzer-Schlüssel), RapidOCR lokal als
   Vorstufe; Standardmodell ohne BYOK offen.
3. **Geburtsdaten:** speichern (App zeigt Geburtsjahr, Chat nichts) und
   parallel einen SHA-256-Hash (`geburtsdatumHash` aus Nachname, Vorname,
   Geburtsdatum), damit das Klartextdatum später entfernt werden kann,
   ohne die Personenzusammenführung zu verlieren.
4. **Auslöser (Annahme, nicht widersprochen):** automatisch für jede Firma
   im Pool eines Nutzers alle 90 Tage, Rekursion automatisch eine Ebene;
   tiefer nur auf Wunsch in App oder Chat.
5. **Notbremsen:** Besuchsliste je Kontext ist die Hauptregel; dazu Tiefe 6
   und 200 Firmen je Kontext als Standard, **abschaltbar je Auslösung**
   (`ohneBremse: true` im Chat-Tool und in der App mit Bestätigung), damit
   auch sehr große Konstrukte vollständig verarbeitet werden.
6. **Originaldateien:** die neueste Liste je Firma als Beleg behalten
   (Tabelle `ShareholderListDocument`, Bytes in Postgres, SHA-256); bei
   Speicherproblemen später löschen.
