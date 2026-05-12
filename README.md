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

Aktuell Pre-1.0 (Stand: **v0.1.155**). Die Architektur ist stabil, Featureflächen wachsen pro Release.

Die Badges oben zeigen den Live-Status der Cloud-Komponenten:

| Service | Rolle | Live-Endpoint |
|---|---|---|
| `db-gateway` | Auth-Gate, Audit-DB, Operator-Proxies | [ava-db-gateway.fly.dev/health](https://ava-db-gateway.fly.dev/health) |
| `master-data` | Stammdaten-Index, Fuzzy-Suche | [ava-master-data.fly.dev/health](https://ava-master-data.fly.dev/health) |
| Desktop-Build (CI) | Letzter Release-Run | siehe Badge oben |

Die schwere Pipeline-Logik (Producer, LLM, Scraping) läuft auf der Maschine des Nutzers und ist deshalb nicht zentral „status-bar"-fähig — Ausfälle sind lokal sichtbar im Whoami-Panel der Desktop-App.

Tiefere Dokumentation: [`DECISIONS.md`](./DECISIONS.md) (D1–D11-Architekturentscheidungen), [`INVENTORY.md`](./INVENTORY.md) (Bestandsaufnahme), [`DESKTOP_DATA_FLOW.md`](./DESKTOP_DATA_FLOW.md) (Workflows W1–W25, SSE-Bridge, IPC-Verträge), [`CHANGELOG.md`](./CHANGELOG.md) (Release-Chronik), [`PLANS.md`](./PLANS.md) (technische Feature-Pläne).

## Roadmap

Was bereits drin ist und was als Nächstes kommt. Wird mit jeder Release-Runde aktualisiert (Stand: v0.1.155).

### Bereits geliefert ✓

- **AI-Chat als primäre Bedienoberfläche** mit Tool-Use, Skills, persistentem Profil und Voice-Mode
- **Multi-Provider-LLM** — lokale Runtime als Standard, BYO-Key für gängige Hosted-Provider; Producer übernehmen den Schlüssel des Nutzers transparent
- **CRM-Integration HubSpot** — OAuth, Live-Enrichment auf Knopfdruck, manuelle Verknüpfung, Deep-Link in die HubSpot-UI
- **Bulk-Import** aus Excel/CSV inkl. Fuzzy-Match mit Dry-Run-Preview vor Commit
- **Heartbeat & Standing-Watches** — periodischer Scan auf neue Bekanntmachungen + nutzer-formulierte Trigger-Kriterien
- **Producer-Selfheal** — Auto-Restart bei Crash, Quota-Aware Parking statt harter Ablehnung
- **Abonnement & Quotas** über externen Payment-Provider mit Tier-aware Pre-Checks
- **OTA-Updates mit Fehlerdiagnose** — automatische Erkennung still gescheiterter Installationen und direkte Verknüpfung zu Log-Dateien (v0.1.155)

### In Arbeit / als Nächstes

| Bereich | Was kommt |
|---|---|
| **Importe** | Nachträgliche Bearbeitung unmatchter Firmen nach dem Commit (kein zweiter Import nötig) |
| **Bekanntmachungen** | Automatische numerische Extraktion (Bilanzkennzahlen, GuV, Umsatz) aus Veröffentlichungstexten |
| **Re-Extraktion** | Existierende Firmen erneut durch beliebige Producer schicken ohne Re-Import |
| **Globale Live-Matrix** | Status aller laufenden Pipelines in einer Übersicht statt nur pro Transaktion |
| **CRM-Erweiterung** | Salesforce + Microsoft-Dynamics-OAuth aktivieren; bidirektionaler Sync mit Schreibschutz-Gates |
| **Skills-System** | Marketplace + Trust-Modell für nutzer-eigene Markdown-Workflows |
| **Sichtbarkeit Quotas** | Per-Zeile „parked"-Pille in der Transaktions-Matrix, damit Quota-Stopper sofort sichtbar sind |
| **Datenmodell** | Tier-aware Persist Wave 2 — Vollständigkeit von Firmenprofilen abhängig vom Plan-Tier |

### Forschungs- & Stretch-Themen

- **Events-as-Context** — laufende Producer-Ergebnisse als Live-Kontext für den Chat-Agenten, statt nur DB-Snapshots
- **LLM-Judgment-Cache** — wiederverwendbare Bewertungen über Sessions hinweg, damit gleiche Fragen nicht jedes Mal neu durch den LLM laufen
- **CRM Phase 1.5 + 2** — strukturierter Schreibpfad zurück ins CRM mit Diff-Preview

> Lücken oder Wünsche? [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de) — die Roadmap ist nicht in Stein gemeißelt.

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
