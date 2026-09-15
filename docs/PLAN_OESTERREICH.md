# Bewertung: Österreich als weiteres Land (Firmenbuch über JustizOnline)

Stand 2026-09-15, Bestandsaufnahme vor einer Umsetzung. Gleiche Frage wie
für die Schweiz (`docs/PLAN_SCHWEIZ.md`, dort auf Halt): Stammdatenliste in
master-data, Registerauszug je Firma, reproduzierbare companyId.

## 1. Quellen (geprüft am 2026-09-15)

**JustizOnline Firmenbuchabfrage** (`https://justizonline.gv.at/jop/web/firmenbuchabfrage`)
- Die Oberfläche ist eine Single-Page-App über eine **öffentliche JSON-API
  ohne Anmeldung**:
  - `GET /jop/service/fba/search?term=<Text>&size=10&page=<n>&state=ACTIVE|DELETED|HISTORIC|ALL`
    → `numResults`, je Treffer `id` (`56247t_17`), `fnr` (`56247t`),
    `status`, `name`, `domicile`. Höchstens 10 je Seite, Paging ohne
    erkennbare Obergrenze (Seite 3000 funktioniert), Mindestlänge des
    Suchbegriffs 3 Zeichen (`Gm` ging, `GmbH` liefert 206.079 aktive
    Treffer). Filter laut `filterConfig`: Status, Rechtsform (200 Werte),
    Gericht (16 Landes-/Handelsgerichte), Bundesland (9); der Parametername
    für Bundesland/Gericht war in der Stichprobe nicht `province`, im
    Notebook zu klären.
  - `GET /jop/service/fba/<fnr>_<n>` → Detail: `fnr`, `status`, `name`,
    `domicile`, `date` (Abrufdatum), `legalForm` (`{abbr: "GES", name:
    "Gesellschaft mit beschränkter Haftung"}`), `address` (PLZ, Straße,
    Ort), `persons: null`, `teilauszug` (Link), `documents` (Auszug
    4,89 EUR, mit Historie 8,20 EUR). `<n>` ist die Eintragungsversion:
    `56247t_1` zeigt den historischen Stand („RED BULL TRADING Gesellschaft
    m.b.H.“, Salzburg), `56247t_17` den aktuellen.
- **Kostenlos ohne Anmeldung:** Firmenbuchnummer, Status, Name, Rechtsform,
  Sitz, Geschäftsanschrift, historische Namens-/Sitzstände.
- **Nur mit Anmeldung (ID Austria / Konto), aber kostenlos:** „Teilauszug“
  (Basisinformationen als PDF; `/jop/secure/service/fba/teilauszug/<fnr>`
  antwortet ohne Sitzung mit 401). Was der Teilauszug über die Detaildaten
  hinaus enthält, ist zu prüfen (vermutlich Geschäftszweig, Stichtag,
  Gericht).
- **Kostenpflichtig (Gerichtsgebühr, TP 10 GGG):** vollständiger
  Firmenbuchauszug mit Geschäftsführung, Gesellschaftern, Stammkapital,
  Prokura, Vertretungsbefugnis: 4,89 EUR je Abruf (8,20 EUR mit Historie),
  über JustizOnline oder Verrechnungsstellen (mit Zuschlag).
- Mengen (Suchbegriff je Rechtsform, aktive Firmen): GmbH 206.079, e.U.
  52.333, KG 37.861, OG 25.938, AG 20.923 (enthält auch Namen mit „AG“),
  Genossenschaften 14.676, Privatstiftungen 2.952. Grob **360.000 aktive
  Rechtsträger**.
- Nutzungsbedingungen für automatisierte Abfragen sind auf der Seite nicht
  ausgewiesen; `robots.txt` liefert die Anmeldeseite. Vor dem Betrieb
  abklären (Justiz-Servicecenter), Takt konservativ wie beim deutschen
  Register.

**Firmenbuchnummer** (`FN 56247t`): bis sechs Ziffern plus ein
Prüfbuchstabe. Die im Netz kolportierte Regel „Zahl mod 26“ stimmt nicht
(56247 mod 26 = 9 → „j“, tatsächlich „t“); auch kein einfaches gewichtetes
Modulo passt auf 15 Stichproben. Eine Nummernfront durch Hochzählen ist
deshalb nicht ohne Weiteres möglich; die Suche verlangt die Nummer mit
Buchstabe (`56247` allein → „invalid length“).

**Ediktsdatei / Insolvenzdatei** (`https://edikte.justiz.gv.at`, Bundesministerium
für Justiz)
- Öffentlich und kostenlos: Insolvenzen mit Suche nach Firmenname,
  Firmenbuchnummer, Gericht, Adresse; dazu Bekanntmachungen und
  Ediktalzustellungen der Firmenbuchgerichte.
- Für Weiterverwendung gibt es eine IWG-Lizenzvereinbarung (Stand Mai
  2024) mit einem **JSON-Webservice** für die Insolvenzdatei
  (`https://iwg.justiz.gv.at/edikte/edikthomeiwg.nsf/export_lookup/id`,
  weitere Exporte je Bereich, „Aktualisierungszyklus: laufend“),
  Antrag über eine Verrechnungsstelle beim BMJ. Ohne Lizenz bleibt die
  Weboberfläche mit Einzelabfrage je Firmenbuchnummer.

**Dritte:** openfirmenbuch.at (privat, „Kurzinformation“ ohne Anmeldung)
spiegelt dieselben Basisdaten; keine Primärquelle, keine API, Lizenz
unklar. Verrechnungsstellen (Compass, CRIF, Manz u. a.) bieten
kostenpflichtige APIs für Vollauszüge und Veränderungsdienste.

## 2. Was das für AVA bedeutet

| Baustein | Deutschland | Schweiz | Österreich |
|---|---|---|---|
| Stammdatenliste | Vollabzug 2023 + Nummernfront | LINDAS (offen, komplett) | JustizOnline-Suche, Paging über Suchbegriffe (≈ 36.000 Anfragen für alle aktiven, einmalig) |
| Delta neue Firmen | Nummernfront | SHAB | kein freies Delta; Wiederholung der Suche je Suchbegriff oder Detail-Refresh je FN |
| Auszug (Zweck, Kapital, Personen) | SI-XML kostenlos | kantonaler Auszug kostenlos | **kostenpflichtig 4,89 EUR je Firma**; kostenlos nur Name, Rechtsform, Sitz, Anschrift, Status, Namenshistorie |
| Insolvenzen | Insolvenzportal | SHAB | Ediktsdatei (Web kostenlos, JSON per IWG-Lizenz) |
| Jahresabschlüsse | Bundesanzeiger | nicht öffentlich | Firmenbuch-Urkunden, kostenpflichtig |

Fazit: Österreich ist für die **Stammdaten** einfach (JSON, kein
Browser, keine Anmeldung), aber der **strukturierte Inhalt** (Geschäftsführung,
Kapital, Zweck) ist nur gegen Gebühr zu haben. Das bricht mit dem heutigen
Modell „Nutzer rechnen alles lokal und kostenlos“. Zwei mögliche Wege:

1. **Stammdaten-only:** Firmen mit Name, Rechtsform, Sitz, Anschrift,
   Status; Profil, Website, Kontakte und Bewertung laufen wie heute über
   die Website der Firma. Handelsregister-Tab zeigt nur die Basisdaten und
   einen Hinweis „Vollauszug kostenpflichtig“. Kein Producer-Geld nötig.
2. **Auszug auf Wunsch:** Nutzer kauft den Auszug je Firma (4,89 EUR) über
   ein eigenes JustizOnline-Konto, AVA liest das PDF ein (Personen,
   Kapital, Zweck). Erfordert Anmeldung im Hintergrund-Browser und
   Zahlungsabwicklung; nichts für den Radar in der Fläche, aber möglich
   für Einzelfälle.

Empfehlung: **Weg 1 zuerst**, Weg 2 als spätere Option.

## 3. Abbildung auf das Datenmodell

| Feld (heute) | Österreich |
|---|---|
| `companyId` | `AT_FN<Nummer><Buchstabe>` = `AT_FN56247T` (Buchstabe groß). Die FN ist die einzige stabile amtliche Kennung; reproduzierbar aus Suche, Detail, Ediktsdatei und Auszug. |
| `name` | `name` |
| `location` | `domicile` (Sitz) |
| `registerNumber` | `56247t` (Original-Schreibweise) |
| `registerType` | Rechtsform-Kürzel (`GES` = GmbH, `AG`, `KG`, `OG`, `EU`, `GEN`, `PS`) aus `legalForm.abbr` |
| `districtCourt` | Firmenbuchgericht (Landesgericht, Handelsgericht Wien) aus Filter/Detail, falls geliefert; sonst leer |
| `state` (Bundesland) | Bundesland |
| `registerStatus` | `ACTIVE` → ACTIVE, `DELETED` → CLOSED, `HISTORIC` = alter Stand (nicht als Firma anlegen) |
| `source` | `justizonline` |
| neu (wie CH): `country`, `legalForm`, `uid` (hier leer; alternativ `fnr`) | |
| `GermanCompanyHistory` | aus den Versionen `<fnr>_1 … _n` (Name, Sitz je Stand) |
| `StructuredContent` | nur Adresse und Rechtsform aus dem Detail; Zweck, Kapital, Geschäftsführung leer (oder aus gekauftem Auszug, Weg 2) |

## 4. Umsetzungsskizze (Weg 1)

1. **Notebook** (wie bei Register und Insolvenz): JSON-Suche paginieren,
   Rechtsform-/Gerichtsfilter-Parameter klären, Versionen `<fnr>_n`,
   Ediktsdatei-Einzelabfrage je FN, Takt messen, Nutzungsbedingungen
   erfragen.
2. **master-data:** Länderspalten (gemeinsam mit CH), Import-Skript über
   die Suche (Suchbegriffe je Rechtsform, Paging, Deduplizierung über
   FN), Delta über Wiederholung alle 30 Tage plus Detail-Refresh der
   Pool-Firmen (Job-Art in der Register-Queue, kein Browser nötig, läuft
   auch auf Fly).
3. **Insolvenz:** Ediktsdatei-Einzelabfrage je FN als Job-Art, analog
   Insolvenzportal DE.
4. **App:** Land, FN statt HRB, Bundesland, Hinweis auf kostenpflichtigen
   Vollauszug.

Aufwand grob: Notebook 1 Tag, master-data und Import 2 Tage, Queue-Jobs 1
bis 2 Tage, App 1 bis 2 Tage. Weg 2 (Auszug kaufen) separat 3 bis 5 Tage.

## 4a. Befunde zur Aufzählung (2026-09-15, Notebook-Schritt)

- **Nummern sind durchsuchbar:** Der Suchbegriff trifft auch die
  Firmenbuchnummer als Teilzeichenkette (`56` → `563165i`, `440256k`;
  `47t` → `540747t`, `112347t`). Da jede Nummer auf Ziffer plus
  Prüfbuchstabe endet, ist die Vereinigung der 260 Begriffe
  `<Ziffer><Buchstabe>` **vollständig per Konstruktion**, ohne
  Prüfbuchstaben-Regel und ohne Nummernfront. Kosten: rund eine Anfrage je
  10 Firmen plus 260 Begriffe je Bundesland, für 360.000 aktive Firmen etwa
  40.000 Anfragen einmalig.
- **Ratengrenze gemessen:** 3 Anfragen je Sekunde → HTTP 429 mit
  `Retry-After: 10`; 1 Anfrage je 2 Sekunden über 90 Anfragen ohne 429.
  Betriebstakt 0,5 je Sekunde und IP, also rund 40.000 je Tag: der
  Erstimport dauert etwa einen Tag auf einer Maschine.
- Prüfbuchstaben: nicht alle 26 Buchstaben kommen vor (`c`, `e`, `h` … sehr
  selten oder gar nicht); Begriffe ohne Treffer kosten je eine Anfrage.
- **Lauf Burgenland (`scripts/at/enumerate_bundesland.py 1`):** 8.813 aktive
  Firmen, 1.053 Anfragen (8,4 Firmen je Anfrage), 44 Minuten bei 0,5 je
  Sekunde, keine Sperre. Prüfbuchstaben: nur a b d f g h i k m p s t v w x y z
  (17), das Skript lässt die übrigen 9 aus. 9 % der Firmen tragen keine
  Rechtsform-Kennung im Namen („Konditorei - Cafe Harrer Anton“, „easypeak
  FlexCo“), Namensbegriffe allein wären also unvollständig.
  Hochrechnung: rund 360.000 Firmen, etwa 43.000 Anfragen, ein Tag auf
  einer Maschine; danach Wiederholung je Bundesland alle 30 Tage plus
  Detail-Refresh der Pool-Firmen.

- **Ediktsdatei je FN (Notebook §7):** Weboberfläche ohne Login und ohne
  Session per GET nutzbar. FN-Einzelabfrage
  `suchedi?SearchView&subf=f&…&query=([FN]=(588123m))` (Prüfbuchstabe
  Pflicht, Groß/Klein egal), Tagesliste `subf=eid` mit
  `([DATBMA]>=Datum | [DATBMZ]>=Datum)` (alle Verfahren mit Bekanntmachung
  ab Datum, Firmen und Privatpersonen, ohne FN-Spalte; rund 200 je Tag,
  Stichprobe: 45 % mit FN). Detailseite `0/<docId>!OpenDocument` = eine
  Seite je Verfahren mit allen Bekanntmachungen chronologisch, FN im Span
  `Schuldner-Firmenbuchnummer`. Beispiel `AT_FN588123M`: Eröffnung
  13.11.2025, Aufhebung mangels Kostendeckung 24.08.2026, Rechtskraft
  14.09.2026. Kategorien wie DE abbildbar (Eröffnung, Abweisung mangels
  Kostendeckung, Aufhebung, Sanierungs-/Zahlungsplan; keine
  Sicherungsmaßnahmen). Vorschlag: Modus A wie in Deutschland, je
  Pool-Firma alle 30 Tage 1 bis 2 Anfragen, Takt 1/s, kein Browser nötig.

## 4b. Stand der Umsetzung

- **master-data (2026-09-15, f4ee8be, Deploy offen):** Länderspalten
  `country` (DE | AT | CH, Default DE, Index), `legalForm` (Langname),
  `uid` (ATU…, CHE-…) an GermanCompany; Migration
  `20260915140000_laenderspalten` (reine Katalogänderung, läuft per
  `release_command`). Register-Delta-Route validiert mit Yup je Land:
  companyId-Muster (DE Original-Scraper inkl. Umlaut-Zusatz und
  `_F<ALT>`, `AT_FN<Nummer><Buchstabe>`, `CH_CHE<9 Ziffern>`),
  Feldlängen, UID-Muster; `legalForm`/`uid` optional (Suchtreffer ohne
  Detail behalten den Bestand). Elastic-Dokument trägt `country`;
  DTOs get/list/fuzzy liefern `country`, `legalForm`, `uid`, Listenfilter
  `country`. InsolvencyEvent kennt `quelle` je Meldung
  (`insolvenzportal` | `ediktsdatei`). 31 Unit-Tests grün.
- **Nächster Schritt (Gateway + Paket register-delta):** Job-Arten
  `at_front` (Aufzählung je Gericht und Begriff `<Ziffer><Buchstabe>`,
  16 Gerichte × 170 Begriffe), `at_refresh` (Detail je FN alle 30 Tage,
  liefert legalForm, Adresse, Status) und `at_insolvenz` (Ediktsdatei je
  FN, §7 Notebook); Abbildung Gericht → Bundesland aus `filterConfig`.
  Kein Browser nötig, läuft im Fly-Worker und beim Mithelfen.
- **Danach App:** Land und FN in Tabellen und Firmendetails, Hinweis auf
  kostenpflichtigen Vollauszug.

## 5. Offene Entscheidungen

1. Weg 1 (Stammdaten-only) jetzt, Weg 2 später?
2. Welche Rechtsformen aufnehmen (Einzelunternehmen e.U. 52.000 ja/nein).
3. Nutzungsbedingungen JustizOnline für automatisierte Abfragen einholen
   (Servicecenter), Takt danach festlegen.
4. Ediktsdatei: Weboberfläche je FN (kostenlos, ohne Lizenz, im Notebook
   belegt) oder IWG-Lizenz mit JSON-Webservice (Antrag über
   Verrechnungsstelle). Vorschlag: Weboberfläche, Modus A.
5. Länderspalten in master-data gemeinsam mit der Schweiz einführen
   (`country`, `legalForm`, `uid`), damit beide Länder dasselbe Modell
   nutzen.
