# Plan: Kunden und Referenzen einer Firma (2026-10-06)

## Ziel

Die Website-Verarbeitung erkennt, welche Kunden, Referenzen und Partner eine
Firma selbst nennt (Logowände, Referenzseiten, Fallstudien). Das Ergebnis
steht als Reiter „Kunden“ auf der Firmendetailseite, fließt in den
Chat-Kontext einer Firmenabfrage und wird gegen die Stammdaten abgeglichen,
damit ein genannter Kunde mit einem Klick übernommen und verarbeitet werden
kann.

## Vorgaben

- Erkennung durch KI, keine Heuristik-Kataloge: Die Seite wird als Digest
  (Text plus Bildliste mit Dateiname, Alt- und Title-Text, Link-Ziel) an das
  Modell gegeben, das entscheidet, was ein Kunde ist. „audi-logo.png“ mit
  Alt „AUDI Referenz Logo“ wird so zu „Audi“, ohne Markenliste.
- Halluzinationssperre wie beim Tech-Stack: Ein Name zählt nur, wenn er
  (buchstabenweise verglichen) im Digest vorkommt.
- Welche Seiten gelesen werden, entscheidet die URL (referenzen, kunden,
  customers, case-studies, projekte, partner, portfolio) plus Startseite.
  Das ist Seitenauswahl, nicht Erkennung. Höchstens 6 Seiten, ein
  Modellaufruf je Firma.
- Compute-Lokalität: Erkennung läuft im Kontakt-Producer beim Nutzer. Das
  Gateway speichert und gleicht ab.
- Ein Erst-Crawl ist keine Neuigkeit (Regel vom 2026-10-05): Kunden werden
  gespeichert, aber nicht als Alarm gemeldet. Alarme „neuer Kunde“ kommen
  später über den Neuheiten-Endpunkt mit Bestandsprüfung.

## Entscheidung: Producer

Kontakt-Producer (`company-contact`), nicht Website-Producer: Er hat den
Crawler mit Sitemap-Priorisierung, den Browser-Abruf, `htmlToText`, die
LLM-Seitenanalyse mit `generateObject` + yup + Schema-Bergung und den
Persist-Weg ins Gateway, in dem der Tech-Stack-Block (`techVendors`) als
Vorlage dient. Der Kunden-Pass läuft nach dem Crawl als eigener Block wie
der Datenschutz-Pass.

## Umsetzung

### K1 Producer (`company-contact`)

- `infrastructure/contact-extraction/kunden.ts`
  - `istReferenzPfad(url)` und `findeReferenzUrls(seedUrl, kandidaten, max)`:
    Seitenauswahl aus Sitemap und gesehenen Links; Startseite immer.
  - `kundenDigest(html, url)`: Text (gekürzt) und Bildliste
    `dateiname | alt | title | link` (höchstens 80 Bilder, keine Data-URIs).
  - `erkenneKunden({digests, companyName, llm, logger})`: ein Aufruf,
    Schema `{ kunden: [{ name, art: kunde|partner|referenzprojekt, beleg,
    quelle, konfidenz: hoch|mittel }] }`, yup-Validierung, Schema-Bergung,
    Halluzinationssperre, Firma selbst ausgeschlossen, höchstens 60.
- `compute-worker.ts`: Referenz-URLs während des Crawls merken (wie
  `merkePrivacy`), nach dem Datenschutz-Block den Kunden-Pass fahren,
  `emitPersist({ kunden, source: "agent:referenzen" })`.
- Persist-Typ `CompanyContactPersistResult.kunden`.

### K2 Gateway

- `lib/kunden.ts`: Tabelle `CompanyKunde` in der Gateway-DB (CREATE IF NOT
  EXISTS wie `ProfileChangeEvent`): `companyId, name, nameNormalized, art,
  beleg, quelle, konfidenz, erstGesehen, zuletztGesehen, matchCompanyId,
  matchName, matchLocation, matchGeprueftAt`, eindeutig je
  `(companyId, nameNormalized)`. `schreibeKunden` upsert (zuletztGesehen,
  Beleg frisch), `listeKunden`, `setzeMatches`.
- `contact-extraction-apply.ts`: `result.kunden` → `schreibeKunden`
  (best-effort, bricht den Persist nie).
- `routes/v1/companies-kunden.ts`: `GET /companies/{companyId}/kunden`.
  Abgleich gegen Stammdaten wie im Radar: Dry-Run der Data-Care-Zuordnung
  (`/api/v1/data-care`, `isFuzzy`, `dryRun`) für alle Zeilen ohne Prüfung
  oder älter als 30 Tage, Ergebnis gespeichert. Antwort je Kunde mit
  `match: { companyId, name, location } | null`.

### K3 Desktop

- Reiter „Kunden“ (`TabKey "kunden"`), nur sichtbar mit Daten. Je Kunde:
  Name, Art, Beleg mit Quelle, Stammdaten-Treffer mit Link zur Firma und
  Knopf „Übernehmen“ (`FirmaUebernehmen`, startet Import plus Verarbeitung
  über `/v1/imports/from-list`), sonst „nicht in den Stammdaten“.
- Chat: `company_get` mit Bereich `kunden` (kompakt: Name, Art, Treffer),
  Werkzeugbeschreibung ergänzt.

## K4 Alarm „neuer Kunde“ (v0.1.755, 2026-10-06)

- `POST /v1/alerts/neuheiten` liefert `new-customers`: Einträge aus
  `CompanyKunde` mit `erstGesehen` nach `since`, je Firma gebündelt (bis 8
  Namen mit Stammdaten-Treffer). Erst-Crawl ist keine Neuheit: nur Firmen,
  die vor `since` schon Kunden hatten.
- Desktop: Alert-Art `customer-change` („Neue Kunden“). Der Kandidat
  markiert Kunden, die selbst in der eigenen Firmenliste stehen („in deinen
  Firmen“: Wettbewerber oder Partner bedient den eigenen Kunden).
- Judge: passt ein Kunde zu Branche, Region, Idealkunde oder steht er in
  den eigenen Firmen = warn; viele neue Referenzen bei heißer Firma = info;
  lauter fachfremde Namen = nichts.

## Umkehrsuche (v0.1.756, 2026-10-06)

- Gateway `POST /v1/kunden/suche` `{ companyIds, name?, zielCompanyId? }`:
  Nennungen über die Firmenliste des Aufrufers, Treffer über den
  Stammdaten-Abgleich oder den genannten Namen (Normalform, Teiltreffer).
- Chat-Werkzeug `kunden_umkehrsuche` (`name` oder `companyId`): je nennender
  Firma Art, Beleg, Quelle, Stammdaten-Treffer. Fähigkeitsgruppe „firmen“
  um `kunden_*` ergänzt.

## Gemeinsame Kunden im Vertriebsblick (v0.1.757, 2026-10-06)

- Gateway `POST /v1/kunden/gemeinsam` `{ companyId, companyIds }`: Kunden
  von X, die auch andere Firmen der Liste nennen (gleich über
  Stammdaten-Treffer oder Normalform des Namens).
- `company_kunden` (Bereich `kunden`) liefert dazu `gemeinsameKunden`,
  `wirdGenanntVon` (eigene Firmen, die X nennen) und `inMeinenFirmen` je
  Kunde. Vertriebsblick-Prompt: gemeinsame Kunden als Anlass nennen und
  `kunden` bei Vertriebs-, Ansprache- und Wettbewerbsfragen mitladen.

## Zertifikate und Technologiepartner (v0.1.759, 2026-10-06)

- Zwei neue Arten: `technologiepartner` (Herstellerprogramme wie SAP-,
  Microsoft-, Siemens-Partner; Name = Hersteller) und `zertifikat` (ISO,
  TÜV, Siegel, Auszeichnungen der Firma selbst). `partner` bleibt für
  Vertriebs-, Kooperations- und Netzwerkpartner. Deckel 80 je Firma.
- Zertifikate sind keine Firmen: kein Stammdaten-Abgleich, im Reiter ohne
  Treffer und Aktion. Technologiepartner werden abgeglichen und sind
  übernehmbar.
- Judge: neue Zertifikate oder Herstellerprogramme sind Anlässe, wenn sie
  zum Angebot des Nutzers passen (info).

## Best Match im Stammdaten-Abgleich (v0.1.772, 2026-10-07)

Befund: Der Abgleich lief seit K2 nie. master-data verlangt beim Data-Care-
Trockenlauf den Parameter `city` (Spaltenname); ohne ihn antwortet es 400,
der Fehler wurde als „best-effort“ geschluckt und keine Zeile als geprüft
markiert (EnKo Engineering GmbH stand deshalb auf „nicht gefunden“).

Neu (`lib/kunden-match.ts`, Spalten `matchStufe`, `matchScore`):
- Aus den bis zu 5 Kandidaten (mit Elasticsearch-Score) wird immer ein
  Best Match gewählt und eingestuft.
- **sicher**: genau ein Kandidat trifft den Namen ohne Rechtsform an einer
  Wortgrenze, oder ein Mehrwortname wird exakt getroffen (EnKo Engineering
  GmbH).
- **unsicher**: mehrere Kandidaten treffen den Namen (KUKA AG, KUKA
  Deutschland GmbH …) → der exakte, sonst der mit dem höchsten Score; oder
  kein Namenstreffer, aber alle Wörter des Kundennamens kommen im besten
  Kandidaten vor (Hettich → Paul Hettich GmbH & Co. KG).
- sonst „nicht gefunden“ (Audi ≠ Audio Service).
- Reiter: Pille „sicher“/„unsicher“ neben dem Treffer; Chat-Tool liefert
  `stufe` und soll sie vor dem Übernehmen nennen.
- Prüfung: `npx tsx scripts/test-kunden-match.mts` im Gateway.

## Stufe 0: normalisierte Namenssuche vor Elasticsearch (2026-10-07)

Vorgabe: Firmennamen auf Kleinschrift und [a-z0-9] reduzieren (ä→ae, ß→ss,
Akzente abgelegt, alles andere raus), damit Schreibvarianten derselben Firma
zusammenfallen („Öhrmann - Maschinenbaufabrik GmbH“ = „Oehrmann-
Maschinenbaufabrik GmbH“). Erst wenn das keinen oder mehrere Treffer liefert,
kommt Elasticsearch mit Score dran.

Umsetzung ohne Nachfüllen und ohne master-data-Codeänderung:
- SQL-Funktion `firmen_schluessel(text)` (IMMUTABLE) in ava_master_data,
  Ausdrucksindizes auf GermanCompany.name und GermanCompanyHistory.name
  (CONCURRENTLY), siehe `services/db-gateway/sql/master-data-firmen-schluessel.sql`.
  Postgres pflegt die Indizes bei jedem Upsert.
- Gateway `kunden-match.ts` → `schluesselTreffer`: ein Aufruf je Liste,
  aktive Firmen, auch über frühere Namen; genau ein Treffer = „sicher“
  (score null). Sonst Elasticsearch wie bisher. Beide Seiten nutzen dieselbe
  SQL-Funktion, die Normalform kann nicht auseinanderlaufen.
- Die vorhandene Spalte nameNormalized war dafür unbrauchbar (1,8 Mio. leer,
  anderes Format, kein Index).

## Später

- Gemeinsame Kunden im Vertriebsblick.
- Zertifikate und Technologie-Partner als eigene Arten.
