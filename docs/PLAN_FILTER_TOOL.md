# Bestandsaufnahme: großes Filter-Tool im Chat

Stand 2026-09-17. Frage des Betreibers: Kann der Chat-Agent ein Werkzeug
bekommen, mit dem er Firmen dynamisch über mehrere Datenbanken hinweg filtert
(„Firmen, gegründet zwischen 1990 und 2000, mit Website, in NRW")?

Kurze Antwort: ja, und einfacher als erwartet. Der Grund ist das Mengengerüst.

## 1. Mengengerüst (gemessen am 2026-09-17)

| Datenbank | Tabelle | Firmen |
|---|---|---|
| master-data | GermanCompany | 5.181.223 (DE 1.837.150, UK 3.202.980, AT 141.093) |
| structured-content | StructuredContent | 37.752 (davon 28.131 mit Gründungsjahr) |
| company-publication | CompanyPublication | 1.737 |
| company-evaluation | EvaluationData | 1.042 |
| website | CompanySerp / Website | 1.023 / 821 |
| company-profile | CompanyProfile | 815 |
| company-contact | Company | 135 |

Daraus folgt die zentrale Unterscheidung. Es gibt zwei Klassen von Filtern, und
sie verhalten sich völlig verschieden:

- **Bestandsfilter** auf master-data (Land, Bundesland, Rechtsform, Ort,
  Registerstatus, Insolvenzstatus, Branchenschlüssel). Sie treffen Millionen
  Zeilen. Sie gehören in SQL in master-data und brauchen Indizes.
- **Merkmalsfilter** auf allem, was ein Producer angereichert hat
  (Gründungsjahr, Stammkapital, Website, Bewertung, Mitarbeiterzahl,
  Kennzahlen, Kontakte, Schlagwörter). Sie treffen höchstens 38.000 Zeilen, die
  meisten unter 2.000. Diese Datenmengen sind so klein, dass jede Kombination
  davon ohne Weiteres im Gateway zusammengeführt werden kann.

Die Angst vor einem verteilten Join ist also unbegründet, solange mindestens ein
Merkmalsfilter gesetzt ist. Er wirkt als Mengenbegrenzer.

## 2. Was heute existiert

- **251 Chat-Werkzeuge** (`docs/TOOLS.md`), keines davon filtert Firmenlisten
  nach Feldern. `company_search` kann Namen und seit heute das Gründungsjahr.
  `company_tech_stack` filtert innerhalb einer mitgelieferten Liste von
  höchstens 300 Firmen.
- **Kein Prädikat-Format.** `docs/DESKTOP_DATA_FLOW.md` sieht für den
  Firmen-Listenweg einen Parameter `filter` vor. Er wurde nie gebaut.
- **Der Desktop erreicht Daten ausschließlich über das Gateway.** Kein Werkzeug
  spricht direkt mit einer Cloud-Datenbank.
- **Das Gateway erreicht sechs Producer-Datenbanken direkt** über
  `getProducerPool`, master-data dagegen nur über HTTP.
- **Mandantengrenze:** Firmendaten sind bewusst geteilter Bestand, `companyId`
  ist nicht mandantengebunden. Producer-Tabellen haben keine Mandantenspalte.
  Die Grenze entsteht allein über die Auswahl der Firmen.
- **Vorbild für die Paginierung** gab es bisher keins. Die Matrix-Ansicht
  kombiniert zwar zwei Datenbanken, aber die zweite reichert nur an und filtert
  nie, deshalb bleibt die Seitengröße dort stabil.

## 3. Das gelöste Paginierungsproblem

Der heute gebaute Gründungsjahr-Filter
(`services/db-gateway/src/lib/companies-gruendungsjahr.ts`) zeigt das Muster,
das sich verallgemeinern lässt:

1. Die **führende Datenbank** ist die mit dem schärfsten Filter, also die
   kleinste. Dort werden Filter, Sortierung, Zählung und Blättern ausgeführt.
2. Die höchstens 200 Firmen der ausgelieferten Seite werden danach angereichert
   (`/internal/companies/by-ids` in master-data).

Weil Schritt 2 nie Zeilen entfernt, bleibt die Seitengröße korrekt. Für ein
allgemeines Filter-Tool heißt das: Der Filterausdruck muss eine führende
Datenbank bestimmen können, und alle weiteren Bedingungen müssen entweder in
dieselbe Datenbank gehören oder als Schnittmenge von Firmen-Kennungen
vorgeschaltet werden.

## 4. Drei Umsetzungswege

**A. Nur Bestandsfilter (klein, schnell).** Ein Werkzeug, das die vorhandenen
master-data-Felder als Prädikate durchreicht. Aufwand gering. Nachteil: genau
die interessanten Merkmale (Gründungsjahr, Website, Kennzahlen) fehlen, weil sie
nicht in master-data liegen. Braucht Indizes auf Bundesland, Rechtsform und
Branchenschlüssel.

**B. Führende Datenbank, verallgemeinert (empfohlen).** Der Filterausdruck ist
eine Liste von Bedingungen, jede mit Feld, Vergleich und Wert. Das Gateway
ordnet jedes Feld seiner Datenbank zu, wählt die Datenbank mit den wenigsten
Zeilen als führend, führt dort Filter und Sortierung aus, bildet für Bedingungen
aus anderen Producer-Datenbanken vorab Kennungsmengen und schneidet sie. Am
Ende reichert master-data die Seite an. Bestandsbedingungen (Bundesland, Land)
werden bei kleiner Ergebnismenge nachgelagert über by-ids geprüft.
Aufwand mittel, kein Schemawechsel, keine Migration. Deckt alle heutigen
Merkmale ab.

**C. Merkmalsspiegel im Gateway (größter Wurf).** Eine Tabelle im Gateway, die
je Firma alle filterbaren Merkmale aus allen Datenbanken spiegelt, gepflegt bei
jedem Persist. Ein einziger SQL-Weg, beliebig kombinierbar, sauber paginierbar.
Aufwand hoch (Schema, Pflege an sechs Stellen, einmaliger Nachlauf über den
Bestand), dafür die einzige Variante, die auch dann noch trägt, wenn die
Producer-Datenbanken Millionen Zeilen haben. Heute wäre das verfrüht.

Empfehlung: **B**, mit dem heute gebauten Gründungsjahr-Weg als erstem Baustein.
C bleibt der Zielzustand, sobald die Producer-Datenbanken sechsstellig werden.

## 5. Offene Entscheidungen des Betreibers

1. **Reichweite.** Soll das Werkzeug den gesamten Bestand durchsuchen dürfen
   oder nur die Firmen des Mandanten? In den Vorgängen liegen heute 125 Firmen,
   im Bestand 5,2 Millionen. Technisch ist beides möglich, die Frage ist
   produktlich und datenschutzrechtlich, nicht technisch.
2. **Ausdrucksform.** Flache Liste von Bedingungen mit Und-Verknüpfung genügt
   für alles, was bisher gewünscht wurde. Oder-Verknüpfungen und Klammern
   verdoppeln den Aufwand. Vorschlag: flach beginnen.
3. **Obergrenze.** Wie viele Firmen darf ein Werkzeugaufruf höchstens
   zurückgeben? Die bestehenden Wege sind bei 300 Kennungen gedeckelt.
4. **Indizes.** Für Bestandsfilter fehlen Indizes auf Bundesland, Rechtsform und
   Branchenschlüssel. Ohne sie dauert ein Filter über 5,2 Millionen Zeilen
   spürbar.

## 6. Was heute schon gebaut wurde

Der Gründungsjahr-Filter ist umgesetzt und deckt den ersten Anwendungsfall ab:
aufsteigend, absteigend, von, bis und von bis, in der Firmensuche und im
Chat-Werkzeug `company_search`. Er dient zugleich als Referenz für Weg B.
