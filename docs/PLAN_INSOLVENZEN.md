# Plan: Insolvenzbekanntmachungen als Quelle (Insolvenz-Delta)

Stand 2026-09-15, Entwurf. Baut auf dem Register-Delta auf
(`docs/PLAN_STAMMDATEN_DELTA.md`): dieselbe Queue mit Lease, dieselben
Worker (Desktop „Mithelfen“, Fly-Fallback), dieselbe companyId-Regel.
Quelle: https://neu.insolvenzbekanntmachungen.de/ap/ (Betreiber: Ministerium
der Justiz NRW für alle Länder).

## 1. Befunde (Portal, 2026-09-15)

**Suchmaske** (`/ap/suche.jsf`, JSF, Formular `frm_suche`)
- Insolvenzgericht (Bundesland, Gericht), Datum der Veröffentlichung von/bis,
  Schuldner (Firma/Nachname, Vorname, Sitz, Wildcards `* + % #`),
  Aktenzeichen (Abteilung, Register AR/IE/IK/IN, laufende Nummer, Jahr),
  Gegenstand der Veröffentlichung (genau einer: Abweisungen mangels Masse,
  Entscheidungen im Restschuldbefreiungsverfahren, Entscheidungen im
  Verfahren, Entscheidungen nach Aufhebung, Eröffnungen, Sicherungsmaßnahmen,
  Sonstiges, Verteilungsverzeichnisse, überwachte Insolvenzpläne).
- **Registereintrag:** Registergericht (Select, 149 Gerichte inklusive
  historischer), Registerart (GnR, GsR, HRA, HRB, PR, VR), Registernummer
  (Textfeld `frm_suche:ir_registereintrag:itx_registernummer`; Selects
  `…:som_registergericht:mysom`, `…:som_registerart:mysom`). Die Abfrage
  „Hamburg, HRA, 90794“ lieferte exakt die drei Veröffentlichungen dieser
  Firma. Ohne Datum sucht das Portal standardmäßig die letzten zwei Wochen;
  für Firmenverfahren ist die gesamte Laufzeit suchbar, dazu Datum leeren
  oder weit setzen.

**Trefferliste** (`/ap/ergebnis.jsf`, Tabelle `tbl_ergebnis`)
- Je Veröffentlichung eine Zeile: Datum, aktuelles Aktenzeichen,
  Insolvenzgericht, Name/Bezeichnung, Sitz/Wohnsitz, Register als Text
  („Hamburg, HRA 90794“, leer bei Verbrauchern). Mehrere Zeilen je
  Aktenzeichen sind normal (mehrere Bekanntmachungen am selben Tag).
- Der Veröffentlichungstext wird je Zeile per JSF-AJAX geladen (Bild-Button
  `tbl_ergebnis:<i>:frm_detail:j_idtNNN`, `mojarra.ab(..., 'msgs
  frm_text:ihd_text')`) und in das versteckte Feld `frm_text:ihd_text`
  geschrieben, das die Seite in ein Popup kopiert. In der Testsitzung kam
  der Wert leer zurück (Sitzungsdialog „läuft ab“ parallel); im Notebook
  zu klären, ob ein frischer Suchlauf und die Kopfzeilen der AJAX-Anfrage
  reichen.
- Menge 14.09.2026 (Montag): 4.484 Zeilen, 2.801 Aktenzeichen, 346 Zeilen
  mit Registereintrag (Firmen). Grob 250 bis 400 Firmenzeilen je Werktag.

**Regeln des Portals**
- 1.000 Treffer je Suche, ausgenommen Suche über genau einen Tag.
- Firmenverfahren (ab 26.06.2018 eröffnet) sind über die gesamte Laufzeit
  uneingeschränkt suchbar; reine Verbraucherverfahren nur zwei Wochen.
- Löschung spätestens 6 Monate nach Aufhebung/Einstellung; sonstige
  Veröffentlichungen nach einem Monat. Was wir behalten wollen, müssen wir
  speichern.
- Sitzung 60 Minuten, keine Deep-Links, Session-Dialog nach Leerlauf.
- FAQ 15: „Eine Schnittstelle oder ein Webservice zum Herunterladen der
  Daten wird nicht angeboten. Abfragen sind nur als, ggf. automatisierter,
  Einzelabruf zulässig. Sinn der Insolvenzbekanntmachungen ist es, prüfen zu
  können, ob über das Vermögen einer konkreten Person ein Insolvenzverfahren
  eröffnet worden ist. Sinn ist es nicht, ohne konkreten Bezug sehen zu
  können, welche Insolvenzverfahren allgemein eröffnet wurden.“ Keine
  Zahl zu Abfragen je Stunde; wir übernehmen den Takt des Registerportals
  (60 je Stunde und IP) als Obergrenze.

**Gerichtsnamen** (Abgleich mit den 117 Registergerichten des Bestands)
- 106 identisch. 11 abweichende Schreibweisen: Berlin ↔ Berlin
  (Charlottenburg), Münster (Westfalen) ↔ Münster, Freiburg im Breisgau ↔
  Freiburg, Friedberg (Hessen) ↔ Friedberg, Königstein im Taunus ↔
  Königstein, Landau in der Pfalz ↔ Landau, Limburg a.d. Lahn ↔ Limburg,
  Ludwigshafen am Rhein ↔ Ludwigshafen a.Rhein (Ludwigshafen), Bad Homburg
  v.d. Höhe ↔ Bad Homburg v.d.H., Frankfurt (Oder) ↔ Frankfurt/Oder,
  Weiden i.d. OPf ↔ Weiden i. d. OPf.
- 30 historische Gerichte (Thüringen: Altenburg, Apolda, Arnstadt, Eisenach,
  Erfurt, Gera, Gotha, Greiz, Heilbad Heiligenstadt, Hildburghausen,
  Meiningen, Mühlhausen, Nordhausen, Pößneck, Rudolstadt, Sömmerda,
  Sondershausen, Sonneberg, Stadtroda, Weimar; Saarland: Merzig, Neunkirchen,
  Ottweiler, Saarlouis, St. Ingbert, St. Wendel, Völklingen, Wadern;
  Bad Salzungen, Jena-Zusatz). Die Register liegen heute bei Jena bzw.
  Saarbrücken (St. Ingbert und St. Wendel führt der Bestand als eigene
  Gerichte). Abbildung über eine Alias-Tabelle; Rest über Name plus Sitz als
  Verdachtstreffer, nie automatisch zugeordnet.

## 2. Entscheidung: welcher Abfragemodus

| Modus | Was | Aufwand | Bewertung |
|---|---|---|---|
| A „gezielt“ | Je bekannter Firma eine Abfrage über den Registereintrag | 1 Anfrage je Firma und Prüfung | Vom Portal ausdrücklich erlaubter Einzelabruf mit konkretem Bezug. Zuordnung per Konstruktion eindeutig. |
| B „Tagesliste“ | Eine Suche je Tag ohne Filter, alle Zeilen mit Registereintrag | 1 Anfrage je Tag | Technisch trivial und vollständig für alle 1,8 Mio. Firmen, aber genau der Fall, den FAQ 15 als nicht gewollt beschreibt. |

Empfehlung: **A als Regelbetrieb.** B nur als bewusste Betreiberentscheidung,
dann ausschließlich vom Fly-Worker, nie von Nutzerrechnern, und nur als
Auslöser für A (Tagesliste liefert companyIds, die gezielte Abfrage holt
Text und Kategorie). Die Entscheidung trifft der Betreiber, siehe
Abschnitt 8.

## 3. Zielbild

```
Insolvenzportal <-- Worker (Desktop "Mithelfen" oder Fly) <-- lease -- Gateway-Queue RegisterJob (art = insolvenz)
                        | Ergebnis: Veroeffentlichungen je companyId                    ^ Ersteller-Cron
                        v                                                               |
                  Gateway verarbeiteErgebnis --HMAC--> master-data InsolvencyEvent + GermanCompany.insolvencyStatus
                        |                                    |
                        v                                    v
              StructuredContentStale                  Elasticsearch (insolvencyStatus)
```

### 3.1 Job `insolvenz` (Modus A)

- Payload: `{ firmen: [{ companyId, gericht, art, nummer, zusatz, grund }], grund }`,
  Bündel zu 15 wie beim Refresh. Der Worker füllt Registergericht (über
  Alias), Registerart und Registernummer, leert das Datum (gesamte
  Laufzeit) und liest alle Zeilen der Trefferliste. Je Zeile zusätzlich
  den Veröffentlichungstext per AJAX (zweite Anfrage je Zeile; im Notebook
  messen, ob nötig oder ob die Kategorie aus dem Gegenstand-Filter reicht).
- Ergebnis je Firma: Liste `{ datum, aktenzeichen, insolvenzgericht, gegenstand, text }`
  oder leer (keine Veröffentlichung = kein bekanntes Verfahren).
- Wer wird geprüft (Ersteller-Cron):
  - Firmen im geteilten Pool (Profil, Kontakte, Vorgänge, Radar-Treffer
    importiert) alle 30 Tage, Priorität 2.
  - Firmen mit `registerStatus = LOESCHUNG_ANGEKUENDIGT` sofort einmalig,
    Priorität 1 (Löschung folgt oft auf Insolvenz).
  - Auf Anforderung: `POST /v1/register-jobs/insolvenz { companyIds }` (Chat,
    Import, Firmendetail „jetzt prüfen“).
  - Nicht: der gesamte Bestand. 1,8 Mio. Abfragen wären bei 60 je Stunde
    und Worker weder sinnvoll noch vom Portal gewollt.

### 3.2 Optionaler Job `insolvenz-tag` (Modus B, nur Betreiber)

- Payload `{ tag }`, eine Suche über genau diesen Tag ohne weitere Filter,
  nur Zeilen mit Registereintrag. Ergebnis: companyIds mit Datum,
  Aktenzeichen, Name, Sitz. Das Gateway legt daraus `insolvenz`-Jobs an
  (Modus A liefert dann Text und Kategorie) und markiert die Firma vorläufig
  (`insolvencyStatus = VERDACHT`). Nur Worker-Art `betreiber` darf diese
  Jobs leasen. Abschaltbar per Umgebungsvariable.

### 3.3 Takt

- Dieselbe `Taktgeber`-Klasse, ein gemeinsames Budget je Rechner über beide
  Portale (60 je Stunde), damit ein Nutzerrechner nie schneller als heute
  anfragt. Das Portal nennt keine Zahl; 60 ist konservativ.

## 4. Datenmodell

**master-data**
```
InsolvencyEvent        id, companyId (FK GermanCompany), aktenzeichen, insolvenzgericht,
                       datum, gegenstand ('ERÖFFNUNG' | 'ABWEISUNG_MANGELS_MASSE' |
                       'SICHERUNGSMASSNAHME' | 'AUFHEBUNG' | 'EINSTELLUNG' | 'ENTSCHEIDUNG' |
                       'VERTEILUNG' | 'INSOLVENZPLAN' | 'SONSTIGES'), textHash, text,
                       quelle ('insolvenzportal'), gesehenAt, createdAt
                       UNIQUE (companyId, aktenzeichen, datum, textHash)
GermanCompany        + insolvencyStatus ('NONE' | 'VERDACHT' | 'SICHERUNG' | 'EROEFFNET' |
                       'ABGEWIESEN' | 'AUFGEHOBEN'), insolvencyAt, insolvencyCheckedAt
```
- `insolvencyStatus` wird aus dem jüngsten Ereignis je Aktenzeichen
  abgeleitet (Eröffnung → EROEFFNET, Abweisung mangels Masse → ABGEWIESEN,
  Aufhebung/Einstellung → AUFGEHOBEN, Sicherungsmaßnahme ohne Eröffnung →
  SICHERUNG). `insolvencyCheckedAt` steuert die 30-Tage-Kadenz.
- Elasticsearch: `insolvencyStatus` im Dokument, damit die Suche den Chip
  zeigt (wie `registerStatus`).
- Ereignisse werden nie gelöscht, auch wenn das Portal sie nach 6 Monaten
  entfernt.
- Interne HMAC-Route `POST /internal/companies/insolvency-events` (Upsert,
  Statusableitung, Befund je Firma: neu, unverändert).

**Gateway**: Job-Arten `insolvenz` und `insolvenz-tag` in `RegisterJob`;
`StructuredContentStale` bei neuem Ereignis (Publikationen ändern sich).

**API und App**: `insolvencyStatus`, `insolvencyAt` in Firmendetails, Liste,
Suchtreffern, „Meine Firmen“ (master-data → Gateway `CompanyShape`,
`CompanyMatrixRow` → Desktop). Chip „insolvent“ (rot) bei EROEFFNET und
SICHERUNG, „Insolvenz abgewiesen“ bei ABGEWIESEN, „Insolvenz beendet“
(grau) bei AUFGEHOBEN, neben „gelöscht“/„in Löschung“. Firmendetails: Tab
oder Abschnitt „Insolvenz“ mit den Ereignissen und Texten. Chat-Tools:
`company_insolvency` (Ereignisse lesen, Prüfung anfordern), Erweiterung
`company_search`-Beschreibung.

## 5. companyId aus dem Registereintrag

Regel aus `docs/PLAN_STAMMDATEN_DELTA.md` 4.1 unverändert:
`idTeil(gericht)_ART_NUMMERZUSATZ`. Gericht vor der Bildung über die
Alias-Tabelle Insolvenzportal → Bestand abbilden (Abschnitt 1). In Modus A
entfällt jede Unsicherheit, weil wir die Parameter setzen. In Modus B wird
der Text „Hamburg, HRA 90794“ geparst (`^(?<gericht>.+?), (?<art>HRA|HRB|GnR|GsR|PR|VR) (?<nummer>\d+)(?: (?<zusatz>[A-ZÄÖÜ]{1,3}))?$`);
Zeilen ohne Registereintrag werden verworfen, nicht über den Namen
zugeordnet.

## 6. Umsetzung in Schritten

| Schritt | Inhalt | Wo |
|---|---|---|
| I0 | Notebook `master-data/scripts/de/insolvenz_delta.ipynb`: Suche über Registereintrag, Trefferliste parsen, AJAX-Text holen, Gegenstand-Kategorien, Alias-Tabelle, Tagesliste; Testfälle (Firma mit Verfahren, Firma ohne, historisches Gericht, Zusatz, Verbraucherzeile, Mehrfachzeilen) | master-data/scripts/de |
| I1 | Schema `InsolvencyEvent`, Spalten an `GermanCompany`, Upsert mit Statusableitung, interne Route, Elasticsearch-Feld | master-data |
| I2 | Job-Arten im Gateway, Ersteller-Regeln (Pool 30 Tage, Löschungsankündigung sofort), Ergebnisverarbeitung, Route `POST /v1/register-jobs/insolvenz`, Statuszähler | Gateway |
| I3 | Worker: `InsolvenzPortal` (Selenium, gleiche Härtung) und `fuehreJobAus` für `insolvenz` (und optional `insolvenz-tag`), gemeinsames Budget | `packages/register-delta` |
| I4 | Fly-Worker und Desktop-Worker nehmen die neue Art automatisch (Arten-Liste); Einstellung „Stammdaten mitpflegen“ nennt Insolvenzen im Text; Verlauf zeigt die Art | Fly, Desktop |
| I5 | Chip, Firmendetail-Abschnitt, Chat-Tool, Org-Feature bleibt `stammdaten.mithelfen` | Desktop, Gateway |
| I6 | Betreiber-Entscheidung Modus B; falls ja, Job `insolvenz-tag` nur für `betreiber` | Gateway, Fly |

Reihenfolge wie beim Register-Delta: I0 zuerst, jeder weitere Schritt mit
Deploy-Freigabe.

## 7. Aufwand und Mengen

- Modus A bei 5.000 Pool-Firmen alle 30 Tage: rund 170 Abfragen je Tag,
  plus Text-Abrufe für Treffer. Ein Fly-Worker deckt das neben dem
  Register-Delta ab; Nutzerrechner beschleunigen.
- Modus B: 1 Anfrage je Tag, danach 250 bis 400 gezielte Abfragen je
  Werktag für die gefundenen Firmen.

## 8. Offene Entscheidungen

1. Modus B (Tagesliste) ja oder nein, angesichts FAQ 15. Empfehlung: nein
   zum Start; Modus A deckt alle Firmen ab, mit denen Nutzer arbeiten.
2. Kadenz der Pool-Prüfung (Vorschlag 30 Tage) und Definition „Pool“
   (Firmen mit Vorgang, Profil, Kontakten oder Radar-Import).
3. Veröffentlichungstext speichern (vollständig, für Firmendetails) oder
   nur Kategorie und Aktenzeichen. Vorschlag: Text speichern, er ist kurz
   und verschwindet nach 6 Monaten aus dem Portal.
4. Ob der Insolvenzstatus die Verarbeitung beeinflusst (zum Beispiel keine
   Kontaktrecherche bei eröffnetem Verfahren) oder nur angezeigt wird.
   Vorschlag: nur anzeigen, Entscheidung beim Nutzer.
