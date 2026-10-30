# Plan: Stellenanzeigen und Expansionsankündigungen — Schlüssel, Persist, Anzeige

Stand 2026-10-30. Anlass: Joyce testete die Stellen-Verarbeitung (Münstermann GmbH,
ARNSBERG_HRB_5451): 6 Stellen gefunden, nichts sichtbar. Vorgabe: beide Recherchen
(Stellen, Expansion/Ausschreibungen) laufen Standard und Deep auf Rechnung des
Nutzers, nie über den Betreiber-Schlüssel; Ergebnisse liegen im Website-Producer
und seiner Datenbank; Altlasten der Bewertung (company-evaluation) werden präzise
entfernt; die App zeigt beides aus der richtigen Quelle mit sauberer Oberfläche.

## 1. Bestandsaufnahme (geprüft 2026-10-30)

### 1.1 Berechnung und Schlüssel (website/src/infrastructure/research/index.ts)

Schlüsselwahl je Feature (`readFeatureConfig`, Z. 64–130) in dieser Reihenfolge:

| # | Pfad | Bedingung | Rechnung |
|---|---|---|---|
| 1 | Gateway-Proxy `/v1/llm/openai` | `RESEARCH_<X>_VIA_GATEWAY=1` | **Organisationsschlüssel** des Tenants (admin.ava.bi); das Log nennt ihn „Organisationsschluessel“. Nicht der Betreiber-Pfad `/llm/betreiber` — den nutzt die Recherche nirgends. |
| 2 | ChatGPT-Abo (Loopback-Token) | `RESEARCH_<X>_VIA_PLAN=1` | Nutzer, nur Standard; Deep wirft Fehler |
| 3 | eigener Schlüssel | `RESEARCH_<X>_API_KEY` + Provider | Nutzer (OpenAI oder Anthropic) |
| 4 | Altlast `OPENAI_API_KEY` | kein TIER gesetzt | Nutzer |

Befund zur Vorgabe „auf Rechnung des Nutzers“:
- Der Desktop schaltet beide Features **automatisch auf Standard über den
  Organisationsschlüssel**, sobald die Organisation einen OpenAI-Schlüssel hat und
  der Nutzer die Einstellung nie angefasst hat (`research/store.ts` `autoEnableFromOrg`,
  Z. 176–191). Bei der quikk-Organisation ist das Joyces Schlüssel — daher wirkt es wie
  „Betreiber-Schlüssel“. Unter Anbieter-Sperre (`providerLock`) wird der
  Organisationsschlüssel sogar erzwungen, auch wenn der Nutzer einen eigenen gewählt hat
  (`resolveFeature`, Z. 449).
- Standard-Stufe nutzt den Recherche-Schlüssel nur für den Scout-Schritt (Responses-API
  mit Websuche, Modell gpt-6-luna); Extraktion und Verfeinerung laufen auf dem
  allgemeinen Producer-LLM (`deps.llm`).
- Deep-Stufe: `o4-mini-deep-research` (oder `RESEARCH_DEEP_MODEL`), nur OpenAI-API,
  nicht über das Abo.
- Risiko Gateway-Pfad: `PRODUCER_GATEWAY_TOKEN` ist ein 15-Minuten-JWT, fest im
  Client-Header; lange Deep-Läufe laufen in 401, der Fehler wird zu `[]` („keine
  Treffer“) verschluckt (`index.ts` Z. 203–207; Pipelines fangen alles, Z. 1154/1247).
- Normalpfad im Compute-Worker nimmt bei fehlendem `RESEARCH_<X>_TIER` „standard“ an,
  die Factory „off/Altlast“ (`compute-worker.ts` Z. 587–662 vs. `index.ts` Z. 112–129).

### 1.2 Persist (heute)

- Der Website-Producer sendet Stellen, Karriereseite und Expansionen als
  `tenant.persist.company-evaluation.v1` (`compute-worker.ts` Z. 705–829, ohne
  llmTier/llmModel).
- Das Gateway schreibt sie in `applyCompanyEvaluation` (`persist-bus.ts` Z. 1759–2115)
  in die **Evaluation-DB** `ava_company_evaluation`: `JobPosting`, `DeepResearch`,
  `CompanyKarriere` — und bei jedem Ereignis eine `EvaluationData`-Elternzeile mit
  `companyName = companyId`. Leere Listen löschen nie (Data-loss-Guard), Altbestand
  bleibt also stehen, auch wenn eine Firma keine Stellen mehr hat.
- Die Bindung lief bis 2026-10-30 hinter dem Tier-Gate; die Frische-Zeile der Stufe
  sperrte jeden weiteren Lauf 30 Tage (Ursache des Münstermann-Befunds). Gate entfernt
  (Commit b039b353).
- Jedes Ereignis schreibt eine `EntityProgress`-Zeile mit `producer='company-evaluation'`
  (Konsument Z. 2522/2532).
- Die **Website-DB** `ava_website` hat die Zieltabellen längst per Prisma-Migration
  (`JobPosting` mit `benefits`, `DeepResearch`, `CompanyKarriere`,
  Migration 20261022120000) — aber auf der Fly-Datenbank sind nur 5 Migrationen
  angewendet, `benefits` und `CompanyKarriere` fehlen dort (geprüft per psql).
  Der Producer läuft beim Nutzer ohne DB, niemand migriert sie.

### 1.3 Leser (heute)

| Leser | Quelle | Befund |
|---|---|---|
| `GET /v1/companies/:id/website` (`companies.ts` Z. 413–443) | seit 30.10. Evaluation-DB (davor Website-DB → „column benefits does not exist“, nie Stellen sichtbar) | `deepResearches` ist **immer `[]`** (Z. 410) — Expansionen erscheinen nirgends |
| `POST /v1/companies/icp-felder` (Z. 930–938) | Website-DB (leer) | ICP-Felder `stellen`/`leistungen` immer leer |
| Neuheiten-Alarm `neueStellen` (`alerts-neuheiten.ts` Z. 193) | seit 30.10. Evaluation-DB | ok |
| `retry-publish.ts` Z. 323–399 | Evaluation-DB | republisht an den abgeklemmten Bewertungs-Producer, tot |

### 1.4 Oberflächen (heute)

- Desktop `CompanyDetail.tsx`: Reiter „Stellenanzeigen“ nur bei ≥ 1 Stelle (Z. 584),
  Karriere-Leistungen ohne Stellen unerreichbar; `DeepResearchStrip` (Z. 897–979,
  „Aktuelle Ereignisse & Signale“) nur bei Daten — also nie. Recherche-Bereich mit
  „Jetzt suchen“/„Deep Research“ je Feature (`RechercheLauf.tsx`), Verlauf per
  `CompanyResearchLauf`.
- Chat: `company_website` liefert das rohe `/website`-JSON; `company_get` hat keinen
  Bereich für Stellen/Expansion; `research_run` startet Läufe.
- app.ava.bi und admin.ava.bi zeigen nichts davon.

### 1.5 Evaluation-DB (ava_company_evaluation, Zeilen und letzte Schreibzeit)

| Tabelle | Zeilen | letzte Schreibung | Status |
|---|---|---|---|
| JobPosting | 347 (90 Firmen) | 2026-10-25 | lebend, Ziel Website-DB |
| DeepResearch | 78 (51 Firmen) | 2026-10-20 | lebend, Ziel Website-DB |
| CompanyKarriere | 1 | 2026-10-25 | lebend, Ziel Website-DB |
| EvaluationData | 1081 | 2026-10-25 | nur noch Elternzeilen-Nebenwirkung |
| KeyFigures/Sales/Profit/Employees/TotalAssets, StateOfAffairs* | 544/…/27.058 | Feb 2026 | tot |
| ManagingDirector, Contact, Employment, Transaction, EntityTransaction | 2129/54/89/44/1603 | Mai 2026 | tot |
| BestMatch*, OfferCluster, MatchFeedback, company_snippets, ChatSession/Turn, ComparisonJob* | … | Feb/Okt 2026 | tot (Routen `/v1/evaluations/*` ohne Aufrufer) |

Gateway-DB: 91 `ContentFreshness`-Zeilen mit `stage='company-evaluation'`,
`EntityProgress`-Zeilen mit `producer='company-evaluation'` (Anzahl in R5 zählen).

Website-DB: `JobPosting` 168 (41 Firmen, Stand 2026-10-10, ohne `benefits`),
`DeepResearch` 101 (26 Firmen, 2026-10-10) — Altbestand aus der Zeit vor dem Umbau.

## 2. Zielbild

1. **Schlüssel:** Recherche läuft auf dem Schlüssel des Nutzers (eigener API-Schlüssel
   oder ChatGPT-Abo). Der Organisationsschlüssel bleibt wählbar, wird aber nie
   automatisch eingeschaltet und unter Anbieter-Sperre nicht mehr stillschweigend
   untergeschoben; der Betreiber-Pfad ist für Recherche ausgeschlossen (heute schon).
   Deep braucht einen API-Schlüssel (Abo kann es nicht); die Oberfläche sagt das.
2. **Persist:** ein eigenes Ereignis `tenant.persist.website-research.v1` vom
   Website-Producer, Bindung unter Producer `website`, Ziel Website-DB
   (`JobPosting`, `DeepResearch`, `CompanyKarriere`). Kein Tier-Gate (Läufe sind
   ausdrücklich angestoßen oder an den Website-Lauf gekoppelt). Semantik: Liste
   vorhanden = Ergebnis eines erfolgreichen Laufs (auch leer → ersetzt alles);
   Liste fehlt = Pipeline nicht gelaufen oder gescheitert → nichts anfassen.
   Erstsichtung je Stelle bleibt erhalten (Titel + Quelle).
3. **Evaluation-Altlasten:** Persist-Konsument, Routen, Ereignis-Builder, Pools,
   Env, Scopes raus; Daten nach Website-DB migriert; Datenbank nach Sicherung
   gelöscht; Frische-/Fortschrittszeilen der Stufe entfernt.
4. **Anzeige:** Desktop liest `/website` (Website-DB): Reiter „Stellenanzeigen“
   (Stellen + Karriere-Leistungen, Reiter auch bei Leistungen ohne Stellen), neuer
   Reiter „Expansion & Ausschreibungen“ (statt Streifen), beide mit Quelle-Links,
   Datum, Art; Chat `company_get` mit Bereichen `stellen` und `expansion`; app.ava.bi
   zeigt beides in der Firmenseite.

## 3. Stufen

| Stufe | Inhalt | Stand |
|---|---|---|
| R1 | Website-Producer: neues Ereignis `tenant.persist.website-research.v1` (Stellen, Karriere, Expansionen, Erfolg/Fehler je Pipeline, `llmTier` weglassen), Compute-Worker Normal- und Manuell-Pfad; `[]` = leeres Ergebnis, fehlende Liste = nicht gelaufen. Alte `company-evaluation`-Veröffentlichung weg, Legacy-`publishEvent` und Proxy-Clients weg, `companyEvaluation.upsertCompanySerp` weg, Retry-Stage `company-evaluation` weg. | 2026-10-30 (website-Submodul, Desktop v0.1.890) |
| R2 | Gateway: `applyWebsiteResearch` auf Website-Pool (Schema sicherstellen: `benefits`, `CompanyKarriere`, da die Fly-Website-DB die Migration 20261022120000 nicht hat), Bindung Producer `website`, Lauf-Abschluss (`laufAbschliessen`) und Fortschritt wie bisher. Leser: `/website` liefert `deepResearches` aus der Website-DB; `icp-felder`, Neuheiten, Vorabanalyse (falls Stellen) auf Website-Pool. `retry-publish` ohne companyEvaluation-Republish. | 2026-10-30 (Gateway-Commit 06467825, Deploy durch Joyce) — Uebergang: `/website` faellt auf die Evaluation-DB zurueck, solange die Website-DB zur Firma nichts hat |
| R3 | Schlüssel: Desktop `autoEnableFromOrg` weg (nur noch eigene Schlüssel/Abo schalten automatisch ein); Anbieter-Sperre erzwingt den Organisationsschlüssel nur, wenn kein eigener vorhanden ist — oder Vorgabe bleibt, dann sichtbar in der Oberfläche; Deep ohne API-Schlüssel sauber abgewiesen mit Hinweis; Compute-Worker-Default `off` wie Factory; Gateway-Pfad: Token pro Aufruf frisch holen statt fest im Header (sonst 401 bei Deep). Einstellungs-Texte: Kostenhinweis je Schlüsselquelle. | 2026-10-30 teilweise (v0.1.890): kein automatisches Einschalten über den Organisationsschlüssel mehr, Texte; Compute-Worker fragt die Factory (`istAktiv`). Offen: Token-Frische beim Gateway-Pfad (Deep läuft in 401, Producer wird vom Desktop beim Token-Wechsel neu gestartet und bricht laufende Deep-Läufe ab) |
| R4 | Anzeige: Desktop Reiter „Stellenanzeigen“ (auch bei Karriere-Leistungen) und „Expansion & Ausschreibungen“ (Karten: Art, Titel, Firma, Land, Datum, Wert, Quelle, Belege), Streifen entfernen; Leerzustände mit Knopf zum Recherche-Lauf; `company_get` Bereiche `stellen`, `expansion`; app.ava.bi Abschnitte. | 2026-10-30 (v0.1.890, app.ava.bi b6d4128) |
| R5 | Migration + Aufräumen: (a) Sicherung `pg_dump ava_company_evaluation` — 2026-10-30 nach ~/ava-sicherungen (55 MB) plus Sicherung der drei Zieltabellen; (b) Kopie in die Website-DB per `scripts/einmalig/recherche-nach-website-db.sh` — 2026-10-30: 358 Stellen/93 Firmen, 117 Expansionen/59 Firmen, 1 Karriereseite; Rückfall im Gateway entfernt; (c) Gateway-Code — 2026-10-30 (Commit f2e6ef14): Routen `/v1/evaluations/*`, `evaluation-writes`, `best-match-jobs`, Schemas, Pool/Upstream/Env, Retry-Republish der Bewertungs-Slices, MCP-Stufe, Keycloak-Scopes; offen: `packages/events` Builder `companyEvaluation` (hängt an den Registry-Versionen 1.1.37–1.1.40 der vier anderen Producer, deren No-op-Publisher ihn noch importieren — eigener Schritt je Producer); der alte Ereignistyp `tenant.persist.company-evaluation.v1` bleibt als Übergang für Desktops < v0.1.890 gebunden; (d) `ContentFreshness` (91) und `EntityProgress` (357) der Stufe löschen — **offen, Freigabe**; (e) Datenbank `ava_company_evaluation` löschen, Fly-App `ava-company-evaluation` prüfen — **offen, Freigabe**; Doku PLAN_BEWERTUNG_ABKLEMMEN nachziehen. | teilweise 2026-10-30 |
| R6 | Live-Test Münstermann + Strategic IT: Standard und Deep je Feature auf eigenem Schlüssel, Anzeige in Desktop, Chat und PWA; Neuheiten-Alarm für neue Stellen. | |

Reihenfolge: R1+R2 zusammen (ein Deploy, ein Release), R4, R3, R5, R6.
Bis R5(b) gelaufen ist, zeigt `/website` übergangsweise beide Quellen zusammengeführt,
damit nichts verschwindet.

## 4. Offene Entscheidungen (Joyce)

1. Organisationsschlüssel: nur noch explizit wählbar (Vorschlag), oder ganz raus?
2. Anbieter-Sperre: darf sie die Recherche weiterhin auf den Organisationsschlüssel
   zwingen? Vorschlag: ja, aber sichtbar im Recherche-Bereich („läuft über den
   Schlüssel der Organisation“), kein automatisches Einschalten.
3. Evaluation-DB löschen (nach Dump) oder nur die lebenden Tabellen leeren?
   Vorschlag: löschen, Dump im Betreiber-Archiv.
