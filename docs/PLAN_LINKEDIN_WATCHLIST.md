# Plan: LinkedIn-Personen-Watchlist (BYOK-Scraping-Integrationen)

Stand: 2026-08-31 · Status: ENTWURF, wartet auf Freigabe

## 1. Zielbild

Heute beobachtet AVA den EIGENEN LinkedIn-Feed des Nutzers (Phase L0-L7,
~8.000 Zeilen unter `main/linkedin/`): verstecktes Electron-Fenster,
eingeloggter Nutzer-Account, Extractor → Linker → `linkedin-signal`-
Alerts. Passiv — es kommt nur, was der LinkedIn-Algorithmus in den Feed
spuelt.

Neu dazu kommt die **Personen-Watchlist**: gezielte Beobachtung der
oeffentlichen Aktivitaet ausgewaehlter Personen (Reaktionen +
Kommentare, d. h. `linkedin.com/in/<slug>/recent-activity/…`) ueber
externe Scraping-Anbieter. Use-Case: „Nils Frohloff hat auf einen Post
ueber ERP-Migration reagiert" = Kaufsignal, das im Feed nie auftauchen
wuerde. Die Watchlist-Eintraege sind typischerweise Ansprechpartner aus
dem CRM/Kontakte-Bestand.

**Zweck 1 (dieser Plan, ratifiziert 2026-08-31):** Timing +
Gespraechsanlass fuer BESTEHENDE Zielkontakte — „wann spreche ich wen
womit an". Die beobachteten Personen kommen aus dem Kontakte-Bestand
(company-contact-Service), siehe §2b Datengrundlage.

**Zweck 2 (Ausbaustufe, ausdruecklich im Auge behalten):**
Personen-Radar — Neukunden-Entdeckung ueber Engagement (wer reagiert
auf relevante Posts?). Eigener Abschnitt §9 mit dem
Person→Firma-Matching-Mechanismus.

**Das letzte Drittel der Kette existiert bereits** und wird
wiederverwendet: Dedupe-Muster, Linker (Signal → Firma/Kontakt im
Bestand), Signal-Klassifikation (SIGNAL_KINDS in extractor.ts),
Alert-Fanout (Glocke/Push/Telegram inkl. Plan-Politik).

## 2. Ratifizierte Grundentscheidungen

- **W1 — BYOK, kein Operator-Token (Default-Pfad).** Der Nutzer
  hinterlegt seinen eigenen Anbieter-Key (z. B. Apify). Gruende:
  1. *Kostenkurve:* Kosten skalieren mit Profile × Frequenz × Items —
     genau das, was der Nutzer maximieren will (50 Profile taeglich
     ≈ 60 USD/Monat, 200 Profile ≈ 240 USD). Ein aktiver Nutzer
     fraesse die Marge eines zweistelligen Abos komplett auf.
  2. *Kein Pool-Effekt:* Anders als DiscoveredCompany beobachtet jeder
     Nutzer ANDERE Personen — kein geteilter Bestand, kein Cache-Gewinn,
     Kosten linear in Nutzern × Profilen.
  3. *DSGVO-Rolle:* Mit Operator-Token stiesse DER OPERATOR die
     Erhebung personenbezogener Daten ueber Dritte an (AVV je Kunde,
     Verarbeitungsverzeichnis, Art.-14-Informationspflicht,
     Loeschkonzept, Apify-Subunternehmerkette). Mit BYOK bleibt der
     Nutzer Verantwortlicher — wie beim heutigen Feed-Scraper.
- **W2 — Direktaufruf vom Desktop, KEIN Gateway-Proxy.** Der BYO-Key
  beruehrt den Operator nie, auch nicht transient (staerker als der
  LLM-BYO-Pfad, der durchs Gateway an Fly-Producer reicht — hier
  passiert die Arbeit lokal). Compute-Lokalitaets-Invariante bleibt
  intakt. Ein Gateway-Proxy (Muster valueserp: Scope-Gate, 4-Fenster-
  Rate-Limit, ProxyQuotaOverride, ProxyAudit, Endpoint-Pinning) kommt
  NUR, falls spaeter eine Operator-„Kostprobe" gewuenscht ist — als
  zweiter Pfad, ohne den Adapter anzufassen.
- **W3 — Abstraktion auf CAPABILITY-Ebene, nicht Anbieter- oder
  HTTP-Ebene.** AVA definiert die Faehigkeit
  `linkedin.profile-activity` mit normiertem Ausgabe-Schema; pro
  Anbieter ein kleiner Adapter (Input-Mapping + Output-Normalisierung,
  ~50-100 Zeilen). Alles dahinter sieht nur das Schema. Der Vertrag ist
  das Signal-Schema, nicht die Anbieter-API (Muster LlmProviderManager).
- **W4 — Apify als erster Adapter, Actor-ID KONFIGURIERBAR.** Apify ist
  selbst ein Meta-Anbieter (Actor-Marktplatz): ein Adapter mit
  konfigurierbarer Actor-ID + Feld-Mapping deckt Dutzende
  Unter-Anbieter ab. Default-Actors (Stand 2026-08:
  `harvestapi~linkedin-profile-reactions` und
  `…-profile-comments`, cookielos, ~2 USD/1.000 Items) sind
  VORBELEGUNG, nicht Hardcode — dieser Markt dreht sich schnell,
  Actors/Preise/Schemata VOR Umsetzung neu pruefen. Zweiter Adapter
  (direkter HTTP-Anbieter) folgt als Gegenprobe der Abstraktion; NICHT
  jetzt festlegen welcher.
- **W5 — Synchron starten.** `run-sync-get-dataset-items` fuer kleine
  Batches (wenige Profile pro Call, mehrere Calls). Webhook-/Run-State-
  Verwaltung (fuer grosse Listen) ist bewusst Ausbaustufe — sie wuerde
  Server-State erfordern.
- **W6 — Nur oeffentliche Aktivitaet, Transparenz statt Vollstaendig-
  keitsversprechen.** Cookielose Actors sehen nur Public-Activity;
  LinkedIn kuerzt die Ansicht. Adapter melden ehrlich, was sie NICHT
  liefern konnten (Profil privat, leer, Fehler) — Konvention aus
  docs/ZUVERLAESSIGKEIT.md §2 (kein stilles „alles ok").
- **W7 — Kill-Switch + Reset.** Watchlist, Sichtungs-Historie und
  Anbieter-Keys stehen im Werksreset; der bestehende LinkedIn-
  Kill-Switch (store.reset) loescht auch die Watchlist-Daten.

## 2b. Datengrundlage: Woher kommen die LinkedIn-URLs?

Die Watchlist ist nur so gut wie die Profil-URLs am Kontakt. Heutige
Herkunft (verifiziert im Code):

1. **valueserp-Mitarbeitersuche** im company-contact-Producer
   (`valueserp.ts`): Queries wie `site:linkedin.com/in "<Firmenname>"`
   und `site:linkedin.com/in "<Domain>"` — LLM extrahiert daraus
   Personen inkl. `linkedinUrl`.
2. **Website-Extraktion** (Team-/Ueber-uns-Seiten mit
   LinkedIn-Links).
3. **Host-Gate im Gateway-Persist** (`employee-contact.ts`,
   LINKEDIN_HOSTS linkedin.com/lnkd.in): verhindert, dass CDN-/
   Avatar-URLs im linkedinUrl-Feld landen.

**WL0 — Vorab-Pruefung (PFLICHT vor WL1, User-Auflage):** Wie gut ist
diese Grundlage wirklich?

- **Abdeckung messen:** Anteil der EmployeeContacts im Bestand mit
  befuelltem linkedinUrl (SQL gegen die Kontakt-DB, read-only).
- **Korrektheit stichproben:** 20-30 zufaellige (Name, Firma,
  linkedinUrl)-Tripel manuell/halbautomatisch pruefen — zeigt die URL
  wirklich DIESE Person bei DIESER Firma? (Namensvetter-Risiko der
  site:-Suche!)
- **Luecken-Pfad:** fuer Kontakte OHNE URL einen gezielten
  Nachschlag definieren (`site:linkedin.com/in "<Vorname Nachname>"
  "<Firma>"` via valueserp, 1 Query/Kontakt, nur auf Anforderung/
  fuer Fokus-Personen — Budget!). Erst wenn Abdeckung + Korrektheit
  akzeptabel sind, lohnt der Watchlist-Bau.

**WL0-ERGEBNIS (gemessen 2026-08-31, Prod read-only via MPG-Proxy):**

Abdeckung — DUENN:
- 147 Personen im Bestand, 130 mit aktueller Anstellung, 29 Firmen
  mit Kontakten.
- Nur **31 Personen (21 %)** haben einen aktiven linkedinUrl-Fact;
  nur **4 von 29 Firmen (14 %)** haben ueberhaupt einen Kontakt mit
  URL. → Der Luecken-Nachschlag ist PFLICHT, nicht Option.
- 11 der 31 URL-Traeger haben KEINE aktuelle Firmen-Zuordnung
  (Employment fehlt) — fuer die Watchlist unbrauchbar, solange die
  Firma nicht haengt.

Korrektheit — Licht und Schatten:
- Von 32 aktiven Facts sind **25 echte /in/-Profile (78 %)**; bei
  denen matcht der URL-Slug durchgehend plausibel den Personennamen
  (birgit-peters, kathrin-milsmann, hakan-sağkal url-encodiert, …).
  Firmen-Zuordnungs-Korrektheit (Namensvetter!) bleibt bei
  valueserp-Quellen ungeprueft — Konfidenz einheitlich 0.60
  (Altbestand aus der Vor-Sanierungs-Aera).
- **7 Facts (22 %) sind KEINE Profil-URLs**: 1x linkedin.com/posts/…
  (Post statt Profil — das Host-Gate prueft nur den Host, nicht den
  Pfad), 4x Presseseiten/CDN-JPGs von Firmen-Websites (Quelle
  agent:website_people, VOR dem Host-Gate persistiert — Teil des
  bekannten offenen Punkts „Altbestand-Re-Normalisierung").
- 1 Personen-Duplikat durch fehlende URL-Normalisierung
  (linkedin.com/in/x vs www.linkedin.com/in/x/ als zwei Facts);
  Laender-Subdomains (de./uk./tr.) uneinheitlich.

**Konsequenzen (Vorbedingungen fuer WL1-Go):**
1. *Gate schaerfen (Gateway, employee-contact.ts):* linkedinUrl
   braucht zusaetzlich ein PFAD-Gate (nur /in/-Profile) und eine
   URL-Normalisierung (https + www erzwingen, Laender-Subdomain →
   www, Slash/Query strippen) als normalized/Dedupe-Schluessel.
   Kleiner Fix, sofort machbar.
2. *Altbestand bereinigen:* die 7 Fremd-Facts retracten + das
   Duplikat mergen — Prod-Write, braucht explizites Go.
3. *Nachschlag bauen:* gezielte valueserp-Query
   (site:linkedin.com/in "<Name>" "<Firma>") pro Fokus-Person, mit
   Slug≈Name-Plausibilitaetscheck vor dem Persist.
4. Die 11 firmenlosen URL-Traeger sind beim Watchlist-Add aus der
   Kontaktansicht unkritisch (companyId kommt mit), gehoeren aber
   mittelfristig ans Employment.

FAZIT WL0: Grundlage noch NICHT stabil — erst 1 (+2 mit Go) und 3,
dann WL1.

**Konsequenz 1+3 UMGESETZT (v0.1.476):** normalizeLinkedInProfileUrl
im Gateway (Pfad-Gate /in/, kanonische Form www+lowercase-Slug,
lnkd.in verworfen) — wirkt in personIdentityKey (mit Legacy-Key-
Fallback gegen Re-Scrape-Dubletten) und buildPersonObservations
(kanonischer Wert wird persistiert). Neue Nadeloehr-Route POST
/v1/companies/{id}/contacts/linkedin-url (validiert serverseitig,
persistiert via applySingleEmployeeCandidate = voller Sanitierungs-
Pfad). Desktop-Tool contact_linkedin_lookup: SERP-Suche + Slug≈Name-
Plausibilitaetscheck (Umlaut-/Transliterations-Falte beidseitig),
confirmAction Klasse A, Mehrdeutigkeit → Kandidatenliste, kein
Treffer → ehrlich nichts. Verifiziert gegen alle WL0-Problemfaelle.
Konsequenz 2 ERLEDIGT (2026-08-31, mit User-Go): 7 Fremd-Facts auf
INACTIVE gesetzt (Status-Aenderung, keine Loeschung; Beleg-IDs im
Session-Log), Joyce-Duplikat auf die kanonische Form konsolidiert
(1 Fact aktualisiert, 1 deaktiviert). Nachher-Stand: 24 aktive
linkedinUrl-Facts, davon 24 echte /in/-Profile (100 %). Gateway mit
Gate+Route deployed. → WL1 kann starten.

## 2c. Fokus-Personen (Priorisierung, User-Auflage)

Der Kontakte-Bestand waechst schnell auf Hunderte Personen — die
Watchlist darf kein Alles-oder-Nichts sein:

- Kontakte (und Watchlist-Eintraege) bekommen ein **Fokus-Flag**
  (`fokus: boolean`, setzbar im Kontakt-Detail, in der
  Watchlist-Ansicht und per Chat-Tool „nimm Nils Frohloff in den
  Fokus").
- **Budget-Verteilung statt harter Trennung:** Fokus-Personen werden
  bei JEDEM Lauf zuerst geprueft (taeglich bei Pro); der Rest der
  Watchlist rotiert im verbleibenden Item-Budget (round-robin nach
  aeltester Sichtung, woechentliche Garantie). Damit bleibt die
  Kostenkontrolle beim Nutzer: `maxItemsProLauf` in den Settings,
  Fokus frisst zuerst.
- **Alert-Gewichtung:** Signale von Fokus-Personen bekommen severity
  mindestens "warn" (→ Telegram-Default), Nicht-Fokus normal "info"
  ausser bei starker ICP-Naehe.
- Plan-Staffelung §6 gilt zusaetzlich fuer die Fokus-Plaetze:
  Starter max 5, Pro max 25 Fokus-Personen.

## 3. Normiertes Signal-Schema (der Vertrag)

```ts
interface ProfileActivitySignal {
  /** Beobachtete Person (Watchlist-Eintrag). */
  personProfileUrl: string;        // normiert: https://www.linkedin.com/in/<slug>/
  personName: string | null;
  activityType: "reaction" | "comment";
  reactionType?: string | null;    // like | celebrate | insightful | …
  commentText?: string | null;     // nur bei comment
  /** Worauf reagiert wurde. */
  targetPostUrl: string;
  targetAuthorName: string | null;
  targetAuthorProfileUrl: string | null;
  targetSnippet: string | null;    // Anfang des Post-Texts
  /** LinkedIn liefert oft nur Relativzeit ("2d") — als Text UND
   *  best-effort-ISO; NIE als Dedupe-Schluessel verwenden. */
  observedAtRaw: string | null;
  observedAtIso: string | null;
  /** Herkunft. */
  providerId: string;              // "apify"
  actorId?: string | null;
}
```

**Dedupe-Schluessel: `sha256(personProfileUrl + "|" + targetPostUrl +
"|" + activityType)`** — Zeitstempel sind unbrauchbar (relativ),
Post-URL + Person + Art ist stabil. Historie in SQLite neben der
bestehenden LinkedIn-DB (`main/linkedin/db.ts`-Muster), Cap ~5.000
Zeilen, TTL 90 Tage.

## 4. Bausteine

### 4.1 Adapter-Schicht (`main/linkedin/watchlist/providers/`)

```ts
interface ProfileActivityProvider {
  id: string;                        // "apify"
  label: string;
  /** Health-/Key-Check fuer die Settings-UI ("Key testen"). */
  verify(key: string): Promise<{ ok: boolean; detail?: string }>;
  fetchActivity(
    key: string,
    profiles: string[],              // wenige pro Call (W5)
    opts: { maxItemsPerProfile: number; signal: AbortSignal },
  ): Promise<{
    signals: ProfileActivitySignal[];
    /** W6 — ehrliche Luecken: was kam NICHT? */
    fehlgeschlagen: Array<{ profileUrl: string; grund: string }>;
    kosteneinheiten: number;         // Items geliefert (fuer die Anzeige)
  }>;
}
```

Apify-Adapter: zwei Actor-Aufrufe (Reactions + Comments) via
`POST /v2/acts/<actorId>/run-sync-get-dataset-items?token=…`
(Tilde-Konvention im Actor-Namen beachten), Actor-IDs + Feld-Mapping
aus einer Adapter-Konfiguration (Settings, mit Default-Vorbelegung).
Output-Normalisierung tolerant nach dem ICP-Schema-Muster (v0.1.471):
zu viel → kuerzen, kaputte Items → filtern, nie Totalausfall wegen
eines Nebenfelds.

### 4.2 Watchlist-Store (`main/linkedin/watchlist/store.ts`)

Lokale Liste `{ profileUrl, label, addedAt, quelle: "manuell" |
"kontakt", companyId?: string | null, aktiv: boolean,
fokus: boolean }` (§2c). Profile-URL
wird beim Anlegen normiert (Slug extrahieren, www erzwingen, Pfad/Query
strippen). Verknuepfung zu Bestand: beim Hinzufuegen aus einer
Kontaktansicht wird companyId mitgegeben — dann kann der Alert direkt
auf die Firma verlinken, der Linker-Fuzzymatch ist nur Fallback.
Plan-Deckel (§6) wird hier durchgesetzt.

### 4.3 Scheduler + Ingest (`main/linkedin/watchlist/supervisor.ts`)

Muster RadarSupervisor/LinkMonitor: Opt-in, Intervall taeglich (Default)
oder woechentlich; pro Lauf Watchlist in Batches à 5 Profile durch den
Adapter, Dedupe gegen die Historie, NEUE Signale → Klassifikation →
Alert. Fehler-Backoff pro Profil (Muster ProfileWorker, 24 h), Abbruch
des Laufs bei Key-Fehler (401/402) mit klarem Settings-Hinweis.
Manueller „Jetzt pruefen"-Button zusaetzlich.

### 4.4 Klassifikation + Alerts

Neue Signale laufen durch einen kleinen LLM-Schritt (Producer-Modell,
Eskalation nach llmJson-Muster): Relevanz-Einordnung mit den
bestehenden SIGNAL_KINDS + Freitext-Begruendung mit ICP-Kontext
(„reagiert auf ERP-Migrations-Post → passt zu deinem Angebot X").
Alert: bestehender `linkedin-signal`-Kind, sourceRef =
Dedupe-Schluessel, severity nach Staerke (Kommentar > Reaktion;
Ziel-Post-Thema nahe am ICP → warn). Fanout wie gehabt (Glocke, Push,
Telegram). Watch-Executor-/Interest-Kalibrierung (👍/👎) gilt
automatisch mit, weil derselbe Alert-Kind.

### 4.5 UI

- **Settings → Automatisierungen → LinkedIn:** neuer Block
  „Personen-Watchlist": Anbieter-Auswahl (vorerst Apify), Key-Eingabe
  (safeStorage; NIE in den Renderer zurueckspiegeln, Muster
  Telegram-Token), „Key testen", Actor-Konfiguration (aufklappbar,
  mit Defaults), Intervall, Kill-Switch.
- **Kontakt-/Firmendetail:** „Auf die Watchlist"-Aktion, wenn eine
  LinkedIn-Profil-URL am Kontakt bekannt ist.
- **Watchlist-Ansicht** (Tab in der LinkedIn-Route): Eintraege,
  letzte Sichtung, letzte Signale, Kosten-Zaehler des Monats
  (kosteneinheiten aufsummiert — Transparenz, da der Nutzer zahlt).
- **Chat-Tools:** `linkedin_watchlist_add/remove/list` +
  `linkedin_watchlist_check_now` (Klasse-A-Aktionen → confirmAction
  additive; add aus Telegram heraus damit vollmacht-faehig).

## 5. Datenschutz-Leitplanken (in der UI sichtbar, nicht nur im Doc)

- Einordnungstext beim Aktivieren: Nutzer ist Verantwortlicher; Hinweis
  auf Art.-6(1)(f)-Interessenabwaegung + Art.-14-Informationspflicht
  bei Erstkontakt (kein Rechtsrat, aber ehrliche Orientierung).
- Nur oeffentliche Aktivitaet; keine Anmeldedaten Dritter; kein
  Operator-Zugriff auf Rohdaten (alles lokal).
- Loeschkonzept eingebaut: 90-Tage-TTL der Sichtungen, Watchlist im
  Werksreset, Kill-Switch loescht sofort.
- MARKETING_FEATURE_REALITY: Feature erst nach Live-Verifikation
  bewerben, Formulierung „oeffentliche LinkedIn-Aktivitaet deiner
  Ansprechpartner" — NIE „lueckenlos".

## 6. Plan-Staffelung

Das Feature kostet den Operator nichts (BYOK) — die Staffelung ist
reine Produktpolitik, durchgesetzt lokal im Watchlist-Store:

| | Free | Starter | Pro |
|---|---|---|---|
| Watchlist-Plaetze | 0 (Feature aus, Teaser) | 25 | 200 |
| Automatik | — | woechentlich | taeglich |

(Free-Teaser: Block sichtbar mit Upgrade-Hinweis, analog Blur-Gate.)

## 7. Phasen & Aufwand

| Phase | Inhalt | Aufwand |
|---|---|---|
| WL0 | Vorab-Pruefung Datengrundlage (§2b): Abdeckungs-Messung + Korrektheits-Stichprobe der linkedinUrl-Felder, Luecken-Nachschlag-Design | ~½ Tag |
| WL1 | Schema + Adapter-Interface + Apify-Adapter (verify, fetchActivity, tolerante Normalisierung) — VOR Start: Actor-Schemata live pruefen | ~½ Tag |
| WL2 | Watchlist-Store + Dedupe-Historie (SQLite) + Key-Store (safeStorage) + Reset/Kill-Switch-Anbindung | ~½ Tag |
| WL3 | Supervisor (Intervall, Batches, Backoff) + Klassifikation + Alert-Fanout | ~½ Tag |
| WL4 | UI (Settings-Block, Watchlist-Tab, Kontakt-Aktion) + Chat-Tools + Plan-Deckel | ~½–1 Tag |
| WL5 | *(Ausbaustufe)* zweiter Adapter (Gegenprobe der Abstraktion) | ~½ Tag |
| WL6 | *(Ausbaustufe, nur bei Bedarf)* Operator-Kostprobe via Gateway-Proxy (valueserp-Muster) + harte Item-Deckel | ~1 Tag |

Empfehlung: WL0 zuerst (Ergebnis entscheidet ueber Go); WL1–WL4 als
ein Release; WL5/WL6 zurueckstellen, bis das Feature Nutzung zeigt.

## 8. Zweck 2 (Ausbaustufe): Personen-Radar ueber Engagement

Umgekehrte Richtung: Nicht „was tun meine Kontakte", sondern **„wer
zeigt gerade Interesse am Thema"** — Engagement als Lead-Quelle. Wer
auf einen Post ueber ERP-Migration reagiert oder kommentiert, hat sich
selbst als thematisch interessiert markiert; das ist ein
Personen-Level-Pendant zum Firmen-Radar.

**Quellen (konfigurierbar, alle drei sinnvoll):**
1. Eigene Posts des Nutzers (waermste Leads: die kennen dich schon).
2. Posts definierter Autoren (Branchen-Groessen, Wettbewerber).
3. Thematische Post-Suchen (Keyword → Posts → deren Engager).

Braucht ANDERE Actors als Zweck 1 (Post-Reactions/-Comments statt
Profil-Activity) — Adapter-Schicht und Signal-Schema aus §3/§4 werden
wiederverwendet, nur die Eingangsrichtung dreht sich.

### 8.1 Person→Firma-Matching (der Kernmechanismus, User-Auflage)

Ein Engager ist erst dann ein Radar-Kandidat, wenn er BELASTBAR einer
Firma zugeordnet ist. Konfidenz-Kaskade, beste Quelle zuerst:

1. **Berufserfahrung → Unternehmensseite → Website (hart).**
   WICHTIG, Quelle praezise: NICHT das freie „Website"-Feld im
   Profil-Kontaktbereich (das ist oft ein Calendly-Link o. ae. —
   unbrauchbar). Sondern: die **aktuellen Positionen** aus der
   Berufserfahrung der Person. Positionen bei Firmen MIT
   LinkedIn-Unternehmensseite tragen einen
   `linkedin.com/company/<slug>`-Link; die Unternehmensseite pflegt
   ihr Website-Feld selbst (Firmen-Angabe, nicht Personen-Angabe) →
   `normalizeDomain` → **das IST die Discovery-ID**
   (Domain=ID-Invariante). Damit landet die Firma verlustfrei im
   bestehenden Trichter: Domain bekannt → Firma bekannt/Kandidat;
   Domain neu → neuer DiscoveredCompany-Kandidat (Website-Pflicht per
   Konstruktion erfuellt), Mini-Profil + ICP-Match wie gehabt.

   **Mehrere aktuelle Positionen sind der Normalfall, kein Randfall**
   (Anstellung + eigene GmbH + Beirat/Beteiligung): ALLE aktuellen
   Positionen werden aufgeloest und gematcht — eine Person darf auf
   mehrere Firmen zeigen. Ranking der Firmen fuers Radar: primaere
   Position zuerst (LinkedIn-Reihenfolge), dann ICP-Score; die
   Ausloeser-Person haengt an JEDER gematchten Firma mit ihrer
   dortigen Rolle.

   **Daten-Realitaet / Kosten:** Engagement-Actors liefern am Engager
   typischerweise nur Name, Headline, Profil-URL — die
   Berufserfahrung braucht einen ZWEITEN Lookup (Profil-Detail-Actor)
   und die Website einen DRITTEN (Company-Page). Aufloesung deshalb
   nur fuer Engager, die die Vorfilter passieren (§8.2), mit hartem
   Budget; Positionen ohne Unternehmensseiten-Link (Freitext-
   Arbeitgeber) fallen auf Stufe 2 zurueck.
2. **Headline-/Freitext-Parsing (mittel):** „Rolle bei <Firmenname>" aus der
   Engager-Headline → `normalizeCompanyName` → Abgleich gegen
   CompanyNameCache / GermanCompany (master-data) / DiscoveredCompany.
   Eindeutiger Treffer → wie 1 weiter; mehrdeutig → SERP-Nachschlag
   `"<Firmenname>" <Ort?>` zur Domain-Aufloesung (Verzeichnis-Filter
   wie im Register-Kanal).
3. **Kein Match (ehrlich):** Person OHNE belastbare Firma wird NICHT
   geraten und NICHT als Kandidat gefuehrt — sie erscheint hoechstens
   in einer „ungeklaert"-Liste zur manuellen Sichtung. Kein
   LLM-Raten von Arbeitgebern (Halluzinations-Verbot).

**Ergebnis-Objekt:** neuer Radar-Kandidat (Firma) MIT angehaengter
Ausloeser-Person `{ name, profileUrl, rolle, ausloeser: "reagierte
auf <Post-Thema>" }` — beim Import wird die Person direkt als
Kontakt-Kandidat an der Firma angelegt. Der ICP-Match laeuft auf der
FIRMA (bestehender Judge); die Person liefert Begruendungs-Kontext
(„Entscheider zeigt aktives Interesse an X").

### 8.2 Abgrenzung + Risiken

- Deutlich hoeheres Volumen als Zweck 1 (ein viraler Post = Tausende
  Engager) → hartes Item-Budget pro Lauf + Vorfilter (nur Engager mit
  Company-Signal, nur DACH, Dedupe ueber Person).
- DSGVO-Gewicht hoeher (Erhebung ueber voellig Unbeteiligte) — gleiche
  BYOK-Logik wie W1, Leitplanken aus §5 gelten verschaerft;
  „ungeklaert"-Liste mit kurzer TTL (14 Tage).
- Phasen (grob, erst nach WL1-WL4 + Nutzungserfahrung): PR1
  Post-Engagement-Adapter, PR2 Matching-Kaskade §8.1, PR3
  Radar-Integration (Kandidat + Ausloeser-Person), PR4 Quellen-UI.
  Schaetzung ~2-3 Tage.

## 9. Offene Punkte (bei Umsetzung klaeren)

- Actor-Landschaft neu sichten (Preise, Schemata, cookielos?) — Stand
  in diesem Doc ist 2026-08 und veraltet schnell.
- Kontakte haben heute nicht durchgaengig LinkedIn-URLs — die
  „Auf die Watchlist"-Aktion braucht das Feld; ggf. kleiner
  Kontakt-Anreicherungsschritt vorher.
- Generischer Integrations-Credential-Store (Aufraeumen der inzwischen
  6+ safeStorage-Einzelstores) — SEPARATER Auftrag, nicht hier
  mitschleppen.

## STATUS

- Entwurf erstellt (2026-08-31).
- WL0 durchgefuehrt (2026-08-31): Ergebnis in §2b — Abdeckung 21 %,
  22 % Fremd-URLs im Feld, Gate-/Normalisierungs-Fixes als
  Vorbedingung identifiziert.
- 2026-08-31: Zweck 1 vom User ratifiziert; Auflagen ergaenzt: WL0
  Datengrundlagen-Pruefung (linkedinUrl-Qualitaet aus dem
  Kontakt-Service), Fokus-Personen-Priorisierung (§2c); Zweck 2
  (Personen-Radar) als Ausbaustufe §8 festgehalten inkl.
  Person→Firma-Matching-Kaskade.
