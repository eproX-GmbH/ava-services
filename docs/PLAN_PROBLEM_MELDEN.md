# Plan: „Problem melden“ mit Geräte-Snapshot und Triage-Center

Stand 2026-11-02 (Joyce). Noch nicht gebaut. Ziel: Ein Nutzer meldet ein Problem aus der
Desktop-App (Knopf unten links im Chat oder Chat-Werkzeug), die App legt automatisch einen
Snapshot des Geräts bei (Logs, Versionen, Zustände), der Betreiber bearbeitet alles in der
Konsole (admin.ava.bi) mit Status, internen Kommentaren und direktem Austausch mit dem Nutzer.
Rückfall ohne Cloud-Upload: fertige Mail in den Entwürfen des Nutzers an info@eprox-gmbh.de
mit allem als ZIP-Anhang.

## 1. Entscheidungen (Vorschlag, bitte bestätigen)

1. **Speicherort Anhänge: Gateway-Postgres (bytea), kein neuer Objektspeicher.** Grenzen:
   Snapshot-ZIP bis 10 MB, bis zu 3 weitere Dateien (Bilder PNG/JPG, PDF, Text) je 5 MB. Das
   deckt Logs plus Screenshots ab; die bestehende MPG hat Platz dafür bei erwartbar wenigen
   Meldungen pro Woche. Aufbewahrung: 90 Tage nach „geschlossen“, dann löscht der Cron die
   Anhänge (Meldung und Verlauf bleiben). Wird das später zu viel, ist der Wechsel auf Tigris
   (Fly) eine reine Speicher-Frage, Schnittstelle bleibt.
2. **Nutzer ↔ Betreiber über die Meldung selbst**, nicht über E-Mail: Der Betreiber antwortet
   in der Konsole, die Desktop-App holt alle 10 Minuten offene Antworten (Muster
   Kontingent-Wächter) und zeigt sie als Meldung in AVA; der Nutzer antwortet im Dialog
   „Meine Problemmeldungen“. Zusätzlich landet jede Betreiber-Antwort als Mail-Hinweis beim
   Nutzer nur, wenn wir später einen Mailversand im Gateway haben (heute keiner), daher
   zunächst nur in-App.
3. **Snapshot mit Sicht für den Nutzer:** Der Dialog zeigt vor dem Senden, was mitgeht
   (Liste), und hat zwei Haken: „Letzte 30 Chat-Schritte beilegen“ (aus) und „Bildschirmfoto
   des aktuellen Fensters beilegen“ (an, Vorschau sichtbar). Schlüssel und Tokens werden vor
   dem Packen maskiert (Regex auf `sk-`, `Bearer `, `apify_api_`, JWT-Muster, E-Mail-Passwörter
   der IMAP-Einstellung).
4. **Kategorien:** Fehler/Absturz, Daten falsch oder fehlend, Verarbeitung hängt, Anmeldung
   oder Organisation, Abrechnung oder Plan, Wunsch oder Idee, Sonstiges. Schwere wählt der
   Nutzer nicht; der Betreiber setzt Priorität (niedrig, normal, hoch, kritisch).
5. **Status:** neu → in Arbeit → wartet auf Nutzer → gelöst → geschlossen (plus „abgelehnt“
   für Wünsche). Jede Statusänderung ist eine Zeile im Verlauf. Zuweisung an Joyce, Patrick,
   Henning (Betreiber-Konten, Keycloak-Rolle admin).
6. **Chat-Werkzeug `problem_melden`** mit confirmAction: AVA fasst das Problem aus dem
   Gespräch zusammen, zeigt Kategorie und Text, der Nutzer bestätigt; der Snapshot wird
   automatisch beigelegt. Kein Werkzeug zum Lesen fremder Meldungen.
7. **Rückfall Mail-Entwurf** immer verfügbar als zweiter Knopf im Dialog („Als E-Mail
   vorbereiten“) und automatisch, wenn der Upload scheitert (offline, Gateway nicht
   erreichbar, Datei zu groß): .eml bzw. Entwurfs-Postfach über den bestehenden Mail-Entwurf
   (Outlook → .eml, sonst IMAP-Entwürfe), Empfänger info@eprox-gmbh.de, Betreff
   „AVA Problem: <Titel> (<Kennung>)“, Anhang `ava-problem-<datum>.zip`.

## 2. Was im Snapshot steckt (ZIP, vom Hauptprozess gepackt)

| Datei | Inhalt | Quelle |
|---|---|---|
| `uebersicht.json` | App-Version, Build, Electron/Chrome/Node, OS und Version, Arch, Sprache, Zeitzone, Uptime, Speicher frei, Worker-Modus, Anmeldung (Nutzer-ID, Org-ID, Rolle; keine Tokens), Gateway-URL und Erreichbarkeit (Health-Antwortzeit), Plan und Kontingentstand, Feature-Vorgaben der Org | platform-electron, auth, /v1/tenants/me, /v1/usage |
| `modell.json` | Anbieter, Modellname, Ollama-Status und geladene Modelle, Azure-Brücke ja/nein, ChatGPT-Abo ja/nein (ohne Schlüssel) | provider-config, ollama:getStatus |
| `ava-main.log` | Letzte 2 MB des Hauptprozess-Logs (plus rotierte Datei, falls die letzte Stunde darin liegt) | file-logger (~/Library/Logs/AVA) |
| `producer-<name>.log` | Ringpuffer je Producer | producer-log-buffer |
| `renderer.log` | Renderer-Breadcrumbs und Fehler der Sitzung | file-logger IPC |
| `hintergrund.json` | Laufende/zuletzt beendete Hintergrundaufgaben, Scheduler-Stände (Auffrischung, Heartbeat, Watchlist), Warteschlangen-Zähler, letzte Fehler je Job | Scheduler-Stores |
| `verarbeitung.json` | Letzte 20 Vorgänge mit Stufen-Status (Matrix-Auszug), geparkte/ruhende Zähler | /v1/companies/matrix |
| `einstellungen.json` | Nutzer-Einstellungen ohne Geheimnisse (Takte, Themen, Beobachtungen an/aus, Mail-Entwurf-Weg) | Settings-Stores |
| `chat-auszug.json` | Nur mit Haken: letzte 30 Schritte des aktuellen Gesprächs (Rollen, Werkzeugnamen, gekürzte Texte) | Konversations-Store |
| `bildschirm.png` | Nur mit Haken: aktuelles Fenster | webContents.capturePage |

Maskierung vor dem Packen (siehe §1.3). Größe begrenzen: Logs hart abschneiden, Puffer je
Producer auf 2.000 Zeilen.

## 3. Datenmodell (Gateway, Prisma-Migration `problem_meldungen`)

- `ProblemMeldung`: id (kurze Kennung wie `PM-2026-0041` zusätzlich zur UUID), tenantId,
  actorId, actorEmail/Name (Snapshot zum Zeitpunkt), kategorie, titel (≤120), beschreibung,
  quelle (dialog | chat | mail), status, prioritaet, zugewiesenAn (actorId Betreiber),
  appVersion, plattform, conversationId?, companyId?, createdAt, updatedAt, geloestAt,
  geschlossenAt, letzteNutzerAntwortAt, letzteBetreiberAntwortAt, ungelesenNutzer (bool),
  ungelesenBetreiber (bool).
- `ProblemAnhang`: id, meldungId, art (snapshot | bild | dokument), dateiname, mime,
  groesse, inhalt (bytea), sha256, createdAt. Index meldungId.
- `ProblemNachricht`: id, meldungId, von (nutzer | betreiber | system), actorId, text,
  intern (bool: nur Betreiber sehen es), art (nachricht | status | zuweisung | prioritaet),
  createdAt. Statuswechsel schreiben eine system-Zeile.

## 4. Endpunkte

**Nutzer (`/v1/meldungen`, Auth wie immer):**
- `POST /v1/meldungen` (multipart: felder + bis zu 4 Dateien) → Meldung mit Kennung.
- `GET /v1/meldungen/meine` → eigene Meldungen mit Status, letzte Nachricht, ungelesen.
- `GET /v1/meldungen/{id}` (nur eigene) → Verlauf ohne interne Kommentare.
- `POST /v1/meldungen/{id}/nachrichten` {text} → Antwort des Nutzers, setzt Status von
  „wartet auf Nutzer“ zurück auf „in Arbeit“, markiert ungelesenBetreiber.
- `POST /v1/meldungen/{id}/anhaenge` (nachreichen, gleiche Grenzen).
- `PUT /v1/meldungen/{id}/gelesen`.

**Betreiber (`/v1/betreiber/meldungen`, istBetreiber):**
- `GET` Liste mit Filter status, prioritaet, kategorie, zugewiesenAn, tenantId, suche;
  Sortierung neu zuerst; Zähler je Status für Badges.
- `GET /{id}` komplett inkl. interne Kommentare, Anhänge (Metadaten), Kunde (Org, Plan,
  Sitze, letzte Deploy-Version), Verweise zur Kundenkarte.
- `GET /{id}/anhaenge/{anhangId}` → Download (Snapshot-ZIP, Bilder inline anzeigbar).
- `POST /{id}/nachrichten` {text, intern} → an Nutzer (intern=false) oder Team-Kommentar.
- `PUT /{id}` {status?, prioritaet?, zugewiesenAn?, kategorie?} → system-Zeile je Änderung.
- `POST /{id}/zusammenfuehren` {inId} (Duplikate) als Komfort, kann später kommen.
- Cron: Anhänge 90 Tage nach „geschlossen“ löschen; `ungelesen`-Zähler für Konsole-Badge.

## 5. Desktop-App

- **Knopf unten links** in der Chat-Seitenleiste neben dem Modellnamen (`chat-sidebar__footer`):
  Text „Problem melden“, Lebenszeichen-Icon, gleiche Typo wie der Modellname (muted, small),
  Hover hebt leicht an. Mit offenen Betreiber-Antworten zeigt er einen Punkt und „1 Antwort“.
- **Dialog „Problem melden“** (bestaetigen-Dialog-Muster, breit): Kategorie (Chips), Titel,
  Beschreibung (Pflicht, Hinweistext „Was hast du getan, was ist passiert, was hast du
  erwartet?“), Bereich „Was mitgeht“ mit Liste aus §2, Haken Chat-Auszug (aus) und
  Bildschirmfoto (an, Miniatur), Dateien anhängen (Drag & Drop, bis 3), Hinweis zum
  Datenschutz (Zweck Fehlerbehebung, 90 Tage), Knöpfe „Senden“ und „Als E-Mail vorbereiten“.
  Nach dem Senden: Kennung, „Wir melden uns hier in AVA“, Link zu „Meine Problemmeldungen“.
- **„Meine Problemmeldungen“**: Liste mit Status-Pille, Detail mit Verlauf (Betreiber-
  Nachrichten links, eigene rechts), Antwortfeld, Nachreichen von Dateien. Erreichbar über
  den Knopf (zweiter Eintrag) und Einstellungen → Hilfe.
- **Abholen**: Hauptprozess fragt alle 10 Minuten `/v1/meldungen/meine`; neue Betreiber-
  Antworten werden Meldungen (AlertsStore, sourceRef `problem:<id>:<nachrichtId>`) mit
  Aktion „Antworten“; Badge am Knopf.
- **Snapshot-Modul** `main/problem/snapshot.ts`: sammelt §2, maskiert, packt (archiver oder
  zip-lib, die ohnehin im Bundle ist, prüfen), liefert Pfad und Größe; `main/problem/
  melden.ts` lädt hoch (multipart über den Gateway-Client), bei Fehler Rückfall Mail-Entwurf
  (`mail-entwurf/oeffnen.ts` mit Anhang-Quelle „Datei“).
- **Chat-Werkzeug `problem_melden`** (tools/problem.ts): Argumente kategorie, titel,
  beschreibung, chatAuszug (bool); confirmAction zeigt die Zusammenfassung; Snapshot wie im
  Dialog; Antwort mit Kennung. Systemprompt: Bei Fehlern, die der Nutzer schildert und die
  AVA nicht selbst lösen kann (Absturz, hängende Verarbeitung nach retry, Anmeldeproblem),
  das Werkzeug anbieten, nie ungefragt auslösen. Fähigkeitsgruppe „Hilfe“ für Chips.
- **Jargon-Prüfung**: Wörter „Snapshot“, „Triage“, „Ticket“ nicht in Nutzertexten; der
  Nutzer sieht „Problem melden“, „Problemmeldung“, „Protokolle“.

## 6. Konsole admin.ava.bi: Triage-Center `/betreiber/meldungen`

- **Liste**: Spalten Kennung, Titel, Kunde (Org, Nutzer), Kategorie, Priorität, Status,
  zugewiesen, letzte Aktivität, ungelesen-Punkt. Filter oben (Status-Chips mit Zählern,
  Priorität, Kategorie, „meine“), Suche. Standardsicht: offen, neueste zuerst. Badge in der
  Navigation mit Zahl ungelesener/neuer Meldungen.
- **Detail** (zwei Spalten): links Beschreibung, Anhänge (Bilder als Galerie, ZIP mit
  Inhaltsliste und Download, `uebersicht.json` und `modell.json` direkt als Karten
  gerendert: Version, OS, Modell, Plan, Gateway-Erreichbarkeit), Kundenkarte (Org, Plan,
  Sitze, Firmen aktiv/ruhend, letzte Aktivität) mit Sprung zur Kundenansicht. Rechts der
  Verlauf: Nachrichten an den Nutzer und interne Kommentare (gelb hinterlegt, Schalter
  „intern“ am Eingabefeld), Statusänderungen als dünne Zeilen. Kopfzeile mit Status,
  Priorität, Zuweisung als Auswahl, Knöpfe „Als gelöst markieren“, „Wartet auf Nutzer“.
- **Antwort-Vorlagen** (kleine Liste im Code): „Danke, wir schauen drauf“, „Bitte App neu
  starten und erneut melden“, „Behoben in Version X“.
- Proxy-Allowlist um `/v1/betreiber/meldungen…`, Download-Route streamt bytea.

## 7. Arbeitspakete und Aufwand

| Paket | Inhalt | Aufwand | Abhängig von |
|---|---|---|---|
| M1 | Gateway: Migration, Nutzer- und Betreiber-Endpunkte, Upload-Grenzen, Cron Löschung | 1 Tag | – |
| M2 | Desktop: Snapshot-Modul mit Maskierung, Dialog, Knopf, „Meine Problemmeldungen“, Abholen der Antworten | 2 Tage | M1 |
| M3 | Desktop: Chat-Werkzeug, Systemprompt, Fähigkeitsgruppe, Mail-Rückfall | 0,5 Tag | M2 |
| M4 | Konsole: Liste, Detail, Verlauf, Kommentare, Badge, Downloads | 1,5 Tage | M1 |
| M5 | Texte: Datenschutzhinweis im Dialog, Abschnitt in Datenschutzerklärung (Website-Prompt), README | 0,5 Tag | – |
| | Gesamt | ~5,5 Tage | |

Reihenfolge: M1 → M2 → M4 → M3 → M5. Deploys: Gateway (Migration) nach M1, Konsole nach M4,
Desktop-Release nach M2/M3.

## 8. Offen (Empfehlung zuerst)

- **Benachrichtigung des Betreibers bei neuer Meldung**: Empfehlung Telegram an die
  Betreiber-Chat-ID über den bestehenden Telegram-Kanal des Gateways, falls vorhanden; sonst
  erst einmal nur Konsole-Badge. Mail an info@ erst mit einem Mailversand im Gateway.
- **PWA und MCP**: PWA bekommt zunächst nur „Problem melden“ als Mail-Link ohne Snapshot
  (kein Gerätezugriff); später derselbe Dialog ohne Protokolle. MCP kein Werkzeug.
- **Snapshot ohne Anmeldung** (Anmeldeprobleme): Dialog auch auf der Anmeldeseite, dann nur
  Mail-Rückfall, weil kein Gateway-Token vorliegt.
- **Server-Instanz (headless-ava)**: Snapshot dort über denselben Code, Auslösung aus der
  PWA; später.
