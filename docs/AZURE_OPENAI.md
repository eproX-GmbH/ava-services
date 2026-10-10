# Azure OpenAI (2026-10-10)

Azure OpenAI ist eine **Variante des OpenAI-Anbieters**, keine eigene Anbieterart. AVA rechnet intern weiter mit
den Katalog-IDs (Kosten, Limits, Stufen, Vorgaben) und übersetzt erst beim Aufruf auf die Deployments des Kunden.
Grundlage ist die OpenAI-kompatible v1-API von Azure: `https://<ressource>.openai.azure.com/openai/v1/`.

## Eigener Schlüssel (Desktop und Server)

- Einstellung: Einstellungen → Modelle → OpenAI → „Über Azure OpenAI“ (Endpunkt + Modell → Deployment, `*` = alle
  übrigen; ohne Eintrag gleichnamiges Deployment). Im Chat: `settings_openai_azure` (stand/setzen/pruefen/aus).
  Der gespeicherte OpenAI-Schlüssel ist dann der Azure-Schlüssel. Speicherung in `provider.json` (`openaiAzure`).
- **Azure-Brücke** (`main/agent/providers/azure-bruecke.ts`): lokaler Durchreicher auf 127.0.0.1 mit eigenem Geheimnis.
  Bearer = Geheimnis → Azure (Modell → Deployment, Azure-Schlüssel als `api-key` und Bearer, Streams ungepuffert);
  anderer Bearer → unverändert an api.openai.com (z. B. separate Recherche-Schlüssel).
- Über die Brücke laufen: Chat (`AiSdkProvider` mit `getAzureBruecke`), `openaiZugang()` (Recherche, Telegram-Stimme
  und -Transkription), Producer (`azureUmgebung`: Werte gleich dem Azure-Schlüssel → Brücken-Geheimnis,
  `OPENAI_BASE_URL` → Brücke; AI SDK und `openai`-Paket lesen die Variable selbst). Dadurch funktionieren auch fest
  verdrahtete Modellnamen im Website-Producer (`gpt-5-mini`, Deep-Research-Modell) ohne Producer-Änderung.
- Schlüsselprüfung gegen `<endpoint>/openai/v1/models` (`validateAzureOpenAIKey`).
- Test: `pnpm --dir services/desktop test:azure` (nachgebauter Azure-Endpunkt, AI SDK, `openai`-Paket, 18 Prüfungen).

## Organisationsschlüssel (Gateway)

- `TenantProvider.endpoint` + `deployments` (Migration `20261010_tenant_provider_azure`, nur `openai`).
- `PUT /v1/tenants/me/providers/openai` mit `azure: { endpoint, deployments } | null`; `apiKey` darf fehlen, wenn schon
  einer liegt. `GET …/providers` liefert Endpunkt und Deployments mit.
- Proxy `/v1/llm/openai/*`: Ziel Azure, `api-key`-Kopf, Modell im Body → Deployment; Abrechnung nach Katalog-ID bzw.
  dem Modell, das Azure in der Antwort meldet.
- Konsole: Schlüssel → OpenAI → „Über Azure OpenAI“ (Vorschläge aus `GET /v1/modelle`).

## Grenzen

- **Sprachmodus** (OpenAI Realtime aus dem Fenster gegen api.openai.com) ist mit Azure nicht verfügbar; die App zeigt
  den Grund (`SpracheStand.hinweis`).
- Websuche/Deep Research nur, wenn die Azure-Ressource die Modelle und das Werkzeug anbietet (Microsoft nennt keine
  vollständige Liste); sonst Fehlermeldung des Laufs.
- Telegram-Sprachantwort und -Transkription brauchen passende Deployments (`gpt-4o-mini-tts`, Transkription); sonst
  fällt die Antwort wie bisher auf Text zurück.
- Anmeldung ohne Schlüssel (Entra ID) und der Einrichtungsassistent mit Azure sind offen.
