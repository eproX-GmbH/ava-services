# Prompt für den Website-Agenten (ava.bi): Nachtrag Workflows

Stand 2026-09-09, Desktop v0.1.594. Ergänzt die Nachträge vom 2026-09-05 und
2026-09-07; deren Regeln gelten weiter (sachlich, Du-Form, keine
Geviertstriche, keine Superlative, nichts versprechen, was nicht live ist).

## Neu live: Workflows

Beschreibe Workflows als neue Funktion, nicht als „in Arbeit". Kernaussagen:

- **Abläufe speichern, statt sie jedes Mal neu zu erklären.** Ein Workflow
  ist eine gespeicherte Kette von AVA-Schritten (Recherche, Filter, CRM,
  Mail, Telegram) mit festen Parametern. Er läuft ohne Rückfragen und ohne
  dass ein Modell den Ablauf jedes Mal neu plant.
- **AVA baut den Workflow.** Der Nutzer erarbeitet den Ablauf im Chat und
  sagt „speicher das als Workflow", oder beschreibt direkt, was regelmäßig
  passieren soll. Die Ansicht unter Vorgänge → Workflows zeigt den Ablauf
  als Diagramm mit Schritten und Verbindungen und dient der Kontrolle und
  kleinen Korrekturen.
- **Ein Lauf gilt für eine Firma.** Jeder Lauf hat den vollständigen Kontext
  dieser Firma (Stammdaten, Profil, Kennzahlen aus Jahresabschlüssen,
  Kontakte, CRM-Stand). Schritte dürfen Platzhalter wie „Kassenbestand" oder
  „Ansprechpartner Vertrieb" verwenden; AVA füllt sie aus dem Kontext und
  nutzt einen Ersatztext, wenn ein Wert fehlt. Mehrere Firmen laufen als
  Stapel oder über einen übergeordneten Workflow, der je Firma einen Lauf
  startet.
- **Auslöser:** manuell, per Chat, Zeitplan (Uhrzeit und Wochentage, feste
  Firmenliste, Radar-Kandidaten ab Score, alle Firmen eines Vorgangs), oder
  Ereignis (neuer heißer Radar-Treffer, eingehende Mail, neue Meldung,
  Import abgeschlossen). Zeitpläne laufen nur, wenn AVA geöffnet ist;
  versäumte Läufe werden nicht nachgeholt.
- **Kontrolle bleibt beim Menschen.** Schreibende Schritte (CRM, Mail)
  laufen unbeaufsichtigt nur nach ausdrücklicher Freigabe des Schritts.
  Mail-Versand braucht immer eine Freigabe und hat eine Tages-Obergrenze je
  Workflow. Ein Freigabe-Schritt hält den Lauf an, bis der Nutzer in der
  App, in den Meldungen oder per Telegram entscheidet. Testläufe zeigen
  Schreib-Schritte nur als Vorschau. Jeder Lauf ist im Audit-Protokoll
  nachvollziehbar.
- **Warten auf Verarbeitung.** Ein Workflow kann warten, bis ein Import
  für alle Firmen durchgelaufen ist, und dann weitermachen, etwa mit einer
  Kurzübersicht je Firma per Telegram. Unabhängig davon meldet AVA jetzt
  jeden abgeschlossenen Import mit einer Bilanz (fertig, fehlgeschlagen,
  Fehlerquellen).
- **Vorlagen** zum Sofort-Anlegen: Firmen-Kurzprofil per Telegram,
  Radar-Import mit Bericht je Firma, Kurzprofil bei neuem heißen
  Radar-Treffer, HubSpot-Notiz nach Import.
- **Teilen in der Organisation.** Workflows liegen lokal auf dem Rechner und
  können mit der eigenen Organisation geteilt werden; Kolleginnen und
  Kollegen übernehmen sie als eigene Kopie. Zugänge werden nie mitgeteilt.

## Plan-Staffelung

Kostenlos: ein Workflow. Starter, Pro, Enterprise: unbegrenzt. Läufe
verbrauchen die normalen Kontingente (Scans, Importe, Profile) und
KI-Aufrufe über den eigenen Schlüssel, ein lokales Modell oder den
Organisationsschlüssel. Ein ChatGPT-Abo gilt nicht für Workflows.

## Nicht schreiben

- Keine Ausführung ohne laufende App (Server-Worker bleibt in Arbeit).
- Keine „Automatisierung von allem": nur die in AVA vorhandenen Schritte.
- Kein Vergleich mit Make oder n8n als Ersatz; AVA-Workflows sind auf
  Vertriebsrecherche und CRM-Pflege beschränkt.
