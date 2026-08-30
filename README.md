# AVA

[![Desktop Release Build](https://github.com/eproX-GmbH/ava-services/actions/workflows/desktop-release.yml/badge.svg?event=push)](https://github.com/eproX-GmbH/ava-services/actions/workflows/desktop-release.yml)
[![Latest Release](https://img.shields.io/github/v/release/eproX-GmbH/ava-services?include_prereleases&label=release&color=00c0a7)](https://github.com/eproX-GmbH/ava-services/releases/latest)
[![Service Health](https://img.shields.io/website?url=https%3A%2F%2Fava-db-gateway.fly.dev%2Fhealth&label=db-gateway&up_message=operational&down_message=offline)](https://ava-db-gateway.fly.dev/health)
[![Master-Data](https://img.shields.io/website?url=https%3A%2F%2Fava-master-data.fly.dev%2Fhealth&label=master-data&up_message=operational&down_message=offline)](https://ava-master-data.fly.dev/health)

> Recherche-App für deutsche B2B-Daten. Handelsregister-zentriert, KI-gestützt, CRM-fähig.

AVA ist eine Desktop-Anwendung, die deutsche Unternehmensdaten zu einem komplett ausgewerteten Firmenprofil verdichtet: vom Handelsregistereintrag über Veröffentlichungen, Webseite und Kontaktdaten bis zu einer LLM-basierten Bewertung. Importiert wird per Excel, einzelner Firma, direkt aus dem verbundenen CRM (gängige B2B-CRM-Systeme via OAuth) oder über den Firmen-Radar, der neue, noch unbekannte Firmen in der Region des Nutzers entdeckt.

Im Gegensatz zu klassischen SaaS-Lösungen läuft die gesamte schwere Logik (Scraping, Crawling, Extraktion und LLM-Aufrufe) **lokal auf der Maschine des Nutzers**. Der Cloud-Anteil ist ein Gateway zur Stammdaten-Synchronisation und für operatorseitige Dienste. Diese Architektur ist bewusst gewählt: keine fremden Server, die Recherche-Anfragen mitlesen, keine Cloud-Quotas auf Threads, kein Wartungsaufwand bei Lastspitzen.

## Was AVA tut

Pro Firma teilt die Pipeline auf 6 spezialisierte Producer aus, die sich gegenseitig anstoßen:

| Producer | Eingabe | Ergebnis |
|---|---|---|
| `structured-content` | Name + Stadt | Stammdaten + Geschäftsführer + Sitz aus dem amtlichen Unternehmensregister (mit Sekundär-Register-Fallback) |
| `company-publication` | Name + Stadt | Geschäftsberichte, Bekanntmachungen, Bilanzen (wahlweise sparsame oder vollständige Analyse) |
| `website` | Strukturdaten | Beste Treffer-Webseite |
| `company-profile` | Webseite | Firmenprofil aus Webseiten-Inhalten |
| `company-contact` | Webseite | Ansprechpartner + Kontaktwege |
| `company-evaluation` | Alle obigen | LLM-basierte Gesamtbewertung |

Status pro Firma × pro Stage liegt live als Matrix in der App, mit Pause/Löschen pro Firma, Drilldown auf Producer-Logs je Lauf und einem einblendbaren Verarbeitungs-Feed (aktive Prozesse plus Chronik, mit Firmennamen).

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
│  ┌─────────────────────┐  ┌────────────────┐ │    │      CRM-OAuth-Exchange) │
│  │ Firmen-Radar        │  │ Telegram-Kanal │ │    │   • Geteilte Korpora     │
│  │  • ICP-Match lokal  │  │  • Alerts +    │ │    │     (Publikations-       │
│  │  • Alerts           │  │    Chat mobil  │ │    │      Blöcke, Discovery-  │
│  └─────────────────────┘  └────────────────┘ │    │      Kandidaten,         │
│  ┌─────────────────────────────────────────┐ │    │      Ortsgraph)          │
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

**Compute-Lokalität ist Invariante:** alle LLM-Aufrufe und alle Web-Scrapes laufen auf der Nutzer-Maschine. Cloud-seitig läuft ausschließlich Substrat: Auth, Stammdaten, geteilte abgeleitete Korpora (einer verarbeitet, alle profitieren) und der eine Service, der zwingend einen Operator-API-Key braucht (`website` → Google-Search-Provider, OAuth-Token-Exchange für die CRM-Anbindung). Private Daten wie das Idealkundenprofil, Match-Bewertungen und die Bestandskunden-Liste bleiben grundsätzlich lokal.

## Funktionen im Überblick

- **Bulk-Import** aus Excel/CSV, Einzelimport per Name + Stadt, oder direkter Import aus dem verbundenen CRM
- **AI-Chat** als primäre Bedienoberfläche: der Agent treibt Pipelines, beantwortet Recherchefragen über die eigene Datenbank, stößt fehlende Anreicherungen proaktiv selbst an und lernt durch ein persistentes Profil + Standing-Watches
- **Firmen-Radar (Discovery)**: findet neue Firmen im Umkreis, die noch nicht in AVA sind. Drei Quellen (Gewerbe-Kartendaten, KI-geplante Places-Recherchen wie von einem menschlichen Rechercheur, unverarbeiteter Register-Bestand), leichtgewichtige Mini-Profile aus der Firmen-Website, Match gegen das Idealkundenprofil mit Score und Warum-Begründung. Kandidaten-Tabelle mit Checkbox-Bulk-Import oder Ignorieren; Import startet erst nach expliziter Nutzer-Entscheidung. Opt-in-Automatik (täglich/wöchentlich) meldet neue heiße Treffer als Alert
- **ICP-Assistent**: Idealkundenprofil in Minuten statt Fragebogen. Der Nutzer nennt die eigene Website plus bis zu 5 Websites seiner besten Kunden; AVA liest Angebot, Standort und Kunden-Gemeinsamkeiten selbst aus und erstellt einen ICP-Entwurf zum Review. Fallback: Fragenkatalog als Formular. Die Top-Kunden fließen als Ähnlichkeits-Signal ins Radar-Matching ein („ähnelt deinem Bestandskunden X")
- **Telegram-Kanal**: Alerts aufs Handy plus vollwertiger mobiler Chat mit dem Agenten, inklusive Sprachnachrichten (lokale Transkription), Bildern und fortlaufendem Gesprächskontext
- **Publikations-Wissen auf Abruf (Lazy-RAG)**: Jahresabschluss-Textblöcke werden zentral gespeichert und eingebettet; der Chat beantwortet Detailfragen per Hybrid-Suche (Volltext + Vektor) statt teurer Voranalyse aller Blöcke
- **CRM-Anbindung** per OAuth (Tokens liegen verschlüsselt im OS-Schlüsselbund)
- **Voice-Mode** über bundled Speech-to-Text-Engine mit deutschem Sprachmodell
- **Heartbeat** scannt periodisch nach neuen Veröffentlichungen + Auffälligkeiten und meldet sie als Alerts in einer Bell + nativen OS-Push
- **Standing-Watches**: der Nutzer formuliert wiederkehrende Kriterien („melde mir, wenn eine Firma eine Bilanz mit GuV-Gewinn > 1 Mio. veröffentlicht"), die Heartbeat-Auswertung wendet sie auf jeden Tick an
- **Link-Überwachung**: beliebige URLs beobachten, KI fasst Änderungen zusammen, Beweis-Screenshot je Lauf im Audit-Trail; Bot-Challenges werden abgewartet, nie umgangen
- **Professional-Network-Beobachter**: opt-in Feed-Beobachtung über eingebettetes Browser-Fenster, mit Vision-LLM-Bildanalyse und Entity-Linking auf Firmen im Bestand
- **Multi-Source-Pipeline**: `structured-content` zieht primär aus dem amtlichen Unternehmensregister, fällt bei Ausfall automatisch auf das Sekundär-Register zurück; Status pro Quelle live im Whoami-Panel
- **Kostenkontrolle**: konfigurierbares tägliches Token-Limit für Chat + Agent, separates (günstigeres) Modell für Producer-Hintergrundarbeit, Verbrauchsübersicht in den Einstellungen
- **Audit-Trail**: sicherheits- und kostenrelevante Aktionen (Importe, Radar-Läufe inklusive der geplanten Suchanfragen, Überwachungs-Läufe, Konfig-Änderungen) sind in der App nachvollziehbar
- **Abonnement & Quotas**: Checkout + Customer-Portal über externen Payment-Provider, Tier-aware Pre-Checks vor jedem Import, sichtbare „Kündigung zum X vorgemerkt"-Hinweise
- **Werksreset** mit doppelter Bestätigung; heruntergeladene KI-Modelle und Provider-Konfiguration bleiben wahlweise erhalten
- **OTA-Updates** über integrierten Auto-Updater + Release-Hosting
- **Multi-Provider-LLM**: lokale LLM-Runtime (Standard) oder Bring-Your-Own-Key für gängige Hosted-LLM-Provider

## Status & Service Health

Aktuell Pre-1.0 (Stand: **v0.1.451**). Die Architektur ist stabil, Featureflächen wachsen pro Release.

Die Badges oben zeigen den Live-Status der Cloud-Komponenten:

| Service | Rolle | Live-Endpoint |
|---|---|---|
| `db-gateway` | Auth-Gate, Audit-DB, Operator-Proxies, geteilte Korpora | [ava-db-gateway.fly.dev/health](https://ava-db-gateway.fly.dev/health) |
| `master-data` | Stammdaten-Index, Fuzzy-Suche | [ava-master-data.fly.dev/health](https://ava-master-data.fly.dev/health) |
| Desktop-Build (CI) | Letzter Release-Run | siehe Badge oben |

Die schwere Pipeline-Logik (Producer, LLM, Scraping) läuft auf der Maschine des Nutzers und ist deshalb nicht zentral „status-bar"-fähig. Ausfälle sind lokal sichtbar im Whoami-Panel der Desktop-App.

Tiefere Dokumentation unter [`docs/`](./docs/): [`DECISIONS.md`](./docs/DECISIONS.md) (D1–D11-Architekturentscheidungen), [`INVENTORY.md`](./docs/INVENTORY.md) (Bestandsaufnahme), [`DESKTOP_DATA_FLOW.md`](./docs/DESKTOP_DATA_FLOW.md) (Workflows W1–W25, SSE-Bridge, IPC-Verträge), [`CHANGELOG.md`](./docs/CHANGELOG.md) (Release-Chronik), [`PLANS.md`](./docs/PLANS.md) sowie die Feature-Pläne (u. a. [`PLAN_FIRMEN_DISCOVERY.md`](./docs/PLAN_FIRMEN_DISCOVERY.md), [`PLAN_ICP_ASSISTENT.md`](./docs/PLAN_ICP_ASSISTENT.md)).

## Roadmap

Wohin sich AVA entwickelt. Granulare Tickets liegen im Tracker; hier nur die strategischen Linien, die AVA zu dem machen sollen, was es sein will.

### Was AVA heute schon ist

- Eine **lokal-laufende KI-Assistenz** für deutsche B2B-Recherche, die Excel-Importe, Handelsregister-Abfragen, Webseiten-Crawls und LLM-Bewertungen automatisch zu Firmenprofilen verdichtet
- Ein **Chat-Agent** mit Tool-Use, eigenen Skills, Voice-Mode und Telegram-Anbindung als primäre Bedienoberfläche
- Ein **Lead-Radar**, das neue Firmen in der Region entdeckt, gegen das Idealkundenprofil bewertet und heiße Treffer aktiv meldet, statt auf Importe zu warten
- **HubSpot-integriert** mit Live-Enrichment auf Knopfdruck und Heartbeat-getriebenen Alerts bei neuen Veröffentlichungen
- **Modellneutral**: lokales LLM als Standard, BYO-Key für gängige Hosted-Provider (Opus 4.7, GPT-5.5, Gemini 3.1 Pro, …)

### Wohin wir wollen

**Universelle CRM-Anbindung.** HubSpot war der Anfang; Salesforce und Microsoft Dynamics folgen, und perspektivisch wird der Schreibpfad bidirektional. AVA soll der intelligente Recherche-Layer über *deinem* CRM sein, nicht ein Parallelsystem, in das du zusätzlich pflegst.

**Strukturiertes Wissen aus unstrukturierten Quellen.** Die Veröffentlichungen im Unternehmensregister enthalten Bilanzen, GuV, Umsatzentwicklung. Mit den zentral gespeicherten, durchsuchbaren Publikations-Blöcken ist der erste Schritt gemacht; als Nächstes werden daraus quantitative Zeitreihen, Branchen-Benchmarks und vergleichbare Kennzahlen.

**Geteilte Recherche-Workflows.** Das Skills-System hat heute schon ein Trust-Modell. Als Nächstes: ein Marketplace, in dem Branchenexperten ihre Recherche-Templates für andere AVA-Nutzer veröffentlichen, vom „Solvenz-Check für Mittelstand" bis zum „Familienunternehmer-Nachfolge-Scan".

**Mehr Märkte.** AVA ist heute auf deutsche Handelsregister-Daten optimiert. Österreichische und schweizer Quellen sind der naheliegende nächste Schritt; weiter draußen liegen die anderen EU-DACH-Registerstandards.

**Vom Single-Seat zum Team.** Heute läuft AVA als persönliche Recherche-Assistenz. Geteilte Standing-Watches, geteilte CRM-Verknüpfungen, ein gemeinsames Recherche-Archiv für Teams stehen auf der mittelfristigen Karte.

> Konkrete Wünsche, Lücken, Branchenanforderungen? Schreib an [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de). Die Roadmap wird mit jeder Nutzer-Rückmeldung schärfer.

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
│   └── db-gateway/          # Cloud-API-Gateway + geteilte Korpora
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

## Vendor-Sync für `@ava/ai-provider`

Die Producer-Submodule tragen jeweils eine eingebaute Kopie von
`@ava/ai-provider` unter `<producer>/vendor/ai-provider/`. Sobald du
am Workspace-Paket etwas änderst, müssen die vendorierten Kopien
nachgezogen werden, sonst schlägt der CI-Drift-Check beim nächsten
Release-Build fehl.

```bash
pnpm vendor:sync          # baut canonical + rsync't in jedes Producer-
                          # Submodul + committet + pushed dort
pnpm vendor:check         # nur prüfen, nichts ändern (read-only)
```

Ein Pre-Push-Hook (eingecheckt unter `.githooks/pre-push`,
aktiviert durch `pnpm install` via `postinstall`) blockt Pushes
mit Drift mit klarer Anweisung.

## Lizenz

Internes Projekt der eproX GmbH. Externe Beiträge derzeit nicht vorgesehen.

---

_Fragen, Feedback, Bugs:_ [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de)
