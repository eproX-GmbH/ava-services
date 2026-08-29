# Plan: ICP-Assistent („Zeig mir dich und deine 5 besten Kunden")

Stand: 2026-08-29 · Status: RATIFIZIERT (P1 → ja, wird I5; P2 → Chat-Card)

## 1. Ziel & Kernidee

ICP-Definition ohne Fragebogen-Folter: Der Nutzer nennt **seine eigene
Website-URL** und **bis zu 5 URLs seiner besten Bestandskunden**. AVA
liest daraus alles selbst:

- **Eigene Website** → was ist das Angebot (Leistungen, Nutzenversprechen,
  Branche) + **Firmen-Standort des Nutzers** (Impressum!) → Radar-Ort.
- **Kunden-Websites** → was die besten Kunden ausmacht (Branchen,
  Größen-Indizien, **Standorte** → Radar-Radius-Vorschlag aus den realen
  Kunden-Distanzen).
- **Synthese** → vollständiger ICP-Entwurf, den der Nutzer nur noch
  reviewt und bestätigt.

Der Assistent wird **nach dem ersten erfolgreichen Login vorgeschlagen**
(solange kein ICP existiert), ist aber jederzeit abrufbar und immer
wegklickbar. **Fallback:** komplette Handeingabe über den Fragenkatalog
als Formular — derselbe Review-Screen, nur ohne Vorbefüllung.

## 2. Fragenkatalog (kanonisch)

Der Katalog ist die gemeinsame Struktur für (a) die LLM-Synthese,
(b) das Review-/Handeingabe-Formular und (c) den `IcpProfile`-Store.

| # | Frage | Feld | Quelle bei URL-Analyse |
|---|---|---|---|
| K1 | Was bietest du an? (Produkte/Leistungen) | `angebot` | eigene Website |
| K2 | Welches Problem löst du / welchen Nutzen stiftest du? | `nutzen` | eigene Website |
| K3 | Wo sitzt dein Unternehmen? | `orte[0]` | Impressum eigene Website |
| K4 | In welchen Branchen sind deine idealen Kunden? | `branchen[]` | Muster über Kunden-Websites |
| K5 | Wie groß sind ideale Kunden (Mitarbeiter/Umsatz-Band)? | `groesse` | Größen-Indizien der Kunden-Websites |
| K6 | In welcher Region / welchem Radius suchst du? | `orte[]` + `radiusKm` | Kunden-Standorte → Distanz-Vorschlag |
| K7 | Was macht einen perfekten Kunden sonst aus? (Merkmale) | `merkmale[]` | Gemeinsamkeiten der Kundenprofile |
| K8 | Wer passt explizit NICHT? (Ausschlüsse) | `ausschluesse` | nur manuell (LLM schlägt nichts vor — keine Vermutungen) |
| K9 | Deine besten Bestandskunden (URLs, optional) | `kundenBeispiele[]` | die eingegebenen URLs selbst |
| — | Freitext-Zusammenfassung (fürs Matching/Embedding) | `beschreibung` | Synthese aus K1–K7 |

`IcpProfile`-Erweiterung (rückwärtskompatibel, `normalise()` füllt
Defaults): `angebot`, `nutzen`, `merkmale[]` (max 10),
`kundenBeispiele[]` (max 5 × {domain, name?, ort?}), `quelle:
"assistent" | "manuell" | "chat"`. `renderText()` nimmt die neuen
Felder mit auf → besseres Match-Embedding ohne weitere Änderung am
Matcher.

## 3. Architektur-Entscheidungen (Vorschlag)

- **B1 — Alles lokal, nichts zentral.** Die Kundenliste des Nutzers ist
  hochsensibel (wessen Kunden man sind = Geschäftsgeheimnis). Kunden-URLs,
  gecrawlte Texte und abgeleitete Kundenprofile bleiben ausschließlich
  auf der Nutzer-Maschine (Teil von `icp.json`). Sie werden
  **ausdrücklich NICHT** als DiscoveredCompany in den geteilten
  Radar-Bestand geschrieben — Bestandskunden sind keine Radar-Kandidaten.
- **B2 — Wiederverwendung statt Neubau.** Crawl = `discovery/profiler.ts`
  (`crawlSite`, robots.txt, Caps) — plus Impressum-Priorität für die
  Standort-Extraktion. LLM = `streamToText` + Producer-Modell-Override.
  Geo-Validierung der Orte = `/v1/geo/places` (existiert). Kein
  Gateway-Deploy nötig: **der gesamte Assistent ist Desktop-only.**
- **B3 — Drei LLM-Schritte statt einem Monolithen:**
  1. *Angebots-Analyse* (eigene Website): {angebot, nutzen, branche,
     standort, leistungen} — yup-validiert.
  2. *Kunden-Analyse* (je Kunden-URL, parallel max 2): {name, branche,
     groessenIndiz, standort, leistungen} — dasselbe Schema-Muster wie
     die Radar-Mini-Profile.
  3. *Synthese*: Angebot + N Kundenprofile → Fragenkatalog-Antworten
     K1–K7 + `beschreibung`. Prompt-Regel: nur belegbare Muster, keine
     Vermutungen, keine Personennamen; K8 bleibt leer.
- **B4 — Radius-Vorschlag aus Daten:** Kunden-Standorte über
  `/v1/geo/places` auflösen, Distanz zum Nutzer-Standort per Haversine;
  Vorschlag = auf 10 km gerundetes Maximum (mind. 30, max 200), mit
  Begründung im Review („dein entferntester Top-Kunde sitzt 74 km
  entfernt"). Nicht auflösbare Orte → Radius-Default 50 + Hinweis.
- **B5 — Vorschlag statt Zwang beim Erst-Login.** Nach Login gilt:
  `!icp.isSet() && !assistentDismissed` → dezentes, nicht-modales
  Banner/Card über dem Chat („In 2 Minuten zum Idealkundenprofil —
  nur deine Website + deine besten Kunden") mit „Starten" / „Später".
  „Später" persistiert (kein Nerv-Faktor), der Einstieg bleibt dauerhaft
  über Firmen → Radar („ICP einrichten") und die Welcome-Message
  erreichbar. KEIN zweiter Hard-Modal nach dem FirstRunWizard —
  der blockiert bereits fürs LLM-Setup, zwei Pflicht-Wizards nacheinander
  wären genau die Fragebogen-Folter, die wir abschaffen wollen.
- **B6 — Review ist Pflicht, Speichern explizit.** Der generierte ICP
  wird NIE stillschweigend gespeichert. Der Review-Screen ist das
  Fragenkatalog-Formular mit Vorbefüllung; erst „ICP übernehmen"
  schreibt in den `IcpStore`. Manuell-Pfad = dasselbe Formular leer.
- **B7 — Auch per Chat nutzbar.** Ein Agent-Tool
  `icp_assist_from_urls(eigeneUrl, kundenUrls[])` fährt dieselbe
  Analyse und präsentiert den Entwurf im Chat (Übernahme via `icp_set`
  nach Nutzer-Bestätigung). Gleicher Code-Pfad wie die UI (ein
  Modul, zwei Frontends).

## 4. Komponenten & Dateien

```
Desktop main:
  agent/icp-store.ts            — Felder-Erweiterung + Migration (I1)
  discovery/icp-assistant.ts    — NEU: analyzeOwnSite, analyzeCustomerSite,
                                  synthesizeIcp, suggestRadius; ein
                                  Orchestrator runIcpAnalysis(urls) mit
                                  Fortschritts-Callback (I2)
  index.ts                      — IPC: icpAssistant:analyze (startet, streamt
                                  Fortschritt via webContents.send),
                                  icpAssistant:dismiss / getState (I2/I4)
  agent/tools/icp.ts            — + icp_assist_from_urls (I4)

Renderer:
  routes/IcpAssistant.tsx       — NEU: Stepper (1 URLs erfassen →
                                  2 Analyse-Fortschritt je Website →
                                  3 Review-Formular = Fragenkatalog →
                                  4 Fertig + CTA „Radar-Automatik an?") (I3)
  components/IcpProposalCard.tsx— NEU: Erst-Login-Vorschlag (B5) (I4)
  routes/DiscoveryRadar.tsx     — „ICP einrichten"-Link auf den Assistenten
  main.tsx / AppShell           — Route /icp-assistent (I3)
```

## 5. Implementierungsphasen

### I1 — Fragenkatalog + Store-Erweiterung + manueller Pfad
- `IcpProfile` um K-Felder erweitern (rückwärtskompatibel), `renderText()`
  erweitern, `icp_set`-Tool-Schema nachziehen.
- `IcpAssistant.tsx` nur mit Schritt 3 (leeres Formular) = Handeingabe-
  Fallback, Route + Radar-Verlinkung.
- **Prüfstein:** ICP manuell über das Formular anlegen → Radar-Match
  nutzt die neuen Felder im Embedding-Text.
- **STATUS: implementiert 2026-08-29** — IcpProfile um K-Felder erweitert
  (angebot, nutzen, merkmale, kundenBeispiele, quelle; Migration
  verifiziert), renderText erweitert (Matcher profitiert ohne Änderung),
  icp_set-Tool nachgezogen (quelle="chat"), IPC discovery:setIcp
  (+Audit), Route /icp-assistent mit Fragenkatalog-Formular K1–K9,
  Radar verlinkt („ICP bearbeiten" + Hinweis-Box).

### I2 — URL-Analyse-Engine
- `discovery/icp-assistant.ts`: Crawl-Wiederverwendung (+ Impressum-
  Priorisierung), drei LLM-Schritte (B3), Radius-Vorschlag (B4),
  Fortschritts-Events („Analysiere kunde3.de … 4/6").
- IPC + Anbindung an den Stepper (Schritte 1+2), Review vorbefüllt.
- **Prüfstein:** quikk.de + 3 echte Kunden-URLs → ICP-Entwurf mit
  korrektem Nutzer-Standort, plausiblen Branchen und Radius-Begründung
  in < 3 Minuten.

### I3 — Wizard-Polish
- Stepper-UX: URLs-Validierung (Domain-Normierung wiederverwenden!),
  einzelne fehlgeschlagene Kunden-Crawls überspringen statt abbrechen
  (transparent gezählt), Abschluss-Screen mit CTA Radar-Automatik.

### I4 — Einstiegspunkte
- Erst-Login-Vorschlag (B5) mit persistiertem „Später".
- Welcome-Message: ICP-Absatz verweist auf den Assistenten („oder gib
  mir einfach deine Website + deine 5 besten Kunden").
- Agent-Tool `icp_assist_from_urls` (B7) + System-Prompt-Zeile.
- **Prüfstein:** Frischer Account → Login → Vorschlag erscheint →
  Assistent → ICP gespeichert → Radar sofort einsatzbereit.

## 6. Aufwand & Risiken

- Kein Gateway-Deploy, keine neuen zentralen Daten → risikoarm, rein
  Desktop-Releases.
- Größtes fachliches Risiko: Synthese-Qualität bei dünnen Websites
  (One-Pager). Gegenmittel: Review-Pflicht (B6) + im Entwurf leere
  Felder sichtbar lassen statt halluzinieren.
- Crawl-Policy identisch zu Phase 2 (robots.txt, keine Bot-Bypässe,
  keine Personendaten).

## 7. Entscheidungen (ratifiziert 2026-08-29)

- **P1 — ENTSCHIEDEN: ja.** Kunden-Beispiele werden als eigenes
  Matching-Signal genutzt („ähnlich zu deinen Top-Kunden"):
  **I5** — Kundenprofile lokal einbetten, Kandidaten-Score bekommt
  eine Ähnlichkeits-Komponente zum nächsten Top-Kunden-Profil.
- **P2 — ENTSCHIEDEN: Chat-Card** (B5 wie vorgeschlagen).
