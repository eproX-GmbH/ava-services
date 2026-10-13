# Was kostet uns die Verarbeitung einer Firma? Kalkulation und Preisvorschlag (2026-10-13)

Auftrag: Alle Kostenfaktoren je verarbeiteter Firma ermitteln, in drei Stufen (klein,
mittel, groß) einteilen, daraus einen tragfähigen Pay-as-you-go-Preis und ein
Seat-Modell mit Guthaben ableiten (Vorbild Apify, Microsoft Copilot).

Datenbasis: Gateway-Tabellen `ProxyAudit` (valueserp-Aufrufe), `LlmUsage` (Modellaufrufe
über den Organisationsschlüssel), `UsageEntry` (verarbeitete Firmen je Monat), Kontakt-
Datenbank `Observation`/`Employment` (Quelle und Zahl der Personen je Firma), Fly-Maschinen
(`fly machine list`), Quellcode der Producer (Abfragen je Firma), Marktpreise (Quellen unten).

## 1. Welche Kosten entstehen überhaupt

| Kostenblock | Wer zahlt heute | Entsteht wo | Verhalten |
|---|---|---|---|
| **valueserp** (Google-Suche über `/v1/proxy/valueserp`) | Operator (einziger Operator-Schlüssel) | Website-Producer (1 Suche je Firma), Kontakt-Producer (SERP-Rückfall 6 Suchen, wenn der Crawl < 5 Personen fand und kein Apify-Profil; LinkedIn-URL-Suche je Person auf Anfrage), Radar-Scans (je Suchgebiet, nicht je Firma), `firma_finden` (1 Places-Abfrage) | variabel je Firma, gedeckelt |
| **Apify** (LinkedIn-Firmenprofil, Mitarbeiter) | heute Nutzer (BYOK) bzw. Organisationsschlüssel, **mittelfristig Operator** | Kontakt-Producer: Firmensuche (1 Lauf), Firmendetails (1 Lauf), Mitarbeiter-Fenster 100 (+ gezielter Zweitlauf 25 bei großen Firmen ohne Führungsrolle im Fenster) | variabel, **durch das Fenster hart gedeckelt** |
| **LLM** (Profil, Kontakte, Alarme, E-Mail-Urteil, Radar) | Nutzer: lokales Ollama, eigener Schlüssel, ChatGPT-Abo oder Organisationsschlüssel. **Nicht Operator** | alle Producer, Heartbeat/Alarme, Chat | größter Posten, wenn man ihn übernähme (siehe §3) |
| **Rechenzeit** (Crawl, Register-Scrape, Selenium, Embeddings) | Nutzer (läuft auf seinem Rechner, Compute-Lokalität) | Producer, Register-Delta „Mithelfen“ | 0 € für uns |
| **Betreiber-Infrastruktur** (Fly, Managed Postgres, Elastic, CloudAMQP, Keycloak, Register-Worker) | Operator | fix je Monat | unabhängig von der Firmenzahl, siehe §4 |
| **Zeitabhängige Folgekosten** (Auffrischung alle 30–90 Tage je Stufe, Alarm-Heartbeat, Insolvenz-/Register-Delta) | Operator (valueserp/Apify) + Nutzer (LLM) | je Firma im Bestand, wiederkehrend | Eine Firma kostet nicht einmal, sondern **laufend**: die Website-Stufe läuft nach 30 Tagen erneut (1 Suche), der Kontakt-Producer nach 30–90 Tagen (Apify erneut) |

Was **nicht** anfällt: Handelsregister (SI/CD kostenlos), Unternehmensregister, Companies House,
Firmenbuch AT (Nutzer-Rechner), Deep Research (nur OpenAI-Schlüssel des Nutzers).

## 2. Gemessene Mengen (Produktion, 60 Tage bis 2026-10-13)

| Größe | Wert | Quelle |
|---|---|---|
| Verarbeitete Firmen | Sept. 119, Okt. (bis 13.) 40, zusammen 159 | `UsageEntry` |
| valueserp-Aufrufe | Sept. 2.625 (davon 999 Cache-Treffer), Okt. 852 (276 Cache) | `ProxyAudit` |
| valueserp je Firma **brutto** (inkl. Radar-Scans und Cache) | Sept. 22, Okt. 21 | Rechnung |
| valueserp je Firma **netto** (nur zahlungspflichtig, ohne Radar, aus dem Code) | Website 1–2, Kontakt 0–6 (Rückfall), LinkedIn-URL 0–10 → **2–18** | Producer-Code |
| Firmen mit Apify-Pfad (LinkedIn-Profil sicher zugeordnet) | 36 von 159 (23 %); 9.494 Beobachtungen → ~50 Personen je Firma | `Observation` |
| Personen je Firma (aktuell beschäftigt) | Median 8, 90. Perzentil 52, Maximum 95 | `Employment` |
| LLM Hintergrund (Producer + Alarme), Organisationsschlüssel | Sept. 18.937 Aufrufe, 144 $; Okt. 6.270 Aufrufe, 17,65 $ | `LlmUsage` |
| LLM Hintergrund **je Firma** | Sept. 159 Aufrufe, **1,21 $**; Okt. 157 Aufrufe, **0,44 $** (günstigere Modelle) | Rechnung |
| LLM Chat (nicht firmenbezogen) | Sept. 56 $, Okt. 19 $ | `LlmUsage` |
| Teuerstes Modell | gpt-5.6-luna: 18.926 Aufrufe, 128 $ (0,0068 $/Aufruf); gpt-6.1-sol 0,0029 $/Aufruf | `LlmUsage` |

Wichtig: Die Apify-Mengen stehen nicht im Gateway (Aufrufe liefen mit dem Organisations-
token durch; `LlmUsage` zählt 385 Aufrufe ohne Kosten). Der Apify-Kostenblock unten ist aus
Aktor-Preisen und Fenstergrößen gerechnet, nicht gemessen.

## 3. Kosten je Firma in drei Stufen

Preise: valueserp 2,50 $/1.000 (Pay-as-you-go) bzw. 1,60 $/1.000 (Plan 25.000/Monat, 50 $);
Apify-Aktoren harvestapi: Mitarbeiter „Short“ 4 $/1.000 Ergebnisse (laut Code-Kommentar
2026-08-31; Vergleichsseiten nennen 1,50–3 $/1.000 für Basisprofile), Firmensuche/-details
3 $/1.000, Startgebühr 0,02 $ je Lauf, Plattform-Rechenzeit 0,20 $/CU (Free/Starter);
Wechselkurs 1 $ ≈ 0,92 €.

| Stufe | Kriterien | valueserp | Apify (wenn Operator zahlt) | **Direkte Kosten je Verarbeitung** | LLM, falls Operator zahlen würde |
|---|---|---|---|---|---|
| **klein** | kein LinkedIn-Firmenprofil zuordenbar oder Free-Plan ohne Apify; Website-Crawl + SERP-Rückfall; ≤ 10 Personen | 2–8 Suchen → 0,5–2 ct | 0 | **≈ 0,02 €** | 0,20–0,60 € |
| **mittel** | LinkedIn-Profil zugeordnet, Mitarbeiter-Fenster 100 genügt; 10–50 Personen | 2–10 Suchen → ≤ 2,5 ct | Suche 0,02 + Details 0,02 + 100 × 0,004 = 0,40 + Startgebühren 0,06 + CU ≈ 0,03 → **≈ 0,53 $ = 0,49 €** | **≈ 0,52 €** | 0,40–1,20 € |
| **groß** | Fenster voll ohne Führungsrolle → Zweitlauf 25; viele LinkedIn-URL-Suchen; 50–95 Personen; Konzern mit Konzernabschluss | 10–20 Suchen → 2,5–5 ct | wie mittel + 25 × 0,004 + 0,02 ≈ **0,65 $ = 0,60 €** | **≈ 0,65 €** | 0,60–1,50 € |

Erkenntnisse:

1. **„25× Deutsche Bank“ ist kein Kostenrisiko mehr, als es scheint.** Das Mitarbeiter-Fenster
   deckelt Apify bei 100 (+25) Ergebnissen je Firma; eine Deutsche Bank kostet uns bei Apify
   dasselbe wie ein Mittelständler mit 120 Mitarbeitern (≈ 0,60 €). 25 Läufe ≈ 15 €. Der
   eigentliche Treiber ist der **LLM-Aufwand**, und der liegt heute beim Nutzer.
2. **valueserp ist vernachlässigbar** (unter 5 ct je Firma), selbst mit Radar-Scans. Ein
   25.000er-Plan (50 $/Monat) reicht für ~1.500 Firmen inklusive Radar.
3. **Apify ist der einzige nennenswerte Direktkostenblock**, wenn wir ihn übernehmen: ≈ 0,50–0,60 €
   je Firma mit LinkedIn-Profil, 0 € ohne. Im Bestand hatten 23 % der Firmen ein zugeordnetes
   Profil; Hochrechnung über alle Firmen ≈ 0,15 € je Firma. Dazu kommt die Auffrischung
   (Kontakt-Stufe alle 90 Tage): je Bestandsfirma mit Profil ≈ 0,20 €/Monat laufend.
4. **LLM je Firma: 0,44–1,21 $**, je nach Modell; rund 160 Modellaufrufe je Firma (Profil,
   Kontakte, E-Mail-Urteil, Alarme). Übernähmen wir das Modell, wäre es der größte Posten und
   schwer zu deckeln. Empfehlung: LLM bleibt beim Nutzer (lokal, eigener Schlüssel, ChatGPT-Abo).
   Hebel, falls doch: Standardmodell gpt-6.1-sol statt luna (Faktor 2,3) und weniger Aufrufe je Firma.

## 4. Fixkosten des Betreibers (Monat, Schätzung nach Fly-Listenpreisen)

| Posten | Größe | ≈ $/Monat |
|---|---|---|
| ava-db-gateway | shared-1cpu, 512 MB | 3,19 |
| ava-master-data | shared-1cpu, 1 GB | 5,70 |
| ava-register-worker | shared-1cpu, 2 GB (läuft) + 2 gestoppte Maschinen (nur Rootfs) | ≈ 11 |
| headless-ava (Operator-Instanz) | shared-2cpu, 4 GB + Volume | ≈ 23 |
| ava-router (2×), ava-pgbouncer | 3 × 256 MB | ≈ 6 |
| Keycloak | shared-2cpu, 1 GB | ≈ 7,5 |
| Managed Postgres „Basic“ ava-db | 1 Replikat, 20 GB | 38 + 6 = 44 |
| Elasticsearch Serverless | monatlicher Sammel-Abgleich | **unbekannt (bitte Rechnung einsetzen)** |
| CloudAMQP | Plan unbekannt | **unbekannt (0–19)** |
| GitHub Actions | Repo public | 0 |
| **Summe Fly + MPG** | | **≈ 100 $ ≈ 92 €** (+ Elastic + CloudAMQP) |

Je Kundeninstanz in der Cloud (`<slug>.ava.bi`, headless-ava-Muster) kommen ≈ 35–40 $/Monat
dazu (4-GB-Kopf + Embedding-Sidecar); das ist ein Enterprise-/Cloud-Zuschlag, kein Seat-Preis.

## 5. Preisvorschlag

### 5.1 Grundsatz

Direktkosten je Firma liegen zwischen 2 ct und 65 ct. Ein tragfähiger Preis muss zusätzlich
die laufende Auffrischung (≈ 20 % der Erstkosten je Monat), Fixkosten, Support, Fehlläufe
(Wiederholungen kosten erneut) und Marge tragen. Üblich für datengetriebene SaaS: Bruttomarge
auf Direktkosten 80–90 %. Daraus:

| Stufe | Direktkosten | **Pay-as-you-go-Preis je Verarbeitung** | Marge auf Direktkosten |
|---|---|---|---|
| klein | ≈ 0,02 € | **0,50 €** | 96 % |
| mittel | ≈ 0,52 € | **2,00 €** | 74 % |
| groß | ≈ 0,65 € | **3,50 €** | 81 % |

Die Stufe entscheidet sich **nach** dem Lauf aus Fakten (LinkedIn-Profil zugeordnet? Fenster
voll? Personenzahl), nicht aus dem Firmennamen. Vorher sieht der Nutzer „0,50–3,50 € je Firma“.
Auffrischungen werden als eigene Verarbeitung der jeweiligen Stufe berechnet (die Firmenansicht
zeigt den Zeitpunkt; der Nutzer kann die Auffrischung je Stufe abschalten, das gibt es bereits).

Alternative mit einfacher Kommunikation: **ein Preis 1,50 € je Firma** (Mischkalkulation bei
23 % Apify-Anteil: Direktkosten ≈ 0,15 €, Marge 90 %). Einfacher zu erklären, aber der Pro-
Nutzer mit vielen LinkedIn-Firmen subventioniert sich über Free-Nutzer; bei Apify-Anteil > 60 %
kippt die Marge unter 70 %.

### 5.2 Seats mit Guthaben (Planbarkeit)

| Plan | Preis/Monat | enthaltenes Verarbeitungsguthaben | reicht für (mittel) | Apify (LinkedIn) | darüber hinaus |
|---|---|---|---|---|---|
| **Free** | 0 € | 25 Firmen lebenslang (wie heute) | 25 | **nein** (nur Website-Crawl + SERP-Rückfall; Stufe klein) | Upgrade |
| **Starter** | 49 € | 40 € Guthaben ≈ 20–80 Firmen | 20 | ja | Pay-as-you-go zum Stufenpreis, Deckel durch Kontingent (heute 500) |
| **Pro** | 149 € | 130 € Guthaben ≈ 65–260 Firmen | 65 | ja | wie Starter, Kontingent 2.000 |
| **Enterprise** | nach Vereinbarung | Guthaben nach Vereinbarung, Cloud-Instanz + 40 € | | ja | |

Warum so:

- **Free kostet uns maximal 25 × 0,02 € + Auffrischung ≈ 1 € je Nutzer**, wenn Apify im
  Free-Plan aus bleibt. Mit Apify wären es bis zu 16 € je Free-Nutzer, plus Wiederholungen.
  Deshalb: Free ohne LinkedIn-Mitarbeiterbeschaffung, klar als Plan-Unterschied kommuniziert
  („Kontakte von der Website; LinkedIn-Kontakte ab Starter“).
- Starter/Pro: Das Guthaben ist nicht übertragbar (Monat), Pay-as-you-go darüber zum Stufenpreis.
  Die heutigen Kontingente (500/2.000 Firmen) bleiben als Sicherheitsdeckel gegen
  Durchläufer, nicht als Leistungsversprechen.
- Deckungsbeitrag bei realistischer Nutzung: Starter-Nutzer mit 60 mittleren Firmen/Monat →
  Direktkosten ≈ 31 € + Auffrischung ≈ 6 € = 37 €, Umsatz 49 € + Überschreitung (60 − 20) ×
  2 € = 129 €. Pro-Nutzer mit 200 mittleren Firmen → Kosten ≈ 125 €, Umsatz 149 € + 270 € = 419 €.
  Ohne Überschreitung (Nutzer bleibt im Guthaben) bleibt die Marge bei ≥ 60 %.

### 5.3 Was vor der Einführung noch fehlt

1. **Kosten je Firma messen statt rechnen:** `ProxyAudit` und `LlmUsage` um `companyId` und
   `stufe` ergänzen; Apify-Läufe (Lauf-ID, Ergebniszahl, Preis aus der Apify-Antwort) je Firma
   protokollieren. Erst dann sind Stufenpreise belegbar, und die Rechnung kann je Firma eine
   Zeile zeigen.
2. **Apify-Preise im Apify-Console prüfen** (Pricing-Tab der drei harvestapi-Aktoren); die
   Code-Kommentare sind vom 31.08.2026, Vergleichsseiten nennen inzwischen andere Sätze.
3. **Elastic- und CloudAMQP-Rechnung** in §4 eintragen (Fixkostenboden).
4. **Stufen-Zuordnung im Gateway** (nach dem Lauf: Apify ja/nein, Fenster voll, Personenzahl)
   und Anzeige am Vorgang; Guthabenstand in der App und im Chat (Self-Service-Regel).
5. **Entscheidung:** Stufenpreise (0,50/2,00/3,50 €) oder Einheitspreis (1,50 €).

## Quellen (Marktpreise)

- valueserp: [Traject Data](https://trajectdata.com/?p=2156), [CostBench ValueSERP](https://costbench.com/software/ai-search-apis/valueserp/), [apiserpent (Wettbewerber)](https://apiserpent.com/blog/valueserp-alternative)
- Apify-Aktoren und Plattform: [apiserpent Apify LinkedIn Pricing](https://apiserpent.com/blog/apify-linkedin-scraper-pricing-explained), [scrapecreators](https://scrapecreators.com/blog/linkedin-company-scrapers), [use-apify Pricing](https://use-apify.com/docs/what-is-apify/apify-pricing), [CostBench Apify](https://costbench.com/software/web-scraping/apify/)
- Fly.io: [Resource Pricing](https://fly.io/docs/pricing/), [Managed Postgres](https://fly.io/docs/mpg)
