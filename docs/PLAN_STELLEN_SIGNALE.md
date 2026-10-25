# Plan: Stellenanzeigen als Signalquelle im Standardprozess (2026-10-22, Entwurf)

## Anlass

Henning (Sprachnachricht 2026-10-22): Ein Vermittler für betriebliche Altersvorsorge
will wissen, welche Firmen bAV anbieten. Das steht oft im Karriereportal („Wir bieten“)
oder in Stellenanzeigen. Er hat eine solche Seite gefunden und AVA im Chat gebeten, sie zu
lesen; AVA antwortete, sie könne die Seite nicht auslesen, er solle den Text kopieren.
Frage: Kann AVA solche Angaben aus Stellenanzeigen und Karriereseiten erfassen, bis zum
Kundentermin nächste Woche Freitag?

Joyce hat geantwortet, dass die Stellenanzeigen-Recherche bereits existiert, aber nicht
automatisch aktiv ist, und bezweifelt, dass „betriebliche Vorsorge“ dort sauber erfasst
würde. Beides stimmt (siehe Ist-Stand).

## Ist-Stand (geprüft im Code und in den Daten, 2026-10-22)

**Was es gibt**

- Producer `website`, Pipeline `runJobPostingsPipeline`
  (`website/src/infrastructure/research/anthropic-research.ts`): ein KI-Aufruf mit
  Websuche je Firma. Prompt: „Sammle online verfügbare Stellenanzeigen; Quellen:
  Karriereseite, LinkedIn, Indeed, StepStone, Glassdoor, XING; max. 20, letzte 90 Tage.“
  Zwei Stufen: standard (ca. 0,02–0,15 € je Firma) und deep (1–5 €, Minuten).
- Gespeichert wird je Stelle: Titel, Ort, Arbeitsmodell, Beschreibung, Erscheinungsdatum,
  Anforderungen (Liste), Technologien (Liste), Quell-URL (`JobPosting` in `ava_website`).
  **Kein Feld für Benefits oder Leistungen des Arbeitgebers.**
- Anzeige: Reiter „Stellenanzeigen“ in der Firmenansicht; Chat über `company_website`.
  Manueller Start je Firma per `research_run` (feature jobs, standard oder deep), seit
  v0.1.725, mit Rückfrage und Kostenhinweis.
- Einstellung: je Feature `off | standard | deep` (`services/desktop/src/main/research/store.ts`).
  Standard ist **off**; seit v0.1.356 schaltet AVA beide Features automatisch auf
  `standard`, wenn ein OpenAI-Schlüssel vorhanden ist und der Nutzer Research nie selbst
  konfiguriert hat. Das greift also nur bei frischen Installationen, nicht bei allen.

**Zahlen**

| | Wert |
|---|---|
| Gespeicherte Stellen gesamt | 168 |
| Firmen mit Stellen | 41 |
| Zeitraum | 2025-11-24 bis 2026-10-10 |
| Stellen mit „Altersvorsorge“/„Vorsorge“ in Beschreibung oder Anforderungen | 0 |
| Manuelle Läufe (`CompanyResearchLauf`) | 2, beide heute, eine Firma |

**Was fehlt**

1. Die Extraktion kennt keine Arbeitgeberleistungen. Selbst wenn eine Anzeige „bAV“
   nennt, landet das höchstens als Satz in `description`, und auch nur, wenn die KI den
   Text übernimmt. Null Treffer bei 168 Stellen zeigt: es wird nicht übernommen.
2. Karriereseiten werden nicht gelesen. Das Mini-Profil im Radar und das Firmenprofil des
   Website-Producers wählen Unterseiten nach Muster (Leistungen, Über uns, Impressum,
   Referenzen, Datenschutz). „Karriere“, „Jobs“, „Wir bieten“ sind nicht dabei.
3. Der Chat hat kein Werkzeug „Seite lesen“. Es gibt URL-Lesen nur im ICP-Assistenten
   (`icp_assist_from_urls`) und im Link-Monitor. Darum die Antwort „Text kopieren“.
4. Stellen fließen nirgends in Bewertung oder Alarme: weder in den ICP-Abgleich (Radar
   und Bestandsabgleich arbeiten mit Profiltext) noch in die Neuheiten-Alarme.
5. Research ist Opt-in je Installation und hängt am OpenAI-Schlüssel. Es ist keine
   Pipeline-Stufe wie Profil oder Kontakte, sondern ein Nebenlauf im Website-Producer.

## Zielbild (zur Diskussion)

Stellenanzeigen und Karriereseite werden eine normale Signalquelle: Sie laufen für jede
Firma im Bestand mit, liefern strukturierte Felder (darunter Arbeitgeberleistungen), und
diese Felder sind im ICP-Abgleich, im Chat und als Alarm nutzbar. Ein ICP wie „bietet
betriebliche Altersvorsorge“ oder „sucht SAP-Entwickler“ wird damit matchbar.

## Optionen

### A — Schnell für Hennings Termin (1–2 Tage)

1. Extraktionsschema um `leistungen: string[]` (Arbeitgeberleistungen, z. B. bAV,
   Jobrad, Homeoffice, 30 Tage Urlaub) und `benefitsText` erweitern; Prompt fordert die
   Übernahme wörtlicher Nennungen. Gilt für Standard und Deep.
2. Karriereseite der Firma als Quelle: Unterseiten-Muster um `karriere|jobs|career|
   stellen|wir-bieten|benefits` erweitern, Text an die Stellen-Extraktion mitgeben.
3. Chat-Werkzeug `seite_lesen` (URL → Text, mit Browser-Fallback wie beim Mini-Profil),
   damit „lies diese Karriereseite“ funktioniert. Grenzen: robots.txt, keine Logins.
4. `company_get` liefert die Leistungen im Bereich `website` mit; `icp_bestand_abgleich`
   bekommt sie als Zusatzfeld, damit „bAV“ im Bestand gefiltert werden kann.

Das reicht für den Termin: Henning kann seine Kunden-Firmen importieren, die Stellen-
Recherche für sie starten und im Chat nach „Firmen, die bAV anbieten“ fragen.

### B — In den Standardprozess (danach, ca. 3–4 Tage)

5. Stufe `jobs` wird wie Website und Kontakte eine Pipeline-Stufe mit Fortschritt,
   Wiederholung und Auffrischung (Kadenz 30 Tage), Standard `standard`, Deep bleibt
   Opt-in. Kosten je Firma ca. 0,05 €, also bei 1.000 Firmen 50 € je Durchlauf.
   Orga-Schalter und Ausgabenlimit greifen wie bei anderen Stufen.
6. Stellen und Leistungen gehen in den Profiltext für den ICP-Abgleich (Radar-Judge und
   Bestandsabgleich): „Firma sucht X“, „bietet Y“ als eigene Zeilen.
7. Neuheiten-Alarm „neue Stellenanzeige“ je Firma, mit Judge gegen das Nutzerprofil
   (z. B. nur Führungs- oder IT-Stellen melden), analog zu Publikationen.
8. Workflow-Ereignis `stelle.neu` für Automatisierung.

### C — Offene Fragen

- Quelle der Stellen: heute KI-Websuche (Anthropic-Modell mit Suche). Für die Breite
  im Standardprozess wäre eine direkte Abfrage von Indeed/StepStone/Karriereseite
  verlässlicher und billiger, aber ein eigener Crawler-Aufwand. Vorschlag: zuerst A,
  Messung an 50 Firmen, dann entscheiden.
- Datenschutz: Stellenanzeigen sind Firmendaten, keine Personendaten. Unkritisch.
- Compute-Lokalität: Läuft wie heute beim Nutzer (Website-Producer), Schlüssel des
  Nutzers oder der Organisation.

## Stand (2026-10-22, Operator: „direkt Option B“)

Umgesetzt mit v0.1.870 (Desktop + Website-Producer) und Gateway-Deploy:

- Extraktion: `benefits` je Stellenanzeige in allen drei Pipelines (OpenAI Standard,
  OpenAI Deep, Anthropic) mit der Anweisung, Leistungen wörtlich zu übernehmen.
- Karriereseite: `research/karriere.ts` lädt Startseite und bis zu drei Karriere-
  Unterseiten (HTTP, bei dünnem Text Browser-Fallback) und zieht per Modell eine
  Liste wörtlicher Leistungen; gespeichert als `CompanyKarriere` je Firma. Läuft in
  beiden Pfaden (normaler Lauf und manueller Lauf).
- Speicherung: Gateway-Persist schreibt `benefits` und `CompanyKarriere`; Erstsichtung
  je Stelle (Titel + Quelle) bleibt beim Ersetzen erhalten. Schema wird beim ersten
  Persist angelegt (`ensureStellenSchema`), die Website-DB kennt keinen Migrations-
  lauf des Gateways.
- Ausgabe: `/companies/{id}/website` liefert Stellen und Karriere (vorher leerer
  Platzhalter); Firmenansicht zeigt „Was die Firma Beschäftigten bietet“ und
  Leistungen je Anzeige; `company_get` Bereich `website` enthält beides.
- ICP: `icp-felder` liefert `stellen` und `leistungen`; der Bestandsabgleich sieht
  „Offene Stellen“ und „Bietet Beschäftigten“. Mini-Profil im Radar liest Karriere-
  Unterseiten und trägt `mitarbeiterLeistungen` im Profiltext (Radar-Judge).
- Alarm: Neuheiten-Quelle `job-postings` (gebündelt je Firma, Erst-Crawl keine
  Neuheit), Meldungsart `job-posting`, Judge-Regel; Workflows über
  `alert.created` mit filter `{ kind: "job-posting" }`.
- Chat: Werkzeug `seite_lesen` (HTTP + Browser-Fallback, Sperren für private Netze
  und robots.txt-Vollsperre).
- Offen: Pipeline-Stufe mit eigener Auffrischung (heute hängt die Stellen-Recherche
  am Website-Lauf, Auffrischung über dessen Kadenz); Standardstufe bleibt die
  Auto-Aktivierung bei vorhandenem Schlüssel; Messung an 50 Firmen; Quelle Websuche
  vs. direkte Portale.


## Nachtrag 2026-10-25: Stellen direkt von der Karriereseite

Befund Patrick (strategic-it.de): rund 15 Stellen auf der eigenen Karriereseite, AVA
fand nur eine über LinkedIn. Zwei Ursachen: der Standardweg schnitt das rohe HTML
bei 60.000 Zeichen ab (die erste Stelle stand bei 86.000), und die Stellen liegen als
News-Artikel unter /up2date/, was die Prompts ausschlossen. Seit v0.1.882 liest der
Website-Producer die Karriereseite immer selbst (`research/karriere.ts`
`stellenVonWebsite`): Karriere-Links der Startseite, Links zu Anzeigen (m/w/d,
festanstellung, /jobs/…), bis zu 16 Detailseiten, Modellpass in Bündeln zu vier
Seiten, Titel ohne Doppelte. Website-Funde haben Vorrang vor Portal-Treffern mit
gleichem Titel. Der Standardweg kürzt jetzt erst nach der Textumwandlung, und Seiten
auf der eigenen Domain sind in allen Prompts erlaubt.
