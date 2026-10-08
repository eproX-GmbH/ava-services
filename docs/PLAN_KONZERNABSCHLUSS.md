# Plan: Konzernabschlüsse verarbeiten (2026-10-08)

Auslöser: Strama-MPS Maschinenbau GmbH & Co. KG (HRA 1369, Straubing). Letzter
Einzel-„Jahresabschluss" 2006, seit 2010 nur noch Konzernabschlüsse plus
Befreiungsmeldungen nach §§ 264 Abs. 3, 264b HGB. AVA zeigt Zahlen von 2006.

## 1. Ist-Zustand

- `company-publication-webdriver.ts` wählt NUR Titel mit „Jahresabschluss"
  (v0.1.526, Entscheidung 2026-09-03: Konzernzahlen sagen nichts über die
  einzelne Gesellschaft). Konzernabschlüsse und § 264b-Hinweise werden gezählt
  und übersprungen. Höchstens 3 Publikationen je Lauf (MAX_PUB_LIMIT).
- Kennzahlen: Mitarbeiter per Regex („Zahl der Beschäftigten"), Umsatz /
  Ergebnis / Bilanzsumme aus Tabellen (Regex), Lagebericht-Extraktion (LLM)
  nur für das neueste Jahr (Lazy-Modus), Rohblöcke als Suchkorpus ans Gateway.
- Speicherung: `CompanyPublication` mit Schlüssel `(companyId, name, year)`;
  `name` = Titel der Veröffentlichung (z. B. „Konzernabschluss zum
  Geschäftsjahr vom 01.01.2023 bis zum 31.12.2023"). Beide Arten passen also
  ohne Schemaänderung nebeneinander in dieselbe Tabelle.
- Leser: Gateway `GET /companies/{id}/publications` (sortiert Jahr absteigend),
  Alerts-Neuheiten (Art `publication`), Desktop Finanzen-Reiter + Hero
  „Aktuelle Finanzen" (`latest` = höchstes Jahr), Tools `company_publications`
  und `company_get` (bereich finanzen), CRM-Export (Mitarbeiter aus dem
  neuesten Jahr), Alarm-Kandidaten (Beschäftigte), company-evaluation
  (Key-Figures).

## 2. Zielbild (Vorgaben Operator 2026-10-08)

1. **Kennzahlen bleiben Kennzahlen der Gesellschaft selbst.** Konsolidierte
   Konzernzahlen (Umsatz 299,5 Mio., 1.759 Mitarbeiter) werden NICHT als
   Umsatz/Mitarbeiter der Strama-MPS gespeichert. Aus dem Konzernabschluss
   werden nur Angaben zur Muttergesellschaft übernommen: Tabelle
   „Einzelergebnisse" (Umsatz 226,2 Mio., EBITDA, Jahresergebnis) und der Satz
   „Bei der Strama-MPS … waren 783 Mitarbeiter … tätig". Quelle wird als
   „aus Konzernabschluss 2023, Angaben zur Muttergesellschaft" ausgewiesen.
   Konsolidierte Summen tauchen höchstens als Kontextsatz im Lagebericht-
   Auszug auf („Konzern gesamt: 299,5 Mio. Umsatz, 1.759 Mitarbeiter"),
   nie in den numerischen Feldern.
2. **Tochtergesellschaften** (Name, Sitz, Land, Anteil, verbunden seit,
   Kerngeschäft) aus den Beteiligungstabellen → Reiter Verflechtungen, mit
   Stammdaten-Abgleich (Best Match) für deutsche Töchter. Dazu die
   Konzernmutter aus „Konzernzugehörigkeit" (Rösner-Mautby Holding).
3. **Geschäftsführung** aus dem Anhang („Geschäftsführer im Geschäftsjahr
   waren …", „ist … als Geschäftsführer ausgeschieden") als Bestätigung der
   Register-Daten: Ein-/Austritte mit Datum, Abgleich gegen die bekannten
   GF-Fakten, Abweichung als Alarm-Kandidat.
4. **Kosteneffizienz:** Keine Block-für-Block-Verarbeitung. Blöcke werden
   nach Kapitel geroutet (Überschriften liegen im Modell: z_titel, l_titel,
   b_teil, fette Absätze) und nur die Zielkapitel gehen an das Modell,
   Tabellen werden zuerst deterministisch gelesen.

## 2a. Block-Routing (gilt für Einzel- UND Konzernabschluss)

| Ziel | Auswahl (Regex auf Überschriftenpfad) | Verarbeitung |
|---|---|---|
| Kennzahlen Mutter | Tabellen unter „Einzelergebnisse", „Entwicklung der einzelnen Konzerngesellschaften"; Absätze mit „bei der <Firmenname>" + Zahl + „Mitarbeiter" | Tabelle deterministisch (Zeile = Firmenname der Mutter); Satz per Regex, ein kleiner LLM-Aufruf nur bei Mehrdeutigkeit |
| Töchter | Tabellen mit Spalten „Name und Sitz" + „Anteil" (Lagebericht 1.2, Anhang „Konsolidierungskreis"/„Anteilsbesitz") | Tabelle deterministisch, ein LLM-Aufruf je Tabelle zum Normalisieren (Land, Prozent, seit) |
| Konzernmutter | Absatz unter „Konzernzugehörigkeit" oder Befreiungsmeldung | Regex „in den Konzernabschluss der … einbezogen" |
| Geschäftsführung | Absätze unter „Geschäftsführung" / „Sonstige Angaben" | Regex-Liste + Sätze mit „ausgeschieden / bestellt / zum …"; ein LLM-Aufruf für die Datumszuordnung |
| Lagebericht-Kernaussagen | nur Kapitel „Geschäftsverlauf", „Ertrags-, Vermögens- und Finanzlage", „Gesamtaussage", „Prognose" (Konzern: zusätzlich „Entwicklung der einzelnen Konzerngesellschaften"); ausgeschlossen: Konjunktur/Branchenumfeld, nichtfinanzielle Indikatoren, Risikobericht-Boilerplate, Bilanzierungsgrundsätze, Bestätigungsvermerk | gebündelt in wenige LLM-Aufrufe mit Zeichenbudget (z. B. 24.000 Zeichen), statt heute „erste N Blöcke" |
| Bilanz/GuV-KPIs | Tabellen unter „Bilanz", „Gewinn- und Verlustrechnung" (Konzern: nur Kontext, nicht als Firmen-KPI) | Regex wie heute |

Erwartung: beim Strama-Konzernabschluss statt ~1.300 Blöcken rund 25 bis 40
ausgewählte Blöcke und 4 bis 6 Modellaufrufe. Dieselbe Routing-Logik senkt auch
die Kosten der Einzelabschlüsse.

## 3. Umsetzung

### K1 Producer: Auswahl und Kennzeichnung (company-publication)

- Auswahl: Titel mit `Jahresabschluss`, `Konzernabschluss`, `Jahresfinanzbericht`
  oder `Konzernjahresabschluss`; Befreiungsmeldungen weiter übersprungen.
- Je Art höchstens 3 neueste Publikationen (statt 3 insgesamt), Reihenfolge
  wie im Register (neueste zuerst).
- `art` je Publikation: `konzern`, wenn Titel oder Dokumentüberschrift
  „Konzern" enthält, sonst `einzel`. Wird im Persist-Event mitgeschickt
  (optionales Feld, alte Producer bleiben kompatibel).
- Block-Routing nach Abschnitt 2a (neues Modul `block-router.ts`, Tests mit
  den Strama-Dokumenten 2006 und 2023 als Fixtures).
- Konzernabschluss: Kennzahlen NUR aus den Mutter-Angaben; `employeeCount`
  und Umsatz aus konsolidierten Tabellen werden verworfen. Fehlen Mutter-
  Angaben, bleibt die Zeile ohne Zahlen (nur Lagebericht-Auszug + Töchter).
- Lagebericht-Extraktion: für das neueste Einzeljahr und das neueste
  Konzernjahr (falls neuer), aber nur über die gerouteten Kapitel.
- Neue Ausgaben im Persist-Event (optional, abwärtskompatibel):
  `toechter[]`, `konzernmutter`, `geschaeftsfuehrung[]` (Name, Rolle,
  eintritt/austritt), `hinweise[]`.
- Befreiungsmeldung: Titel und Datum ins Persist-Event als `hinweise`
  (Liste), damit das Gateway den Konzernbezug speichern kann.

### K2 Gateway: Speichern und Lesen (db-gateway)

- `applyPublications`: `art` aus dem Event, sonst aus `name` abgeleitet
  (`/Konzern/i`). Speicherung ohne Schemaänderung: `art` wird beim Lesen aus
  `name` abgeleitet; optional später Spalte, wenn Filter nötig.
- `GET /publications`: jedes Item bekommt `art: "einzel" | "konzern"`;
  Sortierung Jahr absteigend, bei gleichem Jahr Einzel vor Konzern.
- Alerts-Neuheiten: Text nennt „Konzernabschluss 2023" statt „Jahresabschluss".
- Konzernzugehörigkeit (aus Befreiungsmeldung oder Konzernanhang) als
  Firmen-Fakt `konzernmutter` (Name, Ort) im Kontakt-/Profil-Datenmodell;
  wird im Profil angezeigt.

### K3 Desktop: Anzeige und Werkzeuge

- Finanzen-Reiter: Zeitreihen je Art (Mitarbeiter Einzel / Konzern), Jahres-
  tabelle mit Spalte „Art"; Lagebericht-Karten mit Badge „Konzern".
- Hero „Aktuelle Finanzen": neuestes Einzeljahr; ist der Konzern neuer,
  zusätzlich eine Zeile „Konzern 2023: 1.759 Mitarbeiter, 299,5 Mio. Umsatz"
  mit Erklärung.
- `company_publications` / `company_get` bereich finanzen: Feld `art` und
  Hinweis im Tool-Text („Konzernzahlen sind konsolidiert, nicht die der
  einzelnen Gesellschaft; nenne das").
- CRM-Export, Alarm-Kandidaten, company-evaluation: Mitarbeiter/Umsatz
  bevorzugt aus dem neuesten Einzeljahr; Konzern nur als Rückfall mit
  Kennzeichnung.

### K4 Töchter, Konzernmutter, Geschäftsführung (Gateway + App)

- Neue Tabelle `CompanyBeteiligung` in ava_company_publication (lazy
  CREATE TABLE IF NOT EXISTS wie PublicationBlock; Freigabe vor Deploy):
  companyId, name, sitz, land, anteilProzent, verbundenSeit, kerngeschaeft,
  quelle (Titel + Jahr), matchCompanyId/matchStufe (Best Match wie im
  Kunden-Reiter, nur deutsche Töchter).
- Konzernmutter als Firmen-Fakt (Name, Ort, Quelle) im Profil.
- Geschäftsführung: Abgleich gegen GF-Fakten; neue Namen oder Austritte mit
  Datum → ProfileChangeEvent „laut Konzernabschluss 2023" (Erst-Crawl-Regel
  gilt, Zeitbezug 180 Tage).
- Reiter Verflechtungen: Abschnitt „Tochtergesellschaften laut
  Konzernabschluss <Jahr>" mit Übernehmen-Knopf; Chat `company_get`
  bereich verflechtungen liefert sie mit.

## 4. Kosten und Risiken

- Konzernabschlüsse sind 3- bis 5-mal länger; der Lagebericht-Lauf trifft
  nur das neueste Konzernjahr (eine LLM-Verarbeitung mehr je Firma).
- Firmen mit beiden Reihen erzeugen doppelte Zeilen je Jahr; alle Leser, die
  „neuestes Jahr" nehmen, müssen nach Art unterscheiden (K3 deckt die
  bekannten ab).
- Rohblöcke der Konzernabschlüsse vergrößern den Suchkorpus (PublicationBlock);
  Disk des Clusters beobachten (10 GB).

## 5. Stand

- **K1 umgesetzt (2026-10-08, company-publication 22fe0d0):** DOM-Walker mit
  Ueberschriftenpfad, `block-router.ts` (Routing, Pakete, Mutter-Kennzahlen),
  Konzernauswahl je Art bis 3, `art` im Ergebnis/Persist-Event, Lagebericht des
  neuesten Konzernjahres mit Konzern-Hinweis. Tests: `block-router.test.ts`
  (lokal via ts-jest mit `diagnostics: false`, da @types/jest im Submodul fehlt).
- **K2/K3 umgesetzt:** Gateway liefert `art` (aus dem Titel), Einzel vor
  Konzern bei gleichem Jahr; App zeigt Badge „Konzernabschluss · Kennzahlen
  der Muttergesellschaft", Mutter-Umsatz auf der Jahreskarte; Chat-Tool
  `company_publications` mit `art` und Hinweis; Alarm-Zusammenfassung benennt
  Konzernabschluss.
- **K1b umgesetzt (company-publication 6a807f0, v0.1.776):** Bloecke werden vor dem
  Routing lokal eingebettet (Vektoren fliessen in den Suchkorpus weiter);
  semantische Nachsuche je Thema (Prototyp-Saetze, Kosinus, k je Thema,
  Mindestaehnlichkeit 0,45) ergaenzt die Ueberschriften-Treffer unter dem
  gleichen Budget; das Log nennt die Anteile beider Quellen. Ohne Embedder
  bleibt es beim Ueberschriften-Routing.
- **K4 umgesetzt (2026-10-08, v0.1.777):** Producer `konzern-angaben.ts`
  (deterministisch, kein Modellaufruf): Toechter aus Beteiligungstabellen
  (Name/Sitz/Land/Anteil/seit/Kerngeschaeft, Mutterzeile faellt weg),
  Konzernmutter aus dem Satz „in den Konzernabschluss der … einbezogen",
  Geschaeftsfuehrung aus Liste + Wechselsaetzen (Titel/Anreden entfernt,
  Status amtierend|ausgeschieden|bestellt mit Datum); Feld `konzern` im
  Ergebnis/Persist-Event. Gateway `lib/konzern-angaben.ts`: lazy Tabellen
  `CompanyBeteiligung` (richtung tochter|mutter, Stufe-0-Direkttreffer nur
  fuer deutsche Toechter, kein Elasticsearch im Persist-Pfad) und
  `CompanyKonzernGeschaeftsfuehrer` in ava_company_publication, Replace je
  Firma+Quelle; GF-Abgleich gegen ManagingDirector → ProfileChangeEvent
  kind `managing-directors:konzernabschluss <Jahr>` nur mit Registerbestand
  und Zeitbezug ≤ 180 Tage. Route `GET /v1/companies/{id}/konzern-angaben`
  (ohne Org-Feature, oeffentliche Daten). App: Panel „Laut Konzernabschluss
  <Jahr>" im Reiter Verflechtungen (Konzernmutter, Toechter-Tabelle mit
  Stammdaten-Treffer und Uebernehmen, GF-Liste); `company_get` bereich
  `konzern`; Heartbeat formuliert Abweichungen „laut Konzernabschluss …
  bitte im Register gegenpruefen". Abweichung vom Plan: Konzernmutter liegt
  in derselben Tabelle (richtung mutter) statt als Firmen-Fakt im Profil.
- **Offen:** Live-Test mit
  Strama-MPS nach Release (Neuverarbeitung der Publikationen; Log-Zeilen
  "Semantische Nachsuche" und "Geroutete Analyse" pruefen, Schwelle 0,45 ggf.
  nachziehen).

## 6. Reihenfolge

1. K1 Block-Router + Auswahl + Mutter-Kennzahlen (Producer, lokal testbar
   mit den Strama-Fixtures) → Release.
2. K2/K3 Art-Kennzeichnung, Anzeige, Tools → gleiches Release.
3. K4 Töchter/Konzernmutter/GF mit neuer Tabelle → zweites Release nach
   Freigabe der Schemaänderung.
