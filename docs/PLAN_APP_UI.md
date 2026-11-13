# Plan: app.ava.bi auf Augenhöhe mit der Desktop-App (UI & UX) (2026-11-13)

Anlass: Befund von Joyce am 2026-11-13 anhand eines Finanz-Lageberichts in app.ava.bi: Generative UI
erscheint als rohes JSON, acht Werkzeugaufrufe für eine einfache Frage, der Chat wirkt eng und
uneinheitlich, die Firmenansicht ist gegenüber der Desktop-App dürftig. Vorgabe: keine Minimallösung,
sondern eine Oberfläche, die man gern benutzt. Repo der App: `~/Desktop/Repos/ava-app` (Next.js 16,
React 19, Tailwind 4, shadcn radix-nova; Push auf `main` rollt über Vercel aus).

## 0. Ergebnis in einem Absatz

Die App bekommt eine eigene, durchgängige Gestaltungsgrundlage (Abstände, Radien, Schatten, Typografie,
Lade- und Leerzustände), der Chat bekommt den Generative-UI-Baukasten der Desktop-App und eine ruhige
Lesespalte, und die Firmenansicht wird vom Steckbrief zur Arbeitsfläche: Kopf mit Kennzahlen und
Aktionen, Übersicht mit Insolvenz, CRM und Recherche, vollwertige Kontakte, Verflechtungen mit
Netzgrafik, Buying Center mit Power Map und, als Erstes nur in der App, eine Zeitachse je Firma
(Register-Verlauf, Profiländerungen, Meldungen, Notizen). Die Werkzeugkette im Chat wird parallel in
der AVA selbst gekürzt (drei statt acht Aufrufe für Finanzfragen). Umfang etwa 12 Arbeitstage in neun
Stufen; jede Stufe ist für sich auslieferbar.

## 1. Befund (Ist-Stand, 2026-11-13)

### 1.1 Chat

- **Generative UI fehlt.** Die AVA schaltet ```spec für jeden Kanal außer Telegram und Ollama frei
  (`orchestrator.ts:1298`), die App rendert aber nur ```chart, ```buying-center und ```mail-entwurf
  (`src/components/chat/markdown.tsx`). Jede Antwort mit Kennzahlen zeigt deshalb JSON-Zeilen.
- **Keine Prosa-Styles.** `markdown.tsx` nutzt die Klasse `prose-ava`, die nirgends definiert ist. Absätze,
  Listen und Überschriften haben nur die Minimal-Abstände der Komponenten-Overrides.
- **Kanten und Flächen uneinheitlich.** Nutzerblase 18 px rund, Werkzeug-Chips und Argumente 4 px,
  Codeblöcke als graue Flächen mit Scrollbalken, Karten 12 px. Das Chat-CSS ist eine Teilkopie aus der
  Desktop-`styles.css` neben shadcn-Standards.
- **Werkzeugkette zu lang.** Beispiel „Finanzieller Lagebericht“: company_search, company_get, skill_search,
  tool_search, tool_load, publication_search, tool_load, company_publications. Ursachen in der AVA:
  1. Der Prompt verlangt skill_search „bei JEDER wiederholbaren Aufgabe“, auch ohne einen einzigen Skill
     (`tools/skills.ts:154`).
  2. Der Prompt behauptet, nur 6 Werkzeuge seien dauerhaft da (`prompts.ts:144`); es sind 13. Das Modell
     sucht und lädt deshalb, was es schon hat, und lädt einzeln statt als Bündel.
  3. Für Finanzfragen fehlt die Regel „company_get mit Bereich publikationen (voll) zuerst,
     publication_search nur für Detailfragen danach“; die Lösungskarte `jahresabschluss-lesen` führt
     direkt zur Volltextsuche.
  Ziel: company_search → company_get{publikationen, voll} → bei Bedarf publication_search.

### 1.2 Firmenansicht (App gegen Desktop)

Die App zeigt heute: Kopf (Name, Ort, Register, Badges Insolvenz/gelöscht, Knöpfe „Mit AVA besprechen“
und „Website“), Bereichsleiste als Chips, Übersicht (Profil, Register, Standort mit Karte),
Geschäftsführung, Finanzen, Kontakte (Liste), Referenzen & Partner, Stellen, Expansion, Mein Fokus,
Ruhend-Zustand mit Aktivieren. Datenquellen: `/companies/{id}` plus profile, structured-content,
publications, kunden, contacts, website (`src/app/(app)/firmen/[id]/page.tsx`).

| Bereich | Desktop (`routes/CompanyDetail.tsx`) | App heute | Lücke |
|---|---|---|---|
| Kopf | Land-Badge, Register-/Insolvenz-Badge, Wärmeanzeige, Registerzeile, Schlagwort-Chips, KPI-Kacheln (Standort, Register, Gegründet, Mitarbeiter, Website, Social), Übernehmen/Neu verarbeiten | Name, Ort, Register, 2 Badges, 2 Knöpfe | groß |
| Übersicht | Insolvenz-Abschnitt mit „Jetzt prüfen“, Profil, Kontakt & Standort (Karte, Telefon, Bewertung), gezielte Recherche (3 Knöpfe + Verlauf), CRM-Panel mit Verknüpfen | Profil, Register, Standort | groß |
| Finanzen | CSS-Balken Mitarbeiter, Jahresübersicht, je Jahr Karte mit KPIs und Lagebericht | Kennzahlen-Kacheln mit Delta, Entwicklung (Chart), Bilanzstruktur, Lagebericht, Abschlüsse | **App ist voraus** |
| Geschäftsführung | Karten mit Wohnort/Geburtsdatum, Fallback aus Kontakten | Liste | klein |
| Kontakte | KPI-Kacheln, eingesetzte Systeme, Fakten mit Quelle/Status/Konfidenz, Personensuche und Rang, Personenkarte mit Schnellknöpfen, Beobachten, Varianten, Herkunftsnachweis, Art.-14-Hinweis, informiert, löschen | Liste Name/Titel/Mail/Telefon/LinkedIn (max. 60) | groß |
| Verflechtungen | Netzgrafik (SVG, Tiefe 1–6), Gesellschafter-Tabelle, Beteiligungen, Konzernangaben, „Tiefer verfolgen“ | fehlt | ganz |
| Buying Center | Power Map, Personen-Seitenleiste, Vorschläge, Verlauf, Recherche | nur als Chat-Block | ganz |
| Referenzen & Partner | Gruppen (Kunden, Referenzprojekte, Partner, Technologiepartner, Zertifikate), Beleg, Stammdaten-Treffer, Übernehmen | flache Liste | mittel |
| Stellen, Expansion, Fokus | vergleichbar | vergleichbar | klein |
| Erkenntnisse | Branche, Firmenalter, letzte Finanzen | fehlt | bewusst nicht übernehmen (redundant) |
| Zeitachse | fehlt (Burggraben-Punkt 6 offen) | fehlt | neu, zuerst in der App |

Zwei Fehler im Ladeverhalten: Während die Daten laden, steht auf dem Handy bereits der Leer-Hinweis
„Zu dieser Firma liegen noch keine aufbereiteten Daten vor“, am Laptop eine leere Standort-Karte. Beides
wirkt kaputt, obwohl nur die Antwort fehlt.

Im Gateway vorhanden, in der App noch nicht freigegeben (`src/app/api/gw/[...pfad]/route.ts`):
`insolvency-events`, `crm`, `crm/details`, `crm/links`, `network`, `shareholders` (freigegeben, ungenutzt),
`konzern-angaben`, `register-verlauf`, `profile-changes`, `notizen`, `keywords`, `research`,
`research/verlauf`, `research/stand`, `imports/by-ids` (nur Leads), `buying-center/{id}/verlauf|vorschlaege|
mitglieder/…`, `persons/{id}/herkunft|hinweis|informed`, `relevanz`, `relevanz/signale`,
`alerts/neuheiten`, `register-jobs/insolvenz`.

### 1.3 Firmenliste und Hülle

Liste: Segment Meine/Alle, Suche, Länder-Select, Zeilen mit Name, Ort, Pillen ruhend/Insolvenz/gelöscht.
Keine Sortierung, kein Stand (wann zuletzt aufbereitet), keine Neuigkeiten-Markierung. Hülle: Seitenleiste
ab `md`, Tab-Leiste unten, Safe-Areas und Tastatur-Viewport sind sauber gelöst (behalten).

## 2. Zielbild

### 2.1 Gestaltungsgrundsätze

1. **Eine Sprache für Laptop und Handy.** Gleiche Farben (Aqua `#00c0a7`/`#009f8a`, Slate), gleiche Schrift
   (Plus Jakarta Sans), gleiche Radienstufen wie die Desktop-App: 6 / 8 / 12 / 16 / 20 px. Karten 16 px,
   Chips und Pillen voll rund, Eingaben 12 px, Codeblöcke 12 px. Kein 4-px-Radius mehr.
2. **Luft statt Dichte.** Grundschrift 16 px auf Laptop, 15 px auf dem Handy, Zeilenhöhe 1,6. Abstände aus
   einer Skala (4, 8, 12, 16, 24, 32, 48). Lesespalte für Antworten 720 px, Firmenansicht bis 1.040 px.
3. **Zustände sind gestaltet.** Jede Sektion hat Skelett (beim Laden), Leerzustand (mit nächstem Schritt,
   meist ein Knopf zur AVA) und Fehlerzustand. Kein Leer-Hinweis vor der ersten Antwort.
4. **Die AVA ist überall einen Tipp entfernt.** Jede Sektion der Firmenansicht hat am Kopf „Mit AVA“ mit
   einer vorbelegten Frage („Was sagt der Lagebericht?“, „Wer entscheidet hier?“).
5. **Handy zuerst bei Interaktion.** Details in Sheets von unten (shadcn Sheet), Listen mit großen
   Tippflächen (min. 44 px), Kennzahlen als waagerecht wischbare Kacheln, Netzgrafik und Power Map mit
   Fingerzoom und „Einpassen“.
6. **Hell und Dunkel gleichwertig.** Jede neue Komponente wird in beiden Themen geprüft.

### 2.2 Chat

- **Lesespalte 720 px**, Antworten als Fließtext ohne Blase, Nutzer als Blase rechts (bleibt).
- **Prosa-Styles**: Absätze 12 px Abstand, h3/h4 mit 24/16 px davor, Listen mit 6 px, Tabellen in einer
  Karte mit Zebra-Zeilen und sticky Kopf, Zitate mit Aqua-Balken, Inline-Code auf Mutedfläche 6 px.
- **Generative UI** (Stufe G4 aus `PLAN_GENERATIVE_UI.md`): gleicher Katalog wie Desktop, Komponenten aus
  shadcn (Card, Table, Badge, Button) und dem vorhandenen `visual/chart.tsx`. Aktionen: `oeffnen` auf
  App-Routen abgebildet (`/companies/<id>` → `/firmen/<id>`, Personen → Kontakt-Sheet, sonst weglassen),
  `auftrag` als neue Nutzernachricht, `link` nur https. Beim Streamen Platzhalter-Karte, fehlerhafte Specs
  in einer Fehlergrenze.
- **Werkzeugschritte** als eine ruhige Zeile mit Fortschrittspunkt („Liest Jahresabschlüsse … 3 von 5“),
  aufklappbar; fertige Läufe zu einer Zeile („5 Schritte · 12 s“), nicht mehr als Zeitleiste mit Chips.
- **Verbrauchszeile** bleibt, aber als Tooltip-Ziel in 12 px Muted.
- **Codeblöcke** nur noch für echten Code; alle Zäune der AVA (spec, chart, buying-center, mail-entwurf)
  werden gerendert.

### 2.3 Firmenansicht

Aufbau von oben nach unten, auf dem Handy identisch, nur einspaltig:

1. **Kopf (Hero)**: Name, Land-Badge, Register-/Insolvenz-Badge, Wärmeanzeige (fünf Punkte, wenn Nähe ≥ 2),
   Registerzeile. Darunter Schlagwort-Chips (max. 12). **Aktionsleiste**: „Mit AVA besprechen“ (primär),
   „Übernehmen und verarbeiten“ bzw. „Neu verarbeiten“ (Bestätigung), „Website“, „Im CRM öffnen“ (wenn
   verknüpft), „Teilen“ (Link kopieren).
2. **Kennzahlen-Kacheln** (wischbar): Standort (mit Karte-Link), Register, Gegründet, Mitarbeiter (Jahr),
   Umsatz oder Bilanzsumme (neuester Abschluss), Website, Social-Pillen.
3. **Auf einen Blick**: drei bis fünf Sätze aus dem Profil (vorhanden) plus die jüngste Neuigkeit
   (aus der Zeitachse), als erste Karte.
4. **Bereichsleiste** (sticky, Chips mit Zählern, bleibt): Übersicht · Zeitachse · Finanzen ·
   Geschäftsführung · Kontakte · Verflechtungen · Buying Center · Referenzen & Partner · Stellen ·
   Expansion · Mein Fokus. Bereiche ohne Daten bleiben ausgeblendet, Verflechtungen (DE-Registerfirmen)
   und Zeitachse sind immer da.
5. **Übersicht**: Insolvenz-Abschnitt (Stand, „Jetzt prüfen“), Profil (Markdown, NACE, Gegenstand),
   Register (Rechtsform, Gründung, Kapital), Kontakt & Standort (Karte, Telefon, Bewertung, Quelle),
   **Gezielte Recherche** (drei Knöpfe mit Bestätigung und Verlauf), **CRM-Panel** (Verknüpfungen, Top-Kontakte,
   aktive Deals, Verknüpfen-Dialog als Sheet).
6. **Zeitachse** (neu): Register-Snapshots (`register-verlauf`, Burggraben 1), Profiländerungen
   (`profile-changes`), Insolvenz-Ereignisse, Meldungen zu dieser Firma (`alerts/neuheiten` gefiltert),
   Recherche-Läufe, Notizen (`notizen`, Anlegen direkt in der Zeitachse), Jahresabschlüsse als Marken.
   Filter nach Art, Quelle je Eintrag verlinkt. Das ist Burggraben-Punkt 6 und entsteht zuerst in der App,
   die Desktop-App zieht später nach.
7. **Finanzen**: bleibt (ist der Desktop-App voraus), plus „Mit AVA auswerten“ bleibt.
8. **Geschäftsführung**: Karten mit Wohnort/Geburtsjahr, Fallback aus Kontakten, Link zur Personensuche.
9. **Kontakte**: Kennzahlen (Telefon, Mail, Personen), **eingesetzte Systeme** (Tech-Stack-Fakten),
   Fakten-Gruppen mit Quelle, Status-Pille und Konfidenz, **Personensuche** ab 6 Personen (Rang-Logik aus
   `kontakt-rang.ts` portieren), **Personenkarte** mit Avatar, Rang, Schnellknöpfen (Mail, Anruf, LinkedIn,
   Beobachten), Varianten, Herkunftsnachweis und Art.-14-Hinweis im Sheet. Löschen bleibt der Desktop-App.
10. **Verflechtungen**: Netzgrafik als SVG (Layout aus `VerflechtungenTab.tsx` portieren, Touch-Zoom und
    Einpassen ergänzen), Tiefe 1–6, Legende, Gesellschafter-Tabelle, Beteiligungen, Konzernangaben mit
    Tochtergesellschaften (Übernehmen-Knopf), „Tiefer verfolgen“ mit Bestätigung.
11. **Buying Center**: Power Map (Layout aus `kraft-layout.ts` ist in der App bereits vorhanden, Grafik
    aus `BuyingCenterKarte.tsx` portieren), Personen-Sheet mit Einordnung, Belegkette, Vorschlägen
    (Übernehmen/Verwerfen), Interaktionen, Verlauf und „Recherche starten“. Positionen speichert nur der
    Eigentümer.
12. **Referenzen & Partner**: fünf Gruppen, Beleg mit Zitat, Stammdaten-Treffer mit Pille sicher/unsicher,
    Übernehmen-Knopf.
13. **Stellen, Expansion, Mein Fokus**: wie heute, mit Skeletten, „Alle anzeigen“ und „Jetzt prüfen“.

Relevanzsignale (`firma.ansicht`, `person.gesucht`, `person.mail`, `person.profil`, `firma.import`)
sendet die App über `POST /v1/relevanz/signale`, damit Wärme und „Thema bei Kollegen“ auch aus der App
gespeist werden.

### 2.4 Firmenliste

Zeilen mit Name, Ort · Land, Register, Pillen (ruhend, Insolvenz, gelöscht, **neu** bei Meldung in 7 Tagen),
rechts Mitarbeiter und Stand. Sortierung (Name, zuletzt aufbereitet, Neuigkeiten), Filter Land und Status.
Auf dem Handy Wischen nach links: „Mit AVA besprechen“.

## 3. Technik

- **Tokens** in `globals.css`: `--radius` auf 1rem (Karten 16 px), abgeleitete Stufen auf 6/8/12/16/20 px
  festnageln statt Faktoren; `--shadow-soft`, `--shadow-soft-lg`, `--shadow-button` wie Desktop; Typo-Skala.
- **Prosa**: `.prose-ava` definieren (keine Tailwind-Typography-Abhängigkeit nötig).
- **GenUI**: `@json-render/core` und `@json-render/react` 0.22.0 (wie Desktop; React 19 ist unterstützt),
  Katalog mit `zod/v4` aus zod 3.25 (nie zod 4 installieren), Beschreibungen aus
  `services/desktop/src/shared/gen-ui/bausteine.ts` einmalig kopieren (Kommentar mit Quelle und Stand).
- **Proxy-Freigabe** erweitern (siehe 1.2); Schreibpfade nur, wo die App sie wirklich auslöst (PUT/POST mit
  Bestätigung): imports/by-ids, companies/{id}/research, register-jobs/insolvenz, crm/links, notizen,
  buying-center/{id}/(mitglieder|automatik|verlauf|recherche|auswertung|positionen), persons/{id}/informed,
  relevanz/signale, verflechtungen/kontexte.
- **Lade-Logik**: je Sektion eigener Query-Zustand; der Leer-Hinweis erscheint erst, wenn alle
  Kernabfragen (basis, profile, structured-content) beantwortet sind.
- **Grafiken**: Netzgrafik und Power Map als SVG mit `viewBox`, Pinch-Zoom über Pointer-Events,
  „Einpassen“ als Standard auf dem Handy.
- **Portierungen** aus der Desktop-App (nur Logik, keine Electron-APIs): `kontakt-rang.ts`,
  `kontakt-suche.ts`, `kontakt-quellen.ts`, Layout aus `VerflechtungenTab.tsx` (Z. 31–104),
  `RegisterStatusBadge.tsx` (Kennungen je Land), `firma-uebernehmen.tsx` (Zustände).
- **Werkzeugkette** (in `ava-services`): Prompt-Zeile „6 Tools“ auf die echte Kernliste; skill_search nur
  im Kern, wenn der Skill-Store nicht leer ist; Regel für Finanzfragen im Fan-out-Block; Lösungskarte
  `jahresabschluss-lesen` entsprechend; Bündel „Jahresabschluss“ in `tool_search` (publication_search,
  company_publications). Messgröße: Lagebericht-Frage in ≤ 3 Aufrufen.

## 4. Stufen (jede für sich auslieferbar)

| Stufe | Inhalt | Aufwand |
|---|---|---|
| **A** | Werkzeugkette kürzen (ava-services, Desktop-Release) | 0,5 Tag |
| **U0** | Gestaltungsgrundlage: Tokens, Radien, Schatten, Typo, Prosa, Skelett-/Leer-/Fehlerbausteine, Ladefehler der Firmenansicht | 1 Tag |
| **U1** | Chat: GenUI-Baukasten, Lesespalte, Werkzeugschritte neu, Verbrauchszeile | 1,5 Tage |
| **U2** | Firmen-Kopf: Badges, Wärme, Kacheln, Aktionsleiste mit Übernehmen/Neu verarbeiten, Auf einen Blick | 1 Tag |
| **U3** | Übersicht: Insolvenz, Kontakt & Standort voll, gezielte Recherche, CRM-Panel mit Verknüpfen | 1,5 Tage |
| **U4** | Kontakte: Kennzahlen, Systeme, Fakten, Suche, Personenkarte und Sheet | 1,5 Tage |
| **U5** | Zeitachse je Firma (neu) inkl. Notizen und Meldungen; Burggraben 6 | 1,5 Tage |
| **U6** | Verflechtungen: Netzgrafik, Gesellschafter, Konzern, Tiefer verfolgen | 1,5 Tage |
| **U7** | Buying Center: Power Map, Personen-Sheet, Vorschläge, Verlauf, Recherche | 1,5 Tage |
| **U8** | Referenzen in Gruppen, Firmenliste mit Sortierung/Filter/Neu-Pille, Geschäftsführung | 1 Tag |

Reihenfolge-Vorschlag: A und U0 zuerst (sichtbar in einem Tag), dann U1 und U2 (das sind die beiden
Befunde), dann U3–U5, zuletzt U6–U8. Jede Stufe endet mit Prüfung in Hell/Dunkel, Laptop (1280) und
Handy (375) im Browser-Pane, `pnpm lint`, `pnpm build`, Commit auf `main` ohne Push; Push nach Freigabe
(Vercel rollt sofort aus).

## 5. Entscheidungen (Empfehlung zuerst)

1. **Zeitachse zuerst in der App bauen** (E1 ja): Die App ist die kleinere Codebasis, das Gateway hat die
   Daten, und der Burggraben-Punkt 6 bekommt so eine erste Oberfläche. Alternative: zuerst Desktop.
2. **Kontakte: Löschen und Zusammenführen bleiben der Desktop-App** (E2 ja): Schreibaktionen mit
   Datenschutzfolgen nicht auf dem Handy, bis Bestätigungen dort sauber sind. Art.-14-Hinweis und
   „informiert“ dürfen in die App.
3. **Finanzen der App später in die Desktop-App zurückportieren** (E3 später): nicht Teil dieses Plans,
   aber vermerkt.
4. **GenUI-Katalog einmal kopieren statt Paket bauen** (E4 ja): ein gemeinsames Paket wäre sauberer, kostet
   aber Build-Verkettung zwischen zwei Repos; Stand-Kommentar und Drift-Prüfung per Skript reichen.
5. **Erkenntnisse-Reiter nicht übernehmen** (E5 ja): redundant zu Übersicht und Finanzen.
6. **Radius 16 px für Karten** (E6 ja): wirkt auf dem Handy nativ; Desktop-App bleibt bei 12 px, bis sie
   nachzieht.

## 6. Risiken

- **Zwei Oberflächen laufen auseinander.** Gegenmittel: portierte Logik mit Quell-Kommentar und Stand,
  Drift-Skript für den GenUI-Katalog, Plan-Verweis in beiden Repos.
- **Allowlist wächst.** Jeder neue Schreibpfad wird einzeln freigegeben, nie als Präfix.
- **Netzgrafik und Power Map auf kleinen Bildschirmen.** Einpassen als Standard, Sheet statt Hover.
- **Vercel rollt bei Push sofort aus.** Commits bleiben lokal, bis Joyce freigibt; keine halbfertigen Stufen
  auf `main` pushen.

## 7. Stand

- **2026-11-13:** Befund und Plan geschrieben, Bestandsaufnahme Desktop und App abgeschlossen. Nichts gebaut.
- **2026-11-13, Abnahme:** Joyce nimmt den Plan mit E1–E6 wie empfohlen ab. Stufe A gebaut (Commit vom selben Tag: Prompt-Kernliste, Finanz-Regel, skill_search nur mit Skills, Bündel „Jahresabschluss“), Desktop-Release steht noch aus. U0 läuft als eigene Session in `ava-app`.
