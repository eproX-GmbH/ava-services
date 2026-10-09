# Plan: AVA öffnen — MCP-Server, Aufträge aus der Cloud, Rückmeldung

Stand 2026-10-09. Gespräch mit dem Operator: AVA bleibt eine lokale
Desktop-App (Compute-Lokalität, DECISIONS.md), soll aber von außen nutzbar
werden: Claude, ChatGPT und andere Agenten lesen verarbeitete Daten, legen
neue Aufträge an, und der Nutzer erfährt vom Ergebnis, auch wenn der Laptop
beim Anlegen nicht lief.

Entscheidungen des Operators (2026-10-09):

1. Aufträge aus MCP laufen **direkt** an, ohne Freigabe-Schleife. Beispiel:
   Excel-Liste über Claude hochladen, die Transaktion ist sofort da, die
   lokale App verarbeitet sie, sobald sie läuft.
2. Die Organisation kann **jedes MCP-Werkzeug einzeln** an- und abschalten
   (Org-Einstellungen), statt eines einzelnen Anonymisierungsschalters.
3. Aufträge aus MCP zählen gegen Plan und Kontingent **wie aus der App**.

## 1. Was MCP und A2A leisten, und was nicht

| Wunsch | MCP (Claude.ai, ChatGPT, Claude Code) | A2A (laufende Agenten) |
|---|---|---|
| Daten lesen (Firmen, Publikationen, Kontakte, Meldungen) | ja, Tools auf vorhandene Routen | ja, als Task mit sofortiger Antwort |
| Auftrag anlegen (Import, Auffrischung, Recherche) | ja, Tool schreibt Transaktion | ja, Task `submitted` |
| Status später abfragen | ja, Tool liest Fortschritt | ja, `tasks/get` |
| Proaktiv „fertig" melden | **nein**: Claude.ai/ChatGPT sind keine erreichbaren Agenten; nur beim nächsten Gespräch sichtbar | ja, Push an die Webhook-Adresse des aufrufenden Agenten |
| Proaktiv den **Nutzer** informieren | über AVA selbst: Telegram, Meldungen, Mail (vorhanden) | dito |

Folgerung: Die proaktive Rückmeldung geht an den Nutzer über die
vorhandenen Kanäle. A2A ist eine zweite Fassade über dieselben Aufträge,
sinnvoll erst mit konkreten Agenten-Partnern (Agent-SDK-Dienste, n8n,
Partner-Systeme), die eine Webhook-Adresse mitbringen.

## 2. Was es schon gibt (der „Task Delegator" zu zwei Dritteln)

- **Aufträge = Transaktionen.** `/v1/imports/excel` und `/v1/imports/from-list`
  legen in master-data eine Transaktion an und veröffentlichen die
  Pipeline-Ereignisse in **dauerhafte AMQP-Warteschlangen je Nutzer**. Die
  lokalen Producer holen sie ab, sobald die App läuft. Ein Import, der über
  MCP angelegt wird, wartet also ohne weiteres Zutun auf den Laptop.
- **Fortschritt** liegt im Gateway: `/v1/transactions` (Liste), `/{id}`,
  `/{id}/fortschritt` (Schrittebene), `/{id}/entities`, `/{id}/events` (SSE).
- **Cloud-fähige Arten ohne LLM/Browser** laufen heute schon im Fly-Worker:
  Register-Refresh, Insolvenz-Check, Registerfront (`RegisterJob`-Queue mit
  Lease, `refreshAnfordern`, `insolvenzAnfordern`, AT/UK-Jobs).
- **Rückmeldung an den Nutzer:** Hintergrundaufgaben (AVA meldet sich bei
  Abschluss, Telegram-Zustellung), Alerts (`/v1/alerts/neuheiten`), Mail.
- **Auth und Policy:** Keycloak-JWT mit Scopes im Gateway (`requireScope`),
  `TenantPolicy.features` mit Org-Schaltern, Keycloak-Admin-Client für
  Registrierungen (`KEYCLOAK_REGISTRAR_*`).

Es fehlt: ein MCP-Endpunkt mit OAuth, eine Auftragsart für „braucht die
App" jenseits von Importen (z. B. Recherche je Firma, Auffrischung je
Firma), die Herkunftskennung „mcp" an Transaktionen und die Org-Schalter
je Werkzeug.

## 3. Zielbild

```
Claude / ChatGPT / Claude Code          andere Agenten (A2A, später)
        │ OAuth 2.1 (Keycloak)                  │
        ▼                                       ▼
   db-gateway /mcp (Streamable HTTP) ──▶ db-gateway /v1 (bestehende Routen)
        │ Tools: lesen, Auftrag anlegen,        │
        │ Status, Meldungen                     ▼
        │                              Transaktion + AMQP je Nutzer
        │                                       │ wartet, bis die App läuft
        ▼                                       ▼
   Nutzer erfährt Ergebnis über         lokale AVA-App (Producer, LLM lokal)
   Telegram / Meldungen / Mail          Fly-Worker für cloud-fähige Arten
```

## 4. Bausteine

### M1 MCP-Endpunkt `/mcp` im Gateway (Entscheidung 2026-10-09: Route, kein eigener Dienst)

- Transport Streamable HTTP, Autorisierung nach MCP-Spezifikation:
  Protected-Resource-Metadata zeigt auf Keycloak, Clients registrieren sich
  per Dynamic Client Registration (Keycloak-Policy: nur Redirect-URIs der
  bekannten Hosts claude.ai, chatgpt.com, localhost für Claude Code), Token
  = dasselbe Keycloak-JWT wie in der App, also Tenant, Actor, Scopes.
- Der Server ist ein dünner Übersetzer: jedes Tool ruft eine Gateway-Route
  mit dem Nutzer-Token. Kein eigener Datenbankzugriff, keine LLM-Aufrufe
  in der Cloud (Compute-Lokalität bleibt).
- Herkunft: `X-AVA-Quelle: mcp:<client>` am Gateway-Aufruf; das Gateway
  schreibt sie an Transaktionen und Audit.

### M2 Werkzeuge (Startmenge)

| Werkzeug | Gateway-Route | Org-Schalter |
|---|---|---|
| `firma_suchen` (q, land, limit) | `/v1/companies/search` | `mcp.lesen` |
| `firma_lesen` (companyId, bereiche) | `/v1/companies/{id}` + Bereiche wie `company_get` (profil, register, publikationen, kunden, konzern, gesellschafter) | `mcp.lesen` |
| `firma_kontakte` (companyId) | `/v1/companies/{id}/contacts` | `mcp.kontakte` (Standard aus) |
| `meine_firmen` (Seite) | `/v1/companies/mine` | `mcp.lesen` |
| `meldungen` (seit) | `/v1/alerts/neuheiten` | `mcp.lesen` |
| `import_anlegen` (Datei oder Liste `[{name, ort, land}]`) | `/v1/imports/excel`, `/v1/imports/from-list` | `mcp.auftraege` |
| `auftrag_anlegen` (art: auffrischung, insolvenz, recherche, publikationen; companyIds) | neu `/v1/auftraege` (siehe M3) | `mcp.auftraege` |
| `auftrag_status` (transactionId) | `/v1/transactions/{id}/fortschritt` | `mcp.lesen` |
| `auftraege` (offen, fertig seit) | `/v1/transactions?quelle=mcp` | `mcp.lesen` |

Dateien: Claude.ai kann Dateien an Tools nur als Inhalt übergeben; das
Werkzeug nimmt deshalb Base64 (xlsx/csv bis 5 MB) oder die Liste als JSON.

### M3 Auftragsart „braucht die App" (`/v1/auftraege`)

- Tabelle `Auftrag` im Gateway: tenantId, actorId, art, nutzlast (JSONB),
  status (`offen`, `laeuft`, `fertig`, `fehler`, `verfallen`), `cloudFaehig`,
  transactionId (falls die Art eine Transaktion erzeugt), quelle, angelegt,
  erledigt, ergebnisVerweis.
- Cloud-fähige Arten (Register-Refresh, Insolvenz) werden sofort in die
  `RegisterJob`-Queue gelegt (vorhandene Funktionen), der Auftrag ist damit
  `laeuft`. App-pflichtige Arten warten; die App holt sie beim Start und
  dann alle 60 s mit Lease ab (Muster `stammdaten.mithelfen`), führt sie
  über die vorhandenen Wege aus (Recherche-Lauf, Publikationen-Neuverarbeitung,
  Kontakt-Recherche) und meldet `fertig` oder `fehler`.
- Verfall: offene App-Aufträge nach 14 Tagen `verfallen`, Hinweis an den
  Nutzer („Laptop war nicht an").
- Kontingent: dieselben Prüfungen wie in der App (Plan-Limits, Seat), die
  Herkunft ändert nichts.

### M4 Rückmeldung

- Abschluss eines MCP-Auftrags löst die vorhandene Hintergrundaufgaben-
  Meldung aus („Import aus Claude fertig: 23 Firmen, 2 Fehler"), damit
  Telegram und Meldungen greifen, auch wenn der Chat in Claude längst
  geschlossen ist.
- Für Claude selbst: `auftrag_status` und `auftraege` liefern den Stand
  beim nächsten Gespräch; die Tool-Beschreibung sagt ausdrücklich, dass
  die Verarbeitung lokal läuft und Stunden dauern kann.

### M5 Org-Schalter und Sicherheit

- `TenantPolicy.features`: `mcp` (Hauptschalter, Standard aus; Opt-in der
  Organisation; der Nutzer verbindet zusätzlich selbst per OAuth),
  `mcp.lesen`, `mcp.kontakte`, `mcp.auftraege`; Oberfläche in Organisation
  → Vorgaben mit Hinweis, dass Daten an das Modell des jeweiligen Anbieters
  gehen. Abgeschaltete Werkzeuge erscheinen nicht in `tools/list`.
- Scopes im Token: `mcp:read`, `mcp:write`; Keycloak-Client-Scope je Nutzer
  beim Verbinden einsehbar und widerrufbar (Einstellungen → Verbundene
  Dienste, neue Seite).
- Prompt-Injection: Werkzeugergebnisse sind Daten; Website-Texte und
  Kontakte werden wie im Chat als unvertrauenswürdig markiert
  (`hinweis`-Feld im Ergebnis, keine Anweisungen aus Daten).
- Audit: jeder MCP-Aufruf landet im Gateway-Audit mit Client und Werkzeug.

### M6 A2A-Fassade (später)

- Agent Card unter `/.well-known/agent.json` auf `ava-mcp`, Skills =
  dieselben Werkzeuge, Tasks = Zeilen aus `Auftrag`, Push-Benachrichtigung
  an die beim Task registrierte Webhook-Adresse bei `fertig`/`fehler`.
- Erst, wenn ein konkreter Partner-Agent da ist; die Datenlage ist dann
  schon vorhanden.

## 5. Schritte und Aufwand

| Schritt | Inhalt | Aufwand |
|---|---|---|
| P0 | Keycloak: Client-Scopes `mcp:read`/`mcp:write`, DCR-Policy, Resource-Metadata; Test mit Claude Code (`claude mcp add --transport http`) | 1 Tag |
| P1 | Router `/mcp` im Gateway (MCP SDK, Streamable HTTP, Token-Weitergabe), Tools lesen (`firma_suchen`, `firma_lesen`, `meine_firmen`, `meldungen`, `auftrag_status`, `auftraege`) | 2 Tage |
| P2 | Gateway: Herkunft `quelle` an Transaktionen und Audit, `/v1/transactions?quelle=`, Org-Schalter `mcp.*` in Policy und Organisation-Seite | 1 Tag |
| P3 | `import_anlegen` (Base64/Liste → `/v1/imports/*`), Rückmeldung über Hintergrundaufgaben mit Quelle „Claude" | 1 Tag |
| P4 | `Auftrag`-Tabelle, `/v1/auftraege`, App-Poller mit Lease für app-pflichtige Arten (Recherche, Publikationen, Kontakte), Verfall, Meldung | 2 Tage |
| P5 | Verbundene Dienste in den Einstellungen (Token widerrufen), Doku für Nutzer („AVA mit Claude verbinden"), Website-Text | 1 Tag |
| P6 | A2A-Fassade | 2 Tage, nur bei Bedarf |

Gesamt für MCP (P0–P5) etwa 8 Tage, zwei Releases plus Gateway-Deploys. Schemaänderungen: `Auftrag`-Tabelle und `quelle`-Spalte,
Freigabe vor dem Deploy.

## 6. Risiken

- **Token-Lebensdauer.** MCP-Clients halten Refresh-Tokens; Keycloak-Session
  für Offline-Access nötig (`offline_access`), sonst bricht die Verbindung
  nach Stunden. Widerruf über die neue Einstellungsseite.
- **Große Antworten.** Claude-Kontext ist endlich; Tools liefern kompakt
  (wie `company_get` mit `ansicht: kompakt`), Listen gedeckelt.
- **Kontingent-Überraschungen.** Ein Import über Claude kostet genauso wie
  in der App; der Tool-Text nennt vorab Anzahl und Plan-Rest.
- **Dateien über Claude.ai.** Base64-Grenze 5 MB; größere Listen über die
  App.
- **Betrieb.** Langlebige MCP-Sitzungen im Gateway-Prozess; Rate-Limit je
  Token (vorhandene Limiter), eigener Router, bei Bedarf später herauslösbar.

## 7. Entscheidungen (2026-10-09, zweite Runde)

1. **Route `/mcp` im Gateway**, kein eigener Dienst. Eigener Router mit
   Streamable-HTTP-Transport des MCP-SDK, dieselbe Auth-Middleware;
   herauslösbar, falls langlebige Streams oder Last stören.
2. **Opt-in auf zwei Ebenen:** Org-Hauptschalter `mcp` (Standard aus) und
   die OAuth-Verbindung des Nutzers selbst. Datenumfang = Token-Tenant und
   -Actor, also exakt das, was der Nutzer in der App sieht; keine
   Sonderregel nötig. Seite „Verbundene Dienste" zum Einsehen und Widerrufen.
3. **App-pflichtige Auftragsarten zuerst:** Recherche je Firma und
   Publikationen neu verarbeiten; Kontakt-Recherche und Gesellschafterlisten
   danach. Importe laufen ohnehin über Transaktionen.
4. **Claude und ChatGPT von Anfang an.** Claude.ai, Claude Desktop und
   Claude Code nehmen eigene Server je Konto. ChatGPT: Plus/Pro über den
   Entwicklermodus (eigene MCP-Connectors), Business/Enterprise über
   Admin-Connectors; keine Verzeichnis-Veröffentlichung nötig. Vor P0 die
   aktuellen ChatGPT-Bedingungen noch einmal gegen die OpenAI-Doku prüfen.

## 8. Später (bewusst zurückgestellt, 2026-10-09)

- App-pflichtige Auftragsarten **Kontakt-Recherche** und **Gesellschafterlisten**
  (nach Recherche und Publikationen).
- **A2A-Fassade** (M6): Agent Card, Tasks aus `Auftrag`, Push an Webhook;
  erst mit konkretem Partner-Agenten.
- **Dateien über 5 MB** aus Claude/ChatGPT (heute Base64-Grenze; Alternative
  signierter Upload-Link des Gateways).
- **Anonymisierte Kontakte** als Mittelweg zwischen „Kontakte aus" und
  „Kontakte an" (heute nur Org-Schalter `mcp.kontakte`).
- **Werkzeuge zum Schreiben in die App** (Notizen, Aufgaben, CRM-Verknüpfung)
  über MCP; Start ist Lesen plus Aufträge.
- **Eigener Dienst** statt Route im Gateway, falls langlebige Streams oder
  Last den Gateway-Prozess stören.
- **ChatGPT-Verzeichnis** (Apps SDK) für Nicht-Entwickler, falls der
  Entwicklermodus für Plus/Pro nicht reicht.
- **Radar aus MCP** (Scan anstoßen, Kandidaten lesen) und **Workflows aus MCP**
  (Workflow starten, Freigaben beantworten).

## 9. Stand (2026-10-09, P0/P1/P3 gebaut)

- **Gateway:** `routes/mcp-oauth.ts` (RFC 9728 Resource-Metadata, RFC 8414
  AS-Metadata mit Issuer `<public>/mcp/oauth`, Endpunkte auf Keycloak,
  Registrierung RFC 7591 ueber die Keycloak-Admin-API mit Redirect-Allowlist
  und Rate-Limit), `routes/mcp.ts` (JSON-RPC ohne Sitzungen: initialize,
  ping, tools/list, tools/call; Werkzeuge rufen /v1 im Prozess mit dem
  Nutzer-Token), `lib/keycloak-admin.ts` `createMcpClient` (oeffentlicher
  Client, PKCE S256, Client-Scopes vom Desktop-Client kopiert,
  `offline_access` optional). Env `GATEWAY_PUBLIC_URL`,
  `KEYCLOAK_MCP_TEMPLATE_CLIENT_ID` (Standard ava-desktop). Bei 401 am
  `/mcp` steht `WWW-Authenticate: Bearer resource_metadata=…`.
- **Werkzeuge:** firma_suchen, firma_lesen (Bereiche profil, register,
  publikationen, kunden, konzern, gesellschafter, aenderungen),
  firma_kontakte, meine_firmen, meldungen, import_anlegen (Liste oder
  Base64-Datei), auftrag_status, auftraege.
- **Org-Schalter** (`ORG_FEATURES` in der App): `mcp` (Standard aus),
  `mcp.lesen`, `mcp.auftraege`, `mcp.kontakte` (Standard aus); die
  Organisation-Seite kennt jetzt `standardAus`-Schalter (Haken nur bei
  ausdruecklich true).
- **P4 ohne eigene Tabelle (2026-10-09):** Recherche je Firma
  (`POST /v1/companies/{id}/research`) und Neuverarbeitung einer Stufe
  (`POST /v1/transactions/{tx}/entities/{id}/retry`) veroeffentlichen die
  AMQP-Ereignisse in die dauerhafte Warteschlange des Nutzers; die App
  arbeitet sie ab, sobald sie laeuft. Zwei Werkzeuge `recherche_anstossen`
  und `neu_verarbeiten` genuegen. Die `Auftrag`-Tabelle bleibt in §8 fuer
  Arten ohne vorhandenen Ereignispfad (Kontakt-Recherche, Gesellschafterlisten).
- **P5 Verbundene Dienste:** Gateway `GET/DELETE /v1/auth/verbindungen`
  (Keycloak-Einwilligungen des Nutzers ueber die Admin-API, Widerruf loescht
  die Einwilligung und entfernt verwaiste `mcp-`-Clients), Desktop-Abschnitt
  im Konto-Reiter mit Adresse, Liste und „Trennen“.
- **Live-Test 2026-10-09:** Keycloak eingerichtet, Claude Code hat sich
  registriert (Client `mcp-…`, Redirect localhost) und angemeldet. Die
  Werkzeuge erscheinen erst, wenn der Org-Schalter `mcp` gesetzt ist
  (App ab v0.1.785/786).
- **Offen:** P2 Herkunft `quelle` an Transaktionen (heute Vorgangsname
  „Import über MCP …“ und Gateway-Log), Nutzer-Doku/Website-Text,
  Werkzeugtest in Claude.ai und ChatGPT.

## 10. Einrichtung durch den Operator (Keycloak, einmalig)

Die Registrierung legt Clients ueber den Service-Account `ava-registrar`
an. Dafuer im Keycloak-Admin (Realm `ava`):

1. Clients → `ava-registrar` → Service account roles → Assign role →
   Filter „realm-management“ → `manage-clients` und `view-clients`
   zuweisen.
2. Clients → `ava-desktop` → Client scopes pruefen: die dort zugewiesenen
   Scopes (company:read, import:write, transaction:read, …) erben die
   MCP-Clients. `offline_access` muss als Client-Scope im Realm existieren
   (Standard).
3. Realm settings → Tokens: Offline Session Idle grosszuegig (z. B. 30 Tage),
   damit Claude/ChatGPT die Verbindung halten.

Test danach mit Claude Code:

```bash
claude mcp add --transport http ava https://ava-db-gateway.fly.dev/mcp
```

Claude Code holt die Metadata, registriert sich, oeffnet den Browser zur
Keycloak-Anmeldung; danach `/mcp` im Chat und `firma_suchen` probieren.
In Claude.ai: Einstellungen → Connectors → Custom connector mit derselben
URL. Erscheinen keine Werkzeuge, fehlt der Org-Schalter `mcp`.

