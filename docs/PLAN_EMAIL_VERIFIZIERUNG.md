# Plan: E-Mail-Verifizierung in die Firmenverarbeitung integrieren

Stand 2026-10-11: **umgesetzt V0–V5** (Branch feat/company-email-producer +
feat/company-email-v5, Umsetzungsstand in §8). Baut auf
`docs/PLAN_EMAIL_MUSTER.md` (M1–M4 live seit v0.1.627, Catch-all v0.1.631)
und `docs/PLAN_EMAIL_MUSTER_2.md` (Zuordnung + LLM-Judge, v0.1.771) auf.

Anlass (Operator): Die E-Mail-Verifizierung läuft heute als eigener,
stark gedrosselter Hintergrund-Job *neben* der Pipeline. Das funktioniert,
ist aber entkoppelt vom eigentlichen Verarbeitungsmoment einer Firma.
Besser wäre, die möglichen Adressen der Kundenkontakte **direkt beim
Verarbeiten der Firma** mit herzuleiten und zu verifizieren.

Zwei Fragen soll dieser Plan beantworten:

1. **Contact Producer erweitern** oder **neuer, nachgelagerter Producer**
   nach dem bestehenden Verkettungsmuster? Mit Bewertung der Latenz-
   /Durchsatzwirkung (SMTP-Prüfung kann dauern).
2. Herleitung hunter.io-artig härten: Gängige Formate durchprobieren,
   **einen** Kandidaten je Domain per Zustellbarkeitsprüfung bestätigen,
   das bestätigte Muster auf **alle** Personen derselben Domain anwenden
   (nur hergeleitet + einmal verifiziert, nicht jede Adresse einzeln).

---

## 1. Ist-Analyse

### 1.1 Die sechs Producer und wie sie sich anstoßen

AVA verarbeitet eine Firma mit sechs Producern, die als **lokale
Node-Subprozesse** in der AVA des Nutzers laufen (Desktop oder
Server-Instanz) und über **AMQP** kommunizieren. Compute-Lokalität ist
Invariante (`docs/DECISIONS.md`): LLM- und Web-Abrufe laufen nie in der
Cloud, die Cloud ist nur Substrat (Auth, Persist-Bus, Stammdaten).

Spawn/Registrierung der Producer:
`services/desktop/src/core/bootstrap.ts:750–836` — jeder Producer ist ein
Eintrag `{ name, entry, databaseName, port }` (structured_content,
website, company_profile, company_publication, company_evaluation,
company_contact), gestartet über `ProducerSupervisor`
(`services/desktop/src/main/producer-supervisor.ts`). Jeder Producer
bekommt **eine eigene Datenbank**, eigene Prisma-Migrationen, einen
eigenen Port und einen TCP-Health-Probe (`HEALTH_TIMEOUT_MS = 30_000`,
`producer-supervisor.ts:52`). Absturz-Selbstheilung mit Backoff
(`CRASH_BACKOFF_MS`, `producer-supervisor.ts:67`).

**Start der Verarbeitung** (Orchestrierung, Cloud-seitig in master-data):
`master-data/src/application/data-care/commands/transaktion-starten.ts:99–122`
publiziert je einen Transaktions-Trigger
`transaction.create<Producer>` (`EventBuilder().transaction.createXANDY`)
für structured-content, website, company-profile, company-publication,
company-evaluation, company-contact. Danach je Firma
`publishCompanyProducerTriggers`
(`master-data/src/application/germany/events/services/publish-company-producer-triggers.ts`),
das `germanCompany.upsert` emittiert — laut Kopfkommentar der Fan-out, der
„website / company-profile / -contact / -evaluation downstream" anstößt.

**Verkettung Producer→Producer** („sich gegenseitig anstoßen"): Ein
Producer publiziert am Ende seines Laufs den Trigger für den nächsten.
Beispiel website-Producer
(`website/src/application/integration-events/v1/compute-worker.ts:284–296`):
nach dem eigenen Persist-Event publiziert er
`new EventBuilder().website.upsert` (→ company-profile) **und**
`new EventBuilder().website.upsertCompanyContact` (→ company-contact),
jeweils via `targetUserRoutingKey(...)`.

**Jeder Producer** bindet eine **nutzer-skopierte Queue** an das Exchange
mit Binding-Key `<context>.<operation>`, hört per `getListener(...)`,
verarbeitet und emittiert `tenant.persist.<service>.v1` an das Gateway
(Persist-Bus mit Tier-Gate: Mandant, Modul-Freigabe, Modellqualität;
Rückschritte werden verworfen — „einer verarbeitet, alle profitieren").

### 1.2 Der Contact Producer

`company-contact/src/application/integration-events/v1/compute-worker.ts`
(1028 Zeilen). Kernpunkte:

- Binding: `WEBSITE.CREATECOMPANYCONTACT`
  (`compute-worker.ts:191–201`) — wird also **vom website-Producer**
  angestoßen, nicht direkt aus master-data.
- Basis-Queue `upsert-company-contact`, per `userScopedQueueName`
  nutzer-skopiert (`compute-worker.ts:95–96`).
- Idempotenz-Guard: `laufendeRuns`-Set gegen parallele Doppel-Dispatch
  desselben `runId` (`compute-worker.ts:208`), zweiter Eingang wird
  geackt und verworfen.
- Ablauf: crawlt Website/Impressum (Crawl-Queue, Slug-Priorität),
  extrahiert Firmenfakten und Personen-Kandidaten per LLM, emittiert
  `tenant.persist.company-contact.v1`-Events (`emitPersist`,
  `compute-worker.ts:213–249`), meldet Fortschritt via
  `publishTransactionProgress` (in_progress/completed/skipped/failed).
- **Wichtig:** Der Contact Producer **triggert heute keinen weiteren
  Producer** (kein `createCompany…`-Publish in der Datei). Für das
  Verkettungsthema ist er derzeit ein Blatt.
- Wiederholung je Stufe: `retry-stage-command.ts` (Pause/Löschen/
  Wiederholen je Firma×Stufe, in der Status-Matrix sichtbar).

### 1.3 Wie die E-Mail-Verifizierung heute läuft („parallel, gedrosselt")

Die Verifizierung ist **nicht Teil der Producer-Pipeline**. Sie ist ein
eigener Supervisor im Desktop-Hauptprozess:
`services/desktop/src/main/contacts/email-muster/supervisor.ts` (541 Z.).

Drosselung/Takt (`supervisor.ts:25–35`):

| Konstante | Wert | Bedeutung |
|---|---|---|
| `TICK_MS` | 15 min | ein Tick alle 15 Minuten |
| `FIRST_TICK_MS` | 5 min | erster Tick nach Start |
| `MAX_FIRMEN_JE_TICK` | 25 | je Tick bis zu 25 Firmen ansehen, um EINE zu prüfen |
| `TAGES_DECKEL` | 50 | max. 50 Prüfungen je Gerät und Tag |
| `DOMAIN_RECHECK_MS` | 30 Tage | Domain danach nicht erneut angefasst |
| `CATCHALL_RECHECK_MS` | 90 Tage | Catch-all-Domains |
| `OFFEN_ABSTAND_MS` / `OFFEN_MAX_VERSUCHE` | 24 h / 3 | Nachprüfung offener Adressen |

Pausiert, wenn LLM beschäftigt (Chat-Turn) oder Akkubetrieb
(`supervisor.ts:266`). Deckelprüfung `supervisor.ts:269`.

Bausteine (`services/desktop/src/main/contacts/email-muster/`):

- `pattern.ts` (207 Z.) — Funktionsadressen-Filter, Namensnormalisierung,
  **14-Formen-Musterkatalog** (`vorname.nachname`, `v.nachname`,
  `vnachname`, `vorname`, `nachname`, …), Bewertung/Konfidenz. Das ist
  die vorhandene Formatableitung.
- `zuordnung.ts` (259 Z.) — ordnet firmenweite Adressen (pdettlev@,
  patrick@) Personen zu, deterministisch + **LLM-Judge** für den Rest;
  wählt bei unklarem Muster die Form.
- `domain.ts` (118 Z.) — welche Domain gehört zur Firma (Website →
  Firmenadresse → Alias-Regel). Enthält als Befund-Kommentar genau den
  Fall `joyce@quikk.de` als Negativbeispiel.
- `smtp-verify.ts` (220 Z.) — **die Zustellbarkeitsprüfung** (vom
  Operator „Health-Server" genannt, siehe 1.4).
- `rueckmeldung.ts` (42 Z.) — hängt an `messageFinalized`;
  Unzustellbarkeit → Fakt deaktivieren, Antwort → bestätigen.

Persist/Teilen (Gateway, Cloud):
`services/db-gateway/src/routes/v1/email-patterns.ts`:

- `GET/PUT /v1/email-patterns/{domain}` — Tabelle `EmailPattern`
  (`domain`, `muster`, `konfidenz`, `belege`, `catchAllAt`, `checkedBy`,
  `tenantId`, `vorher`, `stats`). Teilt Muster und Catch-all-Befunde
  mandantenweit, damit andere Nutzer nicht neu ableiten.
- `POST /v1/companies/{id}/contacts/derived-email` — legt je Person Fakt
  + Observation an. `art`: `smtp` (verifiziert), `catchall` (unbestätigt),
  `offen` (unverifiziert), `abgelehnt`. Konfidenz: SMTP 0,9 (zugeordnet
  0,95), Catch-all 0,6/0,75, offen 0,4, abgelehnt 0,2
  (`email-patterns.ts:235–239`). Source `pattern:<art>` bzw.
  `zuordnung:<art>`.
- `POST /v1/email-patterns/feedback` — Bounce/Antwort aus dem Postfach.

### 1.4 Der „Health-Server" / die Zustellbarkeitsprüfung

Im Code gibt es **kein eigenes Bauteil namens „Health-Server"**. Die
einzigen `/health`-Endpunkte sind der Liveness-/Readiness-Check des
Gateways (`services/db-gateway/src/routes/health.ts`, zusätzlich
`/health/persist`) und der TCP-Health-Probe der Producer-Subprozesse
(`producer-supervisor.ts`). Beides ist **nicht** die E-Mail-Prüfung.

Die eigentliche **Zustellbarkeitsprüfung** ist `smtp-verify.ts`, lokal
auf dem Nutzergerät:

- `mxHosts(domain)` (`smtp-verify.ts:23`) — MX-Auflösung, nach Priorität
  sortiert, A-Record-Fallback.
- `pruefeAdressen(...)` (`smtp-verify.ts:119`) — SMTP-Handshake bis
  `RCPT TO` am MX höchster Priorität, STARTTLS wenn angeboten,
  **nie `DATA`**. Ergebnisklassen: `existiert` (250),
  `existiert_nicht` (550/551/553), `catch_all`, `unbekannt` (4xx,
  gehärtete Server). Catch-all-Probe über eine Zufallsadresse
  (`smtp-verify.ts:176`). Höchstens 5 `RCPT TO` je Durchgang.
- `pruefePort25(...)` (`smtp-verify.ts:197`) — Erreichbarkeitstest gegen
  gmail.com/outlook.com, weil viele Nutzernetze ausgehenden Port 25
  sperren.

**Annahme zur Klärung:** Ich lese „Health-Server" als genau diese
SMTP-/Mailbox-Zustellbarkeitsprüfung. Falls der Operator einen *externen*
Dienst oder einen geplanten dedizierten Prüf-Host meint, bitte korrigieren
— im aktuellen Code existiert keiner (ein externer Fallback wurde in
`PLAN_EMAIL_MUSTER.md` §7.1 bewusst abgelehnt).

### 1.5 Zusammenfassung der Lücke

Herleitung + Verifizierung existieren bereits in guter Qualität, laufen
aber **zeitlich entkoppelt** (eigener 15-Minuten-Takt, 50/Tag). Folge:
Nach dem Verarbeiten einer Firma sieht der Nutzer Kontakte **ohne**
abgeleitete Adressen; die erscheinen erst Ticks/Tage später. Die
Datenquellen, die die Herleitung braucht (Website-Domain, Impressum-
Adressen, Personenliste), produziert aber **genau der Contact Producer** —
sie liegen im Verarbeitungsmoment frisch vor und werden ungenutzt gelassen.

---

## 2. Designvergleich: Contact Producer erweitern vs. neuer Producer

### 2.1 Gemeinsame Randbedingung: Latenz der SMTP-Prüfung

Eine SMTP-Prüfung ist langsam und unzuverlässig steuerbar: MX-Auflösung,
TCP-Connect auf Port 25 (oft Timeout, weil gesperrt), Greeting, EHLO,
STARTTLS, `MAIL FROM`, `RCPT TO`, dazu ≥2 s Abstand je `RCPT` und
Greylisting (4xx → Wiederholung). Realistisch **mehrere Sekunden bis zig
Sekunden je Domain**, im Timeout-Fall bis ~30 s. Das ist um Größenordnungen
langsamer als die reine Herleitung (String-Operationen) und schwankt stark.

Genau diese Latenz ist der Grund, warum die Prüfung heute entkoppelt und
gedrosselt ist. Jede Integration muss verhindern, dass sie den
Firmendurchsatz der Pipeline ausbremst.

### 2.2 Variante A — Verifizierung in den Contact Producer aufnehmen

Herleitung + SMTP-Prüfung am Ende des bestehenden
`company-contact`-Laufs, bevor `completed` gemeldet wird.

**Vorteile**

- Daten sind frisch im Prozess (Domain, Impressum-Adressen, Personen) —
  keine zweite Beschaffung, kein zweiter DB-Zugriff.
- Nur ein Producer, ein Deployment, eine Datenbank, eine Status-Zeile.
- Ergebnis erscheint im selben „Kontakte fertig"-Moment.

**Nachteile**

- **Latenz/Durchsatz:** Die langsame SMTP-Prüfung hängt direkt am
  Contact-Durchsatz. Solange `RCPT TO` läuft (oder in Port-25-Timeouts
  steht), ist der Producer für die nächste Firma blockiert bzw. die Stufe
  gilt erst spät als `completed`. Der Nutzer wartet auf „Kontakte fertig",
  obwohl die Kontakte längst da sind.
- **Fehlerisolierung:** Ein SMTP-Hänger/-Fehler landet im selben
  try/catch wie die Kontaktextraktion. Risiko, dass ein Prüf-Timeout die
  ganze Contact-Stufe auf `failed` kippt (obwohl die Kontakte gut sind).
- **Retry:** `retry-stage` würde bei Wiederholung die teure Extraktion
  **und** die Prüfung erneut fahren; beide sind nicht gemeinsam idempotent.
- **Drosselung schwer:** Tages-Deckel/Abstände quer über Firmen hinweg
  sind in einem pro-Firma-Lauf schwer zu halten; der Reputationsschutz
  (max. 5 RCPT/Domain, 50/Tag) müsste in den Producer eingebaut werden und
  kollidiert mit dem Pipeline-Takt.
- **Observability:** Prüf- und Extraktions-Metriken vermischen sich.

### 2.3 Variante B — Neuer nachgelagerter Producer (empfohlen)

Ein neuer Producer `company-email` (Arbeitsname) nach bestehendem Muster.
Der Contact Producer publiziert am Ende seines Laufs — analog zu
`website.upsertCompanyContact` — einen Trigger
`contact.createEmailVerification` (neues `EventTypeOperation`/Payload im
Paket `@ava/event`). Der neue Producer bindet darauf, leitet Muster ab
(bestehende `pattern.ts`/`zuordnung.ts`/`domain.ts` wandern/teilen sich in
ein Paket) und verifiziert per `smtp-verify.ts`, emittiert dann die
vorhandenen Persist-Events (`email-patterns` / `derived-email`).

**Vorteile**

- **Latenz/Durchsatz entkoppelt:** Die langsame Prüfung liegt auf einer
  eigenen Queue und Zeitachse. Der Contact Producer meldet sofort
  `completed`; die E-Mail-Stufe läuft hinterher, ohne den Firmendurchsatz
  zu bremsen. Die Queue puffert Lastspitzen (viele Firmen im Import).
- **Fehlerisolierung:** SMTP-Timeouts/-Fehler bleiben in der E-Mail-Stufe;
  Kontakte sind davon unberührt. Eigene `failed`/`skipped`-Semantik.
- **Retry:** `retry-stage` kann die E-Mail-Stufe allein wiederholen, ohne
  Website-Crawl/Extraktion erneut zu zahlen. Idempotenz über denselben
  `runId`-Guard wie in den anderen Producern.
- **Drosselung natürlich:** Deckel/Abstände/Reputationsschutz leben an
  einer Stelle und über alle Firmen hinweg (Queue-Prefetch=1,
  Token-Bucket), ohne den Pipeline-Takt zu stören.
- **Observability:** Eigene Status-Zeile in der Producer-Matrix
  (Pause/Löschen/Wiederholen je Firma), eigene Logs/Screenshots-losigkeit,
  eigene Metriken.
- Passt sauber ins Fan-out-Muster und ins Tier-Gate.

**Nachteile**

- **Mehr Infrastruktur:** neuer Spawn-Eintrag in
  `bootstrap.ts`, eigene Datenbank + Prisma-Migrationen, gebündeltes
  `dist/` + `node_modules` unter `resources/producers/company-email/`,
  AMQP-Wiring, neues Event-Paket-Payload, Port, Health-Probe.
- **Mehr RAM/Prozesse** auf schwachen Geräten (ein weiterer
  Node-Subprozess). Mindern lässt sich das, indem der Producer ohne
  anstehende Arbeit idle bleibt (er wird nur durch den Trigger aktiv).
- Code-Verschiebung: die heutige Logik im Desktop-Hauptprozess muss in
  ein geteiltes Paket, damit Producer **und** der bestehende
  Hintergrund-Job (für Auffrischung/Nachzügler) sie nutzen.

### 2.4 Empfehlung

**Variante B (neuer, nachgelagerter Producer `company-email`), angestoßen
vom Contact Producer nach dem bestehenden Verkettungsmuster.**

Begründung: Der entscheidende Faktor ist die **hohe, schwankende Latenz
der SMTP-Prüfung**. In Variante A hängt diese Latenz direkt am
Firmendurchsatz und vermischt eine zuverlässige, schnelle Stufe
(Kontaktextraktion) mit einer langsamen, netzabhängigen, oft
fehlschlagenden Stufe (Zustellbarkeit über Port 25). Die
Architektur trennt solche Stufen bereits bewusst über AMQP-Queues; die
Verifizierung gehört genau dort hin. Fehlerisolierung, selektives Retry,
zentrale Drosselung und eine eigene Status-Zeile folgen gratis aus dem
vorhandenen Muster. Der Preis — ein weiterer Subprozess und etwas Boilerplate
— ist einmalig und durch die Producer-Vorlage (`node-microservice-template`)
gut abgedeckt.

Der bestehende, gedrosselte Hintergrund-Supervisor **bleibt** — aber in
neuer Rolle: nicht mehr Haupttreiber, sondern Nachzügler für Firmen, die
beim Live-Lauf nicht prüfbar waren (Port 25 gesperrt, 4xx, Deckel
erreicht, offene Adressen), und für die periodische Auffrischung. So
profitiert der frische Verarbeitungsmoment vom Live-Lauf, ohne die
Reputations-/Netz-Fallstricke zu verlieren, die der Hintergrund-Job
bereits sauber behandelt.

### 2.5 Kurzbewertung

| Kriterium | A: Contact erweitern | B: Neuer Producer |
|---|---|---|
| Latenz auf Firmendurchsatz | hoch (koppelt) | niedrig (entkoppelt) |
| Fehlerisolierung | schwach | stark |
| Selektives Retry | nein | ja |
| Drosselung/Reputation | schwer | natürlich |
| Observability | vermischt | eigen |
| Infrastruktur-Aufwand | gering | mittel (einmalig) |
| Frische des Ergebnisses | sofort | kurz danach |

---

## 3. Konzept: Format-Herleitung + einmalige Verifizierung je Domain (hunter.io-artig)

Vieles ist in `pattern.ts`/`zuordnung.ts` vorhanden. Neu/geschärft:

### 3.1 Ablauf je Firma/Domain

1. **Domain bestimmen** (`domain.ts`): Website → Firmenadresse → Alias-
   Regel. Ohne Domain keine Ableitung.
2. **Belege sammeln:** bekannte Personen-E-Mails der Domain
   (Funktionsadressen ausgeschlossen) + über `zuordnung.ts` den Personen
   zugeordnete Firmenadressen.
3. **Gibt es einen Beleg → Muster ableiten** (`pattern.ts`-Katalog, bei
   Unklarheit LLM-Judge aus `PLAN_EMAIL_MUSTER_2.md` E2). Dieses Muster
   gilt als die Wahrheit der Domain; **keine Format-Ratestufe nötig.**
4. **Kein Beleg → Formate durchprobieren (neu, der hunter.io-Kern):**
   Für **eine** repräsentative Person der Firma Kandidaten nach den
   gängigen Formaten bilden — `vorname.nachname@`, `vorname@`,
   `v.nachname@`, `nachname@` (Reihenfolge nach DACH-B2B-Verbreitung aus
   dem Katalog). Diese Kandidaten nacheinander per `smtp-verify.ts`
   prüfen, **bis einer zustellbar** ist (250). Der Treffer definiert das
   Muster der Domain.
5. **Muster auf alle anwenden:** Für **alle** übrigen Personen der Domain
   die Adresse nach dem gefundenen/bestätigten Muster bilden — **ohne
   Einzelprüfung**. Gespeichert als abgeleitet (`derived-email`) mit
   Baseline-Adresse und Musterquelle.
6. **Stichprobenartiges Härten (optional):** Bei vielen Personen 1–2
   weitere Adressen stichprobenartig prüfen, um das Muster zu härten;
   schlägt die Stichprobe fehl, Muster neu ableiten statt blind anwenden.
7. **Muster + Catch-all teilen:** `PUT /v1/email-patterns/{domain}` →
   andere Nutzer/Mandanten sparen die Prüfung komplett.

### 3.2 Catch-all-Domains

`smtp-verify.ts` erkennt Catch-all über die Zufallsadressen-Probe. Dann
ist **keine** Einzeladresse per SMTP belegbar. Verhalten wie heute
(`PLAN_EMAIL_MUSTER.md` §7b): Muster trotzdem speichern, aber als
`catchall`/„unbestätigt" (gelbes Badge), Konfidenz 0,6/0,75 je Belegzahl.
Ist der Catch-all am Gateway bekannt, entfällt die SMTP-Anfrage ganz.

### 3.3 Fehlerfälle und Zustände

Die am Gateway vorhandenen Arten decken das ab:
`smtp` (verifiziert, 0,9) · `catchall` (unbestätigt) · `offen`
(nicht prüfbar: Port 25 gesperrt / 4xx / gehärtet, 0,4) · `abgelehnt`
(550, 0,2). Eine `offen`/`abgelehnt`-Adresse darf später durch eine
bessere Prüfung ersetzt werden (409 nur bei gefunden/verifiziert).

### 3.4 Rate-Limits und Caching je Domain

- **Je Domain genau eine Verbindung**, höchstens 5 `RCPT TO` je Durchgang,
  ≥2 s Abstand — bereits in `smtp-verify.ts`/Supervisor.
- **Pro Domain einmal prüfen:** Dank „Muster auf alle anwenden" braucht es
  im Normalfall **1 Prüfung je Domain** statt je Person. Das senkt die
  Last drastisch und macht die Live-Integration erst tragbar.
- **Caching:** `EmailPattern` am Gateway ist der geteilte Cache
  (`DOMAIN_RECHECK` 30 d, Catch-all 90 d). Der neue Producer fragt
  **zuerst** das Gateway; liegt ein frisches Muster vor, wird nur
  angewandt, nicht geprüft.
- **Globaler Reputationsschutz:** Token-Bucket (Tages-Deckel) im neuen
  Producer, Prefetch=1 auf der Queue, damit nie mehrere Firmen parallel
  gegen denselben MX laufen.

---

## 4. Umsetzungsschritte / Phasen

| Phase | Inhalt | Aufwand |
|---|---|---|
| **V0 Vorbereitung** | Gemeinsames Paket `packages/email-muster` aus `pattern.ts`, `zuordnung.ts`, `domain.ts`, `smtp-verify.ts` extrahieren, damit Producer und Desktop-Hintergrund-Job dieselbe Logik nutzen. Tests mitnehmen (`test:email-muster`, `test:email-zuordnung`). | 1 Tag |
| **V1 Event-Verkettung** | Neues `EventTypeOperation` `CREATEEMAILVERIFICATION` + Payload in `packages/events`. Contact Producer publiziert am Ende seines Laufs den Trigger (analog `website.upsertCompanyContact`, `company-contact/.../compute-worker.ts`). | 0,5 Tag |
| **V2 Neuer Producer `company-email`** | Auf Basis `node-microservice-template`: AMQP-Binding auf den neuen Trigger, compute-worker (Domain→Belege→Muster/Format-Rate→Prüfung→anwenden), Persist über bestehende Gateway-Routen `email-patterns`/`derived-email`. Eigene DB nur falls lokaler Zustand nötig (sonst zustandslos, Zustand liegt am Gateway). | 2 Tage |
| **V3 Spawn + Drosselung** | Eintrag in `bootstrap.ts` (name/entry/databaseName/port), `producer-supervisor`-Health, Token-Bucket/Tages-Deckel, Prefetch=1, Port-25-Erreichbarkeitstest beim Start. | 1 Tag |
| **V4 Hintergrund-Job umrollen** | Bestehenden `email-muster/supervisor.ts` auf die Nachzügler-/Auffrischungsrolle reduzieren (offene Adressen, Port-25-nachträglich, Deckel-Reste). Doppelverarbeitung mit dem Live-Lauf verhindern (Gateway-Frische respektieren). | 1 Tag |
| **V5 UI/Status + Tests** | E-Mail-Stufe in der Producer-Status-Matrix (Pause/Löschen/Wiederholen), Badges unverändert, Ende-zu-Ende-Test mit einer Firma, Lasttest Import (Durchsatz Contact bleibt unverändert). | 1,5 Tage |

Gesamt ca. **7 Tage**. V0–V2 sind die inhaltliche Substanz, V3–V5 das
Betriebsthema.

---

## 5. Offene Fragen / Entscheidungen fürs Team

1. **„Health-Server":** Meint der Operator die lokale SMTP-Prüfung
   (`smtp-verify.ts`, so hier angenommen) oder einen separaten/externen
   Prüf-Host? Letzterer existiert nicht und wurde in
   `PLAN_EMAIL_MUSTER.md` §7.1 abgelehnt — bleibt das so?
2. **Zustandslos oder eigene DB** für `company-email`? Da Muster/Ergebnisse
   am Gateway liegen, wäre der Producer zustandslos betreibbar (spart DB +
   Migrationen). Nur Drossel-Zähler bräuchten lokalen Zustand (ginge auch
   in-memory je Prozesslauf).
3. **Blocking vs. Fan-and-Forget:** Soll die Transaktion erst als
   „fertig" gelten, wenn auch die E-Mail-Stufe durch ist, oder gilt
   Contact=fertig und E-Mail läuft sichtbar nach? (Empfehlung: nachlaufend,
   eigener Status.)
4. **Live-Deckel vs. Hintergrund-Deckel:** Ein gemeinsamer Tages-Deckel
   (50/Gerät) über Live-Producer und Nachzügler-Job, oder getrennte
   Budgets? (Empfehlung: ein gemeinsames Budget, Reputation ist geräteweit.)
5. **Server-Instanz ohne Port 25:** Auf Fly ist ausgehender Port 25
   standardmäßig gesperrt. Server-Instanzen liefern dann nur `offen`.
   Akzeptiert, oder braucht es dort doch einen externen Fallback?
6. **Stichproben-Härtung:** Wie viele Stichproben je Domain (0, 1, 2) und
   ab welcher Personenzahl? Mehr Stichproben = sicherer, aber mehr Last.
7. **Trigger-Punkt:** Soll der Trigger erst nach `completed` des Contact
   Producers feuern, oder reicht das vorhandene `germanCompany.upsert`-
   Fan-out, das die E-Mail-Stufe parallel zu anderen Stufen startet?

---

## 6. Risiken

- **Port-25-Sperre** in Nutzernetzen und auf Server-Instanzen: Live-Lauf
  liefert dort nur `offen`; der Nachzügler-Job (anderes Netz/später) gleicht
  das aus. Sichtbar statt still (`pruefePort25`).
- **Catch-all** im DACH-Hosting verbreitet → realistische
  Einzel-Verifizierungsquote 40–60 %, Rest als „unbestätigt" mit Muster.
- **Accept-then-bounce:** späterer echter Bounce muss den Fakt
  deaktivieren — `rueckmeldung.ts` deckt das bereits ab.
- **Reputation/Blocklisting** bei zu vielen Prüfungen: 1 Prüfung je Domain
  + Deckel + Abstände halten das klein; der neue Producer darf die Deckel
  nicht umgehen.
- **Doppelverarbeitung** Live-Lauf vs. Hintergrund-Job: Gateway-Frische
  (`EmailPattern.checkedAt`) muss beide koordinieren.

---

## 7. Quellen (Code)

- Orchestrierung: `master-data/.../transaktion-starten.ts:99–122`,
  `master-data/.../publish-company-producer-triggers.ts`
- Verkettung Producer→Producer: `website/.../v1/compute-worker.ts:284–296`,
  `website/src/infrastructure/events/company-contact/upsert-company-contact-event.ts`
- Contact Producer: `company-contact/.../v1/compute-worker.ts`
  (Binding `:191–201`, `emitPersist` `:213–249`, Idempotenz `:208`)
- Producer-Spawn/Health: `services/desktop/src/core/bootstrap.ts:750–836`,
  `services/desktop/src/main/producer-supervisor.ts`
- Event-Typen: `packages/events/src/eventtype.ts`
- Heutige Verifizierung: `services/desktop/src/main/contacts/email-muster/`
  (`supervisor.ts`, `pattern.ts`, `zuordnung.ts`, `domain.ts`,
  `smtp-verify.ts`, `rueckmeldung.ts`)
- Persist/Teilen: `services/db-gateway/src/routes/v1/email-patterns.ts`
- Gateway-Health (nicht die E-Mail-Prüfung):
  `services/db-gateway/src/routes/health.ts`
- Vorgänger-Pläne: `docs/PLAN_EMAIL_MUSTER.md`, `docs/PLAN_EMAIL_MUSTER_2.md`

---

## 8. Umsetzungsstand (2026-10-11)

| Phase | Stand | Wo |
|---|---|---|
| V0 | erledigt | `packages/email-muster` (pattern, zuordnung, domain, smtp-verify, kontakte, budget, **ableitung**); Desktop-Dateien unter `services/desktop/src/main/contacts/email-muster/` sind Re-Exporte |
| V1 | erledigt | `packages/events` (`companyContact.createEmailVerification`, Payload, Builder); Contact Producer sendet den Trigger nach `completed` **und** `skipped` (nicht bei `failed`), von Hand gebaut, weil das Registry-`@ava/event` 1.1.40 den Typ nicht kennt |
| V2 | erledigt | `packages/company-email`: zustandslos, Trigger per AMQP (Prefetch 1), `ermittleFirmenAdressen` (Belege → Muster → **eine** SMTP-Pruefung je Domain → auf alle anwenden), Persist ueber `email-patterns`/`derived-email`, eigene `transaction.progress`-Zeile `company-email` |
| V3 | erledigt | `bootstrap.ts` Registry (`databaseName: null`, Port 51070, `llmOptional`), `fetch-producers.mjs`, gemeinsamer Tages-Deckel (`email-budget.json`), Port-25-Test beim Start und alle 6 h |
| V4 | erledigt | Hintergrund-Job (`supervisor.ts`) ist Nachzuegler: prueft offene Adressen nach und nutzt fuer unversorgte Personen **dieselbe** `ermittleFirmenAdressen`; Domains mit Live-Lauf < 24 h bleiben dem Producer |
| V5 | erledigt | Stufe `companyEmail` in Gateway (`PipelineStage`, `RetryStage`, Seed, `/pipeline`, `/fortschritt`, Firmenmatrix, Retry via neuem Trigger) und Desktop (Matrix-Spalte „E-Mail“, Retry-Formular, Auto-Retry, Resume-Sweep, Workflows `bis`, Chat-Werkzeug `retry_stage`) |

### 8.1 Entscheidungen zu §5

1. „Health-Server“ = lokale SMTP-Pruefung (`smtp-verify.ts`); kein externer Dienst.
2. Zustandslos: `company-email` hat keine Datenbank; Zustand liegt am Gateway, der Deckel in einer Datei.
3. Nachlaufend mit eigenem Status: `companyContact` meldet `completed`, die E-Mail-Stufe laeuft sichtbar danach. Die Stufe zaehlt im Fortschritt des Vorgangs mit; sie endet **immer** terminal (`completed` / `skipped` mit Grund / `failed`).
4. Ein gemeinsamer Tages-Deckel (50/Geraet) fuer Producer und Nachzuegler.
5. Server-Instanzen ohne Port 25 liefern `offen` mit Grund; der Nachzuegler holt in einem anderen Netz nach.
6. Stichprobe: ab 5 unversorgten Personen eine zweite Adresse in derselben Verbindung.
7. Trigger erst nach dem Contact-Lauf (Verkettung), nicht parallel aus dem master-data-Fan-out.

### 8.2 Fehlerbilder und wie sie in der Status-Matrix erscheinen

| Fall | Zelle „E-Mail“ | Grund (errorMessage) |
|---|---|---|
| Ableitung ausgeschaltet (Einstellung oder Feature `kontakte`) | uebersprungen | „E-Mail-Ableitung ist ausgeschaltet …“ |
| keine Domain / alle Personen versorgt | uebersprungen | Zusammenfassung |
| Port 25 gesperrt, Tages-Deckel, 4xx, Greylisting | fertig (Adressen als `offen` mit Hinweis) | – |
| Domain ohne Mailserver (kein MX) | fertig (`offen`, „Domain hat keinen Mailserver“); **kein** `keinFormat`-Befund | – |
| ein Mailserver nicht erreichbar, Port 25 sonst offen | fertig (`offen`, „Mailserver der Domain nicht erreichbar“); keine Netzsperre | – |
| Gateway nicht erreichbar / Kontakte nicht lesbar | fehlgeschlagen | Fehlertext |
| keine einzige Adresse speicherbar | fehlgeschlagen | „… konnten nicht gespeichert werden — <Ursache>“ |
| Contact-Lauf `failed` oder ohne Website nie gelaufen | uebersprungen (abgeleitet, Gateway) | – |

„Erneut versuchen“ an der Zelle sendet nur den Trigger `createEmailVerification` neu (kein Website-Crawl, keine Kontaktextraktion).

### 8.3 Offen

- Server-Instanzen (Fly): Port 25 gesperrt, dort immer `offen` — ein externer Pruefdienst bleibt abgelehnt.
- Lasttest Import (Durchsatz Contact unveraendert) steht aus.

### 8.4 Stand 2026-10-12: kein Deckel, Einzelpruefung, kein Hintergrund-Job (v0.1.814)

Vorgabe des Operators: keine Limits mehr fuer die Verarbeitung von E-Mail-Adressen
(weder fuer kostenlose noch fuer bezahlte Konten), jede abgeleitete Adresse wird
verifiziert und erhaelt bei Erfolg das gruene Badge; der Hintergrund-Job entfaellt,
die Pipeline-Stufe reicht (fehlgeschlagene Stufen stoesst die App selbst wieder an).

| Aenderung | Wo |
|---|---|
| Tages-Deckel entfernt (`TagesBudget`, `email-budget.json`, `AVA_EMAIL_BUDGET_FILE`, `AVA_EMAIL_TAGES_DECKEL`); Entscheidung 4 in §8.1 ist damit hinfaellig. Geblieben: 2 s Abstand je RCPT, 5 Adressen je Verbindung, Prefetch 1. | `packages/email-muster`, `packages/company-email/config.ts`, `bootstrap.ts` |
| **Einzelpruefung** (Schritt 5b in `ableitung.ts`): nach der Muster-Bestaetigung wird jede abgeleitete Adresse, jede zugeordnete Firmenadresse und jede bisher **offene** Ableitung der Firma einzeln per RCPT TO geprueft (Bloecke zu 5, `MAX_DURCHGAENGE` = 4 + 2·MAX_PERSONEN/5). Ergebnis je Adresse: `smtp` (verifiziert, gruen), `abgelehnt`, `offen` (4xx/unbekannt) — Catch-all-Domains und `kein_format` bleiben wie bisher ohne Einzelpruefung. Offene Ableitungen zaehlen jetzt im Live-Lauf als `nachpruefbar`; ein Treffer ersetzt die offene Adresse (409-Lockerung im Gateway). | `packages/email-muster/src/ableitung.ts` |
| Hintergrund-Job entfernt: `supervisor.ts` (Tick, Nachzuegler, Verlauf, Statistik, Domains, Netzstatus) → `dienst.ts` mit Schaltern (`email-muster.json`, liest der Producer weiter), Vorschau und Funktionsadressen-Pruefung. Chat-Werkzeuge `email_muster_verlauf` und `email_muster_jetzt` entfallen; `email_muster_status` zeigt nur die Schalter. Einstellungen → Automatisierungen → E-Mail-Ableitung: nur noch die drei Schalter plus Verweis auf die Status-Matrix. | `services/desktop/src/main/contacts/email-muster/dienst.ts`, `tools/email-muster.ts`, `EmailMusterSection.tsx`, IPC/Preload ohne `runNow`/`verlauf` |
| Badge: unveraendert `AbgeleitetBadge` in `CompanyDetail.tsx` — `pattern:smtp` / `zuordnung:smtp` = „abgeleitet · verifiziert“ (gruen). Durch die Einzelpruefung erreichen jetzt alle Personen einer Firma diesen Stand, sobald die Stufe „E-Mail“ erneut laeuft („neu verarbeiten“ oder `retry_stage companyEmail`). | – |

Risiko, bewusst in Kauf genommen: bei grossen Importen gehen aus dem Nutzernetz
hunderte RCPT TO je Tag an fremde Mailserver (Reputation). Schutz bleibt der
2-s-Abstand und das Abbrechen je Domain bei Sperre/4xx.

### 8.5 Verifizierungsrate je Person (v0.1.815, 2026-10-12)

Statt des Deckels eine **Rate je Stunde**, die die Person selbst einstellt
(nicht die Organisation): `pruefungenJeStunde` in `email-muster.json`
(Einstellungen → Automatisierungen → E-Mail-Ableitung, Chat-Werkzeug
`email_muster_config`). Standard **300** RCPT-TO-Anfragen je Stunde
(Abwaegung: eine Firma mit 20 Personen ist in rund vier Minuten durch, ein
Import mit 100 Firmen in wenigen Stunden; je Mailserver bleiben es nur eine
Handvoll Anfragen mit 2 s Abstand). Grenzen 10–3600. Umsetzung:
`packages/email-muster/src/takt.ts` (`Taktgeber`: **gleichmaessig ueber die
Stunde gestreckt**, kein Burst — bei 300/h alle 12 s eine Anfrage, eine
Verbindung mit 6 Anfragen reserviert 72 s; `warten(n)` wartet statt Adressen
offen zu lassen; Nachtrag v0.1.818 auf Nachfrage des Operators), `AbleitungDeps.takt`, Producer liest die Rate
je Trigger (`einstellungen.ts`) und zieht den Taktgeber nach (`setzeRate`).

### 8.6 Kontakt-E-Mails je Firma, keine Schein-Historie (v0.1.816, 2026-10-12)

Befund (Operator): falsche Ableitungen (`vorname@quikk.de` bei Strategic IT) standen
nach der Bereinigung vom 2026-10-10 noch als "Frühere Angaben" auf der Karte, und
eine Person mit Adressen in mehreren Firmen (joyce@quikk.de bei QUIKK,
joyce.rafflenbeul@strategic-it.de bei Strategic IT) liess sich nicht abbilden:
der 409-Schutz der derived-email-Route sah alle aktiven Adressen der Person
ohne Firmenbezug, und der Eindeutigkeitsschluessel von `Fact` kannte keine Firma.

**Stufe 1 (Gateway, ohne Schema):**
- `GET /companies/{id}/contacts` liefert inaktive Personen-E-Mails/-Telefone nicht
  mehr, wenn sie Ableitungen sind (`pattern:*`/`zuordnung:*`) oder per Bounce,
  Bereinigung oder Zusammenfuehrung deaktiviert wurden; dazu kommt `lastSource`
  je Fakt. Die Karte filtert dieselben Faelle zur Sicherheit nochmals.
- derived-email: der 409-Schutz prueft nur Adressen DIESER Firma.
- Bounce-Rueckmeldung deaktiviert alle Fakten der Adresse (nicht mehr `LIMIT 1`).

**Stufe 2 (Schema `ava_company_contact`, Migration
`company-contact/prisma/migrations/20261012120000_fact_scope_company`):**
- `Fact.scopeCompanyId` (Default `""`) im Schluessel
  `(entityType, entityId, field, normalized, scopeCompanyId)`; fuer Personen-
  Kontakt- und Rollenfakten (`email, phone, jobTitle, department, employmentSince,
  websiteBeschreibung, seniority`) = companyId, sonst `""` (Identitaet, Firmenfakten).
  Bestand: 6.504 Fakten umgeschluesselt, keine Kollision.
- `Fact.deactivatedAt` / `deactivatedReason` (`ersetzt | bounce | ttl | fremde-domain |
  zusammengefuehrt`); die 36 Altfaelle vom 2026-10-10 erhalten `fremde-domain`.
- Gateway (`lib/contact-extraction/scope.ts`): Fakt-Suche, Anlegen, "inaktiv bei
  neuem Wert" und Signal-Dedup je Firmenbezug; Observation-Hash enthaelt den
  Firmenbezug (alte Hashes ohne Bezug bleiben gueltig, es entsteht je Fakt
  hoechstens eine neue Beobachtung); Zusammenfuehrung dedupliziert je Firmenbezug.
- Karte: Badge zeigt den Grund (ersetzt, unzustellbar, nicht mehr gefunden,
  falsche Domain, zusammengeführt) statt pauschal "veraltet".
- Die Migration laeuft NICHT ueber das Gateway (`prisma-company-contact` ist nur
  Spiegel): Ausfuehrung von Hand gegen MPG `ava_company_contact` in einer
  Transaktion samt Eintrag in `_prisma_migrations` (wie `20260511120000`), danach
  Gateway-Deploy. Lokale PGlite-Datenbanken des Producers ziehen sie beim
  naechsten `prisma migrate deploy` nach.

### 8.7 Richtliniensperren erkennen, Kontaktzeile entlastet (v0.1.817, 2026-10-12)

Befund riha WeserGold (Microsoft 365, `*.mail.protection.outlook.com`): ein Lauf
bekam fuer 29 Adressen hintereinander 550, obwohl dieselben Adressen von einem
anderen Host mit 250 bestaetigt werden. Der Server hatte den pruefenden Host per
Richtlinie abgewiesen; der Verifizierer wertete jedes 550 als "existiert nicht".
- `klassifiziereRcpt` (smtp-verify.ts): 55x nur noch "existiert nicht", wenn die
  Antwort ueber die Adresse spricht (5.1.x, Microsoft 5.4.1 "Recipient address
  rejected"); 5.7.x und Texte wie blocked/blacklist/banned/reputation/rate limit
  sind "gesperrt" — die Sitzung endet, die uebrigen Adressen bleiben offen mit
  dem Grund "Mailserver lehnt Pruefanfragen ab (…)". Keine Netzsperre dadurch.
- Antwortzeile des Servers wandert als `smtpAntwort` in den Herkunftstext
  (derived-email, max. 200 Zeichen), damit eine Ablehnung nachvollziehbar ist.
- Bestand riha: 29 Fakten per SQL von `pattern:abgelehnt` auf `pattern:offen`
  (Konfidenz 0,4) mit erklaerendem Herkunftstext gesetzt; sie werden beim
  naechsten Lauf einzeln nachgeprueft.
- Kontaktkarte: Badge der E-Mail-Verifizierung sprengte die Zeile (Adresse brach
  zeichenweise um). Jetzt Wert in Zeile 1, Meta (Badge, Quelle, Zuverlaessigkeit)
  umbrechend darunter; Badges kurz ("abgeleitet · verifiziert / ungeprüft /
  abgelehnt / unbestätigt"), Baseline und Datum nur im Tooltip.
- Nachtrag v0.1.827 (Zimmer Group, 2026-10-12): Ein Befund "kein gaengiges
  Adressformat" wird nur noch 7 Tage gecacht (`KEIN_FORMAT_RECHECK_MS`), nicht 30.
  Ein einziger geblockter Lauf (alle 550) hatte fuer zimmer-group.com einen Monat
  lang jede Ableitung gesperrt; die Domain ist in Wahrheit Catch-all
  (Hornetsecurity, 250 auf alles). Befund im Gateway geloescht, Stufe neu starten.

