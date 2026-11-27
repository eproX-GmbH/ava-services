# Plan: Firmenlogos erfassen und anzeigen (2026-11-27)

Stand 27.11.2026: Plan abgenommen (Joyce: „Ja, fang an“), LG1 bis LG3 gebaut und einzeln
geprüft, noch nicht ausgeliefert. Offen bis zum ersten Lauf im echten Ablauf: Zugangsdaten
als Secrets auf beide Gateways, Kandidat taggen, Website-Stufe einer Firma neu laufen lassen.

## 1. Ziel

Zu jeder aufbereiteten Firma liegt ein Logo vor und erscheint überall, wo AVA die Firma
zeigt: im Firmenprofil im Chat (heute ein Kürzel aus Buchstaben), im Kopf der
Firmenansicht, in Listen, im Radar, später in der App im Browser, in der Konsole und in
Mails. Die Erkennung läuft stufenweise: erst die besten Quellen, das 16×16-Favicon nur
als allerletzter Ausweg. Quadratische Bilder ab etwa 256 px sind das Ziel, aber keine
Pflicht.

## 2. Messung an echten Firmen-Websites (27.11.2026)

Feste Stichprobe von 40 der 1.071 Websites aus dem Bestand, 38 erreichbar. Je Quelle
wurden bis zu drei Bilder geladen und vermessen (Skript und Rohdaten liegen im
Arbeitsordner der Sitzung, nicht im Repo).

| Quelle | Seiten mit Angabe | Bild ladbar | quadratisch | quadratisch ≥ 128 px | Bemerkung |
|---|---|---|---|---|---|
| `link rel="icon"` (mit Größen) | 31 | 31 | 30 | 18 | 9 davon ≥ 256 px, 3 SVG |
| `apple-touch-icon` | 22 | 21 | 20 | 19 | fast immer 180×180 |
| Web-App-Manifest (`icons`) | 5 | 3 | 3 | 3 | selten, dann bis 512×512 |
| JSON-LD `Organization.logo` | 16 | 11 | 1 | 1 | fast immer breite Wortmarke, 4 SVG |
| Logo-Bild im Kopf der Seite | 31 | 31 | 8 | 6 | 12 mit SVG; im Mittel 10 Kandidaten je Seite |
| Inline-SVG im Kopf | 14 | – | – | – | nicht als Datei ladbar |
| `og:image` | 14 | 14 | 2 | 2 | meist Banner (Median 92 KB), nur 3 mit „logo“ im Namen |
| `/favicon.ico` | 38 | 19 | 19 | 4 | meist 16 bis 48 px |

Ergebnis der Stufenwahl über alle Quellen:

- **Quadratisches Zeichen:** bei 34 von 38 Seiten (89 %); gut (≥ 128 px oder SVG) bei
  24 (63 %), davon 14 mit mindestens 256 px; mittel (64 bis 127 px) bei 4, nur klein
  (unter 64 px) bei 6, gar keins bei 4.
- **Breite Wortmarke:** bei 29 von 38 Seiten (76 %).
- **Zusammen:** 36 von 38 Seiten (95 %) liefern ein gut darstellbares Logo (gutes
  Zeichen, sonst Wortmarke, in einem Fall nur Inline-SVG). Bei 2 bleibt nur ein kleines
  Favicon oder nichts.
- **Größe:** Median 5 KB je Bild, 90 % unter 53 KB, 3 von 177 über 256 KB. Je Firma
  (bestes Zeichen plus Wortmarke, Original) im Mittel 52 KB, Median 18 KB.
- **Formate der Zeichen:** PNG 43, ICO 7, SVG 3, WebP 2.

## 3. Folgerungen

1. **Es gibt zwei Arten von Logo, und sie kommen aus verschiedenen Quellen.** Das Logo
   im Kopf der Seite und in JSON-LD ist fast immer eine breite Wortmarke (nur 8 bzw. 1
   quadratisch). Quadratische Zeichen stehen in `apple-touch-icon`, im Manifest und in
   den großen `rel="icon"`-Einträgen. Für runde oder quadratische Flächen (Listen,
   Kürzel im Profil) ist deshalb nicht das Kopf-Logo die beste Quelle, sondern das
   App-Symbol der Website.
2. **Beide erfassen.** Zeichen für kleine Flächen, Wortmarke für den Kopf von Profil und
   Firmenansicht. Fehlt das Zeichen, wird die Wortmarke in die quadratische Fläche
   eingepasst; das kleine Favicon kommt erst danach.
3. **`og:image` taugt kaum** (meist Banner) und zählt nur, wenn der Dateiname oder der
   Alternativtext „logo“ enthält.
4. **Das Kopf-Logo braucht eine Rangfolge**, weil eine Seite im Mittel 10 Bilder mit
   Logo-Merkmal trägt (Partner, Siegel, kleine Symbole).
5. **Die Bilder sind klein.** Eine Bildbibliothek zum Umrechnen ist für den Anfang nicht
   nötig: Original speichern, Maße merken, in der Oberfläche einpassen.

## 4. Erkennung in Stufen

Ort: Website-Stufe (`website`, eigenes Repository `eproX-GmbH/website`), dort, wo die
Startseite heute schon mit cheerio gelesen wird
(`src/infrastructure/utils/metadata-utils.ts`, `extractMetadataFromHtmlToJson`). Die
Stufe läuft auf dem Gerät des Nutzers; der Betreiber rechnet nichts.

**Zeichen (quadratisch), erste passende Stufe gewinnt, innerhalb der Stufe das größte:**

1. Web-App-Manifest: größtes Symbol mit Zweck „any“.
2. `apple-touch-icon`.
3. `link rel="icon"` ab 64 px oder als SVG.
4. Quadratisches Bild aus JSON-LD oder aus dem Kopf der Seite (ab 64 px).
5. Keine Datei: Die Oberfläche passt die Wortmarke in die quadratische Fläche ein.
6. Letzter Ausweg: kleines `rel="icon"` oder `/favicon.ico` (unter 64 px), als „klein“
   markiert.

**Wortmarke (breit):**

1. JSON-LD `Organization.logo` (auch in `@graph`).
2. Kopf der Seite: Bild im Verweis auf die Startseite oder mit Logo-Merkmal in Klasse,
   Kennung, Alternativtext oder Dateiname. Rang: im `header` oder ganz oben im Dokument,
   Firmenname im Alternativtext oder Dateinamen, SVG vor PNG vor WebP vor JPEG.
   Ausgeschlossen: Bereiche für Partner, Kunden, Referenzen, Siegel, Fußzeile und
   Bildwechsler; Bilder unter 48 px; Seitenverhältnis über 12:1 (gemessene Wortmarken
   liegen bei gut 8:1).
3. Inline-SVG im Kopf (bereinigt gespeichert), siehe Entscheidung E8.
4. `og:image`, nur mit „logo“ im Namen oder Alternativtext.

**Prüfregeln für jedes Bild:**

- nur `http`/`https`, keine privaten oder lokalen Adressen, höchstens 256 KB, Frist 10 s,
  je Firma höchstens 8 Abrufe;
- Bildart aus den ersten Bytes, nicht aus der Kopfzeile des Servers; erlaubt sind PNG,
  JPEG, WebP, GIF, ICO, SVG;
- Maße aus dem Dateikopf (ohne Bildbibliothek, wie im Messskript);
- SVG wird bereinigt (kein `script`, kein `foreignObject`, keine Ereignis-Attribute,
  keine fremden Verweise) und nur als Bild eingebunden, nie als Dokument.

## 5. Speicherung

| Weg | Vorteil | Nachteil |
|---|---|---|
| **A. Postgres, Website-Datenbank** (Bytes in eigener Tabelle) | keine neue Infrastruktur, kommt mit dem bestehenden Persist-Weg, Sicherung inklusive | wächst in der geteilten Datenbank mit (rund 50 MB je 1.000 Firmen im ungünstigen Fall) |
| **B. Objektspeicher (S3-artig, etwa Wasabi oder Tigris)** | für Bilder gemacht, praktisch kostenlos, öffentliche Adressen für Mails möglich | neue Zugangsschlüssel, neue Abhängigkeit im Gateway, Zugriffsregeln zu entscheiden |
| C. Nicht speichern, Originaladresse einbinden | kein Speicher | bricht bei Sperren und Umzügen, verrät der Firma jeden Aufruf, verlangt offene Bildquellen in der App |
| D. Nur lokal auf dem Gerät | einfach | nicht geteilt, fehlt in App, Konsole und Mails |

**Entschieden (Joyce, 27.11.2026): B, Objektspeicher von Anfang an, bei Wasabi.** Bucket
`ava-prod`, Region `eu-central-2` (Endpunkt `s3.eu-central-2.wasabisys.com`), S3-artig.
Die Bilder liegen unter `logos/<sha256>.<endung>`, nach Inhalt adressiert; das Präfix hält
den Bucket für anderes frei. Nur das Gateway schreibt und liest; die Zugangsdaten liegen
als Fly-Secrets auf Prod- und Staging-Gateway (beide arbeiten auf denselben Daten, also
auf demselben Bucket) und nie im Repository oder auf Nutzergeräten. Der Bucket bleibt
privat (E3). Zugriff im Gateway über signierte Anfragen ohne das große AWS-Paket
(`aws4fetch` oder eigene Signatur, rund 40 Zeilen).

Stand 27.11.2026: Zugriff geprüft und in Ordnung (auflisten, schreiben, lesen, löschen;
ohne Anmeldung kein Zugriff; Versionierung aus). Der Schlüssel (Benutzer `ava`) sieht
allerdings alle Buckets des Kontos. Für das Gateway genügt eine Richtlinie nur für diesen
Bucket: `s3:ListBucket` auf `arn:aws:s3:::ava-prod` sowie `s3:GetObject`, `s3:PutObject`,
`s3:DeleteObject` auf `arn:aws:s3:::ava-prod/*`. Der Verbindungsaufbau lief im Test
vereinzelt in Zeitüberschreitungen: Der Zugriff im Gateway bekommt Fristen und
Wiederholungen.

Hinweise zu Wasabi: Abrechnung mit Monatsminimum von 1 TB; gelöschte Objekte zählen bis
zum 90. Tag weiter. Für Logos ohne Belang (wenige MB, kaum Löschungen).

**Datenmodell (nur neue Tabellen, Website-Datenbank):**

- Die Bytes liegen im Bucket, nicht in der Datenbank; gleiche Bilder (Konzern mit einem
  Symbol) liegen dort einmal.
- `CompanyLogo`: `companyId`, `rolle` (`zeichen` | `wortmarke`), `sha256`, `breite`,
  `hoehe`, `stufe` (Herkunft), `quelleUrl`, `klein`, `geprueftAt`. Schlüssel
  `companyId` + `rolle`.
- `Website.logoGeprueftAt`: auch „nichts gefunden“ wird gemerkt, damit nicht jeder Lauf
  neu sucht.

**Persist-Weg:** Die Bilder reisen im bestehenden Ereignis `tenant.persist.website.v1`
mit (höchstens zwei, je höchstens 256 KB); das Gateway legt sie in den Bucket und schreibt
die Angaben neben der Zeile in `Website` (`services/db-gateway/src/lib/persist-bus.ts`).
Kein zweiter Kanal. Scheitert der Bucket, bleibt die Website-Zeile gültig und das Logo
wird beim nächsten Lauf erneut versucht.

## 6. Auslieferung und Anzeige

- **Gateway:** Die Firmendaten tragen je Rolle Schlüssel, Maße, Bildart und „klein“
  (Route `/v1/companies/{id}/website`, dazu die Listen für Meine Firmen und Radar, damit
  keine Abfrage je Zeile nötig ist). Das Bild selbst liefert `/v1/logos/{sha256}`, mit
  Anmeldung, unveränderlich zwischenspeicherbar.
- **Desktop:** eigenes Protokoll `ava-logo://<sha256>` im Hauptprozess mit dauerhaftem
  Zwischenspeicher auf der Platte, wie heute `ava-screenshot://` und
  `ava-linkedin-media://`; in der Seitenrichtlinie (`img-src`) kommt nur dieses
  Protokoll dazu.
- **App im Browser und Konsole:** Weiterleitung über deren eigene Gateway-Route
  (gleiche Herkunft, Anmeldung bleibt dort).
- **Ein Baustein `FirmenLogo`** für alle Stellen: zeigt Zeichen, sonst eingepasste
  Wortmarke, sonst das heutige Kürzel. Immer auf heller Fläche mit Rand, auch im
  dunklen Design, weil die meisten Logos für weißen Grund gemacht sind.
- **Reihenfolge der Stellen:** Firmenprofil im Chat und Kopf der Firmenansicht (mit
  Wortmarke), dann Meine Firmen, Firmensuche, Radar, Meldungen, Firmenkarte im Chat.

## 7. Aktualisierung, Bestand, Korrektur

- **Neu aufbereitete Firmen** bekommen das Logo mit der Website-Stufe.
- **Auffrischung:** Bei jedem Lauf der Website-Stufe werden die Kandidaten neu gelesen;
  geladen wird nur, wenn sich die Adresse geändert hat oder die letzte Prüfung älter als
  90 Tage ist.
- **Bestand (1.071 Firmen):** leichter Nachlauf „nur Logo“ ohne KI und ohne Websuche
  (Startseite plus wenige Bilder), gedrosselt, je Nutzer für die eigenen Firmen. Siehe
  E6.
- **Korrektur durch den Nutzer:** „Das Logo ist falsch“ im Chat und ein Knopf in der
  Firmenansicht: anderes Bild von der Website wählen, Adresse angeben oder entfernen.
  Als Werkzeug mit Bestätigung, wie beim Festlegen der Website.

## 8. Recht

Logos sind marken- und oft urheberrechtlich geschützt. Die Anzeige zur Kennzeichnung der
Firma in einem Werkzeug ist üblich; AVA verändert die Bilder nicht, wirbt nicht damit
und nennt die Herkunft (gespeicherte Quelladresse). Auf Wunsch einer Firma wird das Logo
entfernt und gesperrt. Öffentliche Bildadressen ohne Anmeldung gibt es erst nach
Entscheidung E3. Vor dem Start einmal anwaltlich gegenlesen lassen (E7).

## 9. Stufen

| Stufe | Inhalt | Aufwand |
|---|---|---|
| LG0 | Messung und Entscheidungen (dieser Plan) | erledigt bis auf die Abnahme |
| LG1 | Erkennung in der Website-Stufe: Kandidaten, Abruf, Vermessung, Auswahl, SVG-Bereinigung; Tests mit gespeicherten Startseiten aus der Stichprobe | 2 Tage |
| LG2 | Speicher und Persist: Bucket-Zugriff im Gateway, Tabelle, Schreibweg, Routen, Felder in den Firmendaten | 1,5 Tage |
| LG3 | Desktop: Protokoll, Baustein `FirmenLogo`, Firmenprofil im Chat und Firmenansicht | 1,5 Tage |
| LG4 | Listen, Radar, Meldungen, Firmenkarte | 1 Tag |
| LG5 | Bestand nachziehen und Auffrischung | 1 Tag |
| LG6 | Korrektur durch den Nutzer, Lösungskarten, Prüfsatz | 1 Tag |
| LG7 | App im Browser und Konsole | 1 Tag |
| später | PNG-Fassung für Mails, Erkennung heller Logos für dunklen Grund | offen |

Nach LG3 ist das Logo im Chat und in der Firmenansicht zu sehen; das ist der erste
vorzeigbare Stand (rund 5 Tage).

**Umsetzung LG1 bis LG3 (27.11.2026):**

- LG1, Repository `website`: `src/infrastructure/utils/logo/` (`kandidaten.ts`, `auswahl.ts`,
  `masse.ts`, `svg.ts`, `holen.ts`), eingehängt in `compute-worker.ts` nach dem Lesen der
  Startseite; 21 Tests. Echtprobe auf der Stichprobe: 36 von 37 erreichbaren Seiten liefern
  ein Logo (33 Zeichen, davon 21 gut und 9 klein; 22 Wortmarken), im Mittel 25 KB je Firma.
  Aus der Echtprobe: kleine Icons bleiben als letzter Ausweg stehen, Fotos im Kopf
  (1920×1080, Hochformat) zählen nicht als Wortmarke.
- LG2, Gateway: `lib/objektspeicher.ts` (eigene Signatur, Frist 8 s, drei Versuche),
  `lib/firmen-logos.ts` (Prüfung jedes Bildes, Tabelle `CompanyLogo` entsteht beim ersten
  Logo), Persist-Weg außerhalb des Tier-Gates (`mitLogos` in `persist-bus.ts`), Felder
  `logos` in `/v1/companies/{id}/website`, Route `/v1/logos/{sha256}`; 12 Tests, dazu eine
  Echtprobe des Speicher-Moduls gegen den Bucket. Umgebungsvariablen `OBJEKTSPEICHER_*`;
  ohne sie ruht alles.
- LG3, Desktop: `main/logo-cache.ts` und Protokoll `ava-logo://<sha256>` (Ordner
  `shared/logos`), Baustein `components/FirmenLogo.tsx`, eingesetzt im Firmenprofil im Chat
  und im Kopf der Firmenansicht (dort nur, wenn es ein Logo gibt). Eine Wortmarke bekommt
  im Kopf eine breitere Fläche. Lösungskarte `firma-logo`; 10 Tests; Vorschau mit echten
  Logos in hell und dunkel.
- Bewusst noch nicht: Vermerk „geprüft, nichts gefunden“ (`logoGeprueft` reist schon mit,
  wird aber nicht gespeichert), Listen (LG4), Nachlauf für den Bestand (LG5), Korrektur durch
  den Nutzer (LG6), App im Browser und Konsole (LG7).

## 10. Entscheidungen

- **E1 Zwei Fassungen?** Zeichen und Wortmarke getrennt erfassen (Empfehlung) oder nur
  ein Bild je Firma.
- **E2 Speicherort:** entschieden am 27.11.2026: Objektspeicher bei Wasabi (Bucket
  `ava-prod`), siehe Abschnitt 5.
- **E3 Zugriff:** Bilder nur mit Anmeldung (Empfehlung für den Start) oder öffentliche,
  nicht erratbare Adressen (nötig für Mails).
- **E4 Umrechnen:** Originale speichern und in der Oberfläche einpassen (Empfehlung) oder
  beim Erfassen auf 512×512 PNG umrechnen. Das Umrechnen braucht eine Bildbibliothek mit
  Maschinencode in der Desktop-App (drei Zielplattformen, Paketrisiko).
- **E5 LinkedIn als Quelle:** Das Firmenlogo von der LinkedIn-Seite wäre meist
  quadratisch und gut. Empfehlung: nicht im ersten Wurf (Nutzungsbedingungen, eigener
  Abruf).
- **E6 Bestand:** aktiver Nachlauf für die eigenen Firmen jedes Nutzers (Empfehlung) oder
  warten, bis die Website-Stufe ohnehin neu läuft.
- **E7 Recht:** anwaltliche Prüfung vor dem Start, Wortlaut für Entfernung auf Wunsch.
- **E8 Inline-SVG:** mitnehmen (14 von 38 Seiten haben eins, aber nur 3 davon keine
  Wortmarke als Datei) oder im ersten Wurf weglassen (Empfehlung: weglassen; die Farben
  hängen oft am Stylesheet der Seite und stimmen losgelöst nicht).

## 11. Nicht Teil dieses Plans

Logos für Firmen ohne Website-Stufe (nur Registerdaten), Logos von Personen oder
Profilbilder, Logos in Exporten an CRM-Systeme.
