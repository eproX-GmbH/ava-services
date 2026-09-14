# Stammdaten aktuell halten (Register-Delta)

Stand 2026-09-14, abends. Alle Schritte S1 bis S7 sind umgesetzt und in
Betrieb (master-data, Gateway, Fly-Worker `ava-register-worker`, Desktop
v0.1.654). Dieses Dokument beschreibt den gebauten Stand; die Befunde vom
Vormittag, auf denen die Entscheidungen beruhen, stehen in Abschnitt 1.

Ausgangslage: master-data hält 1,84 Mio. Firmen aus einem Vollabzug des
Unternehmensregisters (Stand 2023, Notebooks unter `master-data/scripts/de`,
nur damals aktive Firmen). Ziel: neue Firmen, Umfirmierungen, Sitzwechsel und
Löschungen laufend nachziehen, inklusive Erneuerung strukturierter Inhalte,
ohne Vollabzug.

## 1. Befunde (Portale, 2026-09-14)

**Unternehmensregister (unternehmensregister.de)**
- Die Listensuche „Registerinformationen“ je Amtsgericht und Registerart, auf
  der die Notebooks beruhten, gibt es nicht mehr. Jede Registersuche wird an
  das Registerportal weitergeleitet. Ein Vollabzug per Liste ist unmöglich.

**Registerportal (handelsregister.de), Erweiterte Suche**
- Harte Obergrenze 100 Treffer je Suche, keine Sortierung, keine Blätterung.
- Exakte Registernummer je Gericht funktioniert und ist billig: eine Anfrage,
  Ergebniszeilen mit Bundesland, Gericht, Art, Nummer inklusive Zusatz,
  Firma, Sitz, Status („aktuell“, „Geschlossenes Registerblatt“) und der
  Historie früherer Namen und Sitze. Genau der Datensatz von master-data.
- Mit „auch geschlossene Registerblätter“ liefert die reine Zahl alle
  Zusatzvarianten (Flensburg HRA 100 → SL, NI, HU, FL) und alle Blätter
  früherer Gerichte („HRB 2400 früher Amtsgericht Herford“). Ohne die
  Option 0 Treffer. Eine Zusatz-Schleife ist deshalb unnötig, Mehrfachtreffer
  je Nummer sind normal.
- Nutzungsordnung: 60 Abfragen je Stunde und IP. Das ist der Takt je Worker;
  ein Messlauf der tatsächlichen Sperrschwelle wurde bewusst nicht gemacht.
- Ohne Systemlocale (Fly) liefert das Portal Englisch; der Treiber erzwingt
  `de-DE` und klickt sonst den Umschalter DE.

**Registerbekanntmachungen (im Registerportal)**
- Seit 1.8.2022 nur § 10 HGB: Löschungsankündigung, Umwandlungsgesetz,
  Einreichung neuer Dokumente, Sonstige, Sonderregister. Keine
  Neueintragungen, keine Umfirmierungen.
- Rund 250 Einträge je Tag (Werktage 320 bis 390), Fenster 8 Wochen, alles
  auf einer Seite (fast 2 MB Text, 14.000 Einträge). Die alte Domain
  handelsregisterbekanntmachungen.de antwortet nicht mehr.

**Bestand (Prod-DB, 1.835.854 Zeilen, 117 Gerichte, HRB 1,36 Mio., HRA 0,48 Mio.)**
- Rund 89.000 `registerNumber` mit Float-Artefakt („93141.0“), Zehntausende
  mit angehängtem Altgericht („12345früherAmtsgerichtMeppen“). Beides ist in
  der Nummernfront über die führenden Ziffern abgefangen.
- Keine companyId mit Leerzeichen, Punkt oder „FRÜHER“; 975 Sonderfälle
  (leere Nummer, Umlaut-Zusatz wie `LUEBECK_HRB_264MÖ`).

## 2. Konsequenzen

1. Der einzige vollständige Weg zu neuen Firmen ist die Nummernfront je
   Gericht und Registerart: ab der höchsten bekannten Nummer hochzählen und
   jede Nummer exakt abfragen.
2. Löschungen kommen aus den Löschungsankündigungen und aus dem Status bei
   jeder Abfrage. Umfirmierungen und Sitzwechsel liefert nur eine erneute
   exakte Abfrage (Historie in der Ergebniszeile).
3. Bei 60 Abfragen je Stunde und IP ist das Aufholen 2023 bis 2026 (grob
   500.000 bis 700.000 neue Blätter) verteilt zu leisten: Betreiber-Worker
   auf Fly plus Rechner der Nutzer (Opt-in „Mithelfen“).

## 3. Architektur, wie gebaut

Drei Quellen, eine Queue, ein Datenmodell mit Aktualitätsspalten.

```
Registerportal <-- Worker (Desktop "Mithelfen" oder Fly) <-- lease -- Gateway-Queue RegisterJob
                        | Ergebnis (Treffer, Front, Bekanntmachungen)         ^ Ersteller-Cron 02:00 UTC
                        v                                                     |
                  Gateway verarbeiteErgebnis --HMAC--> master-data Delta-Upsert + RegisterFront
                        |                                    |
                        v                                    v
             StructuredContentStale (S7)              Elasticsearch (_id = companyId)
```

### 3.1 Quelle A: Nummernfront (neue Firmen)

- `RegisterFront(districtCourt, registerType, maxNummer, zusaetze[],
  offeneLuecken[], zuletztGeprueftAt)` in master-data, gesät aus dem Bestand
  (Seed-Skript, Abschnitt 6): höchste plausible Nummer je Gericht und Art
  (bis 10 % über dem 0,99-Quantil, Müllnummern wie 999999995 fallen weg).
- Job `front` je (Gericht, Art): alte Lücken einmal nachprüfen, dann ab
  `maxNummer+1` hochzählen, nur die reine Zahl, Abbruch nach 10 Fehltreffern
  in Folge, höchstens 15 Abfragen je Job (passt in die 20-Minuten-Lease).
  Fehltreffer unterhalb der neuen Front werden als Lücken gemerkt und beim
  nächsten Job einmal nachgeprüft, danach verworfen.
- Bei Treffern reiht das Gateway sofort den nächsten Abschnitt ein
  (Aufholen ohne Wartezeit). Ohne Treffer prüft der Cron die Front täglich.

### 3.2 Quelle B: Registerbekanntmachungen

- Job `bekanntmachungen` je Tag im 56-Tage-Fenster (gestern rückwärts,
  idempotent über den Schlüssel `bek:<Tag>`). Der Worker lädt die Seite
  einmal je Prozess und hält den Text 30 Minuten vor; die Tages-Jobs
  filtern nur.
- Ergebnis: Einträge mit Registerblatt erzeugen Refresh-Jobs (Bündel zu 15),
  Löschungsankündigungen mit Hinweis `loeschung_angekuendigt`. Einträge
  außer Löschungsankündigung markieren die strukturierten Inhalte als
  veraltet (S7).

### 3.3 Quelle C: Auffrischung bekannter Firmen

- Job `refresh` (bis 15 Blätter): exakte Abfrage, Ergebnis geht in den
  Delta-Upsert. Geschlossenes Blatt → `registerStatus = CLOSED`, `closedAt`;
  Löschungshinweis auf aktivem Blatt → `LOESCHUNG_ANGEKUENDIGT`. Firmen werden
  nie gelöscht, Verweise aus dem Pool brechen nicht.
- Anforderung von außen: `POST /v1/register-jobs/refresh { firmen, grund }`.
- Geschlossene oder in Löschung befindliche Firmen, die noch nicht im
  Bestand sind, werden angelegt (Entscheidung 2026-09-14). Der Bestand
  wächst damit auch um geschlossene Blätter; die App kennzeichnet sie.

### 3.4 Queue mit Lease (Gateway)

Tabelle `RegisterJob(id, art, schluessel UNIQUE, payload, status, prioritaet,
leaseUntil, leasedBy, versuche, ergebnis, ergebnisAt, fehler)` plus
`RegisterWorker(workerId, tenantId, actorId, art, zuletztAt, jobsErledigt,
abfragen, gesperrtAt)`.

- Ersteller-Cron stündlich, Erzeugung einmal täglich ab 02:00 UTC:
  Front-Jobs für Fronten mit letzter Prüfung älter als 20 Stunden,
  Bekanntmachungs-Jobs je fehlendem Tag. Prioritäten: Bekanntmachungen 1,
  Refresh 2, Front 3 (große Gerichte) und 4.
- Lease: `UPDATE … FOR UPDATE SKIP LOCKED LIMIT 1`, 20 Minuten, Rückfall in
  die Queue bei Ablauf, maximal 5 Versuche, danach `fehlgeschlagen` mit
  Grund. Wiedervorlage: endgültig fehlgeschlagene Jobs werden nach 12 Stunden
  mit frischem Zähler erneut eingereiht.
- Ergebnis: idempotent (meldet derselbe Worker ein bereits verbuchtes
  Ergebnis erneut, kommt die gespeicherte Zusammenfassung). Treffer gehen in
  1.000er-Blöcken an master-data; Portal-Sperre → Job zurück, Worker eine
  Stunde markiert.
- Routen (JWT, Scope `company:read`): `POST /v1/register-jobs/lease`,
  `POST /v1/register-jobs/{id}/ergebnis`, `POST /v1/register-jobs/{id}/fehler`,
  `GET /v1/register-jobs/status`, `POST /v1/register-jobs/refresh`. Für den
  Betreiber-Worker dieselbe Semantik unter `/internal/register-jobs/*` über
  den HMAC-Kanal (`INTERNAL_HMAC_SECRET`).

### 3.5 Worker (Paket `packages/register-delta`, `@ava/register-delta`)

- Reiner Parser ohne Browser (`parser.ts`: Kopfzeile, Status, Historie,
  Bekanntmachungen), `RegisterPortal` (Selenium, headless, Downloads hart
  gesperrt, nur handelsregister.de), `Taktgeber` (60 je Stunde, gleitendes
  Fenster, Mindestabstand mit Streuung), `GatewayClient` (Bearer oder HMAC,
  eine Wiederholung bei Netzfehler), `fuehreJobAus`, `RegisterWorker`
  (Schleife, Pause bei Sperre, Browser-Neustart bei Fehler), CLI
  `register-delta-worker`. 13 Tests (`npm test`), Referenz bleibt das
  Notebook `master-data/scripts/de/register_delta.ipynb`.
- Betreiber-Fallback: Fly-App `ava-register-worker` (fra, eine Maschine
  shared-cpu-1x 1 GB, läuft dauerhaft, kein HTTP, rund 1.400 Abfragen je
  Tag). Dockerfile mit Alpine-Chromium und chromedriver, Nutzer `worker`.
- Desktop „Mithelfen“ (S6): Opt-in unter Einstellungen → Automatisierungen
  → „Stammdaten mitpflegen“, Option „nur im Netzbetrieb“. Kindprozess aus
  dem vendierten Paket (`resources/p/rd`, ohne Prisma), Token-Datei mit
  Rechten 600 alle 5 Minuten erneuert, Pausen bei Akku, Abmeldung,
  Organisationssperre (Feature `stammdaten.mithelfen`), Neustart nach
  Absturz, Logs unter „register-delta“ im Producer-Log. Chat-Tools
  `register_delta_status` und `register_delta_config` (Fähigkeitsgruppe
  „stammdaten“). Statuszeile zeigt aktuellen Job, Abfragen der letzten
  Stunde und den Stand der geteilten Queue.

### 3.6 Was passiert, wenn tagelang niemand mitmacht

Der Fly-Worker läuft immer. Bekanntmachungen sind bis 8 Wochen nachholbar,
Fronten laufen einfach weiter; nichts geht verloren, es dauert nur länger.

## 4. Datenmodell

**master-data**
```
GermanCompany        + registerStatus ('ACTIVE' | 'CLOSED' | 'LOESCHUNG_ANGEKUENDIGT')
                       (die Spalte `state` ist das Bundesland und bleibt),
                       source ('unternehmensregister-2023' | 'registerportal' | 'bekanntmachung' | 'import'),
                       formerCourt, firstSeenAt, lastSeenAt, changedAt, closedAt
GermanCompanyHistory   unverändert (Verlauf aus der Ergebniszeile, bei Änderung ersetzt)
RegisterFront          districtCourt, registerType, maxNummer, zusaetze[], offeneLuecken[], zuletztGeprueftAt
```
Migration `20260914120000_register_delta`. Delta-Upsert `upsertManyDelta`:
Befund je Zeile (neu, geändert mit Feldliste, unverändert), nie löschen,
`createdAt` und `firstSeenAt` bleiben, `lastSeenAt` immer, `changedAt` und
`closedAt` nur bei Änderung. Auch der alte Import-Pfad (`PUT
/api/germany/v1/companies`, Excel) läuft über diesen Upsert statt
Delete/Create. Interne HMAC-Routen für das Gateway: `POST
/internal/companies/register-delta` (bis 1.000 Zeilen), `POST
/internal/register-front/list`, `PUT /internal/register-front`.

**Elasticsearch** (Index `german_companies`): Dokument-Id ist die companyId,
Felder companyId, name, nameNormalized, location, registerStatus. Neue und
geänderte Firmen werden indexiert, unveränderte nicht. Altbestand am
2026-09-14 per `update_by_query` auf `registerStatus = ACTIVE` gesetzt
(1.835.883 Dokumente). Der Sync-Befehl `POST /api/germany/v1/companies/sync`
schreibt den Status ebenfalls.

**Gateway**: `RegisterJob`, `RegisterWorker`, `StructuredContentStale(companyId,
seit, grund)`.

**API-Antworten**: master-data liefert `registerStatus`, `closedAt`,
`formerCourt` in Firmendetails, Liste, Suchtreffern und „Meine Firmen“; das
Gateway reicht sie in `CompanyShape` und `CompanyMatrixRow` durch; der
Desktop zeigt den Chip `RegisterStatusBadge` („gelöscht“ rot, „in Löschung“
gelb) in Firmensuche, Meine Firmen, Vorgängen und Firmendetails. Das
Chat-Tool `company_search` nennt den Status.

### 4.1 companyId-Regel (reproduzierbar, exakt wie der Original-Scraper)

Formel aus `scripts/de/scraper_unternehmensregister.ipynb`, gespiegelt in
`packages/register-delta/src/ids.ts` und `services/db-gateway/src/lib/register-ids.ts`:

- Gerichtsname in der Schreibweise des Bestands (aus dem Job, nicht aus der
  Kopfzeile; Bekanntmachungs-Köpfe werden über die Fronten abgebildet),
  `strip().upper()`, Ä/Ö/Ü/ß → AE/OE/UE/SS, alles außer A-Z0-9 entfernt
  (auch Leerzeichen: `BADOEYNHAUSEN`, `KEMPTENALLGAEU`, `WEIDENIDOPF`).
- `_ART_` plus Nummer plus Zusatz ohne Leerzeichen, Zusatz in Großschreibung
  mit Umlaut (`FLENSBURG_HRA_100FL`, `LUEBECK_HRB_264MÖ`).
- Bremen zeigt heute `HRB 2827 BHV`, der Bestand hat
  `BREMEN_HRB_2827BREMERHAVEN` (799 Zeilen) → Alias BHV → BREMERHAVEN nur
  für Bremen.
- Blätter früherer Gerichte tragen die reine Nummer (`AURICH_HRB_100001`
  für „früher Amtsgericht Emden“), wie im Bestand. Nur wenn zur selben
  Nummer auch ein aktuelles Blatt existiert (Bad Oeynhausen HRB 2400:
  aktuell plus Herford plus Minden, im Original eine Kollision), bekommen
  die früheren Blätter `_F<ALTGERICHT>`. Die Entscheidung fällt aus dem
  Ergebnis derselben Nummernabfrage und ist damit reproduzierbar.
- `registerNumber` wird wie im Bestand ohne Leerzeichen geschrieben (`4851FL`).

## 5. Veraltet-Markierung strukturierter Inhalte (S7)

`StructuredContentStale` wird gesetzt, wenn der Delta-Upsert ein Registerblatt
als geändert meldet (Name, Sitz, Status, Historie) oder eine Bekanntmachung
mit Registerblatt außer Löschungsankündigung eingeht. `GET
/v1/companies/{id}/state` meldet die Stufe structured-content dann mit
`updatedAt = null` plus `veraltetSeit` und `veraltetGrund`; der bestehende
Vorab-Check des Producers läuft beim nächsten Zugriff neu, ohne
Producer-Änderung. Der nächste structured-content-Lauf löscht die Markierung
(persist-bus). Keine flächige Erneuerung: erneuert wird, was benutzt wird
(Import, Datenrefresh-Kadenz, Zugriff). Anzahl in `GET /v1/register-jobs/status`
(`veraltet`).

## 6. Betrieb

| Was | Wo / Wie |
|---|---|
| Seed der Fronten | `master-data`: `npm run register-delta:seed-front -- --dry` (SQL-Aggregat, hebt bestehende Fronten nur an); gegen Prod über den MPG-Proxy mit `?sslmode=disable` |
| Queue-Stand | `GET /v1/register-jobs/status` (Jobs je Art und Status, Worker aktiv, Abfragen heute, veraltet) oder Chat-Tool `register_delta_status` |
| Fly-Worker | `fly logs -a ava-register-worker`; Secret `INTERNAL_HMAC_SECRET` = Wert von Gateway und master-data; weitere IPs per `fly scale count` je Region; Deploy aus `packages/register-delta` mit `fly deploy --remote-only --ha=false` |
| Lokaler Worker (Test) | `packages/register-delta`: `GATEWAY_URL=… WORKER_ID=… WORKER_REFRESH_TOKEN_FILE=… KEYCLOAK_TOKEN_URL=… KEYCLOAK_CLIENT_ID=ava-desktop REGISTER_DELTA_EINMAL=1 REGISTER_DELTA_ARTEN=refresh node dist/cli.js`; PATH ohne alte chromedriver-Kopien |
| Desktop-Vendoring | `services/desktop`: `node scripts/fetch-producers.mjs --name=register-delta` (bei root-Dateien im npm-Cache `npm_config_cache=/tmp/npm-cache-ava`) |
| Gateway-Cron abschalten | `REGISTER_JOBS_DISABLED=1` |
| Kosten | Fly-Worker rund 6 bis 7 US-Dollar je Monat und Maschine |

Ergebnisse vom 2026-09-14: Refresh Bad Oeynhausen (2 neue Altgerichts-
Blätter, 1 Umfirmierung mit 4 Historie-Einträgen), Front Aurich HRA 15 von 15
Nummern neu, Aurich HRB 6 neu, alle 56 Bekanntmachungs-Tage abgearbeitet
(je Werktag 320 bis 390 Einträge, 21 bis 26 Refresh-Jobs), 116 Firmen als
veraltet markiert. Stand der Queue am Abend: 234 Front-Jobs offen, rund 200
Refresh-Jobs offen.

## 7. Umsetzung (alle Schritte erledigt am 2026-09-14)

| Schritt | Inhalt | Stand |
|---|---|---|
| S1 | Schema, Delta-Upsert, interne Routen | master-data, deployt |
| S2 | Seed-Skript, 234 Fronten in Prod | master-data |
| S3 | Queue, Lease, Ergebnis, Ersteller-Cron, Wiedervorlage | Gateway, deployt |
| S4 | Worker-Kern als Paket | `packages/register-delta` |
| S5 | Betreiber-Worker auf Fly | `ava-register-worker` v6 |
| S6 | Desktop „Mithelfen“, Einstellung, Chat-Tools, Org-Schalter | Desktop v0.1.652 (ID-Regel korrigiert in v0.1.653) |
| S7 | Veraltet-Markierung strukturierter Inhalte | Gateway, deployt |
| Chip | Registerstatus in API, Index und App | master-data, Gateway, Desktop v0.1.654 |

## 8. Entscheidungen

1. Betreiber-Fallback-Worker auf Fly: ja (Ausnahme von der Lokalitätsregel
   für Vollständigkeit).
2. Ratenbudget: 60 Abfragen je Stunde und Worker nach Nutzungsordnung, kein
   Messlauf.
3. Desktop-Worker als Kindprozess des vendierten Pakets, nicht im
   Hauptprozess (Selenium-Muster der Producer).
4. Geschlossene und in Löschung befindliche Firmen werden angelegt; Firmen
   werden nie gelöscht, die App kennzeichnet sie.
5. companyId exakt nach der Original-Formel (Abschnitt 4.1); der Anhang
   `_F<ALTGERICHT>` nur bei Kollision mit einem aktuellen Blatt.

## 9. Offen

- Aufholen beobachten: bei einer Fly-Maschine rund 1.400 Abfragen je Tag;
  zweite Region oder Nutzer mit „Mithelfen“ beschleunigen.
- Selbstabschaltung des Fly-Workers bei leerer Queue, sobald das Aufholen
  durch ist (dann reicht ein Start je Nacht).
- Zusätze weiterer Gerichte prüfen, falls das Portal Kürzel anders anzeigt
  als der Bestand (bisher nur Bremen bekannt).
