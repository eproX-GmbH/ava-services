# AVA

[![Desktop Release Build](https://github.com/eproX-GmbH/ava-services/actions/workflows/desktop-release.yml/badge.svg)](https://github.com/eproX-GmbH/ava-services/actions/workflows/desktop-release.yml)
[![Latest Release](https://img.shields.io/github/v/release/eproX-GmbH/ava-services?include_prereleases&label=release&color=00c0a7)](https://github.com/eproX-GmbH/ava-services/releases/latest)
[![Service Health](https://img.shields.io/website?url=https%3A%2F%2Fava-db-gateway.fly.dev%2Fhealth&label=db-gateway&up_message=operational&down_message=offline)](https://ava-db-gateway.fly.dev/health)
[![Master-Data](https://img.shields.io/website?url=https%3A%2F%2Fava-master-data.fly.dev%2Fhealth&label=master-data&up_message=operational&down_message=offline)](https://ava-master-data.fly.dev/health)

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

## Status & Service Health

Aktuell Pre-1.0 (Stand: **v0.1.156**). Die Architektur ist stabil, Featureflächen wachsen pro Release.

Die Badges oben zeigen den Live-Status der Cloud-Komponenten:

| Service | Rolle | Live-Endpoint |
|---|---|---|
| `db-gateway` | Auth-Gate, Audit-DB, Operator-Proxies | [ava-db-gateway.fly.dev/health](https://ava-db-gateway.fly.dev/health) |
| `master-data` | Stammdaten-Index, Fuzzy-Suche | [ava-master-data.fly.dev/health](https://ava-master-data.fly.dev/health) |
| Desktop-Build (CI) | Letzter Release-Run | siehe Badge oben |

Die schwere Pipeline-Logik (Producer, LLM, Scraping) läuft auf der Maschine des Nutzers und ist deshalb nicht zentral „status-bar"-fähig — Ausfälle sind lokal sichtbar im Whoami-Panel der Desktop-App.

Tiefere Dokumentation unter [`docs/`](./docs/): [`DECISIONS.md`](./docs/DECISIONS.md) (D1–D11-Architekturentscheidungen), [`INVENTORY.md`](./docs/INVENTORY.md) (Bestandsaufnahme), [`DESKTOP_DATA_FLOW.md`](./docs/DESKTOP_DATA_FLOW.md) (Workflows W1–W25, SSE-Bridge, IPC-Verträge), [`CHANGELOG.md`](./docs/CHANGELOG.md) (Release-Chronik), [`PLANS.md`](./docs/PLANS.md) (technische Feature-Pläne).

## Roadmap

Wohin sich AVA entwickelt. Granulare Tickets liegen im Tracker — hier nur die strategischen Linien, die AVA zur dem machen sollen, was es sein will.

### Was AVA heute schon ist

- Eine **lokal-laufende KI-Assistenz** für deutsche B2B-Recherche, die Excel-Importe, Handelsregister-Abfragen, Webseiten-Crawls und LLM-Bewertungen automatisch zu Firmenprofilen verdichtet
- Ein **Chat-Agent** mit Tool-Use, eigenen Skills und Voice-Mode als primäre Bedienoberfläche
- **HubSpot-integriert** mit Live-Enrichment auf Knopfdruck und Heartbeat-getriebenen Alerts bei neuen Veröffentlichungen
- **Modellneutral** — lokales LLM als Standard, BYO-Key für gängige Hosted-Provider (Opus 4.7, GPT-5.5, Gemini 3.1 Pro, …)

### Wohin wir wollen

**Universelle CRM-Anbindung.** HubSpot war Anfang — Salesforce und Microsoft Dynamics folgen, und perspektivisch wird der Schreibpfad bidirektional. AVA soll der intelligente Recherche-Layer über *deinem* CRM sein, nicht ein Parallelsystem, in das du zusätzlich pflegst.

**Strukturiertes Wissen aus unstrukturierten Quellen.** Die Veröffentlichungen im Unternehmensregister enthalten Bilanzen, GuV, Umsatzentwicklung — heute als Text. Wir machen daraus quantitative Zeitreihen, Branchen-Benchmarks und vergleichbare Kennzahlen.

**Geteilte Recherche-Workflows.** Das Skills-System hat heute schon ein Trust-Modell. Als Nächstes: ein Marketplace, in dem Branchenexperten ihre Recherche-Templates für andere AVA-Nutzer veröffentlichen — vom „Solvenz-Check für Mittelstand" bis zum „Familienunternehmer-Nachfolge-Scan".

**Mehr Märkte.** AVA ist heute auf deutsche Handelsregister-Daten optimiert. Österreichische und schweizer Quellen sind der naheliegende nächste Schritt; weiter draußen liegen die anderen EU-DACH-Registerstandards.

**Vom Single-Seat zum Team.** Heute läuft AVA als persönliche Recherche-Assistenz. Geteilte Standing-Watches, geteilte CRM-Verknüpfungen, ein gemeinsames Recherche-Archiv für Teams stehen auf der mittelfristigen Karte.

> Konkrete Wünsche, Lücken, Branchenanforderungen? [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de) — die Roadmap wird mit jeder Nutzer-Rückmeldung schärfer.

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
└── docs/                    # Architektur-Docs, Pläne, Tools-Referenz,
                             # CHANGELOG; siehe `docs/README.md` für Index
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
