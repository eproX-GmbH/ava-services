# Plan: Sign in with ChatGPT — ChatGPT-Abo direkt nutzen (2026-10-06)

## Befund

OpenAI bietet seit Herbst 2026 „Sign in with ChatGPT“ (SIWC) mit **ChatGPT
plan usage**: Eine App meldet den Nutzer per OAuth bei auth.openai.com an und
darf mit dessen Access-Token die **öffentliche Responses API**
(`https://api.openai.com/v1/responses`) auf Kosten des ChatGPT-Abos aufrufen.
Das ersetzt den heutigen Codex-Umweg (`chatgpt.com/backend-api/codex/...`
mit Codex-Modellfamilie, 32-KiB-Instructions-Grenze, Codex-Header).

Was die Dokumentation festlegt (developers.openai.com/siwc):

- **Zielgruppe:** „open-source and locally hosted apps“. Für „paid or
  remotely hosted apps“ gilt das Interessenformular
  (openai.com/form/sign-in-with-chatgpt-interest). Die Partnerliste mit
  Plan-Nutzung (Amp Code, Devin, Lovable, Notion, Vercel, Warp …) sind
  genehmigte Partner mit eigener Client-ID.
- **Pläne:** Plan-Nutzung nur für **Plus und Pro**. Team/Enterprise/Free
  können sich anmelden, aber nicht auf Plan-Kosten rechnen.
- **Registrierung ohne Bewerbung:** `client_id=dynamic_agent_client` bei der
  ersten Anmeldung, plus `ext_agent_host_id` (stabile `urn:uuid:` je
  Installation) und `agent_name_hint` (App-Name). Der Callback liefert eine
  eigene `oaiapp_…`-Client-ID, die gespeichert und für alle weiteren
  Anmeldungen und Refreshes dieser Installation verwendet wird.
- **OAuth:** `GET https://auth.openai.com/api/accounts/authorize` mit
  `response_type=code`, PKCE S256, `state`, `nonce`,
  `redirect_uri=http://127.0.0.1:<port>/auth/callback` (Pfad fest, Port
  frei, nicht `localhost`), `resource=https://api.openai.com/v1`,
  `scope=openid profile email offline_access resource.invoke
  chatgpt.tokens.use.direct`. Token:
  `POST https://auth.openai.com/api/accounts/oauth/token`
  (`authorization_code` + `code_verifier`, später `refresh_token`).
  Access-Token 1 h, Refresh-Token 30 Tage rollierend. Plan-Nutzung nur, wenn
  die Token-Antwort den Scope `chatgpt.tokens.use.direct` enthält.
- **Modelle:** `GET https://api.openai.com/v1/models` mit dem Access-Token
  liefert die für das Konto freigegebenen Modelle (`slug`, `display_name`,
  `visibility`). **Der Nutzer kann daraus selbst wählen.** Serverreihenfolge
  beibehalten, `display_name` anzeigen.
- **Inference:** nur Responses API, `store:false` und `stream:true` sind
  Pflicht; Erfolg erst bei `response.completed`. **Nicht erlaubt:**
  chat/completions, embeddings, audio, realtime, deep research.
- **Fehler:** 401 `subscription_sharing_invalid_user` (neu anmelden),
  403 `subscription_sharing_user_not_eligible` (kein Plus/Pro oder
  Freigabe fehlt), 429 `subscription_sharing_usage_limit_exceeded`
  (Nutzer zu chatgpt.com/settings/usage leiten, „Manage usage“),
  503 `subscription_sharing_usage_unavailable` (Backoff),
  400 `subscription_sharing_unsupported_capability`.
- **Nutzerkontrolle:** Der Nutzer legt in ChatGPT → Settings → Usage je App
  ein Wochenlimit als Prozent seines Plans fest (10–100 %) und kann die
  App dort trennen. Die App erfährt davon nichts außer über Fehler.
- **UI-Pflichten:** Button „Continue with ChatGPT“ mit dem offiziellen
  weißen ChatGPT-Logo; Hinweis „Eligible AI requests in this app use your
  ChatGPT plan“; Link zu chatgpt.com/settings/usage; bei Limit „Manage
  usage“ als Hauptaktion. Nur englische Vorlagen dokumentiert.

## Einordnung für AVA

AVA ist **lokal gehostet** (Compute beim Nutzer) und der Code ist **öffentlich**
(ava-services seit 2026-09-19 public), aber AVA ist ein **bezahltes
Produkt** (Seat-Abrechnung). Technisch funktioniert der dynamische Flow für
jede lokale App. Die Dokumentation ordnet bezahlte Apps dem Interessenformular
zu. Empfehlung: den dynamischen Flow bauen (er ist der dokumentierte Weg für
lokal gehostete Apps) **und** parallel das Formular einreichen, damit AVA auf
die Partnerliste mit eigener Client-ID kommt. Die Entscheidung über die
Lizenz-Einordnung liegt beim Operator (siehe Todos).

Was besser wird als heute (Codex):

| Heute (Codex-Backend) | Neu (SIWC, Responses API) |
|---|---|
| Nur Codex-Modellfamilie, backend-gegated, Modell wird automatisch gewählt | Alle für das Konto freigegebenen Modelle, Nutzer wählt selbst |
| `instructions` ≤ 32 KiB, System-Prompt als developer-Nachricht | Öffentliche Responses API, normale Limits |
| Codex-Header, inoffizieller Endpunkt | Dokumentierter, offizieller Flow |
| Nur Chat (Producer nutzen env-LLM) | Chat und lokale Producer möglich (Responses API) |

Was gleich bleibt: Embeddings, Realtime (Sprachmodus), Deep Research und
Audio laufen **nicht** über den Plan. Dafür braucht es weiter einen
API-Schlüssel (eigener oder Organisation) oder lokale Modelle.

## Stand (v0.1.761, 2026-10-06)

Entscheidungen des Operators: Interessenformular eingereicht; bis zur
Antwort laeuft der dynamische Flow; Hintergrund-KI nutzt das Abo
**standardmaessig mit**, mit Hinweis-Dialog vor der Anmeldung (Limit in
ChatGPT setzen).

Umgesetzt S1–S4:

- `main/auth/siwc-oauth.ts` (Parameter, PKCE, Host-ID, Callback,
  Token-Tausch, Refresh) und `main/auth/siwc-oauth-flow.ts`
  (Anmeldefenster, Redirect-Abfang ohne lokalen Server). Redirect
  `http://127.0.0.1:1456/auth/callback`.
- Speicher: `OpenAISubscriptionRecord.flow` „codex“ | „plan“ plus
  `clientId`, `subject`, `email`, `idToken`, `scopes`, `planModel`.
  Refresher verzweigt nach `flow`. Altbestand bleibt Codex, bis der Nutzer
  neu verbindet.
- Provider: `createOpenAIPlanModel` (api.openai.com/v1, Bearer,
  `store:false`), `listePlanModelle` (GET /v1/models, 30 Minuten gecacht),
  Fehlerabbildung `subscription_sharing_*` in verstaendliche Saetze.
  Gewaehltes Modell je Verbindung, sonst `is_default` bzw. erstes.
- Organisation: `TenantPolicy.chatgptPlanErlaubt` (Standard an),
  Schalter in der Organisation, Desktop blendet Karte und Modus ohne
  Freigabe aus; eine gespeicherte Verbindung ruht dann. **Unter
  Anbieter-Sperre** (v0.1.765): Die Freigabe gilt trotzdem; ein
  verbundenes Abo (nur Plan-Flow, nicht Codex) hat im Chat und in der
  Hintergrund-KI Vorrang vor dem Organisationsschluessel, die Producer
  bleiben beim Schluessel der Organisation. Befund: Operator-Organisation
  hat die Sperre an, Karte war unsichtbar.
- Oberflaeche: Karte „ChatGPT-Abo“ mit „Continue with ChatGPT“ (offizielles
  Logo, englischer Pflichttext), zweistufig mit Limit-Hinweis, Konto,
  Modellauswahl aus der Kontoliste, „Manage usage“, Trennen; Erstlauf-
  Assistent und Fehlerbanner nutzen den neuen Flow. Chat-Werkzeug
  `settings_chatgpt_plan` (stand | modelle | modell).

S6 erledigt (v0.1.770, Operator-Entscheidung): Codex-Pfad komplett entfernt
(`auth/openai-oauth*.ts`, Codex-Builder, Account-ID-Header, IPC
`connectOpenAISubscription`). Gespeicherte Verbindungen ohne
`flow: "plan"` entfernt der Store beim ersten Lesen; der Nutzer meldet sich
einmal neu ueber „Continue with ChatGPT“ an. v0.1.769: Speicher schreibt
alle Felder (Befund: `flow` ging verloren, Plan-Token ging an Codex → 401);
Plan-Verbindung ohne Plan-Scope zaehlt nicht (Team/Business/Free).

Offen: S5 Verbrauchsanzeige (Kennzeichnung „ChatGPT-Abo“ je Aufruf), S7
manuelle Tests mit einem Plus/Pro-Konto (Erstanmeldung, Wiederanmeldung,
429-Pfad, Trennen in ChatGPT). **2026-10-09:** Producer, Recherche Standard
und Workflows laufen ebenfalls ueber das Abo (Loopback-Token-Dienst,
streamObject statt generateObject) — docs/PLAN_CHATGPT_ABO_UEBERALL.md.

## Umsetzung

### S1 OAuth-Client (Desktop main)

- `main/auth/siwc-oauth.ts` (neu): Host-ID `urn:uuid:` einmalig je
  Installation in `userData/siwc-host.json`; PKCE; Loopback-Server auf
  `127.0.0.1` mit freiem Port und Pfad `/auth/callback` (nur loopback,
  Regel „neue Server nur 127.0.0.1“); Authorization-URL mit
  `dynamic_agent_client` beim ersten Mal, danach gespeicherte
  `oaiapp_`-Client-ID plus `id_token_hint`; Token-Tausch; `state`/`nonce`
  prüfen; `sub` als Kontoidentität; Scope-Prüfung auf
  `chatgpt.tokens.use.direct`.
- Speicherung je Account verschlüsselt (safeStorage) wie heute
  `openai-subscription.enc`, erweitert um `clientId`, `hostId`, `subject`,
  `email`, `scopes`, `idToken`. Refresh 5 Minuten vor Ablauf; bei
  `invalid_grant`/`refresh_token_reused` Token löschen, Neuanmeldung.
- Der alte Codex-Flow bleibt als Rückfall erhalten, bis S6 ihn ablöst.

### S2 Modell-Liste und Provider

- `GET /v1/models` mit Access-Token → Liste `{slug, display_name}` (nur
  `visibility=list`), 30 Minuten je Konto gecacht, Serverreihenfolge.
- Neuer Auth-Modus `openaiAuthMode: "chatgpt-plan"` neben `api-key` und
  `subscription` (Codex). `createOpenAIPlanModel()` auf
  `https://api.openai.com/v1` mit Bearer, `store:false`, `stream:true`,
  Fehlerabbildung auf die obigen Codes. Chat und lokale Producer (Env-Shape
  um Token + Modus erweitert, Producer refreshen nicht selbst, sondern holen
  den Token über den bestehenden Loopback-Weg vom Desktop).
- Modellwahl: Settings und Chat-Tool `settings_*` zeigen die Kontoliste
  statt des Katalogs; Standard = erstes Modell mit `is_default`, sonst
  erstes der Liste. Gespeichert je Konto.

### S3 Organisationsvorgabe

- `TenantPolicy.chatgptPlanErlaubt Boolean @default(true)` (Gateway,
  Migration), `PUT /v1/tenants/me/policy`, `OrgPolicy.chatgptPlanErlaubt`
  im Desktop. Schalter in der Organisation neben „Eigener Apify-Token“.
- Wirkung: `false` → Anmelde-Karte und Modus ausgeblendet (Regel
  „Gesperrtes komplett ausblenden“), bestehende Verbindung ruht, Chat
  fällt auf Organisations-Schlüssel oder lokale Modelle. Unter
  `providerLock` gilt die Vorgabe der Organisation wie heute.
- **Nur eigene Konten:** Es gibt keinen Organisations-Account. Die
  Verbindung liegt je Account im Nutzerprofil (safeStorage, nie im
  Gateway), die Host-ID je Installation. Admin-Werkzeuge sehen nur, OB ein
  Mitglied verbunden ist, nie Tokens.

### S4 Oberfläche

- Karte „ChatGPT-Abo“ in den Einstellungen: Button „Continue with ChatGPT“
  mit offiziellem Logo (englischer Pflichttext; darunter deutsche
  Erklärung), verbundenes Konto (E-Mail), gewähltes Modell (Picker aus der
  Kontoliste), Hinweis „Eligible AI requests in this app use your ChatGPT
  plan“, Link „Nutzung und Limits in ChatGPT verwalten“
  (chatgpt.com/settings/usage), Trennen.
- Fehlerkarten: 429 → „Wochen- oder Stundenlimit erreicht“ mit „Manage
  usage“; 403 → „Plan-Nutzung nicht freigegeben oder kein Plus/Pro“;
  401 → „Erneut anmelden“.
- Chat-Tool: Anmeldung anstoßen, Modell wählen, trennen (Regel
  „Self-Service im Chat“, Erst-Consent ausgenommen).

### S5 Nutzung und Kosten

- `LlmUsage.quelle` und Verbrauchsanzeige: Plan-Aufrufe ohne Kostenschätzung
  (wie heute beim Abo), Kennzeichnung „ChatGPT-Abo“.
- Hintergrund-KI (Herzschlag, Auffrischung) über den Plan nur, wenn der
  Nutzer es in den Einstellungen ausdrücklich erlaubt (Standard: aus),
  weil das Wochenlimit mit allen Apps geteilt wird und der Nutzer sonst
  im Chat ohne Kontingent dasteht.

### S6 Ablösung Codex

- Nach zwei stabilen Releases: Codex-Modus für neue Anmeldungen entfernen,
  bestehende Codex-Tokens beim Start einmalig zur Neuanmeldung über SIWC
  einladen, danach Codex-Code entfernen.

### S7 Tests

- Unit: PKCE, Callback-Parsing (client_id, state, access_denied),
  Scope-Prüfung, Refresh-Rotation, Fehlerabbildung.
- Manuell: Erstanmeldung, Wiederanmeldung ohne Consent, Limit-Fall (Usage
  in ChatGPT auf 10 % stellen), Trennen in ChatGPT → 401-Pfad.

Aufwand grob: S1–S2 drei Tage, S3–S4 zwei Tage, S5–S7 zwei Tage.

## Todos für den Operator

1. **Interessenformular einreichen:** openai.com/form/sign-in-with-chatgpt-interest
   mit AVA als lokal gehostete, bezahlte Desktop-App mit öffentlichem Code.
   Ziel: eigene Client-ID und Aufnahme in die Partnerliste. Ohne Antwort
   läuft der dynamische Flow.
2. **Lizenz-Einordnung entscheiden:** AVA als „open-source and locally
   hosted“ (dynamischer Flow ohne Freigabe) oder als „paid app“ (Freigabe
   abwarten). Empfehlung: bauen, Formular parallel, bis zur Antwort nur
   für die eigene Organisation und Pilotkunden freischalten.
3. **Branding-Assets** herunterladen und freigeben:
   developers.openai.com/assets/siwc/sign-in-buttons/chatgpt-logo-white.svg
   plus Button-Vorgaben aus developers.openai.com/siwc/ui-ux-guidelines.
   Englischer Pflichttext „Continue with ChatGPT“ bleibt, deutsche
   Erklärung darunter.
4. **Mit einem Plus- oder Pro-Konto testen** (Team-Konten können nicht auf
   Plan-Kosten rechnen) und in ChatGPT → Settings → Usage das App-Limit
   setzen, um den 429-Pfad zu prüfen.
5. **Nutzungsbedingungen prüfen:** Hinweis in AVA, dass Aufrufe das
   persönliche Wochenlimit verbrauchen und der Nutzer in ChatGPT trennen
   kann. Datenschutz: Daten gehen an api.openai.com wie beim API-Schlüssel.
6. **Entscheidung Hintergrund-KI über den Plan:** Standard aus (Vorschlag)
   oder an.

## Offen

- Ob `instructions` in der Responses API für den Plan ein Größenlimit hat
  (Codex hatte 32 KiB); im Zweifel bleibt die developer-Nachricht.
- Ob `GET /v1/models` `is_default` liefert (Codex tat es); sonst erstes
  Modell der Liste.
- Ob Team-Workspaces künftig freigeschaltet werden.

## Quellen

- developers.openai.com/siwc (Übersicht, Partnerliste)
- developers.openai.com/siwc/token-sharing-open-source (Plan-Nutzung)
- developers.openai.com/siwc/token-sharing-open-source/sign-in (Registrierung, OAuth)
- developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- developers.openai.com/siwc/token-sharing-open-source/token-reference
- developers.openai.com/siwc/ui-ux-guidelines
- developers.openai.com/siwc/request-client-id
- developers.openai.com/cookbook/articles/sign-in-with-chatgpt (Electron-Beispiel)
- workos.com/blog/sign-in-with-chatgpt-plan-usage-scope (Einordnung, 1. Okt. 2026)
