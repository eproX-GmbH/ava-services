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

## 2. Zielbild

1. Konzernabschlüsse werden verarbeitet, aber als **Konzernzahlen**
   gekennzeichnet und nie mit Einzelzahlen vermischt.
2. Je Firma gibt es zwei Zeitreihen: Einzelgesellschaft und Konzern. Die App
   zeigt die jeweils neueste beider Reihen; ist der Konzern neuer, steht er
   oben mit dem Hinweis „Konzern (konsolidiert, inkl. Töchter)".
3. Aus dem Konzernlagebericht werden zusätzlich die **Einzelergebnisse der
   Muttergesellschaft** gezogen, wenn eine Tabelle sie nennt (Strama: 226,2
   Mio. Umsatz, 783 Mitarbeiter in Straubing) — als Kennzahlen mit Kategorie
   `sonstiges` und Präfix „Muttergesellschaft:".
4. Befreiungsmeldungen (§ 264 Abs. 3 / 264b HGB) liefern den Hinweis „in den
   Konzernabschluss von X einbezogen" (der Mutterkonzern steht im Anhang unter
   „Konzernzugehörigkeit"); Zahlen enthalten sie nicht.
5. Beteiligungstabellen (Name, Sitz, Anteil) aus dem Konzernanhang gehen als
   eigene Stufe an die Verflechtungen (docs/PLAN_VERFLECHTUNGEN.md).

## 3. Umsetzung

### K1 Producer: Auswahl und Kennzeichnung (company-publication)

- Auswahl: Titel mit `Jahresabschluss`, `Konzernabschluss`, `Jahresfinanzbericht`
  oder `Konzernjahresabschluss`; Befreiungsmeldungen weiter übersprungen.
- Je Art höchstens 3 neueste Publikationen (statt 3 insgesamt), Reihenfolge
  wie im Register (neueste zuerst).
- `art` je Publikation: `konzern`, wenn Titel oder Dokumentüberschrift
  „Konzern" enthält, sonst `einzel`. Wird im Persist-Event mitgeschickt
  (optionales Feld, alte Producer bleiben kompatibel).
- Lagebericht-Extraktion (LLM): für das neueste Einzeljahr wie bisher UND für
  das neueste Konzernjahr, falls es neuer ist als das Einzeljahr. Prompt
  bekommt den Hinweis, dass Konzernzahlen konsolidiert sind und Einzelergebnisse
  der Muttergesellschaft gesondert als KPIs mit Präfix „Muttergesellschaft:"
  auszuweisen sind.
- Mitarbeiter-Regex um „Mitarbeiter" / „Arbeitnehmer" in Tabellen mit
  Jahresspalte erweitern (Konzernanhang Strama: Zeile „Mitarbeiter 1.596").
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

### K4 Beteiligungen (später, eigene Freigabe)

- Tabellen „Name und Sitz / Anteil am Kapital" aus Konzernlagebericht und
  -anhang per LLM in `{name, sitz, land, anteilProzent, verbundenSeit}`;
  Abgleich gegen Stammdaten (Best Match wie im Kunden-Reiter); Speicherung in
  einer neuen Tabelle (Schemaänderung → Freigabe) und Anzeige im Reiter
  Verflechtungen.

## 4. Kosten und Risiken

- Konzernabschlüsse sind 3- bis 5-mal länger; der Lagebericht-Lauf trifft
  nur das neueste Konzernjahr (eine LLM-Verarbeitung mehr je Firma).
- Firmen mit beiden Reihen erzeugen doppelte Zeilen je Jahr; alle Leser, die
  „neuestes Jahr" nehmen, müssen nach Art unterscheiden (K3 deckt die
  bekannten ab).
- Rohblöcke der Konzernabschlüsse vergrößern den Suchkorpus (PublicationBlock);
  Disk des Clusters beobachten (10 GB).

## 5. Rückfragen

1. Reihenfolge: K1–K3 in einem Release (Producer-Submodul + Gateway + App)?
2. Befreiungsmeldung als Fakt `konzernmutter`: gewünscht oder vorerst nur
   im Lagebericht-Text?
3. K4 Beteiligungen: direkt mitplanen oder nach K1–K3?
