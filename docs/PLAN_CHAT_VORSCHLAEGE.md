# Plan: Nächste Schritte im Chat (mehrstufige, dynamische Vorschläge)

Stand 2026-09-14, Desktop v0.1.646. V0 und V1 umgesetzt (Willkommenstext neu
mit dynamischer Tool-Zahl; `main/suggestions/nutzerstand.ts`,
`main/suggestions/faehigkeiten.ts` mit 34 Gruppen, IPC `suggestions:*`,
Chat-Tool `vorschlaege_status`, Test `npm run test:suggestions`).
V2 umgesetzt in v0.1.647: `main/suggestions/erzeugung.ts` (KI-Chips ueber den
Hintergrundkanal, Cache je Nutzerstand und Tag, harte Schranke gegen unbekannte
Integrationen, gesperrte Module, Erledigtes und Verwaltung, feste Rueckfalliste),
IPC `suggestions:startseite`, Org-Feature `vorschlaege` (aus = nur feste Liste).
V3 umgesetzt in v0.1.648: `components/chat/VorschlagChips.tsx`, Chips auf der
Startseite (unter dem neuen Lede) und unter der Willkommensnachricht; Klick sendet
den Auftrag plus versteckten Kontextsatz `[Vorschlag: …]`, der im Bubble als Badge
erscheint. V4 umgesetzt in v0.1.649: Frame `suggestions`, Orchestrator ruft nach jedem
normalen Turn (nicht autonom, nicht abgebrochen, nicht Welcome) `gespraech()` in
`erzeugung.ts` auf: Urteil ueber Hintergrundkanal, Standard leer, max. 3 Chips,
Verwaltung nur, wenn der Nutzer sie selbst anspricht; Renderer haengt die Chips
unter die Antwort, naechster Turn raeumt sie weg. V5 offen.

## 1. Ziel

Der Chat wird zur Zentrale. AVA schlägt dem Nutzer konkrete, ausführbare
Aktionen vor, die zu seinem Stand passen: auf der Chat-Startseite immer, im
laufenden Gespräch nur, wenn sich aus dem Kontext etwas anbietet. Erledigtes
(HubSpot verbunden, ICP vorhanden) wird auf der Startseite nicht mehr
vorgeschlagen. Unnützes wird nicht angezeigt. Verwaltung (Abrechnung, Konto,
Schlüssel) kommt nur vor, wenn der Nutzer selbst davon spricht.

## 2. Ist-Zustand

- Startseite (`renderer/routes/Chat.tsx`, leerer Verlauf): Überschrift
  „Womit fangen wir heute an?“, ein statischer Absatz, darüber die
  ICP-Vorschlagskarte (`IcpProposalCard`), solange kein ICP existiert.
  Keine Aktionen.
- „Hi“/„Was kannst du?“: fester Text in `main/agent/welcome.ts`
  (`WELCOME_MESSAGE`), ohne LLM. Stand Mai: nennt Skills als Kern, „über 160
  Werkzeuge“, kein Firmen-Radar, keine Workflows, kein Telegram, keine
  E-Mail-Ableitung, keine Organisation; Zahlen veraltet (heute 241 Tools).
- Tools tragen `summary` und `category` (`agent/types.ts`), aber keine
  Kennzeichnung „produktiv“ vs. „Verwaltung“ und keine Stufen.
- Zustandssignale existieren verstreut im Main-Prozess: `auth`, `icpStore`
  (`isSet`, `isComplete`), `radarSupervisor.getConfig`, `crmManager.
  getAllStatuses`, `mailSupervisor.snapshot`, Telegram-Client-Status,
  `workflowService.list`, Transaktionen, Watchlist, E-Mail-Muster, Policy
  (`useFeature`, Anbieter-Sperre) und Plan-Tier. Kein gemeinsames Modell.
- Stream-Frames (`AgentStreamFrame`): token, tool-call, tool-result,
  choice-/text-/match-request, navigate, error, done. Kein Frame für
  Vorschläge.

## 3. Architektur

### 3.1 Nutzerstand (`main/suggestions/nutzerstand.ts`)

Deterministisch, ohne LLM, in unter 50 ms aus vorhandenen Stores:

```
{
  verbindungen: { mail, telegram, hubspot, notion, obsidian, linkedin },   // je: "verbunden" | "offen" | "gesperrt"
  icp: "fehlt" | "unvollstaendig" | "vollstaendig",
  radar: { aktiv, kandidatenOffen, heisseTreffer, topTreffer: {name, discoveryId, score} | null },
  firmen: { importiert: number, letzterImportAt },
  workflows: { anzahl, letzterLaufAt },
  skills: { eigene: number },
  watchlist: { personen: number },
  emailAbleitung: { aktiv },
  modell: { bereit, sStufe },        // S-Stufe für Workflow-Anlage
  plan: "free" | "starter" | "pro" | "enterprise",
  policy: { gesperrteModule: string[] },
  organisation: { mitglied, admin }
}
```

Gesperrte Module (Feature-Policy) und gesperrte Anbieter fallen komplett
raus, nach der Regel „Gesperrtes ist unsichtbar“.

### 3.2 Aktionskatalog (`main/suggestions/katalog.ts`)

Kuratierte Liste, keine automatische Ableitung aus 241 Tools. Je Aktion:

```
{
  id: "hubspot_verbinden",
  stufe: 1,
  titel: "HubSpot verbinden",
  beschreibung: "Firmen und Kontakte mit deinem CRM abgleichen",
  icon: "hubspot",
  voraussetzung: (s) => s.verbindungen.hubspot === "offen",
  erledigt: (s) => s.verbindungen.hubspot === "verbunden",
  ausfuehrung: { art: "navigation", pfad: "/settings/crm" }
                | { art: "prompt", text: "Starte den Firmen-Radar für meine Region" }
                | { art: "tool", name: "discovery_scan", args: {...} }
}
```

Stufe 1 (Anschluss): Mail-Postfach, Telegram, HubSpot, Notion/Obsidian,
LinkedIn-Beobachter, lokales Modell laden, wenn kein Modell bereit.
Stufe 2 (Aufbau): ICP erstellen bzw. vervollständigen, Radar starten,
Radar-Automatik einschalten, Firmen aus HubSpot importieren, Excel-Liste
importieren, E-Mail-Ableitung einschalten, erste Person auf die Watchlist.
Stufe 3 (Routine): Workflow anlegen (nur mit S-Stufen-Modell), „ICP- und
Marktanalyse zu {Top-Treffer}“ (Platzhalter aus `radar.topTreffer`),
Kurzprofil des heißesten Kandidaten per Telegram, Best-Match über die
Bestandskunden, Recherche mit der Organisation teilen.

Bewusst nicht im Katalog: Abrechnung, Konto, Schlüssel/Anbieter, Organisation
verwalten, Löschen. Diese Tools bleiben im Chat nutzbar, werden aber nie
vorgeschlagen, es sei denn, der Kontextpfad (3.4) erkennt die Absicht des
Nutzers ausdrücklich.

Platzhalter (`{topTreffer}`, `{firma}`) werden beim Rendern aus dem
Nutzerstand gefüllt; fehlt der Wert, entfällt die Aktion.

### 3.3 Startseite: deterministisch, immer da

`GET suggestions:start` (IPC) liefert bis zu vier Aktionen:

1. Alle Katalogaktionen filtern: Voraussetzung erfüllt, nicht erledigt,
   Modul nicht gesperrt, Plan reicht, nicht ausgeblendet (3.6).
2. Reihenfolge: niedrigste offene Stufe zuerst, innerhalb der Stufe eine
   feste Priorität; mindestens eine Aktion der nächsthöheren Stufe, damit
   auch Neue sehen, wohin es geht (z. B. „Firmen-Radar starten“ neben
   „HubSpot verbinden“).
3. Kein LLM-Aufruf. Keine Kosten, sofort, deterministisch, testbar.

Ersetzt den statischen Absatz unter „Womit fangen wir heute an?“; die
`IcpProposalCard` geht im Katalog auf (Aktion „ICP erstellen“).

### 3.4 Im Gespräch: KI-bewertet, standardmäßig nichts

Nach jedem `done`-Frame eines normalen Turns (nicht nach Fehler, Abbruch,
Welcome-Text, Freigabe-Rückfragen):

- Eingabe für ein kurzes Urteil: letzte Nutzer-Nachricht, letzte
  Assistenten-Antwort (gekürzt), aufgerufene Tools des Turns, Nutzerstand
  (kompakt), Katalog als Liste `id: titel` inklusive der Verwaltungs-
  aktionen, damit „ich will auf Pro wechseln“ erkannt wird.
- Ausgabe: JSON `{ vorschlaege: [{ id, grund }] }`, 0 bis 3 Einträge, per
  yup validiert, unbekannte IDs verworfen. Anweisung: „Nur vorschlagen,
  wenn der nächste Schritt aus dem Gespräch offensichtlich ist. Im Zweifel
  leer.“
- Modell: Hintergrundkanal (`channel: "background"`), günstiges Modell
  (Provider-Standard für Hintergrund oder lokal), Zeitlimit 8 s; Fehler
  oder Zeitüberschreitung ergeben keinen Vorschlag. Kein Aufruf im reinen
  Abo-Chat ohne Hintergrundzugang.
- Ausgabe als neuer Frame `{ kind: "suggestions", conversationId,
  messageId, items }`, angehängt an die letzte Assistenten-Nachricht;
  verschwindet, sobald der Nutzer weiterschreibt. Nicht persistiert.
- Deckel: höchstens ein Urteil je Turn, keines, wenn der Turn selbst schon
  eine Rückfrage (choice/text-request) enthält.

### 3.5 Ausführung

Klick auf eine Aktion:
- `prompt`: der Text erscheint als Nutzer-Nachricht im Verlauf und wird
  normal verarbeitet (transparent, kein versteckter Tool-Aufruf).
- `tool`: läuft über den Orchestrator wie ein Slash-Befehl, mit den
  üblichen Bestätigungen (confirmAction) für schreibende Schritte.
- `navigation`: Route öffnen (Einstellungen → CRM), danach zurück.

### 3.6 Ausblenden und Merken

Jede Aktion hat „Ausblenden“. Gemerkt in `userData/suggestions.json`:
ausgeblendete IDs mit Ablauf (30 Tage), plus „nie wieder“ je Aktion.
Erledigtes ergibt sich aus dem Nutzerstand, nicht aus Klicks.

### 3.7 Einstellung und Chat-Tool

Einstellung „Vorschläge im Gespräch“ (an/aus, Standard an) und
„Vorschläge auf der Startseite“ (an/aus). Nach der Self-Service-Regel als
Tool `vorschlaege_config` mit Bestätigung; `vorschlaege_status` zeigt
Nutzerstand und aktuelle Startseiten-Vorschläge (auch fürs Debugging).

## 4. Willkommenstext erneuern (`welcome.ts`)

- Abschnitte neu: Recherche & Import; Firmen-Radar mit ICP; Workflows;
  Meldungen unterwegs (Telegram); CRM & Wissen (HubSpot, Notion, Obsidian);
  Beobachten (LinkedIn-Signale, Personen-Watchlist, Link-Monitor); Mail;
  Kontakte mit Beleg und E-Mail-Ableitung; Teams (Organisation, Teilen,
  zentrale Schlüssel); Lokal & privat mit der präzisen Formulierung aus den
  Website-Regeln (eigene Daten bleiben lokal, öffentliche Firmendaten im
  geteilten Bestand).
- Zahl der Werkzeuge nicht mehr hart, sondern aus der Registry eingesetzt.
- Skills bleiben, aber als Unterpunkt, Workflows sind der Hauptweg.
- Der Text endet nicht mehr mit der ICP-Aufforderung, sondern mit dem
  Satz „Unten habe ich dir passende nächste Schritte vorbereitet“, und der
  Renderer hängt die Startseiten-Vorschläge (3.3) als Chips an diese
  Nachricht. Damit ist der Welcome-Text stufengerecht, ohne LLM.
- Weiterhin fester Text, keine Halluzination; jede Behauptung gegen den
  Website-Stand geprüft (docs/WEBSITE_PROMPT_*).

## 5. UI

- Chips wie im ChatGPT-Beispiel: Zeile je Aktion mit Icon, Titel,
  gedämpfter Beschreibung, rechts der Aktionsbegriff („Verbinden“,
  „Starten“, „Anlegen“); Hover zeigt „Ausblenden“. Maximal vier auf der
  Startseite, maximal drei im Verlauf.
- Startseite: unter dem Lede, oberhalb des Eingabefelds.
- Verlauf: unter der letzten Assistenten-Nachricht, dezent, mit
  Einleitung „Nächster Schritt?“; verschwindet beim nächsten Turn.
- Kein Geviertstrich, Du-Form, keine unterstrichenen Buttons.

## 6. Umsetzungsschritte

| Schritt | Inhalt | Dateien | Aufwand |
|---|---|---|---|
| V0 | Willkommenstext erneuern, Tool-Zahl dynamisch | `welcome.ts`, `orchestrator.ts` | klein |
| V1 | Nutzerstand-Modell + IPC + Tests | `main/suggestions/nutzerstand.ts`, `index.ts`, `preload` | mittel |
| V2 | Katalog Stufe 1–3 mit Prädikaten, Startseiten-Auswahl, Ausblenden-Store | `main/suggestions/katalog.ts`, `auswahl.ts`, `store.ts` | mittel |
| V3 | Renderer: Chips auf Startseite + an Welcome-Nachricht, Ausführung (prompt/tool/navigation) | `Chat.tsx`, `components/chat/Vorschlaege.tsx`, `styles.css` | mittel |
| V4 | Gesprächs-Vorschläge: Urteil nach `done`, Frame `suggestions`, Deckel | `orchestrator.ts`, `main/suggestions/urteil.ts`, `shared/types.ts` | mittel |
| V5 | Einstellung + Tools `vorschlaege_config` / `vorschlaege_status`, Doku, TOOLS.md | `agent/tools/vorschlaege.ts`, Settings | klein |

V0 bis V3 sind ohne KI-Kosten und sofort nutzbar; V4 kommt danach.
Tests: Nutzerstand aus Fixtures, Katalog-Prädikate je Stufe, Auswahl
(Erledigtes fehlt, Gesperrtes fehlt, Platzhalter gefüllt), Urteil-Parser
mit leerer und ungültiger Antwort.

## 7. Präzisierung nach Rückmeldung (2026-09-14)

Der Operator hat drei Punkte geklärt; sie ersetzen die Abschnitte 3.2, 3.3,
3.5 und 3.6, soweit sie widersprechen.

**Chips sind Anstöße, keine vorberechneten Tool-Ketten.** Ein Chip ist ein
kurzer Auftrag in Nutzersprache („HubSpot verbinden“, „Firmen-Radar für
meine Region starten“, „ICP- und Marktanalyse zu Müller GmbH“). Klick sendet
diesen Auftrag, angereichert um einen versteckten Kontextsatz (Stufe, Grund,
relevante IDs wie discoveryId), als Nutzer-Nachricht in den Chat. Von da an
arbeitet AVA wie bei jeder Anfrage: sie lädt und ruft alle Tools, die nötig
sind, in der Reihenfolge, die sich ergibt. Es gibt keinen Katalog mit
Tool-Zuordnung mehr.

**AVA muss wissen, was möglich ist.** Damit kein Chip „Mit Facebook
verbinden“ entsteht, bekommt das erzeugende Modell zwei Dinge:
1. die **Fähigkeitenliste**: alle geladenen Tools als `kategorie: summary`
   (aus der Registry, gefiltert um gesperrte Module und Anbieter, ohne
   Verwaltungskategorien wie Abrechnung, Konto, Schlüssel), plus die
   bekannten Integrationen mit Zustand;
2. den **Nutzerstand** (3.1), inklusive „schon erledigt“. Die Anweisung
   lautet ausdrücklich: „Schlage nichts vor, was bereits erledigt ist oder
   keinen Nutzen hätte (HubSpot verbinden, wenn HubSpot verbunden ist).
   Schlage nur vor, was mit den gelisteten Fähigkeiten tatsächlich geht.“
   Kein Ausblenden-Speicher, kein „nie wieder“; der Stand ist die
   Wahrheit.

Nachgelagert prüft der Code jeden Chip gegen die Fähigkeitenliste: Nennt
der Chip eine Integration oder Funktion, die nicht existiert oder gesperrt
ist, fällt er weg. Das ist die harte Schranke gegen Erfindungen; das Modell
ist die weiche.

**Startseite ebenfalls KI-erzeugt, mit Cache.** Beim Öffnen der leeren
Chat-Seite werden vier Chips erzeugt (Stufenlogik im Prompt: erst
Anschluss, dann Aufbau, dann Routine, dazu ein Ausblick auf die nächste
Stufe, Platzhalter wie der Top-Radar-Treffer aus dem Nutzerstand). Das
Ergebnis wird gecacht und nur neu erzeugt, wenn sich der Nutzerstand
ändert oder der Tag wechselt. Ist kein Modell bereit, zeigt die Seite
eine kleine feste Liste (Modell einrichten, ICP erstellen, Radar starten),
damit die Seite nie leer ist.

**Im Gespräch** bleibt 3.4: nach jedem Turn ein kurzes Urteil, Standard
leer. Auch hier erzeugt das Modell den Chip-Text frei, gestützt auf
Fähigkeitenliste und Nutzerstand, und der Code prüft nach.

**Modell:** Startseite und Gesprächs-Urteil laufen über den
Hintergrundkanal mit dem günstigsten bereiten Modell (lokal bevorzugt),
nie über das Chat-Modell des Nutzers. Zeitlimit 8 s, danach Cache bzw.
kein Chip.

**Organisation:** neuer Schalter in den Organisations-Vorgaben
„Vorschläge im Chat“ (an/aus, Standard an). Aus heißt: keine Erzeugung,
keine Chips, keine Kosten; die Startseite zeigt dann nur die feste Liste
ohne Modellaufruf. Verbrauch über den Organisationsschlüssel wird in der
Verbrauchsübersicht als „Vorschläge“ ausgewiesen.

**Zusammengesetzte Aufträge wie „ICP- und Marktanalyse“** brauchen keinen
eigenen Baustein: Der Chip löst den Auftrag aus, AVA plant die Kette aus
Profil, Register, Publikationen, ICP-Urteil und Wettbewerb selbst, wie sie
es heute bei einer entsprechenden Frage im Chat auch täte. Ob die Qualität
solcher langen Ketten reicht, zeigt der Test; falls nicht, wird daraus
später ein Workflow-Template.

Umsetzungsschritte (ersetzt Tabelle in 6): V0 Welcome-Text; V1 Nutzerstand
+ Fähigkeitenliste; V2 Chip-Erzeugung Startseite mit Cache, Nachprüfung
und fester Rückfalliste; V3 Renderer-Chips + Klick sendet Auftrag mit
Kontextsatz; V4 Gesprächs-Urteil nach `done`; V5 Org-Schalter, Einstellung,
Chat-Tools, Verbrauchs-Ausweis.

## 8. Ursprünglich offene Entscheidungen (historisch)

1. Modell für das Gesprächs-Urteil: Hintergrund-Standard des Nutzers oder
   bevorzugt lokal (Ollama), um Kosten je Turn bei null zu halten? Vorschlag:
   lokal, wenn vorhanden, sonst Hintergrund-Standard, nie das Chat-Modell.
2. Anzahl Chips (Vorschlag 4 Startseite, 3 Verlauf).
3. Ausblenden-Dauer (Vorschlag 30 Tage) und ob „nie wieder“ angeboten wird.
4. Sollen Vorschläge im Verlauf auch in Organisationen mit Anbieter-Sperre
   laufen (Urteil über den Organisationsschlüssel, zählt gegen Budget)?
   Vorschlag: ja, aber im Verbrauch als „Vorschläge“ ausgewiesen.
5. „ICP- und Marktanalyse zu {Top-Treffer}“ existiert heute nicht als ein
   Tool; das wäre ein neuer zusammengesetzter Ablauf (Profil, Register,
   Publikationen, ICP-Urteil, Wettbewerb) und gehört als eigener Punkt
   geplant, bevor die Aktion in Stufe 3 erscheint.
