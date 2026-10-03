# Hintergrundaufgaben im Chat (2026-10-03)

Nutzerwunsch: Startet AVA eine Verarbeitung (Import einer oder mehrerer
Firmen), soll der Chat sie selbst verfolgen, die laufende Verarbeitung
hervorheben und sich mit dem Ergebnis melden, sobald sie fertig ist, statt
„frag später nach dem Stand“ zu sagen. Vorbild: Hintergrundaufgaben und
Subagenten in Claude Code und Codex.

## Vorbild

Claude Code startet lange Arbeit im Hintergrund und bekommt eine Aufgaben-ID.
Eine Aufgabenleiste zeigt laufende Aufgaben mit Fortschritt. Das Modell fragt
nicht selbst ab, sondern erhält bei Abschluss eine Benachrichtigung im
Gesprächsverlauf und meldet dem Nutzer daraufhin von sich aus das Ergebnis.
ChatGPT und Codex arbeiten ereignisgesteuert genauso: Aufgabe läuft weiter,
auch wenn man den Chat verlässt, und meldet sich bei Abschluss.

## Umsetzung (v0.1.743)

| Teil | Datei | Was |
| --- | --- | --- |
| Wächter | `main/aufgaben/aufgaben.ts` | Aufgaben je Unterhaltung, Stand alle 20 s über `/v1/transactions/{id}/entities`, Abschluss = alle Firmen completed/failed/skipped, „hängt“ nach 2 Std. ohne Fortschritt, Ablage `userData/hintergrund-aufgaben.json` (überlebt Neustart), Aufräumen nach 7 Tagen |
| Registrierung | `main/index.ts` | Automatisch nach `import_excel`, `import_companies`, `import_companies_from_crm` (Ereignis `werkzeug-ergebnis` des Orchestrators) |
| Werkzeuge | `agent/tools/aufgaben.ts` | `aufgabe_beobachten` (jede andere transactionId, „sag Bescheid, wenn fertig“), `aufgaben_liste` |
| Meldung | `orchestrator.meldeAufgabe` | Notiz `[Hintergrundaufgabe abgeschlossen] …` als Nachricht mit quelle „aufgabe“ in die Unterhaltung, Zug startet, Modell antwortet von sich aus. Läuft gerade ein Zug, versucht der Wächter es beim nächsten Takt. Je Takt höchstens eine Meldung |
| Oberfläche | `components/AufgabenLeiste.tsx`, `Chat.tsx` | Leiste über dem Eingabefeld: laufend mit pulsierendem Punkt und Balken „12 von 40 Firmen fertig“, fertig mit Haken, hängt in Orange; × beendet nur das Verfolgen. Die Notiz erscheint als Hinweiszeile, nicht als Nutzer-Blase |
| Benachrichtigung | `main/index.ts` | Systembenachrichtigung, wenn die App nicht im Vordergrund ist |
| Prompt | `agent/prompts.ts` | Nach Import ankündigen, dass AVA sich meldet; Antwort auf die Notiz: Ergebnis, Erkenntnisse, Fehlschläge, nächster Schritt; bei „hängt“ Neuanstoß nur anbieten |

Kosten: Beobachten ist ein reiner Gateway-Abruf ohne KI. Erst die Meldung ist
ein Modellzug. Im Worker-Modus und abgemeldet pausiert der Wächter.

## Stufe 2: Lebendigkeit und Abbruch, Telegram (v0.1.744)

Nutzervorgabe: Solange sich irgendetwas bewegt, nie abbrechen. Kommt ein
Vorgang eine Stunde gar nicht weiter, automatisch mit Fehler beenden. Über
Telegram gestartete Vorgänge melden das Ergebnis in Telegram.

| Ebene | Regel |
| --- | --- |
| Producer (5 von 6) | Lebenszeichen: alle 5 Min. erneut `in_progress`, solange ein Lauf arbeitet. company-evaluation sendet bewusst kein in_progress (8 parallele Teile, kurze LLM-Aufrufe) |
| Gateway-Zeitwächter | unverändert: Schritt ohne Lebenszeichen seit 30 Min. → failed. Mit Lebenszeichen trifft das nur noch tote Läufe |
| Desktop-Aufräumer | Neuanstoß nur bei Schritten, die 15 Min. still sind (vorher: alle älter als 60 s, auch gesunde), höchstens 2-mal je Schritt (`userData/auto-neustarts.json`). Vorher setzte jeder Neuanstoß die Uhr des Zeitwächters zurück: Endlosschleife ohne Fehler |
| Aufgaben-Wächter | Lebendigkeit = jede Änderung an Zählern oder am jüngsten Zeitstempel eines Schritts (`GET /v1/transactions/{id}/fortschritt`). 60 Min. ohne jede Änderung → `POST /v1/transactions/{id}/abbrechen` setzt offene Schritte auf failed, Meldung `[Hintergrundaufgabe abgebrochen]`. Fertig erst, wenn zwei Takte lang kein Schritt offen ist und 90 s Ruhe herrscht (Übergang zwischen Schritten) |
| Telegram | Unterhaltungen `telegram-…`: Abschluss-Zug als Telegram-Zug, Antwort als Nachricht bzw. Sprachnachricht aufs Handy; Fortschritt nur in der App |

Warum 30 und 60 Minuten: Der längste legitime Einzelschritt ist Deep
Research mit bis zu 35 Minuten, sendet aber alle 5 Minuten ein
Lebenszeichen. 30 Minuten Funkstille sind also sechs verpasste
Lebenszeichen, der Lauf ist sicher tot. Auf Vorgangsebene bewegt sich bei
einem lebenden Import praktisch immer etwas; 60 Minuten völliger Stillstand
heißt, dass nichts mehr kommt (z. B. App zu, Producer gestoppt, Gateway
gestört). Ein später echter Abschluss überschreibt den Fehler trotzdem.

## Grenzen

- Die Meldung braucht eine laufende App. Ist die App zu, meldet AVA beim
  nächsten Start (der Wächter liest den Stand nach).
- Nur Vorgänge mit transactionId. Best-Match-Jobs und Recherche-Läufe je
  Firma haben eigene IDs; Kandidaten für eine zweite Ausbaustufe.
