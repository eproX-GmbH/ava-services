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
- **Allowlist** (`DOWNLOAD_ALLOW_HOSTS`): `handelsregister.de`,
  `unternehmensregister.de` inkl. Subdomains. Erweiterung nur mit
  Begründung hier im Dokument.

## Was weiterhin gilt

- Producer-APIs verlangen ein Keycloak-JWT; ohne Token 401.
- Kein Prozess von AVA nimmt Verbindungen von außerhalb des Rechners an.
- Ausgehend: Gateway (Frankfurt), KI-Anbieter des Nutzers, öffentliche
  Quellen (Register, Firmenwebsites, Google-Suche über das Gateway).
