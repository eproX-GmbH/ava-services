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
  unterbrechen. Tippen geht unten in der Zeile, Bilder (bis vier) und Dokumente (PDF,
  Excel, CSV; bis drei) ueber + oder Einfuegen.
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

- Sprachmodell `gpt-live-1` (GPT Live, 0,05 $/Min, Abrechnung je Sekunde),
  Stimme fest `marin`, WebRTC zwischen Desktop und OpenAI; Ereignisse ueber
  den Datenkanal. Der Standardschluessel bleibt im Hauptprozess: er legt die
  Live-Sitzung mit dem SDP-Angebot des Renderers an (`POST /v1/live/
  sessions`, direkt oder ueber den Gateway-Proxy). Kann OpenAI die Live-
  Sitzung nicht anlegen, laeuft die Realtime API (`gpt-realtime-2.1-mini`)
  als Rueckfall.
- Die Sprach-KI ist nur die Stimme. Werkzeuge, Skills, Gedaechtnis und
  Rueckfragen laufen ueber den Relay (`main/sprache/relay.ts`) in den
  Chat-Orchestrator. GPT Live delegiert per `session.delegation.created`;
  der Auftrag ist das Gesagte seit der letzten Delegation, das Ergebnis
  kommt als Commentary zurueck und wird vorgelesen.
- Verbrauch beim Organisationsschluessel: `POST /v1/llm-usage` mit den
  Gespraechssekunden (GPT Live) bzw. Token-Zahlen (Realtime-Rueckfall).
- Laeuft eine Sitzung bei OpenAI ab (`session.closed`, reason expired),
  verbindet der Desktop still neu und gibt die letzten Zuege als Kontext mit.
- Tests: `npm run test:sprachmodus` (Relay-Text, Bloecke, Wachwort,
  Instruktionsregeln, Werkzeuge).

## Offen

Nichts aus dem Plan; Praxistest mit echtem Mikrofon und OpenAI steht aus.
