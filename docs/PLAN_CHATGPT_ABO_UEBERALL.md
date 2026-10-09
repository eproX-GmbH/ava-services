# Plan: ChatGPT-Abo für alles außer Sprache-zu-Sprache und Deep Research

Stand 2026-10-09. Auftrag des Operators: Bis auf Speech-to-Speech und Deep
Research soll ALLES über das persönliche ChatGPT-Abo (Plan-Flow von „Sign in
with ChatGPT“, docs/PLAN_SIGN_IN_WITH_CHATGPT.md) laufen können. Heute laufen
nur Chat, Hintergrund-KI und (ungewollt, Text sagt das Gegenteil) Workflows
darüber; die fünf Producer, die Recherche-Scouts und die Bildanalyse-Pfade
der Producer nutzen Schlüssel oder lokale Modelle.

## 1. Was der Plan-Flow erlaubt (OpenAI-Doku, gelesen 2026-10-09)

Quelle: developers.openai.com/siwc/token-sharing-open-source
(models-and-inference, preview-limitations, token-reference).

- Nur `POST /v1/responses` und `GET /v1/models` mit `Authorization: Bearer
  <Access-Token>`. `store: false` und `stream: true` sind Pflicht; Erfolg
  erst bei `response.completed`; 429 kann auch mitten im Stream als
  `response.failed` kommen (`subscription_sharing_usage_limit_exceeded`).
- Eingaben: Text, Bilder und Dateien, „wenn das Modell sie annimmt“.
  Nicht: Audio- und Videoeingabe, Files-API, Transkription.
- Werkzeuge: Funktionsaufrufe gehen (der Chat nutzt sie heute). Nicht:
  Bildgenerierung, File Search, Code Interpreter, Computer Use, Hosted
  MCP, `tool_search`. `web_search` ist nicht ausgeschlossen, aber „subject
  to model and account/workspace policy“, also zu testen.
- Wegzulassen: `background`, `previous_response_id`, `conversation`,
  `max_output_tokens`, `temperature`, `top_p`, `metadata`, `user`,
  `truncation`, `prompt`, `max_tool_calls`. Keine `system`-Nachrichten,
  stattdessen `instructions` oder developer-Nachricht.
- Nicht dokumentiert, also empirisch zu prüfen: strukturierte Ausgaben
  (`text.format: json_schema`), Reasoning-Parameter, Anfragegröße.
- Token: Access-Token 1 Stunde, Refresh-Token 30 Tage mit Rotation.
- Das Wochenlimit ist je Konto und wird mit allen Apps geteilt; der Nutzer
  setzt je App 10 bis 100 Prozent in ChatGPT → Settings → Usage.

Daraus folgt, was NICHT über das Abo gehen kann, unabhängig von AVA:

| Funktion | Grund | bleibt bei |
|---|---|---|
| Sprachmodus (GPT Live / Realtime) | Realtime nicht im Plan, vom Operator ausgenommen | Schlüssel |
| Deep Research | eigener Endpunkt mit `background`, vom Operator ausgenommen | Schlüssel |
| Telegram-Sprachantwort (Text zu Sprache, gpt-4o-mini-tts) | Audio-Endpunkt nicht im Plan | Schlüssel, sonst Textantwort |
| Embeddings | nicht im Plan | lokal (Ollama embeddinggemma, Standard) |
| Whisper (Telegram-Eingang, Wachwort) | läuft ohnehin lokal | lokal |

Alles andere ist ein Responses-Aufruf mit Text, Bild oder Datei und damit
grundsätzlich möglich.

## 2. Ist-Zustand je Konsument

| Konsument | Pfad heute | Abo heute | Hindernis |
|---|---|---|---|
| Chat, Telegram-Text, Vorschläge | Desktop `providers/manager.ts` → `createOpenAIPlanModel` (Responses, Plan-Fetch) | ja | – |
| Hintergrund-KI (Herzschlag, Auffrischung, LinkedIn, E-Mail-Zuordnung, Radar-Planner, ICP, Mini-Profil, Match) | `streamToText` über den Provider-Manager | ja | – |
| Workflows (KI-Schritt) | `streamToText` über den Provider-Manager | ja, obwohl der Text „gilt nicht“ sagt | nur Text (`workflows/runner.ts:1085`, `workflows/index.ts:173`, Website-Vorlage, PLAN_WORKFLOWS Entscheidung 3) |
| LinkedIn-Bildanalyse (Desktop) | `generateText` mit Bild über den Provider-Manager | ja (Bildeingabe erlaubt) | – |
| Producer company-profile, website, company-publication, company-contact, company-evaluation, structured-content (Gesellschafterlisten) | Kindprozess, `@ava/ai-provider` `getLLM()` mit `OPENAI_API_KEY` aus der Umgebung; 36 Aufrufe `generateObject`/`generateText` in 18 Dateien | nein | 1. kein Plan-Token im Kindprozess, 2. `generateObject` sendet `stream:false`, 3. Token läuft nach 1 h ab, Producer kennen keinen Refresh, 4. Rate-Limit 429 würde Firmen als fehlgeschlagen markieren |
| Recherche Standard (Stellenanzeigen, Ausschreibungen: Scout mit `web_search`, danach Extraktion) | website-Producer, OpenAI-SDK `responses.create` direkt | nein | wie Producer plus `web_search`-Policy ungeklärt |
| Organisationsschlüssel über Gateway (`AVA_LLM_VIA_GATEWAY`) | Gateway `/v1/llm/<anbieter>` | – | unberührt; unter Anbieter-Sperre hat das Abo im Chat Vorrang (v0.1.765), Producer bleiben beim Org-Schlüssel |

## 3. Entscheidungen (Vorschlag)

- **E1 Ein Token-Dienst statt Umgebungsvariable.** Der Desktop-Main öffnet
  einen Loopback-Endpunkt (127.0.0.1, zufälliger Port, Geheimnis je
  Start) `GET /plan-token`, der den aktuellen Access-Token des Plan-Flows
  liefert. Producer bekommen `OPENAI_PLAN_TOKEN_URL` und
  `OPENAI_PLAN_TOKEN_SECRET` statt eines Tokens. Der Fetch-Wrapper im
  geteilten Paket holt den Token je Anfrage (gecacht 60 s, bei 401 sofort
  neu). Damit entfällt der Producer-Neustart bei jedem Refresh
  (`scheduleCredentialCycle` nur noch bei Verbinden/Trennen).
  Regel „BYOK-Keys nie über Renderer-IPC“ bleibt: der Endpunkt lebt im
  Main, nur Kindprozesse mit dem Geheimnis kommen dran.
- **E2 Plan-Modell im geteilten Paket.** `@ava/ai-provider` bekommt den
  Plan-Builder (Responses-Modell, `store:false` erzwungen, Bearer statt
  `x-api-key`, Fehlerabbildung `subscription_sharing_*`), der heute nur im
  Desktop liegt. Vendor-Kopien aller Producer per `diff -r` nachziehen
  (CI-Guard check-vendor-drift).
- **E3 Streaming-Pflicht.** Alle `generateObject`-Aufrufe der Producer
  gehen auf eine Hilfsfunktion `objektErzeugen(model, args)` im Paket:
  bei Plan-Modell `streamObject` und am Ende `await result.object`,
  sonst wie heute `generateObject`. Kein Verhaltensunterschied für
  Schlüssel-Nutzer. `generateText` wird entsprechend zu `streamText` mit
  `await result.text`.
- **E4 Kontingent schützt den Chat.** Firmenverarbeitung über das Abo ist
  eine Einstellung je Nutzer: „Firmenverarbeitung über das ChatGPT-Abo“
  (Standard an, wie die Hintergrund-KI; Operator-Entscheidung vom
  2026-10-06). Daneben ein Hinweis, dass ein großer Import das Wochenlimit
  aufbrauchen kann, mit Link auf „Manage usage“. Chat-Werkzeug
  `settings_chatgpt_plan` bekommt `firmenverarbeitung: an|aus`
  (Self-Service-Regel). Organisation: `chatgptPlanErlaubt` deckt beides;
  unter Anbieter-Sperre gilt weiter der Organisationsschlüssel für
  Producer, das Abo nur, wenn die Organisation es ausdrücklich freigibt
  (neuer Schalter `chatgptPlanProducer`, Standard aus).
- **E5 429 heißt Pause, nicht Fehler.** Producer behandeln
  `subscription_sharing_usage_limit_exceeded` und `_usage_unavailable` als
  Rückstau: Nachricht per AMQP-NACK mit Requeue, Producer-Status
  „Kontingent des ChatGPT-Abos erschöpft, wartet“ mit Zeitstempel, kein
  Fehlerzähler je Firma. Der Desktop zeigt es in der Verarbeitungsleiste
  und im Chat-Vorschlag. Nach Ablauf (ChatGPT nennt die Rücksetzung) oder
  nach 30 Minuten erneuter Versuch.
- **E6 Deep Research, Sprachmodus, Audio bleiben bei Schlüssel.**
  Research-Stufe „Deep“ und die Sprachantwort melden ohne Schlüssel
  weiter „braucht einen OpenAI-Schlüssel“. Research-Stufe „Standard“
  (Scout mit `web_search`) geht über das Abo, sofern der Test in Schritt
  A0 das bestätigt; sonst bleibt sie bei Schlüssel und der Plan vermerkt
  es.
- **E7 Modellwahl.** Producer nutzen das im Abo gewählte Modell
  (`planModel`), nicht `LLM_MODEL`; die Producer-Modell-Übersteuerung
  (`getProducerModelOverride`) greift nur innerhalb der Kontoliste.
  Parameter, die der Plan verbietet (`temperature`, `max_output_tokens`),
  streicht der Fetch-Wrapper aus dem Body, damit bestehende Aufrufe
  unverändert bleiben.

## 4. Umsetzung

| Schritt | Inhalt | Dateien | Aufwand |
|---|---|---|---|
| A0 | Empirischer Test mit einem Plus/Pro-Konto, bevor Code entsteht: (a) `text.format json_schema` über `/responses` mit `stream:true`, (b) `stream:false` wird abgelehnt oder toleriert, (c) Bild- und PDF-Eingabe, (d) `web_search` als Werkzeug, (e) Verhalten bei `temperature` im Body, (f) 429 mitten im Stream. Skript im Scratchpad, Ergebnis in §6 | – | 0,5 Tage |
| A1 | Paket `@ava/ai-provider`: Plan-Builder aus dem Desktop übernehmen, Fetch-Wrapper mit Token-Abruf über `OPENAI_PLAN_TOKEN_URL`, verbotene Felder streichen, `objektErzeugen`/`textErzeugen`; `getLLM()` wählt den Plan, wenn die URL gesetzt ist; `getEmbedder()` ignoriert den Plan (lokal). Tests. Vendor-Kopien in allen fünf Producern plus structured-content | `packages/ai-provider/src/index.ts`, neu `plan-fetch.ts`; `*/src/vendor/ai-provider` | 1 Tag |
| A2 | Desktop: Loopback-Token-Endpunkt im Main (`main/auth/plan-token-server.ts`), Producer-Supervisor reicht URL und Geheimnis durch, wenn Abo verbunden, Plan-Scope vorhanden, Einstellung an und Organisation es erlaubt; Credential-Cycle nur bei Verbinden/Trennen; Status „Producer: ChatGPT-Abo (Modell X)“ in Einstellungen → Modelle | `main/index.ts`, `main/producer-supervisor.ts`, `main/agent/providers/store.ts`, `renderer/routes/Settings*.tsx` | 1 Tag |
| A3 | Producer: 36 Aufrufe auf `objektErzeugen`/`textErzeugen` umstellen (mechanisch, Verhalten für Schlüssel identisch); 429-Rückstau (E5) im gemeinsamen Compute-Worker-Muster; Research-Scout im website-Producer auf das Plan-Modell (Responses mit `web_search`, streaming, `background` weg), Deep Research unverändert | `website/src/infrastructure/openai/index.ts`, `website-judge.ts`, `company-*/src/infrastructure/openai/*.ts`, `company-contact/src/infrastructure/contact-extraction/*.ts`, `structured-content/src/application/verflechtungen/auswertung.ts`, je Producer der Compute-Worker | 1,5 Tage |
| A4 | Einstellung und Organisation (E4): `TenantPolicy.chatgptPlanProducer`, Desktop-Schalter, Chat-Werkzeug `settings_chatgpt_plan` erweitert, Fähigkeitsgruppe gepflegt; Verbrauchsanzeige kennzeichnet Producer-Aufrufe „ChatGPT-Abo“ (S5 aus dem SIWC-Plan) | Gateway `routes/v1/tenant-policy*.ts`, Desktop `agent/tools/settings.ts`, `billing`/`LlmUsage` | 1 Tag |
| A5 | Texte: Workflow-Runner und Workflow-Liste („Abo gilt nicht“ raus), PLAN_WORKFLOWS Entscheidung 3 nachführen, PLAN_SIGN_IN_WITH_CHATGPT Stand, Website-Vorlagen (`WEBSITE_PROMPT_WORKFLOWS`, `WEBSITE_PROMPT_UPDATE`: „ChatGPT-Abo ist kein vierter Weg“ prüfen) | docs, `workflows/runner.ts`, `workflows/index.ts` | 0,5 Tage |
| A6 | Live-Test: Import von 20 Firmen über das Abo (alle Producer), Token-Wechsel nach 1 h während eines Laufs, Wochenlimit auf 10 Prozent stellen und 429-Pause beobachten, Recherche Standard | – | 0,5 Tage |

Gesamt etwa 6 Tage, zwei Releases (Paket + Producer zuerst, dann Desktop
und Gateway-Schalter). Gateway-Schema: eine Spalte in `TenantPolicy`
(Freigabe vor dem Deploy).

## 5. Risiken

- **Wochenlimit.** Ein Import mit 200 Firmen erzeugt je Firma 5 bis 15
  Modellaufrufe; das kann ein Plus-Kontingent in Stunden leeren und den
  Chat lahmlegen. Deshalb E4 (Einstellung, Hinweis) und E5 (Pause statt
  Fehler). Der Nutzer begrenzt die App in ChatGPT selbst.
- **Strukturierte Ausgaben ungeklärt.** Wenn A0 (a) scheitert, bleiben die
  Producer bei Schlüssel; die Alternative, JSON aus Freitext zu parsen,
  ist unzuverlässiger und wird nicht gebaut.
- **Verbotene Parameter.** Bestehende Aufrufe setzen `temperature` oder
  `maxOutputTokens`; der Wrapper entfernt sie nur beim Plan-Modell. Das
  verändert leicht das Verhalten (kein Deckel), zu beobachten in A6.
- **Token-Dienst.** Loopback mit Geheimnis, nur 127.0.0.1 (Regel „neue
  Server nur 127.0.0.1“); fällt der Main weg, enden die Producer ohnehin.
- **Lizenz.** Der Plan-Flow gilt laut OpenAI für „open-source and locally
  hosted apps“; Producer laufen lokal, das passt. Das Interessenformular
  bleibt offen (Todo des Operators).
- **Anbieter-Sperre.** Organisationen mit Sperre bekommen die
  Producer-Nutzung nur über den neuen Schalter; sonst stünde das Abo des
  Nutzers über der Vorgabe der Organisation.

## 6. Ergebnis Schritt A0

Noch offen. Hier eintragen: Datum, Konto (Plus/Pro), Modell, Ergebnis je
Teiltest (a) bis (f).

## 7. Offene Entscheidungen

1. Standard der Einstellung „Firmenverarbeitung über das ChatGPT-Abo“: an
   (wie Hintergrund-KI) oder aus (Kontingent schonen)? Vorschlag: an, mit
   Hinweis beim Verbinden.
2. Soll die Organisation unter Anbieter-Sperre Producer über das Abo
   freigeben können (Schalter `chatgptPlanProducer`) oder bleibt es dort
   hart beim Organisationsschlüssel? Vorschlag: Schalter, Standard aus.
3. Research Standard über das Abo nur, wenn `web_search` im Test läuft;
   sonst weiter Schlüssel.
