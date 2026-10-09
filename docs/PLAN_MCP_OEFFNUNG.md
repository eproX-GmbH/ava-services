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
   ava-mcp (Fly, Streamable HTTP) ───▶ db-gateway /v1 (bestehende Routen)
        │ Tools: lesen, Auftrag anlegen,        │
        │ Status, Meldungen                     ▼
        │                              Transaktion + AMQP je Nutzer
        │                                       │ wartet, bis die App läuft
        ▼                                       ▼
   Nutzer erfährt Ergebnis über         lokale AVA-App (Producer, LLM lokal)
   Telegram / Meldungen / Mail          Fly-Worker für cloud-fähige Arten
```

## 4. Bausteine

### M1 MCP-Server `ava-mcp` (Fly, neben dem Gateway)

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

- `TenantPolicy.features`: `mcp` (Hauptschalter, Standard aus),
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
| P1 | `ava-mcp` Grundgerüst (Node, MCP SDK, Streamable HTTP, Token-Weitergabe), Tools lesen (`firma_suchen`, `firma_lesen`, `meine_firmen`, `meldungen`, `auftrag_status`, `auftraege`) | 2 Tage |
| P2 | Gateway: Herkunft `quelle` an Transaktionen und Audit, `/v1/transactions?quelle=`, Org-Schalter `mcp.*` in Policy und Organisation-Seite | 1 Tag |
| P3 | `import_anlegen` (Base64/Liste → `/v1/imports/*`), Rückmeldung über Hintergrundaufgaben mit Quelle „Claude" | 1 Tag |
| P4 | `Auftrag`-Tabelle, `/v1/auftraege`, App-Poller mit Lease für app-pflichtige Arten (Recherche, Publikationen, Kontakte), Verfall, Meldung | 2 Tage |
| P5 | Verbundene Dienste in den Einstellungen (Token widerrufen), Doku für Nutzer („AVA mit Claude verbinden"), Website-Text | 1 Tag |
| P6 | A2A-Fassade | 2 Tage, nur bei Bedarf |

Gesamt für MCP (P0–P5) etwa 8 Tage, zwei Releases plus Gateway- und
MCP-Deploys. Schemaänderungen: `Auftrag`-Tabelle und `quelle`-Spalte,
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
- **Betrieb.** Ein weiterer Fly-Dienst mit eigenem Health und Logs;
  Rate-Limit je Token im Gateway (vorhandene Limiter).

## 7. Offene Entscheidungen

1. Eigener Fly-Dienst `ava-mcp` oder Route `/mcp` im Gateway? Vorschlag:
   eigener Dienst (anderer Lebenszyklus, MCP-SDK-Abhängigkeiten, getrennt
   skalierbar), Gateway bleibt reine API.
2. Standard des Hauptschalters `mcp` je Organisation: aus (Vorschlag) oder an?
3. Welche App-pflichtigen Auftragsarten in P4 zuerst: Recherche je Firma
   und Publikationen neu verarbeiten (Vorschlag), Kontakt-Recherche später.
4. ChatGPT-Connectors verlangen aktuell eine Veröffentlichung im
   Connector-Verzeichnis für Nicht-Entwickler; Claude.ai erlaubt eigene
   Server je Konto. Start mit Claude.ai und Claude Code, ChatGPT danach.
