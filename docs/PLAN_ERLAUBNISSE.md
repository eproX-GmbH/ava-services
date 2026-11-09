# Plan: Erlaubnisse überarbeiten („Nur dieses Mal“ / „Immer erlauben“)

Stand 2026-11-09, Anstoß Joyce (Feedback Patrick: zehnmal „Entwurf ablegen?“ bestätigen):
„Eine wiederkehrende Aktion immer wieder abzufragen ist total sinnfrei. Einmal ist OK, dann
muss man ‚Immer erlauben‘ oder ‚Nur ein Mal erlauben‘ wählen können, wie bei
Betriebssystemen.“ Und: „Auch bei löschenden Aktionen sollte eine einmalige Freigabe auch
bei Bulk-Operationen ausreichen, wenn der Nutzer das explizit freigegeben hat.“
Vorgänger: docs/PLAN_VOLLMACHT.md (Wirkungsklassen, globaler Modus seit v0.1.468).

## 1. Ist-Stand (Code geprüft)

| Baustein | Heute |
|---|---|
| Chat-Modus am Eingabefeld | Manuell / Halb-auto / Voll-auto = Vollmacht `none` / `additive` / `mutating`, gilt global (Chat, Telegram, Workflows) |
| `UiBridge.confirmAction` | 30 Dateien, 83 Stellen: 53 additiv, 21 ändernd, 9 löschend. Deckt der Modus die Klasse, kein Dialog (mit Audit) |
| Löschend (`destructive`) | fragt IMMER, keine Stufe deckt es (Unternehmen entfernen, Import löschen, CRM-Löschungen, Fokus-Thema, Relevanz, Organisation, Workflow löschen, Freigabe entziehen, Umzug) |
| Direkte `askChoice`-Rückfragen | 18 Stellen (u. a. `mail_send` an Empfänger außerhalb der Allowlist, Notion, Obsidian, Zeitpläne, Beobachtungen, Profil, Skills). Laufen am Modus vorbei, also auch an jeder künftigen Dauer-Erlaubnis |
| Mail-Triage (eingehende Mails) | auf höchstens `additive` geklammert (Prompt-Injection), `ohneVollmacht` → `none` |
| Workflows | Stufe = min(Workflow-Deckel, Chat-Modus); Schritt `confirmed` → `mutating` (nicht löschend); `mail_send`/`mail_forward` brauchen `confirmed`; **je Item eine Freigabe** bei `perItem`; Freigabe verfällt nach 48 h |
| Obergrenzen | `maxItemsPerRun` 500 (max. 5000), `maxMailsPerDay` 20 je Workflow |
| Sammel-Aktionen | meist eine Bestätigung je Aufruf, also je Eintrag; Sammel-Werkzeug bisher nur für Entwürfe (in Arbeit) |
| Übersicht/Widerruf | gibt es nicht (nur Audit-Protokoll) |

### Probleme
1. Wiederkehrendes fragt immer wieder, im Chat und in Workflows sogar je Eintrag.
2. Der Chat-Modus bremst Workflows, obwohl ein Workflow bewusst angelegt wurde.
3. Löschendes ist nie dauerhaft erlaubbar; ein Sammel-Löschen ergibt N Dialoge.
4. 18 Rückfragen laufen am Modell vorbei (uneinheitlich, nicht erlaubbar).
5. Keine Übersicht, was dauerhaft erlaubt ist, und kein Widerruf.

## 2. Soll-Konzept

### 2.1 Ein Dialog für alles
Jede Erlaubnisfrage bietet dieselben drei Antworten:
- **Nur dieses Mal erlauben**: gilt für genau diesen Aufruf, bei Sammel-Aufrufen für alle
  enthaltenen Einträge.
- **Immer erlauben**: dauerhaft für dieses Werkzeug; künftige Aufrufe laufen ohne Frage
  (mit Audit-Eintrag).
- **Ablehnen**.

Löschende Aktionen bekommen dieselben Antworten. Bei „Immer erlauben“ steht ein klarer Hinweis
dabei („löscht künftig ohne Rückfrage“).

### 2.2 Sammel-Aktionen
Eine Bestätigung deckt den ganzen Aufruf ab. Werkzeuge, die üblicherweise viele Einträge
betreffen (Entwürfe ablegen, Importe, Löschen, CRM-Übernahmen), nehmen Listen an. Das Modell
soll sie gesammelt aufrufen statt in einer Schleife (Prompt-Regel).

### 2.3 Workflows
- Beim Anlegen fragt AVA einmal: „läuft selbstständig“ oder „vorher fragen“ (gebaut).
  „Selbstständig“ gibt alle Schreib-Schritte frei, auch löschende.
- Der Chat-Modus gilt nicht mehr für Workflows; maßgeblich ist die Einstellung des Workflows.
- Eine Freigabe im Lauf gilt **je Schritt und Lauf** (alle Einträge), nicht je Eintrag.
  Antworten: „Für diesen Lauf freigeben“, „Immer freigeben“ (Schritt dauerhaft frei),
  „Ablehnen“. Gleich in der App, als Meldung und über Telegram (`/immer <id>`).
- Dauer-Erlaubnisse aus dem Chat gelten auch im Workflow (je Werkzeug).

### 2.4 Übersicht und Widerruf
- Einstellungen → neuer Abschnitt „Erlaubnisse“: Liste der dauerhaften Erlaubnisse
  (Werkzeug in Klartext, seit wann), einzeln oder alle widerrufen; dazu je Workflow
  „selbstständig“ an/aus.
- Chat-Werkzeug `erlaubnisse` (zeigen/widerrufen), nach der Self-Service-Regel.

### 2.5 Was gleich bleibt (Sicherheit)
- Jede automatische Bestätigung landet im Audit-Protokoll.
- Eingehende Mails (Mail-Triage) bleiben geklammert: Dort wirken Dauer-Erlaubnisse nur
  für additive Aktionen. Ein fremder Absender könnte sonst über Prompt-Injection eine
  dauerhaft erlaubte Lösch- oder Sende-Aktion auslösen.
- Die 18 direkten Rückfragen werden auf `confirmAction` mit Wirkungsklasse umgestellt,
  damit Modus, Dauer-Erlaubnis und Audit überall gleich greifen.

## 3. Stufen

- **E1** Dauer-Erlaubnis-Speicher je Konto + Dialog „Nur dieses Mal / Immer / Ablehnen“
  in `confirmAction` (Chat, Telegram, PWA-Relais); löschend inklusive, Mail-Triage
  geklammert. *(Grundgerüst angefangen, nicht committet.)*
- **E2** 18 `askChoice`-Rückfragen auf `confirmAction` umstellen.
- **E3** Workflows: eigene Einstellung statt Chat-Modus; Freigabe je Schritt und Lauf;
  „Immer freigeben“ in App, Meldung, Telegram. Abfrage beim Anlegen *(gebaut)*.
- **E4** Einstellungen „Erlaubnisse“ + Chat-Werkzeug `erlaubnisse`.
- **E5** Sammel-Werkzeuge: Entwürfe *(gebaut)*, dazu Prüfung, welche Lösch- und Schreib-Werkzeuge
  Listen brauchen; Prompt-Regel „gesammelt statt Schleife“.
- **E6** Lösungskarten, Prüfsatz, lokaler Test gegen Prod.

Schätzung: E1–E3 2 Tage, E4–E6 1–2 Tage.

## 4. Offene Entscheidungen (Joyce)

1. **Mail-Triage:** Klammer behalten (Vorschlag), also keine dauerhaft erlaubten Lösch-
   oder Änderungsaktionen aus eingehenden Mails? Telegram zählt als „du selbst“ und wird
   nicht geklammert.
2. **Obergrenzen in Workflows:** `maxItemsPerRun` (500) als reiner Schutz gegen
   Endlosschleifen auf 5000 anheben oder ganz streichen? `maxMailsPerDay` (20, echte Mails
   an Dritte) streichen oder als Standard behalten?
3. **Reichweite von „Immer erlauben“:** je Werkzeug (Vorschlag, einfach) oder je Werkzeug
   und Ziel (z. B. `mail_send` nur an diesen Empfänger)?
4. **`mail_send` an Empfänger außerhalb der Allowlist:** auch dauerhaft erlaubbar, oder
   bleibt das je Mail eine Frage?
