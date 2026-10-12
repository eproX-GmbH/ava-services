# Bewertungs-Producer abklemmen (2026-10-12)

## Warum

Der Producer `company-evaluation` (Best Match, Angebotsanalyse, Vergleich) lieferte im
Chat keine brauchbaren Antworten: „Welche Firma passt am besten zu meinem ICP?“ endete
in einem 30–90-Sekunden-Job mit ausweichender Antwort und 200.000 Tokens Werkzeuglärm.
Entscheidung (Joyce, 2026-10-12): Funktionen komplett aus Werkzeugliste, MCP und UI
entfernen, den Producer nicht mehr starten und keine AMQP-Ereignisse mehr dorthin senden.
Danach neu überlegen, wie „beste Firma zu meinem ICP“ gut beantwortet wird.

## Was abgeklemmt ist (v0.1.829)

| Ebene | Änderung |
|---|---|
| Desktop-App | Producer nicht mehr in der Startliste (`core/bootstrap.ts`), nicht mehr gebündelt (`scripts/fetch-producers.mjs`), Release- und Server-Image-Workflows holen das Submodul nicht mehr. |
| Chat-Werkzeuge | `evaluation_*` entfernt (Datei `tools/evaluations.ts` gelöscht), Fähigkeitsgruppe „best_match“ weg, `retry_stage` ohne `companyEvaluation`, Prompt-Abschnitt „Angebot/Ausschreibung“ ersetzt (siehe unten). |
| Stufen | `companyEvaluation` aus `PIPELINE_STAGES`, `FreshnessStage`, Auffrischung, Retry-Tick, Workflow-Katalog (Warten-Knoten), Verarbeitungsstand. |
| UI | Seiten `/transactions/:id/evaluations`, `/evaluations/best-matches/:id`, `/evaluations/chats/:id` gelöscht; Spalte „Bewertung“ in Vorgang, Meine Firmen, Firmenansicht, Verarbeitungs-Feed und Diagnose entfernt. |
| Gateway | `PROGRESS_PRODUCER_NAMES` ohne `company-evaluation` (kein Seed, keine Matrix-Spalte, kein Warten beim Vorgangsabschluss), Pipeline-Antwort ohne `companyEvaluation`, Retry-Enum und Fan-out entfernt. Die Routen `/v1/evaluations/*` und der Persist-Konsument bleiben ruhend (keine Aufrufer). |
| master-data | Kein `transaction.createCompanyEvaluation`-Ereignis mehr (Import, Firmen-IDs, Excel), `company-evaluation` nicht mehr in den Retry-Diensten, Routing-Key nicht mehr gebunden. |
| Producer | In structured-content, website, company-profile, company-contact, company-publication sind die `evaluation.*`-Veröffentlicher No-ops (keine Verbindung, keine Queue `upsert-company-evaluation-*`). Ohne Konsument wären die Queues sonst unbegrenzt gewachsen. |

Nicht angefasst: das Submodul `company-evaluation` selbst (Code bleibt im Repo, wird
nirgends gebaut), die Datenbank `ava_company_evaluation`, das Pflichtmodell
`embeddinggemma` (wird auch für lokale Einbettungen im Chat genutzt).

Alte `EntityProgress`-Zeilen mit `producer = 'company-evaluation'` bleiben stehen; der
Fortschritt (`/fortschritt`) übersprang sie schon vorher, die Matrix listet sie nicht mehr.

## Übergangsregel im Chat

Bis es eine neue Antwort gibt, sagt der Prompt: Es gibt kein Bewertungswerkzeug; bei
„welche Firma passt zu meinem ICP“ liest AVA `icp_get`, nimmt die Kandidaten aus Meine
Firmen und `company_get` (profil, register, publikationen), wägt selbst ab und nennt eine
kurze Rangliste mit Begründung aus den gelesenen Daten. Keine erfundenen Scores, keine
angekündigte „laufende Analyse“.

## Offen: „Welche Firma passt am besten zu meinem ICP?“ richtig beantworten

Vorschlag zur Diskussion (noch nicht umgesetzt):

1. **Daten statt Embedding-Job.** Der Bestand des Nutzers ist klein (Dutzende bis wenige
   Tausend Firmen). Statt Vektorsuche: ein deterministischer Vorfilter im Gateway über
   die schon vorhandenen Felder (Branche/NACE aus dem Profil, Ort/Region, Mitarbeiter und
   Umsatz aus den Jahresabschlüssen, Rechtsform, Status), gespeist aus dem ICP
   (`branchen`, `orte`, `groesse`). Ergebnis: eine Kandidatenliste mit den rohen Werten.
2. **Ein KI-Urteil je Kandidat, lokal.** Für die 10–20 Vorfilter-Treffer je ein kurzes
   Urteil (Modell des Nutzers) gegen die ICP-Beschreibung: passt / passt teilweise /
   passt nicht + ein Satz. Das ist dieselbe Mechanik wie der Radar-ICP-Score
   (`discovery_match_run`), nur auf den eigenen Bestand angewandt — möglichst dieselbe
   Bewertungsfunktion wiederverwenden, damit Radar und Bestand gleich urteilen.
3. **Ein Werkzeug, eine Antwort.** `icp_bestand_abgleich` (Arbeitstitel): liefert die
   Rangliste in einem Aufruf, synchron (wenige Sekunden), mit Begründung je Firma und den
   Belegfeldern. Keine Jobs, kein Polling, keine Seite „Best Match“.
4. **Relevanz-Signale einbeziehen.** Sobald docs/PLAN_RELEVANZ.md (Nähe + Gewicht) lebt,
   fließt das Gewicht als zweiter Faktor ein („passt zum ICP“ und „ist gerade dran“).
5. **Nachrangig:** Angebots-/Ausschreibungs-Abgleich (Freitext statt ICP) über dieselbe
   Mechanik mit dem Angebotstext als Kriterium.

Entscheidung dazu steht aus.
