# Plan: Eingesetzte Systeme aus der Datenschutzerklaerung

Stand: 2026-09-01 · Status: T1-T5 UMGESETZT (v0.1.509/510)

## 1. Idee und Nutzen

Die DSGVO zwingt Firmen, in der Datenschutzerklaerung ihre
Auftragsverarbeiter zu benennen — also genau die Systeme, die sie
wirklich einsetzen: CRM, Marketing-Automation, Support-Tools,
Analytics, Hosting. Auf der Startseite steht so etwas nie.

Zwei konkrete Anwendungsfaelle (User, 2026-09-01):

- **Eigener Vertrieb:** "Welche meiner Firmen nutzen HubSpot?"
- **Gespraechsvorbereitung fuer Kunden wie Strategic IT** (Microsoft-
  CRM-Spezialisten): vor dem Termin wissen, ob der Interessent
  Dynamics, Salesforce oder gar nichts einsetzt.
- **Firmen-Radar:** als Merkmal ins ICP-Matching, damit "Firmen mit
  Microsoft-Stack" ueberhaupt als Zielprofil formulierbar wird.

## 2. Harte Eingrenzung (User-Vorgabe)

Ausschliesslich Datenschutz-Seiten auswerten:
`/datenschutz`, `/datenschutzerklaerung`, `/privacy`,
`/privacy-policy`, jeweils auch unter `/en/…`, `/de/…`.
KEINE Auswertung von Startseite, Impressum, Produktseiten — dort
stehen keine Auftragsverarbeiter, und alles andere waere Raten.

## 3. Erkennung: Woerterbuch zuerst, LLM nur als Ergaenzung

Entscheidung: **deterministisch vor LLM.** Datenschutzerklaerungen
nennen Anbieter woertlich ("HubSpot Inc.", "Salesforce.com",
"Microsoft Dynamics 365"). Ein gepflegtes Woerterbuch mit Kategorien
ist deshalb praeziser, kostenlos, nachvollziehbar und kann nicht
halluzinieren.

Kategorien: CRM, Marketing-Automation, Analytics, Support/Ticketing,
E-Commerce, Hosting/Cloud, Kommunikation, HR/Recruiting, Zahlung,
Consent/Cookie.

Optionale zweite Stufe (LLM) fuer unbekannte Anbieter — mit einer
harten Auflage: **jeder vom Modell vorgeschlagene Anbieter muss
woertlich im Seitentext vorkommen**, sonst wird er verworfen. Damit
ist die Stufe halluzinationsfest (Konvention aus
docs/ZUVERLAESSIGKEIT.md).

## 4. Wo es laeuft — zwei Pipelines

Der Nutzen faellt an zwei Stellen an, und die haben getrennte Wege:

| Ort | Pipeline | Ablage |
|---|---|---|
| Verarbeitete Firmen | company-contact-Producer | Gateway-Persist (Fact) |
| Radar-Kandidaten | lokaler ProfileWorker (`discovery/profiler.ts`) | lokale PGlite |

Gemeinsamer Kern: EIN Extraktor-Modul (Woerterbuch + Seitenfinder),
von beiden genutzt — kein Zwilling, der auseinanderlaeuft.

### Konflikt, der aufgeloest werden muss

`/datenschutz` steht seit v0.1.496 auf der HARTEN Skip-Liste des
Kontakt-Crawlers (dort korrekt: fuer Kontakte ist die Seite Ballast).
Der neue Schritt umgeht die Liste bewusst und holt die Seite GEZIELT
— nicht durch Aufweichen der Skip-Regel, sonst kostet es wieder
LLM-Budget im Kontakt-Pfad.

## 5. Phasen

- **T1** Extraktor-Modul: Seitenfinder (Sitemap + Standardpfade),
  Woerterbuch mit Kategorien, deterministische Erkennung, Belegstelle
  (Textausschnitt + URL) je Treffer.
- **T2** company-contact: gezielter Datenschutz-Schritt nach dem
  Crawl; Persist als Firmen-Fakten (`techVendor`, Wert = Anbieter,
  Kategorie im Feld). Belegseite wandert wie gehabt in
  `Observation.evidenceUrl` — damit greift der Quellen-Link aus
  v0.1.508 automatisch.
- **T3** UI: Block "Eingesetzte Systeme" auf der Firmenseite,
  gruppiert nach Kategorie, mit Quellen-Link.
- **T4** Radar: Datenschutz-Seite des Kandidaten mit auswerten,
  Ergebnis in `MiniProfile` + `profileText` → wirkt sofort auf
  Embedding-Score UND LLM-Urteil im ICP-Matching.
- **T5** Chat-Tool: "Welche Firmen nutzen HubSpot?" (Filter ueber die
  neuen Fakten) — Self-Service-Regel.

## 6. Grenzen, die in der UI stehen muessen

- Eine Nennung belegt **eine Beziehung, keinen aktiven Betrieb**:
  Datenschutzerklaerungen sind oft veraltet oder aus Generatoren.
- Generator-Boilerplate nennt haeufig Dienste, die gar nicht laufen.
  Gegenmittel: Kategorie-Gewichtung — CRM/Marketing sind das Signal,
  Consent-/Font-Dienste eher Rauschen.
- Manche Seiten sind nur per JavaScript erreichbar; dann gibt es
  schlicht kein Ergebnis (kein Raten, keine Ersatzquelle).
- Rechtlich unkritisch: veroeffentlichte Firmenangaben, keine
  Personendaten.

STATUS: T1-T5 umgesetzt (v0.1.509 + v0.1.510).

Nachtrag zur Erkennung (User-Einwand 2026-09-01): ein festes
Woerterbuch ist grundsaetzlich unvollstaendig — quikk.de nennt
"Website-Hosting: Vercel Inc." woertlich, das Woerterbuch kannte es
nicht, und die Hosting-Info ist genauso interessant wie das CRM.
Konsequenz: Woerterbuch auf 73 Anbieter erweitert (Schwerpunkt
Hosting/PaaS) UND die offene LLM-Stufe aus §3 von "optional" auf
"fest eingebaut" hochgestuft — mit der Halluzinationssperre
(woertlicher Textabgleich) als Bedingung.

T4 loest den Radar OHNE Woerterbuch-Zwilling: der Profiler haengt die
Datenschutzseite an den ohnehin gecrawlten Text und laesst das Modell
im selben Aufruf ein Feld `systeme` fuellen. Das landet im
profileText und wirkt damit auf Embedding UND LLM-Urteil.
