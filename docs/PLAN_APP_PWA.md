# Plan: AVA als App (PWA) unter app.ava.bi (2026-10-10)

Anlass: Mit AVA auf dem Server soll man nicht mehr über Telegram arbeiten müssen. Gewünscht ist eine App mit Chat,
Diktat, Live-Gespräch (Sprachblase), Datei-Upload und Firmenansichten, die am Laptop im Browser gut aussieht und auf
dem Handy installiert möglichst nativ wirkt. Vorgabe des Operators: Next.js (App Router) und shadcn/ui wie die
Konsole, Adresse **app.ava.bi**, zunächst als PWA statt nativer App.

## 0. Ergebnis in einem Absatz

Die App ist eine **zweite Oberfläche für die laufende AVA des Nutzers**, nicht für den Gateway: Chat, Gespräche,
Rückfragen, Dateien, Diktat, Sprache und Meldungen laufen über ein neues **App-Kanal im Kopf-Relais** (Gateway ↔ AVA,
heute nur Aufruf/Antwort, künftig mit gestreamten Frames). Firmenansichten holen ihre Daten direkt vom Gateway und
gehen auch ohne laufende AVA. Die App selbst ist ein Next.js-BFF wie die Konsole (Anmeldung über Keycloak, Tokens nur
in verschlüsselten Cookies), mit PWA-Hülle (Manifest, Service Worker, Safe Areas, Tab-Leiste). Aufwand bis zum
nutzbaren Kern (Chat, Dateien, Diktat) rund **2 Wochen**, mit Sprachblase, Firmen, Meldungen und Push rund
**4 Wochen**.

## 1. Was die AVA heute dafür mitbringt (Bestandsaufnahme)

| Bereich | Heute | Für die App |
| --- | --- | --- |
| Chat | `AgentOrchestrator.send(AgentSendInput)` → Frames `token`, `tool-call`, `tool-result`, `choice-request`, `text-request`, `match-request`, `navigate`, `suggestions`, `usage`, `done`, `error` (`shared/types.ts:896`), an alle Fenster gesendet | dieselben Frames über das Relais an die App |
| Gespräche | `MemoryStore` (eine Markdown-Datei je Gespräch): `list`, `load`, `delete`, `search` | App zeigt dieselben Gespräche wie die Desktop-App |
| Rückfragen | `UiBridge.askChoice/askText` im Chat, Antwort per `answerChoice(choiceId, value)`; ohne Oberfläche das Token-Muster (`RelaisRueckfragen`) | App beantwortet interaktiv wie das Desktop-Fenster |
| Dateien | `AttachmentStore.stage` (7 Tage, Handles `att-…`), `datei_*`-Werkzeuge; Bilder bis 5 MB als Bildteile, Dateien bis 25 MB; PDF/DOCX-Text im Hauptprozess (`agent:extractPdfText`) | Upload in Teilen über das Relais (6 MB je Nachricht), Ablage und Textauszug auf der AVA |
| Sprache | Realtime: Client-Secret von der AVA, WebRTC direkt zu OpenAI (`renderer/src/lib/realtime.ts`); GPT Live: SDP über die AVA (`main/sprache/live.ts`); Werkzeuge über `SpracheRelay` (`ava_bearbeiten`, Rückfragen, Ergebnisse) | Browser-Teil fast unverändert übernehmbar; Sitzungsaufbau und Aufträge über das Relais |
| Diktat | nur lokal: whisper.cpp (`voice/whisper-sidecar.ts`), WAV 16 kHz (`renderer/src/lib/recordVoice.ts`) | WAV in der App erzeugen, Transkription auf der AVA; Rückfall auf OpenAI-Transkription, wo kein Whisper läuft |
| Firmen | Detailseite `CompanyDetail.tsx` mit ~20 Gateway-Endpunkten (`/v1/companies/{id}/…`, Buying Center, Personen) | direkt über das BFF zum Gateway, ohne AVA |
| Meldungen | nur auf der AVA (`AlertsStore`), Zustellung per Desktop-Benachrichtigung und Telegram | über das Relais lesen; Web-Push als weiterer Kanal |
| Relais | WebSocket je Instanz, `aufruf`/`ergebnis` mit ID, 6 MB je Nachricht, 110 s je Aufruf, **kein Streaming** | neuer Nachrichtentyp für Frames, App-Anfragen |

Zwei harte Randbedingungen:

- **Ein Chat-Durchlauf zur Zeit** (`orchestrator.ts:503`): Telegram, Mail-Triage, Workflows, MCP und die App teilen
  sich die AVA. Die App muss „AVA arbeitet gerade“ zeigen und kurz warten können (§4.3).
- **Relais ohne Streaming:** muss erweitert werden (§3.2), auf beiden Seiten.

## 2. Zielbild

### 2.1 Was die App kann (erster Wurf)

1. **Chat** mit gestreamten Antworten (Markdown, Tabellen, Firmenlinks), sichtbaren Werkzeugschritten, Rückfragen
   als Knöpfe oder Eingabefeld, Abbrechen, Vorschlags-Chips; Gesprächsliste mit Suche, dieselben Gespräche wie am Desktop.
2. **Dateien und Fotos** anhängen (Kamera, Fotos, Dateien; PDF, Word, Excel, CSV, Text, Bilder).
3. **Diktat:** Mikrofon-Knopf im Eingabefeld, Text erscheint zum Bearbeiten.
4. **Sprachblase:** Live-Gespräch mit AVA (GPT Live, Rückfall Realtime), Pegelanzeige, Ergebnisse als Karten im Gespräch.
5. **Firmen:** Suche, Meine Firmen, Detailansicht (Übersicht, Finanzen, Geschäftsführung, Kontakte, Kunden,
   Verflechtungen, Buying Center) zunächst lesend; „Mit AVA besprechen“ öffnet einen Chat zur Firma.
6. **Meldungen** mit Zähler, gelesen/verwerfen; **Web-Push** auf dem Handy.
7. **Status:** welche AVA antwortet (Server oder Desktop), verbunden/offline, Vorgaben der Organisation werden beachtet
   (abgeschaltete Funktionen verschwinden).

### 2.2 Bewusst nicht im ersten Wurf

Einstellungen der AVA (gehen per Chat, jede Einstellung hat ein Werkzeug), Radar-Oberfläche, Workflows-Editor,
Importe aus Excel mit Zuordnungsdialog (`match-request` kommt als einfache Auswahl), LinkedIn, Mail-Triage-Oberfläche,
Aktivierungswort „Hey AVA“ (geht im Browser nicht im Hintergrund).

### 2.3 Gestaltung: Laptop und Handy aus einem Guss

- **Laptop/Browser:** Seitenleiste (Gespräche, Firmen, Meldungen), Chat in der Mitte, Firmenansicht als zweite Spalte
  oder eigene Seite. Gleiche Farben und Schrift wie App und Konsole (Aqua #00c0a7/#009f8a, Slate, Plus Jakarta Sans),
  Logo im Kopf.
- **Handy (installiert):** Vollbild ohne Browserleiste (`display: standalone`), Tab-Leiste unten (Chat, Firmen,
  Meldungen, Mehr), Safe Areas (Notch, Home-Indikator) über `env(safe-area-inset-*)`, Eingabefeld folgt der Tastatur
  (`visualViewport`), große Tippflächen, Wischgesten nur wo erwartet (Zurück), keine Gummiband-Effekte im Rahmen,
  Sprachblase als schwebender Knopf über dem Eingabefeld, Sheets (shadcn Drawer) statt Dialogen.
- **Installation:** Android bietet sie selbst an (`beforeinstallprompt`), iOS bekommt einen einmaligen Hinweis
  („Teilen → Zum Home-Bildschirm“). Seit iOS 26 öffnet jede zum Home-Bildschirm hinzugefügte Seite standardmäßig als
  Web-App ([heise](https://heise.de/-10749652)).

## 3. Architektur

```
Handy/Browser ─(Cookie)─▶ ava-app (Next.js BFF, Vercel fra1, app.ava.bi)
                               │ Firmen, Suche, Personen, Policy: /v1/… (wie Konsole)
                               │ App-Kanal: POST /v1/app/…  +  GET /v1/app/strom (SSE)
                               ▼
                         ava-db-gateway ──(WebSocket, Kopf-Relais)──▶ AVA des Nutzers (Server oder Desktop)
                                                                         Orchestrator, Gespräche, Dateien,
                                                                         Sprache, Meldungen
Sprache:  Browser ──WebRTC──▶ OpenAI (Schlüssel kurzlebig, von der AVA erzeugt)
```

### 3.1 App (Repo `ava-app`)

- Next.js 16 App Router, shadcn/ui (Radix, Nova) wie `ava-admin`; Anmeldung, Sitzung (JWE-Cookies), Durchreicher mit
  Freigabeliste und Ursprungsprüfung aus der Konsole übernommen (`lib/config|session|oidc|ursprung`, `api/gw`).
- Zusätzlich: **SSE-Durchreiche** `app/api/strom/route.ts` (Gateway-Strom → Browser, mit `Last-Event-ID`),
  **Upload-Route** (Datei in Teilen an den Gateway), PWA-Teile (`app/manifest.ts`, Service Worker für App-Hülle und Push,
  Symbole inkl. maskable, `apple-touch-icon`, Statusleiste).
- Wiederverwendung aus der Desktop-App (kopiert, nicht geteilt): Markdown-Darstellung des Chats, `realtime.ts`/`live.ts`
  (WebRTC), `recordVoice.ts` (WAV), `attachment.ts` (Tabellen-Vorschau und Marker-Block), Teile der Firmenansicht.
- Vercel-Projekt `ava-app` (Team QUIKK, `fra1`), Domain `app.ava.bi`, Git-Anbindung wie die Konsole.

### 3.2 Gateway und Relais: App-Kanal

Neue Nachrichten im Relais (beide Seiten):

| Richtung | Nachricht | Zweck |
| --- | --- | --- |
| Gateway → AVA | `{typ: "app", id, art, daten}` | Anfrage der App; `art` ∈ `chat_senden`, `chat_abbrechen`, `antwort`, `gespraeche`, `gespraech_laden`, `gespraech_loeschen`, `anhang_teil`, `anhang_fertig`, `transkribieren`, `sprache_sitzung`, `sprache_live`, `sprache_auftrag`, `sprache_rueckfrage`, `meldungen`, `meldung_status`, `stand` |
| AVA → Gateway | `{typ: "ergebnis", id, text, isError}` | Antwort wie heute (JSON im Text) |
| AVA → Gateway | `{typ: "app-frame", frame}` | gestreamter Frame (Chat- und Sprach-Frames, Meldungs-Änderungen) |
| AVA → Gateway | `{typ: "push", titel, text, ziel}` | Web-Push auslösen (§3.4) |

- Die AVA meldet Frames nur, solange eine App verbunden ist (`app-abo` mit Ablauf), damit nichts unnötig fließt.
- **Gateway-Endpunkte:** `POST /v1/app/{art}` (Anfrage → Relais → Antwort), `GET /v1/app/strom` (SSE je Nutzer: alle
  Frames aller Gespräche, wie `agent:stream` an alle Fenster). Ringpuffer je Nutzer (letzte 500 Frames, 10 Minuten),
  damit die App nach Funklöchern mit `Last-Event-ID` nahtlos weiterliest.
- **Zielinstanz:** wie MCP (Server vor Desktop, `mcp`-Schalter), in der App sichtbar und umschaltbar (E4).
- Dateien: in Teilen zu 768 KB (wie beim Umzug), Prüfsumme, Ablage über `AttachmentStore.stage`; PDF/DOCX-Text auf
  der AVA (dieselbe Funktion wie `agent:extractPdfText`).

### 3.3 AVA-Seite (`core/relais/app-kanal.ts`)

- Hört auf Orchestrator-`stream`, `SpracheRelay`-Ergebnisse und `AlertsStore`-Änderungen und schickt sie als `app-frame`.
- `chat_senden` → `orchestrator.send({conversationId, message, images, quelle: "app"})`; Rückfragen laufen interaktiv
  über `answerChoice` (kein Token-Muster nötig, die App ist eine echte Oberfläche). Desktop-Fenster und App sehen
  dieselben Frames; wer zuerst antwortet, gilt.
- `navigate`-Frames werden in App-Pfade übersetzt (`company:<id>` → `/firmen/<id>`).
- Neue Quelle `"app"` im Orchestrator (Audit, Vorschläge, Vollmacht wie im Desktop-Chat).

### 3.4 Meldungen und Push

- Lesen/Ändern über den App-Kanal (`alerts_*` der AVA).
- **Web-Push:** Gateway speichert Push-Abos je Nutzer (neue Tabelle `PushAbo`: actorId, endpoint, Schlüssel, Gerät),
  sendet mit VAPID (`web-push`). Die AVA bekommt einen weiteren Zustellkanal neben Desktop und Telegram (gleiche Regeln:
  Schwelle, Ruhezeiten), der `{typ: "push"}` ans Relais schickt. iOS: Push nur in der installierten App und nur nach
  einer Nutzeraktion freischaltbar ([WebKit](https://webkit.org/?p=13878)).

### 3.5 Sprache

- **Live (Standard):** App erzeugt SDP-Angebot → `sprache_live` → AVA spricht mit OpenAI (Schlüssel bleibt bei der AVA)
  → SDP-Antwort → WebRTC direkt Browser ↔ OpenAI. Delegationen (`session.delegation.created`) → `sprache_auftrag`;
  Ergebnisse und Rückfragen kommen als Frames zurück.
- **Realtime (Rückfall):** `sprache_sitzung` liefert das kurzlebige Client-Secret; Funktionsaufrufe wie im Desktop.
- Mit Azure OpenAI nicht verfügbar (wie am Desktop, `SpracheStand.hinweis`).

### 3.6 Diktat

App nimmt per Web Audio auf und erzeugt WAV 16 kHz (wie `recordVoice.ts`) → `transkribieren` → AVA: lokales Whisper,
wenn bereit; sonst **neu** OpenAI-Transkription über `openaiZugang()` (`/audio/transcriptions`, z. B.
`gpt-4o-transcribe`), damit es auch auf Servern ohne Whisper-Modell geht (E6).

## 4. Besonderheiten und Entscheidungen im Detail

### 4.1 Vercel und lange Ströme

Funktionen auf Vercel haben eine Höchstdauer; der SSE-Strom wird deshalb bewusst kurz gehalten (z. B. 5 Minuten) und
vom Browser mit `Last-Event-ID` neu aufgebaut. Der Ringpuffer im Gateway sorgt dafür, dass dabei nichts verloren geht.
Wird das zu teuer oder hakelig, öffnet die App den Strom direkt beim Gateway mit einem kurzlebigen Strom-Ticket, das
das BFF ausstellt (E3).

### 4.2 iOS-Grenzen (ehrlich)

- **Kein Hintergrund:** Bildschirm aus oder App gewechselt beendet Live-Gespräch und Aufnahme. Kein Aktivierungswort.
- **Mikrofon-Erlaubnis** kann je nach iOS-Version und Startweg erneut abgefragt werden; Berichte dazu sind
  uneinheitlich ([WebKit-Bug 185448](https://bugs.webkit.org/show_bug.cgi?id=185448),
  [Apple-Forum](https://developer.apple.com/forums/thread/710010)). Die App prüft vorher mit
  `navigator.permissions.query` und erklärt die Abfrage einmalig.
- **Teilen in die App** aus anderen Apps (Web Share Target) gibt es auf iOS nicht, auf Android ja.
- **Haptik** auf iOS nicht verlässlich (Vibration API); nur dort nutzen, wo verfügbar.
- Push-Abos können nach langer Inaktivität verfallen; die App erneuert sie beim Öffnen.

### 4.3 Eine Anfrage zur Zeit

Ist die AVA beschäftigt (Telegram, Workflow, Mail-Triage, anderes Gerät), zeigt die App „AVA arbeitet gerade an …“
mit Abbrechen-Möglichkeit (nur eigene Durchläufe) und reiht die Nachricht in eine kleine Warteschlange der AVA ein
(höchstens 3, verfällt nach 10 Minuten), statt sie abzuweisen.

### 4.4 Datenschutz und Sicherheit

- Tokens nur im BFF (wie Konsole); die App sieht nie Anbieterschlüssel; Sprach-Secrets sind kurzlebig und an die
  Sitzung gebunden.
- Der Gateway reicht App-Frames nur an das eigene Konto weiter (actorId der Sitzung = actorId der AVA).
- Organisationsvorgaben gelten: abgeschaltete Funktionen (Sprachmodus, Kontakte, Buying Center …) blendet die App aus;
  die AVA weist sie ohnehin ab.
- Service Worker cacht nur die App-Hülle und statische Dateien, nie Gesprächs- oder Firmendaten.

## 5. Stufen

| Stufe | Inhalt | Aufwand |
| --- | --- | --- |
| **P0** | Repo `ava-app` (eproX-GmbH, privat), Vercel-Projekt, DNS `app.ava.bi`, Keycloak-Weiterleitung, Grundgerüst mit Anmeldung (aus der Konsole) | 0,5 Tage |
| **P1** | App-Kanal: Relais-Nachrichten beide Seiten, `core/relais/app-kanal.ts`, Gateway `/v1/app/*` + SSE mit Ringpuffer, Quelle `"app"`, Warteschlange | 3–4 Tage |
| **P2** | Chat: Gesprächsliste, Strom, Markdown, Werkzeugschritte, Rückfragen, Abbrechen, Vorschläge; Layout Laptop/Handy, Tab-Leiste, Safe Areas, Tastatur | 4–5 Tage |
| **P3** | Dateien und Fotos (Teil-Upload, Textauszug auf der AVA, Marker-Block, Bilder) | 1,5 Tage |
| **P4** | Diktat (WAV in der App, Whisper oder OpenAI-Transkription auf der AVA) | 1 Tag |
| **P5** | Firmen: Suche, Meine Firmen, Detailansicht lesend, „Mit AVA besprechen“ | 3 Tage |
| **P6** | Sprachblase (Live + Realtime-Rückfall, Delegation, Ergebnisse als Karten) | 2–3 Tage |
| **P7** | Meldungen in der App, Web-Push (VAPID, `PushAbo`, Zustellkanal der AVA) | 2 Tage |
| **P8** | PWA-Feinschliff: Manifest, Symbole, Installationshinweise, Offline-Hinweis, Startbildschirm, Tests auf iPhone und Android | 1–2 Tage |

Nutzbarer Kern nach P0–P4 (Chat mit Dateien und Diktat) in rund 2 Wochen; komplett rund 4 Wochen. P7 braucht eine
Datenbankänderung im Gateway (neue Tabelle) und damit eine Freigabe vor dem Deploy.

## 6. Entscheidungen (Empfehlung zuerst)

| # | Frage | Empfehlung | Alternative |
| --- | --- | --- | --- |
| E1 | Projekt | eigenes Repo `ava-app` (eproX-GmbH, privat), gleicher Aufbau wie `ava-admin` | Bereich im Repo `ava-admin` |
| E2 | Keycloak-Client | `ava-web` um `https://app.ava.bi/auth/callback` erweitern (Skript anpassen) | eigener Client `ava-app` |
| E3 | Strom-Transport | SSE über das BFF, kurze Ströme mit `Last-Event-ID` | direkt zum Gateway mit Strom-Ticket |
| E4 | Welche AVA antwortet | wie MCP: Server vor Desktop, in der App umschaltbar | immer die zuletzt aktive |
| E5 | Beschäftigte AVA | kleine Warteschlange (3, 10 Min.) mit Anzeige | sofort abweisen |
| E6 | Diktat ohne Whisper | OpenAI-Transkription als Rückfall | nur Whisper (Server braucht dann das Modell) |
| E7 | Push | Web-Push in P7, Telegram bleibt parallel | erst später |
| E8 | Firmenansicht | zunächst lesend, Aktionen über „Mit AVA besprechen“ | Aktionen direkt (Buying Center bearbeiten, Import) |

## 7. Risiken

- **Zwei Oberflächen für dieselbe AVA:** Rückfragen könnten gleichzeitig am Desktop und in der App erscheinen; die
  zuerst gegebene Antwort gilt, die andere Oberfläche schließt die Karte (`choice-resolved`, dafür die fehlende
  `conversationId` in diesem Frame nachziehen).
- **Gateway mit einer Maschine:** Ringpuffer und Relais liegen im Speicher; ein Gateway-Neustart unterbricht kurz,
  die App verbindet sich neu, laufende Durchläufe auf der AVA laufen weiter.
- **iOS-Verhalten** ändert sich von Version zu Version; Tests auf echten Geräten gehören in jede Stufe.
- **Code-Kopien** aus der Desktop-App (Markdown, WebRTC, Anhänge) laufen auseinander; mittelfristig in ein gemeinsames
  Paket ziehen, wenn beide Oberflächen bleiben.
