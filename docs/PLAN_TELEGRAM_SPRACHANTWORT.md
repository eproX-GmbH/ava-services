# Plan: Telegram-Antworten als Sprachnachricht

Stand 2026-09-25 (v0.1.729). Der Nutzer hat diesen Plan beauftragt; die
Datei gab es vorher nicht, sie wurde mit der Umsetzung geschrieben.

## Ziel

AVA antwortet im Telegram-Chat wahlweise als Text oder als
Sprachnachricht. Der Nutzer steuert das in der Nachricht selbst:

| Anweisung (tolerant erkannt) | Wirkung |
| --- | --- |
| "gerne per Textnachricht" | diese eine Antwort als Text, auch wenn Sprache Standard ist |
| "gerne immer per Textnachricht" | Standard = Text |
| "gerne per Sprachnachricht" | diese eine Antwort gesprochen, auch wenn Text Standard ist |
| "gerne immer per Sprachnachricht" | Standard = Sprachnachricht |

Die Absicht bestimmt das Modell des Nutzers, nicht ein Wortmuster
(`antwortSteuerungErmitteln`): Auch "sag's mir lieber muendlich", "ich kann
gerade nicht lesen, bin im Auto" oder "schreib mir ab jetzt wieder" werden
verstanden. Klare Formulierungen ("gerne per Sprachnachricht") trifft ein
Muster vorweg, dann faellt kein Modellaufruf an. Das Urteil ist JSON, mit
yup geprueft; ohne Modell oder bei Fehler gilt "keine Anweisung". Das
guenstige Hintergrund-Modell wird genutzt, falls eines vorgegeben ist. Die
Anweisung wird aus der Nachricht entfernt, bevor sie an den Agenten geht. Besteht die Nachricht nur aus der
Anweisung, bestaetigt AVA kurz und startet keinen Zug.

## Umsetzung

- `main/telegram/sprachantwort.ts`: `parseAntwortSteuerung(text)` (Modus,
  dauerhaft, bereinigter Text) und `sprachantwortErzeugen(text, zugang)`
  (OpenAI `audio/speech`, Modell `gpt-4o-mini-tts`, Stimme `marin` wie im
  Sprachmodus, Ausgabe Opus, Anweisung an die Stimme: deutsch, klar,
  direkt).
- `main/telegram/client.ts`: `sendVoice` (Multipart, OGG/Opus).
- `main/telegram/inbound.ts`: Steuerung vor dem Zug auswerten; bei
  "immer" `antwortModus` in der Telegram-Konfiguration umstellen; Prompt-
  Hinweis fuer gesprochene Antworten (Gespraechsform, kurze Saetze, keine
  Links vorlesen); `antworten()` schickt Sprachnachricht oder faellt bei
  fehlendem Schluessel oder Fehler der Stimme auf Text mit Hinweis zurueck.
  Die Antwort geht nie verloren.
- Schluessel wie im Chat: eigener zuerst, Organisation ueber den Gateway-
  Proxy (`providers.openaiZugang()`); Verbrauch ueber den Proxy erfasst.
- Einstellung: Telegram-Abschnitt "Standardmaessig als Sprachnachricht
  antworten"; Chat-Werkzeug `telegram_antwortmodus` mit Rueckfrage.
- Tests: `npm run test:telegram-sprachantwort` (Parser).

## Grenzen

- Stimme nur mit OpenAI-Schluessel; lokal gibt es keine Sprachausgabe.
- Hoechstens 3.800 Zeichen je Sprachnachricht (Rest wird abgeschnitten;
  der Prompt bittet um hoechstens sechs Saetze).
- Rueckfragen (ask_user_choice) im Telegram-Chat bleiben Text, damit die
  Nummern zum Antworten sichtbar sind.
