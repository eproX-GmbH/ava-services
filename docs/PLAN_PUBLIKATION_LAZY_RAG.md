# Plan: Publikations-Analyse — Lazy RAG statt Block-für-Block-Extraktion

Stand: 2026-08-27 · Basis: Code-Kartierung company-publication + Gateway +
company-evaluation + Desktop-Agent.

## Befund (was die 1.283 Blöcke heute wirklich tun)

1. **Der Kostenfresser ist genau EINE Schleife.** `processStateOfAffairs`
   ruft `callStateOfAffairs` für JEDEN Block auf — ohne Filter
   (openai/index.ts:590). Die Kennzahlen-Extraktion (`callMetrics`) ist
   bereits auskommentiert; die Mitarbeiter-Suche ist stichwort-gefiltert und
   bricht beim ersten Treffer ab. „1.283 Blöcke" = 1.283 DOM-Absätze +
   Tabellen der Bundesanzeiger-Seite.
2. **Blöcke sind heute flüchtig** — reiner Arbeitsspeicher, nirgendwo
   persistiert. Es gibt sogar ein ungenutztes `Document`-Modell im Schema.
3. **Konsumenten der Extraktion:** CompanyDetail (KPI-Grid + Lagebericht),
   `upsertKeyFigures` → company-evaluation (Best-Match-Snippets),
   Heartbeat-Kandidaten (stateOfAffairs-Text ist DAS Signal für
   Alerts/Watches), Agent-Tool `company_publications`. Ersatzlos streichen
   würde all das leeren — deshalb behält der Lazy-Default ein Minimal-Set.
4. **Embedding-Infrastruktur existiert** (embeddinggemma lokal via Ollama,
   pgvector in company-evaluation). **BM25/Volltext existiert NIRGENDS** —
   kein tsvector im ganzen System. Hybrid-Suche ist Greenfield.

## Architektur-Entscheidung (REVIDIERT v0.1.426): Blöcke + Embeddings ZENTRAL

**Korrektur:** Die ursprüngliche Lokal-Entscheidung (unten, historisch)
war falsch begründet — Jahresabschlüsse sind ÖFFENTLICHE
Bundesanzeiger-Daten, und das AVA-Datenmodell teilt Firmendaten („einer
verarbeitet, alle profitieren"). Blöcke UND Embeddings gehen deshalb als
gebatchte Persist-Events (`tenant.persist.company-publication-blocks.v1`,
100 Blöcke/Event) an das Gateway → Tabelle `PublicationBlock` in
`ava_company_publication` (tsvector german + GIN; Embeddings als REAL[],
768-dim embeddinggemma — lokal beim verarbeitenden Nutzer berechnet).
Replace-Semantik über runId (reihenfolge- und redelivery-sicher).
Kein pgvector/ANN-Index nötig: Suche = BM25 zentral, Vektor-Rerank beim
Suchenden über die Kandidaten.

**Kapazitäts-Hinweis (Operator):** Text + Vektoren ≈ 5–15 MB je Firma.
Der basic-MPG-Cluster hat 10 GB Disk — bei vielen hundert Firmen Disk
beobachten/skalieren.

## Historisch (verworfen): Blöcke bleiben LOKAL

Die Blöcke sind das größte Artefakt im System (3 Publikationen × ~1.300
Blöcke × bis 12k Zeichen). Empfehlung: **lokale PGlite-Datenbank** statt
Cloud-MPG, aus drei Gründen:

1. **Datensouveränität** — kompletter Jahresabschluss-Text verlässt sonst
   die Maschine. „Deine Daten bleiben bei dir" ist ein Produktversprechen.
2. **MPG-Kapazität** — der geteilte Cluster lief eben erst bei 97/100
   Verbindungen; ihn zusätzlich mit dem dicksten Datensatz des Systems zu
   fluten wäre fahrlässig.
3. **AMQP-Event** — das heutige Ein-Event-pro-Firma-Design trägt keine
   ~15 MB Blocktext; Batching wäre Zusatzkomplexität.

Seam dafür existiert schon: Der `postgres-supervisor` serviert PGlite über
das pg-Wire-Protokoll auf `127.0.0.1:54329` — bislang ungenutzt. Der
Producer bekommt eine `BLOCKS_DATABASE_URL` dorthin und schreibt mit dem
normalen pg-Client. Die Agent-Tools lesen dieselbe DB direkt im
Main-Prozess. Kein Gateway, keine neue Infrastruktur.

**Bewusster Trade-off:** Blöcke sind damit nicht auf einem Zweitgerät und
nicht im ES-/Best-Match-Index sichtbar. Akzeptiert — die extrahierten
Kennzahlen (Minimal-Set) fließen weiterhin in die Cloud-Pipeline.

## PB1 — Opt-in-Schalter + schlanker Default

Neuer Modus `AVA_PUBLICATION_ANALYSIS`:
- **`lazy` (neuer Default):**
  - `processStateOfAffairs` läuft NUR noch über gefilterte Blöcke
    (Stichworte: Lagebericht, Geschäftsverlauf, Prognose, Risiken,
    Ertragslage …), gedeckelt auf ~30 Blöcke. Erhält Lagebericht-Panel,
    Heartbeat-Signaltext und `upsertKeyFigures` — zu ~2 % der Kosten.
  - Mitarbeiter-Suche bleibt (ist schon billig).
  - `processKpisFromTables` (Alt-Jahre) entfällt; Tabellen sind ja ab jetzt
    durchsuchbar.
- **`eager` (Opt-in):** exakt heutiges Verhalten.

Plumbing nach dem Research-Features-Muster: JSON-Store unter
`userData/publication/`, IPC + Preload + Settings-Sektion (Modelle-Tab,
unter der Producer-Modell-Wahl), debounced Producer-Neustart bei Änderung.
Infotext erklärt den Unterschied (Kosten vs. Detailtiefe).

## PB2 — Block-Speicher + Embeddings

- Neue lokale DB `publication_blocks` (via postgres-supervisor):
  `block(company_id, publication_id, year, doc_name, source_url, ordinal,
  type text|table, text, tsv tsvector('german'), embedding float4[])`
  + GIN-Index auf tsv.
- Producer: `search()` gibt die (ohnehin vorhandenen) Blöcke mit zurück;
  neuer Schritt schreibt sie per Batch-Insert in die lokale DB und embeddet
  sie via **lokalem Ollama embeddinggemma** (Env wie bei company-evaluation;
  768-dim, roh gespeichert — kein pgvector nötig, Scoring in JS).
- Ersetzt vorherige Blöcke derselben Publikation (Re-Run = Refresh).
- Werksreset: DB liegt unter `pglite/` → wird automatisch mitgelöscht.

## PB3 — Chat-RAG: Hybrid-Suche + Such-Orchestrierung

Zwei neue Agent-Tools (Muster obsidian_search/get):
- `publication_search(companyId, query, year?, topK)` —
  **Hybrid:** BM25 (`websearch_to_tsquery('german')` + `ts_rank_cd`) holt
  Kandidaten, Vektor-Kosinus (Query-Embedding via lokalem embeddinggemma)
  rerankt; RRF-Fusion. Liefert Snippets + Block-IDs.
- `publication_block_get(blockId)` — voller Blocktext (auch Tabellen).

**Such-Orchestrierung** (dein Kernpunkt): Vor der Suche zerlegt ein kleiner
LLM-Aufruf (Muster watch-executor: validiertes Mini-Objekt) die Nutzerfrage
in 3–5 konkrete deutsche Suchqueries („Geht's der Firma gut?" →
„Umsatzentwicklung Vorjahr", „Jahresfehlbetrag Jahresüberschuss",
„Fortführungsprognose Ausblick", „Risikobericht wesentliche Risiken").
Union der Treffer, Rerank, Top-K an den Agenten. Läuft im Tool selbst —
der Chat-Agent ruft einfach `publication_search` mit der Rohfrage auf.

## PB4 — UI/Text

- Settings-Sektion „Publikations-Analyse" (lazy/eager) mit Kosten-Hinweis.
- CompanyDetail: Hinweis im Publikations-Panel, wenn lazy („Details per
  Chat-Frage abrufbar — die Blöcke sind durchsuchbar").

## Kostenrechnung (pro Firma, 3 Publikationen)

| | heute (eager) | lazy |
|---|---|---|
| LLM-Aufrufe | ~1.300–3.900 | ~30–40 (gefiltertes Lagebericht-Set) |
| Embeddings | — | ~3.900 × embeddinggemma, lokal ≈ 0 € |
| Chat-Frage | 0 extra | 1 Query-Zerlegung + 1 Antwort (nur bei Bedarf) |

## Reihenfolge & Aufwand

| Phase | Aufwand | Bemerkung |
|---|---|---|
| PB1 | ~1 Tag | sofortige Kostensenkung, kein neues Storage |
| PB2 | ~1–1,5 Tage | Producer-Submodule + lokale DB |
| PB3 | ~1–1,5 Tage | Tools + Orchestrierung |
| PB4 | ~½ Tag | |

PB1 ist unabhängig auslieferbar und bringt den Großteil der Ersparnis.
