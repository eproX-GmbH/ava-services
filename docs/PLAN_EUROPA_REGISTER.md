# Plan: Weitere europäische Register (Skandinavien zuerst)

Stand 2026-10-29. Anlass: Hennings Bewertung „AVA European Company Data
Strategy V2“ (27.10.2026, Tier 1 bis 3) und ein Interessent mit Sales-Strategie
2030, der in Skandinavien wachsen will. Fragen: Was kostet es, Tier 1 und 2
grundsätzlich zu integrieren, und wie schnell wären die skandinavischen Länder
in AVA?

## 1. Was wir heute haben und was ein Land kostet

Vier Länder laufen über dieselbe Register-Delta-Queue: Deutschland (Portal mit
Browser), Österreich (JustizOnline), UK (Companies House Bulk plus Firmenseite),
Schweiz (Zefix plus LINDAS, seit 24.10.). Je Land eine Fly-Maschine (rund 3 Euro
im Monat), Land als Präfix in der Firmen-ID, `country` an jeder Zeile, Filter in
Desktop, app.ava.bi und admin.ava.bi, Radar mit Ortsgraph aus GeoNames.

Die Schweiz ist der Referenzwert für ein Land mit offener Schnittstelle:

| Baustein | Aufwand Schweiz |
|---|---|
| Zugang (Zefix-Konto beantragen) | Wochen Wartezeit, kein Entwicklungsaufwand |
| Adapter im Register-Worker (Erstabzug, Tagesdelta, Detail je Firma) | 1 Tag |
| Gateway (Treffer-Abbildung, Job-Arten, Cron, Anforderung beim Import) | 0,5 Tage |
| Länderfilter und Texte in drei Oberflächen, Radar (Ortsgraph, Suchprofil) | 1 Tag |
| Erstabzug 800.000 Firmen | 10 Stunden Laufzeit |

Ein weiteres Land mit offener API und Massendaten kostet also **2 bis 3
Entwicklungstage** plus Laufzeit des Erstabzugs. Dazu kommt einmalig etwa eine
Woche, um die noch länderspezifischen Reste zu verallgemeinern (Sprache des
Radars je Land, Rechtsformen-Tabellen, Adressformate, Prompt-Hinweise), damit
das fünfte Land nicht mehr kostet als das vierte.

## 2. Skandinavien konkret (geprüft am 29.10.2026)

| Land | Zugang | Bestand | Delta | Personen/Rollen | Jahresabschlüsse | Aufwand |
|---|---|---|---|---|---|---|
| Norwegen | Brønnøysundregistrene, offene REST-API ohne Schlüssel, geprüft (Einzelabruf, Änderungsendpunkt `oppdateringer`, Gesamtdownload 12 MB gz) | rund 1,1 Mio. Einheiten | täglich über Änderungs-IDs | eigener Rollen-Endpunkt, offen | Regnskapsregisteret offen | 2 Tage |
| Finnland | PRH Open Data v3, offene REST-API, geprüft (Suche liefert Namen mit Historie, Adressen, Branchen) | rund 0,7 Mio. | Abfrage nach Änderungsdatum | Vertretungsberechtigte im Datensatz | PRH Abschlüsse offen | 2 Tage |
| Dänemark | CVR über Virk, System-zu-System-Zugang (Elasticsearch) kostenlos, aber Antrag bei Erhvervsstyrelsen; ohne Zugang nur Drittanbieter (cvrapi.dk, geprüft, nicht für Massendaten) | rund 0,8 Mio. Firmen plus Betriebsstätten | Änderungsfeed im System-zu-System-Zugang | Beteiligte (Deltagere) enthalten | XBRL-Abschlüsse offen | 2 Tage nach Zugang, Antrag 1 bis 3 Wochen |
| Schweden | Bolagsverket „Värdefulla datamängder“ (kostenlos, Registrierung), SCB Företagsregistret kostenpflichtig; Endpunkte ohne Schlüssel nicht erreichbar | rund 1,7 Mio. | Änderungsliste in der Bolagsverket-API | nicht in der kostenlosen Basis | kostenpflichtig | 3 Tage, Registrierung vorab |

Zeitplan, wenn wir morgen anfangen: Norwegen und Finnland in der ersten Woche
produktiv (Erstabzug inklusive), Dänemark und Schweden sobald die Zugänge da
sind, zusammen etwa **drei Wochen Kalenderzeit bei acht bis zehn
Entwicklungstagen**. Anträge für Dänemark und Schweden sollten sofort gestellt
werden, sie sind der kritische Pfad.

Für das Verkaufsgespräch: Norwegen und Finnland lassen sich binnen einer Woche
als „in AVA verfügbar“ zeigen, Dänemark und Schweden als „in Umsetzung, Zugang
beantragt“.

## 3. Tier 1 und 2 komplett

| Welle | Länder | Entwicklungstage | Hinweis |
|---|---|---|---|
| A Skandinavien plus Estland | NO, FI, DK, SE, EE | 10 bis 12 | Estland: Open Data offen, Echtzeit braucht Vertrag |
| B Westeuropa | FR, NL, IE, BE | 10 bis 12 | NL (KVK) und BE kostenpflichtig je Abfrage, FR (INPI) kostenlos |
| C Osteuropa | PL, CZ, SI, LV, LT, SK | 12 bis 15 | je Land ein eigenes Format, Sprachen für Radar und Prompts |
| D Italien | IT | 3 bis 5 | InfoCamere vertraglich, vorher klären |
| Verallgemeinerung | alle | 5 | Sprache je Land, Rechtsformen, Adressformate, Registeramt-Bezeichnungen |

Zusammen rund **40 bis 50 Entwicklungstage**, also zwei bis drei Monate neben
dem Tagesgeschäft. Das ist Mechanik, kein Risiko; das Risiko liegt in den
Zugängen (Verträge, Schlüssel, Nutzungsbedingungen) und in der Datenbank.

## 4. Was es im Betrieb kostet

- **Maschinen:** je Land oder Ländergruppe eine Fly-Maschine, rund 3 Euro im
  Monat. Für Tier 1 und 2 lassen sich Länder mit kleinem Bestand auf einer
  Maschine bündeln, grob 20 bis 30 Euro im Monat zusätzlich.
- **Datenbank:** heute rund 7,9 Mio. Firmen (DE, AT, UK, CH). Tier 1 und 2
  bringen etwa 15 bis 20 Mio. weitere Zeilen plus Historie. Die eine geteilte
  Fly-Postgres ist schon heute der empfindlichste Teil (OOM beim Indexaufbau,
  Verbindungsbudget 100). Realistisch braucht der Vollausbau die nächste
  Größenstufe des Clusters oder eine eigene Datenbank für Stammdaten, grob
  **100 bis 200 Euro im Monat** mehr. Das ist der größte Posten.
- **Suchindex:** Elastic Serverless rechnet die Ingest-Laufzeit; der monatliche
  Sammelabgleich wächst mit dem Bestand, grob **30 bis 60 Euro im Monat**
  mehr bei Tier 1 und 2.
- **Registerzugänge:** Norwegen, Finnland, Dänemark, Estland (Open Data),
  Frankreich, Polen, Tschechien, Slowenien, Lettland, Litauen kostenlos. Schweden
  (SCB) nur mit Abo, Niederlande und Belgien je Abfrage, Italien vertraglich.
  Für Skandinavien reicht die kostenlose Basis.
- **Geo und Suche:** GeoNames hat alle Länder, Valueserp braucht je Land ein
  Suchprofil (google.no, google.se, …), Kosten wie heute je Abfrage.

Kurz: Skandinavien kostet im Betrieb fast nichts zusätzlich (eine Maschine,
ein paar Gigabyte). Teuer wird erst der Vollausbau durch die Datenbank.

## 5. Was sich an AVA selbst ändern müsste

- Sprache je Land im Radar und in den Prompts (heute DE und EN).
- Rechtsformen und Registerbezeichnungen je Land in einer Tabelle statt im
  Code, damit Chip, Kennung und Prompt-Hinweise aus Daten kommen.
- Strukturierter Inhalt: Norwegen, Finnland und Dänemark liefern Personen und
  Abschlüsse offen, das ist mehr als die Schweiz. Dafür braucht es die
  Länderweiche im Jahresabschluss-Pfad (heute Bundesanzeiger-spezifisch).
- Deutschland bleibt, wie es ist: Hennings Tier 3 für DE bezieht sich auf das
  Fehlen einer offenen Massen-API, die AVA über Portal und Nummernfront längst
  ersetzt hat.

## 6. Empfehlung

1. Anträge sofort: Dänemark (CVR System-zu-System) und Schweden (Bolagsverket).
2. Norwegen und Finnland als Welle A bauen, mit der Verallgemeinerung
   (Sprache, Rechtsformen) gleich mit.
3. Weitere Wellen nur mit zahlendem Anlass, so wie Henning es selbst sagt.
