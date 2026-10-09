# Plan: Firmen-Radar für Österreich und UK

Stand 2026-10-09. Auftrag des Operators: Der Radar soll für alle Länder
funktionieren, die AVA abdeckt (heute DE, AT, UK; CH on hold). Grundlage:
docs/PLAN_FIRMEN_DISCOVERY.md (Architektur A1–A10), docs/PLAN_OESTERREICH.md,
docs/PLAN_UK.md.

## 1. Ist-Zustand: sechs Kopplungen an Deutschland

| Nr. | Stelle | Was heute nur für DE geht |
|---|---|---|
| 1 | Gateway `lib/geo-places.ts`, `scripts/build-geo-dataset.mjs`, `routes/v1/geo.ts` | Ortsgraph `GeoPlace` aus GeoNames `DE.zip` (~15k PLZ-Zeilen, Spalten `bundesland`, `kreis`, `agsKreis`). Ein Ort aus AT oder UK wird nicht aufgelöst, der Scan bricht mit „Ort unbekannt“ ab. |
| 2 | Gateway `routes/v1/proxy.ts` (valueserp) | Places-Suche fest mit `google.de`, `gl=de`, `hl=de`, `location=Germany` aus der Umgebung. Der Aufrufer kann `gl`, `hl`, `location` zwar überschreiben (ALLOWED_PARAMS), der Radar tut es nicht; `google_domain` ist nicht überschreibbar. |
| 3 | Gateway `lib/discovery.ts` `findRegisterCandidates` | Register-Kanal liest `GermanCompany` über `location = ANY(Ortsnamen)` und den Gerichtsbezirks-Rückfall (A6), ohne `country`. AT-Firmen tauchen zufällig auf, wenn ein Ortsname gleich heißt; UK-Firmen praktisch nie (PostTown „London“ steht nicht im DE-Ortsgraph). |
| 4 | Gateway `DiscoveredCompany` | Spalten `city`, `plz`, `lat`, `lon`, kein `country`. Kandidaten aus verschiedenen Ländern sind nicht trennbar; die Radar-Tabelle filtert nur über die Bounding-Box. |
| 5 | Desktop `discovery/scan.ts`, `icp-assistant.ts`, `IcpAssistant.tsx` | ICP hat `orte: string[]` ohne Land; SERP-Planner und Fallback bauen deutsche Suchanfragen („Branche Ort“); `parseAddress` erwartet „PLZ Ort“ (fünfstellig). OSM-Overpass ist bereits länderneutral (Bounding-Box). |
| 6 | Desktop Import und Abgleich | Übernehmen läuft über `/v1/imports/from-list` mit `{name, city}` und data-care, dessen Fuzzy-Suche ohne Land auf `country: "DE"` zurückfällt (`german-companies-repository.ts` fuzzySearch). Register-Kandidaten mit `masterCompanyId` wären direkt importierbar, SERP/OSM-Funde aus AT/UK würden gegen DE abgeglichen und scheitern. |

Mini-Profil, Embedding, ICP-Match und Alerts sind länderneutral (A2, A5);
Profil und Match-Begründung werden deutsch formuliert, auch für englische
Websites. Das bleibt so (Nutzer sind deutschsprachig).

## 2. Datengrundlage in master-data (Lesung 2026-10-09)

| Land | Firmen | mit `location` | mit `zipCode` | Form von `location` |
|---|---|---|---|---|
| DE | 1.838.308 | alle | keine | Sitzort (Freitext aus dem Register) |
| AT | 346.994 | alle | keine | `domicile` (Sitzgemeinde) |
| UK | 5.693.001 | alle | 5.601.790 | `PostTown` (z. B. London, 86k mit WC2H 9JQ = Registered-Office-Agenten); Fallback County („England and Wales“ 55k) |

Folgen: AT lässt sich wie DE über den Ortsnamen zuordnen. UK braucht die
Postleitzahl: `PostTown` ist zu grob (Greater London allein ~1 Mio. Firmen),
und viele Firmen sitzen formal bei Registered-Office-Diensten (Scheinsitz).
Der Register-Kanal ist in UK deshalb nur mit Outward-Code-Filter und
Abzug der Agenten-Adressen brauchbar; der Places-/OSM-Kanal findet dort die
operativ tätigen Firmen besser.

## 3. Entscheidungen (Vorschlag)

- **L1 Land ist Teil des Suchgebiets, nicht des ICP.** Ein ICP gilt weiter
  pro Nutzer; jeder Eintrag in `orte` wird zu `{ort, land}` (Standard DE,
  Altbestand bleibt DE). Der Radar startet je Suchgebiet einen Scan mit
  dem Land des Gebiets. Keine „Alle Länder“-Suche: Die Quota zählt Gebiete.
- **L2 Ein Ortsgraph, drei Länder.** `GeoPlace` bekommt `country` (Teil des
  Schlüssels) und wird aus GeoNames `DE.zip`, `AT.zip` (~2,2k Zeilen) und
  `GB.zip` (Outward-Codes, ~27k Zeilen; nicht `GB_full`, 1,7 Mio.) gebaut.
  Für UK heißt `plz` der Outward-Code („WC2H“), `kreis` der Bezirk
  (admin2), `bundesland` die Landesteile England/Scotland/Wales/Northern
  Ireland. `agsKreis` bleibt DE-spezifisch (leer sonst). Ortsnamen werden
  je Land aufgelöst; `near` wird mehrdeutig bei gleichen Namen (Neustadt
  gibt es in AT und DE), daher immer mit `country`.
- **L3 Register-Kanal je Land.** DE wie heute. AT über `location` in der
  Ortsmenge und `country = 'AT'` (kein Gerichtsbezirks-Rückfall, dort sind
  es nur 16 Gerichte). UK über den Outward-Code der Postleitzahl in der
  Code-Menge des Radius: `zipCode LIKE ANY('WC2H %', …)` auf `country =
  'UK'`, hart gedeckelt per `statement_timeout`; kein neuer Ausdrucksindex
  auf `GermanCompany` (Memory „kein großer Indexaufbau“), alternativ eine
  kleine Hilfstabelle im Gateway (§6). Registered-Office-Agenten: Adressen
  mit mehr als 500 Firmen je `(location, zipCode)` werden ausgeschlossen
  (Liste beim Deploy aus der Lesung in §2 gebildet, Schwelle einstellbar).
- **L4 SERP je Land.** Der Radar schickt `google_domain`, `gl`, `hl` und
  `location` mit: AT = google.at / at / de / „Austria“, UK = google.co.uk /
  uk / en / „United Kingdom“. Der Proxy nimmt `google_domain` in die
  erlaubten Parameter auf (Allowlist der drei Domains). Planner-Prompt
  bekommt das Land und schreibt die Suchanfragen in der Landessprache
  (UK englisch). `parseAddress` lernt AT (vierstellige PLZ) und UK
  (Postcode-Muster, Ort vor der PLZ).
- **L5 Kandidaten mit Land.** `DiscoveredCompany.country` (Default DE,
  lazy `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, Freigabe vor Deploy),
  Discovery-ID bleibt die Domain (A8; `.at`/`.co.uk` kollidieren nicht
  mit `.de`). Radar-Tabelle und Chat-Tools zeigen das Land als Chip wie in
  den Firmendetails; Filter nach Land in der Liste.
- **L6 Übernehmen je Land.** Register-Kandidaten tragen `masterCompanyId`
  und werden ohne Abgleich importiert. SERP/OSM-Funde gehen an
  `/v1/imports/from-list` mit `country`; das Gateway reicht es an data-care
  durch. Dort kennt nur `fuzzySearch` ein Land; der Name-Ort-Abgleich des
  Excel-Befehls (`fuzzySearchCompanyNameAndLocation`) filtert heute nicht
  nach Land und bekommt den Parameter (Elastic `match` auf `country`, siehe
  Memory „Suchindex-Mapping“). UK-Funde
  ohne Registertreffer bleiben Kandidaten mit Hinweis „nicht im Register
  gefunden“ (Companies-House-Namen weichen oft vom Markennamen ab).
- **L7 Quota unverändert.** Gebiete, Läufe und Kandidaten je Plan gelten
  länderübergreifend (docs/WEBSITE_INFO_RADAR_PLAENE.md bleibt gültig, nur
  „in deiner Region“ wird zu „in deiner Region in Deutschland, Österreich
  oder UK“).

## 4. Umsetzung

| Schritt | Inhalt | Dateien | Aufwand |
|---|---|---|---|
| R-L0 | Ortsgraph: Generator für drei Länder, `country` im Seed und in `GeoPlace` (Neuseed bei Zeilenzahl-Abweichung greift automatisch), `GET /v1/geo/places?near=&country=`; Tests mit Wien, Graz, Manchester, „Neustadt“ in DE und AT | gateway `scripts/build-geo-dataset.mjs`, `src/data/geo-places.json`, `lib/geo-places.ts`, `routes/v1/geo.ts` | 1 Tag |
| R-L1 | Register-Kanal je Land (L3) inkl. Agenten-Ausschluss und Zeitgrenze; `country` in `DiscoveredCompany`, `startScan`/`addCandidates`/`listCandidates` mit Land | gateway `lib/discovery.ts`, `routes/v1/discovery.ts` | 1,5 Tage |
| R-L2 | Proxy: `google_domain` erlaubt (Allowlist), Länderprofile als Konstante; Import `from-list` mit `country`; data-care Excel-Befehl mit Land | gateway `routes/v1/proxy.ts`, `routes/v1/imports.ts`; master-data `upload-companies-excel-command*.ts`, `data-care-controller.ts` | 0,5 Tage |
| R-L3 | Desktop Scan: `ScanArgs.land`, Länderprofil (SERP-Parameter, Sprache des Planners, `parseAddress`), Register-Kandidaten mit Land, OSM unverändert; Supervisor plant je Suchgebiet mit Land | desktop `discovery/scan.ts`, `radar-supervisor.ts`, `profile-worker.ts` | 1 Tag |
| R-L4 | ICP: `orte` → `{ort, land}` mit Migration des Altbestands; ICP-Assistent erkennt das Land aus der eigenen Website-Adresse (Impressum: „A-1010 Wien“, UK-Postcode); Formular mit Landauswahl je Gebiet; Chat-Tools `icp_*` und `radar_*` mit Land | desktop `agent/icp-store.ts`, `discovery/icp-assistant.ts`, `renderer/routes/IcpAssistant.tsx`, `agent/tools/discovery*.ts` | 1 Tag |
| R-L5 | Radar-Tabelle: Landeschip, Filter, Übernehmen mit Land; Alerts nennen das Land; Fähigkeitsgruppen und Vorschläge-Texte | desktop `renderer/routes/DiscoveryRadar.tsx`, `discovery/radar-alerts.ts` | 0,5 Tage |
| R-L6 | Live-Test: je Land ein Erst-Scan (Wien Maschinenbau, Manchester Software), Ausbeute je Kanal im Log, Agenten-Schwelle prüfen; Website-Text anpassen | — | 0,5 Tage |

Gesamt etwa 6 Tage, zwei Releases (R-L0–R-L2 Gateway zuerst, dann App).
Schemaänderungen (ALTER TABLE `GeoPlace`, `DiscoveredCompany`) brauchen
Freigabe vor dem Deploy.

## 5. Risiken

- **UK-Register ist riesig und scheinsitz-lastig.** 5,7 Mio. Zeilen,
  London allein mit sieben Agenten-Adressen über 300k Firmen. Ohne
  Outward-Code-Filter und Agenten-Ausschluss liefert der Register-Kanal
  Briefkästen. Deshalb Kanalgewichtung in UK: Places und OSM zuerst,
  Register nur als Auffüllung.
- **Kein neuer großer Index auf dem Cluster.** Der UK-Postleitzahlfilter
  muss mit vorhandenen Indizes (`country`) und Zeitgrenze auskommen oder
  eine kleine Hilfstabelle im Gateway nutzen. Ein Ausdrucksindex auf
  `GermanCompany` ist nach den Abstürzen vom 2026-10-07 ausgeschlossen.
- **Mehrdeutige Orte über Ländergrenzen.** Immer mit Land auflösen; der
  Assistent darf das Land raten, der Nutzer bestätigt es im Formular.
- **SERP-Kosten.** Gleiches Budget je Scan, aber mehr Gebiete pro Nutzer
  möglich; die Plan-Deckel bleiben die Bremse.
- **Sprache.** Planner-Queries auf Englisch für UK, Profil weiter deutsch;
  Matcher-Prompt bekommt den Hinweis, dass Website-Inhalte englisch sein
  können.

## 6. Offene Entscheidungen

1. UK-Register-Kanal: `LIKE ANY` mit Zeitgrenze (kein Schema, langsamer)
   oder Hilfstabelle `UkOutward` im Gateway (einmalige Füllung ~5,7 Mio.
   Zeilen, dann schnell)? Vorschlag: zuerst `LIKE ANY` mit 8 s, Hilfstabelle
   nur bei Bedarf.
2. Schwelle für Registered-Office-Agenten (Vorschlag 500 Firmen je
   Adresse) und ob diese Firmen auch außerhalb des Radars als „Scheinsitz“
   markiert werden sollen.
3. Soll der ICP-Assistent für ein Suchgebiet im Ausland automatisch den
   Radius anpassen (UK-Ballungsräume dichter)? Vorschlag: nein, gleiche
   Regeln.
4. Schweiz bleibt außen vor, bis Firmen in master-data liegen (CH on hold).

## 7. Stand (2026-10-09, v0.1.781; Gateway und master-data deployt)

Umgesetzt R-L0 bis R-L5 mit den Vorschlaegen aus §6 (UK per `LIKE ANY`
mit 8 s Zeitgrenze, Agenten-Schwelle 500 je Adresse, gleiche Radius-Regeln).

- **R-L0 Ortsgraph:** `scripts/build-geo-dataset.mjs` laedt DE, AT und GB
  (Outward-Codes) und schreibt `[country, name, plz, bundesland, kreis,
  agsKreis, lat, lon]`; 61.725 Zeilen (DE 15.050, AT 19.225, UK 27.450).
  `GeoPlace` bekommt `country` (lazy ALTER, Neuseed ueber die Zeilenzahl),
  `GET /v1/geo/places?country=` loest je Land auf und liefert `country`.
- **R-L1 Gateway:** `DiscoveryScan.country`, `DiscoveredCompany.country`
  (lazy ALTER, Standard DE); Gebiete-Gate zaehlt Ort+Land; Kandidaten
  erben das Land des Scans; `listCandidates` filtert optional nach Land;
  `findRegisterCandidates` je Land (AT ueber Sitzort, UK ueber Outward-Codes
  des Radius, Agenten-Adressen ab 500 Firmen ausgeschlossen, DE-Gerichts-
  Rueckfall nur fuer DE).
- **R-L2 Proxy/Import:** `google_domain` nur aus der Allowlist google.de/
  .at/.co.uk/.com; `/v1/imports/from-list` mit `country` → data-care
  `country` → master-data exakter Abgleich (`country`) und Elastic-Fuzzy
  (`filter: match country`), Standard DE.
- **R-L3 Desktop-Scan:** `discovery/land.ts` (Profile je Land: Domain, gl,
  hl, location, Sprache; `ortMitLand`, `parseAdresse` fuer DE/AT/UK-PLZ);
  Scan, Planner (englische Anfragen fuer UK), Places-, Register-Kanal und
  Website-Lookup je Land.
- **R-L4 ICP:** Land am Ort per Kuerzel („Wien (AT)", „Manchester (UK)");
  Supervisor rotiert ueber die Gebiete je Lauf; Chat-Werkzeuge `icp_set`
  (Hinweis) und Radar-Scan (`land` oder Kuerzel); Formular-Platzhalter.
- **R-L5 Radar-Tabelle:** Landeschip neben dem Ort fuer AT/UK; Import je
  Land in eigener Transaktion mit `country`.
- **Deploys 2026-10-09:** Gateway (Spalten und GeoPlace-Neuseed entstehen
  beim ersten Geo-Aufruf) und master-data (Abgleich mit Land).
- **Offen:** R-L6 Live-Test je Land (Wien, Manchester), Website-Text
  (`docs/WEBSITE_INFO_RADAR_PLAENE.md` nennt nur „deine Region"),
  Alert-Texte mit Land, Filter nach Land in der Tabelle.
