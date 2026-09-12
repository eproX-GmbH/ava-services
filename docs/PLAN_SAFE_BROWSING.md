# Plan: Safe-Browsing-Vorprüfung für alle Website-Abrufe

Stand 2026-09-12 (Desktop v0.1.640). Bestandsaufnahme vor der Umsetzung.
Anlass: Virenscanner-Alarm bei einem Tester (portmann.it, Radar-Crawler).

## 1. Bestandsaufnahme: Wo AVA fremde Websites öffnet

Nicht gemeint sind Aufrufe unserer eigenen Dienste (Gateway, master-data),
KI-Anbieter, HubSpot/Notion/Telegram/Apify-APIs, Keycloak, GitHub-Updates
und Ollama. Die tauchen in der Code-Suche auf, sind aber feste, bekannte
Endpunkte.

### Desktop (Electron, Main-Prozess)

| Nr. | Stelle | Was wird geöffnet | Womit | Prüfung nötig |
|---|---|---|---|---|
| D1 | `discovery/profiler.ts` `crawlSite` | Startseite + bis 4 Unterseiten + Datenschutzerklärung jedes Radar-Kandidaten | `fetch` (Node), bei dünnem HTML Fallback D2 | ja, Kernfall |
| D2 | `discovery/profiler.ts` `fetchTextViaBrowser` | dieselbe Seite gerendert | verstecktes BrowserWindow (Partition `ava-bg-fetch`) | ja, über D1 |
| D3 | `discovery/scan.ts` | keine Website; Overpass/OSM, Gateway (Google-Suche über Proxy), Register | `fetch` | nein, aber: hier entstehen die Kandidaten, deren Domains geprüft werden müssen |
| D4 | `link-monitor/browser.ts` `loadURL` | vom Nutzer beobachtete URLs (beliebige Domains) und LinkedIn | verstecktes BrowserWindow | ja (Nicht-LinkedIn-URLs) |
| D5 | `linkedin/scraper-window.ts`, `login-window.ts`, `personen-radar/*` | ausschließlich linkedin.com bzw. Apify-API | BrowserWindow / fetch | nein (feste Domain) |
| D6 | `telegram/audio.ts` | nur `data:`-Seite zum Dekodieren | BrowserWindow | nein |
| D7 | `index.ts` Window-Open-Handler + `shell.openExternal` (Renderer-Links `ExternalLink`, Firmen-Website, Belegseiten, Mail-Links) | beliebige URL im Standardbrowser des Nutzers | OS-Browser | optional: Warnhinweis vor dem Öffnen, wenn Verdikt „unsicher“ (der Browser des Nutzers prüft selbst) |
| D8 | `mail/*` | öffnet keine Links selbst | – | nein |
| D9 | Chat-Tools (`agent/tools/*`) | kein Tool ruft beliebige URLs ab (nur Gateway, Ollama) | – | nein |

### Producer (Node-Kindprozesse, Selenium/Chrome oder fetch)

| Nr. | Producer | Stelle | Was wird geöffnet | Prüfung nötig |
|---|---|---|---|---|
| P1 | website | `utils/website-utils.ts` `axios.get(url)` | Firmenwebsite (aus Suche/Stammdaten) | ja |
| P2 | website | `utils/browser-fetch.ts` `d.get(url)` | Firmenwebsite gerendert (Selenium) | ja |
| P3 | website | `public-companies-extractor` | nur valueserp (Suche) | nein |
| P4 | company-profile | `utils/browser-fetch.ts` `d.get(url)` | Firmenwebsite | ja |
| P5 | company-contact | `contact-extraction/browser-fetch.ts` `d.get(url)` | Firmenwebsite | ja |
| P6 | company-contact | `contact-extraction/company-contact-extraction.ts` `fetch(url)` + `crawl-priorisierung.ts` | Unterseiten (Team, Impressum, Kontakt) | ja, gleiche Domain wie P5, einmal je Domain reicht |
| P7 | company-contact | `apify-company.ts` | Apify-API | nein |
| P8 | company-evaluation | – | keine Website-Abrufe (arbeitet auf Daten anderer Producer) | nein |
| P9 | structured-content | Webdriver | nur handelsregister.de | nein (Allowlist) |
| P10 | company-publication | Webdriver | nur unternehmensregister.de | nein (Allowlist) |

### Gateway

| Nr. | Stelle | Was | Prüfung nötig |
|---|---|---|---|
| G1 | `routes/v1/proxy.ts` | valueserp (Google-Suche) | nein |
| G2 | `lib/discovery.ts` `addCandidates` | legt Kandidaten mit Domain an | hier Verdikt anfordern und speichern |
| G3 | Kontakt-/Website-Persist | speichert Ergebnisse, ruft nichts ab | nein |

Ergebnis: **sieben Abrufstellen** brauchen die Prüfung (D1/D2, D4, P1, P2, P4,
P5/P6), plus eine Erzeugungsstelle (G2) und ein optionaler Warnhinweis (D7).

## 2. Architektur

**Eine Prüfstelle im Gateway, alle anderen fragen dort nach.**

- `POST /v1/safe-browsing/check` mit `{ urls: string[] }` (bis 100).
  Antwort je URL: `{ url, host, verdikt: "sicher" | "unsicher" | "unbekannt",
  bedrohung?: string, geprueftAt }`.
- Gateway-Tabelle `SafeBrowsingVerdict(host, verdikt, bedrohung, checkedAt)`,
  Cache 7 Tage (unsicher: 1 Tag, damit bereinigte Seiten schneller
  freikommen). Abfrage bei Google Safe Browsing Lookup API v4
  (`threatMatches:find`, Typen MALWARE, SOCIAL_ENGINEERING,
  UNWANTED_SOFTWARE, POTENTIALLY_HARMFUL_APPLICATION), Betreiber-Schlüssel
  `SAFE_BROWSING_API_KEY`. Ohne Schlüssel: Verdikt „unbekannt“, kein Block.
- Prüfeinheit ist der Host (eTLD+1 plus Subdomain), nicht die einzelne
  URL; das deckt Unterseiten mit ab und hält die Zahl der Abfragen klein.
- Rückmeldung ist **fail-open**: Ist das Gateway oder Google nicht
  erreichbar, wird nicht blockiert, nur protokolliert. Begründung: Ein
  Ausfall der Prüfung darf nicht die gesamte Verarbeitung anhalten; die
  Download-Sperre bleibt als zweite Schicht.

**Desktop-Helfer** `main/safe-browsing.ts`: `pruefeUrl(url)` mit lokalem
Cache (1 h), ruft die Gateway-Route. **Producer-Helfer** (gleicher Code in
`packages/`?): Producer haben `GATEWAY_URL` und das Nutzer-JWT bereits
(Muster `apifyUeberGateway` in company-contact), also derselbe Aufruf.

## 3. Änderungen je Stelle

1. **G2 Kandidaten-Anlage:** nach dem Insert Hosts der neuen Kandidaten in
   einem Batch prüfen, Spalte `DiscoveredCompany.unsafeAt` / `unsafeGrund`
   setzen. `candidates`-Liste liefert `unsicher: boolean`.
2. **D1/D2 Mini-Profile:** Kandidaten mit `unsicher` überspringen (Grund im
   Radar-Popup: „Website als unsicher gemeldet, nicht abgerufen“), plus
   Prüfung vor dem Abruf für Altbestand ohne Verdikt.
3. **Radar-Tabelle:** Badge „unsicher“, kein Website-Link, Import nur mit
   ausdrücklicher Bestätigung.
4. **D4 Link-Monitor:** vor `loadURL` prüfen; unsicher → Eintrag im
   Monitor-Status „nicht abgerufen: Website als unsicher gemeldet“.
5. **P1/P2 website, P4 company-profile, P5/P6 company-contact:** vor dem
   ersten Abruf je Domain prüfen; unsicher → Stufe als `skipped` mit
   Grund, keine Zeitüberschreitung, kein Fehler. Kaskade wie bei
   Register-Fehlern läuft weiter.
6. **D7 externe Links (optional, zweite Stufe):** vor `shell.openExternal`
   Verdikt aus dem Cache; „unsicher“ → Bestätigungsdialog.
7. **Einmalige Nachprüfung** aller bestehenden Kandidaten-Hosts per
   Gateway-Job (Batches zu 500, innerhalb des Tageskontingents).
8. **Chat-Tool** `radar_config`/Status um „Website-Prüfung: aktiv/kein
   Schlüssel“ ergänzen; Self-Service-Regel.

## 4. Voraussetzungen

- Google-Cloud-Projekt mit aktivierter „Safe Browsing API“, API-Schlüssel,
  als Fly-Secret `SAFE_BROWSING_API_KEY` am Gateway. Kostenlos bis 10.000
  Abfragen je Tag; ein Enterprise-Radar mit 1.200 neuen Firmen am Tag
  liegt weit darunter.
- Gateway-Deploy, Desktop-Release, drei Producer-Releases (website,
  company-profile, company-contact).

## 5. Grenzen

- Google listet nur, was Google kennt; herstellerspezifische Listen
  (Bitdefender, Kaspersky) bleiben außen vor. Fehlalarme einzelner Scanner
  verhindert das nicht, dafür die echten Treffer.
- Prüfung je Host: Eine einzelne kompromittierte Unterseite auf einem
  sonst sauberen Host wird nur erkannt, wenn Google den Host listet.
