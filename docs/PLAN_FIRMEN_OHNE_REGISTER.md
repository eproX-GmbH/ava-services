# Firmen finden, die nicht in den Stammdaten stehen (2026-10-13)

Auftrag (Sprachnachricht Joyce, 2026-10-13): Nennt der Nutzer eine Firma, die in den
Stammdaten nicht gefunden wird, soll AVA nicht aufgeben, sondern (1) live im
Handelsregister nachsehen und (2) als letzten Rückfall per Google-Suche einen
Google-My-Business-Eintrag mit eigener Website finden, per KI-Urteil absichern und die
Firma dann verarbeiten. Harte Vorgaben:

- Firmen OHNE klaren Google-Eintrag mit erreichbarer, eigener Website werden NICHT
  aufgenommen. Lieber keine Firma als eine Karteileiche.
- Die normalisierte Domain ist die ID-Basis für Firmen ohne Registernummer.
- Die Domain muss der Firma gehören und echten, verarbeitbaren Inhalt haben: kein
  Linktree, keine Social-Media-Seite, kein Verzeichnis, keine Baukasten-Subdomain,
  keine Parkseite, kein Redirect auf eine fremde Domain. „facebook.com“ als Domain
  darf nie entstehen.

## 1. Bestandsaufnahme

| Baustein | Stand heute | Verwendbar für |
|---|---|---|
| `company_search` → Gateway `/v1/companies/search` → master-data Elastic (fuzzy, Land) | Liefert 0 Treffer, wenn der Name nicht im Index ist. Neue Firmen (Register-Delta) kommen nur mit dem monatlichen Sammel-Abgleich in den Index (Kostenbremse, docs/PLAN_ELASTIC…). | Auslöser „nicht gefunden“. Lücke: frisch angelegte Firmen sind bis zum Abgleich unsichtbar; master-data hat dafür die Direktsuche über `name_norm` (Stufe 0 der Kunden-Zuordnung). |
| Register-Delta (`packages/register-delta`, vendiert in der App als `resources/p/rd`, Fly-Worker `ava-register-worker`) | Portal-Suche NUR nach Nummer (`suche(gericht, art, nummer)` über die „Erweiterte Suche“), Treffer → `schreibeTreffer` → master-data `upsertRegisterDelta` (source `registerportal`). Lokaler Lauf über das „Mithelfen“-Jobsystem (Jobs aus der Gateway-Queue). | Stufe 1: Das Portal-Formular hat auch `form:schlagwoerter` (Firmenname) + Optionen „alle/mind. ein Schlagwort/genau“. Eine Namenssuche ist dieselbe Seite, dieselbe Treffertabelle, derselbe Parser. Fehlt: Namens-Suchfunktion im Portal, ein Ad-hoc-CLI-Modus (ohne Queue) und der Rückweg companyId → Import. |
| Radar (`services/desktop/src/main/discovery/scan.ts`) | Google Places über `/v1/proxy/valueserp` (`search_type: places`): Titel, Adresse, Kategorie, Bewertung, Telefon, `website`. Zielbild A8 „ohne Website kein Kandidat“ ist dort schon Gesetz; `domainFromUrl` normalisiert, Social-Hosts → null; `DIRECTORY_DOMAIN_RE` filtert Verzeichnisse; Kandidat = `DiscoveredCompany`, ID = Kern-Domain (Gateway `normalizeDomain`). | Stufe 2: Places-Abfrage, Domain-Normalisierung und Sperrliste 1:1 wiederverwenden. Lücke: Erreichbarkeits-/Inhaltsprüfung der Website, Eigentums-Prüfung (Redirect), Baukasten-/Linktree-Sperre, KI-Urteil „ist das die gesuchte Firma?“. |
| Radar-Import (`discovery/decide.ts` → `/v1/imports/from-list`) | Kandidat wird per Name + Ort gegen die Stammdaten gematcht. Ohne Registertreffer: nicht importierbar. | Zeigt die Lücke: Es gibt keinen Weg, eine Firma ohne Registernummer in die Stammdaten zu bringen. |
| Website-Producer (`valueserp-utils.searchAndJudge`, `judgeWebsiteCandidates`) | Sucht die Website per SERP und lässt die Kandidaten vom LLM beurteilen; eine bekannte URL geht als zusätzlicher Kandidat mit (v0.1.745). Manueller Lauf braucht `companySerp.url`. | Für WEB-Firmen soll die geprüfte URL direkt als Website gelten (kein erneutes Raten). Lücke: Übergabe der URL im Trigger-Ereignis. |
| structured-content | Register-Scrape je `districtCourt/registerType/registerNumber`; UK-Zweig (`/^UK_/`) liest Companies House per HTTP statt Portal und fächert danach normal auf (website, profile, contact). company-publication überspringt Nicht-DE-IDs bereits als `skipped`. | Muster für einen WEB-Zweig: kein Scrape, Stammdaten aus dem Ereignis übernehmen, Website-Kette mit bekannter URL anstoßen. |
| master-data `GermanCompany` | Pflichtfelder `registerNumber/registerType/districtCourt/state` (Strings), `country` DE/AT/CH/UK, `source`, `legalForm`, Adresse (`street/zipCode`, `CompanyAddress`). ID-Muster je Land im Validator (`COMPANY_ID_MUSTER`). | WEB-Firmen passen hinein, brauchen aber ein eigenes ID-Muster und eine Register-Art, an der alle Konsumenten „kein Register“ erkennen. |
| Chat (`verarbeitung`-Block, Seele seit v0.1.828) | Firma im Bestand, aber nicht aufbereitet → sofort Import. Ein eindeutiger Suchtreffer → keine Rückfrage. | Erweiterung: 0 Treffer → neues Werkzeug statt „nicht gefunden“. |

## 2. Entscheidungen (Vorschlag, gilt bis Widerspruch)

1. **Reihenfolge je Anfrage:** Stammdaten (Elastic) → Stammdaten-Direktsuche (`name_norm`, fängt frische Register-Delta-Firmen) → Handelsregister live nach Name (lokal, Mithelfen-Browser) → Google Places + Website-Gate + KI-Urteil. Jede Stufe endet, sobald es einen klaren Treffer gibt; mehrere plausible Treffer → Rückfrage wie bisher.
2. **Stammdaten-Modell für Firmen ohne Register („WEB-Firma“):** bleibt in `GermanCompany`.
   `companyId = "WEB_" + Kern-Domain in Großbuchstaben, Punkte → "_"` (z. B. `WEB_EPROX-GMBH_DE`),
   `registerType = "WEB"`, `registerNumber = Kern-Domain` (klein, kanonisch), `districtCourt = ""`,
   `state = Bundesland aus der Adresse oder ""`, `country` aus der Adresse (DE/AT/CH/UK),
   `source = "google-places"`, `legalForm` aus dem Namen (e. K., Einzelunternehmen, GbR …) oder null,
   Adresse aus dem Places-Eintrag in `street/zipCode/location` + `CompanyAddress`. Die Domain ist
   damit eindeutig (ein Eintrag je Domain), und jeder Konsument erkennt an `WEB_`/`registerType WEB`,
   dass es keine Registerstufen gibt. Alternative (eigene Tabelle) verworfen: alle Lese-Pfade
   (Matrix, Suche, Firmenansicht, Kontakte, Alerts) hängen an `GermanCompany`.
3. **Welche Stufen laufen für WEB-Firmen:** Stamm (aus dem Ereignis), Website (mit vorgegebener URL,
   kein SERP-Raten), Profil, Kontakt, E-Mail. Struktur = `skipped` (kein Register), Publikation =
   `skipped` (kein Unternehmensregister). Firmenansicht zeigt ein Badge „ohne Registereintrag“ mit
   der Quelle; Stammdaten-Delta, Insolvenz, Verflechtungen und Konzern bleiben für WEB-Firmen aus.
4. **Website-Gate (hart, deterministisch, vor jedem KI-Urteil):**
   a) Normalisierung wie Radar/Gateway (`normalizeDomain`, Kern-Domain).
   b) Sperrliste: Social (facebook, instagram, linkedin, xing, tiktok, youtube, x/twitter,
      pinterest), Link-Seiten (linktr.ee, linkin.bio, beacons.ai, carrd.co, about.me, taplink),
      Google (google.*, sites.google.com, business.site, goo.gl, maps), Verzeichnisse
      (`DIRECTORY_DOMAIN_RE` des Radars + yelp, gelbeseiten, 11880, dasoertliche, cylex,
      firmenwissen, northdata …), Marktplätze (amazon, ebay, etsy, kleinanzeigen),
      Baukasten-/Shared-Hosts, bei denen die Kern-Domain dem Anbieter gehört (wixsite.com,
      jimdosite.com, jimdofree.com, webnode.*, weebly.com, wordpress.com, blogspot.*,
      squarespace.com, godaddysites.com, strikingly.com, github.io, notion.site, mystrikingly,
      shopify.com-Subdomains ohne eigene Domain, myshopify.com).
   c) Erreichbarkeit + Inhalt: GET der Startseite (https, dann http; Timeout 10 s; max. 3
      Redirects), Status 200, `text/html`, nach Redirects muss die Kern-Domain gleich bleiben
      (Redirect auf facebook/linktree/fremde Domain → abgelehnt), sichtbarer Text ≥ 300 Zeichen,
      keine Parkseiten-Muster („domain is for sale“, „parked“, „Diese Domain ist zu verkaufen“,
      Sedo/GoDaddy-Parkseiten), kein reiner „Coming soon“.
   d) Eindeutigkeit: Domain darf nicht schon einer anderen Firma gehören (WEB-Firma mit derselben
      Domain → das ist dieselbe Firma; Register-Firma mit dieser Website laut `CompanyProfile.url`
      → Rückfrage „meinst du X?“ statt Doppelanlage).
5. **KI-Urteil (lokales Modell des Nutzers, wie Radar/Website-Judge):** Eingabe = gesuchter Name +
   Ort, Places-Eintrag (Titel, Adresse, Kategorie, Telefon), Seitentitel und die ersten 1.500
   Zeichen der Startseite. Fragen: „Ist das die gesuchte Firma?“ und „Ist das ihre eigene Website
   (nicht Verband, Händler, Portal, Franchise-Mutter)?“ Beides mit Konfidenz; Aufnahme nur bei
   ≥ 0,8 für beide. Darunter: dem Nutzer den Kandidaten zeigen und fragen, nie still anlegen.
6. **Kosten:** Places-Abfrage = 1 valueserp-Aufruf über das Operator-Kontingent (wie Radar), die
   Startseite lädt der Rechner des Nutzers, das Urteil das lokale Modell. Handelsregister-Live-
   Suche nutzt den Mithelfen-Browser des Nutzers (eigene IP, Budget 60/h).
7. **Nicht Teil dieses Plans:** Firmen ohne eigene Website (nur Telefon/Adresse), Firmen nur auf
   Social Media. Die bleiben draußen; AVA sagt das dem Nutzer in einem Satz.

## 3. Umsetzungsstufen

- **F1 Website-Gate als Bibliothek** (`packages/firmen-web/` oder zunächst
  `services/desktop/src/main/firmen-web/domain-gate.ts` + Gateway-Zwilling für die Sperrliste):
  `pruefeFirmenDomain(url) → { ok, domain, grund, titel, text }`, Tests mit echten Fällen
  (Linktree, Facebook-Page, Wix-Subdomain, Parkseite, Redirect auf fremde Domain, gute Seite).
- **F2 Handelsregister-Namenssuche:** `RegisterPortal.sucheName(name, ort?)` (Formular
  `form:schlagwoerter`, Option „alle Schlagwörter“, 100 je Seite), CLI-Modus
  `register-delta suche --name --ort` ohne Queue (Mithelfen-Browser), Desktop-IPC + Werkzeug
  `register_live_suche`: Treffer → `upsertRegisterDelta` (Gateway `/v1/register/…`, source
  `registerportal`) → companyId → `import_companies`. Mehrere Treffer → Rückfrage.
- **F3 WEB-Firmen in den Stammdaten:** master-data Validator `WEB`-Muster, Gateway-Route
  `POST /v1/companies/web` (legt die Firma an, prüft Domain-Eindeutigkeit, gibt companyId),
  structured-content WEB-Zweig, Website-Trigger mit `url`, company-publication `skipped`,
  Matrix/Verarbeitungsstand/Badge.
- **F4 Werkzeug `firma_finden`** (Desktop): Orchestriert Stufen 1–4, nutzt Places + Gate + Urteil,
  legt an, importiert, meldet. Prompt/Seele: 0 Treffer in `company_search` → `firma_finden`,
  nie „nicht gefunden“ ohne diesen Versuch. Vorschlagsgruppe pflegen.
- **F5 Live-Test** mit drei Fällen (eine frische Register-Firma, ein Einzelunternehmer mit eigener
  Website, ein Friseur nur mit Facebook-Seite → muss abgelehnt werden) und Nachtrag hier.

Stand: Plan geschrieben, F1–F5 offen (Freigabe der Entscheidungen 2 und 3 erbeten).
