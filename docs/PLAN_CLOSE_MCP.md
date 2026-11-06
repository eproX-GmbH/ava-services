# Plan: Close CRM und fremde MCP-Dienste (CompLeadly) in AVA

Stand 2026-11-05. Anlass: Alessandro (Family of Benefits, erster Kunde) arbeitet mit
Close CRM und will LinkedIn-Ansprache über CompLeadly fahren, mit AVA als Bindeglied.
Vorgabe Joyce: AVA wird nicht auf diesen Fall getrimmt. Die fachliche Logik kommt aus
Workflows und dem Kontext des Nutzers; AVA muss nur nach Anweisung alles mit den
MCP-Werkzeugen von Close und CompLeadly tun können. Reihenfolge: zuerst Close als CRM.

## 1. Befund

- CRM-Unterbau (`services/desktop/src/main/crm/`): Anbieterliste Salesforce, HubSpot,
  Dynamics; Token-Store über die Schlüsselbund-Verschlüsselung, OAuth-Tausch über das
  Gateway (`routes/v1/crm.ts`), Firmenverknüpfung je Firma (`companies-crm.ts`,
  `crmType` als Aufzählung), Import aus dem CRM (`fetch-companies.ts`). Nur HubSpot ist
  wirklich ausgebaut: 26 Werkzeuge `crm_*_hubspot_*` für Kontakte, Deals, Notizen,
  Aufgaben, Zuordnungen; Salesforce und Dynamics sind Platzhalter.
- Werkzeuge werden beim Start fest registriert (`ToolRegistry.register`), das Modell lädt
  sie bei Bedarf über `tool_search`/`tool_load`. Workflows nutzen jedes registrierte
  Werkzeug als Knoten (`workflows/catalog.ts`).
- AVA ist MCP-Server (Gateway `routes/mcp.ts`, Plan MCP-Öffnung), aber kein MCP-Client.
  Kein MCP-SDK im Desktop.
- Close: REST-API mit API-Schlüssel oder OAuth 2.0 (Scopes `all.full_access`,
  `offline_access`, Token eine Stunde, Refresh rotiert), Webhooks mit Ereignisprotokoll,
  MCP-Server `https://mcp.close.com/mcp` (Streamable HTTP; API-Schlüssel über die Kopfzeilen
  `Close-API-Key` und `Close-Scope` mit `mcp.read`, `mcp.write_safe`,
  `mcp.write_destructive`, oder OAuth mit dynamischer Registrierung).
- CompLeadly: REST-API mit Token (alle Tarife), Profile einzeln oder bis 500 je Aufruf in
  eine Zielgruppe laden, Sequenzen mit Freigabe durch den Nutzer, 14 Webhook-Ereignisse
  (ab Premium) mit Name, Firma, Position, LinkedIn-URL, Mitglieds-ID; MCP-Server über
  Token (stdio oder HTTP/SSE), steuert das CompLeadly-Konto, nicht LinkedIn.

## 2. Entscheidungen

1. **Zwei Ebenen.** Native bleibt nur, was AVA strukturell braucht: Verbindung,
   Firmenverknüpfung (AVA-Firma ↔ CRM-Datensatz), „Im CRM öffnen“, Import aus dem CRM,
   CRM-Stand in der Firmenkarte. Alles Fachliche (Kontakte, Aktivitäten, Chancen,
   Aufgaben, Sequenzen, Statistiken) kommt über die MCP-Werkzeuge des Dienstes. Keine
   zweite HubSpot-Garnitur je Anbieter.
2. **Close zuerst über API-Schlüssel.** Der Nutzer trägt seinen Close-Schlüssel in den
   Einstellungen ein (nie im Chat, wie bei allen Schlüsseln). OAuth folgt, sobald eine
   Close-Entwickler-App des Betreibers existiert; der Token-Store trägt beides.
3. **Generischer MCP-Client.** Verbundene Dienste in den Einstellungen: Name, Adresse,
   Zugang (Bearer, Kopfzeilen, später OAuth mit dynamischer Registrierung), Verbindungstest.
   Die Werkzeuge des Dienstes werden beim Verbinden als `mcp_<dienst>_<werkzeug>`
   registriert, mit Kurzbeschreibung für `tool_search`, Kategorie `mcp`, und sind in
   Workflows als Knoten nutzbar. Schreibende Werkzeuge (Annotation `readOnlyHint` nicht
   gesetzt oder `destructiveHint`) laufen durch dieselbe Bestätigung wie unsere
   Schreibwerkzeuge; im autonomen Modus nur mit ausdrücklicher Freigabe im Workflow.
4. **Vorlagen statt Sonderwege.** Close und CompLeadly sind Vorlagen im MCP-Client (Adresse
   und Zugangsart vorbelegt), kein eigener Code je Dienst. Alles weitere kommt aus
   Workflows („Ansprache über CompLeadly, Verlauf nach Close“) und dem Kontext des Nutzers.
5. **Rückkanal generisch.** Ein Webhook-Empfänger im Gateway je Nutzer und Dienst
   (Geheimnis, Signaturprüfung, Rohereignis gespeichert, Meldung und Workflow-Auslöser).
   Die Zuordnung zu Personen läuft über die LinkedIn-URL an der Personenkarte.
6. **Organisation entscheidet.** Schalter `mcp.clients` (fremde Dienste erlaubt) und
   Anbieter-Sperre wie bei HubSpot; LinkedIn-Ansprache nur mit Hinweis auf die LinkedIn-
   Nutzungsbedingungen und die Werbe-/Art.-14-Pflichten.
7. **Grenzen vor Durchsatz.** Für Enterprise-Kunden mit hohem Durchsatz setzt der Betreiber
   Firmen-Limit und LinkedIn-Budget, bevor Sequenzen laufen.

## 3. Stufen

| Stufe | Inhalt | Stand |
|---|---|---|
| C1 | Close als CRM-Anbieter: `CrmProvider` + `crmType` um `close`/`CLOSE`; Verbindung per API-Schlüssel (Einstellungen, Prüfung über `GET /api/v1/me/`, Konto-Label aus Organisation), Token-Store mit Zugangsart `apikey` (kein Ablauf, kein Refresh); Import aus Close (`GET /api/v1/lead/` mit `display_name`, `addresses`, `url`), Firmenverknüpfung und „Im CRM öffnen“ (`https://app.close.com/lead/<id>/`), CRM-Stand in der Firmenkarte, `connect_crm`/`crm_status` kennen Close. Gateway: Aufzählungen, Verknüpfungsrouten. | gebaut 2026-11-05, Desktop v0.1.934; Gateway (Migration `CrmType` + Aufzählungen) Deploy offen |
| C2 | MCP-Client-Kern im Desktop: Dienste-Store (Name, Adresse, Zugang verschlüsselt), Verbindung über Streamable HTTP (SSE als Rückfall), `tools/list` → Registrierung als `mcp_<dienst>_<werkzeug>` (Schema 1:1, Kurzbeschreibung, Kategorie), Aufruf mit Zeitlimit und Fehlertext, Abmelden entfernt die Werkzeuge; Bestätigung bei Schreibwerkzeugen; Prompt-Abschnitt „Verbundene Dienste“; Fähigkeitsgruppe; Einstellungen-Karte mit Verbindungstest. | gebaut 2026-11-05 (v0.1.935): `main/mcp-client/` (store, client mit SDK 1.32, werkzeuge, Verwaltung), Werkzeuge `mcp_<dienst>_<werkzeug>` mit Wirkungsklasse aus Annotationen oder Namen, Registry mit unregister, Workflow-Katalog kennt die Klasse, Org-Schalter `mcp.dienste` (Konsole lokal a0973f0, Push durch Joyce), Einstellungen → Verbindungen → Weitere Dienste mit Vorlagen Close (Kopfzeilen) und CompLeadly (Zugangscode); Rauchtest gegen DeepWiki (Streamable HTTP, 3 Werkzeuge, Aufruf). Nachtrag v0.1.936 (Joyce): dieselbe Oberfläche legt auch Agenten (A2A) an — Agentenkarte laden, Werkzeuge `a2a_<agent>_auftrag` (message/send, wartet bis 2 Min, tasks/get) und `a2a_<agent>_status`; Vorlagen Close und CompLeadly (Adresse https://mcp.complead.ly/user/mcp, Bearer-Token aus Einstellungen → Eigene KI verbinden) vorausgefüllt; abgelaufener oder abgelehnter Zugang (401/403) wird am Dienst markiert, erscheint als Warnband in der App („Zugang erneuern“ führt in die Einstellungen) und als klare Werkzeugmeldung ans Modell |
| C3 | Vorlagen Close (API-Schlüssel aus C1 wird wiederverwendet, Scope wählbar, Standard `mcp.write_safe`) und CompLeadly (Token); Werkzeug-Kurzbeschreibungen auf Deutsch nachziehen, wenn der Dienst nur englische liefert. | Vorlagen in C2 enthalten (Close: Kopfzeilen Close-API-Key/Close-Scope, CompLeadly: Zugangscode; Adresse des CompLeadly-MCP noch offen); Beschreibungen bleiben vorerst wie vom Dienst |
| C4 | Webhook-Empfänger im Gateway (`POST /v1/webhooks/<dienst>/<token>`), Ereignistabelle, Zuordnung zu Person über LinkedIn-URL, Meldung im Chat, Workflow-Auslöser „Ereignis von Dienst“. | gebaut 2026-11-05 (v0.1.937): Gateway `lib/dienst-webhooks.ts` + `routes/v1/dienst-webhooks.ts` (öffentlich `POST /v1/webhooks/ereignis/{token}`, angemeldet `/v1/dienste/webhooks` und `/v1/dienste/ereignisse`), Tabellen `WebhookEmpfaenger` (ein Empfänger je Nutzer und Dienst) und `DienstEreignis` (roh, Deckel 5.000 je Nutzer), Migration 20261105_dienst_webhooks; Desktop: Werkzeug `dienst_ereignisse`, Wächter alle 3 Min mit Benachrichtigung („CompLeadly: Lead hat geantwortet · Name, Firma“), dezente Rückkanal-Zeile an der Dienstkarte (Adresse anlegen, kopieren, Stand; Hinweis „bei CompLeadly ab Premium“). Nachtrag v0.1.941: Zuordnung über die LinkedIn-Adresse (Gateway sucht den Kurznamen in `Fact.linkedinUrl` der Firmen im Bestand des Nutzers, Spalten `personId`/`companyId`/`linkedinSlug`, Migration 20261106_dienst_ereignis_zuordnung, Abfrage ~1 ms) und Workflow-Auslöser `dienst.ereignis` (Wächter löst je Ereignis einen Lauf aus, Firma = zugeordnete companyId; im Workflow-Editor wählbar); Rückfall ohne Rückkanal: Stand über die MCP-Werkzeuge (Prompt) |
| C5 | Workflow-Vorlage „LinkedIn-Ansprache mit Rückmeldung ins CRM“ (Kontakte wählen → an CompLeadly → Ereignisse → Activity in Close → Aufgabe), rein aus MCP-Knoten; Hinweise und Organisationsschalter; Betreiber-Grenzen. | offen |
| C6 | Close-OAuth über Betreiber-App (ersetzt den Schlüssel), wenn Close-Entwicklerkonto vorhanden. | offen |

## 4. Offene Punkte

- Close-Entwicklerkonto des Betreibers für OAuth (C6).
- CompLeadly-Testkonto für C3/C4 (zehn Tage ohne Karte).
- Ob MCP-Werkzeuge fremder Dienste im Hintergrundkanal (Workflows ohne Nutzer) schreiben
  dürfen: Vorschlag nur mit `confirmed=true` im Knoten, wie bei Mail.
