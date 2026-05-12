# Anthropic-Authentifizierung in AVA

AVA unterstützt zwei Wege, gegen Anthropic zu authentifizieren:

1. **Api-Schlüssel** (Standard) — verbraucht Anthropic-Api-Credits.
2. **Subscription-OAuth-Token** — verbraucht das Pro-, Max-, Team- oder
   Enterprise-Abo des Nutzers statt Api-Credits.

Beide Credentials liegen verschlüsselt im OS-Schlüsselbund (Electron
`safeStorage`) und können parallel gespeichert sein. Welche Variante
gerade aktiv ist, bestimmt das Feld `anthropicAuthMode` in
`provider.json` (`"api-key"` oder `"subscription"`).

## Wofür ist die Subscription-Variante gedacht?

Wer ein laufendes Claude.ai-Abo besitzt, möchte typischerweise nicht
zusätzlich Api-Credits dazukaufen. Der Subscription-Token routet alle
Anthropic-Aufrufe aus AVA gegen das vorhandene Abokontingent.

## Empfohlen: In-App-Anmeldung (v0.1.133+)

Seit v0.1.133 gibt es einen Ein-Klick-Login direkt aus AVA — kein
Terminal nötig.

- **First-Run-Wizard:** die dritte Karte „Claude.ai Pro/Max-Abo" trägt
  jetzt den Button „Mit Claude.ai verbinden". Klick öffnet ein
  Anmeldefenster bei claude.ai, AVA fängt das Token nach
  erfolgreichem Login automatisch ab und speichert es verschlüsselt.
- **Settings → Anbieter → „Claude.ai Pro/Max-Abo":** identischer
  Button „Mit Claude.ai verbinden" (bzw. „Neu verbinden", wenn schon
  ein Token vorhanden ist).

Unter der Haube läuft der OAuth-PKCE-Flow, den auch Anthropics
`claude setup-token` benutzt — derselbe öffentliche Client, dieselben
Endpunkte, derselbe `user:inference`-Scope. Der Code-Verifier bleibt
im Main-Process, der Code wird per Redirect-Interception auf der
Anthropic-eigenen `console.anthropic.com/oauth/code/callback`-URL
abgefangen, gegen ein Bearer-Token getauscht und in
`anthropic-subscription.enc` abgelegt.

## Fallback: Token manuell einfügen

Falls der In-App-Login nicht klappt (z. B. weil die Anmeldung in einem
Unternehmens-SSO hängenbleibt), bleibt der bisherige Paste-Flow
erreichbar:

```sh
npm install -g @anthropic-ai/claude-code   # einmalig
claude setup-token                          # interaktiver Flow
```

`claude setup-token` öffnet den Browser, fragt die Anmeldedaten ab und
gibt am Ende einen Token aus, der mit `sk-ant-oat01-…` beginnt. Der
Token lebt ein Jahr und ist auf Inference (Chat-Completions) beschränkt.
Quelle: <https://code.claude.com/docs/en/authentication>.

Diesen Token kannst du dann hinterlegen:

- **Settings → Anbieter → „Claude.ai Pro/Max-Abo" → „Advanced: Token
  manuell einfügen"** ausklappen, Token einfügen, „Speichern" klicken.
- **First-Run-Wizard:** auf der Subscription-Karte „Stattdessen Token
  manuell einfügen" wählen.
- Alternativ aus dem Chat heraus:
  `settings_set_anthropic_subscription_token` mit dem Tokenwert
  aufrufen. Der Agent verifiziert ihn am Anthropic-Modell-Endpoint und
  speichert ihn verschlüsselt. Der Token wird niemals in der Antwort
  wiedergegeben.

Speichern flippt den aktiven Anthropic-Auth-Modus automatisch auf
`"subscription"`. Anschließend einmal Anbieter auf Anthropic stellen
(falls noch nicht aktiv) — der Chat nutzt ab dem nächsten Turn das
Pro/Max-Kontingent.

## Drittapp-Caveat

Anthropic verlangt, dass Subscription-Authentifizierung normalerweise
nur durch Claude Code selbst genutzt wird. Drittapps, die den selben
OAuth-Token verwenden, **können** laut aktueller Anthropic-Policy als
„Extra Usage" oberhalb der Abogrenze abgerechnet werden (Quellen:
TheNewStack-Bericht zur Token-Politik, Hacker-News-Diskussion zum
Thema „Claude Code OAuth in Third-Party Apps"). AVA selbst sendet den
Token ausschließlich an `api.anthropic.com` und nirgendwohin sonst —
über die Abrechnungsseite hat AVA jedoch keine Kontrolle.

Wer das Risiko nicht eingehen will, bleibt beim Api-Schlüssel.

## Zwischen Auth-Modi wechseln

Liegen API-Key und Subscription-Token gleichzeitig im Schlüsselbund,
zeigt die Settings-Karte einen Umschalter „auf Api-Key umschalten" /
„auf Subscription umschalten". Der Modus wird über
`anthropic-subscription.enc` bzw. `anthropic.enc` ausgelesen — die
zuletzt gespeicherte Variante gewinnt automatisch.

Wer ganz wechseln will: Token bzw. Schlüssel über den jeweiligen
„Löschen"-Button entfernen.

## Token-Lebensdauer

Der Subscription-Token gilt ein Jahr ab `claude setup-token`-Aufruf.
Bei 401-Antworten von Anthropic den Token neu erzeugen
(`claude setup-token` erneut ausführen) und in AVA überschreiben.

## Verhalten unter der Haube

- **Header**: bei aktivem Subscription-Modus sendet AVA
  `Authorization: Bearer <token>` statt `x-api-key`. Zusätzlich
  `anthropic-beta: oauth-2025-04-20` als offizielle OAuth-Opt-in-
  Marke.
- **Probe**: `validateAnthropicSubscriptionToken` testet den Token
  gegen `GET /v1/models`. Wenn Anthropic dort 401 zurückgibt (manche
  Endpunkte sind nicht für OAuth freigeschaltet), markiert AVA das
  Ergebnis als „inconclusive" und erlaubt trotzdem das Speichern; der
  erste echte Chat-Turn klärt die Gültigkeit endgültig.
- **Speicherort**: `<userData>/agent/anthropic-subscription.enc` —
  parallel zu `anthropic.enc`, niemals zusammengelegt.
- **Producer-Subprocesse**: laufen unverändert env-getrieben. Wer
  einen Subscription-Token gesetzt hat, aber kein Anthropic-Api-Key,
  bekommt für seine lokalen Producer den env-Anthropic-Fallback (oder
  bleibt bei Ollama).
- **Catalog**: Modell-Auswahl ändert sich nicht — dieselben
  `claude-sonnet-*`- / `claude-haiku-*`-Modelle stehen in beiden
  Auth-Modi zur Verfügung.
