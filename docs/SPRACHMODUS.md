# Sprachmodus: Bedienung und Technik

Stand 2026-09-24 (v0.1.728). Plan und Entscheidungen: docs/PLAN_SPRACHMODUS.md.

## Bedienung

- **Einschalten:** Einstellungen → Modelle → Sprachmodus. Braucht einen
  OpenAI-Schluessel (eigener oder der der Organisation; eigener hat Vorrang,
  die Anbieter-Sperre erzwingt den der Organisation). Die Organisation kann
  den Sprachmodus ueber den Schalter `sprachmodus` abschalten; dann
  verschwinden Knopf, Einstellung und Werkzeug. Im Chat:
  "Sprachmodus einschalten" (Werkzeug `sprachmodus_konfigurieren`).
- **Starten:** der Wellen-Knopf im Chat neben dem Mikrofon. Der Bildschirm
  wird weiss, die Kugel erscheint, AVA ist sofort verbunden.
- **Sprechen:** einfach reden; AVA erkennt Satzenden selbst und laesst sich
  unterbrechen. Tippen geht unten in der Zeile, Bilder ueber + oder
  Einfuegen (bis zu vier).
- **Kugel:** atmet im Leerlauf, dehnt sich wenn AVA spricht, zieht sich beim
  Zuhoeren zusammen und wird dunkler, pulsiert wenn AVA arbeitet. Diagramme
  und Buying Center erscheinen unter der Kugel, die dabei nach oben faehrt.
  Bloecke lassen sich pinnen oder schliessen; AVA raeumt bei Themenwechsel
  selbst auf, nach zehn Minuten ohne Erwaehnung blenden sie aus.
- **Ruhezustand:** nach 20 Sekunden Stille (ohne laufenden Auftrag) geht die
  Verbindung zu, es entstehen keine Kosten. Die letzten acht Sekunden zeigt
  die Kugel einen Ring und "AVA hoert noch N s zu". Wecken: "Hey AVA" (lokal
  ueber das Whisper-Modell, nur bei erkannter Sprache; ohne installiertes
  Modell: Klick auf die Kugel oder Leertaste), Tippen, oder Klick. Der
  Gespraechsfaden bleibt erhalten.
- **Mikrofon stumm:** Knopf unten; dann Leertaste gedrueckt halten, um zu
  sprechen (Push-to-Talk).
- **Beenden:** X unten rechts oder Esc. Sonst gibt es im Sprachmodus keine
  Navigation und keine Links.
- **Kosten:** Gespraechsminuten kosten mehr als Chat (grob 0,20–0,40 € je
  Minute, dazu die Chat-Zuege wie bisher). Beim Schluessel der Organisation
  landet der Verbrauch im Kontingent der Organisation.

## Fehlerbilder

| Meldung | Ursache | Was hilft |
| --- | --- | --- |
| Zugriff auf das Mikrofon verweigert | Systemrecht fehlt | "Mikrofon-Einstellungen oeffnen", Recht erteilen, "Erneut verbinden" |
| Kein Mikrofon gefunden | kein Eingabegeraet | Geraet anschliessen oder in den Systemeinstellungen waehlen |
| Keine Verbindung zu OpenAI | Netz weg, WebRTC hinter Proxy/Firewall blockiert | Internet pruefen, anderes Netz; Firmen-Proxys blockieren oft UDP/WebRTC |
| OpenAI-Schluessel abgelehnt | Schluessel ungueltig oder widerrufen | eigener: Einstellungen → Modelle; Organisation: Administrator erneuert den Schluessel |
| Kontingent erschoepft | Guthaben/Limit bei OpenAI oder Kontingent der Organisation | Guthaben nachladen, Limit abwarten |

## Technik (kurz)

- Realtime-Modell `gpt-realtime-2.1`, Stimme fest `marin`, WebRTC direkt
  zwischen Desktop und OpenAI; Ereignisse ueber den Datenkanal.
- Der Standardschluessel bleibt im Hauptprozess: `POST /v1/realtime/
  client_secrets` (direkt oder ueber den Gateway-Proxy) liefert den
  ephemeren Client-Schluessel fuer den Renderer.
- Die Sprach-KI ist nur die Stimme. Werkzeuge, Skills, Gedaechtnis und
  Rueckfragen laufen ueber den Relay (`main/sprache/relay.ts`) in den
  Chat-Orchestrator; die Sprach-KI hat nur `ava_bearbeiten`,
  `ava_rueckfrage_beantworten`, `ava_anzeigen`.
- Verbrauch beim Organisationsschluessel: je Antwort `POST /v1/llm-usage`
  (Token-Zahlen aus `response.done.usage`, Realtime-Preise je Audio-/Text-
  Token, Kanal chat).
- Sitzungen enden bei OpenAI nach 60 Minuten; der Desktop verbindet nach
  55 Minuten still neu und gibt die letzten Zuege als Kontext mit.
- Tests: `npm run test:sprachmodus` (Relay-Text, Bloecke, Wachwort,
  Instruktionsregeln, Werkzeuge).

## Offen

Dokumente (PDF/Excel) als Anhang, Markierung der Sprach-Zuege im
Chatverlauf, Alerts im Sprachmodus zurueckhalten, Audio-Puffer waehrend des
Verbindungsaufbaus beim Wecken.
