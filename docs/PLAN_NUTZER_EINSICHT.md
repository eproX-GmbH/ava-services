# Nutzer-Einsicht in der Betreiber-Konsole

Stand: 2026-11-11 · Anlass: Joyce sah Alessandro in „Aktive Nutzer“ als „aktiv“, obwohl er seit dem 08.11.
nichts mehr selbst getan hatte. Gemessen wurde jede Anfrage, auch reine Hintergrundarbeit der App (Relais-
Neuverbindung eines schlafenden Rechners). Ziel: sehen, WAS Nutzer tun, und eingreifen können.

## 1. Befund (vorher)

- `NutzerAktivitaet` hatte eine Zeile je Nutzer: letzte Anfrage, Gerät, Version, „Minuten mit Anfrage“.
- Jede angemeldete Anfrage zählte: Producer, Auffrischung, Relais, Connector-Abfragen (`tools/list` von Claude),
  Register-Helfer. „Gerät“ war das zuletzt anfragende Gerät (bei Joyce „MCP (Claude)“ statt Desktop).
- Alte Apps (vor v0.1.940) senden `x-ava-version` nicht → Version leer, obwohl das Relais sie kennt.
- Fallbeispiel Alessandro: v0.1.930, Relais verbindet etwa alle 25 Minuten neu und wird nach 60 s ohne Pong
  getrennt; letzte eigene Handlung 08.11. 23:14 (Firmenansicht); 1.426 „aktive Minuten“ fast nur Hintergrund.

## 2. Stufe 1 (gebaut 2026-11-11)

Gateway:
- Neue Spalten `genutztAt`, `genutztArt`, `nutzungMinuten` (Migration `20261111_nutzer_nutzung`).
  `vermerkeNutzung` schreibt bei Handlungen eines Menschen:
  - Relevanz-Signale der App (Firma angesehen, importiert, Chat zu einer Firma, CRM, Watchlist …),
  - MCP `tools/call` (nicht `initialize`/`tools/list`), Text „MCP (Claude): firma_lesen“,
  - A2A-Auftrag („A2A: skill“), App-Chat (`/v1/app/anfrage/senden|bild`),
  - Chat über den Organisationsschlüssel (`LlmUsage.channel = chat`), Sprachmodus,
  - neue Route `POST /v1/nutzung {art: chat, kanal}`: die Desktop-App meldet je Nachricht eines Menschen den
    Kanal (Desktop, Telegram, App, Sprache), ohne Inhalt. Nötig für Chats mit eigenem Schlüssel/ChatGPT-Abo.
- „Aktiv“ = `genutztAt` in den letzten 15 Minuten; „online“ = irgendeine Anfrage darin.
- Gerät = AVA-App; Connector und Browser überschreiben ein Desktop-/Server-Gerät nicht mehr.
- Version zusätzlich aus der Relais-Anmeldung; Liste liefert `neuesteVersion` (Registry) für den Rückstand.
- Kosten je Nutzer: echte Anbieterkosten aus `LlmUsage.costMicroUsd` + `ProxyAudit.kostenMicroUsd`
  (30 Tage, 7 Tage, seit Erfassung), Kosten je Minute mit Aktivität, Monats-Hochrechnung (7 Tage × 30/7).
- Sperre durch das AVA-Team: `KontoStatus.art = 'gesperrt'` (+ `von`), `PUT /v1/betreiber/nutzer/{id}/sperre`.
  Gateway weist alle Anfragen mit `konto_gesperrt` ab (Cache 60 s je Maschine, eigene Maschine sofort),
  Keycloak schaltet die Anmeldung aus und beendet die Sitzungen, offene Relais-Verbindungen werden getrennt.
  Entsperren hebt nur `gesperrt` auf, nie eine Löschung/Deaktivierung. Sich selbst sperren geht nicht.

Desktop (mit dem nächsten Release): Orchestrator meldet je `send()` (Desktop, App, Sprache) und je
Telegram-Nachricht den Kanal. Notizen des Aufgaben-Wächters, Mails und Hintergrundläufe zählen nicht.

Konsole: Spalten Zuletzt genutzt (mit Art), AVA-App (Gerät, Version, online, Rückstand), Seit,
Minuten genutzt/gesamt, Kosten 30 Tage (≈ Monat, je Minute), Zugang (Schalter mit Rückfrage).

So sieht die Sperre beim Nutzer aus: Die nächste Anfrage ans Gateway scheitert, beim nächsten Token-Abgleich
(spätestens nach Ablauf des Zugriffstokens, wenige Minuten) lehnt Keycloak ab, die App meldet sich ab und
zeigt den Anmeldebildschirm; eine neue Anmeldung scheitert. Lokale Daten bleiben. Chat mit eigenem
KI-Schlüssel ist dann nicht mehr erreichbar, weil die ganze Oberfläche hinter der Anmeldung liegt.
Lücke: Der Telegram-Empfang läuft im Hauptprozess weiter (beim Abmelden wird er nicht gestoppt). Mit eigenem
KI-Schlüssel antwortet AVA dort also noch, kann aber auf nichts am Gateway zugreifen (Firmen, Kontakte,
Meldungen scheitern). Fix in §4.

## 3. Stufe 2: Detailansicht je Nutzer (Vorschlag, nicht gebaut)

- Tageswerte der letzten 14 Tage in einer neuen Tabelle `NutzerTag (actorId, tag, art, anzahl)`, beim
  `vermerkeNutzung` hochgezählt (Upsert, gedrosselt): Chat je Kanal, MCP je Werkzeug, Firmen angesehen/
  importiert, Workflow-Läufe; Hintergrund getrennt (Verarbeitungsschritte je Producer aus `LlmUsage.quelle`,
  Register-Helfer-Jobs aus `RegisterWorker`, Auffrischungen).
- KI-Kosten je Tag und Art (Chat, Verarbeitung, Recherche, Apify, Websuche) aus den vorhandenen Tabellen.
- Konsole: Klick auf einen Nutzer öffnet die Detailansicht (Balken je Tag, Liste der letzten 50 Handlungen
  mit Zeit und Art, keine Inhalte).
- Aufwand: Gateway ½ Tag, Konsole ½ Tag.

## 4. Stufe 3: Hinweise am Nutzer (Vorschlag)

- „Update hängt“: Version mehr als 5 Versionen zurück und seit 3 Tagen unverändert.
- „Verbindung bricht ständig ab“: mehr als 10 Relais-Trennungen „kein Pong“ in 24 h (Zähler im Relais).
- „Nur Hintergrund“: online, aber seit 7 Tagen keine Nutzung (Kandidat für Nachfassen oder Ruhen).
- Abmelden stoppt Hintergrundkanäle: Telegram-Empfang und Mail-Triage beim Status „abgemeldet“ anhalten,
  bei erneuter Anmeldung wieder starten (Desktop, klein).

## 5. Offene Entscheidungen (Joyce)

1. **Datenschutz:** Erfasst werden Zeitpunkt und Art der Nutzung (Kanal, Werkzeugname, „Firma angesehen“),
   keine Inhalte. Satz in der Datenschutzerklärung ergänzen? Vorschlag: ja, unter „Betrieb und Abrechnung“.
2. **Aufbewahrung:** Tageswerte (Stufe 2) 90 Tage, danach löschen? Vorschlag: 90 Tage.
3. **Sperre melden:** Soll der gesperrte Nutzer eine Mail bekommen („Dein Zugang wurde gesperrt“)?
   Vorschlag: nein, Sperre ist ein Betreiber-Werkzeug für Missbrauch/Nichtzahlung; Kontakt läuft persönlich.
4. **Organisations-Admins:** Sollen Orga-Admins die Nutzung ihrer Mitglieder (ohne Kosten) sehen?
   Vorschlag: später, nach Stufe 2.
