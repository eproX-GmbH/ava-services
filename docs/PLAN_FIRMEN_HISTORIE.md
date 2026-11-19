# Plan: Firmenhistorie aus Personal- und Stammdatenwechseln

Stand 2026-11-19 · Anlass: Sprachnachricht von Patrick (19.11., 10:18): 531 Meldungen, die Frage
„Welche neuen Vertriebsleiter gab es in letzter Zeit?“ konnte AVA nur teilweise beantworten; Idee,
die Meldungen als Historie an die Firmen zu hängen, damit über viele Nutzer ein Verlauf entsteht
(„Wie oft wechselt dort der Vertriebsleiter?“).

## 0. Ergebnis in drei Sätzen

Die Historie, die Patrick will, entsteht schon heute zentral und für alle Nutzer gemeinsam: Jede
verarbeitete Firma schreibt Stellen-, Rollen- und Geschäftsführungswechsel in die Kontakt- und
Gateway-Datenbank, unabhängig davon, wer eine Meldung bekommt. Es fehlen eine Abfrage darüber
(Chat, Zeitachse), eine Regel, die echte Wechsel von bloßen Umformulierungen trennt, und eine
Auswertung je Firma („Vertriebsleitung dreimal in zwei Jahren gewechselt“). Grundlage sind die
zentralen Ereignisse, nicht die lokalen Meldungen; persönliche Fokus-Themen bleiben privat.

## 1. Befund

### 1.1 Meldungen sind eine persönliche Sicht

- Meldungen liegen nur auf dem Gerät des Nutzers (`agent/alerts.jsonl`, `AlertsStore`). Der
  Alarm-Judge bewertet jedes Ereignis lokal mit dem Profil des Nutzers (Compute-Lokalität) und
  macht daraus eine Meldung oder nicht.
- Das Chat-Werkzeug `alerts_list` filtert nur nach Zeitraum (`sinceMinutes`, höchstens 30 Tage),
  Art (`kinds`) und „ungelesen“, höchstens 200 Einträge. Nach Rolle, Stichwort oder Firma sucht es
  nicht. Daher die halbe Antwort auf Patricks Frage.

### 1.2 Die Ereignisse dahinter sind zentral und gemeinsam

| Quelle | Wo | Was |
|---|---|---|
| `SignalEvent` | Kontakt-DB (`ava_company_contact`) | `PERSON_JOB_CHANGED` (Titel vorher/nachher), `PERSON_EMPLOYER_CHANGED`, Firmen-Telefon/-Mail/-Adresse, mit Quelle und Beleg-URL |
| `Employment` | Kontakt-DB | eine Zeile je Person und Firma: `title`, `isCurrent`, `startDate`/`endDate` (laut Profil), `firstSeen`/`lastSeen` (laut AVA) |
| `ProfileChangeEvent` | Gateway-DB | Geschäftsführung, Name, Rechtsform, Adresse, Kapital, Gegenstand |
| `RegisterSnapshot` | Gateway-DB | Registerstände (Burggraben 1) |
| `ManagingDirector` | Gateway-DB | Geschäftsführung mit `bestelltAm` |

Das Gateway liest daraus bereits die Neuheiten für den Heartbeat (`POST /v1/alerts/neuheiten`,
Fenster auf 30 Tage gedeckelt, Erst-Crawl zählt nie als Neuheit).

### 1.3 Datenlage (nur lesend geprüft, 2026-11-19)

| Größe | Wert |
|---|---|
| Beschäftigungen | 8.176 bei 361 Firmen (7.076 aktuell, 1.100 beendet) |
| davon mit Startdatum laut Profil | 3.709 |
| Rollenwechsel (`PERSON_JOB_CHANGED`) | 1.776 bei 131 Firmen, seit Dezember 2025 |
| Arbeitgeberwechsel (`PERSON_EMPLOYER_CHANGED`) | 205, aber nur bei 4 Firmen mit Firmenbezug |
| Vertriebsrollen (Titel enthält Vertrieb/Sales/CSO/Verkaufsleitung/Key Account) | 825 bei 165 Firmen |

**Wichtigster Befund:** Viele Rollenwechsel sind nur Umformulierungen desselben Jobs, etwa
„Technischer Vertrieb“ → „Technischer Vertrieb Innendienst“ oder „Chief Sales Officer (CSO)“ →
„Member of the Board & CSO“. Zählt man sie mit, wäre jede Auswertung falsch. Echte Wechsel sind
andere: eine **neue Person** in einer Rolle, eine Person **verlässt** die Firma, oder eine Person
**steigt in eine andere Ebene oder Rollengruppe** auf („Vertriebsingenieur“ → „Vertriebsleitung“).

## 2. Zielbild

### 2.1 Begriffe

- **Rollengruppe:** Geschäftsführung/Vorstand, Vertrieb, Marketing, Einkauf, IT/Digital, Personal,
  Finanzen, Produktion/Technik, Service, Sonstige. Zuordnung aus dem Titel über eine feste
  Wörterliste (deutsch und englisch, etwa „Vertriebsleiter“, „Leiter Vertrieb“, „Head of Sales“,
  „Sales Director“, „CSO“), später ergänzt durch ein KI-Urteil für Unklare.
- **Ebene:** Leitung (Leiter, Head, Director, Chief, VP, Geschäftsführer) oder Mitarbeit.
- **Personalereignis:** „neu in Rolle“ (Person erstmals mit dieser Rollengruppe und Ebene an der
  Firma), „Rolle verlassen“ (Beschäftigung beendet), „Aufstieg/Wechsel“ (Rollengruppe oder Ebene
  ändert sich). Reine Umformulierungen innerhalb derselben Rollengruppe und Ebene sind **kein**
  Ereignis.
- **Zeitpunkt:** `startDate`/`endDate` laut Profil, wenn vorhanden, sonst „erstmals gesehen“
  (`firstSeen`/`observedAt`) und ausdrücklich so gekennzeichnet. Der Erst-Crawl einer Firma ist nie
  ein Ereignis (bestehende Regel aus `alerts-neuheiten`).

### 2.2 Was Nutzer bekommen

1. **Fragen im Chat** über alle eigenen Firmen: „Welche neuen Vertriebsleiter gab es in den letzten
   drei Monaten?“, „Wo hat die Geschäftsführung dieses Jahr gewechselt?“, „Wer hat bei Firma X die
   IT verlassen?“. Antwort mit Person, Rolle, Firma, Zeitpunkt und Beleg-Link.
2. **Zeitachse je Firma** mit Personalereignissen ohne 30-Tage-Grenze: in app.ava.bi als neue Art
   „Personal“, in der Desktop-App als eigener Reiter „Zeitachse“ (bisher nur in der App).
3. **Kennzahl je Firma:** Wechsel je Rollengruppe in 24 Monaten und mittlere Verweildauer der
   Leitung, als Hinweis an der Firma („Vertriebsleitung 3× in 2 Jahren gewechselt“), sichtbar in
   Übersicht und Chat, nutzbar für Relevanz und Alarm-Judge.
4. **Meldungen durchsuchen:** `alerts_list` bekommt Freitext, Firma und ein längeres Fenster, damit
   „Was wurde mir zu Firma X gemeldet?“ auch lokal geht.

### 2.3 Was geteilt wird und was nicht

- Geteilt (schon heute): Ereignisse an der Firma aus öffentlichen Quellen (Register, Website,
  LinkedIn-Profile). Sie entstehen bei jeder Verarbeitung und gehören zur Firma.
- Nicht geteilt: Fokus-Themen-Befunde (seit 2026-11-06 je Nutzer, `actorId`), die Bewertung des
  Alarm-Judges, Notizen und wer welche Firma beobachtet. Die Auswertung verrät nie, welche Nutzer
  sich für eine Firma interessieren.

## 3. Technik

- **Gateway, neue Route** `GET /v1/firmen-ereignisse?companyIds=…|meine=1&arten=personal,geschaeftsfuehrung&rollengruppe=vertrieb&ebene=leitung&seit=…&bis=…&limit=…`
  liest `Employment` und `SignalEvent` (Kontakt-DB) sowie `ProfileChangeEvent`/`ManagingDirector`
  (Gateway-DB), leitet daraus Personalereignisse nach 2.1 ab und liefert je Ereignis Person, Rolle
  vorher/nachher, Rollengruppe, Ebene, Zeitpunkt (mit Art „laut Profil“ oder „erstmals gesehen“),
  Quelle und Beleg-URL. `meine=1` nimmt die Firmen der Organisation wie „Meine Firmen“ (gleiche
  Logik wie der Neuigkeiten-Cron). Ohne 30-Tage-Grenze, mit Seitenweise-Abruf.
- **Rollengruppen:** reine Funktion `lib/rollengruppe.ts` (Wörterliste, Tests mit echten Titeln aus
  der Datenbank), im Gateway; der Desktop bekommt die Gruppe fertig geliefert.
- **Kennzahl:** `GET /v1/companies/{id}/fluktuation` rechnet aus denselben Ereignissen; zunächst
  live, bei Bedarf als nächtlich gefüllte Tabelle. **Keine großen neuen Indizes** auf der geteilten
  Datenbank (Lehre vom 07.10.: Indexaufbau hat den Cluster gekippt); die vorhandenen Indizes auf
  `companyId` und `observedAt` reichen für Abfragen je Firmenliste.
- **Desktop:** Chat-Werkzeug `firmen_ereignisse` (dünn über der Route), Hinweis im Systemprompt
  („Personalwechsel immer über firmen_ereignisse, nicht über Meldungen“), `alerts_list` um `suche`
  und `companyId` erweitert, Reiter „Zeitachse“ in der Firmenansicht (Logik aus
  `ava-app/src/lib/zeitachse.ts` übernehmen), Kennzahl in Übersicht und Kopf.
- **app.ava.bi:** neue Zeitachsen-Art „Personal“ aus der Route, Kennzahl in „Auf einen Blick“.
- **MCP:** dasselbe Werkzeug für Copilot und andere Clients (Gateway-Werkzeug, läuft ohne AVA).
- **Lösungskarten:** neue Karte „Personalwechsel bei meinen Firmen“, Karte Meldungen ergänzt.

## 4. Stufen

| Stufe | Inhalt | Aufwand |
|---|---|---|
| **H0** | Rollengruppen-Wörterliste an echten Titeln prüfen (nur lesend): wie viele Wechsel bleiben nach dem Filter übrig, wie oft fehlt ein Startdatum | 2 Std |
| **H1** | Gateway: `lib/rollengruppe.ts`, Route `firmen-ereignisse`, Tests | 1 Tag |
| **H2** | Chat: Werkzeug `firmen_ereignisse` (Desktop und MCP), Prompt-Hinweis, `alerts_list` mit Suche und Firma, Lösungskarten | 0,5 Tag |
| **H3** | Zeitachse: Art „Personal“ in app.ava.bi; Reiter „Zeitachse“ in der Desktop-App | 1,5 Tage |
| **H4** | Kennzahl Fluktuation je Firma: Route, Anzeige in Übersicht/Kopf, Weitergabe an Relevanz und Alarm-Judge | 1 Tag |

Reihenfolge: H0 → H1 → H2 (damit ist Patricks Frage beantwortet), dann H3 und H4.

## 5. Entscheidungen (Empfehlung zuerst)

1. **Grundlage sind die zentralen Ereignisse, nicht die Meldungen.** Meldungen sind gefiltert und
   persönlich bewertet; sie hochzuladen würde verraten, wer welche Firma beobachtet, und nur
   abbilden, was zufällig gemeldet wurde. Alternative: Meldungen zusätzlich zentral ablegen.
2. **Umformulierungen zählen nicht.** Nur neue Person, Austritt oder Wechsel von Rollengruppe/Ebene.
3. **Zeitpunkt laut Profil vor „erstmals gesehen“**, beides sichtbar gekennzeichnet.
4. **Fokus-Themen bleiben privat**, auch in der Auswertung.
5. **Löschungen:** Wird eine Person nach Datenschutz gelöscht, verschwinden ihre Ereignisse
   (Kaskade). Für die Kennzahl je Firma zählt H4 zusätzlich anonym mit (Rollengruppe, Ebene,
   Zeitpunkt, ohne Person), damit die Firmenhistorie nicht lückenhaft wird. Alternative: keine
   anonyme Zählung, dann sinkt die Kennzahl bei Löschungen.

## 6. Risiken

- **Titelqualität:** LinkedIn-Titel sind frei formuliert, mehrsprachig und oft lang. Die
  Wörterliste trifft die Mehrheit; Unklare landen in „Sonstige“ und zählen nicht als Wechsel.
- **Verzögerung:** Ein Wechsel wird erst sichtbar, wenn die Firma neu verarbeitet wird (Auffrischung
  14 Tage). „Erstmals gesehen“ kann deshalb Wochen nach dem echten Wechsel liegen.
- **Arbeitgeberwechsel ohne Firmenbezug:** 205 Ereignisse, aber nur 4 mit Firma; diese Art liefert
  vorerst wenig und braucht in H0 eine Prüfung, warum der Firmenbezug fehlt.
- **Personenbezug:** Die Historie nennt Personen. Sie stammt aus öffentlichen Quellen, der Art.-14-
  Hinweis gilt weiter; die Kennzahl je Firma kommt ohne Namen aus.

## 7. Stand

- 2026-11-19: Befund und Plan geschrieben (Sprachnachricht lokal transkribiert, Code und Prod-Daten
  nur lesend geprüft). Wartet auf Abnahme.
- 2026-11-19: Abgenommen („Ja, so umsetzen“, Entscheidungen wie empfohlen).
- 2026-11-19 H0: 4.291 Titel, 1.776 Titeländerungen → 161 echte Wechsel (beide Titel eingeordnet,
  Assistenz raus, eigene Gruppe Aufsichtsrat/Beirat). Wörterliste in `rollengruppe.ts`.
- 2026-11-19 H1 gebaut: `GET /v1/firmen-ereignisse` (Gateway, `lib/firmen-ereignisse.ts`). Lesende
  Probe für Patricks Org (234 Firmen, 90 Tage), Lehren daraus fest eingebaut:
  * `endDate` setzt das System (Titeländerung schließt die alte Zeile, Aufräumen, Profilprüfung),
    nicht das Profil → „verlassen“ nur, wenn keine aktuelle Zeile der Person mehr da ist, Zeitpunkt
    „festgestellt“. Titeländerungen innerhalb einer Firma werden zu Wechseln. 127 → 9 GF-Abgänge.
  * Beförderung stand doppelt (neu + Wechsel, Signal + Zeile) → je Person/Firma/Rollenpaar einmal.
  * Neue Quelle für eine Firma (LinkedIn nach Website) ist Bestand: Basis = erster Abruf der Firma
    durch DIE Quelle. Fehlzuordnung binnen 30 Tagen auf- und zugeklappt zählt gar nicht.
  * Schub ≥ 3 Personen am selben Tag aus derselben Quelle ohne Profildatum = Bestand.
  * „Gebiets-/Regionalleiter“ = Mitarbeit, „Vice President“/„Product Owner“ ≠ Geschäftsführung.
  Ergebnis: 113 Ereignisse in 90 Tagen (statt 500), 7 in der Vertriebsleitung, alle plausibel
  (z. B. „Vertriebsingenieur → Vertriebsleitung“, laut Profil). Antwortzeit ~350 ms.
