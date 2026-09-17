# Sicherheit: Hintergrund-Browser, Netzwerk-Ports, Downloads

Stand 2026-09-12 (Desktop v0.1.639). Anlass: Rückmeldung eines Windows-Testers
(„AVA hat persistente TCP-/UDP-Inbound-Regeln für alle Ports angelegt“,
„Infected web resource detected: portmann.it, accessed by ava.exe“).

## Befund

1. **Firewall-Regeln.** Die lokalen Producer (Handelsregister, Publikationen,
   Website, Profil, Kontakt, Bewertung) laufen als Node-Kindprozesse von
   `ava.exe` und banden ihre HTTP-API und die Liveness-/Readiness-Probes ohne
   Host, also auf allen Schnittstellen. Windows fragt dann beim ersten Start
   nach und legt für die ausführbare Datei Inbound-Regeln „alle Ports“ an.
   Das war kein eingehender Zugang von außen (die APIs sind JWT-geschützt,
   der Router blockt ohnehin), aber unnötig und für Nutzer alarmierend.
   **Behoben:** Der Desktop setzt `LISTEN_HOST=127.0.0.1`; alle sechs Producer
   binden HTTP-Server und Probes nur noch auf loopback. Postgres, Auth- und
   CRM-Loopback-Server waren bereits auf 127.0.0.1, Ollama ebenso.
   Bestehende Regeln auf Nutzer-Rechnern bleiben, bis sie gelöscht werden;
   neue entstehen nicht mehr.
2. **„Infected web resource“ portmann.it.** Der Firmen-Radar hatte die Domain
   als Kandidat; der Mini-Profil-Crawler hat sie wie jede andere Website
   gelesen. Der Virenscanner hat den Abruf blockiert, AVA hat nichts
   ausgeführt oder gespeichert. Erwartetes Verhalten, keine Lücke.
3. **Downloads.** Bisher gab es keine Sperre: Ein Hintergrund-Fenster hätte
   einen erzwungenen Download (Content-Disposition, Klick eines Agenten)
   durchgelassen. **Behoben**, siehe unten.

## Regeln ab v0.1.639

- **Electron-Fenster** (`main/download-guard.ts`): Auf jeder Sitzung
  (Standard, LinkedIn, Link-Monitor, OAuth, Anmeldung, Mini-Profil-Fetch)
  wird `will-download` abgefangen. Hintergrund-Fenster: jeder Download wird
  abgebrochen, Ausnahme Hosts auf der Allowlist. Hauptfenster: nur eigene
  `blob:`/`data:`-Exporte (CSV) oder Allowlist. Hintergrund-Fenster
  bekommen zusätzlich keine Popups, keine Nicht-http(s)-Navigation und
  keine Web-Berechtigungen. Jeder blockierte Download landet im
  Audit-Protokoll (`download.blocked`).
- **Selenium-Chrome der Producer:** Website- und Publikations-Producer
  setzen `download_restrictions=3` (Chrome blockt jeden Download) und Safe
  Browsing an. Der Handelsregister-Producer braucht Dateidownloads (SI-XML)
  und besucht ausschließlich handelsregister.de; er bleibt die einzige
  Stelle mit Downloads, in ein festes Temp-Verzeichnis.
  **Gesellschafterlisten (seit 2026-09-16, Freigabe des Betreibers):** Für
  Firmen-Verflechtungen lädt derselbe Producer über den DK-Knopf die
  neueste „Liste der Gesellschafter“ (PDF oder ZIP mit TIFF). Die Ausnahme
  gilt wie für die XML-Dateien: nur handelsregister.de, nur nach Klick auf
  den Download-Knopf, in dasselbe Temp-Verzeichnis, höchstens 20 MB, Typ
  wird an den Magic Bytes geprüft (PDF/TIFF/ZIP, ZIP wird im Speicher
  gelesen), die Datei wird nach dem Einlesen gelöscht und nie ausgeführt.
  Nur aktiv, wenn das Org-Feature `verflechtungen` eingeschaltet ist
  (`AVA_VERFLECHTUNGEN=1`). Details: `docs/PLAN_VERFLECHTUNGEN.md` §4.
  **Register-Delta (seit 2026-09-17, Freigabe des Betreibers):** Der
  Delta-Worker (`packages/register-delta`, Fly-Worker und „Mithelfen“ im
  Desktop) lädt in refresh-Jobs den strukturierten Registerinhalt (SI-XML)
  mit. Gleiche Regeln: nur handelsregister.de, nur nach Klick auf „SI“ in
  einer Trefferzeile, eigenes leeres Temp-Verzeichnis je Browser (wird beim
  Schließen entfernt), nur `.xml` bis 5 MB, Inhalt muss als XJustiz-XML
  erkennbar sein, alles andere wird sofort gelöscht, die Datei nach dem
  Lesen ebenfalls. Abschaltbar mit `REGISTER_DELTA_SI=0`; dann gilt wieder
  `download_restrictions=3`. Details: `docs/PLAN_STAMMDATEN_DELTA.md` §8a.
- **Register-Delta-Worker** (seit v0.1.652, Paket `packages/register-delta`,
  Desktop-Einstellung „Stammdaten mitpflegen“ als Opt-in und Betreiber-App
  `ava-register-worker` auf Fly): eigener Selenium-Chrome, headless,
  `download_restrictions=3`, Safe Browsing an, besucht ausschließlich
  handelsregister.de (Erweiterte Suche und Registerbekanntmachungen), lädt
  nichts herunter und öffnet keinen Port. Kindprozess des Desktops mit
  Bearer-Token aus einer Datei mit Rechten 600 im userData-Verzeichnis;
  höchstens 60 Abfragen je Stunde (Nutzungsordnung des Registerportals).
  Details: `docs/PLAN_STAMMDATEN_DELTA.md`.
- **Allowlist** (`DOWNLOAD_ALLOW_HOSTS`): `handelsregister.de`,
  `unternehmensregister.de` inkl. Subdomains. Erweiterung nur mit
  Begründung hier im Dokument.

## Was weiterhin gilt

- Producer-APIs verlangen ein Keycloak-JWT; ohne Token 401.
- Kein Prozess von AVA nimmt Verbindungen von außerhalb des Rechners an.
- Ausgehend: Gateway (Frankfurt), KI-Anbieter des Nutzers, öffentliche
  Quellen (Register, Firmenwebsites, Google-Suche über das Gateway).

## Nachtrag 2026-09-15: Österreich ohne Browser

Die Job-Arten `at_front`, `at_refresh` und `at_insolvenz` (Firmenbuch
JustizOnline, Ediktsdatei) laufen über reine HTTP-GETs mit `fetch` im
Worker-Prozess: kein BrowserWindow, kein Selenium, kein Download. Die
Antworten sind JSON beziehungsweise HTML-Text, der nur geparst wird.
Damit gilt die Allowlist der Hintergrund-Browser dafür nicht; die
Domains sind `justizonline.gv.at` und `edikte.justiz.gv.at`.

## Nachtrag 2026-09-15: UK ohne Browser

`uk_bulk`, `uk_refresh` und `uk_insolvenz` laufen wie Österreich über
`fetch`: Companies House (`download.companieshouse.gov.uk`,
`find-and-update.company-information.service.gov.uk`) und The Gazette
(`thegazette.co.uk`). Der Monatsabzug wird als ZIP nach `/tmp` geladen,
gestreamt und danach gelöscht; es wird nichts ausgeführt und nichts in
den Nutzerordner geschrieben.
