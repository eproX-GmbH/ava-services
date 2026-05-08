# AVA

> Recherche-App für deutsche B2B-Daten. Handelsregister-zentriert, KI-gestützt, CRM-fähig.

AVA ist eine Desktop-Anwendung, die deutsche Unternehmensdaten zu einem komplett ausgewerteten Firmenprofil verdichtet: Vom Handelsregistereintrag über Veröffentlichungen, Webseite und Kontaktdaten bis zu einer LLM-basierten Bewertung. Importiert wird per Excel, einzelner Firma oder direkt aus dem verbundenen CRM (HubSpot, Salesforce, Microsoft Dynamics 365 uvm.).

Im Gegensatz zu klassischen SaaS-Lösungen läuft die gesamte schwere Logik (Scraping, Crawling, Extraktion und LLM-Aufrufe) **lokal auf der Maschine des Nutzers**. Der Cloud-Anteil ist ein Gateway zur Stammdaten-Synchronisation und für operatorseitig Dienste. Diese Architektur ist bewusst gewählt: keine fremden Server, die Recherche-Anfragen mitlesen, keine Cloud-Quotas auf Threads, kein Wartungsaufwand bei Lastspitzen.

## Was AVA tut

Pro Firma teilt die Pipeline auf 6 spezialisierte Producer aus, die sich gegenseitig anstoßen:

| Producer | Eingabe | Ergebnis |
|---|---|---|
| `structured-content` | Name + Stadt | Stammdaten + Geschäftsführer + Sitz aus dem Unternehmensregister |
| `company-publication` | Name + Stadt | Geschäftsberichte, Bekanntmachungen, Bilanzen |
| `website` | Strukturdaten | Beste Treffer-Webseite |
| `company-profile` | Webseite | Firmenprofil aus Webseiten-Inhalten |
| `company-contact` | Webseite | Ansprechpartner + Kontaktwege |
| `company-evaluation` | Alle obigen | LLM-basierte Gesamtbewertung |

Status pro Firma × pro Stage liegt live als Matrix in der App, mit Drilldown auf Producer-Logs.

## Architektur

```
┌──────────────────────────────────────────────┐    ┌──────────────────────────┐
│  Desktop (Electron, Mac/Windows)             │    │  Cloud-Substrat (fly.io) │
│                                              │    │                          │
│  ┌─────────────────────┐  ┌────────────────┐ │    │  db-gateway              │
│  │ AI-Chat (Agent)     │  │ Pipeline-View  │ │    │   • Auth (Keycloak)      │
│  │  • Ollama/OpenAI/   │  │  • SSE live    │ │    │   • Audit-DB             │
│  │    Anthropic/Google │  │  • Drilldown   │ │    │   • Operator-Proxies     │
│  └─────────────────────┘  └────────────────┘ │    │     (valueSERP, CRM      │
│  ┌─────────────────────────────────────────┐ │    │      OAuth-Exchange)     │
│  │  6× Producer-Subprozesse (Node.js)      │ │◄───┤                          │
│  │  • Selenium + chromedriver              │ │    │  master-data             │
│  │  • Lokale PGlite + Prisma               │ │AMQP│   • Stammdaten-Index     │
│  │  • Eigene per-User AMQP-Queues          │ │    │   • Elasticsearch        │
│  └─────────────────────────────────────────┘ │    │     (Fuzzy-Suche)        │
│  ┌─────────────────────────────────────────┐ │    │                          │
│  │  Whisper.cpp Sidecar (Voice-Mode)       │ │    │  Whisper-Models &        │
│  │  Bundled binary, GGUF auto-download     │ │    │  Ollama-Models           │
│  └─────────────────────────────────────────┘ │    │  (CDN, optional)         │
└──────────────────────────────────────────────┘    └──────────────────────────┘
```

**Compute-Lokalität ist Invariante:** alle LLM-Aufrufe und alle Web-Scrapes laufen auf der Nutzer-Maschine. Cloud-seitig läuft ausschließlich Substrat: Auth, Stammdaten, und der eine Service, der zwingend einen Operator-API-Key braucht (`website` → valueSERP, OAuth-Token-Exchange für die CRM-Anbindung).

## Funktionen im Überblick

- **Bulk-Import** aus Excel/CSV, Einzelimport per Name + Stadt, oder direkter Import aus dem verbundenen CRM
- **AI-Chat** als primäre Bedienoberfläche — der Agent treibt Pipelines, beantwortet Recherchefragen über die eigene Datenbank und lernt durch ein persistentes Profil + Standing-Watches
- **CRM-Anbindung** per OAuth (Tokens liegen verschlüsselt im OS-Schlüsselbund)
- **Voice-Mode** über bundled `whisper.cpp` mit Distil-Whisper-DE
- **Heartbeat** scannt periodisch nach neuen Veröffentlichungen + Auffälligkeiten und meldet sie als Alerts in einer Bell + nativen OS-Push
- **Standing-Watches** — der Nutzer formuliert wiederkehrende Kriterien („melde mir, wenn eine Firma eine Bilanz mit GuV-Gewinn > 1 Mio. veröffentlicht"), die Heartbeat-Auswertung wendet sie auf jeden Tick an
- **OTA-Updates** via electron-updater + GitHub Releases
- **Multi-Provider-LLM**: lokales Ollama (Standard) oder Bring-Your-Own-Key für OpenAI / Anthropic / Google / Mistral

## Status

Aktuell Pre-1.0: die Architektur ist stabil, Featureflächen wachsen pro Release. Das Projekt befindet sich in einer aktiven Transition von einem reinen Cloud-Stack hin zur hier beschriebenen Compute-on-User-Architektur. Migrations-Status liegt in [`DECISIONS.md`](./DECISIONS.md) und [`INVENTORY.md`](./INVENTORY.md).

## Installation

Vorgefertigte Builds: [Releases](https://github.com/eproX-GmbH/ava-services/releases)

Erste Installation:

1. `.dmg` der aktuellen Release herunterladen
2. AVA.app in `/Applications/` ziehen
3. Beim ersten Start läuft der Quarantäne-Scrub (siehe `services/desktop/src/main/scrub-quarantine.ts`); danach AVA einmal beenden und neu starten
4. Nach dem zweiten Start funktionieren OTA-Updates ohne weiteren manuellen Eingriff

## Repository-Layout

```
ava-services/
├── services/
│   ├── desktop/             # Electron-App (Main / Preload / Renderer)
│   └── db-gateway/          # Hono-API auf fly.io
├── master-data/             # Stammdaten + Elasticsearch (Submodul)
├── company-contact/         # Producer (Submodul)
├── company-evaluation/      # Producer (Submodul)
├── company-profile/         # Producer (Submodul)
├── company-publication/     # Producer (Submodul)
├── structured-content/      # Producer (Submodul)
├── website/                 # Producer (Submodul)
├── packages/
│   ├── ai-provider/         # Vercel-AI-SDK-Wrapper über alle LLM-Provider
│   └── events/              # CloudEvents-Builder + AMQP-Client
├── DECISIONS.md             # Ratifizierte D1–D11-Architekturentscheidungen
├── DESKTOP_DATA_FLOW.md     # Workflows W1–W25, SSE-Bridge, IPC-Verträge
└── INVENTORY.md             # Vollständige Bestandsaufnahme der Services
```

## Build aus dem Quelltext

```bash
# Voraussetzungen: Node 20, pnpm 9, macOS-arm64-Runner für Codesign/Notarize
git clone --recurse-submodules https://github.com/eproX-GmbH/ava-services.git
cd ava-services/services/desktop
pnpm install
pnpm build            # main + preload + renderer
pnpm package:mac      # produziert dmg + zip in dist/
```

Detaillierte Release- + Signatur-Schritte: `.github/workflows/desktop-release.yml`.

## Lizenz

Internes Projekt der eproX GmbH. Externe Beiträge derzeit nicht vorgesehen.

---

_Fragen, Feedback, Bugs:_ [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de)
