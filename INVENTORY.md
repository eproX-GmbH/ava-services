# AVA Services — Inventory
> Erstellt: 2026-04-21 | Schritt 1 der Cloud→Desktop-Transition  
> Zweck: Vollständige Bestandsaufnahme vor jeglichen Code-Änderungen

## Scope-Entscheidungen (User-Feedback 2026-04-21)

- **`business-intelligence`**: Ausgeschlossen — war nur PoC, wird nicht weiter genutzt.
- **`user-interface`**: Ausgeschlossen — Electron-App wird grundsätzlich neu aufgebaut, das bestehende Next.js-Frontend wird nicht übernommen.
- **Elasticsearch**: Bleibt **managed** bei elastic.co. Kein lokales Bundling nötig. Nutzung nur in `master-data` für Fuzzy-Unternehmenssuche (und `company-evaluation` für Best-Match-Queries — beide nutzen denselben Cluster).
- **Postgres**: Bleibt **vollständig managed** auf fly.io. Keine lokale Postgres-DB in der Desktop-App. Zugriff ausschließlich über Thin DB-Gateway (Option B aus Plan).

**Migrations-Scope somit:** `company-contact`, `company-evaluation`, `company-profile`, `company-publication`, `master-data`, `structured-content`, `website` + `lib/events`.

---

## 1. Root-Level-Struktur

```
ava-services/
├── business-intelligence/      # Python/FastAPI — NICHT Node.js
├── company-contact/            # Node.js, OpenAI light
├── company-evaluation/         # Node.js, OpenAI INTENSIV + Elasticsearch
├── company-profile/            # Node.js, OpenAI initialisiert
├── company-publication/        # Node.js, OpenAI INTENSIV + Selenium
├── master-data/                # Node.js, KEIN OpenAI
├── node-microservice-template/ # Boilerplate-Template
├── structured-content/         # Node.js, KEIN OpenAI
├── user-interface/             # Next.js 14 Frontend
├── website/                    # Node.js, OpenAI v6
├── lib/
│   └── events/                 # @ava/event — Shared RabbitMQ Client
├── package-lock.json           # Leer (kein echter Workspace-Root)
└── scale.sh                    # fly.io Scale-to-Zero-Script
```

**Befund:** Es gibt **keinen echten Workspace-Root**. `package-lock.json` enthält keine Dependencies, keine `package.json` mit `workspaces`-Feld. Jeder Service ist ein vollständig eigenständiges Repo.

---

## 2. Service-Charakterisierung

### 2.1 `business-intelligence` — ACHTUNG: Python-Ausreißer

| | |
|---|---|
| **Stack** | Python 3 + FastAPI |
| **Zweck** | Lokale SQL-Generierung via NL→SQL-Modelle (NSQL, Llama 2) |
| **Modelle** | NSQL-350M, NSQL-2B, NSQL-6B, Llama-2-7B (alle lokal via Hugging Face) |
| **RabbitMQ** | Keines — stand-alone HTTP-Service |
| **OpenAI** | Nicht genutzt — rein lokale Modelle |
| **Externe APIs** | Keine |
| **Besonderheit** | Basiert **nicht** auf dem Node.js-Template. Völlig andere Technologie-Stack. Modelle werden über Volume-Mounts in Docker eingebunden. |

**Implikation für Transition:** Dieser Service passt bereits in das Zielbild (lokal, kein Cloud-AI), muss aber separat behandelt werden — kein Node.js-Migrationspfad anwendbar.

---

### 2.2 `company-contact` — Leichter OpenAI-Nutzer

| | |
|---|---|
| **Package** | `ava-company-contact` |
| **Zweck** | Kontaktdaten (Personen, E-Mails) für Unternehmen extrahieren |
| **OpenAI-SDK** | `openai@^4.48.2` — initialisiert in `di.ts`, leichte Nutzung |
| **OpenAI-Funktionen** | Kontakt-Extraktion aus Webseiten-Inhalten |
| **Embedding** | Nicht genutzt |
| **RabbitMQ** | Konsumiert: Company-Contact-Upsert-Events |
| **Externe APIs** | **ValueSERP** — Websuche für Kontakt-Recherche |
| **Template-Konformität** | Hoch (Awilix, Express, Prisma, Winston, Swagger) |

---

### 2.3 `company-evaluation` — Kritischster Service (OpenAI-Kern)

| | |
|---|---|
| **Package** | `ava-company-evaluation` |
| **Zweck** | Best-Match-Matching, RAG-Chat, Embedding-Clustering, Unternehmens-Evaluierung |
| **OpenAI-SDK** | `openai@^4.67.1` — **1.272 Zeilen** in `infrastructure/openai/index.ts` |
| **OpenAI-Modelle** | `gpt-4o-mini`, `gpt-5-mini` (Chat) · `text-embedding-3-large` (Embeddings) |
| **Embedding-Strategie** | Batch-Embeddings: 96 Items/Batch, 6 parallel (`pLimit`) |
| **Externe APIs** | **Elasticsearch** (`@elastic/elasticsearch@^9.2.0`) |
| **RabbitMQ Konsumiert** | structured-content, company-profile, company-serp, key-figures, deep-research, job-postings, company-contacts |
| **RabbitMQ Produziert** | company-evaluation-transaction |
| **Template-Konformität** | Hoch + starke Erweiterungen |

**OpenAI-Funktionen (alle zu migrieren):**

| Funktion | Modell | Zweck |
|---|---|---|
| `embedBatch()` | text-embedding-3-large | Batch-Embeddings mit Concurrency-Limit |
| `embed()` | text-embedding-3-large | Einzelnes Embedding + Cosine-Similarity |
| `rankCompaniesByQuestion()` | gpt-4o-mini | Ranking nach Freitext-Frage |
| `offerExtraction()` | gpt-5-mini | Job-Offers → Target-Profiles |
| `evaluateBestMatchOfES()` | gpt-5-mini | LLM-Evaluierung von ES-Kandidaten |
| `findBestMatch()` | beide | End-to-End Best-Match-Pipeline |
| `clusterKMeans()` | text-embedding-3-large | K-Means + PCA Visualisierung |
| `startDatasetChat()` | gpt-5-mini | Neue RAG-Chat-Session |
| `continueDatasetChat()` | gpt-5-mini | RAG-Session fortsetzen |
| `chatOverDatasetRag()` | gpt-5-mini | RAG mit Grounded Answers + Citations |
| `decideScopeAction()` | gpt-5-mini | Intelligente Scope-Entscheidung |

**Achtung:** Viele Prompts sind empirisch gefinetunt (Chat, Scope-Entscheidung, Evaluierung). Diese **keinesfalls ohne Rückfrage ändern** — nur Provider-Layer austauschen, Prompts unverändert lassen.

---

### 2.4 `company-profile` — Mittlerer OpenAI-Nutzer

| | |
|---|---|
| **Package** | `ava-company-profile` |
| **Zweck** | Unternehmensprofile verwalten, Keyword-Extraktion |
| **OpenAI-SDK** | `openai@^4.48.2` — initialisiert, moderater Einsatz |
| **OpenAI-Funktionen** | Keyword-Extraktion aus Profil-Texten |
| **Embedding** | Wahrscheinlich (gpt-tokenizer als Dependency: `gpt-tokenizer@^2.1.2`) |
| **RabbitMQ Produziert** | company-profile Upsert-Events |
| **RabbitMQ Konsumiert** | evaluation upsert-keywords |
| **Externe APIs** | Keine direkt (axios vorhanden) |
| **Template-Konformität** | Hoch |

---

### 2.5 `company-publication` — Intensiver OpenAI + Web-Scraping

| | |
|---|---|
| **Package** | `ava-company-publication` |
| **Zweck** | Jahresabschlüsse/Publikationen abrufen, Kennzahlen + Lage extrahieren |
| **OpenAI-SDK** | `openai@^5.20.0` — **532 Zeilen** in `infrastructure/openai/index.ts` |
| **OpenAI-Modelle** | `gpt-4o-mini`, `gpt-5-mini` |
| **RabbitMQ Produziert** | company-publication upsert, key-figures upsert |
| **RabbitMQ Konsumiert** | company-evaluation Events |
| **Externe APIs** | Selenium WebDriver + Chrome-Extension (Custom Headers) |
| **Besonderheiten** | ONNX Runtime (`onnxruntime-node@^1.23.2`) für CAPTCHA-Solving, `sharp` für Image-Processing |
| **Template-Konformität** | Hoch + Web-Scraping-Erweiterungen |

**OpenAI-Funktionen:**

| Funktion | Modell | Zweck |
|---|---|---|
| `callMetrics()` | gpt-4o-mini | Bilanzsumme, Umsatz, Gewinn extrahieren |
| `callEmployees()` | gpt-4o-mini | Mitarbeiterzahl extrahieren |
| `callStateOfAffairs()` | gpt-5-mini | Lage & Ausblick analysieren |
| `processPublicationContent()` | beide | Publikations-Verarbeitungs-Pipeline |
| `processStateOfAffairs()` | gpt-5-mini | State-of-Affairs aus Jahresabschlüssen |

---

### 2.6 `master-data` — Kein OpenAI, Daten-Import-Hub

| | |
|---|---|
| **Package** | `ava-master-data` |
| **Zweck** | Master-Data-Management (Handelsregister-Daten DE), Trigger-Service |
| **OpenAI** | **NICHT GENUTZT** |
| **RabbitMQ Produziert** | Transaction-Events für: company-contact, company-profile, company-publication, company-evaluation, structured-content, website |
| **RabbitMQ Konsumiert** | German-Company Upsert-Events |
| **Externe APIs** | Elasticsearch (`@elastic/elasticsearch@^8.13.1`), Excel-Import (`xlsx`) |
| **Besonderheit** | Ist der **Pipeline-Starter** — nimmt Handelsregister-Einträge auf, triggert alle nachgelagerten Services |
| **Template-Konformität** | Hoch |

---

### 2.7 `structured-content` — Kein OpenAI, XML-Parser

| | |
|---|---|
| **Package** | `ava-structured-content` |
| **Zweck** | XML-Daten (Jahresabschlüsse) zu JSON konvertieren, Streaming |
| **OpenAI** | **NICHT GENUTZT** |
| **RabbitMQ Produziert** | structured-content upsert |
| **RabbitMQ Konsumiert** | company-publication, company-profile, website Events |
| **Externe APIs** | Selenium WebDriver (XML-Quellen abrufen) |
| **Besonderheit** | Streaming-JSON-Parsing (`stream-json`, `stream-chain`) für große XML-Dokumente |
| **Template-Konformität** | Hoch |

---

### 2.8 `user-interface` — Next.js 14 Frontend

| | |
|---|---|
| **Package** | `ava` |
| **Zweck** | React-basiertes Web-Frontend |
| **Stack** | Next.js 14, Redux Toolkit, Material UI (MUI v5), Three.js, i18next |
| **OpenAI** | Nicht direkt — kommuniziert via API mit Backend-Services |
| **Auth** | NextAuth |
| **API-Typen** | Auto-generiert aus Swagger-JSON der Backend-Services |
| **Besonderheit** | Muss in Electron-Transition als Renderer-Process eingebettet werden |
| **Template-Konformität** | N/A (Frontend) |

---

### 2.9 `website` — OpenAI v6, Web-Scraping

| | |
|---|---|
| **Package** | `ava-website` |
| **Zweck** | Website-Daten extrahieren, SERP-Recherche, Job-Postings, Deep-Research |
| **OpenAI-SDK** | `openai@^6.0.0` — **neueste Major-Version** (andere Services: v4/v5) |
| **OpenAI-Funktionen** | Telefonnummern-Extraktion, Website-Content-Analyse |
| **RabbitMQ Produziert** | website upsert, company-serp upsert, job-postings upsert, deep-research upsert |
| **RabbitMQ Konsumiert** | company-profile, company-contact, evaluation Events |
| **Externe APIs** | `google-libphonenumber` (Telefon-Parsing), `cheerio` (HTML-Parsing) |
| **Besonderheit** | Einziger Service mit OpenAI SDK v6 (Breaking Changes gegenüber v4/v5!) |
| **Template-Konformität** | Hoch |

---

## 3. Shared Library: `@ava/event`

**Lokation:** `lib/events/`  
**Aktuelle Version:** `0.0.0` (unveröffentlicht, wird lokal via npm-link / relativer Pfad eingebunden)

### RabbitMQ-Architektur

```
Exchange: Topic Exchange
Pattern:  CloudEvents Standard + Custom Payloads
Prefetch: 1 (sequentielle Verarbeitung)
ACK:      Manuell (NACK bei Fehler)
Reconnect: Exponentiell (1s → 30s max)
```

### Event-Topologie (vollständige Pipeline)

```
[Handelsregister] 
    → master-data
        → TRANSACTION EVENTS →
            ┌─────────────────────────────────────────────────────────┐
            │  company-profile ←→ company-contact                     │
            │  company-publication → structured-content               │
            │  website → company-evaluation                           │
            │  company-evaluation (aggregiert alle obigen)            │
            └─────────────────────────────────────────────────────────┘
```

### Event-Typen

| Context | Operations |
|---|---|
| `germanCompany` | upsert |
| `structuredContent` | upsert, create |
| `website` | upsert, create, serp-upsert, job-postings-upsert, deep-research-upsert |
| `transaction` | create-company-contact/profile/publication/evaluation/website/structured-content |
| `evaluation` | upsert-keywords, upsert-key-figures |
| `companyContact` | upsert |

---

## 4. Node.js-Template-Muster

### Gemeinsame Dateistruktur (alle Node.js-Services)

```
src/
├── application/
│   ├── application-errors/
│   ├── common/
│   │   ├── exceptions/
│   │   ├── filters/
│   │   ├── interfaces/      # Service-Interfaces (IoC)
│   │   ├── mappers/
│   │   └── validators/
│   ├── integration-events/
│   └── transactions/
│       ├── commands/        # CQRS Commands
│       └── queries/         # CQRS Queries
├── domain/
│   ├── entities/
│   └── value-objects/
├── infrastructure/
│   ├── di.ts               # Awilix DI-Container — ZENTRALE DATEI
│   ├── eventbus.ts         # @ava/event Wrapper
│   ├── events/             # RabbitMQ Event Handlers
│   ├── openai/             # OpenAI-Nutzung (in Services mit AI)
│   │   └── index.ts        # Alle AI-Funktionen — MIGRATIONSZIEL
│   ├── repositories/       # Prisma-Repositories
│   ├── auth/
│   ├── logger.ts           # Winston
│   └── metrics.ts          # Prometheus
└── web/
    └── api/
        ├── app.ts          # Express-App
        ├── server.ts       # Entry Point
        └── openapi.json    # Swagger
```

### Gemeinsame Dependencies (alle Node.js-Services)

| Package | Zweck |
|---|---|
| `@ava/auth` | Auth-Middleware |
| `@ava/event` | RabbitMQ-Event-Client |
| `awilix` | Dependency Injection |
| `express` | HTTP-Framework |
| `@prisma/client` / `prisma` | ORM |
| `winston` | Logging |
| `express-prom-bundle` / `prom-client` | Prometheus Metrics |
| `swagger-ui-express` | API-Docs |
| `@leonbrandt/simple-probe` | Health Probes |

### Was zwischen Services divergiert

| Abweichung | Services |
|---|---|
| OpenAI-SDK-Version | company-contact/profile: v4 · company-publication: v5 · website: v6 |
| Elasticsearch-Client | master-data: v8, company-evaluation: v9 |
| Selenium + ONNX | company-publication |
| Streaming-JSON | structured-content |
| Python-Stack | business-intelligence |
| ML-Libraries | company-evaluation (ml-kmeans, ml-pca) |

---

## 5. QUIKK Knowledge Engine — Provider-Abstraktions-Muster

**Relevant als Referenz für AVA-Migration**

### Muster

```typescript
// di.ts — Provider-Factory als Awilix-Dependency
type Dependencies = {
  aiFactory: (organizationId: string) => Promise<OpenAIProvider | MistralProvider>;
  // ...
};

// llm.ts — Nutzung
import { generateText } from "ai";          // Vercel AI SDK
import { OpenAIProvider } from "@ai-sdk/openai";
import { MistralProvider } from "@ai-sdk/mistral";

// Model-String wird separat übergeben, Provider-Objekt ist der Factory-Output
const { text } = await generateText({
  model: ai(llmModel),   // ai = OpenAIProvider | MistralProvider
  prompt: [...],
});
```

### Unterschied zum Blueprint im Planungsdokument

Das QUIKK-Muster gibt **kein fertiges Model-Objekt** zurück, sondern einen **Provider** (callable), dem man den Model-String separat übergibt. Das ist etwas flexibler als der `getLLM()`-Blueprint, der bereits ein fertiges Chat-Modell zurückgibt.

**Empfehlung:** Für AVA das Blueprint-Muster (`getLLM()` gibt fertiges Modell zurück) verwenden — einfacher für die Migrationsschritte und ausreichend für den Use Case.

### QUIKK-Packages (Referenz)

```json
{
  "@ai-sdk/openai": "^2.0.65",
  "@ai-sdk/mistral": "^2.0.24",
  "ai": "^5.0.92"
}
```

---

## 6. Fly.io-Deployment-Topologie

Aus `scale.sh` erkennbar: Alle Hauptservices laufen auf fly.io:

```
fly.io Apps:
- master-data
- website  
- structured-content
- company-publication
- company-profile
- company-evaluation
- company-contact
```

---

## 7. Offene Fragen / Risiken

| # | Befund | Risiko | Priorität |
|---|---|---|---|
| 1 | `company-evaluation` hat 1.272 Zeilen empirisch getunter Prompts und AI-Logik | Größte Migrationsarbeit; Prompts dürfen nicht verändert werden | HOCH |
| 2 | OpenAI SDK divergiert zwischen Services (v4/v5/v6) | Breaking-Changes bei v5→v6; vor Migration klären | MITTEL |
| 3 | Selenium + Chrome-Driver in `company-publication` + `structured-content` | Electron-Bundling von Browser-Driver-Binaries komplex | HOCH |
| 4 | ONNX Runtime in `company-publication` | Native Binary-Dependency; plattformspezifische Binaries nötig | MITTEL |
| 5 | `@ava/event` als lokale unveröffentlichte Lib | Muss in Workspace-Struktur sauber integriert werden | MITTEL |
| 6 | ValueSERP in `company-contact` | Cloud-only API — wie Offline-Verhalten? | NIEDRIG |
| 7 | Elasticsearch bleibt managed (elastic.co) — erfordert Internetverbindung | Offline-Verhalten der Desktop-App klären | NIEDRIG |

---

## 8. Zusammenfassung: OpenAI-Migrations-Scope

| Service | OpenAI-Nutzung | Migrations-Aufwand |
|---|---|---|
| business-intelligence | Nicht genutzt | — |
| company-contact | Leicht (Kontakt-Extraktion) | Klein |
| company-evaluation | **INTENSIV** (Chat, Embedding, Matching, Clustering) | **Groß** |
| company-profile | Mittel (Keyword-Extraktion) | Mittel |
| company-publication | **INTENSIV** (Kennzahlen, Lage-Extraktion) | **Groß** |
| master-data | Nicht genutzt | — |
| structured-content | Nicht genutzt | — |
| user-interface | Nicht direkt | — |
| website | Leicht-mittel (Content-Analyse) | Mittel |

**Empfohlener Pilot-Service für Schritt 3:** `company-contact` — kleinste OpenAI-Oberfläche, klar abgegrenzter Use Case, ideal als Referenz-Migration.

---

*Schritt 1 abgeschlossen. Keine Änderungen an Services vorgenommen.*  
*Nächster Schritt: DECISIONS.md (nach Freigabe durch User)*
