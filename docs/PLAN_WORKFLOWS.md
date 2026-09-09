# Plan: Workflows — Abläufe aus dem Chat speichern, visualisieren, automatisch laufen lassen

Stand: 2026-09-09 · Ausgangslage: Desktop v0.1.582, 225 Agent-Tools in 36 Dateien,
Skills (SKILL.md, Prosa-Anleitungen), Scheduler (nur Mail-Loops und Erinnerungen),
Radar-Automatik, Vollmacht-Stufen (none / additive / mutating), Audit-Trail.

Leitszenario (vom Operator): *„Starte Firmenradar → importiere alle Firmen mit
Score über 80 → identifiziere Firmen im Maschinenbau mit Kassenbestand über
100.000 € → ermittle passenden Ansprechpartner aus dem Vertrieb → formuliere eine
auf das Unternehmen zugeschnittene E-Mail → versende sie an den Vertriebsleiter
oder die allgemeine Kontaktadresse."* Der Nutzer erarbeitet so einen Ablauf im
Chat, sagt „speichere die Schritte als Workflow", lässt ihn regelmäßig laufen und
korrigiert ihn bei Bedarf in einer n8n-artigen Ansicht.

---

## 0. Kurzfassung der Entscheidung

- **Workflows sind gespeicherte, deterministische Tool-Ketten mit Parametern**,
  keine Prosa. Ein Workflow ist JSON (Nodes + Kanten), das der Desktop-Hauptprozess
  ohne LLM-Planung abarbeitet. LLM-Arbeit passiert nur in dafür markierten
  Nodes („KI-Schritt"), mit festem Prompt und Ausgabeschema.
- **Skills bleiben**, decken aber den anderen Fall ab: Wissen und Vorgehen in
  Prosa, das der Agent interpretiert. Workflows sind das Gegenteil: exakt,
  wiederholbar, auditierbar, ohne Interpretationsspielraum.
- **AVA baut Workflows selbst**: aus dem Tool-Call-Trace einer Konversation
  („speicher das als Workflow") oder aus einer Beschreibung („bau mir einen
  Workflow, der …"). Die visuelle Ansicht dient der Kontrolle und kleinen
  Korrekturen, nicht dem Bau von Null.
- **Datenmodell nach n8n**: Nodes, Kanten mit Ausgangs-Index (für Verzweigungen),
  Items-Strom zwischen Nodes (Array von `{ json }`), Expressions zum Verweisen auf
  Vorgänger-Daten, Loop-/If-/Switch-/Merge-Nodes, Trigger-Node, Ausführungen mit
  je Node gespeicherter Ein- und Ausgabe, Pin-Daten zum Testen.
- **Sicherheit über die bestehende Vollmacht**: Schreib-Tools laufen im Workflow
  nur, wenn die Vollmacht-Stufe die Klasse deckt oder der Node explizit als
  „bestätigt" freigegeben wurde. Läuft ein Workflow zeitgesteuert, gibt es keinen
  Dialog; nicht gedeckte Aktionen halten den Lauf an und melden sich.

---

## 1. Was wir von n8n übernehmen und was bewusst nicht

Referenz: n8n-Datenmodell (`INode`, `IConnections`, `INodeExecutionData`),
Dokumentation zu Data Structure, Loop, Fehlerbehandlung, Pin-Daten,
Ausführungsreihenfolge v1.

**Übernehmen**
- **Nodes + Connections.** Jeder Node hat `id`, `name`, `type`, `position`,
  `parameters`; Kanten sind je Node nach Ausgangs-Index gruppiert
  (`connections[nodeName].main[outputIndex] = [{ node, index }]`). Das trägt
  If/Switch (mehrere Ausgänge) und Merge (mehrere Eingänge) ohne Sonderfälle.
- **Items als Datenstrom.** Zwischen Nodes fließt ein Array von Items
  `{ json: {...} }`. Ein Node läuft standardmäßig einmal je Item (implizite
  Schleife); Nodes können auch „einmal für alle Items" laufen. Damit ist
  „importiere alle Firmen mit Score über 80" ein Filter-Node plus ein Tool-Node,
  kein Loop-Node.
- **Expressions.** `{{ $json.score }}`, `{{ $('Firmenradar').item.json.name }}`,
  `{{ $input.all() }}`, `{{ $vars.mindestScore }}`. Sandbox ohne Netzwerk,
  ohne Dateizugriff, mit Zeitlimit.
- **Paired Items.** Jeder Ausgabe-Item merkt sich, aus welchem Eingabe-Item er
  entstand. So kann ein späterer Node auf Felder eines früheren Nodes zugreifen,
  ohne dass jeder Node alles durchreichen muss.
- **Flow-Logik.** If (2 Ausgänge), Switch (n Ausgänge), Merge (Warten auf
  mehrere Zweige), Loop Over Items mit Ausgängen „loop" und „done" für Batches,
  Wait (Zeit), Stop-and-Error, Sub-Workflow.
- **Fehlerverhalten je Node.** `onError: stop | continue | errorOutput`,
  `retryOnFail`, `maxTries`, `waitBetweenTries`.
- **Ausführungen als Objekt.** Jede Ausführung speichert je Node Ein- und
  Ausgabe, Status, Dauer, Fehler; die Ansicht zeigt das am Node („3 Items").
- **Pin-Daten.** Ausgabe eines Nodes einfrieren, damit beim Testen nicht jedes
  Mal der Radar-Scan oder die Mail läuft.
- **Ausführungsreihenfolge v1.** Zweig für Zweig, oben vor unten, links vor
  rechts. Deterministisch und erklärbar.
- **Editor-Erlebnis.** Canvas mit Pan/Zoom, Node-Panel mit Eingabe-Daten links,
  Parametern in der Mitte, Ausgabe rechts; „Schritt ausführen", „Workflow
  testen", Sticky Notes, Undo/Redo, Copy/Paste von Nodes als JSON.

**Nicht übernehmen**
- Kein allgemeiner HTTP-/Code-Node mit freiem JavaScript. Die Nodes sind
  AVA-Tools mit Schema. Ein „Transformieren"-Node deckt Umformungen deklarativ
  ab (Felder wählen, umbenennen, berechnen mit Expressions), ohne Code.
- Keine Credentials im Workflow. Zugänge (CRM, Mail, Apify, KI) kommen aus den
  AVA-Einstellungen; ein Workflow referenziert sie nie direkt. Damit ist ein
  Workflow innerhalb der Organisation teilbar.
- Kein Vue Flow (n8n ist Vue). Im React-Renderer nutzen wir **React Flow
  (`@xyflow/react`)**: gleiche Abstraktionen (Nodes, Edges, Handles, Minimap,
  Controls, Auto-Layout über `dagre`/`elkjs`), MIT-Lizenz, aktiv gepflegt.

---

## 2. Datenmodell

Datei `services/desktop/src/shared/workflow-types.ts` (shared: Main, Preload,
Renderer, Chat-Tools nutzen dieselben Typen; Validierung mit yup im Main).

```ts
export interface WorkflowDefinition {
  id: string;                      // "wf_" + cuid
  name: string;                    // "Maschinenbau-Outreach Herford"
  description: string;
  version: number;                 // hochgezählt bei jeder Änderung
  nodes: WorkflowNode[];
  connections: Record<string, { main: Array<Array<{ node: string; index: number }>> }>;
  variables: Record<string, WorkflowVariable>;   // Parameter des Workflows ($vars)
  trigger: WorkflowTrigger;        // genau einer, ist zugleich Node "Start"
  settings: {
    executionOrder: "v1";
    timeoutMinutes: number;        // Default 60
    maxItemsPerRun: number;        // Default 500 (Kontingent-/Kostenbremse)
    autonomy: "inherit" | "none" | "additive" | "mutating"; // Deckel je Workflow
    errorWorkflowId?: string;
    notifyOnFinish: boolean;       // Meldung unter Meldungen/Telegram
  };
  origin: { kind: "chat" | "assistant" | "manual" | "import"; conversationId?: string };
  createdAt: string; updatedAt: string; createdBy: "user" | "agent";
  pinData?: Record<string, WorkflowItem[]>;
}

export interface WorkflowNode {
  id: string; name: string;        // name eindeutig im Workflow (Expressions verweisen darauf)
  type: WorkflowNodeType;          // "tool" | "trigger" | "if" | "switch" | "loop" | "merge"
                                   // | "transform" | "filter" | "ai" | "wait" | "stop" | "subworkflow" | "note"
  position: [number, number];
  parameters: Record<string, unknown>;  // je type; bei "tool": { tool: "discovery_scan", args: {...} }
  mode: "perItem" | "allItems";    // Default perItem
  disabled?: boolean;
  onError: "stop" | "continue" | "errorOutput";
  retryOnFail?: boolean; maxTries?: number; waitBetweenTriesSec?: number;
  confirmed?: boolean;             // Schreib-Node vom Nutzer für unbeaufsichtigte Läufe freigegeben
  notes?: string;
}

export interface WorkflowItem { json: Record<string, unknown>; pairedItem?: { item: number; input?: number } }

export type WorkflowTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; intervalMinutes: number; at?: string; weekdays?: number[] }   // "täglich 07:00", "Mo–Fr"
  | { kind: "event"; event: "radar.newHot" | "mail.inbound" | "alert.created" | "import.finished"; filter?: Record<string, unknown> }
  | { kind: "chat" };              // Slash-Aufruf /workflow-name oder Tool workflow_run

export interface WorkflowExecution {
  id: string; workflowId: string; workflowVersion: number;
  trigger: "manual" | "schedule" | "event" | "chat" | "test";
  status: "running" | "success" | "error" | "cancelled" | "waiting" | "paused";
  startedAt: string; finishedAt?: string;
  nodeRuns: Record<string, Array<{                 // je Node, je Durchlauf (Loops)
    startedAt: string; finishedAt?: string; status: "success" | "error" | "skipped";
    inputItems: number; outputItems: number[];     // je Ausgang
    output?: WorkflowItem[][]; error?: string;     // Ausgabe wird gekürzt gespeichert (max 200 Items, 64 KB je Item)
    toolCallIds?: string[];                        // Verknüpfung zum Audit
  }>>;
  pausedAt?: { node: string; reason: "confirmation" | "wait" | "quota" };
  summary?: string;                                // Einzeiler fürs Meldungen-Panel
}
```

**Speicherung.** `<userData>/workflows/<id>.json` (Definition) und
`<userData>/workflows/executions/<workflowId>/<executionId>.json` (Läufe,
Aufbewahrung 90 Tage oder 200 Läufe je Workflow). Kein Gateway-Zwang in W1;
Teilen in der Organisation (W7) legt die Definition zusätzlich im Gateway ab.

**Beispiel-Workflow (Leitszenario) als Node-Kette**

| # | Node | type | Parameter (gekürzt) | Ausgabe-Items |
|---|---|---|---|---|
| 1 | Start | trigger | schedule: täglich 07:00 | 1 leeres Item |
| 2 | Firmenradar laufen lassen | tool `radar_run` (neu, kapselt Scan → Profile → Match) | – | 1 Item mit Lauf-Zusammenfassung |
| 3 | Kandidaten lesen | tool `discovery_candidates` (allItems) | `{ minScore: {{ $vars.mindestScore }} }` | n Items (je Firma) |
| 4 | Score ≥ 80? | filter | `{{ $json.matchScore >= 80 }}` | m Items |
| 5 | Importieren | tool `discovery_decide` (allItems, Schreib-Node, confirmed) | `decisions: {{ $input.all().map(i => ({discoveryId: i.json.discoveryId, decision: "imported"})) }}` | 1 Item (transactionId) |
| 6 | Auf Verarbeitung warten | wait `import.finished` | `{{ $json.transactionId }}`, max 6 h | 1 Item |
| 7 | Firmen des Imports | tool `company_search` (allItems) | `{ transactionId: … }` | k Items |
| 8 | Maschinenbau + Kasse > 100 T€ | filter | `{{ $json.branche === "Maschinenbau" && $json.finanzen.kassenbestand > 100000 }}` | k' Items |
| 9 | Ansprechpartner Vertrieb | tool `company_contacts` (perItem) + transform (erster Treffer mit Rolle „Vertrieb", sonst allgemeine Adresse) | – | k' Items |
| 10 | Mail formulieren | ai (perItem, Ausgabeschema `{ subject, text }`) | Prompt mit `{{ $json.name }}`, `{{ $json.profil.zusammenfassung }}`, Stilvorgabe aus Skill „outreach-stil" | k' Items |
| 11 | Mail senden | tool `mail_send` (perItem, Schreib-Node) | `to: [{{ $json.empfaenger }}]`, `subject`, `text` | k' Items |
| 12 | Meldung | tool `alert_create` | „12 Mails versendet" | – |

Offen für die Umsetzung: Node 8 setzt voraus, dass Finanzkennzahlen aus den
Jahresabschlüssen als strukturierte Felder am Firmenobjekt verfügbar sind
(heute in `structured-content`; ein lesendes Tool `company_financials` fehlt und
wird in W2 ergänzt). Node 11 unterliegt weiter der Mail-Allowlist.

---

## 2a. Grundgedanke: Ein Lauf = eine Firma, voller Kontext, semantische Platzhalter

Vorgabe des Operators (2026-09-09): **Ein Workflow-Lauf bezieht sich immer auf
genau eine Firma.** Der vollständige Kontext dieser Firma liegt dem Lauf als
Klartext vor, und die KI des Workflow-Laufs füllt Node-Parameter dynamisch
mit den passenden Werten, nach semantischer Ähnlichkeit, nicht über feste
Feldnamen.

- **Kontext.** Beim Start lädt die Engine über die vorhandenen Lese-Tools
  Stammdaten, Firmenprofil, Schlagworte, Kontakte, Jahresabschlüsse mit
  Kennzahlen und den CRM-Stand (bei Radar-Kandidaten das Mini-Profil) und
  rendert sie als Klartext (`# Firmen-Kontext …`, je Quelle ein Abschnitt,
  gekürzt auf 70 000 Zeichen). Anbieter- und Feature-Sperren gelten dabei
  automatisch, weil derselbe Tool-Pfad genutzt wird. In Expressions steht der
  Kontext als `$company` (strukturiert) und `$context` (Text) bereit; jeder
  KI-Node bekommt ihn in den System-Prompt.
- **Semantische Platzhalter.** AVA erfindet beim Bauen frei benannte
  Platzhalter wie `$kassenbestand`, `$ansprechpartner_vertrieb` oder
  `$umsatz_letztes_jahr`. Vor der Ausführung eines Nodes sammelt die Engine
  alle Platzhalter seiner Parameter und lässt sie in einem Modell-Aufruf aus
  dem Firmen-Kontext befüllen (Regeln: nur Werte aus dem Kontext, nichts
  erfinden, Zahlen als Zahl, sonst `null`). Ergebnisse werden je Lauf
  gecacht, damit ein Name über alle Nodes denselben Wert hat.
- **Fallback.** Syntax `$kassenbestand ?? "Es liegt KEIN Kassenbestand vor"`.
  Fehlt der Wert, greift der Fallback; ohne Fallback bleibt der Wert leer und
  der Node bekommt einen Hinweis. Innerhalb von `{{ }}` wird der Wert als
  Literal eingesetzt (Zahlen bleiben Zahlen), außerhalb als Text.
- **Abgrenzung.** `$json`, `$input`, `$vars`, `$company`, `$context`, `$now`,
  `$today`, `$run`, `$itemIndex` und `$('Node')` sind Expression-Wurzeln,
  keine Platzhalter.
- **Firmenbezug je Trigger.** Manuell/Chat: Firma wird gewählt (Suche über
  `company_search`, `workflow_run` mit `firma`). Ereignis: das Ereignis muss
  eine Firma tragen (`companyId` oder `discoveryId`), sonst wird der Lauf
  übersprungen und auditiert. **Mehrere Firmen** (Operator 2026-09-09, v0.1.591):
  entweder Stapel-Start (`workflow_run` mit `firmen[]`, Mehrfachauswahl in der
  Firmenauswahl; je Firma ein Lauf, bis zu 3 parallel) oder das **Prime/Sub-
  Muster**: ein Prime-Workflow ohne Firmenbezug erzeugt Items mit
  `companyId`/`discoveryId` und ruft einen `subworkflow`-Node je Item auf;
  jeder Sub-Lauf holt sich den vollen Kontext seiner Firma selbst. Zeitplan: feste Firmenliste im Trigger
  (`companyIds`), ein Lauf je Firma nacheinander; ohne Liste läuft ein
  Zeitplan nur bei `settings.scope = "none"` (Abläufe ohne Firmenbezug, z. B.
  „Radar starten“). Offen: dynamische Firmenquellen für Zeitpläne (alle
  Firmen eines Vorgangs, Radar-Kandidaten über Schwelle).

## 3. Engine (Hauptprozess)

Neues Modul `services/desktop/src/main/workflows/`:

- `store.ts` — Laden/Speichern/Versionieren; Validierung (yup) beim Speichern:
  Node-Namen eindeutig, alle Kanten zeigen auf existierende Nodes/Ausgänge,
  genau ein Trigger, keine Zyklen außer über Loop-Node, jeder `tool`-Node
  referenziert ein registriertes Tool und seine `args` passen zum
  JSON-Schema des Tools (statisch prüfbar, sofern keine Expression).
- `expressions.ts` — Expression-Auswertung. Erste Stufe: eigener kleiner
  Ausdrucks-Interpreter für Pfade, Vergleiche, Arithmetik, String-Templates,
  `map/filter/find/length` auf Arrays, Datumsfunktionen. Kein `eval`, kein
  Node-`vm`. Zweite Stufe (falls nötig): `jsep`-Parser mit eigener sicherer
  Evaluation.
- `runner.ts` — Ausführung:
  1. Topologische Reihenfolge nach n8n-v1 (Zweig für Zweig; Position als
     Tie-Breaker).
  2. Je Node: Eingabe-Items sammeln (Merge wartet auf alle Eingänge), Modus
     `perItem` → Node je Item aufrufen, `pairedItem` setzen; `allItems` →
     einmal mit `$input.all()`.
  3. Tool-Node: Args aus Parametern und Expressions bauen, `tool.parseArgs`,
     `tool.run(args, ctx)`. `ctx.ui` ist eine **Workflow-UiBridge**: Bestätigungen
     werden nicht als Dialog gestellt, sondern gegen Vollmacht + `confirmed`-Flag
     entschieden (siehe §5); `askChoice/askText` sind im Workflow nicht erlaubt
     (Fehler „Node braucht Rückfrage — als Parameter festlegen").
  4. Ergebnisse normalisieren: Tool-Ergebnis-Objekt → Items. Regel: liefert das
     Tool ein Array unter einem bekannten Schlüssel (`items`, `rows`,
     `candidates`, `companies`, `contacts`, `results`), wird je Element ein Item;
     sonst ein Item mit dem ganzen Objekt. Der Node-Katalog (§4) kann das je Tool
     überschreiben (`outputPath`).
  5. Fehler je Node nach `onError`; Retry mit Backoff; Abbruch via
     AbortController (Nutzer-Stopp, Timeout, App-Beenden → Lauf als
     `cancelled`, Wiederaufnahme nicht in W1).
  6. Fortschritt als Events (`workflow:progress`) an Renderer und Audit
     (`workflow.run.*`, je Tool-Call die bestehenden Tool-Audits mit
     `executionId`-Metadatum).
- `triggers.ts` — Manuell, Zeitplan (nutzt den vorhandenen
  `ScheduledJobsSupervisor` mit neuer `kind: "workflow"`), Ereignisse
  (Abonnements auf interne Emitter: Radar-Alerts, Mail-Eingang, Import
  abgeschlossen), Chat (Slash `/wf-name` und Tool `workflow_run`).
- `compiler.ts` — **Trace → Workflow** (§6).
- `catalog.ts` — Node-Katalog (§4).
- Nebenläufigkeit: ein Workflow-Lauf zur Zeit je Workflow; global maximal 2
  parallele Läufe; Workflow-Läufe haben niedrigere Priorität als der
  interaktive Chat (bestehendes `isLlmBusy`-Muster für KI-Nodes).

Wiederverwendung statt Neubau: Tools laufen über die vorhandene `ToolRegistry`
(inkl. Anbieter-Sperre `setSperre`), Vollmacht über `autonomyCovers`, Audit über
`audit()`, Zeitplan über `ScheduledJobsSupervisor`, KI-Node über
`providers.streamChat({ channel: "background" })`.

---

## 4. Node-Katalog

Der Katalog wird aus der `ToolRegistry` **generiert** plus einer Handvoll
Logik-Nodes. Je Tool ein Node-Typ `tool:<name>` mit Label, Kategorie
(aus `category`), Parametern (JSON-Schema des Tools → Formularfelder),
Ausgabe-Beschreibung, `write: boolean` (aus `isWriteTool`), `outputPath`.

Nicht als Node zulässig: `ask_user_*`, `tool_search`, `tool_load`,
`skill_*`, `chat_history_*`, `workflow_*` (außer `workflow_run` als
Sub-Workflow-Node), Tools mit Consent-Charakter (`connect_crm`,
Schlüssel-Tools). Diese Liste ist ein Allowlist-Filter in `catalog.ts`.

Logik-Nodes (eigene Implementierung, ohne LLM):

| Node | Ausgänge | Zweck |
|---|---|---|
| Start (Trigger) | 1 | Auslöser; liefert Trigger-Daten als Item (z. B. eingehende Mail, neuer heißer Treffer) |
| If | true / false | Bedingung als Expression je Item |
| Switch | n benannte | Wert-Verzweigung (z. B. Branche) |
| Filter | 1 | behält Items, für die die Bedingung gilt |
| Transform | 1 | Felder setzen/umbenennen/entfernen, Werte berechnen |
| Loop Over Items | loop / done | Batches (z. B. 10 Firmen je Runde, Kontingent-schonend) |
| Merge | 1 | wartet auf mehrere Zweige; Modus append / nach Schlüssel verbinden |
| Wait | 1 | Zeit (bis 7 Tage) oder Ereignis (`import.finished`, `transaction.stage`) |
| Stop and Error | – | Lauf gezielt abbrechen |
| Sub-Workflow | 1 | anderen Workflow mit Items aufrufen |
| Note | – | Sticky Note |

KI-Node (`ai`): fester System-Prompt, Nutzer-Prompt mit Expressions, optional
Skill als Stilvorgabe, **Ausgabeschema Pflicht** (JSON-Schema → yup-Validierung,
bis zu 2 Reparaturversuche), Modell = Hintergrund-Modell, Kanal `background`.
Kein Tool-Zugriff innerhalb des KI-Nodes; wer Tools braucht, verbindet einen
Tool-Node davor oder danach.

---

## 5. Sicherheit, Vollmacht, Kosten

- **Vollmacht.** Beim Speichern klassifiziert der Store jeden Schreib-Node
  (`isWriteTool` + Klasse `additive | mutating | destructive` aus dem
  Confirm-Kind des Tools, in W1 als Tabelle gepflegt). Ein Node darf
  unbeaufsichtigt laufen, wenn (a) die effektive Vollmacht die Klasse deckt
  oder (b) der Nutzer den Node in der Ansicht als „freigegeben" markiert hat.
  Löschende Aktionen sind im Workflow nie unbeaufsichtigt, nur mit
  `confirmed` **und** Vollmacht `mutating`.
- **Ohne Deckung** hält der Lauf am Node an (`status: paused`, Grund
  `confirmation`), erzeugt eine Meldung („Workflow X wartet: Mail an 12
  Empfänger versenden — freigeben?") und lässt sich aus der Ansicht, dem Chat
  oder Telegram fortsetzen. Wartet ein Lauf länger als 48 h, bricht er ab.
- **Organisation.** Anbieter-Sperre und Funktions-Vorgaben gelten unverändert:
  Nodes zu abgeschalteten Funktionen sind im Katalog unsichtbar; ein
  gespeicherter Workflow mit einem solchen Node ist „nicht ausführbar" mit
  Begründung. Org-Admins können später (W7) Workflows für Mitglieder
  bereitstellen und Trigger-Arten einschränken.
- **Kosten und Kontingente.** `maxItemsPerRun` deckelt; Radar-Scans, Imports und
  Deep Research zählen weiter gegen Plan-Kontingente und Org-Limits (Kanal
  `background`). Vor dem Lauf zeigt die Ansicht eine Schätzung (Items × Tool-
  Kostenklasse), aus dem Katalog gepflegt (frei / Kontingent / KI-Aufrufe /
  externer Dienst).
- **Audit.** Jeder Lauf ist ein Audit-Eintrag mit `executionId`; jeder Tool-Call
  bleibt einzeln auditiert. Das Meldungen-Panel bekommt den Typ
  `workflow-run`.
- **Idempotenz.** Tool-Nodes mit natürlichen Schlüsseln (discoveryId, mail
  Message-ID, HubSpot-ID) merken sich je Workflow verarbeitete Schlüssel
  (`<userData>/workflows/state/<id>.json`), damit ein täglicher Lauf dieselbe
  Firma nicht zweimal anschreibt. Der Node-Katalog markiert, welches Feld der
  Schlüssel ist; die Ansicht zeigt „bereits verarbeitet: 37".

---

## 6. AVA baut Workflows: Trace → Workflow, Beschreibung → Workflow

**A. Aus dem Chat speichern** („speichere die Schritte als Workflow")

1. Tool `workflow_from_conversation` liest die Tool-Calls der Konversation
   (`AgentMessage.toolCalls` + zugehörige `tool`-Ergebnisse) ab einer
   Startmarke (Default: seit der letzten Nutzer-Nachricht, die einen neuen
   Auftrag begann; optional `sinceMessageId`).
2. **Kompilierung ohne LLM** (`compiler.ts`): Meta-Tools raus
   (`tool_search`, `tool_load`, `skill_*`, `ask_user_*`), Fehlschläge mit
   anschließendem erfolgreichem Retry auf den Retry reduziert, Reihenfolge
   beibehalten, je Tool-Call ein Tool-Node. **Datenfluss-Rekonstruktion:**
   Argumentwerte, die wörtlich in einem früheren Ergebnis vorkommen
   (IDs, Domains, E-Mail-Adressen, Namen), werden zu Expressions auf diesen
   Node (`{{ $('Kandidaten lesen').item.json.discoveryId }}`); wiederholte
   gleichartige Calls über verschiedene IDs werden zu **einem** Node im Modus
   `perItem` zusammengefaltet (das ist genau das Muster aus dem
   `crm_search_hubspot_companies`-Vorfall). `ask_user_choice`-Antworten werden
   zu Workflow-Variablen (`$vars`), damit sie beim nächsten Lauf gesetzt sind.
3. **LLM-Nachbearbeitung** (ein Aufruf, Ausgabeschema Pflicht): Node-Namen in
   Klartext, Beschreibung, Vorschlag für Variablen (was war ein Einmalwert,
   was ein Parameter?), Vorschlag für Filter-Nodes, wo der Agent im Chat
   Ergebnisse „im Kopf" gefiltert hat (z. B. Score-Schwelle aus dem Verlauf),
   Trigger-Vorschlag.
4. Entwurf wird dem Nutzer als Liste gezeigt (Bestätigungsdialog wie bei
   `skill_create`) und nach „Speichern" in der Ansicht geöffnet. Nichts läuft
   automatisch; Trigger ist zunächst `manual`.

**B. Aus einer Beschreibung** („bau mir einen Workflow, der …")

Tool `workflow_draft`: Der Agent bekommt den Node-Katalog (kompakt: Name,
Zweck, Eingabe-/Ausgabe-Felder) und erzeugt die Definition direkt als JSON
(Ausgabeschema = `WorkflowDefinition`, ohne Positionen; Auto-Layout im
Renderer). Validierung wie beim Speichern; Fehler gehen als Liste zurück an
den Agenten (max 3 Runden). Für unklare Parameter fragt der Agent den Nutzer
vorher (im Chat, nicht im Workflow).

**C. Testen und Korrigieren im Chat**

`workflow_test_run` (führt aus, Schreib-Nodes im Trockenlauf: Vorschau statt
Ausführung, wie `dryRun` bei Imports), `workflow_update` (Node-Parameter,
Kanten, Trigger ändern, mit Bestätigung), `workflow_explain` (erklärt Ablauf
und letzte Läufe in Prosa), `workflow_run`, `workflow_list`, `workflow_pause`.
Jede Einstellung ist damit im Chat erreichbar (Regel „Self-Service im Chat").

---

## 7. Ansicht (Renderer)

Route `/workflows` (Liste) und `/workflows/:id` (Editor). Navigation unter
„Vorgänge → Workflows"; unsichtbar, solange die Org-Policy `workflows`
abschaltet.

**Liste.** Karten je Workflow: Name, Trigger („täglich 07:00"), letzter Lauf
mit Status und Einzeiler, nächster Lauf, Schalter aktiv/pausiert, „Jetzt
ausführen", „Im Chat öffnen".

**Editor** (React Flow):
- Canvas mit Pan/Zoom, Minimap, Auto-Layout (dagre, links nach rechts wie
  n8n), Drag von Nodes, Kanten per Handle ziehen, Kanten mit Ausgangs-Label
  (true/false, loop/done), Undo/Redo, Copy/Paste von Nodes.
- Node-Karte: Icon nach Kategorie, Name, Untertitel (Tool-Name), Badges
  (Schreib-Node, freigegeben, deaktiviert, KI), nach einem Lauf „12 Items"
  am Ausgang; Fehler rot am Node.
- Rechtes Panel bei Auswahl (n8n-Dreiteilung, hier zweispaltig wegen Platz):
  **Parameter** als Formular aus dem JSON-Schema; jedes Feld hat einen
  Umschalter „fester Wert / Expression"; Expression-Editor mit Autovervollständigung
  aus den Ausgabe-Feldern der Vorgänger (aus Pin-Daten oder letztem Lauf).
  **Eingabe/Ausgabe** als Tabelle oder JSON (letzter Lauf oder Pin), Pin-Knopf.
- Aktionen: „Schritt ausführen" (bis zu diesem Node, Vorgänger aus Pin/letztem
  Lauf), „Workflow testen" (Trockenlauf), „Speichern" (Version +1), „Im Chat
  ändern" (öffnet Chat mit vorgefülltem Kontext „Workflow X").
- Node hinzufügen: Palette mit Suche über den Katalog (Kategorien wie im
  Chat), plus Vorschlagsliste „passt nach diesem Node" (gleiche Heuristik wie
  `outputPath`/Eingabefelder).
- Trigger-Panel: manuell / Zeitplan (Intervall, Uhrzeit, Wochentage) /
  Ereignis / Chat.
- Läufe-Tab: Tabelle der Ausführungen, Klick öffnet den Lauf auf dem Canvas
  (Node-Färbung nach Status, Items je Kante).
- Theme: bestehende Tokens (`--color-indigo-*`), Du-Form, keine
  unterstrichenen Button-Texte, dunkel/hell wie die übrige App.

Abhängigkeiten: `@xyflow/react` (~120 KB), `dagre` (Layout). Kein
Monaco-Editor; Expression-Feld ist ein Textfeld mit Vorschlagsliste.

---

## 8. Phasen und Aufwand

Reihenfolge so, dass ab W2 ein nutzbarer Kern existiert und die Ansicht die
Engine nie blockiert.

| Phase | Inhalt | Aufwand | Ergebnis für Nutzer |
|---|---|---|---|
| **W0 Entscheidungen** | §10 abhaken; Feature-Flag `workflows` in Org-Policy; Plan-Tier (Workflows ab Starter? Anzahl Workflows je Plan?) | 0,5 Tag | – |
| **W1 Kern** | Typen, Store, Validierung, Expressions (Stufe 1), Runner mit Tool-/Filter-/Transform-/If-Nodes, Items-Normalisierung, Workflow-UiBridge, Audit, IPC (list/get/save/run/cancel/executions) | 5 Tage | Workflows als JSON ausführbar (Chat-Tool `workflow_run`), keine Ansicht |
| **W2 Aus dem Chat** | `compiler.ts` (Trace → Nodes, Datenfluss-Rekonstruktion, Faltung zu perItem), LLM-Nachbearbeitung, Tools `workflow_from_conversation`, `workflow_draft`, `workflow_list/explain/update`; `company_financials`-Lesetool; `radar_run`-Tool | 5 Tage | „Speicher das als Workflow" funktioniert; Workflows per Beschreibung |
| **W3 Ansicht** | Liste, Editor mit React Flow, Parameter-Formular aus Schema, Expression-Feld mit Vorschlägen, Läufe-Tab, Node-Palette | 7 Tage | Visualisierung und kleine Korrekturen |
| **W4 Automatik** | Zeitplan-Trigger über ScheduledJobsSupervisor, Ereignis-Trigger (Radar heiß, Mail-Eingang, Import fertig), Wait-Node (Zeit + Ereignis), Meldungen-Typ `workflow-run`, Telegram-Fortsetzung bei `paused` | 4 Tage | Workflows laufen von selbst; Freigabe unterwegs |
| **W5 Flow-Logik komplett** | Switch, Loop Over Items, Merge, Sub-Workflow, Stop-and-Error, Fehler-Workflow, Retry-Einstellungen, Idempotenz-Schlüssel | 4 Tage | Leitszenario vollständig abbildbar |
| **W6 Testen** | Pin-Daten, „Schritt ausführen", Trockenlauf für Schreib-Nodes, Kostenschätzung vor dem Lauf | 3 Tage | Sicheres Iterieren ohne echte Mails |
| **W7 Organisation** | Workflows teilen (Gateway-Ablage `TenantWorkflow`), Vorlagen der Organisation, Admin-Einschränkungen (erlaubte Trigger, Pflicht-Freigabe für Mail-Versand), Export/Import als JSON | 4 Tage | Team-Vorlagen |
| **W8 Politur** | Undo/Redo, Copy/Paste, Sticky Notes, Auto-Layout-Feinschliff, Onboarding-Beispiele („Radar-Outreach", „Mail-Nachfass", „CRM-Pflege"), Website-Text | 3 Tage | n8n-Gefühl |

Summe rund 35 Arbeitstage. W1 + W2 + W4 (14 Tage) sind der Wert für Nutzer,
W3 kann parallel starten, sobald die Typen aus W1 stehen.

---

## 9. Was bestehende Bausteine dafür brauchen

- `ToolRegistry`: `list()` liefert bereits alles; ergänzen: `write`-Klasse und
  `outputPath` je Tool (Metadaten in `defineTool`, Default per Heuristik).
- `defineTool`: neues optionales Feld `workflow: { outputPath?, itemKey?, costClass?, allowed?: boolean }`.
- `UiBridge`: Interface extrahieren, damit `WorkflowUiBridge` dieselbe Form
  hat (`confirmAction` entscheidet statt fragt, `askChoice/askText` werfen).
- `ScheduledJobsSupervisor`: `kind: "workflow"` mit `workflowId`; Uhrzeit und
  Wochentage (heute nur Intervall).
- Ereignis-Quellen als Emitter: `RadarAlertEmitter` (vorhanden), Mail-Eingang
  (`MailAgentBridge`, vorhanden), Import-Abschluss (Producer-Status →
  neuer Emitter), Meldungen.
- Org-Policy: Feature `workflows`; später Trigger-Einschränkungen.
- Meldungen-Panel: Typ `workflow-run` mit Aktionen „Freigeben", „Öffnen".
- Website: Abschnitt „Workflows" erst mit W4 („in Arbeit" bis dahin).

---

## 9a. Umsetzungsstand

| Datum | Stand |
|---|---|
| 2026-09-09 | **W0 entschieden** (siehe §10). **W1 Kern** umgesetzt: Typen, Store, Validierung, Expressions (jsep + sichere Auswertung), Katalog, Engine mit allen Logik-Nodes inkl. Human-in-the-Loop (Freigaben mit 48-h-Verfall), Vollmacht/Node-Freigabe/mail_send-Regel/Tages-Deckel, Idempotenz-Schluessel, Trockenlauf, Zeitplan-Trigger ohne Nachholen, Ereignis-Haken `emitEvent` — **W4 teilweise**: `radar.newHot` (RadarAlertEmitter), `mail.inbound` (messageFinalized, nur eingehend), `alert.created` (AlertsStore) sind angeschlossen; `import.finished` seit v0.1.588 per Polling (juengste Vorgaenge, alle Firmen im Endzustand → je abgeschlossener Firma ein Ereignis); Telegram-Fortsetzung bei Freigaben und Meldungs-Typ `workflow` seit v0.1.586. Editor-Parameter-Formular aus dem Schema mit Expression-Vorschlaegen seit v0.1.587. **v0.1.589:** Pin-Daten (Ausgabe pinnen, Testlaeufe nutzen sie), „Bis hierhin testen“ (untilNode), Fehler-Workflow (W5, `errorWorkflowId` mit Fehler-Item), Kostenuebersicht je Lauf (W6, Kostenklassen + Platzhalter-Aufrufe). **v0.1.590 / Gateway (Migration 20260909_tenant_workflows):** W7 Teilen mit der Organisation — Kopie der Definition im Tenant (`TenantWorkflow`, Routen `/v1/tenants/me/workflows`), Uebernehmen als eigene Kopie (Trigger manuell, Freigaben zurueckgesetzt), Zurueckziehen durch Teilenden/Admin; Workflows-Seite (Teilen, „Von der Organisation geteilt“), Chat-Tools `workflow_share`, `workflow_org_list`, `workflow_adopt`. Gateway deployt 2026-09-09. **v0.1.591:** Mehrere Firmen — Stapel-Start (`runBatch`, `firmen[]`, Mehrfachauswahl) und Prime/Sub-Muster (subworkflow-Node je Item mit eigenem Firmenkontext). **v0.1.592:** Watcher — `wait`-Node mit `transactionId` wartet, bis alle Firmen eines Vorgangs verarbeitet sind (Polling, maxHours). Damit ist „Radar-Firmen importieren → nach Verarbeitung je Firma Kurzuebersicht per Telegram“ als Prime/Sub-Kette abbildbar. **v0.1.593:** allgemeiner Vorgangs-Watcher (`transaction-watcher.ts`): Meldung „Vorgang abgeschlossen: X fertig, Y fehlgeschlagen“ mit Fehlerquellen (Meldungen, Toast, Telegram) fuer jeden Import, unabhaengig von Workflows; zugleich Quelle fuer `import.finished`. **v0.1.594 (W8):** Undo/Redo im Editor (Cmd/Strg+Z, Shift fuer Wiederholen), vier Vorlagen (`templates.ts`, Liste + Chat-Tool `workflow_templates`, Sub-Vorlage wird mitangelegt), Website-Prompt docs/WEBSITE_PROMPT_UPDATE_2026-09-09.md. Damit sind W0–W8 des Plans umgesetzt; offen bleibt nur die Ausfuehrung ohne laufende App (eigenes Vorhaben). **W2** umgesetzt: Chat-Tools `workflow_*` inkl. `workflow_from_conversation` (Trace-Compiler ohne LLM; LLM-Nachbearbeitung uebernimmt der Agent selbst ueber `workflow_save`). **W3 erste Fassung**: Liste mit „Offene Freigaben“, Editor mit React Flow (Canvas, Kanten ziehen, Node-Panel mit JSON-Parametern, Trigger-Panel, Laeufe mit Node-Faerbung und Items je Kante, Palette). Offen in W3: Parameter-Formular aus dem Schema, Expression-Vorschlaege, Pin-Daten, „Schritt ausfuehren“, Undo/Redo. Tests: `pnpm test:workflows`. **v0.1.586:** Zeitplan-Firmenquellen (`companySource`: feste Liste, Radar-Kandidaten ab Score, alle Firmen eines Vorgangs, alle Firmen) mit Idempotenz je Firma und Zeitfenster; Meldungs-Typ `workflow` (Meldungen-Panel, OS-Toast, Telegram ueber den Alert-Fanout); Freigaben per Telegram (`/freigaben`, `/ja <id>`, `/nein <id>`). **Grundgedanke §2a umgesetzt (v0.1.585):** Firmen-Kontext je Lauf (`context.ts`), semantische Platzhalter mit Fallback (`placeholders.ts`), Firmenauswahl in Liste/Editor, `workflow_run` mit `firma`, Zeitplan mit `companyIds`, Ereignisse nur mit Firma. |

## 10. Offene Entscheidungen (vor W1)

1. **Plan-Staffelung.** → Entschieden 2026-09-09: Free max. 1 Workflow, alle
   anderen Plaene unbegrenzt (`WORKFLOW_LIMITS`).
2. **Mail-Versand unbeaufsichtigt.** → Entschieden 2026-09-09: Freigabe
   Pflicht (Node `confirmed` oder Human-in-the-Loop-Node davor), Tages-
   Obergrenze je Workflow (Default 20). Zusaetzlich gewuenscht: ein
   **Human-in-the-Loop-Node** (`human`) mit einer zentralen Liste aller
   offenen Freigaben (Workflows-Seite, Chat-Tool `workflow_approvals`,
   Meldung/Telegram), die man akzeptieren oder ablehnen kann, bevor der
   Workflow weiterlaeuft. Umgesetzt in W1/W3.
3. **KI-Node und ChatGPT-Abo.** → Bestaetigt 2026-09-09. Blockade wird in
   der Liste als Grund angezeigt (`blocked`).
4. **Ausführung ohne laufende App.** → Entschieden 2026-09-09: KEIN
   Nachholen. Laeuft die App zur Trigger-Zeit nicht, faellt der Lauf aus
   und der naechste Zeit-Trigger zaehlt (Fenster 20 Minuten nach der
   Uhrzeit).
5. **Expressions-Umfang.** → Entschieden (dem Assistenten ueberlassen):
   `jsep` + Plugins (Pfeilfunktionen, Objekt-Literale, Templates) mit
   eigener sicherer Auswertung. Syntax wie JavaScript (n8n-Gefuehl):
   Vergleiche, Arithmetik, Ternaer, `??`, `in`, Array-/String-Methoden,
   `$json`, `$('Node')`, `$input`, `$vars`, `$now`, `$today`, `$run`,
   `Math`, `Date`. Kein eval/vm, keine Prototyp-Zugriffe, keine
   Zuweisungen, Schrittgrenze.
6. **Teilen in der Organisation** → Entschieden 2026-09-09: W7. Workflows
   liegen lokal auf dem Geraet des Nutzers und koennen — wie Vorgaenge und
   Radar-Firmen — mit der eigenen Organisation geteilt werden.

---

## 11. Risiken

- **Trace-Kompilierung liefert Murks**, wenn der Chat mäandert (Fehlversuche,
  Themenwechsel). Gegenmittel: Startmarke wählbar, Entwurf immer als Liste
  bestätigen, Faltung und Datenfluss-Rekonstruktion konservativ (im Zweifel
  fester Wert statt falscher Expression, mit Hinweis „prüfen").
- **Tool-Ergebnisse sind nicht auf Items ausgelegt** (Objekte mit
  Zusammenfassung statt Listen). Gegenmittel: `outputPath` je Tool im Katalog,
  in W1 für die 30 wichtigsten Tools gepflegt; Transform-Node für den Rest.
- **Unbeaufsichtigte Schreibaktionen** erzeugen Vertrauensverlust bei einem
  einzigen Fehlversand. Gegenmittel: Freigabe-Flag, Trockenlauf, Tages-Deckel,
  Idempotenz-Schlüssel, Meldung nach jedem Lauf mit Zahlen.
- **Ansicht wird zum Bau-Werkzeug**, das mit n8n verglichen wird. Gegenmittel:
  Positionierung „AVA baut, du kontrollierst"; die Palette ist Ergänzung.
- **Canvas-Leistung** bei Workflows mit vielen Läufen: Ausgaben gekürzt speichern,
  Läufe-Tab lazy laden.
- v0.1.597: workflow_save/workflow_update tolerant (Trigger ohne kind/`type`-Alias → normalisiert, Variablen als Skalar → {label,type,value}); Fehler nennen das erhaltene Objekt; workflow_update meldet geaenderte Node-Parameter zurueck; Vorlagen-Hinweis zur Filteranpassung; Editor-Ansicht ueber volle Breite.
- v0.1.598: Gateway-Limit pageSize 200 beachtet (Warten-Node, Vorgangs-Watcher, Firmenquelle Vorgang laden seitenweise); vorher 400 und stiller Watcher. Warten-Node prueft die Vorgangs-ID und nennt sie im Fehler.
- v0.1.599: Firmen-Kontext um Handelsregister-Auszug (company_structured_content: Rechtsform, Stammkapital, Gruendungsjahr, Geschaeftsfuehrung) ergaenzt; fehlende Quellen (404) als „keine Daten vorhanden“ statt Fehler.
- Ausfuehrung ohne laufende App: Plan in docs/PLAN_WORKFLOWS_OHNE_APP.md (Empfehlung: Desktop-Bereitschaft C1–C5 jetzt, Headless-Server spaeter; Betreiber-Worker verworfen). Wartet auf Entscheidung.
- v0.1.600: Warten-Node wertet seine Parameter (transactionId, minutes, maxHours) als Expressions aus; vorher kam {{ $json.transactionId }} woertlich an.
- v0.1.601: Engine-Pruefung aller Nodes (End-to-End-Test scripts/_test-workflows-engine.inner.mjs mit Stub-Tools, Teil von test:workflows). Behoben: Schleifen-Rueckkanten blockierten den Loop-Node (nie ausgefuehrt); Tool-Ergebnisse mit error-Feld galten als Erfolg; Warten-Node ohne Vorgang (Import ohne importierbare Firmen, z. B. ohne Ort) meldet die Ursache; Trockenlauf endet am Warten-Node sauber statt mit Folgefehler.
- v0.1.602: Vorgangs-Abschluss anhand der Pipeline-Matrix je Stufe (transaction-pipeline.ts): massgeblich ist das Firmenprofil je Firma; Teilfehler (Handelsregister/Jahresabschluesse) werden als Ursache mit Beispiel-Fehler und Quellen-Hinweis gemeldet, nicht als Totalausfall. Warten-Node liefert ein Item je Firma (companyId, state, fehlgeschlageneStufen); Vorlage ohne transaction_entities-Schritt. Ereignis import.finished traegt fehlgeschlageneStufen.

## 11. Daten-Abhängigkeiten je Node (entschieden und umgesetzt 2026-09-09, v0.1.603)

Anlass: Ein Node, der `$kassenbestand` braucht, muss den Publikations-Producer
abwarten; das Firmenprofil ist oft deutlich früher fertig. Heute wartet der
Warten-Node nur auf das Firmenprofil.

**Grundsatz:** Abhängigkeiten werden aus den Nodes abgeleitet, nicht vom
Nutzer gepflegt. Manuelles Überschreiben bleibt möglich.

1. **Zuordnung Datenquelle → Stufe.** Jede Kontext-Sektion kommt aus einer
   Producer-Stufe: Stammdaten → masterData, Firmenprofil → companyProfile,
   Handelsregister → structuredContent, Jahresabschlüsse/Kennzahlen →
   companyPublication, Kontakte → companyContact, Bewertung →
   companyEvaluation, CRM → keine.
2. **Ableitung je Node (Validierung, ohne Modell).** Expressions
   (`$company.finanzen…`, `$company.register…`) sind eindeutig. Semantische
   Platzhalter werden über Wortlisten zugeordnet (kasse/umsatz/bilanz/
   eigenkapital/ebit → Jahresabschlüsse; geschäftsführer/stammkapital/
   rechtsform/gründung → Handelsregister; ansprechpartner/e-mail/telefon →
   Kontakte; sonst → Firmenprofil). Ergebnis: `benoetigteStufen` je Node,
   im Editor als Chips „Braucht: Jahresabschlüsse ($kassenbestand)“ sichtbar;
   Override-Feld `dependsOn` am Node.
3. **Sub-Workflows vererben.** Der Sub-Workflow-Node übernimmt die Vereinigung
   der Anforderungen des Sub-Workflows; so weiß der Prime-Workflow, worauf
   er warten muss.
4. **Warten-Node.** Neuer Parameter `bis` (Stufen-Liste). Leer = automatisch:
   Vereinigung aller Anforderungen der nachfolgenden Nodes, mindestens
   Firmenprofil. Abschluss je Firma = alle geforderten Stufen im
   **Endzustand** (fertig ODER fehlgeschlagen/übersprungen), nicht „erfolgreich“;
   sonst blockiert ein ausgefallenes Handelsregister den Lauf für immer. Bei
   fehlgeschlagener Stufe greift der Fallback des Platzhalters
   (`?? "kein Kassenbestand bekannt"`), der Node bekommt einen Hinweis.
5. **Läufe ohne Vorgang** (Firma längst importiert, Ereignis, Zeitplan): keine
   Wartezeit; fehlt die Sektion, greift der Fallback. Nur wenn die Firma in
   einem laufenden Vorgang steckt, wartet der Node (Pipeline-Matrix je Firma).
6. **Editor-Warnung.** Warten-Node wartet auf weniger, als nachfolgende Nodes
   brauchen → Hinweis in der Validierung („Node ‚Mail‘ braucht Jahresabschlüsse,
   der Warten-Node wartet nur auf das Firmenprofil“).

Umsetzung v0.1.603 (Operator-Go „Umsetzen“): (a) Ableitung + Override
(`dependsOn` am Node); (b) `bis` leer = automatisch (Folge-Schritte inkl.
Sub-Workflow, mindestens Firmenprofil); (c) Wartezeit je Node 6 h
(`DEPENDENCY_WAIT_MS`), Warten-Node `maxHours`; (d) Chips „↳ Stufe“ auf den
Node-Karten und im Schritt-Panel, Stufen-Auswahl am Warten-Node.
Code: src/shared/workflow-dependencies.ts (Ableitung, waitStages,
dependencyProblems), runner.ts awaitDependencies (Firma in laufendem Vorgang →
warten, danach Kontext neu laden), transaction-pipeline.ts bewertePipeline mit
geforderten Stufen, CompanyScope.transactionId (Ereignis import.finished,
Warten-Node-Items, Sub-Workflow). Tests in test:workflows.
- v0.1.603: Daten-Abhaengigkeiten je Node (§11): abgeleitet aus Platzhaltern/Expressions, Warten-Node `bis` (leer = automatisch), Node wartet in laufendem Vorgang auf seine Stufen, Editor-Chips, Validierungs-Hinweis, Chat-Tool zeigt benoetigteStufen.
- v0.1.604: Node-Katalog auf fachliche Schritte begrenzt (Operator 2026-09-09: Konto-, Organisations-, Abrechnungs-, Einstellungs-, Verbindungs-, Loesch-, Zeitplan- und Konfigurations-Tools sind keine Workflow-Nodes; 113 erlaubt / 120 gesperrt, Liste per `isToolAllowedInWorkflows`). Chat: Sammelabrechnung aktivieren/beenden/Tier wechseln nicht mehr per Chat-Tool. Palette-Suchfeld-Hoehe korrigiert.
- v0.1.605: Kein Deadlock im Warten-Node: nach maxHours geht der Lauf mit den fertigen Firmen weiter (offene bleiben state=pending, Filter laesst sie aus). Producer structured-content: kein Suchergebnis = echter Fehler (rot, sofort), nur nachweislich unerreichbares Portal = Zeitueberschreitung (orange).
- v0.1.606: Producer company-publication: keine Veroeffentlichungen = uebersprungen (kein Fehler); Portal unerreichbar oder Button reagiert nicht = Zeitueberschreitung (orange); fehlendes Element = Fehler (rot, sofort).
- v0.1.607: Fortsetzen nach Neustart: Laeufe, die beim Beenden/Update im Warten-Node standen, werden 20 s nach dem Start automatisch fortgesetzt (gespeicherte Ausgaben der fertigen Nodes werden geliefert, der Warten-Node laeuft neu an, $('Node')-Bezuege bleiben gueltig). Unterbrechung in anderen Nodes → als abgebrochen markiert mit Hinweis (kein doppelter Schreib-Schritt). Kein falsches „Laeuft“ mehr.
- v0.1.608: Producer-Vorpruefung „bereits verarbeitet“ (website, company-profile, company-contact, company-publication; Frist 7 Tage, env AVA_FRESH_SKIP_DAYS; Folge-Ereignisse aus Gateway-Kanon; LLM-Upgrade rechnet). „uebersprungen“ gilt fuer Warten-Node, Filter und Vorgangs-Meldung als fertig. Nicht abgedeckt: company-evaluation (ICP-Bewertung soll bei geaendertem ICP neu laufen), structured-content hat bereits 30 Tage.
- v0.1.609: Kette haengt nicht mehr am Handelsregister: structured-content loest bei Fehler die Folge-Ereignisse aus Stammdaten aus; Gateway wiederholt nur voruebergehende Fehler automatisch (retry-policy.ts, deployt 2026-09-09); Register-Formularfelder ohne 2-Minuten-Wartezeit.
- v0.1.610 (Operator-Entscheidung): Passives Warten. Warten-Node mit Vorgang haelt keinen Timer mehr: Firmen gehen einzeln an die Folge-Schritte, sobald ihre Stufen fertig sind; der Lauf pausiert mit Status „wartet“ (WorkflowExecution.waiting), der Scheduler fuehrt ihn im Minutentakt weiter (runner.continueWaiting, Fortsetzungs-Mechanik aus v0.1.607, ueberlebt Neustarts). Sicherheitsnetz maxDays (Standard 14), danach Ende mit den fertigen Firmen. Gesamt-Zeitlimit gilt nur fuer aktive Rechenzeit. Abbrechen waehrend des Wartens moeglich.
