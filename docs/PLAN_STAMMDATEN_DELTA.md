# Plan: Stammdaten aktuell halten (Delta statt Vollabzug)

Stand 2026-09-14. Ausgangslage: master-data hält rund 1,8 Mio. Firmen aus
einem Vollabzug des Unternehmensregisters (Stand 2023, Notebooks unter
`master-data/scripts/de`). Ziel: neue Firmen, Umfirmierungen, Sitzwechsel und
Löschungen laufend nachziehen, inklusive Auffrischung strukturierter Inhalte,
ohne dass der Betreiber regelmäßig einen Vollabzug fährt.

## 1. Was heute geprüft wurde (Portale, 2026-09-14)

**Unternehmensregister (unternehmensregister.de)**
- Die Listensuche „Registerinformationen“ je Amtsgericht und Registerart mit
  100 Treffern je Seite, auf der die Notebooks beruhten, gibt es nicht mehr.
  Die neue Oberfläche leitet jede Registersuche an das Registerportal weiter
  („Hier werden Sie zu den Registerinformationen des Registergerichts
  weitergeleitet“). Ein Vollabzug per Liste ist damit nicht mehr möglich.

**Registerportal (handelsregister.de), Erweiterte Suche**
- Felder: Bundesland, Firma/Schlagwörter, Sitz, Registerart, Registernummer,
  Registergericht, Rechtsform, Staat, „auch geschlossene Registerblätter“,
  Ergebnisse je Seite (max. 100).
- **Harte Obergrenze 100 Treffer je Suche** („Die maximale Trefferanzahl von
  100 wurde überschritten“), keine Sortierung, keine Blätterung darüber
  hinaus. Listen je Gericht sind damit ebenfalls unmöglich.
- **Exakte Registernummer je Gericht funktioniert** und ist billig: eine
  Anfrage, eine Ergebniszeile mit Bundesland, Gericht, Registerart, Nummer
  inklusive Zusatz, Firma, Sitz, Status („aktuell“ oder „Geschlossenes
  Registerblatt“, letzteres nur mit der Option „auch geschlossene“) und der
  **Historie** früherer Namen und Sitze. Das ist genau der Datensatz, den
  master-data führt.
- **Nummernzusätze:** „HRA 100“ in Flensburg liefert 0 Treffer, „HRA 100 FL“
  liefert das Registerblatt. Zusätze (zweistellige Kürzel aus Gerichts-
  fusionen, historisch „B“ in Berlin) müssen beim Abfragen mitgegeben
  werden; die Suche findet sie nicht über die reine Zahl.
- Nutzungsgrenze: Die Hilfe nennt keine Zahl. Bekannt und im Producer
  structured-content berücksichtigt ist die Praxis von etwa 60 Anfragen je
  Stunde und IP. Diese Zahl ist zu messen, bevor Takte festgelegt werden.

**Registerbekanntmachungen (im Registerportal; die Domain
handelsregisterbekanntmachungen.de antwortet nicht mehr)**
- Enthält seit 1.8.2022 nur die Fälle nach § 10 HGB: Löschungsankündigung,
  Bekanntmachung nach dem Umwandlungsgesetz, Einreichung neuer Dokumente,
  Sonstige, Sonderregister. **Keine Neueintragungen, keine Umfirmierungen.**
  Seit DiRUG gelten Eintragungen mit der Abrufbarkeit als bekannt gemacht.
- Menge im Fenster 20.07. bis 14.09.2026: rund 14.100 Einträge, davon
  11.000 Umwandlungsgesetz, 1.900 Löschungsankündigungen, 800 Dokumente.
  Also **rund 250 je Tag**, Fenster **8 Wochen**, filterbar nach Datum,
  Bundesland, Gericht, Kategorie; alles auf einer Seite.

## 2. Konsequenzen

1. Ein „funktionales Skript, das ich einmal bei mir laufen lasse“ im Sinne
   des alten Vollabzugs gibt es nicht mehr. Kein Portal liefert Listen.
2. Der einzige vollständige Weg zu neuen Firmen ist die **Nummernfront je
   Gericht und Registerart**: Registernummern werden fortlaufend vergeben,
   Lücken sind selten und klein. Ab der höchsten bekannten Nummer wird
   hochgezählt und jede Nummer exakt abgefragt, mit den Zusätzen, die für
   das Gericht bekannt sind.
3. Löschungen kommen aus den Löschungsankündigungen und aus dem Status bei
   jeder Abfrage. Umfirmierungen und Sitzwechsel liefert nur eine erneute
   exakte Abfrage der Firma (Historie in der Ergebniszeile).
4. Bei etwa 60 Anfragen je Stunde und IP ist das Aufholen der Jahre 2023
   bis 2026 (grob 500.000 bis 700.000 neue Blätter) von einem Rechner aus
   nicht machbar (über ein Jahr). Aufholen muss verteilt laufen oder über
   mehrere Betreiber-IPs. Der laufende Tagesbetrieb danach ist klein:
   grob 1.500 bis 2.500 Front-Abfragen und 250 Bekanntmachungen je Tag.

## 3. Zielbild

Drei Quellen, eine Queue, ein Datenmodell mit Aktualitätsspalten.

### 3.1 Quelle A: Nummernfront (neue Firmen)

- Tabelle `RegisterFront(districtCourt, registerType, maxNummer,
  zusaetze[], zuletztGeprueftAt, offeneLuecken[])` in master-data, initial
  aus `GermanCompany` berechnet (höchste rein numerische Nummer je Gericht
  und Art, Menge der gesehenen Zusätze je Gericht).
- Job „front“ je (Gericht, Art): fragt `maxNummer+1 … +N` ab, nur die reine
  Zahl je Nummer (mit „auch gelöschte Registerblätter“ liefert das Portal
  alle Zusatzvarianten und alle Blätter früherer Gerichte mit, Notebook
  2026-09-14), bricht nach K=25 Fehltreffern in Folge ab und merkt sich die Lücken für einen späteren
  zweiten Versuch (Nummern werden gelegentlich verzögert sichtbar).
- Ergebnis je Treffer: neue Firma mit Name, Sitz, Status, Historie,
  `source='registerportal'`, `firstSeenAt`, `lastSeenAt`.

### 3.2 Quelle B: Registerbekanntmachungen (Löschungen, Umwandlungen)

- Job „bekanntmachungen“ je (Tag, Bundesland): Seite abrufen, alle Einträge
  parsen (Kategorie, Gericht, Art, Nummer, Firma, Sitz), Ergebnis:
  - Löschungsankündigung → Firma als `state='LOESCHUNG_ANGEKUENDIGT'`
    markieren und in Quelle C zur Bestätigung einreihen.
  - Umwandlungsgesetz, Dokumente, Sonstige → Firma zur Auffrischung
    einreihen (Quelle C) und strukturierte Inhalte als veraltet markieren.
- Fenster 8 Wochen: Nach einer Pause von bis zu 8 Wochen lässt sich alles
  nachholen. Der Job-Ersteller legt für jeden fehlenden Tag im Fenster
  einen Job an.

### 3.3 Quelle C: Auffrischung bekannter Firmen

- Job „refresh“ je Firma (gebündelt zu 25): exakte Abfrage, Vergleich von
  Name, Sitz, Status, Historie mit dem Bestand. Änderung → `changedAt`,
  neuer Verlaufseintrag in `GermanCompanyHistory`, `state` bei geschlossenem
  Blatt auf `CLOSED`, Firma bleibt in der Tabelle (Verweise aus dem Pool
  dürfen nie brechen).
- Wer wird aufgefrischt: alle Firmen im geteilten Pool (haben Profil,
  Kontakte oder Verarbeitung) alle 90 Tage, Firmen aus Quelle B sofort,
  alle übrigen 1,8 Mio. nur bei Bedarf (Import, Radar-Treffer).
- Strukturierte Inhalte: keine flächige Erneuerung. Der bestehende
  Producer erneuert einen Datensatz, wenn er als veraltet markiert ist und
  die Firma im aktiven Bestand eines Nutzers liegt oder beim nächsten
  Zugriff. Damit ist „vollständig inklusive strukturiertem Inhalt“ für
  alles erreicht, was tatsächlich benutzt wird.

### 3.4 Queue mit Lease (Gateway)

Tabelle `RegisterJob(id, art, schluessel, payload, status, prioritaet,
leaseUntil, leasedBy, versuche, ergebnisAt, fehler)`. Regeln:

- **Ersteller** (Gateway-Cron, täglich 02:00): Front-Jobs je (Gericht,
  Art), Bekanntmachungs-Jobs je fehlendem Tag im 8-Wochen-Fenster,
  Refresh-Jobs nach Fälligkeit. Idempotent über `schluessel`.
- **Lease**: `UPDATE … WHERE status='offen' AND (leaseUntil IS NULL OR
  leaseUntil < now()) ORDER BY prioritaet, id FOR UPDATE SKIP LOCKED LIMIT 1`,
  Lease 20 Minuten, Rückfall in die Queue bei Ablauf, maximal 5 Versuche,
  danach `fehlgeschlagen` mit Grund.
- **Ergebnis** wird als Batch an das Gateway gemeldet; das Gateway schreibt
  über master-data (`upsert` mit Änderungserkennung, kein Delete/Create
  mehr) und aktualisiert `RegisterFront`. Doppelte Verarbeitung ist
  unschädlich, weil alles Upsert über die `companyId` ist.
- **Ratenbudget je Worker**: 60 Abfragen je Stunde und Rechner (Grenze aus
  der Nutzungsordnung des Registerportals, kein Messlauf nötig; Entscheidung
  2026-09-14), mindestens 60 Sekunden Abstand zwischen zwei Jobs, Pause bei Chat, Akku, und wenn der
  Nutzer den Producer structured-content gerade selbst braucht (dieselbe IP,
  dasselbe Portal).

### 3.5 Worker

- **Desktop-Worker** (neuer Hintergrunddienst, Opt-in „Mithelfen“ in den
  Einstellungen mit Chat-Tool, pausierbar, für Organisationen abschaltbar):
  Lease holen, Job ausführen, Ergebnis melden. Läuft über den bereits
  vorhandenen Webdriver-Code aus structured-content (Registerportal-
  Navigation, Cookie-Banner, Erweiterte Suche), als eigener kleiner
  Producer „register-delta“ oder als Modul im Hauptprozess mit dem
  Hintergrund-Browser und Download-Sperre.
- **Betreiber-Fallback-Worker**: derselbe Code als kleiner Dienst auf 1 bis
  3 Fly-Maschinen mit eigenen IPs. Er nimmt nur Jobs, die älter als 24
  Stunden sind oder deren Priorität hoch ist (Bekanntmachungen des
  Vortags). Damit ist die Vollständigkeit unabhängig davon, ob Nutzer
  mitmachen. Das ist eine bewusste Ausnahme von „Rechenarbeit lokal“:
  kleine Menge, öffentliche Daten, Betreiber-IP.

### 3.6 Was passiert, wenn tagelang niemand mitmacht

- Front-Jobs verfallen nicht. Registernummern laufen nicht weg; ein Job, der
  eine Woche liegen bleibt, holt beim nächsten Lauf einfach mehr Nummern.
- Bekanntmachungs-Jobs sind bis 8 Wochen nachholbar (Portal-Fenster). Der
  Ersteller legt fehlende Tage nach; erst nach 8 Wochen ginge etwas
  verloren, und das fängt der Fallback-Worker vorher ab.
- Refresh-Jobs haben keine Frist; sie werden schlicht später verarbeitet.
- Der Fallback-Worker greift nach 24 Stunden Stillstand. Ziel „alle Daten
  werden abgegriffen“ ist damit garantiert, nur die Latenz schwankt
  zwischen Stunden (viele Teilnehmer) und wenigen Tagen (keiner).
- Sichtbar unter Einstellungen → System: Queue-Länge, ältester offener Job,
  Abfragen der letzten 24 Stunden, Anteil Nutzer/Betreiber.

## 4. Datenmodell (master-data)

```
GermanCompany        + firstSeenAt, lastSeenAt, changedAt, closedAt,
                       source ('unternehmensregister-2023' | 'registerportal' | 'import'),
                       registerStatus: 'ACTIVE' | 'CLOSED' | 'LOESCHUNG_ANGEKUENDIGT'
                       (die Spalte `state` ist das Bundesland und bleibt),
                       formerCourt ("früher Amtsgericht X")
GermanCompanyHistory   unverändert (Verlauf aus der Ergebniszeile)
RegisterFront          districtCourt, registerType, maxNummer, zusaetze[],
                       offeneLuecken[], zuletztGeprueftAt
```

Gateway: `RegisterJob` (3.4) und `StructuredContentStale(companyId, seit,
grund)` für die Veraltet-Markierung, die der Producer beim nächsten Lauf
auswertet.

`companyId` bleibt `AMTSGERICHT_ART_NUMMER` inklusive Zusatz ohne
Leerzeichen, exakt wie im Bestand (Gerichtsname ohne Leer- und
Sonderzeichen: `BADOEYNHAUSEN`, `KEMPTENALLGAEU`). Blätter früherer
Gerichte mit derselben Nummer bekommen den Anhang `_F<ALTGERICHT>`
(`BADOEYNHAUSEN_HRB_2400_FHERFORD`). Upsert statt Delete/Create.

**S1 umgesetzt (2026-09-14, master-data):** Migration
`20260914120000_register_delta`, Repository `upsertManyDelta` (Befund je
Zeile: neu, geändert mit Feldern, unverändert; Elastic-Index mit
`_id = companyId`), auch der alte Import-Pfad `upsertMany` löscht nicht
mehr. Interne HMAC-Routen für das Gateway:
`POST /internal/companies/register-delta` (bis 1.000 Zeilen, Quelle,
`gesehenAt`), `GET/PUT /internal/register-front`.

**S2 umgesetzt (2026-09-14):** `master-data/scripts/register-delta/seed-front.ts`
(`npm run register-delta:seed-front -- --dry`), SQL-Aggregat über den Bestand,
Ausreißerfilter „höchste Nummer bis 10 % über dem 0,99-Quantil“. Seed in Prod
geschrieben: 234 Fronten, 8 Gerichte mit Zusätzen (Schleswig-Holstein).

**S3 umgesetzt (2026-09-14, Gateway):** Migration `20260914_register_jobs`
(`RegisterJob`, `RegisterWorker`), `lib/register-jobs.ts` (Lease per
`FOR UPDATE SKIP LOCKED`, 20 Minuten, 5 Versuche; Ergebnis → master-data
Delta-Upsert in 1.000er-Blöcken, Front-Fortschreibung, Folge-Front-Job bei
Treffern; Bekanntmachungen → Refresh-Jobs zu 25 mit Hinweis
`loeschung_angekuendigt`; Portal-Sperre → Job zurück, Worker markiert),
Ersteller-Cron täglich ab 02:00 UTC (Front-Jobs für Fronten mit letzter
Prüfung älter als 20 h, Bekanntmachungs-Jobs je Tag im 56-Tage-Fenster,
Priorität: Bekanntmachungen 1, Refresh 2, Front 3/4). Routen
`POST /v1/register-jobs/lease`, `POST /v1/register-jobs/{id}/ergebnis`,
`POST /v1/register-jobs/{id}/fehler`, `GET /v1/register-jobs/status`,
`POST /v1/register-jobs/refresh`. Budget-Hinweis an den Worker: 60 Abfragen
je Stunde. Front-Jobs fragen nur die reine Zahl ab, `maxFehltreffer` 10.

**S4 umgesetzt (2026-09-14):** Paket `packages/register-delta`
(`@ava/register-delta`, CommonJS, einzige Abhängigkeit selenium-webdriver).
Reiner Parser ohne Browser (`parser.ts`: Kopfzeile, Status, Historie,
Bekanntmachungen; 11 Tests mit `node --test`), `RegisterPortal` (Selenium,
headless, `download_restrictions: 3`, DOM-Extraktion per In-Page-Skript,
Sperr- und Störungserkennung), `Taktgeber` (60/h gleitendes Fenster mit
Mindestabstand und Streuung), `GatewayClient`, `fuehreJobAus` (front:
Lücken einmal nachprüfen, dann hochzählen, max. 15 Abfragen je Job;
bekanntmachungen: ein Seitenaufruf, Filter auf den Tag; refresh:
Zusatzfilter, Löschungshinweis → `LOESCHUNG_ANGEKUENDIGT`), `RegisterWorker`
(Schleife mit Pause bei Sperre, Browser-Neustart bei Fehler) und CLI
`register-delta-worker` (Bearer statisch oder Keycloak client_credentials).
Live-Rauchtest: Bad Oeynhausen HRB 2400 → 3 Blätter (Herford, Minden als
frühere Gerichte), HRB 9637 mit 4 Historie-Einträgen, Bekanntmachungen
14.157 Einträge über 57 Tage, 2 ohne Registerblatt.

## 5. Einmaliges Aufholen 2023 → heute

Was du selbst laufen lassen kannst (`master-data/scripts/register-delta`,
TypeScript, gleicher Code wie der Worker):

1. **Seed:** `RegisterFront` aus der Datenbank berechnen, Zusätze je Gericht
   ableiten, Front-Jobs erzeugen. Dauert Minuten, keine Portalabfragen.
2. **Lokaler Worker im Betreibermodus:** nimmt Jobs mit deiner IP. Bei 60
   Anfragen je Stunde schafft ein Rechner rund 1.400 am Tag. Für das
   Aufholen reicht das nicht; für die Bekanntmachungen des Fensters (etwa
   60 Seitenabrufe) und für Stichproben schon.
3. **Aufholen:** entweder die 1 bis 3 Fallback-Maschinen auf Fly (bei drei
   IPs rund 4.000 Abfragen je Tag, für 600.000 Nummern etwa fünf Monate)
   oder verteilt über die Nutzer, sobald der Desktop-Worker ausgerollt ist
   (bei 20 aktiven Rechnern rund zwei bis drei Wochen). Realistisch beides:
   Fallback sofort, Nutzer beschleunigen.
4. Priorität beim Aufholen: Gerichte nach Nutzer-Regionen (ICP-Orte, Radar-
   Gebiete) zuerst, damit der Nutzen früh sichtbar wird.

## 6. Rechtliches und Höflichkeit

- Nutzungsbedingungen des Registerportals zu automatisierten Abfragen
  prüfen und den Takt daran ausrichten. Der Producer structured-content
  macht heute schon exakte Abfragen im Auftrag des Nutzers; die Front-
  Abfragen sind dieselbe Art Anfrage, nur ohne konkreten Anlass.
- Nutzer-IPs: Opt-in mit klarer Erklärung, was der Rechner abfragt, und
  eigenes Budget, damit der Nutzer selbst nie in die Portalgrenze läuft.

## 7. Umsetzung in Schritten

| Schritt | Inhalt | Wo |
|---|---|---|
| S1 | Schema: Aktualitätsspalten, `RegisterFront`, Upsert mit Änderungserkennung | master-data |
| S2 | Seed-Skript: Front aus Bestand, Zusätze, Jobs | master-data/scripts/register-delta |
| S3 | `RegisterJob`-Queue, Lease-Route, Ergebnis-Route, Ersteller-Cron | Gateway |
| S4 | Worker-Kern: Registerportal-Abfrage (Front, Bekanntmachungen, Refresh) als Bibliothek, mit den Selektoren aus structured-content | Paket `register-delta` |
| S5 | Betreiber-Fallback-Worker auf Fly, Metriken | Gateway/Fly |
| S6 | Desktop-Worker „Mithelfen“, Einstellung, Chat-Tool, Org-Schalter, Systemseite | Desktop |
| S7 | Veraltet-Markierung strukturierter Inhalte und Erneuerung im Producer | Gateway, structured-content |

S1 bis S5 bringen die Daten unabhängig von Nutzern auf Stand, S6 skaliert.

## 8. Offene Entscheidungen

1. Betreiber-Fallback-Worker auf Fly: entschieden, ja.
2. Anzahl Fly-IPs fürs Aufholen (1 bis 3) und ob das Aufholen auf Regionen
   priorisiert wird.
3. Ratenbudget je Nutzer-Rechner: entschieden, 60 je Stunde nach
   Nutzungsordnung, kein Messlauf.
4. Ob der Desktop-Worker ein eigener Producer wird (eigener Chrome, wie
   structured-content) oder im Hauptprozess mit dem Hintergrund-Browser
   läuft (leichter, aber Registerportal ist JSF-lastig; Selenium-Code
   existiert bereits).
