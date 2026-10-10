# AVA

[![Latest Release](https://img.shields.io/github/v/release/eproX-GmbH/ava-releases?include_prereleases&label=release&color=00c0a7)](https://github.com/eproX-GmbH/ava-releases/releases/latest)
[![Service Health](https://img.shields.io/website?url=https%3A%2F%2Fava-db-gateway.fly.dev%2Fhealth&label=db-gateway&up_message=operational&down_message=offline)](https://ava-db-gateway.fly.dev/health)
[![Master-Data](https://img.shields.io/website?url=https%3A%2F%2Fava-master-data.fly.dev%2Fhealth&label=master-data&up_message=operational&down_message=offline)](https://ava-master-data.fly.dev/health)

> Sales Intelligence als Desktop-App oder eigene Server-Instanz: Firmen aus Deutschland, Österreich und dem Vereinigten Königreich recherchieren, beobachten und ins eigene CRM bringen. KI läuft beim Nutzer (lokales Modell) oder mit eigenem Schlüssel.

AVA verdichtet öffentliche Unternehmensdaten zu einem vollständigen Firmenbild: amtliches Register, Jahresabschlüsse und Bekanntmachungen, Firmenwebsite, Ansprechpartner mit Herkunftsnachweis und eine KI-Bewertung gegen das eigene Idealkundenprofil. Danach beobachtet AVA die Firmen weiter und meldet, was sich ändert: Insolvenzen, Löschungen, Geschäftsführerwechsel, neue Jahresabschlüsse, Website-Änderungen, LinkedIn-Signale.

Bedient wird AVA über einen Chat-Agenten mit rund 290 Werkzeugen, über die Firmenansichten in der Desktop-App, über die AVA-App im Browser und auf dem Handy ([app.ava.bi](https://app.ava.bi)), über Telegram, aus Claude und ChatGPT per MCP und über gespeicherte Workflows. Alles Rechenintensive (Browser-Automatisierung, Extraktion, KI-Aufrufe) läuft **in der AVA des Nutzers**: auf seinem Rechner oder auf seiner eigenen Server-Instanz. Die Cloud ist Substrat: Anmeldung, Stammdaten, Verarbeitungsstand, geteilte Korpora, Vermittlung zwischen App, MCP und der AVA des Nutzers.

## Inhalt

- [Was AVA heute kann](#was-ava-heute-kann)
- [Architektur](#architektur)
- [Cloud-Komponenten und Betrieb](#cloud-komponenten-und-betrieb)
- [Sicherheit und Datenschutz](#sicherheit-und-datenschutz)
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
| `company-publication` | Unternehmensregister / Bundesanzeiger | Jahresabschlüsse und Konzernabschlüsse (Kennzahlen nur der Muttergesellschaft, Töchter und Geschäftsführung in den Verflechtungen), Lagebericht, Bekanntmachungen; Kennzahlen per Lazy-RAG auf Abruf statt Voranalyse |
| `website` | Websuche + Firmenwebsite | Beste Treffer-Website, Inhalte, Stellenanzeigen, eingesetzte Systeme aus der Datenschutzerklärung |
| `company-profile` | Website | Firmenprofil (Angebot, Branche, Größe, Standorte) |
| `company-contact` | Website, Impressum | Ansprechpartner und Kontaktwege mit Beleg, Herkunftsnachweis und Art.-14-Hinweis |
| `company-evaluation` | alles oben | KI-Bewertung gegen das Idealkundenprofil, Best-Match-Ranking, Angebotsvergleich |

- **Länder:** Deutschland (Handelsregister, Insolvenzbekanntmachungen), Österreich (Firmenbuch über JustizOnline, Ediktsdatei) und Vereinigtes Königreich (Companies House, Gazette). Länderfilter in Firmensuche und „Meine Firmen“, Landeschip und amtliche Kennung je Firma. Schweiz ist bewertet, aber nicht umgesetzt.
- **Stammdaten aktuell halten (Register-Delta):** Neueintragungen, Änderungen und Löschungen kommen täglich aus den Registern. Die Arbeit teilen sich Betreiber-Worker in der Cloud und Nutzer, die „Stammdaten mitpflegen“ einschalten (Opt-in, höchstens 60 Abfragen je Stunde). Geänderte Registerblätter markieren die betroffene Firma als veraltet.
- **Insolvenzen und Firmenstatus:** gezielte Prüfung je Pool-Firma alle 30 Tage; Insolvenz, Löschung, Löschungsankündigung und Liquidation erscheinen als Chip in den Tabellen, als Warnung in jedem Chat-Werkzeug und als Meldung des Firmenstatus-Wächters.
- **Firmen-Verflechtungen (Deutschland):** Gesellschafterlisten werden über den Registerordner geladen, mit dem KI-Modell des Nutzers gelesen (zwei unabhängige Lesungen, harter Qualitätsfilter, Bild-Modell ab Stufe A Pflicht) und zu Beteiligungen, Personen und gemeinsamen Adressen verdichtet. Firmen-Gesellschafter werden rekursiv nachgezogen (Besuchsliste, Notbremse Tiefe 6 / 200 Firmen, abschaltbar). Reiter „Verflechtungen“ mit Netzgrafik, Gesellschaftertabelle und Personenseite; Meldung „Gesellschafterwechsel“. Als Org-Feature abschaltbar. Stand: umgesetzt, Ende-zu-Ende-Erprobung läuft.
- **Neue Firmen finden (Firmen-Radar):** Scan in einer Region in Deutschland, Österreich oder dem Vereinigten Königreich aus öffentlichen Firmeneinträgen, KI-geplanter Web-Recherche und unverarbeitetem Registerbestand; Mini-Profile, Score gegen das Idealkundenprofil, Import erst nach Entscheidung des Nutzers. Automatik täglich oder wöchentlich als Opt-in.
- **Kunden und Referenzen:** Kunden, Referenzen, Zertifikate und Technologiepartner, die eine Firma auf ihrer Website nennt, per KI erkannt (ohne Heuristik), mit dem Firmenbestand abgeglichen (sicher/unsicher), als eigener Reiter, im Chat abrufbar und umgekehrt suchbar („wer nennt Firma X als Kunden?“); Meldung bei neuem Kunden.
- **Idealkundenprofil (ICP):** aus der eigenen Website und bis zu fünf Kunden-Websites abgeleitet oder als Fragebogen; liegt in der AVA des Nutzers.

### Beobachten und melden

- **Heartbeat und Meldungen:** neue Veröffentlichungen, Profil- und Stammdatenänderungen, neue und gewechselte Ansprechpartner, Bewertungs-Auffälligkeiten, Firmenstatus, Gesellschafterwechsel, neue Kunden; eine KI-Bewertung mit dem Nutzerprofil entscheidet, was meldenswert ist. Glocke in der App, OS-Benachrichtigung, Telegram, Push in der AVA-App. Ruhezeiten, dringende Meldungen umgehen sie.
- **Auffrischung:** der ganze Firmenbestand wird nach Relevanz in Abständen neu verarbeitet (Website, Profil, Kontakte, Veröffentlichungen), mit Pause nach Fehlversuchen.
- **Beobachtungsregeln (Watches)** mit eigener Bewertungsvorschrift in Nutzersprache.
- **Website-Überwachung** beliebiger URLs mit KI-Zusammenfassung der Änderung und Beweis-Screenshot; Bot-Schutz wird abgewartet, nie umgangen.
- **LinkedIn (Opt-in, eigenes Konto):** Feed-Beobachter für Signale zu Firmen im Bestand, Personen-Watchlist, Personen-Radar aus Beitrags-Engagement. Bildanalyse per Vision-Modell.
- **Safe Browsing** vor Website-Abrufen.

### Kontakte und Kommunikation

- **Ansprechpartner** mit Beleg, Herkunft und Löschfunktion; Datenschutzhinweise (Art. 14) als Text exportierbar. Kontaktangaben bleiben bei der Firma, bei der sie gefunden wurden: Arbeitet eine Person für mehrere Firmen, erscheinen E-Mail, Telefon und Position nur dort.
- **E-Mail-Muster:** Adressen nach dem Muster der Firma ableiten und gegen den Mail-Server prüfen (Hintergrund mit Vorrang für Chat, Last und Akku; verifizierte Adressen werden nie erneut geprüft, Bounces und Antworten fließen zurück). Firmenadressen mit Namen werden Personen zugeordnet; bei unklarem Muster entscheidet ein KI-Urteil. Abgeleitet wird nur mit der Domain der eigenen Firma (Website oder Firmenadresse), nie mit der Adresse einer anderen Firma derselben Person.
- **Buying Center:** Power Map je Firma nach dem Schema des strategischen Key-Account-Plans (Rolle, Einstellung, Kontaktintensität, Einfluss), Beziehungen zwischen Personen, Vorschläge von AVA aus Website und Kontaktdaten zur Freigabe, Verlauf. Gehört nur dem Ersteller; im Chat und im Sprachmodus als Karte.
- **Mail-Entwürfe:** Formuliert AVA eine Mail zum Selbstversenden (z. B. Erstansprache mit Ansprechpartner und Anlass), öffnet ein Knopf sie fertig im Mail-Programm: Outlook als Entwurf mit Anhängen, andere Programme per `mailto:`, ohne Mail-Programm Gmail oder Outlook im Web. Optional legt AVA Entwürfe mit Anhängen direkt in den Entwürfe-Ordner des eigenen Postfachs (IMAP, nur Schreiben). Feste Anhänge wie ein Firmenprofil werden einmal hinterlegt. Stand: umgesetzt, Erprobung läuft.
- **Mail-Postfach** anbinden (IMAP): lesen, antworten, weiterleiten (auch mit im Chat hochgeladenen Dateien), archivieren, Triage mit Kontext je Firma.
- **Telegram:** Meldungen, Kurzprofile und Freigaben aufs Handy, vollwertiger Chat mit Sprachnachrichten und Bildern; Antworten wahlweise als Text oder Sprachnachricht, Telegram je AVA-Instanz.

### Arbeiten mit AVA

- **Chat-Agent** mit rund 290 Werkzeugen in 43 Fähigkeitsgruppen, Tool-Suche, Gedächtnis über Gespräche, Nutzerprofil, Vorschlags-Chips für die nächsten Schritte. Diagramme und Buying-Center-Karten direkt in der Antwort. Dateien (Excel, CSV, PDF, Word, Bilder) bekommen ein Handle und werden bei Bedarf gelesen statt vollständig in den Prompt gelegt. Lange Aufgaben wie Importe laufen als Hintergrundaufgabe weiter; AVA meldet sich, wenn sie fertig sind.
- **Sprachmodus:** Gespräch mit AVA per Stimme (OpenAI GPT Live mit eigenem oder Organisationsschlüssel, Realtime als Rückfall), Aufträge laufen über denselben Agenten mit allen Werkzeugen, Diagramme und Buying Center erscheinen unter der Sprachkugel. Diktat und Aktivierungswort über lokales Whisper.
- **AVA-App im Browser und auf dem Handy ([app.ava.bi](https://app.ava.bi)):** installierbar als Web-App. Chat mit der eigenen AVA samt Rückfragen, Dateien, Fotos, Diktat und Sprachmodus, Firmensuche und Firmenansicht, Meldungen mit Push. Die App spricht über den Gateway mit der laufenden AVA des Nutzers (Desktop oder Server). Stand: umgesetzt, Erprobung läuft.
- **Claude und ChatGPT per MCP ([mcp.ava.bi](https://mcp.ava.bi)):** Anmeldung per OAuth mit dem AVA-Konto. Firmen suchen und lesen, Recherchen und Neuverarbeitung anstoßen, AVAs eigenen Agenten beauftragen (`ava_fragen`) und den Kontext laden (`ava_kontext`: Rolle, Regeln, Profil, ICP, Gedächtnis, Abläufe). Org-Schalter je Werkzeug.
- **Workflows:** Abläufe aus dem Gespräch speichern, als Diagramm kontrollieren, per Zeitplan oder Ereignis ausführen (neuer Radar-Treffer, eingehende Mail, Import fertig). Schreibende Schritte nur nach Freigabe; Freigaben in App, Meldungen oder Telegram; Laufhistorie und Audit.
- **Skills:** wiederverwendbare Routinen per Slash-Befehl, mit Trust-Modell.
- **Integrationen:** HubSpot (lesen, anlegen, verknüpfen), Notion, Obsidian. Teilen von Recherchen, Radar-Firmen und Workflows mit der Organisation.
- **KI-Modelle:** lokal (Ollama, kuratierte Modelle mit Hardware-Prüfung) oder mit eigenem Schlüssel bei OpenAI (auch über Azure OpenAI mit eigenem Endpunkt und Deployments), Anthropic, Google, Mistral, DeepSeek, xAI, Qwen; ChatGPT-Abo (Plus/Pro) per „Sign in with ChatGPT“ für Chat, Hintergrund-KI, Workflows und Firmenverarbeitung nutzbar (nicht für Sprachmodus und Deep Research). Jedes Modell hat eine Qualitätsstufe (S/A/B/C, `docs/MODEL_TIERS.md`), die entscheidet, ob ein Ergebnis bestehende Daten überschreiben darf und welche Funktionen es freischaltet. Getrenntes, günstigeres Modell für die Hintergrundverarbeitung, Token-Limit je Tag, Verbrauchsübersicht.

### Organisationen

- Mandanten mit Mitgliedern, Beitrittsanfragen, Vorgaben je Organisation: Anbieter-Sperre, vorgegebene Modelle, Organisationsschlüssel über den Gateway-Proxy (auch Azure OpenAI), Limits, abschaltbare Module (LinkedIn, Bildanalyse, Kontakt-Recherche, Mail, Telegram, Workflows, Vorschläge, Stammdaten mitpflegen, Verflechtungen, MCP-Werkzeuge). Abgeschaltetes verschwindet vollständig aus der App.
- **Web-Konsole [admin.ava.bi](https://admin.ava.bi)** für Organisations-Admins, ohne App-Installation: Mitglieder und Einladungen, Funktionen und Vorgaben, Schlüssel, Limits und Verbrauch (Kennzahlen, Verlauf je Tag nach Bereich oder Mitglied, Kosten je Mitglied, Quelle und Modell, CSV-Export), Abrechnung, Instanzen der Mitglieder mit Aktualisieren von Server-Instanzen auf eine neue Version. Die Organisationsverwaltung liegt nur noch dort.
- Seat-Abrechnung je Belegungsmonat (Stripe), Kontingente je Plan mit Vorprüfung vor jedem Import, Verbrauch je Mitglied.
- Mehrere Konten auf einem Gerät (Account-Spaces), mehrere AVAs je Konto (Desktop und Server, Umzug zwischen beiden), Audit-Protokoll für sicherheits- und kostenrelevante Aktionen.

### AVA als Server-Instanz

- Dieselbe AVA ohne Oberfläche als Container (`services/desktop/src/server`, Docker, Fly): Anmeldung per Device Flow, Einrichtungsseite für Schlüssel und ChatGPT-Abo, Embeddings über einen Ollama-Beiwagen. Bedient über die AVA-App, Telegram und MCP; der LinkedIn-Beobachter läuft nie auf dem Server.
- Kunden-Instanzen unter `<name>.ava.bi`, an ein Konto gebunden (nur dieses Konto kann sich anmelden), aus einem gemeinsamen Image je Release; Weiterleitung direkt im Gateway. Stand: Betreiber-Instanz in Betrieb, Kunden-Instanzen in Erprobung.

## Architektur

```
┌───────────────────────────────────────────────┐   ┌─────────────────────────────────┐
│ AVA des Nutzers                               │   │ Cloud-Substrat (Fly.io, EU)     │
│  Desktop-App (macOS arm64/x64, Windows x64)   │   │                                 │
│  oder Server-Instanz (Container, ohne UI)     │   │ db-gateway                      │
│                                               │   │  Auth (Keycloak OIDC), Policy   │
│  Chat-Agent · Firmen · Radar · Workflows      │   │  Persist-Bus mit Tier-Gate      │
│  Meldungen · Mail · Telegram · Sprachmodus    │WS │  Kopf-Relais: App-Kanal, MCP    │
│                                               │◄──┤  (mcp.ava.bi), Instanz-Router   │
│  6 Producer-Subprozesse (lokal)               │   │  Register-Delta-Queue, Cron     │
│  Register-Delta-Worker (Opt-in)               │AMQP  Operator-Proxies, Abrechnung │
│  LLM lokal (Ollama) oder eigener Schlüssel    │◄──┤                                 │
│  Whisper-Sidecar, Hintergrund-Browser         │   │ master-data                     │
└───────────────────────────────────────────────┘   │  Stammdaten DE/AT/UK, Elastic,  │
                                                    │  Personen, Beteiligungen,       │
┌───────────────────────────────────────────────┐   │  Adressen, Insolvenz-Ereignisse │
│ Web (Vercel, EU)                              │   │                                 │
│  app.ava.bi    AVA-App (PWA, Next.js-BFF)     │──►│ ava-register-worker (Fly)       │
│  admin.ava.bi  Web-Konsole für Org-Admins     │   │ ava-pgbouncer                   │
└───────────────────────────────────────────────┘   └─────────────────────────────────┘
```

**Compute-Lokalität ist Invariante** (`docs/DECISIONS.md`): jeder LLM-Aufruf und jeder Web-Abruf für die Recherche läuft in der AVA des Nutzers, auf seinem Rechner oder auf seiner eigenen Server-Instanz. Cloud-seitig läuft Substrat, die Register-Delta-Worker des Betreibers (nur öffentliche Register, kein LLM) und die wenigen Dienste, die einen Betreiber-Schlüssel brauchen (Websuche, CRM-OAuth-Austausch, optionaler Organisationsschlüssel-Proxy).

**Kopf-Relais:** Die laufende AVA verbindet sich ausgehend per WebSocket mit dem Gateway und meldet ihre Werkzeuge an. Darüber erreichen die AVA-App (Anfragen, Antwort-Strom per SSE mit Wiederaufsetzen) und MCP-Clients die AVA des Nutzers, ohne dass sie von außen erreichbar sein muss. Hat ein Nutzer mehrere AVAs (Desktop und Server), wählt der Gateway eine passende Instanz; persönlicher Kontext wie Profil und Gedächtnis wird dabei aus der Instanz geholt, die ihn hat.

**Persist-Bus mit Tier-Gate:** Producer schreiben nicht direkt in die Datenbank, sondern schicken Ereignisse an den Gateway. Der prüft Mandant, Modul-Freigabe der Organisation und die Qualitätsstufe des Modells und verwirft Rückschritte („einer verarbeitet, alle profitieren“, aber nie mit schlechteren Daten).

## Cloud-Komponenten und Betrieb

| Komponente | Rolle | Betrieb |
|---|---|---|
| `ava-db-gateway` | Auth-Gate, Policy, Persist-Bus, Register-Queue, Verflechtungen, Proxies, Abrechnung | Fly, [Health](https://ava-db-gateway.fly.dev/health) |
| `ava-master-data` | Stammdaten-Index DE/AT/UK, Fuzzy-Suche (Elasticsearch), Personen, Beteiligungen, Adressen | Fly, [Health](https://ava-master-data.fly.dev/health) |
| `ava-register-worker` | Betreiber-Worker für Register-Delta: DE mit Browser, AT und UK ohne | Fly, zwei Prozessgruppen |
| `ava-pgbouncer` | Verbindungstrichter vor der geteilten Postgres (100 Verbindungen für alle Dienste) | Fly |
| Server-Instanzen | AVA ohne Oberfläche je Kunde (`<name>.ava.bi`), Image je Release in `ava-server-image`, Embeddings-Beiwagen | Fly |
| AVA-App, Web-Konsole | `app.ava.bi`, `admin.ava.bi`: Next.js mit Anmeldung über Keycloak (BFF, Sitzung als verschlüsseltes httpOnly-Cookie), eigene private Repos | Vercel, Frankfurt |
| Keycloak | Anmeldung, Organisationen, Rollen | Fly |
| Postgres, Elasticsearch, CloudAMQP | Daten, Suche, Ereignisse | managed |

Deploys von Gateway und master-data laufen manuell per `fly deploy --remote-only` nach Freigabe; master-data braucht den npm-Token als Build-Secret. Server-Instanzen: Image mit `scripts/instanz-image.mjs` bauen, anlegen, aktualisieren und entfernen mit `scripts/instanz-*.mjs` oder aktualisieren per Knopf in der Web-Konsole. App und Konsole rollt Vercel bei jedem Push auf `main` aus. Der Desktop-Release entsteht aus einem Tag `v0.1.X` über GitHub Actions: macOS arm64 und x64 (signiert, notarisiert), Windows x64 (Azure Artifact Signing, `docs/WINDOWS_CODESIGNING.md`), OTA-Updates über den integrierten Updater.

## Sicherheit und Datenschutz

- Schlüssel und Tokens liegen im Schlüsselbund des Betriebssystems; eigene KI-Schlüssel überschreiten nie die Grenze zur Oberfläche und werden nicht über den Chat gesetzt.
- Hintergrund-Browser sind gehärtet: keine Downloads außer den amtlichen Registerdateien (XML, Gesellschafterlisten als PDF/TIFF, geprüft an den Magic Bytes, nach dem Lesen gelöscht), keine Web-Berechtigungen, Producer nur auf Loopback (`docs/SICHERHEIT_HINTERGRUND_BROWSER.md`).
- Personendaten: Ansprechpartner mit Herkunftsnachweis, Art.-14-Hinweis und Löschfunktion; Aufbewahrungsfristen per Cron; Geburtsdaten aus Gesellschafterlisten nur als Jahr nach außen, intern mit Hash für eine spätere Entfernung. Kontaktangaben sind firmengebunden; abgeleitete Adressen mit fremder Domain lehnt der Gateway ab.
- Server-Instanzen: Kontobindung (nur das gebundene Konto kann sich anmelden), Geheimnisse mit eigenem Schlüssel verschlüsselt, Statusseite nur mit Setup-Token.
- MCP: Anmeldung per OAuth über Keycloak, Opt-in auf zwei Ebenen (Organisation und Nutzer), lesende Werkzeuge als solche gekennzeichnet, Organisationen schalten Werkzeuge einzeln ab.
- Web-Konsole und AVA-App: Zugriffstoken bleiben serverseitig im BFF, Weiterleitung an den Gateway nur über eine Freigabeliste mit Ursprungsprüfung.
- Entwurfs-Postfach: AVA schreibt nur in den Entwürfe-Ordner und liest keine Mails; das Passwort liegt verschlüsselt in der AVA und wird nur in den Einstellungen eingegeben.
- Alle Ausgaben von Modellen und externen Quellen werden vor der Übernahme gegen Schemata geprüft (Yup). „Lieber keine Daten als falsche Daten“ ist Regel, nicht Ausnahme.
- Compliance- und Enterprise-Stand mit offenen Punkten: `docs/PLAN_ENTERPRISE_FREIGABE.md`.

## Installation

Vorgefertigte Builds: [Releases](https://github.com/eproX-GmbH/ava-releases/releases) oder über [ava.bi](https://ava.bi).

1. Installationspaket der Plattform laden (macOS `.dmg`, Windows `.exe`).
2. Installieren und starten, mit Konto anmelden oder registrieren.
3. Beim ersten Start KI wählen: lokales Modell laden oder eigenen Schlüssel hinterlegen. Der Einrichtungsassistent führt durch.
4. Updates kommen danach automatisch (OTA).

## Repository-Layout

```
ava-services/
├── services/
│   ├── desktop/             # AVA: Electron-App (Main/Preload/Renderer), Kern (src/core), Server-Einstieg (src/server), Chat-Agent, Tools
│   └── db-gateway/          # Cloud-Gateway: Auth, Policy, Persist-Bus, Kopf-Relais, MCP, App-Kanal, Register-Queue
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
├── infra/                   # Fly-Konfigurationen, Keycloak-Skripte
├── scripts/                 # vendor-sync, Drift-Prüfung, Server-Instanzen anlegen/aktualisieren
└── docs/                    # Entscheidungen, Pläne, Tools-Referenz, Sicherheit
```

AVA-App (`app.ava.bi`) und Web-Konsole (`admin.ava.bi`) liegen in eigenen, privaten Repositories.

## Entwicklung

```bash
git clone --recurse-submodules https://github.com/eproX-GmbH/ava-services.git
cd ava-services && pnpm install          # Workspace: desktop, gateway, packages, Producer
cd services/desktop
pnpm dev                                  # App mit Hot-Reload
npm run build:typecheck                   # Typecheck, regeneriert docs/TOOLS.md, prüft deutsche UI-Texte
npm run test:suggestions                  # Vorschlags-Chips
npm run test:email-muster                 # E-Mail-Muster
npm run test:mail-entwurf                 # Mail-Entwürfe, Entwurfs-Postfach, feste Anhänge
npm run build:server                      # AVA als Server-Instanz (out/server)
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
- [`AZURE_OPENAI.md`](./docs/AZURE_OPENAI.md): Azure OpenAI als Variante von OpenAI
- Feature-Pläne mit Stand: [`PLAN_AVA_CLOUD.md`](./docs/PLAN_AVA_CLOUD.md) (Server-Instanzen, Kopf-Relais), [`PLAN_MCP_OEFFNUNG.md`](./docs/PLAN_MCP_OEFFNUNG.md), [`PLAN_APP_PWA.md`](./docs/PLAN_APP_PWA.md), [`PLAN_ADMIN_WEB.md`](./docs/PLAN_ADMIN_WEB.md), [`PLAN_MAIL_ENTWURF.md`](./docs/PLAN_MAIL_ENTWURF.md), [`PLAN_BUYING_CENTER.md`](./docs/PLAN_BUYING_CENTER.md), [`PLAN_KUNDEN.md`](./docs/PLAN_KUNDEN.md), [`PLAN_SPRACHMODUS.md`](./docs/PLAN_SPRACHMODUS.md), [`PLAN_KONZERNABSCHLUSS.md`](./docs/PLAN_KONZERNABSCHLUSS.md), [`PLAN_STAMMDATEN_DELTA.md`](./docs/PLAN_STAMMDATEN_DELTA.md), [`PLAN_INSOLVENZEN.md`](./docs/PLAN_INSOLVENZEN.md), [`PLAN_OESTERREICH.md`](./docs/PLAN_OESTERREICH.md), [`PLAN_UK.md`](./docs/PLAN_UK.md), [`PLAN_VERFLECHTUNGEN.md`](./docs/PLAN_VERFLECHTUNGEN.md), [`PLAN_WORKFLOWS.md`](./docs/PLAN_WORKFLOWS.md), [`PLAN_FIRMEN_DISCOVERY.md`](./docs/PLAN_FIRMEN_DISCOVERY.md), [`PLAN_EMAIL_MUSTER.md`](./docs/PLAN_EMAIL_MUSTER.md), [`PLAN_ABRECHNUNG_SEATS.md`](./docs/PLAN_ABRECHNUNG_SEATS.md), [`PLAN_ENTERPRISE_FREIGABE.md`](./docs/PLAN_ENTERPRISE_FREIGABE.md)

## Lizenz

AVA steht unter der [AVA Source-Available License](./LICENSE) der eproX GmbH. Das ist **keine Open-Source-Lizenz** im Sinne der OSI, sondern eine Source-Available-Lizenz. Kurz zusammengefasst (rechtlich maßgeblich ist allein der Text in `LICENSE`):

- **Erlaubt:** Quellcode lesen, lokal bauen und ausführen, ändern, unentgeltlich forken; Server-Komponenten lokal zum Entwickeln und Testen betreiben; Nutzung im Rahmen des Free-Plans oder eines Bezahlplans laut [AGB](https://www.ava.bi/agb).
- **Nicht erlaubt:** die App über den Free-Plan hinaus selbst betreiben (eigene Gateway-/Worker-Instanz produktiv, fremdes Backend, Umgehen von Plan-/Kontingent-Prüfungen); geschäftliche Nutzung über den Free-Plan hinaus ohne Bezahlplan; kommerzielle Weiterverbreitung (Verkauf, Hosting für Dritte, Einbau in kostenpflichtige Produkte).
- **Beiträge:** Issues und Pull Requests sind ausdrücklich willkommen. Mit dem Einreichen räumst du eproX die in Abschnitt 4 der Lizenz beschriebenen Rechte an deinem Beitrag ein.

Drittkomponenten behalten ihre jeweiligen Lizenzen. Fragen zu Bezahlplänen und kommerzieller Lizenzierung: [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de).

---

_Fragen, Feedback, Bugs:_ [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de)
