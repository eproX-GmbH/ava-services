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

## Später

- Umkehrsuche „Wer nennt X als Kunden?“ über alle Firmen des Nutzers.
- Gemeinsame Kunden im Vertriebsblick.
- Zertifikate und Technologie-Partner als eigene Arten.
