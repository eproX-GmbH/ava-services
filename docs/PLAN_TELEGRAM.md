# Plan: Telegram als Benachrichtigungskanal

Stand: 2026-08-22 · Basis: Code-Kartierung `services/desktop`.

## Architekturentscheidung: nativer Kanal, kein Skill

Die Zustellung wird **nativ** gebaut, nicht als Skill:

- Benachrichtigungen entstehen im **Hintergrund**. Der Heartbeat feuert sein
  `alerts`-Event als schlichter synchroner Fan-out (`main/index.ts:1667`) —
  ohne Orchestrator, ohne Chat-Turn. Ein Skill bräuchte einen LLM-Turn pro
  Meldung, abhängig von LLM-Bereitschaft und Warteschlange.
- **Kosten + Determinismus:** Für ein festes `POST /bot<token>/sendMessage`
  ein LLM zu bemühen kostet Tokens (frisst das Tageslimit aus v0.1.405) und
  wäre nicht reproduzierbar.
- Skills laufen im Hintergrund nur über `startAutonomousConversation`
  (`agent/orchestrator.ts:569`) — heute Mail-förmig und LLM-gated.

**Aber:** Zusätzlich entsteht ein `telegram_send_message`-Agent-Tool. Damit
wird der openclaw-artige Teil möglich — eigene Skills wie „Schick mir jeden
Morgen die Top-LinkedIn-Signale per Telegram" nutzen denselben Client.
Der *Kanal* ist deterministisch, das *Was* darf Skill-getrieben sein.

## 1. Datenmodell & Speicherung

Zwei getrennte Orte, weil der Bot-Token ein Geheimnis ist:

| Wert | Ort | Warum |
|---|---|---|
| `botToken` | `userData/telegram/bot-token.enc` (safeStorage) | Credential, verschlüsselt — Muster von `mail/credentials.ts` |
| `chatId`, `enabled`, `botUsername`, Schwellwert | `userData/telegram/config.json` | unkritische Konfiguration |

Eigenes Top-Level-Verzeichnis `userData/telegram/` (analog `crm/`, `linkedin/`),
damit der **Werksreset** es sauber mitnimmt: `"telegram"` in
`reset-store.ts` → `topLevelTargets` ergänzen. (Ein `agent/telegram.enc`
würde den Reset überleben — die Keep-Regel dort ist „alles nicht explizit
Gelistete bleibt". Das wäre ein Datenleck über den Reset hinweg.)

## 2. Verbindungs-Flow (die eigentliche UX-Arbeit)

Niemand soll eine numerische Chat-ID suchen müssen:

1. Nutzer erstellt Bot bei **@BotFather** → kopiert Token.
2. Token in AVA einfügen → AVA ruft `getMe` → zeigt **„Verbunden mit
   @DeinBot"** (validiert den Token sofort, wie `notion_connect_save_token`).
3. AVA zeigt: *„Öffne @DeinBot in Telegram und schicke `/start`."*
4. AVA pollt `getUpdates` (max ~60 s, mit Abbruch-Knopf) und **liest die
   Chat-ID automatisch** aus der ersten eingehenden Nachricht.
5. AVA sendet automatisch eine **Testnachricht** → sichtbarer Beweis.

Fallback für Gruppen-Chats: manuelles Eintragen der Chat-ID bleibt möglich.

Wichtig: `getUpdates` kollidiert mit gesetzten Webhooks und mit parallelen
Pollern. Wir pollen nur kurz während der Einrichtung (und in Phase 2
dauerhaft, siehe unten) und melden `409 Conflict` verständlich.

## 3. Zustellung

**Choke-Point:** `NotificationManager.notifyForAlert` (`main/notifications.ts:72`).
Refactor in `gate()` + `deliver()`, damit mehrere Kanäle bedient werden.
Alle 4 Aufrufer (Heartbeat, Scheduler-Reminder, Link-Monitor, Konstruktion)
bleiben unverändert.

**Eigene Gates pro Kanal.** Heute gilt ein Gate für OS-Push (`pushEnabled`,
`pushSeverityThreshold`, Quiet Hours). Telegram bekommt **eigene** Schalter —
typischer Wunsch: „Desktop-Push aus, aber Wichtiges aufs Handy". Also:
`telegram.enabled`, eigener `severityThreshold`, und ein Schalter
„Ruhezeiten auch für Telegram beachten" (Default: ja).

**Warteschlange + Rate-Limit (kritisch).** Telegram erlaubt ~1 Nachricht/s
pro Chat. Alert-Wellen sind real (siehe die 10 gleichzeitigen
Corgi-LinkedIn-Meldungen). Deshalb:
- Interne Queue mit ~1 Nachricht/Sekunde Taktung.
- **Bündelung:** mehr als N Meldungen (z. B. 3) innerhalb eines kurzen
  Fensters (z. B. 10 s) werden zu **einer Sammelnachricht** zusammengefasst
  („5 neue Meldungen: …"). Verhindert Spam und `429`.
- `429 Too Many Requests` → `retry_after` respektieren.

**Zustellsicherheit.** Netzwerk offline darf keine Meldung verlieren:
kleine **Outbox** (letzte N ungesendete Meldungen persistent), Retry mit
Backoff, Aufgabe nach X Versuchen mit Log. Kein stiller Verlust.

**Kein Egress-Blocker.** Es gibt keine globale Host-Allowlist (nur die
Mail-Empfänger-Allowlist). Trotzdem bleibt der Kanal bewusst **opt-in** und
erst nach erfolgreichem Test aktivierbar — analog `outboundEnabled` bei Mail.

## 4. Nachrichtenformat

Telegram bietet viel mehr Platz als ein OS-Toast (der `bodyFor()` sogar die
Begründung wegwirft). Format (HTML-Parse-Mode, sicherer als MarkdownV2):

```
⚠️ <b>{headline}</b>
{companyName}
{rationale}
🔗 {url}
```
Severity-Emoji: `ℹ️` info · `⚠️` warn · `❗` urgent. `url` (z. B.
LinkedIn-Permalink) als Inline-Button, wenn vorhanden. Alle Felder
HTML-escapen — Firmennamen können `<`/`&` enthalten.

## 5. Settings-UI

Neue `TelegramSection.tsx`, gerendert in **`AutomatisierungenTab.tsx`**
direkt nach `<AlertsSection/>` (der Kanal erweitert die Meldungs-Prefs).
Muster: `LinkMonitorSection.tsx` (Aufbau) + `MailAccountSection.tsx`
(Verbinden/Testen-Flow, inkl. der Konvention, **das Geheimnis nie
zurück ins Formular zu spiegeln** — Snapshot liefert nur
`{connected, botUsername, chatId}`, nie den Token).

Elemente: Token-Feld → „Verbinden", Status-Zeile, Chat-ID-Ermittlung mit
Fortschritt, „Testnachricht senden", Schwellwert-Auswahl, Ruhezeiten-Schalter,
„Trennen".

## 6. Agent-Tools

Neue `agent/tools/telegram.ts`, Muster `notion.ts:37-119`:
- `telegram_connect_start` — Anleitung (BotFather → Token → /start)
- `telegram_connect_save_token` — Token speichern + validieren, **niemals
  zurückgeben** (Beschreibung explizit: „Never echo the token back")
- `telegram_status` / `telegram_disconnect`
- `telegram_send_message` — freie Nachricht (macht Skills möglich)

Registrierung in `tools/index.ts` mit Lazy-Getter (Muster v0.1.261).

## 7. Phase 2 (später, optional): Eingehende Befehle

Reizvoll („AVA vom Handy fragen"), aber ein **Sicherheitsthema** — direkt
verwandt mit der Confirm-Gate-Frage aus dem Security-Review:

- **Nur die konfigurierte Chat-ID akzeptieren.** Jeder, der den Bot-Namen
  kennt, kann ihm schreiben. Alles andere verwerfen.
- **Eingehender Text ist nicht vertrauenswürdig** (Prompt-Injection direkt
  in den Agenten mit allen Tools).
- **Der Confirm-Gate schützt weiterhin:** `askChoice` wirft im autonomen
  Modus (`ui-bridge.ts:84`), destruktive Tools (CRM-Löschen) können also aus
  Telegram heraus **nicht** ausgeführt werden — es fällt geschlossen aus.
  Das ist gewollt und muss so bleiben.
- Empfehlung: Telegram-initiierte Turns laufen auf einer **lesenden
  Tool-Teilmenge**; alles Verändernde bleibt der Desktop-Oberfläche
  vorbehalten.
- Kein Webhook möglich (Desktop hinter NAT) → Long-Polling `getUpdates`,
  nur wenn eingehend aktiviert.

## Phasen & Aufwand

| Phase | Inhalt | Aufwand |
|---|---|---|
| T1 | Credentials-Store + Config + Reset-Integration | ~½ Tag |
| T2 | Telegram-Client (`getMe`, `sendMessage`, `getUpdates`) + Retry/Timeout | ~½ Tag |
| T3 | Kanal in `NotificationManager` + Queue/Rate-Limit/Bündelung/Outbox | ~1 Tag |
| T4 | Settings-UI inkl. Chat-ID-Ermittlung + Test | ~1 Tag |
| T5 | Agent-Tools (ermöglicht Skills) | ~½ Tag |
| T6 | *optional* Eingehende Befehle + Sicherheitsgrenzen | ~1–2 Tage |

**Empfehlung:** T1–T4 als geschlossenes Feature ausliefern (dann funktionieren
Benachrichtigungen), T5 direkt danach (macht Skills möglich). T6 nur, wenn
zweiwege wirklich gewünscht ist — dann mit eigener Sicherheitsabnahme.

**STATUS T6 (v0.1.459): umgesetzt als „Rückfragen aufs Handy".**
Opt-in-Schalter `inboundConfirmEnabled` (Settings → Telegram, nur sichtbar
wenn der Eingang aktiv ist; Default AUS — dann bleibt das bisherige
Fail-Closed-Verhalten unverändert). Wenn an: Telegram-initiierte
Konversationen bekommen einen `RemoteAskHandler` (ui-bridge.ts), über den
`ask_user_choice`/`ask_user_text` die Rückfrage direkt in den verknüpften
Chat stellen (nummerierte Optionen, Antwort per Nummer/Text, „abbrechen"
lehnt ab). Sicherheitsgrenzen: nur der verifizierte Chat, 3-Minuten-Timeout
→ Abbruch (fail-closed), `ask_user_match` bleibt Desktop-only, alle
Rückfragen + Antworten im Audit-Trail. Die Rückfrage pollt getUpdates
selbst — die Haupt-Long-Poll-Schleife wartet währenddessen in
handleMessage, es gibt also nie zwei getUpdates-Konsumenten gleichzeitig.
