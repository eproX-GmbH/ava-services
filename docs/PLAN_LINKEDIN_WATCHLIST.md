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
"kontakt", companyId?: string | null, aktiv: boolean }`. Profile-URL
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
| WL1 | Schema + Adapter-Interface + Apify-Adapter (verify, fetchActivity, tolerante Normalisierung) — VOR Start: Actor-Schemata live pruefen | ~½ Tag |
| WL2 | Watchlist-Store + Dedupe-Historie (SQLite) + Key-Store (safeStorage) + Reset/Kill-Switch-Anbindung | ~½ Tag |
| WL3 | Supervisor (Intervall, Batches, Backoff) + Klassifikation + Alert-Fanout | ~½ Tag |
| WL4 | UI (Settings-Block, Watchlist-Tab, Kontakt-Aktion) + Chat-Tools + Plan-Deckel | ~½–1 Tag |
| WL5 | *(Ausbaustufe)* zweiter Adapter (Gegenprobe der Abstraktion) | ~½ Tag |
| WL6 | *(Ausbaustufe, nur bei Bedarf)* Operator-Kostprobe via Gateway-Proxy (valueserp-Muster) + harte Item-Deckel | ~1 Tag |

Empfehlung: WL1–WL4 als ein Release; WL5/WL6 zurueckstellen, bis das
Feature Nutzung zeigt.

## 8. Offene Punkte (bei Umsetzung klaeren)

- Actor-Landschaft neu sichten (Preise, Schemata, cookielos?) — Stand
  in diesem Doc ist 2026-08 und veraltet schnell.
- Kontakte haben heute nicht durchgaengig LinkedIn-URLs — die
  „Auf die Watchlist"-Aktion braucht das Feld; ggf. kleiner
  Kontakt-Anreicherungsschritt vorher.
- Generischer Integrations-Credential-Store (Aufraeumen der inzwischen
  6+ safeStorage-Einzelstores) — SEPARATER Auftrag, nicht hier
  mitschleppen.

## STATUS

- Entwurf erstellt (2026-08-31), keine Umsetzung begonnen.
