# Plan: Telegram unterwegs — Rückstau, Bilder, Sprachnachrichten

Stand: 2026-08-23 · Leitszenario: Vertriebler diktiert unterwegs Anweisungen
in den Telegram-Chat; der Laptop mit AVA liegt offline in der Tasche. Zurück
im Büro (AVA läuft, Netz da) arbeitet AVA den Rückstau ab.

## P1 — Rückstau zuverlässig abarbeiten (Defekt-Behebung)

**Befund.** `startAutonomousConversation` gibt `null` zurück, wenn der
Orchestrator gerade beschäftigt ist — reiht die Anfrage aber INTERN ein
(`pendingAutonomousQueue`). Der Telegram-Empfänger wertet `null` als
„beschäftigt", antwortet entsprechend und wartet nicht auf das Ergebnis:
**die spätere Antwort geht ins Leere.** Genau der Rückstau-Fall.

**Fix.**
- Bei `null` NICHT abwimmeln, sondern in Ruhe warten, bis der Agent frei ist
  (Poll mit Backoff, Obergrenze ~5 Min), dann selbst starten. So bleibt die
  Zuordnung Anfrage → Antwort erhalten.
- Nachrichten strikt **nacheinander** abarbeiten (ist im Batch bereits so;
  gilt jetzt auch über Batches hinweg).
- Durchsatzbremse neu fassen: Ein *Rückstau* ist kein Missbrauch. Statt hart
  bei 30/h abzuweisen, wird der Rückstau abgearbeitet und nur die *Frequenz*
  begrenzt (Pause zwischen Anfragen), damit nichts verloren geht.

**Grenze, die bleibt (Telegram-seitig):** unabgeholte Nachrichten werden
~24 h vorgehalten. Länger offline ⇒ ältere Anweisungen sind weg. Das ist
nicht änderbar; es gehört in die UI-Erklärung.

## P2 — Bilder

**Befund.** Es wird nur `message.text` gelesen; Fotos fallen durch
(`if (!text) continue`). Die Agenten-Seite kann Bilder aber bereits:
`AgentMessage.images` (`{ base64, mimeType, filename? }`) wird vom
Desktop-Chat genutzt.

**Umsetzung.**
- `client.ts`: `getFile(file_id)` + Download über
  `api.telegram.org/file/bot<token>/<path>`; Größenlimit (~10 MB).
- Größtes angebotenes Foto wählen (Telegram liefert mehrere Auflösungen).
- `startAutonomousConversation` um `images` erweitern (bisher nur Text) und
  im Orchestrator an die Initial-Nachricht hängen.
- Bildunterschrift (`caption`) wird als Anweisungstext verwendet; fehlt sie,
  ein neutraler Standardtext („Was siehst du auf diesem Bild?").
- Kann das aktive Modell keine Bilder, klare Rückmeldung statt stiller
  Fehlschlag.

## P3 — Sprachnachrichten (lokal transkribiert)

**Befund.** Whisper ist bereits gebündelt und im Hauptprozess nutzbar
(`WhisperSidecar.transcribe(audio: Uint8Array)`), erwartet aber **16-bit-PCM-
WAV**. Telegram liefert **OGG/Opus**. `ffmpeg` ist bewusst NICHT im Bundle
(siehe `recordVoice.ts`: Resampling passiert im Renderer, um genau das zu
vermeiden).

**Umsetzung — Opus-Dekodierung ohne neue Abhängigkeit.** Chromium kann Opus
von Haus aus. Wir dekodieren in einem versteckten Fenster:
`decodeAudioData` → auf 16 kHz mono umrechnen → als 16-bit-PCM-WAV
zurückgeben (dieselbe Kette wie beim vorhandenen Sprachaufnahme-Feature).
Ergebnis geht an `whisper.transcribe`.

**Damit bleibt die Transkription vollständig auf dem Rechner** — kein
Cloud-Dienst, passend zum Datensouveränitäts-Versprechen.

**Bestätigungsschleife (wichtig).** Transkription kann Namen und Zahlen
verfälschen. Bevor etwas ins CRM wandert, schickt AVA zurück, was sie
verstanden hat („🎙️ Verstanden: …") und arbeitet dann damit weiter. Der
Vertriebler sieht die Grundlage seiner Anweisung im Chat.

**Grenzen:** Ist Whisper nicht bereit oder kein Sprachmodell installiert,
klare Meldung mit Hinweis auf die Einstellungen — statt stillem Ignorieren.

## Reihenfolge
P1 (Defekt) → P2 (klein, Infrastruktur vorhanden) → P3 (Dekodier-Kette).
