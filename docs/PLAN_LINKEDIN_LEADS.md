# Plan: Bereich „LinkedIn-Leads“ (2026-10-22)

## Ziel

Wer auf einen beobachteten LinkedIn-Post reagiert oder kommentiert, ist ein
warmer Lead: eine Person mit Anlass. Dieser Bereich führt solche Personen
getrennt vom Firmen-Radar, mit Post, Reaktion, Rolle und Firma, und macht aus
einem Lead in einem Schritt einen Kontakt samt Anlass. Der ICP-Score wird
angezeigt, entscheidet aber nichts.

Anlass: Patricks Sprachnachrichten vom 2026-10-22 (Hennings Post im
Personen-Radar). Kernaussage: „Wer auf einen Post reagiert, muss nicht zum ICP
passen, ist aber trotzdem interessant. Das Firmen-Radar siebt genau diese
Firmen aus.“ Entscheidung des Operators (2026-10-22): eigener Bereich statt
Sonderfälle im Firmen-Radar.

## Ist-Stand (geprüft im Code, Stand v0.1.864)

- **Erfassung** (`services/desktop/src/main/linkedin/personen-radar/`): Quell-Posts
  (bis 25 URLs, 10 je Lauf) → Apify-Actors harvestapi (Reaktionen, Kommentare,
  Profil, Unternehmensseite) → `Engager { profileUrl, name, headline,
  activityType, reactionType, commentText, postUrl }` → Kaskade Person→Firma
  (Positionen → Unternehmensseite → Website hart; Headline → SERP mittel;
  sonst „ungeklärt“, kein Raten) → bis zu 2 Firmen je Person.
- **Ablage heute:** Die Firma geht als Direkt-Kandidat ins Firmen-Radar
  (`POST /v1/discovery/candidates/direct`, source `personen-radar`, Tages-Deckel
  50). Die Person hängt nur als `metaJson.ausloeser` an der Firma: person,
  profileUrl, rolle, aktivitaet, reactionType, kommentar (200 Zeichen), postUrl,
  konfidenz. `metaJson` wird beim Wiederfinden derselben Domain NICHT
  überschrieben (COALESCE) — die zweite Person, die auf denselben Post
  reagiert, geht verloren. Die Kandidatenliste liefert `metaJson` nicht aus.
- **Dedupe:** `pradar_seen` je Profil-URL, 90 Tage. Dieselbe Person auf einem
  zweiten Post wird nicht erneut erfasst — gerade das wäre aber ein starkes
  Signal.
- **Import:** `decide.ts` importiert die Firma; die Auslöser-Person wird NICHT
  als Kontakt angelegt (in PLAN_LINKEDIN_WATCHLIST §8 vorgesehen, nie gebaut).
  Nach dem Import findet erst der Kontakt-Producer Personen, ohne Bezug zum
  Post.
- **Oberfläche:** `PersonenRadarPanel` (Post-URLs, Automatik, Budget,
  Ungeklärt-Liste 14 Tage). Seit v0.1.864 im Firmen-Radar Chips „Aus Posts /
  Aus Suche“ und Badge „aus Post“; Ort kommt seit v0.1.864 aus dem
  Mini-Profil (Impressum), vorher war der Import an „kein Ort“ gescheitert.
- **Bezug Relevanz-Plan** (docs/PLAN_RELEVANZ.md): Nähe aus Verhalten, Gewicht
  aus Sachlage. Eine Post-Reaktion ist ein Nähe-Signal der Person. Dieser
  Bereich ist die erste sichtbare Verwendung dieser Trennung.

## Vorgaben

- Compute-Lokalität bleibt: Apify-Abruf und Kaskade laufen wie heute auf dem
  Gerät des Nutzers (bzw. seiner Server-AVA). Das Gateway speichert und teilt.
- Datenschutz wie PLAN_LINKEDIN_WATCHLIST §5/§8.2: Leads sind Verhaltensdaten
  Unbeteiligter. Kurze Aufbewahrung ohne Übernahme (Vorschlag 90 Tage),
  Herkunftsnachweis je Person, Löschwunsch über die vorhandene Personen-Löschung,
  Kommentartexte nur gekürzt (200 Zeichen) und nur, solange der Lead offen ist.
- Keine Plan-Verweise und keine Repo-Pfade in Nutzertexten.
- Jede neue Einstellung bekommt ein Chat-Werkzeug (Self-Service-Regel).
- Orga-Schalter: Feature `linkedin.leads`, Standard an, wenn `linkedin.radar`
  an ist.

## Zielbild

```
Post (beobachtet) ──► Reaktionen/Kommentare ──► Lead (Person)
                                                  │ Firma (gematcht, Mini-Profil, Score nur Hinweis)
                                                  │ Anlass: Post, Art, Kommentar, Datum
                                                  ▼
                                   [Als Kontakt übernehmen]  [Ansprache vorschlagen]  [Ignorieren]
                                                  │
                                                  ▼
                               Firma importiert (falls neu) + Person als Kontakt mit Anlass-Notiz
```

Der Firmen-Radar bleibt rein für die Suche nach Ort und Branche mit ICP-Tor.
Direkt-Kandidaten aus Posts gehen NICHT mehr in den Radar; die Chips aus
v0.1.864 entfallen wieder, sobald L3 live ist.

## Datenmodell (Gateway, je Tenant)

```
LinkedInLead
  id, tenantId, actorId
  postUrl, postTitel (aus dem ersten Lauf, LLM-Kurztitel), postAutor?
  person: name, profileUrl, headline, rolle
  aktivitaet: reaction | comment, reactionType, kommentar (≤200)
  reagiertAm (falls Actor liefert, sonst Laufzeit)
  firmaDomain?, firmaName?, companyId? (nach Import), discoveryId? (Mini-Profil)
  konfidenz (Kaskade), matchScore? (Hinweis, aus dem Radar-Judge, optional)
  status: offen | uebernommen | ignoriert | ungeklaert
  uebernommenAt?, personId? (Kontakt), ignoriertGrund?
  createdAt, updatedAt, loeschenAb (Aufbewahrung)
Eindeutig: (tenantId, profileUrl, postUrl)
```

Eine Person mit mehreren Posts = mehrere Leads, in der Oberfläche zu einer
Karte gruppiert („hat auf 3 Posts reagiert“). Das ersetzt die 90-Tage-Dedupe
je Profil: Dedupe gilt je (Person, Post), Auflösung der Firma wird je Person
zwischengespeichert, damit der teure Profil-Lookup nicht je Post anfällt.

## Schritte

### L1 — Gateway: Leads speichern und listen

- Tabelle `LinkedInLead` (Migration), Routen:
  `POST /v1/linkedin-leads/batch` (vom Personen-Radar, idempotent je
  Person+Post), `GET /v1/linkedin-leads?status=&post=&seite=`,
  `PATCH /v1/linkedin-leads/{id}` (status, ignoriertGrund),
  `GET /v1/linkedin-leads/posts` (Posts mit Zählern: Leads, offen, übernommen).
- Aufbewahrung: Cron löscht `offen`/`ungeklaert` nach 90 Tagen, Kommentartexte
  bei Übernahme in die Notiz, danach am Lead gelöscht.
- Herkunft: jeder Lead hat `quelle: "linkedin-post"` im Herkunftsnachweis der
  Person, sobald sie Kontakt wird.

### L2 — Personen-Radar schreibt Leads statt Radar-Kandidaten

- Supervisor: je Engager mit Firmen-Match → Lead(s) an L1; „ungeklärt“ wird
  ebenfalls Lead mit Status `ungeklaert` (bisher nur lokale Liste).
- Mini-Profil weiter über den vorhandenen Profiler, aber ohne Radar-Zeile:
  der Lead referenziert die Firma per Domain; `DiscoveredCompany` bleibt als
  Profil-Träger mit `source = personen-radar`, erscheint aber nicht mehr in
  der Radar-Liste (Filter `source <> 'personen-radar'` in der Liste und im
  Deckel-Zähler).
- Score: der inkrementelle ICP-Match darf weiterlaufen; sein Wert wird am Lead
  als Hinweis gespiegelt, nie als Filter verwendet.
- Dedupe je (Person, Post); Firmenauflösung je Person 90 Tage gecacht.

### L3 — Desktop: Bereich „LinkedIn-Leads“

- Neuer Menüpunkt unter LinkedIn (neben Beobachter, Watchlist, Personen-Radar
  → letzterer wird zur Einstellungsseite „Beobachtete Posts“).
- Ansicht je Post: Kopf (Titel, Autor, Datum des ersten Laufs, Zähler), darunter
  Lead-Karten: Person (Name, Rolle, Firma, Ort), Reaktion (Art, Kommentar
  gekürzt mit Aufklappen), Firmen-Kurzprofil (eine Zeile aus dem Mini-Profil),
  Score als graue Zahl mit Tooltip „nur Hinweis“, Konfidenz der Zuordnung.
- Knöpfe: **Als Kontakt übernehmen** (L4), **Ansprache vorschlagen** (öffnet
  den Chat mit vorbefülltem Auftrag: Person, Post, Kommentar, Firmenprofil),
  **Ignorieren** (mit Grund: kein Entscheider, falsche Branche, Wettbewerber).
- Filter: Status, Post, Reaktionsart (nur Kommentare), Rolle enthält.
- Ungeklärte Personen als eigener Reiter mit „Firma zuordnen“ (Freitext →
  Firmensuche) und „Verwerfen“.
- Leerzustände und Hinweis auf Kosten (Apify-Budget) wie im heutigen Panel.

### L4 — Übernahme in einem Schritt

- `POST /v1/linkedin-leads/{id}/uebernehmen`: Firma anlegen oder importieren
  (vorhandener Pfad: bekannt → companyId; Domain neu → `companies/web` bzw.
  Register-Import mit Ort aus dem Mini-Profil), Person als Kontakt mit
  Name, Rolle, LinkedIn-URL (vorhandene Route `contacts/linkedin-url`),
  Anlass als Notiz am Kontakt („Hat am 21.10. den Post ‚…‘ kommentiert: …“),
  Nähe-Signal an die Relevanz (sobald R-Schritte live sind).
- Verarbeitung der Firma startet wie beim Import; der Kontakt ist sofort da,
  nicht erst nach der Kontaktstufe. Der Kontakt-Producer darf die Person
  später anreichern (E-Mail-Muster, Position), nicht ersetzen.
- Rückweg: „Übernahme zurücknehmen“ setzt Status zurück und deaktiviert den
  Kontakt (Tombstone-frei, nur inaktiv).

### L5 — Chat und Meldungen

- Werkzeuge: `linkedin_leads` (lesen, filtern), `linkedin_lead_uebernehmen`
  (confirmAction), `linkedin_lead_ignorieren`, `linkedin_posts_beobachten`
  (ersetzt `personen_radar_config` für Post-URLs; Automatik/Budget bleiben).
- Meldung je Lauf statt je Firma: „7 neue Leads zu ‚Outreach-Post‘, davon 3
  Kommentare“ mit Sprung in den Bereich. Alert-Art `linkedin-lead`.
- Vorschlags-Chips: „Leads aus Posts durchsehen“, „Ansprache für X vorschlagen“.
- Workflow-Ereignis `linkedin.lead` (Payload wie Lead) für Automatisierung
  („Kommentar von Entscheider → Entwurf per Mail an mich“), ohne Score-Tor.

### L6 — PWA

- Reiter „Leads“ unter LinkedIn in app.ava.bi mit derselben Liste, Übernehmen
  und Ignorieren; Ansprache öffnet den Chat.

### L7 — Rückbau und Aufräumen

- Radar: Chips „Aus Posts“ und Badge entfernen, Direkt-Route nur noch für
  andere Direkt-Quellen (heute keine) — bleibt für Workflows erhalten.
- `pradar_seen`/`pradar_unklar` wandern in die Lead-Tabelle; lokale Reste nach
  einem Lauf mit L2 löschen.
- Doku: PLAN_LINKEDIN_WATCHLIST §8 verweist hierher; Hilfetext im Panel.

## Aufwand (grob)

| Schritt | Aufwand | Abhängigkeit |
|---|---|---|
| L1 Gateway | 1 Tag | — |
| L2 Radar schreibt Leads | 0,5 Tag | L1 |
| L3 Bereich Desktop | 1,5 Tage | L1 |
| L4 Übernahme | 1 Tag | L1, Kontakt-Routen |
| L5 Chat/Meldungen/Workflow | 1 Tag | L1–L4 |
| L6 PWA | 0,5 Tag | L1, L4 |
| L7 Rückbau | 0,5 Tag | L2–L3 live |

Reihenfolge: L1 → L2 → L3 → L4 (ein Release, sonst ist der Bereich leer) →
L5 → L6 → L7.

## Stand

- L1–L4 live mit v0.1.865 (2026-10-22), Nachbesserungen v0.1.866 (wer hat übernommen),
  v0.1.867 (Fehler der Kontaktanlage protokolliert, „Kontakt nachholen“), v0.1.868
  (Kommentartext aus dem Feld `commentary`).
- L5–L7 live mit v0.1.869 (2026-10-22): Werkzeuge `linkedin_leads`,
  `linkedin_lead_uebernehmen`, `linkedin_lead_ignorieren`, `linkedin_posts_beobachten`;
  Fähigkeitsgruppe `linkedin_leads`; Workflow-Ereignis `linkedin.lead`; PWA-Seite
  /leads mit Übernahme und Ansprache; Radar-Chips entfernt, Panel-Text angepasst.
- Offen: Ursache des 500ers bei `contacts/linkedin-url` (seit v0.1.867 im Log sichtbar),
  Live-Test mit echtem Post, Entscheidungen unten.

## Offene Entscheidungen

1. **Aufbewahrung offener Leads:** 90 Tage (Vorschlag) oder 30 Tage wie die
   Ungeklärt-Liste heute (14 Tage)?
2. **Kommentartexte:** am Lead speichern (nützlich für Ansprache) oder nur
   anzeigen und bei Übernahme in die Notiz übernehmen? Vorschlag: speichern,
   gekürzt, mit Löschung bei Ignorieren/Ablauf.
3. **Score am Lead:** ganz weglassen oder als grauer Hinweis? Patrick: Hinweis
   ja, Tor nein. Vorschlag: Hinweis.
4. **Autoren-Profile und Themensuche** als Quellen (Ausbaustufe aus §8): erst
   nach L7, mit eigenem Budget.
5. **Hennings Fall ohne ICP:** reicht der Bereich, oder braucht eproX
   zusätzlich einen „ICP aus Leads ableiten“-Schritt (Firmenprofile der
   übernommenen Leads → ICP-Vorschlag)? Kleine Erweiterung des vorhandenen
   ICP-Assistenten, nach L4 möglich.

### Stand v0.1.872/873 (2026-10-22, Feedback Patrick)
- Ungeklärte Leads lassen sich ignorieren; Grund ohne doppelten Text; Lede ohne ICP-Score-Verweis.
- Übernahme ohne bekannten Sitz (Sellmore GmbH: KI fand keinen Ort, Impressum nur unter `/impressum/`): Rückfall liest das Impressum deterministisch (`discovery/ort-impressum.ts`, PLZ+Ort, 4-stellig nur bei AT/CH-Hinweis), der Mini-Profiler nutzt denselben Rückfall; bleibt der Ort unbekannt, antwortet die Übernahme mit `ortFehlt` und Desktop-Panel, PWA und Chat-Werkzeug (`ort`) nehmen den Ort vom Nutzer entgegen.

