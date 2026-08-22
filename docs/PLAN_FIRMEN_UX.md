# Plan: Firmenverarbeitung — Performance, Verwaltung, Logs & Screenshots

Stand: 2026-08-03 · Basis: Code-Kartierung Desktop (`services/desktop`) + Gateway (`services/db-gateway`) + master-data/Producer.

## Befund (wie es heute wirklich funktioniert)

**B1 — Warum ab ~10 Firmen „alles rot" wird.**
Rot = `EntityProgress.state='failed'`. Es gibt zwei Quellen: echte Producer-Fehler
und den Gateway-`stuck-progress-reaper` (kippt `in_progress`-Rows nach 30 Min auf
`failed`, Meldung „Zeitüberschreitung … kein Lebenszeichen"). Beide sind in der UI
**ununterscheidbar**. Die Massen-Rot-Ausfälle kommen vom Reaper: Die geteilte
MPG-DB (basic, 100 Slots, aktuell ~97 belegt, inkl. 2 Fremd-Apps) läuft bei
größeren Importen voll → Gateway-Persists scheitern (`FATAL: remaining connection
slots …`) → Steps bleiben `in_progress` → Reaper färbt alles rot. Lokal ist die
Parallelität schon gedrosselt (AMQP `prefetch(1)` je Producer ⇒ max. 6 Firmen
gleichzeitig); eine Client-Drossel fehlt nicht — die **DB-Kapazität** ist der
Engpass.

**B2 — „Löschen" löscht nichts.**
Der Papierkorb in „Meine Firmen" schreibt nur die companyId in
`localStorage["ava.hiddenCompanies"]`. Kein IPC, kein Gateway-Call. Transaktion +
`EntityProgress`-Rows + master-data bleiben vollständig — daher die „ewig vielen
leeren Transaktionslisten". Es existiert **keine** Delete-/Cleanup-API im Gateway.

**B3 — Pause gibt es nur global.**
`processing-control.ts` pausiert ALLE Producer (Subprozesse werden gestoppt).
Pro Firma gibt es nichts; das Gateway hat keinerlei Cancel-/Hold-Route.

**B4 — Logs sind global, nicht pro Firma.**
`producer-log-buffer.ts` = ein Ring (5000 Zeilen) **pro Producer**, plus globale
Datei je Producer. Die Firmenübersicht zeigt genau diesen Live-Stream. Es gibt
`runId = "<transactionId>:<companyId>"` in den Worker-Logzeilen — aber nur dort
(Selenium/AMQP-Zeilen sind untagged), und nichts wird pro Run persistiert.

**B5 — Screenshots: Bug + fragile Retention.**
- 🐛 **Bug:** `AllCompanies.tsx:480` übergibt `runId={openCompanyId}` (nackte
  companyId) statt `"<tx>:<companyId>"` — der Screenshots-Tab im Drill-Panel der
  Firmenübersicht findet daher **nie** etwas („Keine Screenshots für diesen
  Lauf"). In `TransactionDetail.tsx:530` ist es korrekt.
- Retention: Producer `rm -rf`t das Run-Verzeichnis beim Start desselben Runs;
  Desktop pruned pauschal nach 7 Tagen (nur beim Boot). „Aktuellster Run pro
  Firma bis zur nächsten Verarbeitung" ist nicht garantiert.

**B6 — Es gibt kein Run-Entity.** „Letzter Lauf der Firma X" ist heute nur über
`EntityProgress.updatedAt` bzw. das Matrix-Query ableitbar; die Matrix
(`companies-matrix.ts`) hat die gewinnende `transactionId` bereits im
`DISTINCT ON`-Row, selektiert sie aber nicht.

---

## Plan (Phasen nach Impact/Aufwand)

### P0 — Sofort-Fixes (klein, hoher Nutzen)
1. **Screenshot-runId-Bug** in `AllCompanies.tsx` fixen: `companies-matrix.ts`
   liefert pro Zelle zusätzlich die `transactionId` des Gewinner-Rows (ist im
   Query schon da, nur `SELECT` erweitern) → Drill-Panel baut
   `runId = tx:companyId` korrekt. Damit funktionieren Screenshots + der
   Log-Filter-Seed in der Firmenübersicht erstmals.
2. **Timeout-Rot von Fehler-Rot trennen:** Reaper-Rows sind an der
   `errorMessage` erkennbar („Zeitüberschreitung"). UI zeigt sie als eigenen
   Zustand (⏳ orange „abgebrochen/Timeout" statt rot „fehlgeschlagen") mit
   Tooltip. Nimmt dem Massen-Rot die Panik und macht echte Fehler sichtbar.

### P1 — Kapazität (die eigentliche Ursache von B1)
1. **Infra-Entscheidung** (Operator): MPG-Plan anheben ODER Fremd-DBs
   (`pattern_paradise_prod`, `quikk-demo`, cbj) auf eigenen Cluster. Ohne das
   bleibt jeder größere Import ein Glücksspiel. (Keycloak-Pool 15→6 ist bereits
   umgesetzt; Gateway-Pools sind mit `max:2` je DB schon minimal.)
2. **Reaper resilienter machen:** Beim Reaper-Tick zwischen „Producer meldet
   nichts" und „Gateway kann selbst nicht in die DB" unterscheiden — wenn der
   Tick-eigene DB-Zugriff scheitert, NICHT reapen (heute failt der Tick teils
   mitten im Kippen). Optional: Timeout von 30 auf 45–60 Min für große Importe.
3. **Optional, später:** Persist-Retry mit Backoff im Gateway, wenn der Pool
   `53300`/Slot-Fehler liefert (statt Step hängen zu lassen).

### P2 — Pause/Aussetzen pro Firma (statt Löschen)
Neues Konzept **„Firma pausiert"** (Hold), Ende-zu-Ende:
1. Gateway: Tabelle `CompanyProcessingHold(companyId, heldAt, reason?)` +
   Routen `PUT/DELETE /v1/companies/:id/hold` + Flag im Matrix-Response.
2. Durchsetzen an drei Stellen: (a) master-data
   `publishCompanyProducerTriggers` überspringt gehaltene Firmen vor dem
   Publish; (b) Producer-`compute-worker` prüft den Hold am Anfang (dort gibt es
   bereits den Freshness-Early-Out mit `runId`) und NACKt/skippt; (c)
   `producer-resume.ts` + Retry-Dispatch überspringen gehaltene Firmen.
3. UI: Pause-/Play-Button pro Zeile in „Meine Firmen" (neben dem Papierkorb),
   Status-Badge „pausiert", Filter. Der globale Pause-Toggle bleibt.

### P3 — Echtes Löschen + Transaktions-Aufräumen
1. Gateway: `DELETE /v1/companies/:id` (löscht `EntityProgress`,
   `ContentFreshness`, forwardet an master-data) und
   `DELETE /v1/transactions/:id` (Transaktion + Progress-Rows + Namens-Sidecar).
2. Desktop: Papierkorb ruft die echte API (mit Confirm), löscht zusätzlich
   lokale Screenshot-Ordner `screenshots/<producer>/*:<companyId>/`;
   `ava.hiddenCompanies`-localStorage entfällt (Migration: einmalig anbieten,
   versteckte Firmen echt zu löschen).
3. Vorgänge-Liste: leere Transaktionen (0 verbleibende Firmen) automatisch
   ausblenden + „Aufräumen"-Button (löscht alle leeren).

### P4 — Log-Hierarchie: aktuellster Log der gewählten Firma
1. `producer-log-buffer.ts`: zweiter Index `Map<runId, Zeilen[]>` (Cap ~2000
   Zeilen/Run, LRU über ~50 Runs). Zuordnung über eine „current-runId-Latch":
   Producer loggen beim Run-Start bereits eine runId-Zeile; der Buffer parst
   `runId=<tx>:<cid>` und rechnet alle Folgezeilen dieses Producers dem Run zu,
   bis die nächste runId-Zeile kommt (deckt auch untagged Selenium-Zeilen ab —
   korrekt dank `prefetch(1)`).
2. IPC `producers:logs:tailForRun(producer, runId)` + Push analog heute.
3. UI Drill-Panel: Tabs „Letzter Lauf dieser Firma" (Default, via runId aus P0.1)
   und „Live-Log (alle)". Persistenz über App-Neustart: NICE-to-have via
   `producer-logs/runs/<runId>.log` (Cap + Prune), Phase 2 der Umsetzung.

### P5 — Screenshot-Retention pro Firma
1. Regel: **Neuester Run pro Firma bleibt bis zur nächsten Verarbeitung** —
   Prune wechselt von „7 Tage pauschal" auf „behalte je
   (producer × companyId) nur den neuesten Run-Ordner; alles Ältere erst
   löschen, wenn ein neuerer Run existiert" (+ Alters-Obergrenze 30 Tage als
   Backstop).
2. Producer-seitig: beim `setCurrentRunId` Geschwister-Ordner `*:<companyId>`
   des VORHERIGEN Runs erst NACH erfolgreichem ersten Screenshot des neuen Runs
   entfernen (kein Fenster ohne Screenshots).
3. Prune nicht nur beim Boot, sondern täglich (Timer existiert für Usage schon).

## Reihenfolge & Aufwand (grob)
| Phase | Aufwand | Abhängigkeit |
|---|---|---|
| P0 | ~½ Tag | keine — sofort |
| P1.1 | Operator-Entscheidung | keine |
| P1.2 | ~½ Tag | keine |
| P2 | ~2 Tage (Gateway+master-data+Producer+UI) | Gateway-Deploy |
| P3 | ~1–2 Tage | Gateway-/master-data-Deploy |
| P4 | ~1 Tag | P0.1 |
| P5 | ~½ Tag | keine |

Empfehlung: **P0 + P1.2 sofort**, P1.1 als Infra-Entscheidung parallel, dann
P2 (Pause ist wichtiger als echtes Löschen), P4+P5, zuletzt P3.
