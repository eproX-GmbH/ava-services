# Plan: Abgestufte Autonomie („Vollmacht") für Mail- und Telegram-Kanal

Stand: 2026-08-30 · Status: ENTWURF, wartet auf Freigabe

## 1. Ausgangslage und Einordnung

User-Feedback (Telegram-Transcript): AVA findet die HubSpot-Firma, kann
die Aktivität aber nicht anlegen — „das Tool erzwingt im Auto-Modus eine
Rückfrage". Gleiches Grundproblem bei Mail-Triage.

**Wichtige Einordnung vorab:** Für Telegram existiert die
Rückfrage-Mechanik bereits — T6 „Rückfragen aufs Handy" ist in v0.1.459
released (gleicher Tag): opt-in Schalter Settings → Telegram →
„Rückfragen aufs Handy erlauben". Damit stellt `ask_user_choice`/
`ask_user_text` die Frage direkt im verknüpften Chat (nummerierte
Optionen, Antwort per Nummer/Text, 3-Minuten-Timeout, „abbrechen").
Das Transcript zeigt das ALTE Verhalten — Build < 0.1.459 oder Toggle
aus (Default ist bewusst AUS). Der konkrete HubSpot-Fall wäre mit T6
bereits gelöst: AVA fragt „Aktivität so anlegen? 1) Ja 2) Abbrechen".

Was T6 NICHT löst:

1. **Mail** hat kein Rückfrage-Pendant und kann keins bekommen, das
   blockiert: Ein Tool-Call kann nicht Minuten bis Stunden auf eine
   Antwort-Mail offen gehalten werden.
2. **Komfort**: T6 macht jede einzelne Aktion bestätigungspflichtig.
   Wer AVA regelmäßig vom Handy aus arbeiten lässt, will Routine-Writes
   (Notiz, Aktivität, Task) nicht einzeln abnicken.

## 2. Sicherheits-Rahmen (nicht verhandelbar)

- Eingehender Text (Mail-Body, Telegram-Text, transkribierte Voice) ist
  IMMER Injection-gefährdet. Trusted-Allowlist und injectionRisk-
  Classifier sind Heuristiken, keine Garantien; Absender sind fälschbar,
  Postfächer kompromittierbar.
- Deshalb gibt es KEINEN binären „AVA darf alles"-Modus. Stattdessen
  abgestufte Vollmacht nach Wirkungsklasse der Aktion.
- **Destruktives bleibt immer bestätigungspflichtig** (Desktop-Dialog
  oder Telegram-Remote-Ask): `crm_delete_*`, `notion_delete_page`,
  Mail/Forward an Empfänger außerhalb der Allowlist. Keine Vollmacht-
  Stufe deckt das ab.

## 3. Wirkungsklassen der Confirm-Gates (Ist-Inventar)

~35 `askChoice`-Stellen in Tools, davon 16 in crm.ts. Drei Klassen:

| Klasse | Wirkung | Beispiele (Ist-Gates) |
|---|---|---|
| **A additiv** | erzeugt Neues, reversibel, überschreibt nichts | crm_create_hubspot_note / _task / _activity (crm_log_hubspot_activity), crm_create_hubspot_company / _contact / _deal, crm_link_manual, crm_associate_hubspot_objects, Notion/Obsidian-Page anlegen, Import anstoßen |
| **B verändernd** | überschreibt bestehende Werte | crm_update_hubspot_company, crm_enrich_hubspot_company_from_ava, crm_sync_hubspot_company_from_ava, crm_disassociate_hubspot_objects, Watch/Scheduler ändern |
| **C destruktiv / eskalierend** | löscht oder verlässt den Vertrauensraum | crm_delete_hubspot_*, notion_delete, mail_send/forward an nicht-Allowlist, Werksreset-nahe Aktionen |
| **D Disambiguierung** | keine Genehmigung, sondern echte Auswahlfrage („welche Firma meinst du?") | Match-Auswahl in crm/imports |

Klasse D ist KEINE Vollmacht-Frage: Sie braucht immer eine echte
Antwort → Telegram: T6-Remote-Ask; Mail: Agent entscheidet selbst oder
fragt in der Antwort-Mail (heutiges Verhalten ist dort richtig).

## 4. Soll-Design

### 4.1 Neues UiBridge-API: `confirmAction`

```ts
ctx.ui.confirmAction({
  kind: "additive" | "mutating" | "destructive",
  prompt: string,          // wie bisheriger askChoice-Text
  confirmValue: string,    // Wert, der „Ja" bedeutet (z. B. "send")
  options: AgentChoiceOption[],
}, signal): Promise<string>
```

Auflösungsreihenfolge:

1. **Interaktiv** (Desktop-Chat): wie heute askChoice.
2. **Autonom + Vollmacht deckt `kind`**: sofort `confirmValue`
   zurückgeben + AUDIT-Eintrag „autonom bestätigt (Vollmacht additiv,
   Kanal mail)" mit vollem Prompt-Text. Der Nutzer kann jede autonome
   Entscheidung nachlesen.
3. **Autonom + RemoteAsk vorhanden** (Telegram T6): Rückfrage im Chat.
4. **Sonst**: throw wie heute (fail-closed).

`askChoice` selbst bleibt unverändert (Klasse D nutzt es weiter).

### 4.2 Vollmacht-Einstellungen (opt-in, Default „keine")

- **Mail** (Settings → Mail): „Vollmacht im Auto-Modus:
  keine | additiv". Bewusst OHNE Stufe „verändernd" — Mail ist der
  injection-exponierteste Kanal.
- **Telegram** (Settings → Telegram): „Vollmacht:
  keine | additiv | additiv+verändernd". Kombiniert mit T6: Was die
  Vollmacht nicht deckt, wird zur Telegram-Rückfrage statt zu werfen.
- Plumbing: `startAutonomousConversation` bekommt `autonomyLevel`,
  landet in Conversation → ToolContext/UiBridge (gleiches Muster wie
  `remoteAsk` in v0.1.459).

### 4.3 Migration der Gates

Phase 1 migriert nur die Klasse-A-Gates auf `confirmAction`
(die 8 CRM-Creates + link/associate) — das ist der konkrete
Schmerzpunkt aus dem Transcript. Klasse B folgt, wenn die Telegram-
Stufe „verändernd" gebaut wird. Klasse C wird NICHT migriert
(bleibt askChoice → nie autonom).

### 4.4 Mail: gesammelte Rückfragen (Phase 2, optional)

Users Alternativvorschlag — „AVA nennt die offenen Rückfragen, ich
beantworte alle, AVA macht weiter":

- Nicht gedeckte Aktionen wirft confirmAction mit strukturiertem
  Fehler; der mail-triage-Skill weist an, sie am Ende der Antwort-Mail
  nummeriert aufzulisten („Antworte mit ‚Ja zu 1 und 3'").
- Der Folge-Turn hat seit v0.1.461 den Thread-Verlauf und erkennt die
  Zustimmung; die Zustimmungs-Mail muss selbst trusted sein (ist
  Trigger-Bedingung ohnehin).
- Autorisierung gilt nur für Klasse A/B, nie C — und nur für die im
  Verlauf konkret benannten Aktionen.
- Bewertung: erhöhter Injection-Angriffswert („Ich stimme zu" in
  manipulierter Mail) → erst nach Praxis-Erfahrung mit Phase 1
  entscheiden, ob der Zusatznutzen das Risiko trägt. Mit Mail-Vollmacht
  „additiv" entfällt der häufigste Fall bereits.

## 5. Aufwand & Reihenfolge

| Schritt | Inhalt | Aufwand |
|---|---|---|
| V1 | confirmAction in UiBridge + autonomyLevel-Plumbing (Conversation/ToolContext) + Audit | ~½ Tag |
| V2 | Klasse-A-Gates migrieren (crm.ts: 8 Creates + link/associate; imports) | ~½ Tag |
| V3 | Settings-UI: Mail-Vollmacht (keine/additiv), Telegram-Vollmacht (keine/additiv/verändernd) + Hinweistexte | ~½ Tag |
| V4 | Klasse-B-Gates migrieren + Telegram-Stufe „verändernd" | ~½ Tag |
| V5 | *(optional)* Mail deferred-consent (gesammelte Rückfragen) | ~1 Tag, eigene Sicherheitsabnahme |

Empfehlung: V1–V3 als ein Release; V4 direkt danach; V5 zurückstellen.

## STATUS

- **V1–V3 umgesetzt (v0.1.462):** `confirmAction` + `autonomyCovers` in
  ui-bridge.ts (Auflösung: interaktiv → Vollmacht-Auto-Confirm mit
  Audit → Telegram-Remote-Ask → throw); `autonomyLevel` durch
  Conversation/Orchestrator/UiBridge geplumbt (Muster remoteAsk);
  Audit-Senke via Orchestrator-onAudit → zentraler Trail (category
  agent, action agent.autonomy.autoConfirm). 8 Klasse-A-Gates in
  crm.ts migriert (link_manual, associate, note, activity, task,
  company, contact, deal). Settings: Mail-Checkbox „Vollmacht: Neues
  anlegen" (none|additive, PGlite-Spalte autonomy_level), Telegram-
  Select none|additive|mutating (setzt Eingang voraus). Der
  Auto-Triage-Systemprompt spiegelt T6-Rückfragekanal + Vollmacht
  (hasRemoteAsk/autonomyLevel statt pauschalem „ask_user_* verboten").
  Deckungsmatrix + Auflösungsreihenfolge per Bundle-Smoke verifiziert;
  destruktiv ist von keiner Stufe gedeckt, geht mit T6 aber als
  Rückfrage in den Chat (gültige Bestätigung).
- **V4 umgesetzt (v0.1.463):** Die 6 Klasse-B-Gates in crm.ts auf
  `confirmAction(kind: "mutating")` migriert (update_hubspot_company,
  generisches Objekt-Update, disassociate, complete_task,
  sync_from_ava, enrich_from_ava) — die Telegram-Stufe „verändernd"
  deckt sie jetzt wirklich. Zusätzlich crm_delete_hubspot_* auf
  `kind: "destructive"` umgestellt (verhaltensgleich: nie autonom, mit
  T6 als Chat-Rückfrage, sonst throw — aber deklarierte Klasse +
  präzise Fehlermeldung). Einzige verbleibende askChoice-Stelle in
  crm.ts ist die Dubletten-Disambiguierung (Klasse D, korrekt so).
  Confirm-Gates außerhalb crm.ts (Notion/Obsidian/Scheduler/Watches/
  Imports) bleiben vorerst askChoice — migrieren, wenn sie im
  Auto-Modus praktisch gebraucht werden.
- Offen: V5 (Mail deferred-consent, zurückgestellt).
