# Prompt für den Website-Agenten (ava.bi): AVA Workflows als eigenes Feature

Stand 2026-09-09, Desktop v0.1.594. Ergänzt die Übergaben vom 2026-09-05 und
2026-09-07 und den Nachtrag docs/WEBSITE_PROMPT_UPDATE_2026-09-09.md; deren
Regeln gelten weiter.

---

Du aktualisierst die Website ava.bi (Desktop-App der eproX GmbH, Herford,
B2B-Vertriebsrecherche im DACH-Raum). AVA hat ein neues großes Feature:
**Workflows**. Es ist live und bekommt drei Dinge auf der Website:

1. einen eigenen großen Block auf der Startseite,
2. eine eigene Seite `/workflows`,
3. einen Link im Header (Hauptnavigation), gleichrangig mit den bestehenden
   Feature-Seiten.

Ton wie gehabt: sachlich, Du-Form, keine Geviertstriche, keine Superlative,
keine Versprechen über Dinge, die nicht live sind. Alles unten ist live,
außer dem, was ausdrücklich als „nicht schreiben" markiert ist.

## 1. Was Workflows sind (Kernbotschaft)

Vertriebsteams arbeiten hoch individuell: Jeder pflegt sein CRM anders,
jeder schreibt Mails anders, jeder hat eigene Abläufe. Bisher musste man AVA
das jedes Mal neu erklären. Mit Workflows speichert man einen Ablauf einmal
und lässt ihn laufen, manuell, per Chat, nach Zeitplan oder ausgelöst durch
ein Ereignis.

Ein Workflow ist eine gespeicherte Kette von AVA-Schritten mit festen
Parametern: Recherche, Filter, Verzweigungen, KI-Schritte, CRM, Mail,
Telegram. Er läuft ohne Rückfragen und ohne dass ein Modell den Ablauf jedes
Mal neu plant. Das Ergebnis ist wiederholbar und im Audit-Protokoll
nachvollziehbar.

Formulierung, die du verwenden kannst: „Abläufe einmal erarbeiten, dann
automatisch laufen lassen." Nicht verwenden: „Automatisierung von allem",
„grenzenlos", „wie n8n".

## 2. Die vier Aussagen, die das Feature von allem anderen unterscheiden

Diese vier gehören in den Startseiten-Block und prominent auf die Seite.

**a) AVA baut den Workflow, nicht der Nutzer.**
Der Nutzer erarbeitet einen Ablauf im Chat, wie er es heute schon tut, und
sagt am Ende „speicher das als Workflow". AVA macht aus den Schritten den
Workflow, fasst wiederholte Schritte zusammen und ersetzt konkrete Werte
durch Bezüge. Alternativ beschreibt der Nutzer, was regelmäßig passieren
soll, und AVA baut den Workflow aus der Beschreibung. Die grafische Ansicht
dient der Kontrolle und kleinen Korrekturen, nicht dem Bau von Null.

**b) Jeder Lauf gilt für eine Firma und kennt sie vollständig.**
Ein Lauf hat den gesamten Kontext einer Firma: Stammdaten, Firmenprofil,
Kennzahlen aus Jahresabschlüssen, Kontakte, CRM-Stand, bei Radar-Kandidaten
das Mini-Profil. Schritte dürfen Platzhalter in Alltagssprache verwenden,
zum Beispiel „Kassenbestand" oder „Ansprechpartner Vertrieb". AVA füllt sie
aus dem Kontext nach Bedeutung und setzt einen Ersatztext, wenn ein Wert
fehlt. Der Nutzer muss keine Feldnamen kennen.

**c) Mehrere Firmen laufen als Kette, nicht als Chaos.**
Mehrere Firmen werden als Stapel gestartet, je Firma ein eigener Lauf. Oder
ein übergeordneter Workflow sammelt Firmen, etwa aus dem Radar, und startet
je Firma einen Unter-Workflow. Ein Workflow kann außerdem warten, bis ein
Import für alle Firmen fertig verarbeitet ist, und erst dann weitermachen.

**d) Kontrolle bleibt beim Menschen.**
Schreibende Schritte (CRM-Einträge, Mails) laufen unbeaufsichtigt nur nach
ausdrücklicher Freigabe des jeweiligen Schritts. Mail-Versand braucht immer
eine Freigabe und hat eine Tages-Obergrenze je Workflow. Ein
Freigabe-Schritt hält den Lauf an, bis der Nutzer entscheidet, in der App,
in den Meldungen oder unterwegs per Telegram. Testläufe zeigen schreibende
Schritte nur als Vorschau. Jeder Lauf steht im Audit-Protokoll.

## 3. Startseiten-Block

Eigener, großer Abschnitt oberhalb der bestehenden Feature-Übersicht oder
direkt nach dem Hero. Aufbau:

- Überschrift: „Workflows: Abläufe einmal erarbeiten, dann automatisch
  laufen lassen."
- Zwei bis drei Sätze aus Abschnitt 1.
- Drei Kacheln mit den Aussagen a), b) und d) aus Abschnitt 2, je zwei
  Sätze.
- Ein Beispiel als Ablaufkette in einer Zeile: „Radar-Kandidaten ab Score
  80 importieren → warten, bis alle verarbeitet sind → je Firma
  Kurzübersicht erstellen → per Telegram senden."
- Link „Mehr zu Workflows" auf `/workflows`.

Kein Preis, keine Plan-Namen im Block.

## 4. Die Seite `/workflows`

Reihenfolge und Inhalt:

**Hero.** Überschrift wie im Startseiten-Block, ein Absatz Kernbotschaft,
darunter der Hinweis, dass Workflows in der Desktop-App enthalten sind
(kein Zusatzprodukt).

**So entsteht ein Workflow.** Drei Schritte, jeweils ein kurzer Absatz:
1. Im Chat erarbeiten, wie bisher.
2. „Speicher das als Workflow" sagen. AVA fasst die Schritte zusammen,
   schlägt Namen, Parameter und einen Auslöser vor und zeigt den Entwurf.
3. Testlauf mit Vorschau, dann freigeben, was unbeaufsichtigt laufen darf.

**Was ein Workflow kann.** Liste der Schrittarten in Alltagssprache:
Recherche-Schritte (alle AVA-Funktionen, die Daten lesen), Filter und
Verzweigungen, Felder setzen, Schleifen in Batches, Zusammenführen, Warten
(Zeit oder bis ein Import fertig ist), KI-Schritt mit festem Prompt und
festem Ausgabeformat, Freigabe-Schritt, Unter-Workflow, CRM- und
Mail-Schritte, Telegram.

**Auslöser.** Manuell, per Chat, Zeitplan (Uhrzeit und Wochentage oder
Intervall; Firmen aus fester Liste, aus dem Radar ab Score, aus einem
Vorgang oder alle Firmen), Ereignis (neuer heißer Radar-Treffer, eingehende
Mail, neue Meldung, Import abgeschlossen). Ehrlich dazu: Zeitpläne und
Ereignisse greifen nur, solange AVA geöffnet ist. Versäumte Läufe werden
nicht nachgeholt.

**Eine Firma je Lauf, voller Kontext.** Abschnitt zu Aussage b) mit einem
konkreten Beispiel: „Formuliere eine Mail, die auf $ansprechpartner_vertrieb
zugeschnitten ist und den Kassenbestand erwähnt, sonst schreibe ‚keine
Finanzdaten bekannt'." Erkläre, dass AVA solche Platzhalter aus dem Kontext
füllt.

**Sicherheit und Kontrolle.** Abschnitt zu Aussage d), zusätzlich: Idempotenz
(ein täglicher Lauf schreibt dieselbe Firma nicht zweimal an), Fehler je
Schritt behandelbar (abbrechen, weitermachen, Fehler-Ausgang), optionaler
Fehler-Workflow, Kostenübersicht je Lauf vor dem Start.

**Meldungen und unterwegs.** Abgeschlossene Läufe, Fehler und offene
Freigaben erscheinen unter Meldungen, als Desktop-Benachrichtigung und in
Telegram. Freigaben lassen sich per Telegram beantworten. Unabhängig von
Workflows meldet AVA jetzt jeden abgeschlossenen Import mit einer Bilanz
(fertig, fehlgeschlagen, Fehlerquellen).

**Vorlagen.** Vier Vorlagen zum Sofort-Anlegen: Firmen-Kurzprofil per
Telegram; Radar-Firmen importieren, danach je Firma Bericht per Telegram;
Kurzprofil bei neuem heißen Radar-Treffer; HubSpot-Notiz nach Import.

**Im Team.** Workflows liegen lokal auf dem Rechner und können mit der
eigenen Organisation geteilt werden. Kolleginnen und Kollegen übernehmen sie
als eigene Kopie; Zugänge werden nie mitgeteilt, Freigaben setzt jeder
selbst.

**Die Ansicht.** Ein Absatz: Diagramm mit Schritten und Verbindungen,
Parameter je Schritt als Formular, Läufe mit Ergebnis je Schritt, Testen bis
zu einem Schritt, Ausgaben einfrieren zum Testen, Rückgängig/Wiederholen.
Kein Vergleich mit anderen Werkzeugen.

**Plan-Staffelung.** Kostenlos: ein Workflow. Starter, Pro, Enterprise:
unbegrenzt. Läufe verbrauchen die normalen Kontingente (Scans, Importe,
Profile) und KI-Aufrufe über den eigenen Schlüssel, ein lokales Modell oder
den Schlüssel der Organisation. Ein ChatGPT-Abo gilt nicht für Workflows.

**FAQ** (je zwei bis vier Sätze):
- Muss ich programmieren? Nein. Der Chat baut den Workflow; die Ansicht ist
  zum Prüfen und Anpassen.
- Kann ein Workflow etwas kaputt machen? Schreibende Schritte laufen nur
  nach Freigabe, Mails nie ohne. Testläufe zeigen Vorschauen.
- Läuft das auch, wenn mein Laptop zu ist? Nein. Zeitpläne und Ereignisse
  greifen nur bei geöffneter App. Ein Server-Betrieb ist in Arbeit, nicht
  versprechen.
- Was kostet ein Lauf? KI-Schritte und Platzhalter-Befüllung sind
  Modell-Aufrufe über den eigenen Zugang; Recherche-Schritte zählen wie
  bisher gegen die Kontingente. Die App zeigt vor dem Start eine grobe
  Übersicht.
- Sehen Kollegen meine Workflows? Nur, wenn du sie teilst. Dann als Kopie,
  ohne deine Zugänge.

## 5. Header

Neuer Punkt „Workflows" in der Hauptnavigation, Ziel `/workflows`,
platziert neben den bestehenden Feature-Seiten (nicht unter „Mehr").
Footer entsprechend ergänzen. Sitemap aktualisieren.

## 6. Bestehende Seiten anpassen

- Startseite: Block aus Abschnitt 3.
- Seite „KI-Modelle" und FAQ „KI-Modellkosten": einen Satz ergänzen, dass
  Workflows KI-Schritte über denselben Zugang ausführen und ein ChatGPT-Abo
  dafür nicht gilt.
- Lösungen-Seiten für Vertriebsleitung und SDR/BDR-Teams: Workflows als
  Team-Funktion aufnehmen (Vorlagen, Teilen, Freigaben).
- Datenschutz: ein Satz, dass Workflows dieselben Datenwege nutzen wie der
  Chat (lokal bzw. über die vom Nutzer gewählten Modellzugänge) und dass
  Freigaben und Läufe im lokalen Audit-Protokoll stehen.

## 7. Nicht schreiben

- Keine Ausführung ohne laufende App.
- Keine Integrationen, die es in AVA nicht gibt; nur die vorhandenen
  Schritte (Recherche, Radar, CRM HubSpot, Notion, Obsidian, Mail,
  Telegram, LinkedIn-Beobachtung).
- Kein „unbegrenzt", „grenzenlos", „vollautomatisch". Formuliere
  „automatisch nach deiner Freigabe".
- Kein Vergleich mit Make oder n8n als Ersatz. Falls du das Bild brauchst:
  „Wer Werkzeuge wie n8n kennt, findet sich in der Ansicht zurecht; AVA baut
  die Abläufe aber selbst und kennt jede Firma."
- Keine Bilder erfinden. Wenn Screenshots fehlen, Platzhalter mit Hinweis an
  den Betreiber setzen.
