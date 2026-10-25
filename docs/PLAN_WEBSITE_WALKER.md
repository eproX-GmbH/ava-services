# Plan: Website-Walker (Seitenwahl und Blockauswahl statt Seitendump)

Stand 2026-10-25. Anlass: Patrick, strategic-it.de. Rund 15 Stellen auf der
Karriereseite, AVA fand eine über LinkedIn. Ursachen: Zeichenschnitt im rohen
HTML (60.000 Zeichen, die erste Stelle stand bei 86.000) und Stellen als
News-Artikel unter /up2date/, die die Prompts ausschlossen. Die Soforthilfe
(v0.1.882, `research/karriere.ts` `stellenVonWebsite`) liest die Karriereseite
direkt. Dieser Plan verallgemeinert das nach dem Muster des Abschluss-Walkers
(docs/PLAN_KONZERNABSCHLUSS.md): Struktur erkennen, Passagen zitieren, nicht
ganze Seiten ins Modell kippen.

## 1. Befund heute

| Zweck | Weg heute | Schwäche |
|---|---|---|
| Stellen | Websuche (Modell mit `web_search`) → bis 5 Quellen → Seitentext mit Stichwortfenster 14.000 Zeichen → Modellpass | Hängt an Suchtreffern; Firmenseiten mit Stellen als News oder tief im HTML fallen durch; seit v0.1.882 Sonderfall Karriereseite |
| Arbeitgeberleistungen | `karriere.ts`: Karriere-Links der Startseite, 3 Seiten, 14.000 Zeichen | ok, aber eigene Mini-Logik |
| Kunden/Referenzen | Website-Pass über Profil-Seiten | ganze Seiten, Logo-Wände ohne Text fallen durch |
| Personen | `website_people`: Team-Seiten per Agent | ganze Seiten, Navigation und Footer mit im Prompt |
| Profil | Startseite plus Unterseiten, Zeichenbudget | Budget frisst sich an Navigation und srcset-Resten auf |

Gemeinsam: jede Stufe hat eigene Seitenwahl, jede lädt ganze Seiten, keine
trägt die Fundstelle je Aussage mit.

## 2. Zielbild

Ein Paket `website/src/infrastructure/walker/` mit drei Schichten, die alle
Zwecke nacheinander nutzen:

1. **Linkgraph** (`graph.ts`): Startseite, Navigation, Sitemap (Index und
   Unter-Sitemaps, bis 500 URLs), Tiefe 2, nur eigener Host. Je Link eine
   deterministische Einordnung aus Pfad und Linktext in Zwecke: `karriere`,
   `stelle` (einzelne Anzeige), `referenzen`, `team`, `impressum`, `news`,
   `produkt`, `sonstiges`. Kein Modell.
2. **Blockzerlegung** (`bloecke.ts`): Seite laden (HTTP, Browser-Rückfall wie
   bisher), Skripte, Styles, Navigation, Kopf, Fuß, Cookie-Banner und
   `srcset` verwerfen, Hauptbereich (`main`, `article`, sonst `body`) in
   Blöcke schneiden: Überschrift plus Folgeabsätze, Listen, Karten,
   Tabellen. Jeder Block trägt URL, Position und Überschriftenpfad.
3. **Signalbewertung** (`signale.ts`): je Block und Zweck eine Dichte aus
   Regeln, z. B. Stellen: `(m/w/d)`, Vollzeit/Teilzeit, „Bewerbung“,
   „Deine Aufgaben“, „Wir bieten“; Referenzen: „Kunden“, „vertrauen“,
   Logo-Listen; Personen: Name-plus-Rolle-Muster. Nur Blöcke über einer
   Schwelle gehen ins Modell, mit Fundstelle, je Lauf gedeckelt.

Das Modell bekommt also je Firma eine Handvoll belegter Passagen statt 5 bis
16 ganzer Seiten.

## 3. Stufen

| Stufe | Inhalt | Stand |
|---|---|---|
| W0 | Plan, Messgrößen festlegen | 2026-10-25 |
| W1 | Walker-Paket `website/src/infrastructure/walker/` (graph.ts, bloecke.ts, signale.ts) und Stellen darüber (stellen.ts): Karriere- und Anzeigen-Seiten aus Navigation, Sitemap und Rückfallpfaden (Soft-404 erkannt), Listen nur signalstarke Blöcke, Anzeigen ganz bis 3.500 Zeichen, Modellpass in Bündeln zu 20.000 Zeichen, Fundstelle je Stelle, reichere Fassung bei gleichem Titel | v0.1.883; Messung strategic-it.de: 17 Seiten, 70 Blöcke, 39.575 Zeichen, 2 Modellaufrufe, 59 s, 14 von 14 Stellen (vorher 0) |
| W2 | Kunden/Referenzen über den Walker (Zweck `referenzen`), Beleg = Block | offen |
| W3 | Personen (`website_people`) über den Walker (Zweck `team`, `impressum`) | offen |
| W4 | Profil: Startseite plus `produkt`-Seiten blockweise, Budget auf Blöcke statt Seiten | offen |
| W5 | Messung an zehn Firmen (Handzählung Stellen, Tokens je Firma) und Nachschärfen der Regeln | offen |

## 4. Messgrößen (W5)

- Zeichen, die je Firma und Zweck ans Modell gehen (Log `[walker] … zeichen=`).
  Ziel: unter 25.000 je Firma für Stellen, vorher 70.000 bis 200.000.
- Gefundene Stellen gegen Handzählung bei zehn Firmen unterschiedlicher
  Website-Technik (TYPO3-News, WordPress, Personio-Einbettung, reine Liste
  ohne Detailseiten, englische Seite). Ziel: mindestens 90 Prozent, keine
  erfundenen.
- Fundstelle je Stelle muss die Anzeige oder die Liste sein, nie die Startseite.

## 5. Entscheidungen

- Kein Vollcrawl, kein Headless-Crawl über die ganze Site: Tiefe 2 plus
  Sitemap reicht; JavaScript-Seiten laufen über den vorhandenen
  Browser-Rückfall (`utils/browser-fetch.ts`).
- Externe Bewerbungsportale (Personio, softgarden, join.com) werden erkannt
  (iframe oder Link) und als eine Quelle geladen, nicht mitgecrawlt.
- Websuche bleibt als Ergänzung für Portale (LinkedIn, StepStone), die
  Firmenseite hat Vorrang bei gleichem Titel.
- Der Walker läuft beim Nutzer (Compute-Lokalität), kein Betreiber-Dienst.
