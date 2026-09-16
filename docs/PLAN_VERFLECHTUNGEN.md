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

1. **Job-Art `gesellschafter`** in der Register-Queue (Gateway), Payload
   `{ companyId, gericht, art, nummer, kontext }`. Läuft im Desktop
   „Mithelfen“ und im Fly-Worker `worker` (Browser), 4 bis 5 Portal-Abfragen
   je Job, damit im 60/h-Budget.
2. **Worker (Paket register-delta, `RegisterPortal.gesellschafterliste()`):**
   Suche, DK, Baum aufklappen, neuestes Blatt „Liste der Gesellschafter“,
   Format `pdf` wenn angeboten, sonst `zip` (TIFF), Download in ein
   temporäres Verzeichnis, sofort nach dem Lesen löschen. Ohne Knoten →
   Ergebnis `KEINE`. Metadaten (Aufnahme-Datum, Größe) mitgeben.
3. **Text gewinnen (lokal beim Worker):** PDF-Textebene per `pdf-parse`
   oder pdftotext; ohne Textebene Seiten rendern und OCR (RapidOCR-ONNX im
   Worker, Modell 15 MB, oder Tesseract wo vorhanden). Ergebnis: Rohtext je
   Seite plus Seitenbilder als PNG in Base64 für den nächsten Schritt.
4. **Strukturieren (LLM, entschieden 2026-09-16):** Remote-Modelle sind
   hier ausdrücklich erlaubt, also das konfigurierte Modell des Nutzers
   inklusive OpenAI/Codex über den eigenen Schlüssel; bevorzugt ein
   Vision-Modell mit Seitenbild plus OCR-Text, sonst Text allein. Prompt →
   JSON nach festem Schema (Yup-validiert, §6), danach der Qualitätsfilter
   (§6a). Beim Fly-Worker: Betreiber-Modell. Listen können deutlich
   komplexer sein als die vier Beispiele (Erbengemeinschaften,
   Treuhand, Teilanteile, Nießbrauch, Vorlisten); was der Filter nicht
   bestätigt, wird verworfen, nicht geraten.
5. **Gateway → master-data** `POST /internal/companies/shareholders`:
   Shareholding-Zeilen ersetzen den Stand der vorigen Liste (Historie bleibt
   über `listeDatum`), Firmen-Gesellschafter über die Registerangabe zur
   companyId auflösen (Original-Regel, Aliase wie beim Register-Delta),
   Personen zusammenführen (§3).
6. **Rekursion mit Besuchsliste:** Jede Firma unter den Gesellschaftern, die
   noch nicht im Bestand ist, wird angelegt (Refresh-Job über das
   Registerportal) und bekommt selbst einen `gesellschafter`-Job im selben
   **Verarbeitungskontext** (`kontext` = Ursprungs-companyId plus Datum).
   Besuchte companyIds je Kontext stehen im Gateway (`RegisterJob.payload`
   plus Tabelle `VerflechtungKontext(kontext, companyId, tiefe)`); eine
   schon besuchte Firma bekommt keinen weiteren Job. Damit enden Schleifen
   (A hält B, B hält A) und Doppelarbeit. Zusätzlich eine weiche
   Tiefengrenze (Vorschlag 6 Ebenen) und eine Kontextgrenze (Vorschlag 200
   Firmen) als Notbremse gegen Konzernbäume.
7. **Aufwärts:** Wer hält die Ausgangsfirma? Das steht nur in *ihrer* Liste
   (§5). Wer die Ausgangsfirma als Gesellschafter hat, weiß man erst, wenn
   deren Listen verarbeitet sind. Der Graph füllt sich also von unten nach
   oben mit jedem verarbeiteten Pool; die Suche „Firmen, an denen X
   beteiligt ist“ ist eine Abfrage über `gesellschafterCompanyId`.
8. **Aktualität:** wie Insolvenz je Pool-Firma alle 90 Tage prüfen, ob eine
   neuere Liste vorliegt (nur Baum lesen, 3 Abfragen); Register-
   bekanntmachungen zu „Liste der Gesellschafter“ gibt es nicht, aber
   Änderungen der Geschäftsführung kommen weiter über den Register-Refresh.

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
| V1 | master-data: Tabellen Shareholding, ShareholderListCheck, Person, PersonRole; interne Routen; Yup | 1,5 Tage |
| V2 | Paket: `gesellschafterliste()` im RegisterPortal (Download in Temp), Textgewinnung, OCR-Anbindung, Tests mit den vier Beispieldateien | 2 Tage |
| V3 | LLM-Strukturierung (Prompt, Schema, Plausibilitäten) im Worker; Desktop nutzt das Nutzer-Modell, Fly das Betreiber-Modell | 1,5 Tage |
| V4 | Gateway: Job-Art, Kontext mit Besuchsliste, Rekursion, Auflösung der Firmen-Gesellschafter, Anlage fehlender Firmen | 2 Tage |
| V5 | Geschäftsführer aus structured-content in Person/PersonRole spiegeln; Adress-Schlüssel für DE aus structured-content | 1 Tag |
| V6 | App: Reiter Verflechtungen mit Netzgrafik, Gesellschaftertabelle, Personenseite | 3 Tage |
| V7 | Chat-Tools, Statuswächter „Gesellschafterwechsel“, Fähigkeitsgruppe, Org-Feature `verflechtungen` und Betreiber-Schalter | 1,5 Tage |

## 8. Offene Entscheidungen (Rückfragen)

1. **Download-Sperre der Hintergrund-Browser.** Die Sicherheitsregel
   (`docs/SICHERHEIT_HINTERGRUND_BROWSER.md`) verbietet Downloads hart
   (`download_restrictions 3`). Für die Listen braucht der Portal-Browser
   eine **eng begrenzte Ausnahme**: nur Domain handelsregister.de, nur nach
   Klick auf den Download-Knopf der DK-Seite, nur in ein temporäres
   Verzeichnis, nur PDF/ZIP/TIFF bis 20 MB, ZIP nur mit Bilddateien, Datei
   nach dem Lesen gelöscht, nie ausgeführt. Vorschlag: eigener
   Chrome-Profilordner für diesen Job mit `download_restrictions 0` plus
   Prüfung von Dateityp (Magic Bytes) und Größe im Worker. Bitte
   bestätigen.
2. **OCR-Modell.** Entschieden: Remote-Modelle erlaubt (Nutzer-Schlüssel).
   Vorschlag bleibt RapidOCR-ONNX als lokale Vorstufe plus Vision-LLM;
   ohne Vision-Modell nur OCR-Text. Offen nur noch: Standardmodell für
   Nutzer ohne BYOK (lokales Ollama-Vision wie `qwen2.5vl`?).
3. **Geburtsdaten speichern?** Sie stehen in den Listen und sind der
   sicherste Schlüssel zur Personenzusammenführung. Vorschlag: speichern,
   in der App nur Geburtsjahr zeigen, im Chat gar nicht, Art.-14-Hinweis
   wie bei Kontakten. Alternativ nur Hash für die Zusammenführung.
4. **Rekursionsgrenzen:** Besuchsliste je Kontext (bestätigt), dazu
   Notbremse Tiefe 6 und 200 Firmen je Kontext?
5. **Wer löst Verarbeitung aus?** Vorschlag: automatisch für jede Firma im
   Pool eines Nutzers (Import, Suche-Übernahme), einmal je 90 Tage, plus
   „Jetzt prüfen“ in der App und im Chat. Kosten je Firma 4 bis 5
   Portalabfragen plus LLM-Aufruf; Rekursion nur Tiefe 1 automatisch,
   tiefer nur auf Wunsch?
6. **Bild-Aufbewahrung:** Original-PDF/TIFF nach der Verarbeitung löschen
   (Vorschlag) oder je Firma die letzte Liste als Beleg behalten
   (Speicher, Personendaten)?
