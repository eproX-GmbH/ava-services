# Plan: Sprachmodus (Speech-to-Speech mit OpenAI Realtime)

Stand 2026-09-24. Grundlage: OpenAI Realtime API (Modell `gpt-realtime-2.1`,
WebRTC im Browser, ephemere Client-Schluessel, Function Calling im
Datenkanal). Quelle: developers.openai.com/api/docs/guides/realtime,
realtime-webrtc, realtime-conversations.

---

## 0. Festlegungen und meine Empfehlung

1. **Die Sprach-KI ist die Stimme, nicht das Gehirn.** Das Realtime-Modell
   spricht und hoert; die eigentliche Arbeit (Werkzeuge, Skills,
   Gedaechtnis, Rueckfragen, Autonomiestufen, Diagramme, Buying Center)
   macht weiterhin der bestehende Chat-Orchestrator. Die Sprach-KI hat dafuer
   genau EIN Werkzeug: `ava_bearbeiten(auftrag)`, das den Auftrag als Zug in
   die laufende Unterhaltung gibt und die Antwort zurueckbekommt. Damit gilt
   Punkt 5 der Anforderung ("dieselben Moeglichkeiten wie der Chat") von
   Tag eins, ohne 269 Werkzeuge, Lazy-Loading, Skills und
   Bestaetigungslogik ein zweites Mal zu bauen.
   Der Preis: Ein Auftrag mit Werkzeugen dauert so lange wie im Chat (das
   Chat-Modell des Nutzers, ggf. lokal), und zwei Modelle sind beteiligt.
   Die Sprach-KI ueberbrueckt die Wartezeit ("ich schaue nach") und bekommt
   das Ergebnis nachgereicht, waehrend sie weiterreden kann (Punkt 7.2).
   Die Alternative, das Realtime-Modell direkt mit allen Werkzeugen zu
   verdrahten, steht in Abschnitt 9 als spaeterer Ausbau, nicht als Start.

2. **Keine Halluzination durch Nacherzaehlen.** Die Sprach-KI darf Fakten
   NUR aus der Antwort des Orchestrators wiedergeben, nichts ergaenzen. Sie
   antwortet ohne Werkzeug nur bei Smalltalk, Rueckfragen zum Verstaendnis
   und Bedienhinweisen. Das steht so in den Instruktionen und wird im Test
   S5 gegen typische Fangfragen geprueft.

3. **Schluessel wie ueberall.** Sprachmodus braucht einen OpenAI-Schluessel
   (eigener oder Organisation, Vorrang wie im Chat; Sperre erzwingt die
   Organisation). Der Standardschluessel verlaesst nie den Hauptprozess: Der
   Hauptprozess praegt einen ephemeren Client-Schluessel (`POST
   /v1/realtime/client_secrets`, direkt oder ueber den Gateway-Proxy
   `/v1/llm/openai/realtime/client_secrets`), der Renderer verbindet sich
   damit per WebRTC direkt mit OpenAI.

4. **Verlassen nur ueber das X.** Im Sprachmodus gibt es keine Navigation,
   keine Links, keine Menues. Antworten werden als Text OHNE Links
   gerendert; Diagramme und Buying Center erscheinen als Bloecke unter der
   Kugel. `navigate`-Frames des Orchestrators werden im Sprachmodus
   verworfen.

5. **AVA ist weiblich, klar, direkt.** Stimme `marin` als Standard (von
   OpenAI empfohlen, weiblich), waehlbar aus den weiblichen Stimmen
   (`marin`, `coral`, `sage`, `shimmer`). Instruktionen: kurze Saetze, keine
   Fuellwoerter, keine Tabellen, keine Aufzaehlungen laenger als drei
   Punkte, Zahlen gerundet nennen.

---

## 1. Was der Nutzer bekommt

- Ein Knopf im Kopf der Chat-Seite (Wellen-Symbol, wie bei ChatGPT neben dem
  Mikrofon fuer Sprachnachrichten) und ein Menuepunkt. Sichtbar NUR, wenn
  die Funktion aktiviert ist und ein OpenAI-Schluessel vorhanden ist
  (Gesperrtes wird ausgeblendet, nicht ausgegraut).
- Beim Wechsel blendet der ganze Bildschirm nach Weiss (bzw. im Dunkelmodus
  nach dem hellsten Grau der Palette; Entscheidung 8.4), die Sprachkugel
  blendet ein. Unten: Eingabezeile ("AVA fragen", Anhaenge), Mikrofon
  stumm/laut, X.
- Kugel: atmet leicht im Leerlauf; dehnt sich mit AVAs Stimme aus (Pegel
  des Ausgabetons); zieht sich beim Zuhoeren zusammen und wird dunkler
  (Pegel des Mikrofons, Ereignis `input_audio_buffer.speech_started`).
- Waehrend ein Auftrag laeuft: dezenter Ring um die Kugel. Ergebnisse mit
  Bloecken (```chart, ```buying-center, spaeter Tabellen als Karten): Die
  Kugel faehrt nach oben, der Block erscheint darunter. Mehrere Bloecke
  stapeln sich, scrollbar, Kugel bleibt oben stehen.
- Text tippen oder Bilder/Dokumente anhaengen geht jederzeit; beides geht
  als Zug in dieselbe Unterhaltung, AVA antwortet gesprochen.
- Die Unterhaltung ist dieselbe wie im Chat: Wer den Sprachmodus verlaesst,
  sieht Auftraege und Antworten im Chatverlauf (gesprochene Antworten als
  Transkript markiert).

---

## 2. Architektur

```
Renderer (Sprachmodus-Overlay)
  ├─ WebRTC ─────────────────────────────► OpenAI Realtime (Audio rein/raus)
  │    Datenkanal "oai-events": session.update, response.create,
  │    conversation.item.create, response.done (function_call), …
  ├─ IPC sprache:session  ◄──────────────  Hauptprozess (ephemerer Schluessel,
  │                                         Instruktionen, Stimme, Werkzeuge)
  └─ IPC sprache:auftrag / sprache:antwort ◄► Hauptprozess: Relay
                                              └─ AgentOrchestrator.send(...)
                                                 (bestehende Unterhaltung,
                                                  Werkzeuge, Skills, Rueckfragen)
```

**Relay im Hauptprozess (`main/sprache/relay.ts`):**
- `auftrag(conversationId, text, anhaenge)` → `orchestrator.send(...)`;
  sammelt die Frames des Zugs (token, tool-call, tool-result,
  choice-request, text-request, done) und liefert:
  - sofort: `{ laeuft: true, requestId }` (die Sprach-KI ueberbrueckt),
  - spaeter per Ereignis `sprache:ergebnis`: `{ text, bloecke[],
    rueckfrage? }`. Der Renderer legt das Ergebnis als
    `conversation.item.create` (Rolle user, Praefix "ERGEBNIS von AVA:")
    in die Realtime-Sitzung und loest `response.create` aus.
- Rueckfragen (`choice-request`, `text-request`, `match-request`) des
  Orchestrators: Der Relay gibt sie als `rueckfrage` zurueck; die Sprach-KI
  stellt sie muendlich; die Antwort des Nutzers geht ueber das zweite
  Werkzeug `ava_rueckfrage_beantworten(choiceId, wert)` an
  `orchestrator.answerChoice(...)`. Die Karte wird zusaetzlich unter der
  Kugel gezeigt (Klick moeglich), damit Auswahl mit vielen Optionen nicht
  vorgelesen werden muss.
- Bloecke: Chart- und Buying-Center-Zaeune werden aus dem Antworttext
  herausgeloest (dieselben Regexe wie in Chat.tsx) und dem Renderer als
  `bloecke` gegeben; der Sprach-KI wird nur der Text ohne Zaeune
  uebergeben, plus Hinweis "Ein Diagramm ist auf dem Bildschirm".

**Werkzeuge der Realtime-Sitzung (session.tools):**
1. `ava_bearbeiten({ auftrag: string })` – alles, was Daten, Recherche,
   Aktionen oder Wissen ueber Firmen braucht.
2. `ava_rueckfrage_beantworten({ choiceId, wert })`.
3. `ava_anzeigen({ zeigen?: id[], entfernen?: id[], alle_entfernen?: true })`
   – die Sprach-KI bestimmt, was auf dem Bildschirm bleibt (Abschnitt 5,
   "Bildschirm folgt dem Gespraech").

**Turn-Erkennung:** `semantic_vad` (Standard), Unterbrechung erlaubt
(`interrupt_response: true`); bei stummgeschaltetem Mikrofon `turn_detection:
null` und Push-to-Talk ueber die Leertaste.

**Instruktionen (session.instructions):** Persona aus `buildSystemPrompt`
(Du-Form, Deutsch, Fakten-Disziplin) gekuerzt auf Sprache: siehe Abschnitt
6. Kein Werkzeug-Katalog, keine Skills; das kennt der Orchestrator.

**Sitzungsgrenze:** 60 Minuten je Sitzung (OpenAI). Nach 55 Minuten praegt
der Hauptprozess einen neuen Schluessel, der Renderer verbindet neu und
uebergibt die letzten Zuege als Kontext (Punkt 8.6).

---

## 3. Schluessel, Organisation, Kosten

- Aktivierung in den Einstellungen (Modelle → "Sprachmodus"): Schalter,
  Stimme, Hinweis auf Kosten. Bedingung: OpenAI-Schluessel vorhanden
  (eigener oder Organisation). Ohne Schluessel: kein Schalter, sondern der
  Hinweis "OpenAI-Schluessel hinterlegen".
- Chat-Werkzeug `sprachmodus_konfigurieren` (confirmAction) fuer Schalter
  und Stimme (Regel: jede Einstellung auch im Chat), Schluessel bleiben
  ausgenommen.
- Organisationsschalter `sprachmodus` in `ORG_FEATURES` (Aus = Knopf,
  Einstellung und Werkzeug verschwinden).
- Praegung des Client-Schluessels: eigener Schluessel → direkt
  `api.openai.com`; Organisation → `GATEWAY/v1/llm/openai/realtime/
  client_secrets` mit Producer-/Nutzer-Token (der Proxy ist generisch, der
  Pfad geht durch). `OpenAI-Safety-Identifier` = gehashte actorId.
- **Verbrauch:** Der Proxy sieht nur die Praegung, nicht die Audio-Minuten.
  Das Ereignis `response.done` traegt `usage` (Audio-/Text-Token). Der
  Renderer meldet sie je Antwort an den Hauptprozess, der sie an
  `POST /v1/llm/usage` (neu, nur fuer Organisationsschluessel) gibt; damit
  landet der Sprachmodus im Verbrauch und im Kontingent der Organisation.
  Ohne diesen Schritt waere der Sprachmodus ein Loch im Kontingent
  (Entscheidung 8.2).
- Kostenrahmen (Listenpreise gpt-realtime, Stand Juni 2026, im Bau
  gegenzupruefen): grob 0,20–0,40 € je Gespraechsminute Audio, dazu die
  Chat-Zuege des Orchestrators wie bisher. Der Kostenhinweis steht an der
  Einstellung und beim ersten Start.

---

## 4. Oberflaeche

- Route `/sprache` als Vollbild-Overlay ueber der App (kein Sidebar-
  Rendering, keine Kopfzeile). Ein- und Ausblenden per CSS-Transition
  (Weiss-Fade 400 ms, Kugel 600 ms verzoegert).
- Kugel: `<canvas>` mit weichem Farbverlauf (blau-weiss wie das Vorbild),
  Radius und Helligkeit aus zwei Pegeln: Ausgabe (AnalyserNode am
  Remote-Audiotrack) und Eingabe (AnalyserNode am Mikrofon-Stream). Zustand
  `spricht` / `hoert` / `denkt` / `leerlauf` bestimmt Grundgroesse und Farbe;
  Pegel moduliert um ±15 %. Reduzierte Bewegung (prefers-reduced-motion):
  nur Farbwechsel.
- Ergebnisbereich unter der Kugel: Bloecke aus Chat-Komponenten
  (`ChartBlock`, `BuyingCenterBlock`, spaeter `TabelleBlock`), Text-
  Antworten als schlichte Karte ohne Links (Markdown-Renderer im Modus
  "ohneLinks": Links werden zu Text; `company:`-Links ebenso).
  Buying-Center-Karte im Sprachmodus ohne Links auf Personen (Dialog
  bleibt).
- Untere Leiste: Eingabefeld "AVA fragen" (Enter sendet als Auftrag),
  Anhang (+), Mikrofon stumm/laut, X. Transkript der letzten gesprochenen
  Saetze als dezente Zeile ueber der Leiste (aus
  `response.output_audio_transcript.delta`), abschaltbar.
- Tastatur: Esc = X, Leertaste gedrueckt = sprechen bei stummem Mikrofon.

**Ruhezustand und Aktivierungswort (Zusatz 2026-09-24):**
- Beim Start des Sprachmodus ist AVA sofort da: Die Realtime-Sitzung wird
  beim Einblenden aufgebaut (Schluessel praegen, WebRTC verbinden, ca. 1 s),
  die Kugel wacht mit dem Fade auf.
- Nach einer Stille von 20 Sekunden (Entscheidung 8.8) ohne laufenden
  Auftrag geht AVA in den Ruhezustand: Die WebRTC-Verbindung wird
  geschlossen, es laeuft nichts mehr bei OpenAI, es entstehen keine Kosten.
  Die Kugel schrumpft und dunkelt ab (Transition 600 ms), darunter steht
  "Sag „Hey AVA", um AVA zu aktivieren". Laeuft ein Auftrag, schlaeft AVA
  nicht; die Ansage des Ergebnisses weckt sie nicht extra, sie ist noch
  wach.
- Aktivierungswort lokal, ohne Cloud: Im Ruhezustand hoert nur das Geraet
  zu. Ein Energie-VAD im Renderer (WebAudio) schneidet bei Sprache ein
  Fenster von etwa zwei Sekunden aus, das lokale Whisper-Modell (bereits
  fuer Sprachnachrichten gebuendelt, `main/voice/whisper-sidecar.ts`)
  transkribiert es, und ein toleranter Vergleich erkennt "Hey AVA" (auch
  "he Ava", "hey Afa", "hallo AVA"). Audio verlaesst das Geraet dabei nicht.
  Kein Whisper-Modell installiert: Der Hinweis lautet stattdessen "Tippe
  auf die Kugel oder druecke die Leertaste", und der Ruhezustand bleibt
  trotzdem (Kosten).
- Wecken: Aktivierungswort, Klick auf die Kugel, Leertaste oder Tippen in
  die Eingabezeile. Beim Wecken: kurzer Signalton (wie bei Alexa, eigener
  Klang, etwa 300 ms, abschaltbar), Kugel waechst und hellt auf (Transition
  600 ms), Sitzung wird neu aufgebaut; die Kugel zeigt "denkt", bis die
  Verbindung steht, dann "hoert". Der Nutzer spricht nach dem Ton; was er
  waehrend des Aufbaus sagt, wird lokal gepuffert und als erster
  Audio-Puffer an die Sitzung gegeben (`input_audio_buffer.append`), damit
  nichts verloren geht.
- Beim Wecken bekommt die neue Sitzung die letzten Zuege der Unterhaltung
  als Kontext (wie bei der 55-Minuten-Neuverbindung), damit "und was ist
  mit deren Umsatz?" nach einer Pause noch funktioniert.
- Kein Link, kein Menue, keine Navigation. `navigate`-Frames ignoriert;
  Alerts/Toasts der App werden im Sprachmodus zurueckgehalten und beim
  Verlassen gezeigt.

---

## 5. Werkzeuge, Rueckfragen, Rendering

- Werkzeuge/Skills/Autonomie: unveraendert ueber den Orchestrator. Der
  Sprachmodus setzt `conversationId` auf die aktuelle Unterhaltung (oder
  legt eine neue an) und markiert Zuege als `quelle: "sprache"` (fuer den
  Verlauf und die Vorschlaege).
- Bestaetigungen (confirmAction): muendlich, siehe Abschnitt 2; die
  bestehenden Sicherheitsregeln (destruktives nie ohne Ja) gelten weiter;
  die Sprach-KI darf ein Ja nur weitergeben, wenn der Nutzer es
  ausdruecklich gesagt hat (Instruktion + Test S5).
- Diagramme/Buying Center: entstehen wie im Chat aus dem Orchestrator; der
  Relay reicht sie als Bloecke durch. "Subagent" im Sinne der Anforderung
  ist hier der Orchestrator-Zug selbst, der asynchron laeuft, waehrend die
  Sprach-KI weiterspricht. Ein zweiter paralleler Auftrag wird in die
  Warteschlange genommen (Orchestrator ist je Unterhaltung seriell); die
  Sprach-KI sagt das.
- Anhaenge: Bilder als `images` im `AgentSendInput`, Dokumente ueber die
  bestehende Anhangs-Logik (`composePromptWithAttachments`).

**Bildschirm folgt dem Gespraech (Zusatz 2026-09-24):** Bloecke bleiben so
lange sichtbar, wie das Gespraech sie braucht, und verschwinden oder
wechseln von selbst, wenn der Fokus sich verschiebt. Drei Ebenen:
1. Jeder Block bekommt eine Kennung, einen Titel und einen Bezug
   (companyId, Personenname, Thema). Die Sprach-KI kennt jederzeit die
   Liste "Auf dem Bildschirm: …" (sie wird jedem Ergebnis von
   `ava_bearbeiten` angehaengt und nach jeder Aenderung als kurzer
   Systemhinweis in die Sitzung gelegt).
2. Die Sprach-KI raeumt aktiv auf: Instruktion "Wenn das Gespraech zu
   einer anderen Firma, Person oder Frage wechselt, entferne Bloecke, die
   dazu nichts beitragen (`ava_anzeigen`), bevor du antwortest; ein Block,
   ueber den gerade gesprochen wird, bleibt." Kein Nachfragen dafuer, kein
   Ankuendigen; es passiert nebenbei.
3. Der Relay raeumt passiv auf, ohne Modell: Kommt ein neuer Block zu
   einer anderen Firma als die sichtbaren, ersetzen die neuen die alten
   (gleiche Firma: anhaengen, gleicher Typ zur gleichen Firma: ersetzen).
   Bloecke, die 10 Minuten lang weder erwaehnt noch angefasst wurden,
   blenden aus; die Kugel faehrt zurueck in die Mitte, wenn nichts mehr da
   ist. Der Nutzer kann jeden Block per Klick festpinnen (bleibt, bis er
   ihn schliesst) oder wegwischen.

---

## 6. Prompting der Sprach-KI (Instruktionen)

Kern (Deutsch, wird als `session.instructions` gesetzt):
- Du bist AVA, weiblich, klar und direkt. Du sprichst Deutsch, Du-Form.
- Kurze Saetze. Keine Fuellwoerter, kein "aehm", kein Vorgeplaenkel, keine
  Wiederholung der Frage. Keine Tabellen, keine Aufzaehlung ueber drei
  Punkte, keine URLs vorlesen. Zahlen runden, Einheiten nennen.
- Fakten NUR aus Ergebnissen von `ava_bearbeiten`. Alles ueber Firmen,
  Personen, Zahlen, Termine, Stand der App: erst `ava_bearbeiten`, dann
  antworten. Nie raten, nie ergaenzen. Weisst du etwas nicht: sag es.
- Waehrend ein Auftrag laeuft: ein Satz Ueberbrueckung ("Ich schaue nach."),
  dann warten. Kommt das Ergebnis, fasse es zusammen: das Wichtigste zuerst,
  hoechstens vier Saetze; biete Vertiefung an.
- Ist ein Diagramm oder Buying Center auf dem Bildschirm: sag, dass es zu
  sehen ist, beschreibe in einem Satz, was es zeigt.
- Der Bildschirm folgt dem Gespraech: Wechselt das Thema (andere Firma,
  andere Person, andere Frage), entferne Bloecke, die nichts mehr beitragen,
  mit `ava_anzeigen`, ohne es anzukuendigen. Was gerade besprochen wird,
  bleibt. Fragt der Nutzer nach etwas Frueherem, zeige es wieder.
- Rueckfragen des Systems (Bestaetigungen) stellst du woertlich; ein Ja
  gibst du nur weiter, wenn der Nutzer eindeutig zustimmt.
- Verlassen des Sprachmodus geht nur ueber das X; du bietest keine
  Navigation an.

---

## 7. Phasen

| Stufe | Inhalt | Aufwand |
| --- | --- | --- |
| S0 | Einstellung (Schalter, Stimme, Kostenhinweis), Orga-Schalter `sprachmodus`, Chat-Werkzeug `sprachmodus_konfigurieren`, Praegung des Client-Schluessels im Hauptprozess (eigen/Organisation), IPC `sprache:session` | 1 Tag |
| S1 | Overlay `/sprache`: Fade, Kugel mit Pegeln, WebRTC-Verbindung, Datenkanal, Mikrofon stumm/laut, X, Esc; Transkriptzeile | 2 Tage |
| S2 | Relay: `ava_bearbeiten` → Orchestrator-Zug, Ergebnis nachreichen, `ava_rueckfrage_beantworten`, Rueckfragen-Karte unter der Kugel | 2 Tage |
| S3 | Bloecke unter der Kugel (Chart, Buying Center, Textkarte ohne Links), Kugel faehrt hoch; "Bildschirm folgt dem Gespraech": Block-Kennungen mit Bezug, `ava_anzeigen`, Liste "Auf dem Bildschirm" fuer die Sprach-KI, passives Aufraeumen im Relay, Pinnen/Wegwischen | 1,5 Tage |
| S4 | Eingabezeile + Anhaenge im Sprachmodus, Zuege im Chatverlauf markiert, Alerts zurueckhalten | 1 Tag |
| S4b | Ruhezustand nach Stille (Verbindung zu, keine Kosten), Aktivierungswort lokal ueber Whisper, Wecken per Kugel/Leertaste/Tippen, Signalton, Audio-Puffer beim Aufbau, Kontext-Uebergabe | 1,5 Tage |
| S5 | Verbrauchsmeldung an das Gateway (Organisationsschluessel), 55-Minuten-Neuverbindung, Prompt-Tests (Fangfragen, Ja-Weitergabe, Tabellenvermeidung) | 1 Tag |
| S6 | Feinschliff: reduzierte Bewegung, Fehlerbilder (kein Mikrofon, Netz weg, Schluessel ungueltig), Doku | 0,5 Tag |

Reihenfolge S0 → S1 → S2 sind das Minimum fuer ein erstes Gespraech mit
Werkzeugen; S3–S6 danach. Gateway-Deploy nur fuer S5 (Usage-Endpunkt).

---

## 8. Offene Entscheidungen

1. **Architektur:** Stimme-plus-Relay (Empfehlung, Abschnitt 0.1) oder das
   Realtime-Modell direkt mit den Werkzeugen (Abschnitt 9)?
2. **Verbrauch beim Organisationsschluessel:** Usage-Meldung ueber neuen
   Gateway-Endpunkt (Empfehlung) oder Sprachmodus nur mit eigenem
   Schluessel erlauben, bis das Kontingent ihn kennt?
3. **Unterhaltung:** Sprachmodus setzt die aktuell geoeffnete Unterhaltung
   fort (Empfehlung) oder oeffnet immer eine neue?
4. **Weiss im Dunkelmodus:** echtes Weiss wie das Vorbild (Empfehlung, es
   ist ein eigener Modus) oder Hell-Grau der Palette?
5. **Stimme:** `marin` als Standard, Auswahl unter den weiblichen Stimmen;
   soll die Organisation die Stimme vorgeben koennen (wie das
   Deep-Research-Modell)?
6. **Nach 60 Minuten:** stille Neuverbindung mit Kontext (Empfehlung) oder
   Hinweis und Ende?
7. **Transkript im Chatverlauf:** gesprochene Zuege vollstaendig speichern
   (Empfehlung, Nachvollziehbarkeit) oder nur die Auftraege?
8. **Stille bis zum Ruhezustand:** 20 Sekunden (Empfehlung; kurz genug,
   dass eine Denkpause des Nutzers nicht laufend Geld kostet, lang genug
   fuer eine Antwort auf eine Rueckfrage) oder einstellbar 10–60 s?
9. **Aktivierungswort:** "Hey AVA" ueber das lokale Whisper (Empfehlung,
   kein zusaetzliches Modell, Audio bleibt lokal; Erkennung braucht etwa
   eine Sekunde) oder ein eigener Wake-Word-Detektor (schneller, aber
   neues Modell samt Training auf "Hey AVA")?

---

## 9. Spaeterer Ausbau: Realtime direkt mit Werkzeugen

Wenn die Wartezeit ueber den Relay stoert: Das Realtime-Modell bekommt
`tool_search`/`tool_load` und die Kernwerkzeuge direkt (session.update
laedt weitere nach), Bestaetigungen laufen ueber die UiBridge mit einem
Sprach-Adapter, Skills werden als Instruktionsbloecke nachgeladen. Das ist
ein zweiter Orchestrator-Pfad und ein eigener Plan; die Oberflaeche aus
S1/S3/S4 bleibt unveraendert.

---

## 10. Risiken

- Halluzination beim Nacherzaehlen: Instruktion + Tests; zusaetzlich gibt
  der Relay die Antwort in kurzen Absaetzen, damit das Modell wenig
  umformulieren muss.
- Mikrofonrechte unter macOS/Windows (Electron: `systemPreferences.askForMediaAccess`),
  Info.plist-Eintrag `NSMicrophoneUsageDescription` pruefen.
- WebRTC hinter Firmen-Proxys: TURN nicht in unserer Hand; Fehlerbild
  "Verbindung nicht moeglich" mit Hinweis.
- Kosten: Gespraechsminuten sind teurer als Chat; Kostenhinweis an der
  Einstellung, Verbrauchsmeldung (S5), kein automatischer Start.

---

## 11. Stand der Umsetzung (2026-09-24, v0.1.727)

Entscheidungen des Nutzers: Architektur Stimme-plus-Relay; Orga-Schluessel
erlaubt (Orga-Schalter `sprachmodus`); frisch geoeffnet = neue Unterhaltung,
offener Bildschirm fuehrt den Faden fort (auch nach Ruhezustand); echtes
Weiss; Stimme fest `marin` (keine Auswahl); stille Neuverbindung; Transkript
vollstaendig; 20 s Stille, letzte 8 s sichtbar (Ring + Countdown-Text);
Aktivierungswort ueber Whisper, aber nur pegelgesteuert (kein Dauerlauf).

| Stufe | Stand |
| --- | --- |
| S0 | gebaut: `main/sprache/store.ts` (sprache.json), `session.ts` (Client-Schluessel eigen/Organisation ueber `providers.openaiZugang()`), Orga-Schalter, Einstellung in Modelle → Sprachmodus, Werkzeug `sprachmodus_konfigurieren`, IPC `sprache:*` |
| S1 | gebaut: Route `/sprache` (Vollbild, Weiss-Fade), `lib/realtime.ts` (WebRTC, Datenkanal, Pegel), `components/SprachKugel.tsx`, Mikrofon stumm (turn_detection null), X/Esc, Transkriptzeile |
| S2 | gebaut: `main/sprache/relay.ts` (Orchestrator-Zug, Ergebnis per `sprache:ergebnis`, Rueckfragen), Werkzeuge `ava_bearbeiten`, `ava_rueckfrage_beantworten`, Rueckfrage-Karte unter der Kugel |
| S3 | gebaut: Chart-/Buying-Center-Bloecke unter der Kugel, Kugel schrumpft/faehrt hoch, `ava_anzeigen`, Liste "Auf dem Bildschirm", passives Aufraeumen (andere Firma ersetzt, 10 Min ohne Erwaehnung), Pinnen/Schliessen, Anker-Klicks abgefangen |
| S4 | teilweise: Eingabezeile (Text geht als Nachricht an die Sprach-KI, die entscheidet ueber `ava_bearbeiten`); OFFEN: Anhaenge (Bilder/Dokumente), Markierung der Zuege im Chatverlauf, Alerts zurueckhalten |
| S4b | gebaut: Ruhezustand nach `ruheSekunden` (Verbindung zu), Countdown-Ring, Wecken per Kugel/Leertaste/Tippen, Aktivierungswort `lib/wachwort.ts` (Pegel-Detektor + Whisper-Fenster), Signalton, Kontext-Uebergabe an die neue Sitzung; OFFEN: Audio-Puffer waehrend des Aufbaus |
| S5 | OFFEN: Verbrauchsmeldung ans Gateway (Orga-Schluessel), 55-Minuten-Neuverbindung, Prompt-Tests |
| S6 | OFFEN: Push-to-Talk bei stummem Mikrofon, Fehlerbilder, Doku |

Nicht im laufenden Programm geprueft (nur Typecheck und Build): erster
Praxistest durch den Nutzer nach dem Release.
