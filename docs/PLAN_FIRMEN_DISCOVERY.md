# Plan: Discovery neuer Firmen („Radar")

Stand: 2026-08-29 · Status: RATIFIZIERT (O1–O5 entschieden, siehe §7)

## 1. Ziel & Kernidee

AVA kann heute nur Firmen verarbeiten, die der Nutzer schon „kennt" (CRM,
Liste, Zuruf). Das Feature „Radar" findet **neue, unbekannte Firmen** im
geografischen Umfeld des Nutzers und meldet nur die, die zum
Idealkundenprofil (ICP) passen.

**Zweistufiger Trichter** (Kostenkontrolle by design):

```
Ortsgraph ──▶ Kandidaten finden ──▶ Mini-Profil (nur Website, billig)
                                          │  zentral geteilt
                                          ▼
                              ICP-Match (lokal, pro Nutzer)
                                          │  Schwellwert
                                          ▼
                        Alert ──▶ Ein-Klick-Import ──▶ volle Pipeline
```

- **Stufe 1 (breit, billig, geteilt):** Kandidaten im Umkreis entdecken,
  pro Firma nur die Website kurz crawlen (3–5 Seiten) und mit dem
  günstigen Producer-Modell ein kompaktes Profil erzeugen. Profil +
  Embedding werden **zentral** gespeichert — einer verarbeitet, alle
  profitieren (Muster: PublicationBlocks).
- **Stufe 2 (selektiv, lokal, privat):** ICP des Nutzers gegen die
  Mini-Profile matchen. Der ICP verlässt die Nutzer-Maschine nicht
  (Embedding-Vergleich lokal, wie beim publication-blocks-Reranking).
  Treffer → Alert mit Begründung → Import startet die normale
  Vollverarbeitung. Erst ab dann existiert die Firma in der Sicht des
  Nutzers.

## 2. Recherche-Ergebnis: was existiert, was fehlt

### Wiederverwendbar (kein Neubau)

| Baustein | Fundort | Nutzung im Radar |
|---|---|---|
| valueserp-Proxy | `services/db-gateway/src/routes/v1/proxy.ts` | Param-Whitelist erlaubt heute schon generische Queries („IT-Dienstleister Hannover"), `search_type: places` liefert Adresse + lat/lon + Rating. Quota, 24h-Cache, Audit fertig. |
| BFS-Website-Crawl | `company-contact/.../compute-worker.ts` | visited-Set, Queue, maxPages, LLM-Extraktion pro Seite — 1:1-Vorbild für den Mini-Profil-Crawl. |
| Zentraler geteilter Korpus | PublicationBlock (`persist-bus.ts`, `companies.ts` search) | Persist-Event → lazy Tabelle mit tsvector(german) + REAL[]-Embedding; BM25 zentral, Vektor-Reranking lokal. Gateway braucht weder Embedder noch ANN-Index. |
| Lazy CREATE TABLE | `lib/company-names.ts`, `lib/company-tombstones.ts` | Neue Tabellen ohne Prisma-Migrationstanz. |
| Dedup gegen Bestand | master-data ES `fuzzySearchCompanyNameAndLocation` | „Kennt AVA die Firma schon?" (Name+Ort, fuzzy). |
| „Ist im CRM?" | `CompanyCrmLink` (Gateway-Prisma) | Tenant-scoped Join-Punkt. |
| Import-Landepunkt | `POST /v1/companies` {name, city} | Ein-Klick-Import → baut 1-Zeilen-xlsx → volle Pipeline. Existiert. |
| Nutzerprofil-Speicher | `agent/profile-store.ts` (userData JSON) | Muster für den ICP-Store. |
| Hintergrund-Scheduler | `link-monitor/supervisor.ts` | Muster für periodische Scans + Audit-Trail. |
| Embeddings lokal | embeddinggemma:latest (768d) via Ollama | Gleiches Modell wie publication-blocks → ein Embedding-Raum. |

### Lücken (Neubau nötig)

1. **Ortsgraph:** Keinerlei Geo-/PLZ-Daten oder Distanz-Utilities im Repo.
2. **ICP-Persistenz:** Kein ICP-Datenmodell; die Welcome-Message stellt
   die ICP-Frage, aber die Antwort landet nirgends strukturiert.
3. **Discovery-Quelle:** Kein Mechanismus, fremde Firmen zu finden.
4. `EvaluationData.latitude/longitude` ist faktisch meist leer (der
   places-Call wurde im Hauptpfad eingespart) — als Geo-Basis unbrauchbar.

### Externe Datenquellen (Recherche 08/2026)

| Quelle | Eignung | Kosten/Risiko |
|---|---|---|
| **OSM Overpass API** | POIs (office/craft/shop/industrial) im Umkreis, mit Name, Adresse, oft Website. Ortsbasiert = exakt unser Zuschnitt. | Kostenlos; Fair-Use (öffentliche Instanzen drosseln); Abdeckung lückenhaft je Branche/Region. Läuft lokal → compute-locality-konform. |
| **valueserp** (im Stack) | Branchen-Queries + `places` je Ort. Gute Abdeckung „sichtbarer" Firmen. | Operator-Key, Kosten pro Query → Quota zwingend; schon vorhanden. |
| **Handelsregister** | Seit DiRUG (08/2022) kostenlos einsehbar, aber **keine offizielle API**. Registerbekanntmachungen (§10 HGB) für Neueintragungen. | Scraping fragil (Captcha-Muster existiert im Repo, aber wartungsintensiv). |
| handelsregister.ai / OpenRegister.de | Kommerzielle HR-APIs inkl. Neueintragungs-Feeds. | Kosten; Operator-Key; **Phase-2-Option** für den Kanal „neu gegründet im Umkreis". |
| OffeneRegister.de | Freier HR-Dump — **eingefroren auf Stand 2019**. | Als Basis unbrauchbar. |
| **OpenPLZ API / Georef-Datensätze** | Gemeinden, PLZ, Verwaltungseinheiten als offene Daten; PLZ-/Orts-Zentroide aus OSM-Derivaten frei verfügbar. | Kostenlos, statisch — ideal als einmaliger Seed für den Ortsgraphen. |

## 3. Architektur-Entscheidungen (Vorschlag)

- **A1 — Ortsgraph = zentrale Zentroid-Tabelle + Radius, kein echter
  Graph.** `GeoPlace(ort, plz, lat, lon, gemeindeschlüssel)` einmalig aus
  offenen Daten geseedet (~12k Gemeinden / ~8k PLZ). „Nachbarorte von
  Hannover" = Haversine-Radius über Zentroide. Deckt Minden (~60 km) und
  Bielefeld (~90 km) über den Radius-Parameter ab. Fahrzeit-Gewichtung
  wäre Graph-Ausbau später — für v1 unnötige Komplexität.
- **A2 — Discovery + Crawl + Profil + Embedding laufen lokal**
  (Compute-Locality-Invariante). Zentral liegen nur: Ortsgraph,
  Discovery-Korpus, Dedup, Quota.
- **A3 — Mini-Profile sind geteilte Stammdaten** (zentral via Gateway,
  PublicationBlock-Muster). ICP, Match-Ergebnisse, Alerts und
  Dismissed-Entscheidungen sind **pro Nutzer** (lokal bzw. user-scoped).
- **A4 — Kein neuer Producer-Prozess für v1.** Der Radar läuft als
  Desktop-Main-Modul (link-monitor-Muster: Supervisor + Store + Audit).
  Begründung: braucht Agent-Nähe (ICP, Alerts, Tools), kein
  Transaction-/EntityProgress-Lebenszyklus, und die Crawl-Helper sind
  importierbar. Ein Producer-Umbau bleibt möglich, wenn Volumen es
  erzwingt.
- **A5 — ICP-Match nutzt das publication-blocks-Suchmuster:** Gateway
  filtert zentral (Geo-Radius + optional BM25-Branchenbegriffe) und gibt
  Profile inkl. Embeddings zurück; Cosine gegen das lokal berechnete
  ICP-Embedding + LLM-Urteil für die Top-K laufen auf der Nutzer-Maschine.
- **A6 — Amtsgericht (`districtCourt`) als zweites Regionssignal.**
  Durch die Registerkonzentration betreut ein Registergericht typischer-
  weise 1–2 Landkreise (Beleg: AG Bad Oeynhausen führt die Register der
  früheren AG-Bezirke Bünde, Herford, Lübbecke, Minden und Rahden — also
  die Kreise Herford + Minden-Lübbecke, ~12.400 HR-Firmen). Nutzung:
  1. **Disambiguierung** mehrdeutiger Ortsnamen: „Neustadt" allein ist
     unbrauchbar, „Neustadt" + zuständiges Gericht pinnt die Region.
  2. **Court→Region-Karte empirisch aus eigenen Daten:** pro
     `districtCourt` die distinct `location`-Werte sammeln, über
     `GeoPlace` geocoden → Zentroid + Ortsmenge je Gerichtsbezirk.
     Kein externes Zuständigkeits-Verzeichnis nötig, selbstpflegend
     (Millionen Zeilen machen die Karte robust; Ausreißer per
     Häufigkeits-Cutoff filtern).
  3. **Vorfilter für die Umkreissuche:** Radius → Menge der
     schneidenden Gerichtsbezirke → indizierter Equality-Filter auf
     `districtCourt`, erst danach Ortsnamen-Matching. Macht die
     Bestandsabfrage über Millionen Freitext-`location`s billig.
  4. **Recall-Fallback:** steht ein `location`-Wert nicht in `GeoPlace`
     (Ortsteil, Schreibvariante), fängt der Gerichtsbezirk die Firma
     trotzdem ein (Zentroid als Näherung, als „unscharf" markiert).
  Grenzen: Granularität variiert je Bundesland (Berlin: ein Gericht für
  die ganze Stadt; teils sehr große Bezirke) → Gericht ist Vorfilter
  und Fallback, nie alleiniger Locator; Sitzverlegungen ändern das
  zuständige Gericht.
- **A8 — Website ist Pflicht; die normierte Kern-Domain ist die
  Discovery-ID** (Zielbild-Schärfung 2026-08-29). Die HRB+Registergericht-
  ID der normalen Verarbeitung liegt bei Places/OSM-Funden nicht
  zuverlässig vor. Deshalb: Firmen OHNE Website werden komplett
  übersprungen; die Website-URL wird normiert (lowercase, ohne www./
  Subdomains/Pfad/Slash → registrierbare Kern-Domain) und ist der
  Primärschlüssel. Quell-Metadaten (Places-Kategorie, Rating, OSM-Tags)
  werden mitgespeichert.
- **A9 — Verarbeitungs-Sperre 6 Monate.** Eine Firma, für die bereits
  ein Mini-Profil erstellt wurde (`profiledAt` gesetzt), wird frühestens
  nach 6 Monaten neu verarbeitet (Website-Crawl etc.); bis dahin wird
  sie beim Scan/Profiling einfach übersprungen. Durchsetzung in Phase 2
  am `profiledAt`-Feld.
- **A10 — Verarbeitung nur auf explizite Nutzer-Entscheidung.** Discovery
  legt NIE selbst eine Vollverarbeitung an. Der Nutzer entscheidet in der
  Kandidaten-Tabelle (Phase 3) per Checkbox: Bulk-Import ODER Ignorieren;
  entschiedene Firmen verschwinden aus der Tabelle (DiscoveryDecision).
- **A7 — Kein Bot-Detection-Bypass.** Für Quell-Websites gilt dieselbe
  Policy wie beim Link-Monitor: Challenges abwarten, nie lösen; Firma bei
  Blockade übersprungen markieren.

## 4. Datenmodell (Gateway, lazy CREATE TABLE)

```sql
-- zentral, geteilt
GeoPlace(placeId PK, name, plz, lat, lon, ags, kind)          -- Seed einmalig
DiscoveredCompany(
  discoveryId PK, name, nameNormalized, city, plz, lat, lon,
  domain UNIQUE NULLS NOT DISTINCT, source,                    -- osm|serp|register
  masterCompanyId NULL,                                        -- Dedup-Treffer gegen GermanCompany
  profileJson JSONB, profileText TEXT, tsv tsvector(german),
  embedding REAL[],                                            -- 768d embeddinggemma
  profiledAt, createdAt, updatedAt
)
-- pro Nutzer
DiscoveryDecision(userId, discoveryId, decision,               -- imported|dismissed
                  reason, decidedAt, PRIMARY KEY(userId, discoveryId))
```

Lokal (userData): `agent/icp.json` (ICP-Store), `discovery/` (Scan-Zustand,
Watermarks, Audit).

**Mini-Profil-Schema** (LLM-Output, yup-validiert):
`{branche, leistungen[], zielkunden, region, groessenIndiz, keywords[], kurzbeschreibung ≤400}`
— Ziel ≤ 200 Tokens Output pro Firma.

## 5. Implementierungsplan

### Phase 0 — Ortsgraph (Fundament)
- Seed-Skript: OpenPLZ/Georef-Daten → `GeoPlace` (einmalig, Operator).
- Gateway-Route `GET /v1/geo/places?near=<ort>&radiusKm=<n>` (Haversine,
  liefert Orte + bbox für Overpass). Zweisegmentiger Pfad beachten
  (Routen-Kollisions-Lektion).
- Desktop: Agent-Tool `geo_places_nearby` als Smoke-Test.
- **Prüfstein:** „Hannover, 60 km" liefert u. a. Minden; „95 km" auch
  Bielefeld. (Gemessen am GeoNames-Seed: Minden/Minden-Lübbecke 57,4 km,
  Bielefeld 91,2 km Luftlinie ab Zentroid.)
- **STATUS: implementiert 2026-08-29** — Seed-Generator
  `services/db-gateway/scripts/build-geo-dataset.mjs`, Datensatz
  `src/data/geo-places.json` (15.050 Zeilen; Großkunden-PLZ per
  leerem accuracy-Feld gefiltert), Lib `lib/geo-places.ts`
  (lazy Seed unter Advisory-Lock, Reseed bei Zeilenzahl-Drift),
  Route `GET /v1/geo/places`, Agent-Tool `geo_places_nearby`.
  Prüfsteine lokal gegen Wegwerf-Postgres verifiziert.

### Phase 1 — Discovery-Scan + zentrale Ablage (MVP sichtbar)
- Gateway: `DiscoveredCompany` + Persist-Handler
  `tenant.persist.company-discovery.v1` + Dedup-Hook (master-data
  fuzzy → `masterCompanyId` setzen).
- Desktop: Scan-Modul, Kanal 1 = **valueserp** über bestehenden Proxy
  (LLM baut aus ICP ~5–10 Branchen-Queries je Ort; `places` für
  Adresse/Koordinaten). Kanal 2 = **OSM Overpass** (bbox aus Phase 0,
  nur Kandidaten mit `website`-Tag priorisieren).
- Agent-Tool `discovery_scan(ort, radiusKm)` — manuell triggerbar, damit
  das MVP ohne Scheduler testbar ist.
- Plan-Limits (per O3): Gateway prüft beim Scan-Start Scans/Tag und
  Kandidaten/Scan je Tenant (Default je Plan, Override je Tenant).
- **Prüfstein:** Scan „Hannover, 30 km" legt zentral Kandidaten an,
  bereits bekannte Firmen sind als solche markiert.
- **STATUS: implementiert 2026-08-29** — Gateway: `lib/discovery.ts`
  (DiscoveredCompany/DiscoveryScan/DiscoveryDecision/DiscoveryQuotaOverride,
  Quota-Gate, Upsert mit COALESCE-Anreicherung),
  `routes/v1/discovery.ts` (scans/candidates, Dedup-Hook = master-data-
  Fuzzy-Dry-Run per Mini-xlsx). Desktop: `discovery/scan.ts`
  (Overpass-Kanal — User-Agent PFLICHT, sonst 406; Behörden/Vereine
  gefiltert — + valueserp-places-Kanal ≤8 Queries, Priorisierung
  Website>Nähe), Tools `discovery_scan`/`discovery_candidates`,
  Bundle „Firmen-Discovery" in meta.ts. Overpass empirisch getestet
  (Hannover 30 km: 800 POIs, 381 mit Website, 6,4 s); Gateway-Lib
  gegen Wegwerf-Postgres verifiziert. Live-Prüfstein steht nach
  Gateway-Deploy + Desktop-Release aus.

### Phase 2 — Mini-Profil + Embedding
- Kurzcrawl je Kandidat (BFS-Muster aus company-contact: Startseite,
  Impressum, Leistungen; maxPages 5, Timeout, robots.txt respektieren).
- Profil mit **Producer-Modell** (billig, konfigurierbar — vorhandene
  Infrastruktur), Embedding lokal via Ollama, Batch-Persist ans Gateway.
- Verarbeitungs-Sperre (A9): `profiledAt` jünger als 6 Monate → Firma
  wird beim Profiling übersprungen, kein Website-Crawl. Erst danach ist
  ein Refresh zulässig.
- **Prüfstein:** ≥ 80 % der Kandidaten mit Website bekommen ein valides
  Profil; Kosten pro 100 Firmen gemessen und im Plan nachgetragen.
- **STATUS: implementiert 2026-08-29** — Desktop `discovery/profiler.ts`
  (Kurzcrawl max 5 Seiten mit robots.txt-Respekt, LLM-Profil per
  yup-validiertem JSON, Embedding via lokalem Ollama), Gateway
  `saveProfile` + `PUT /discovery/candidates/{id}/profile` (A9-Sperre
  SERVERSEITIG, tsv german für Phase-3-BM25), Tool
  `discovery_profile_run` (Default 10, max 25 Firmen/Lauf).
  Neu: `LlmStreamRequest.modelOverride` — Desktop-interne
  Hintergrund-Jobs nutzen das günstige Producer-Modell
  (`getProducerModelOverride`). Verifiziert: Crawl real (drecoll.de
  28,7k / quikk.de 26k Zeichen in ~1 s), saveProfile-Sperre/tsv/
  Refresh-nach-7-Monaten gegen Wegwerf-Postgres, Embedding 768d
  gegen lokale Ollama. LLM-Schritt + 80-%-Quote werden im Live-Lauf
  gemessen.

### Phase 3 — ICP + Match + Alert + Import
- `icp-store.ts` (profile-store-Muster) + Tools `icp_get`/`icp_set`;
  Welcome-Flow schreibt die ICP-Antwort strukturiert hierher.
- Match-Lauf: Gateway-Query (Radius + optional BM25) → lokal Cosine
  gegen ICP-Embedding → Top-K (≈ 20) → LLM-Urteil mit Score + Begründung
  → Schwellwert.
- **Kandidaten-Tabelle als eigener App-Bereich** (Zielbild): alle offenen
  Kandidaten als Tabelle, sortiert nach Match-Score („heiße" Kandidaten
  oben) mit Kurztext, WARUM die Firma zum ICP passt (aus dem LLM-Urteil).
  Checkbox-Auswahl → **Bulk-Import** (`POST /v1/imports/from-list`) ODER
  **Ignorieren**; entschiedene Firmen verschwinden aus der Tabelle
  (DiscoveryDecision) und machen Platz. Match-Score + Begründung sind
  nutzerbezogen (ICP ist privat) und werden lokal bzw. user-scoped
  gehalten, nie im geteilten Bestand. Optional Telegram-Alert für neue
  Top-Kandidaten (Kanal existiert).
- **Prüfstein:** Ende-zu-Ende: Scan → Alert → Import → Firma läuft durch
  die normale Pipeline.
- **STATUS: implementiert 2026-08-29** — ICP: `agent/icp-store.ts`
  (userData/agent/icp.json, privat) + Tools `icp_get`/`icp_set` +
  System-Prompt-Block (ICP-Antwort aus Begrüßung wird gespeichert).
  Match: `discovery/matcher.ts` (Embedding-Vorranking lokal → Top-20 →
  LLM-Urteil in 8er-Batches auf Producer-Modell, Score+Warum-Satz),
  Scores nutzerlokal in `discovery/match-store.ts`. Entscheidungen:
  Gateway `POST /discovery/decisions` + `discovery/decide.ts`
  (Import ZUERST via /imports/from-list — schlägt er fehl, bleibt
  alles offen; Kandidaten ohne Ort werden gemeldet). UI: Route
  `/radar` (Firmen → Radar): Tabelle heißeste zuerst mit Score-Badge +
  Warum-Text, Checkbox-Bulk Import/Ignorieren, Vorgangs-Link nach
  Import, Empty-States mit Chat-Anleitungen. Tools
  `discovery_match_run`/`discovery_decide` (nur auf explizite
  Nutzer-Entscheidung, A10). Gateway-Lib gegen Wegwerf-Postgres
  verifiziert (withProfiles, Decision-Ausblendung pro Nutzer,
  Re-Decision-Upsert). LLM-Match-Qualität + E2E im Live-Lauf.

### Phase 4 — Automatisierung + Lernen (nach Praxis-Feedback)
- Scheduler (täglich/wöchentlich, konfigurierbar; Watermark: nur neue/
  geänderte Profile matchen), Quota-Budget pro Scan.
- Feedback-Loop: Verworfen-Begründungen fließen in den Match-Prompt.
- Kanal 3 „Register-Bestand im Umkreis" (per O5): `GermanCompany`
  (global, HRB-basiert) via Gerichtsbezirks-Vorfilter (A6) +
  Ortsnamen-Matching gegen `GeoPlace` —
  Firmen aus dem master-data-Bestand, die der Nutzer nicht hat und die
  im Radius liegen, wandern in die Kandidatenliste (Website-Ermittlung
  dann via searchAndJudge-Muster).
- **STATUS: implementiert 2026-08-29** — (1) Radar-Automatik:
  `discovery/radar-supervisor.ts` (Opt-in, Default AUS; täglich/
  wöchentlich; Scan→Profile(15)→Match→Alerts kind="radar-match" für
  neue Kandidaten Score ≥ 70, max 5/Lauf, dedupliziert über
  radar-alerted.json; Fanout = Glocke + OS-Push + Telegram), UI-Block
  „Automatik" im Radar inkl. „Jetzt komplett laufen lassen". (2)
  Feedback-Loop: `GET /discovery/dismissals` (Verwerf-Gründe mit Grund,
  pro Nutzer) → fließen in den Match-Judge-Prompt. (3) Kanal 3:
  `GET /discovery/register-candidates` (master-data-Pool auf demselben
  Cluster, Pool-Cap 2; Ausschluss DiscoveredCompany + CompanyNameCache)
  + Desktop-Website-Auflösung per SERP (max 12 Lookups/Scan,
  Verzeichnis-Filter northdata & Co.; Budget mit Branchen-Queries ≤ 20
  < O1-Limit 30); source=register trägt masterCompanyId direkt.
  A6 seit v0.1.459 als **Recall-Fallback** live: Die Court→Region-Karte
  wird empirisch aus den exakten Orts-Treffern abgeleitet (Top-5-Gerichte
  der gematchten Firmen); bleibt die exakte Ausbeute unter dem doppelten
  Limit, füllen Firmen derselben Gerichtsbezirke mit abweichendem
  location-Text auf (Ortsteile, Schreibvarianten wie „Porta
  Westfalica-Barkhausen") — bewusst unscharf, daher nachrangig und auf
  max. 100 Zeilen gedeckelt. Der volle Vorfilter (Karte vorab) bleibt
  Ausbaustufe.
  Verifiziert gegen Wegwerf-Postgres (inkl. Fake-ava_master_data).

## 6. Prozessplan (Betrieb)

1. **Onboarding:** ICP erfassen (Welcome-Flow), Heimat-Ort + Radius
   festlegen (Default 50 km).
2. **Scan-Zyklus** (manuell, später geplant): Kandidaten entdecken →
   Dedup → fehlende Profile crawlen (Budget-Cap pro Lauf, z. B. 100
   Firmen) → persistieren.
3. **Match-Zyklus:** neue Profile gegen ICP → Alerts in Feed (+ Telegram).
4. **Nutzer-Entscheidung:** Import (volle Pipeline) oder Verwerfen.
5. **Pflege:** Profil-Refresh > 6 Monate; Quota-/Kosten-Review über
   ProxyAudit; Ortsgraph-Seed jährlich aktualisieren.

   **GeoNames-Jahres-Refresh (Prozess, seit v0.1.459 überwacht):**
   Das Gateway warnt beim Start per `console.warn`, sobald
   `meta.generatedAt` in `src/data/geo-places.json` älter als ~13 Monate
   ist. Refresh: `cd services/db-gateway && node scripts/build-geo-dataset.mjs`,
   dann `src/data/geo-places.json` committen und deployen — das lazy
   Seeding erkennt die abweichende Zeilenzahl und lädt die GeoPlace-Tabelle
   automatisch neu.

## 7. Entscheidungen (ratifiziert 2026-08-29)

- **O1 — ENTSCHIEDEN:** valueserp-Budget max. 30 Queries/Scan,
  Tages-Cap über bestehende Quota (`ProxyQuotaOverride`).
- **O2 — ENTSCHIEDEN:** Overpass v1 über öffentliche Instanz mit
  Throttle; Wechsel auf eigene Instanz erst bei Volumen.
- **O3 — ENTSCHIEDEN, UMGESETZT v0.1.466:** Radar für **alle Tenants**
  mit Plan-Staffelung, zentral im Gateway erzwungen (`PLAN_DISCOVERY`
  in lib/discovery.ts): free 1 Scan/Woche · 25 km · 1 Gebiet · SERP 8 ·
  Cap 50; starter 1/Tag · 50 km · 2 Gebiete · SERP 20 · Cap 150; pro
  4/Tag · 100 km · 5 Gebiete · SERP 30 · Cap 300. **Erst-Backlog-Scan
  läuft für alle Pläne mit Pro-Parametern und zählt nicht gegen
  Quota/Gebiete** (isInitial-Flag). Desktop: SERP-Budget-Split
  (Planner/Register/Nachschlag, LLM-Planner erst ab Budget ≥12),
  Alert-Politik `policyForTier` (free Top 3/Woche ab Score 75, starter
  10/Tag ab 75, pro sofort ab 65 — Schwelle wird für niedrige Pläne NICHT
  gesenkt: weniger, aber die besten), Automatik-Klammer (free aus,
  6-h-Intervall nur Pro). Mini-Profile bleiben für alle ungedrosselt
  (lokales Compute, geteilter Pool). `DiscoveryQuotaOverride` bleibt
  Operator-Notausgang. Ursprüngliche Planung: Limits zentral im Gateway
  (Muster `ProxyQuotaOverride`/`TenantBilling` — Default je Plan,
  Override je Tenant), Prüfung beim Scan-Start.
- **O4 — ENTSCHIEDEN:** Nur öffentliche Firmendaten; **keine
  Personendaten** im Mini-Profil (dort auch fachlich irrelevant).
- **O5 — ENTSCHIEDEN: keine kommerzielle HR-API.** Grundlage für
  registerbasierte Discovery ist der **master-data-Bestand selbst**:
  die globale `GermanCompany`-Tabelle (HRB-basiert, tenant-agnostisch)
  wird dritter Discovery-Kanal — „Firmen aus dem Register-Bestand im
  Umkreis, die der Nutzer nicht hat". Einschränkung: `location` ist
  Freitext ohne PLZ/Koordinaten → Abgleich über Ortsnamen-Matching
  gegen `GeoPlace` (Phase-4-Kanal, ersetzt den HR-API-Kanal).
