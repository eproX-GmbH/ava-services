# Plan: Vorabanalyse für Kunden-CRM-Listen (Betreiber-Werkzeug)

Stand: 2026-10-16. Status: Entwurf, wartet auf Go.

## 1. Ziel

Patrick und Henning sollen vor einem Vertragsabschluss aus einer CRM-Liste eines
Interessenten (bis 20.000 Firmen, Excel/CSV) die Teilmenge bestimmen, die AVA wirklich
aufbereiten soll ("AVA ready"). Dazu wird die Liste gegen die Stammdaten abgeglichen,
je Firma die Website gesucht und bestätigt, ein Miniprofil erstellt und gegen das ICP des
Kunden beurteilt. Ergebnis ist eine kuratierte Liste mit Begründung je Firma, Kosten
je Lauf und ein Export.

Das Werkzeug steht für sich: nur in admin.ava.bi, nur für Betreiber (Keycloak-Rolle
admin), keine Verbindung zur AVA-Pipeline, zu Transaktionen, Bestand oder Abrechnung
der Kunden. Es läuft auf Betreiber-Rechnung (Betreiber-Modell, Valueserp-Schlüssel des
Betreibers). Das ist eine bewusste Ausnahme von der Regel "alle Rechenarbeit beim
Nutzer": hier gibt es noch keinen Nutzer, nur einen Interessenten.

## 2. Bausteine, die es schon gibt

| Schritt | Vorhanden | Wo | Wiederverwendung |
|---|---|---|---|
| ICP erfassen | Assistent mit drei Wegen (Fragen, Website, Dokument), Schema `IcpProfile` | Desktop `icp-assistant.ts`, `icp-store.ts` | Schema und Prompts in ein geteiltes Paket ziehen, Engine im Gateway über das Betreiber-Modell |
| Stammdaten-Abgleich Name + Ort | Data-Care (Excel rein, Treffer/unsicher/kein Treffer, Kandidaten mit Score) | master-data `POST /api/v1/data-care?dryRun=1` | Neuer interner Endpunkt mit JSON-Zeilen statt Excel, gleiche Logik |
| Website suchen | Valueserp-Suche "Name Ort", Kandidaten, Plattform-Sperrliste | website `valueserp-utils.ts`, Radar `scan.ts` `resolveWebsitesViaSerp` | Logik ins Gateway portieren (fetch, kein Browser) |
| Website-Judge | LLM beurteilt, ob die Seite zur Firma gehört | website `website-judge.ts` `judgeWebsiteCandidates` | Prompt und Schema übernehmen, Aufruf über die Betreiber-Spur |
| Miniprofil | Crawl von 3 bis 5 Seiten, Text, LLM-Profil | Radar `profiler.ts` (`crawlSite`, `buildProfile`) | Portieren; läuft heute im Desktop mit Nutzermodell |
| ICP-Urteil | LLM-Urteil Profil gegen ICP mit Score und Begründung | Radar `matcher.ts` `icpUrteil` | Portieren |
| Fortschritt live | SSE je Transaktion über den Event-Bus | Gateway `transactions.ts` `/events` | Gleiches Muster, eigener Kanal je Lauf |
| Kosten messen | `LlmUsage` (Betreiber-Spur, `quelle`), `ProxyAudit` (Valueserp, Tarif, Preis) | Gateway | Je Aufruf die Lauf-Kennung mitschreiben |

## 3. Architektur

Alles im Gateway (`services/db-gateway/src/lib/vorabanalyse/`), eigene Tabellen, eigener
Job-Läufer im Prozess (wie der Billing-Cron, aber ereignisgetrieben), eigene Routen
unter `/v1/betreiber/vorabanalyse/*` (nur `istBetreiber`).

### 3.1 Datenmodell (neue Tabellen, Prefix `Vorab`)

- `VorabLauf`: id, kundeName, erstelltVon (actorId), status (`icp` | `abgleich` |
  `zuordnung` | `website` | `profil` | `urteil` | `fertig` | `abgebrochen` | `fehler`),
  icp (jsonb, Schema `IcpProfile`), einstellungen (jsonb: bestMatchAutomatisch,
  mindestScore, Parallelität), zaehler (jsonb je Schritt: gesamt/offen/fertig/fehler),
  kosten (jsonb: openaiMicroUsd, valueserpMicroUsd, aufrufe), createdAt, updatedAt,
  gestartetAt, beendetAt.
- `VorabFirma`: id, laufId, zeile (Nr. in der Datei), eingabe (jsonb: Name, Ort, PLZ,
  Straße, Land, weitere Spalten roh), abgleich (`treffer` | `unsicher` | `keiner`),
  kandidaten (jsonb: companyId, name, ort, score), companyId (gewählt), zuordnung
  (`automatisch` | `manuell` | `bestmatch` | `offen` | `ausgeschlossen`), website,
  websiteKandidaten (jsonb), websiteUrteil (jsonb: passt, konfidenz, begründung),
  profil (jsonb `MiniProfile`), icpUrteil (jsonb: score 0 bis 100, passt, begründung,
  ausschlussgrund), schritt (letzter erledigter), fehler (text), updatedAt.
- `VorabEreignis`: id, laufId, zeit, schritt, art (`info` | `fehler` | `fortschritt`),
  text, daten (jsonb). Grundlage für die Zeitleiste in der Konsole und für SSE.

`ProxyAudit` und `LlmUsage` bekommen die Lauf-Kennung mit: `LlmUsage.quelle =
"vorab:<laufId>"` (gibt es schon als Spalte), `ProxyAudit.ref` (neue Spalte) für
Valueserp-Aufrufe aus dem Lauf. Kosten je Lauf = Summe dieser Zeilen, echte Beträge
über den Anbieter-Abgleich (docs 2026-10-15).

### 3.2 Schritte je Lauf

0. **Anlegen**: Kundenname, Einstellungen. Datei (xlsx/csv) hochladen, Spalten
   zuordnen (Name, Ort, PLZ, Straße, Land; Vorschlag per Kopfzeile). Zeilen werden
   als `VorabFirma` gespeichert, Duplikate (Name+Ort normalisiert) markiert.
1. **ICP**: Formular wie in der App (alle Felder), Assistent über die Betreiber-Spur
   (Website des Kunden lesen oder Dokument/Freitext verdichten). Ergebnis als jsonb am
   Lauf. Änderbar, bis Schritt 5 läuft; danach "ICP geändert → Urteile neu rechnen".
2. **Abgleich**: Zeilen in Paketen zu 500 an master-data `POST /internal/data-care/
   rows` (neu; gleiche Suche wie Data-Care, Antwort je Zeile: `treffer` mit companyId,
   `unsicher` mit Kandidaten und Score, `keiner`). Eindeutig = ein Kandidat mit Score
   über Schwelle und Ortstreffer. Kein Import, keine Transaktion.
3. **Zuordnung**: Konsole zeigt unsichere Zeilen mit Kandidaten. Entweder je Zeile
   wählen, ausschließen oder "Best Match für alle übernehmen" (höchster Score ab
   Mindestscore, sonst `keiner`). Firmen ohne Treffer bleiben im Lauf (Website-Suche
   funktioniert auch ohne Registereintrag), bekommen aber keine companyId.
4. **Website**: je Firma eine Valueserp-Suche "Name Ort" (Lokalisierung google.de,
   gl=de, hl=de, docs 2026-10-03), Plattform-Sperrliste (LinkedIn, Facebook,
   Instagram, XING, Kununu, Branchenbücher, Marktplätze), bis zu 5 Kandidaten, Judge
   über die Betreiber-Spur (Prompt aus `website-judge.ts`: Name, Ort, Registerdaten
   falls companyId, Snippets). Ergebnis `passt` mit Konfidenz; unter 0,7 → "keine
   Website", Firma scheidet aus (Regel aus docs/PLAN_FIRMEN_OHNE_REGISTER.md: ohne
   eigene Website nie aufnehmen). Parallelität 5, Valueserp-Rate aus Env.
5. **Miniprofil**: Startseite plus bis zu 4 Unterseiten (Über uns, Leistungen,
   Produkte, Kontakt) per fetch, Text wie `profiler.ts`, ein LLM-Aufruf → `MiniProfile`
   (Angebot, Branche, Zielkunden, Größe, Orte, Merkmale). Parallelität 10, Zeitlimit
   20 s je Seite, keine Browser, keine Downloads.
6. **ICP-Urteil**: je Firma ein LLM-Aufruf (Prompt aus `matcher.ts`): Score 0 bis 100,
   `passt`, Begründung in zwei Sätzen, Ausschlussgrund (z. B. Versicherung, Behörde,
   falsche Branche, zu klein). Schwelle einstellbar (Standard 60).
7. **Ergebnis**: Kennzahlen (eingelesen, Duplikate, Treffer, manuell zugeordnet,
   Website gefunden, Profil erstellt, AVA ready), Kosten je Lauf (OpenAI gerechnet und
   laut Rechnung umgelegt, Valueserp je Tarif), Tabelle mit Filtern, Export als CSV
   und xlsx (alle Spalten plus `companyId`, Website, Score, Begründung). Die
   "AVA ready"-Liste enthält companyIds und WEB-Kandidaten (Domain) und ist das, was
   später in einen Import geht, wenn der Kunde unterschreibt. Dieser Übergang bleibt
   bewusst ein getrennter Schritt in der App (import_companies / firma_finden).

### 3.3 Job-Läufer

- Ein Läufer im Gateway-Prozess (`vorabanalyse/laeufer.ts`), startet bei Boot, nimmt
  Läufe mit Status `website` bis `urteil` auf und arbeitet Firmen in Paketen ab
  (`SELECT … FOR UPDATE SKIP LOCKED` auf `VorabFirma`, damit auch zwei
  Gateway-Instanzen sicher wären).
- Je Firma ein Zustandsautomat (website → profil → urteil), Fehler je Firma
  (nicht je Lauf), drei Versuche bei Zeitüberschreitung/5xx, danach `fehler` mit Text.
- Pausieren/Fortsetzen/Abbrechen je Lauf. Lebenszeichen alle 30 s im `VorabEreignis`.
- Alle LLM-Aufrufe über `llmJson` der Betreiber-Spur (festes Modell
  OPERATOR_POOL_MODEL, Antworten mit zod validiert), `quelle = vorab:<laufId>`.
- Budgetbremse je Lauf: maximale Kosten (Standard 150 USD) aus Einstellungen; bei
  Erreichen pausiert der Lauf und meldet es.

### 3.4 Routen (alle nur Betreiber)

- `POST /v1/betreiber/vorabanalyse` (anlegen), `GET /` (Liste), `GET /{id}` (Stand
  mit Zählern und Kosten), `DELETE /{id}` (als gelöscht markieren).
- `POST /{id}/datei` (xlsx/csv, Spaltenzuordnung), `PUT /{id}/icp`,
  `POST /{id}/icp/assistent` (Website/Dokument/Text → Vorschlag).
- `POST /{id}/abgleich` (Schritt 2 starten), `GET /{id}/firmen?filter…&seite`,
  `PUT /{id}/firmen/{firmaId}/zuordnung`, `POST /{id}/bestmatch`.
- `POST /{id}/start` (Schritte 4 bis 6), `POST /{id}/pause`, `POST /{id}/weiter`,
  `POST /{id}/abbrechen`, `POST /{id}/urteile-neu` (nach ICP-Änderung).
- `GET /{id}/events` (SSE: Zähler je Schritt alle 2 s oder bei Änderung, Ereignisse,
  Kosten), `GET /{id}/export.csv`, `GET /{id}/export.xlsx`, `GET /{id}/ava-ready.csv`.
- master-data: `POST /internal/data-care/rows` (JSON-Zeilen, HMAC wie andere
  internal-Routen).

### 3.5 Konsole (admin.ava.bi)

- Navigation "Vorabanalyse" (nurBetreiber), Seite `/vorabanalyse`: Liste der Läufe
  (Kunde, Status, Fortschritt, Kosten, erstellt von), "Neuer Lauf".
- Lauf-Seite als Stufenleiste (7 Schritte) mit Karten je Schritt: Zähler, Balken,
  Dauer, Fehler, Knöpfe des Schritts. Live über SSE (EventSource über den
  `/api/gw`-Durchreicher; der muss Streaming durchlassen), Rückfall Polling 5 s.
- Schritt 3 als Tabelle: Eingabezeile, Kandidaten mit Score und Ort, Auswahl per
  Klick, Filter "nur unsichere", "Best Match für alle".
- Ergebnis: Kennzahlen, Kostenkarte (OpenAI, Valueserp, je Firma), Tabelle mit
  Filtern (AVA ready / ausgeschlossen / ohne Website / Fehler), Begründung je Zeile,
  Export-Knöpfe. Zeitleiste der Ereignisse am Rand.
- Allowlist im Durchreicher: `v1/betreiber/vorabanalyse(/…)?`.

### 3.6 Kosten und Mengengerüst (20.000 Firmen)

| Posten | Menge | Preis | Summe |
|---|---|---|---|
| Valueserp Websuche | 20.000 Suchen | 0,0025 USD | 50 USD |
| Judge | 20.000 Aufrufe, ca. 1.500 Tokens | 0,0008 USD | 16 USD |
| Miniprofil | ca. 14.000 (nur mit Website), ca. 6.000 Tokens | 0,0012 USD | 17 USD |
| ICP-Urteil | 14.000 Aufrufe, ca. 2.500 Tokens | 0,0008 USD | 11 USD |
| Summe | | | ca. 95 USD je Lauf |

Laufzeit: Valueserp 60/min → 20.000 Suchen in gut 5,5 h; Crawl und LLM parallel dazu.
Ein großer Lauf dauert einen Arbeitstag, kleine (2.000) etwa 40 Minuten. Die
Kosten des Laufs stehen live in der Konsole und fließen in "Bestand" als eigener
Posten "Vorabanalysen" (nicht in Kundenkosten, es gibt noch keinen Kunden).

### 3.7 Sicherheit und Grenzen

- Nur Betreiber (Rolle admin), kein Zugriff über MCP oder App.
- Crawl nur per fetch, Loopback und private Netze gesperrt, keine Downloads, maximale
  Seitengröße 2 MB, robots.txt beachten, User-Agent AVA.
- Hochgeladene Dateien werden nach dem Einlesen nicht gespeichert; Zeilen liegen als
  jsonb in `VorabFirma`. Lauf löschen = Zeilen löschen (DSGVO: Interessentendaten).
- Keine Plan-Verweise in Texten der Konsole.

## 4. Umsetzungsphasen

| Phase | Inhalt | Aufwand |
|---|---|---|
| V0 | Tabellen, Migration, Routen anlegen/Liste/Stand, Konsole Liste + "Neuer Lauf", Datei-Upload mit Spaltenzuordnung | 1 Tag |
| V1 | ICP-Schritt: Schema ins geteilte Paket, Formular in der Konsole, Assistent über Betreiber-Spur (Website, Dokument, Text) | 1 Tag |
| V2 | master-data `data-care/rows`, Abgleich in Paketen, Zuordnungstabelle, Best Match | 1 Tag |
| V3 | Job-Läufer, Website-Suche + Sperrliste + Judge, Kosten-Kennung an LlmUsage/ProxyAudit, SSE | 1,5 Tage |
| V4 | Miniprofil-Crawl und Profil, ICP-Urteil, Budgetbremse, Pause/Weiter/Abbruch | 1 Tag |
| V5 | Ergebnisseite, Filter, Begründungen, Exporte, Kostenkarte, Posten in "Bestand" | 1 Tag |
| V6 | Live-Test mit einer echten CRM-Liste (2.000 Zeilen), Feinschliff Schwellen und Prompts | 0,5 Tag |

Gesamt etwa 7 Arbeitstage. Reihenfolge so, dass nach V2 bereits der Abgleich mit
Zuordnung nutzbar ist und nach V4 der ganze Durchlauf.

## 5. Entscheidungen (Joyce, 2026-10-16)

1. Mindestscore "AVA ready" (60) und Judge-Konfidenz (0,7) sind Einstellungen je Lauf.
2. Firmen ohne Registertreffer, aber mit bestätigter Website, gehören in die Liste,
   deutlich markiert (Spalte "Registertreffer" ja/nein, Kennung WEB).
3. Budgetbremse je Lauf 150 USD Standard, je Lauf konfigurierbar.
4. Übergabe in den Import der Kundenorganisation per Knopf, sobald die Organisation
   existiert (Phase V5; nutzt by-ids mit companyIds und firma_finden-Pfad für
   WEB-Kandidaten). Export bleibt daneben bestehen.
5. Keine Obergrenze an Firmen; Läufe bleiben unbegrenzt erhalten (kein automatisches
   Löschen), Löschen nur von Hand.
6. Ergebnis-Artefakt: CSV und Excel mit mindestens "Name" und "Ort" (direkt in AVA
   importierbar), dazu Registertreffer, companyId, Website, Miniprofil, Score,
   Konfidenz, Begründung. Die Excel aus dem Abgleich (Data-Care-Report) wird dabei
   mit überarbeitet: ein Blatt je Ergebnisklasse, Kopfzeile fixiert, Filter, Farben
   je Status, Kandidaten lesbar, Zusammenfassung als erstes Blatt. Sie steht nach dem
   Abgleich zum Download bereit.
