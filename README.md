# AVA

[![Desktop Release Build](https://github.com/eproX-GmbH/ava-services/actions/workflows/desktop-release.yml/badge.svg?event=push)](https://github.com/eproX-GmbH/ava-services/actions/workflows/desktop-release.yml)
[![Latest Release](https://img.shields.io/github/v/release/eproX-GmbH/ava-services?include_prereleases&label=release&color=00c0a7)](https://github.com/eproX-GmbH/ava-services/releases/latest)
[![Service Health](https://img.shields.io/website?url=https%3A%2F%2Fava-db-gateway.fly.dev%2Fhealth&label=db-gateway&up_message=operational&down_message=offline)](https://ava-db-gateway.fly.dev/health)
[![Master-Data](https://img.shields.io/website?url=https%3A%2F%2Fava-master-data.fly.dev%2Fhealth&label=master-data&up_message=operational&down_message=offline)](https://ava-master-data.fly.dev/health)

> Sales Intelligence als Desktop-App: Firmen aus Deutschland, Österreich und dem Vereinigten Königreich recherchieren, beobachten und ins eigene CRM bringen. KI läuft auf dem Rechner des Nutzers oder mit eigenem Schlüssel.

AVA verdichtet öffentliche Unternehmensdaten zu einem vollständigen Firmenbild: amtliches Register, Jahresabschlüsse und Bekanntmachungen, Firmenwebsite, Ansprechpartner mit Herkunftsnachweis und eine KI-Bewertung gegen das eigene Idealkundenprofil. Danach beobachtet AVA die Firmen weiter und meldet, was sich ändert: Insolvenzen, Löschungen, Geschäftsführerwechsel, neue Jahresabschlüsse, Website-Änderungen, LinkedIn-Signale.

Bedient wird AVA über einen Chat-Agenten mit rund 250 Werkzeugen, über die Firmenansichten in der App, über Telegram unterwegs und über gespeicherte Workflows. Alles Rechenintensive (Browser-Automatisierung, Extraktion, KI-Aufrufe) läuft **lokal auf der Maschine des Nutzers**. Die Cloud ist Substrat: Anmeldung, Stammdaten, Verarbeitungsstand, geteilte Korpora.

## Inhalt

- [Was AVA heute kann](#was-ava-heute-kann)
- [Architektur](#architektur)
- [Cloud-Komponenten und Betrieb](#cloud-komponenten-und-betrieb)
- [Sicherheit und Datenschutz](#sicherheit-und-datenschutz)
- [Status](#status)
- [Roadmap](#roadmap)
- [Installation](#installation)
- [Repository-Layout](#repository-layout)
- [Entwicklung](#entwicklung)
- [Dokumentation](#dokumentation)

## Was AVA heute kann

### Firmen aufnehmen und recherchieren

- **Import** per Excel/CSV, einzeln per Name und Ort, aus HubSpot oder über den Firmen-Radar. Jede Firma wird öffentlichen Quellen zugeordnet (Fuzzy-Suche über den Stammdaten-Index).
- **Sechs Producer** je Firma, die sich gegenseitig anstoßen. Status pro Firma und Stufe live als Matrix, mit Pause, Löschen, Wiederholen je Stufe, Logs und Screenshots je Lauf.

| Producer | Quelle | Ergebnis |
|---|---|---|
| `structured-content` | Handelsregister (Registerportal), Firmenbuch (AT) und Companies House (UK) über master-data | Stammdaten, Sitz, Geschäftsführung bzw. Officers; für deutsche HRB-Firmen zusätzlich die Gesellschafterliste (siehe Verflechtungen) |
| `company-publication` | Unternehmensregister / Bundesanzeiger | Jahresabschlüsse, Lagebericht, Bekanntmachungen; Kennzahlen per Lazy-RAG auf Abruf statt Voranalyse |
| `website` | Websuche + Firmenwebsite | Beste Treffer-Website, Inhalte, Stellenanzeigen, eingesetzte Systeme aus der Datenschutzerklärung |
| `company-profile` | Website | Firmenprofil (Angebot, Branche, Größe, Standorte) |
| `company-contact` | Website, Impressum | Ansprechpartner und Kontaktwege mit Beleg, Herkunftsnachweis und Art.-14-Hinweis |
| `company-evaluation` | alles oben | KI-Bewertung gegen das Idealkundenprofil, Best-Match-Ranking, Angebotsvergleich |

- **Länder:** Deutschland (Handelsregister, Insolvenzbekanntmachungen), Österreich (Firmenbuch über JustizOnline, Ediktsdatei) und Vereinigtes Königreich (Companies House, Gazette). Länderfilter in Firmensuche und „Meine Firmen“, Landeschip und amtliche Kennung je Firma. Schweiz ist bewertet, aber nicht umgesetzt.
- **Stammdaten aktuell halten (Register-Delta):** Neueintragungen, Änderungen und Löschungen kommen täglich aus den Registern. Die Arbeit teilen sich Betreiber-Worker in der Cloud und Nutzer, die „Stammdaten mitpflegen“ einschalten (Opt-in, höchstens 60 Abfragen je Stunde). Geänderte Registerblätter markieren die betroffene Firma als veraltet.
- **Insolvenzen und Firmenstatus:** gezielte Prüfung je Pool-Firma alle 30 Tage; Insolvenz, Löschung, Löschungsankündigung und Liquidation erscheinen als Chip in den Tabellen, als Warnung in jedem Chat-Werkzeug und als Meldung des Firmenstatus-Wächters.
- **Firmen-Verflechtungen (Deutschland):** Gesellschafterlisten werden über den Registerordner geladen, mit dem KI-Modell des Nutzers gelesen (zwei unabhängige Lesungen, harter Qualitätsfilter, Bild-Modell ab Stufe A Pflicht) und zu Beteiligungen, Personen und gemeinsamen Adressen verdichtet. Firmen-Gesellschafter werden rekursiv nachgezogen (Besuchsliste, Notbremse Tiefe 6 / 200 Firmen, abschaltbar). Reiter „Verflechtungen“ mit Netzgrafik, Gesellschaftertabelle und Personenseite; Meldung „Gesellschafterwechsel“. Als Org-Feature abschaltbar. Stand: umgesetzt, Ende-zu-Ende-Erprobung läuft.
- **Neue Firmen finden (Firmen-Radar):** Scan in einer Region aus öffentlichen Firmeneinträgen, KI-geplanter Web-Recherche und unverarbeitetem Registerbestand; Mini-Profile, Score gegen das Idealkundenprofil, Import erst nach Entscheidung des Nutzers. Automatik täglich oder wöchentlich als Opt-in.
- **Idealkundenprofil (ICP):** aus der eigenen Website und bis zu fünf Kunden-Websites abgeleitet oder als Fragebogen; bleibt lokal.

### Beobachten und melden

- **Heartbeat und Meldungen:** neue Veröffentlichungen, Profiländerungen, Bewertungs-Auffälligkeiten, Firmenstatus, Gesellschafterwechsel; Glocke in der App, OS-Benachrichtigung, Telegram. Ruhezeiten, dringende Meldungen umgehen sie.
- **Beobachtungsregeln (Watches)** mit eigener Bewertungsvorschrift in Nutzersprache.
- **Website-Überwachung** beliebiger URLs mit KI-Zusammenfassung der Änderung und Beweis-Screenshot; Bot-Schutz wird abgewartet, nie umgangen.
- **LinkedIn (Opt-in, eigenes Konto):** Feed-Beobachter für Signale zu Firmen im Bestand, Personen-Watchlist, Personen-Radar aus Beitrags-Engagement. Bildanalyse per Vision-Modell.
- **Safe Browsing** vor Website-Abrufen.

### Kontakte und Kommunikation

- **Ansprechpartner** mit Beleg, Herkunft und Löschfunktion; Datenschutzhinweise (Art. 14) als Text exportierbar.
- **E-Mail-Muster:** Adressen nach dem Muster der Firma ableiten und gegen den Mail-Server prüfen (Hintergrund mit Vorrang für Chat, Last und Akku; verifizierte Adressen werden nie erneut geprüft, Bounces und Antworten fließen zurück).
- **Mail-Postfach** anbinden (IMAP): lesen, antworten, weiterleiten, archivieren, Triage mit Kontext je Firma.
- **Telegram:** Meldungen, Kurzprofile und Freigaben aufs Handy, vollwertiger Chat mit Sprachnachrichten und Bildern.

### Arbeiten mit AVA

- **Chat-Agent** mit rund 250 Werkzeugen in 36 Gruppen, Tool-Suche, Gedächtnis über Gespräche, Nutzerprofil, Vorschlags-Chips für die nächsten Schritte, Sprachmodus (lokale Whisper-Transkription).
- **Workflows:** Abläufe aus dem Gespräch speichern, als Diagramm kontrollieren, per Zeitplan oder Ereignis ausführen (neuer Radar-Treffer, eingehende Mail, Import fertig). Schreibende Schritte nur nach Freigabe; Freigaben in App, Meldungen oder Telegram; Laufhistorie und Audit.
- **Skills:** wiederverwendbare Routinen per Slash-Befehl, mit Trust-Modell.
- **Integrationen:** HubSpot (lesen, anlegen, verknüpfen), Notion, Obsidian. Teilen von Recherchen, Radar-Firmen und Workflows mit der Organisation.
- **KI-Modelle:** lokal (Ollama, kuratierte Modelle mit Hardware-Prüfung) oder mit eigenem Schlüssel bei OpenAI, Anthropic, Google, Mistral, DeepSeek, xAI, Qwen; ChatGPT-Abo und Anthropic-Abo per OAuth nutzbar. Jedes Modell hat eine Qualitätsstufe (S/A/B/C, `docs/MODEL_TIERS.md`), die entscheidet, ob ein Ergebnis bestehende Daten überschreiben darf und welche Funktionen es freischaltet. Getrenntes, günstigeres Modell für die Hintergrundverarbeitung, Token-Limit je Tag, Verbrauchsübersicht.

### Organisationen

- Mandanten mit Mitgliedern, Beitrittsanfragen, Vorgaben je Organisation: Anbieter-Sperre, vorgegebene Modelle, Organisationsschlüssel über den Gateway-Proxy, Limits, abschaltbare Module (LinkedIn, Bildanalyse, Kontakt-Recherche, Mail, Telegram, Workflows, Vorschläge, Stammdaten mitpflegen, Verflechtungen). Abgeschaltetes verschwindet vollständig aus der App.
- Seat-Abrechnung je Belegungsmonat (Stripe), Kontingente je Plan mit Vorprüfung vor jedem Import, Verbrauch je Mitglied.
- Mehrere Konten auf einem Gerät (Account-Spaces), Audit-Protokoll für sicherheits- und kostenrelevante Aktionen.

## Architektur

```
┌────────────────────────────────────────────────┐   ┌────────────────────────────────┐
│ Desktop-App (macOS arm64/x64, Windows x64)     │   │ Cloud-Substrat (Fly.io, EU)    │
│                                                │   │                                │
│  Chat-Agent · Firmen · Radar · Workflows       │   │ db-gateway                     │
│  Meldungen · Mail · Telegram · Organisation    │   │  Auth (Keycloak OIDC), Policy  │
│                                                │   │  Persist-Bus mit Tier-Gate     │
│  6 Producer-Subprozesse (lokal)                │◄──┤  Register-Delta-Queue, Cron    │
│  Register-Delta-Worker (Opt-in)                │AMQP  Verflechtungen-Kontexte      │
│  LLM lokal (Ollama) oder eigener Schlüssel     │   │  Operator-Proxies (Suche, CRM) │
│  Whisper-Sidecar für Sprache                   │   │  Abrechnung (Stripe)           │
│  Hintergrund-Browser, gehärtet                 │   │                                │
└────────────────────────────────────────────────┘   │ master-data                    │
                                                     │  Stammdaten DE/AT/UK, Elastic  │
                                                     │  Personen, Beteiligungen,      │
                                                     │  Adressen, Insolvenz-Ereignisse│
                                                     │                                │
                                                     │ ava-register-worker (Fly)      │
                                                     │ ava-pgbouncer (Verbindungs-    │
                                                     │  trichter vor Postgres)        │
                                                     └────────────────────────────────┘
```

**Compute-Lokalität ist Invariante** (`docs/DECISIONS.md`): jeder LLM-Aufruf und jeder Web-Abruf für die Recherche läuft auf der Maschine des Nutzers. Cloud-seitig läuft Substrat, die Register-Delta-Worker des Betreibers (nur öffentliche Register, kein LLM) und die wenigen Dienste, die einen Betreiber-Schlüssel brauchen (Websuche, CRM-OAuth-Austausch, optionaler Organisationsschlüssel-Proxy).

**Persist-Bus mit Tier-Gate:** Producer schreiben nicht direkt in die Datenbank, sondern schicken Ereignisse an den Gateway. Der prüft Mandant, Modul-Freigabe der Organisation und die Qualitätsstufe des Modells und verwirft Rückschritte („einer verarbeitet, alle profitieren“, aber nie mit schlechteren Daten).

## Cloud-Komponenten und Betrieb

| Komponente | Rolle | Betrieb |
|---|---|---|
| `ava-db-gateway` | Auth-Gate, Policy, Persist-Bus, Register-Queue, Verflechtungen, Proxies, Abrechnung | Fly, [Health](https://ava-db-gateway.fly.dev/health) |
| `ava-master-data` | Stammdaten-Index DE/AT/UK, Fuzzy-Suche (Elasticsearch), Personen, Beteiligungen, Adressen | Fly, [Health](https://ava-master-data.fly.dev/health) |
| `ava-register-worker` | Betreiber-Worker für Register-Delta: DE mit Browser, AT und UK ohne | Fly, zwei Prozessgruppen |
| `ava-pgbouncer` | Verbindungstrichter vor der geteilten Postgres (100 Verbindungen für alle Dienste) | Fly |
| Keycloak | Anmeldung, Organisationen, Rollen | Fly |
| Postgres, Elasticsearch, CloudAMQP | Daten, Suche, Ereignisse | managed |

Deploys von Gateway und master-data laufen manuell per `fly deploy --remote-only` nach Freigabe; master-data braucht den npm-Token als Build-Secret. Der Desktop-Release entsteht aus einem Tag `v0.1.X` über GitHub Actions: macOS arm64 und x64 (signiert, notarisiert), Windows x64 (Azure Artifact Signing, `docs/WINDOWS_CODESIGNING.md`), OTA-Updates über den integrierten Updater.

## Sicherheit und Datenschutz

- Schlüssel und Tokens liegen im Schlüsselbund des Betriebssystems; eigene KI-Schlüssel überschreiten nie die Grenze zur Oberfläche und werden nicht über den Chat gesetzt.
- Hintergrund-Browser sind gehärtet: keine Downloads außer den amtlichen Registerdateien (XML, Gesellschafterlisten als PDF/TIFF, geprüft an den Magic Bytes, nach dem Lesen gelöscht), keine Web-Berechtigungen, Producer nur auf Loopback (`docs/SICHERHEIT_HINTERGRUND_BROWSER.md`).
- Personendaten: Ansprechpartner mit Herkunftsnachweis, Art.-14-Hinweis und Löschfunktion; Aufbewahrungsfristen per Cron; Geburtsdaten aus Gesellschafterlisten nur als Jahr nach außen, intern mit Hash für eine spätere Entfernung.
- Alle Ausgaben von Modellen und externen Quellen werden vor der Übernahme gegen Schemata geprüft (Yup). „Lieber keine Daten als falsche Daten“ ist Regel, nicht Ausnahme.
- Compliance- und Enterprise-Stand mit offenen Punkten: `docs/PLAN_ENTERPRISE_FREIGABE.md`.

## Status

Pre-1.0, aktuell **v0.1.669** (September 2026). Die Architektur ist seit dem Umbau auf Desktop plus Substrat (April 2026) stabil; Funktionen kommen in kleinen Releases, oft mehrere am Tag. Die Badges oben zeigen den Live-Zustand der Cloud-Komponenten; Ausfälle der lokalen Producer sind im Whoami-Panel der App sichtbar.

Was gerade in Erprobung ist und noch nicht beworben wird: Firmen-Verflechtungen Ende-zu-Ende, Workflows ohne laufende App.

## Roadmap

- **Verflechtungen abschließen:** Ende-zu-Ende-Test, Backfill der Adressen für den Bestand, Adressen aus AT/UK.
- **Workflows ohne laufende App** (`docs/PLAN_WORKFLOWS_OHNE_APP.md`): Zeitpläne, die auch bei geschlossener App laufen.
- **Enterprise-Freigabe** (`docs/PLAN_ENTERPRISE_FREIGABE.md`): SSO-Anbindung an Kundenverzeichnisse, Datenresidenz, Auftragsverarbeitung, Protokollexport.
- **Weitere CRM-Systeme** neben HubSpot (Salesforce, Dynamics), perspektivisch bidirektional.
- **Schweiz** (`docs/PLAN_SCHWEIZ.md`) als viertes Land, sobald die Registerquelle belastbar ist.
- **Zeitreihen und Benchmarks** aus den Jahresabschluss-Blöcken.

> Wünsche und Lücken: [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de).

## Installation

Vorgefertigte Builds: [Releases](https://github.com/eproX-GmbH/ava-services/releases) oder über [ava.bi](https://ava.bi).

1. Installationspaket der Plattform laden (macOS `.dmg`, Windows `.exe`).
2. Installieren und starten, mit Konto anmelden oder registrieren.
3. Beim ersten Start KI wählen: lokales Modell laden oder eigenen Schlüssel hinterlegen. Der Einrichtungsassistent führt durch.
4. Updates kommen danach automatisch (OTA).

## Repository-Layout

```
ava-services/
├── services/
│   ├── desktop/             # Desktop-App (Electron: Main / Preload / Renderer), Chat-Agent, Tools
│   └── db-gateway/          # Cloud-Gateway: Auth, Policy, Persist-Bus, Register-Queue, Verflechtungen
├── master-data/             # Stammdaten DE/AT/UK, Fuzzy-Suche, Personen/Beteiligungen/Adressen (Submodul)
├── structured-content/      # Producer: Register, Officers, Gesellschafterlisten (Submodul)
├── company-publication/     # Producer: Jahresabschlüsse, Bekanntmachungen (Submodul)
├── website/                 # Producer: Websuche, Website, Stellen, Tech-Stack (Submodul)
├── company-profile/         # Producer: Firmenprofil (Submodul)
├── company-contact/         # Producer: Ansprechpartner (Submodul)
├── company-evaluation/      # Producer: KI-Bewertung, Best-Match (Submodul)
├── packages/
│   ├── ai-provider/         # Ein Interface für alle LLM-Anbieter, Katalog mit Qualitätsstufen
│   ├── events/              # CloudEvents-Builder + AMQP-Client
│   └── register-delta/      # Register-Worker (Desktop „Mithelfen“ und Fly): DE, AT, UK
├── scripts/                 # vendor-sync, Drift-Prüfung, Hilfsskripte
└── docs/                    # Entscheidungen, Pläne, Tools-Referenz, Sicherheit
```

## Entwicklung

```bash
git clone --recurse-submodules https://github.com/eproX-GmbH/ava-services.git
cd ava-services && pnpm install          # Workspace: desktop, gateway, packages, Producer
cd services/desktop
pnpm dev                                  # App mit Hot-Reload
npm run build:typecheck                   # Typecheck, regeneriert docs/TOOLS.md, prüft deutsche UI-Texte
npm run test:suggestions                  # Vorschlags-Chips
npm run test:email-muster                 # E-Mail-Muster
```

Release: Version in `services/desktop/package.json` erhöhen, committen, Tag `v0.1.X` pushen. Der Workflow `.github/workflows/desktop-release.yml` baut, signiert und veröffentlicht.

Regeln, die im Code durchgesetzt werden: deutsche UI-Texte in Du-Form (`lint:german`), keine unterstrichenen Buttons, jede neue Einstellung bekommt auch ein Chat-Werkzeug mit Bestätigung, externe und Modell-Daten werden mit Yup geprüft, jedes Katalogmodell braucht eine Qualitätsstufe.

### Vendor-Sync für `@ava/ai-provider`

Die Producer-Submodule tragen eine eingebaute Kopie von `@ava/ai-provider` unter `<producer>/vendor/ai-provider/`. Nach jeder Änderung am Paket:

```bash
pnpm vendor:sync          # baut, kopiert in alle Producer, committet und pusht dort
pnpm vendor:check         # nur prüfen
```

Ein Pre-Push-Hook blockt Pushes mit Drift. Submodul-Pointer danach im Hauptrepo committen.

## Dokumentation

Einstieg über [`docs/README.md`](./docs/README.md). Wichtigste Dokumente:

- [`DECISIONS.md`](./docs/DECISIONS.md): Architekturentscheidungen D1 bis D11 (Compute-Lokalität, Substrat-Umfang)
- [`MODEL_TIERS.md`](./docs/MODEL_TIERS.md): Qualitätsstufen der Modelle und die Gates, die davon abhängen
- [`TOOLS.md`](./docs/TOOLS.md): automatisch erzeugte Referenz aller Chat-Werkzeuge
- [`SICHERHEIT_HINTERGRUND_BROWSER.md`](./docs/SICHERHEIT_HINTERGRUND_BROWSER.md): Härtung der Hintergrund-Browser, Download-Regeln
- Feature-Pläne mit Stand: [`PLAN_STAMMDATEN_DELTA.md`](./docs/PLAN_STAMMDATEN_DELTA.md), [`PLAN_INSOLVENZEN.md`](./docs/PLAN_INSOLVENZEN.md), [`PLAN_OESTERREICH.md`](./docs/PLAN_OESTERREICH.md), [`PLAN_UK.md`](./docs/PLAN_UK.md), [`PLAN_VERFLECHTUNGEN.md`](./docs/PLAN_VERFLECHTUNGEN.md), [`PLAN_WORKFLOWS.md`](./docs/PLAN_WORKFLOWS.md), [`PLAN_FIRMEN_DISCOVERY.md`](./docs/PLAN_FIRMEN_DISCOVERY.md), [`PLAN_EMAIL_MUSTER.md`](./docs/PLAN_EMAIL_MUSTER.md), [`PLAN_ABRECHNUNG_SEATS.md`](./docs/PLAN_ABRECHNUNG_SEATS.md), [`PLAN_ENTERPRISE_FREIGABE.md`](./docs/PLAN_ENTERPRISE_FREIGABE.md)

## Lizenz

Internes Projekt der eproX GmbH. Externe Beiträge derzeit nicht vorgesehen.

---

_Fragen, Feedback, Bugs:_ [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de)
