# AVA

> Recherche-App für deutsche B2B-Daten. Handelsregister-zentriert, KI-gestützt, CRM-fähig.

AVA ist eine Desktop-Anwendung, die deutsche Unternehmensdaten zu einem komplett ausgewerteten Firmenprofil verdichtet: Vom Handelsregistereintrag über Veröffentlichungen, Webseite und Kontaktdaten bis zu einer LLM-basierten Bewertung. Importiert wird per Excel, einzelner Firma oder direkt aus dem verbundenen CRM (gängige B2B-CRM-Systeme via OAuth).

Im Gegensatz zu klassischen SaaS-Lösungen läuft die gesamte schwere Logik (Scraping, Crawling, Extraktion und LLM-Aufrufe) **lokal auf der Maschine des Nutzers**. Der Cloud-Anteil ist ein Gateway zur Stammdaten-Synchronisation und für operatorseitige Dienste. Diese Architektur ist bewusst gewählt: keine fremden Server, die Recherche-Anfragen mitlesen, keine Cloud-Quotas auf Threads, kein Wartungsaufwand bei Lastspitzen.

## Was AVA tut

Pro Firma teilt die Pipeline auf 6 spezialisierte Producer aus, die sich gegenseitig anstoßen:

| Producer | Eingabe | Ergebnis |
|---|---|---|
| `structured-content` | Name + Stadt | Stammdaten + Geschäftsführer + Sitz aus dem amtlichen Unternehmensregister (mit Sekundär-Register-Fallback) |
| `company-publication` | Name + Stadt | Geschäftsberichte, Bekanntmachungen, Bilanzen |
| `website` | Strukturdaten | Beste Treffer-Webseite |
| `company-profile` | Webseite | Firmenprofil aus Webseiten-Inhalten |
| `company-contact` | Webseite | Ansprechpartner + Kontaktwege |
| `company-evaluation` | Alle obigen | LLM-basierte Gesamtbewertung |

Status pro Firma × pro Stage liegt live als Matrix in der App, mit Drilldown auf Producer-Logs.

## Architektur

```
┌──────────────────────────────────────────────┐    ┌──────────────────────────┐
│  Desktop-App (Mac/Windows)                   │    │  Cloud-Substrat          │
│                                              │    │                          │
│  ┌─────────────────────┐  ┌────────────────┐ │    │  db-gateway              │
│  │ AI-Chat (Agent)     │  │ Pipeline-View  │ │    │   • Auth (OIDC)          │
│  │  • lokales LLM ODER │  │  • SSE live    │ │    │   • Audit-DB             │
│  │    Hosted (BYO-Key) │  │  • Drilldown   │ │    │   • Operator-Proxies     │
│  └─────────────────────┘  └────────────────┘ │    │     (Web-Search-API,     │
│  ┌─────────────────────────────────────────┐ │    │      CRM-OAuth-Exchange) │
│  │  6× Producer-Subprozesse                │ │◄───┤                          │
│  │  • Headless-Browser-Automatisierung     │ │    │  master-data             │
│  │  • Lokale Embedded-DB + ORM             │ │AMQP│   • Stammdaten-Index     │
│  │  • Eigene per-User Event-Queues         │ │    │   • Fuzzy-Suchmaschine   │
│  └─────────────────────────────────────────┘ │    │                          │
│  ┌─────────────────────────────────────────┐ │    │                          │
│  │  Speech-to-Text Sidecar (Voice-Mode)    │ │    │  Sprachmodell- &         │
│  │  Bundled binary, Modell auto-download   │ │    │  LLM-Model-Spiegel       │
│  └─────────────────────────────────────────┘ │    │  (CDN, optional)         │
└──────────────────────────────────────────────┘    └──────────────────────────┘
```

**Compute-Lokalität ist Invariante:** alle LLM-Aufrufe und alle Web-Scrapes laufen auf der Nutzer-Maschine. Cloud-seitig läuft ausschließlich Substrat: Auth, Stammdaten, und der eine Service, der zwingend einen Operator-API-Key braucht (`website` → Google-Search-Provider, OAuth-Token-Exchange für die CRM-Anbindung).

## Funktionen im Überblick

- **Bulk-Import** aus Excel/CSV, Einzelimport per Name + Stadt, oder direkter Import aus dem verbundenen CRM
- **AI-Chat** als primäre Bedienoberfläche — der Agent treibt Pipelines, beantwortet Recherchefragen über die eigene Datenbank, stößt fehlende Anreicherungen proaktiv selbst an und lernt durch ein persistentes Profil + Standing-Watches
- **CRM-Anbindung** per OAuth (Tokens liegen verschlüsselt im OS-Schlüsselbund)
- **Voice-Mode** über bundled Speech-to-Text-Engine mit deutschem Sprachmodell
- **Heartbeat** scannt periodisch nach neuen Veröffentlichungen + Auffälligkeiten und meldet sie als Alerts in einer Bell + nativen OS-Push
- **Standing-Watches** — der Nutzer formuliert wiederkehrende Kriterien („melde mir, wenn eine Firma eine Bilanz mit GuV-Gewinn > 1 Mio. veröffentlicht"), die Heartbeat-Auswertung wendet sie auf jeden Tick an
- **Professional-Network-Beobachter** — opt-in Feed-Beobachtung über eingebettetes Browser-Fenster, mit Vision-LLM-Bildanalyse und Entity-Linking auf Firmen im Bestand
- **Multi-Source-Pipeline** — `structured-content` zieht primär aus dem amtlichen Unternehmensregister, fällt bei Ausfall automatisch auf das Sekundär-Register zurück; Status pro Quelle live im Whoami-Panel
- **Abonnement & Quotas** — Checkout + Customer-Portal über externen Payment-Provider, Tier-aware Pre-Checks vor jedem Import, sichtbare „Kündigung zum X vorgemerkt"-Hinweise
- **OTA-Updates** über integrierten Auto-Updater + Release-Hosting
- **Multi-Provider-LLM**: lokale LLM-Runtime (Standard) oder Bring-Your-Own-Key für gängige Hosted-LLM-Provider

## Status

Aktuell Pre-1.0 (Stand: v0.1.152). Die Architektur ist stabil, Featureflächen wachsen pro Release. Architektur-Entscheidungen liegen in [`DECISIONS.md`](./DECISIONS.md), eine vollständige Bestandsaufnahme in [`INVENTORY.md`](./INVENTORY.md), der detaillierte Datenfluss in [`DESKTOP_DATA_FLOW.md`](./DESKTOP_DATA_FLOW.md). Eine Release-Chronik führt [`CHANGELOG.md`](./CHANGELOG.md). Aktuelle Feature-Pläne (Tool-Coverage-Audit, Skills-System) stehen in [`PLANS.md`](./PLANS.md).

## Installation

Vorgefertigte Builds: [Releases](https://github.com/eproX-GmbH/ava-services/releases)

Erste Installation:

1. Aktuelles Installationspaket der Plattform herunterladen
2. AVA in den Anwendungsordner verschieben
3. Beim ersten Start läuft der Quarantäne-Scrub (siehe `services/desktop/src/main/scrub-quarantine.ts`); danach AVA einmal beenden und neu starten
4. Nach dem zweiten Start funktionieren OTA-Updates ohne weiteren manuellen Eingriff

## Repository-Layout

```
ava-services/
├── services/
│   ├── desktop/             # Desktop-App (Main / Preload / Renderer)
│   └── db-gateway/          # Cloud-API-Gateway
├── master-data/             # Stammdaten + Fuzzy-Suche (Submodul)
├── company-contact/         # Producer (Submodul)
├── company-evaluation/      # Producer (Submodul)
├── company-profile/         # Producer (Submodul)
├── company-publication/     # Producer (Submodul)
├── structured-content/      # Producer (Submodul)
├── website/                 # Producer (Submodul)
├── packages/
│   ├── ai-provider/         # Einheitliches LLM-Provider-Interface
│   └── events/              # Event-Schema-Builder + Message-Broker-Client
├── DECISIONS.md             # Ratifizierte D1–D11-Architekturentscheidungen
├── DESKTOP_DATA_FLOW.md     # Workflows W1–W25, SSE-Bridge, IPC-Verträge
└── INVENTORY.md             # Vollständige Bestandsaufnahme der Services
```

## Build aus dem Quelltext

```bash
# Voraussetzungen: aktuelle LTS-JS-Runtime, pnpm, signaturfähiger Build-Runner
git clone --recurse-submodules https://github.com/eproX-GmbH/ava-services.git
cd ava-services/services/desktop
pnpm install
pnpm build            # main + preload + renderer
pnpm package:mac      # produziert Installationspaket in dist/
```

Detaillierte Release- + Signatur-Schritte: `.github/workflows/desktop-release.yml`.

## Lizenz

Internes Projekt der eproX GmbH. Externe Beiträge derzeit nicht vorgesehen.

---

_Fragen, Feedback, Bugs:_ [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de)
