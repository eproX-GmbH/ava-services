# Plan: Compliance- und Enterprise-Faehigkeit

Stand 2026-09-03. Status: Konzept. Antwort auf die externe Bewertung
(„lokal = drei verschiedene Dinge", LinkedIn-Haftung, Profiling/DSFA,
Cloud-Modelle, Telemetrie, Skalierung) und Joyces Kommentare dazu.
Leitlinie: berechtigte Fragen entweder ohne Funktionsverlust loesen
oder Funktionen sauber abschaltbar machen; nichts ueberverkaufen.

## 0. Befund: Was verlaesst heute den Rechner? (am Code erhoben)

| Datenklasse | Bleibt lokal | Geht an AVA-Substrat | Bemerkung |
|---|---|---|---|
| Chats, Agent-Gedaechtnis, Profil, ICP-Definition | ja | nein | Account-Space (v0.1.527) |
| API-Keys, Abo-Tokens, Mail-/Telegram-/LinkedIn-Logins | ja | nein | verschluesselt je Konto |
| Mail-Inhalte, Telegram-Nachrichten | ja | nein | PGlite lokal |
| Watchlist-Signale (LinkedIn-Aktivitaet von Zielkontakten) | ja | nein | lokale DB, Alerts lokal |
| **Welche Firmen ein Nutzer recherchiert** | nein | **ja** | Transaktionen (userId + companyIds) in master-data; noetig fuer Producer-Steuerung |
| **Firmenfakten aus oeffentlichen Quellen** (Register, Bundesanzeiger, Website, SERP) | nein | **ja, geteilt** | Company/Fact/Observation ohne Mandantenbezug — bewusst: Firmenwissen wird nicht kopiert |
| **Personen an Zielfirmen** (Name, Titel, Abteilung, LinkedIn-/XING-URL, Firmen-E-Mail/-Telefon von Website und Suche) | nein | **ja, geteilt** | Person/Employment/Fact/Observation mit Quelle, Beleg, Zeitstempel, runId — aber ohne Mandanten-/Akteurs-Zuordnung, ohne Loeschroute je Person |
| **Personen-Radar-Ausloeser** (Name, Profil-URL, Kommentar-Auszug einer Person, die auf einen beobachteten Post reagiert hat) | nein | **ja** | als `meta.ausloeser` am Radar-Kandidaten (JSON, bis 4000 Zeichen) |
| Bilder aus LinkedIn-Posts (Logo-/Produkt-Erkennung) | je nach Modell | je nach Modell | gehen an das konfigurierte Vision-Modell: lokal (Ollama) ODER Cloud-Anbieter |
| Verbrauch (Firmen je Monat), Audit (Methode/Pfad/Akteur), Proxy-Nutzung | nein | ja | Lizenz-/Kontingentzaehlung, kein Produkt-Tracking (keine Sentry/PostHog o. ae.) |

Konsequenz fuer die Aussenkommunikation: „verlaesst deinen Rechner nie"
ist so nicht haltbar. Haltbar und stark ist: **„Deine eigenen Daten
(Chats, Logins, Schluessel, ICP, Mails) verlassen deinen Rechner nie.
Oeffentliche Firmen- und Kontaktinformationen aus oeffentlichen Quellen
landen mit Quellenbeleg in einem geteilten Bestand, den du auch selbst
betreiben kannst."**

## 1. Rechtsgrundlage, Art. 14, Betroffenenrechte — der Audit-Trail zu Kontaktdaten

Joyces Kommentar: Dealfront arbeitet ebenfalls mit natuerlichen Personen;
AVA braucht einen rechtssicheren Audit-Trail.

**Was schon da ist:** Jede Beobachtung traegt Quelle (`source`, z. B.
agent:website / search / apify:company-profile), Beleg-URL, Belegausschnitt,
Zeitpunkt, Lauf-ID, Modellstufe. Fakten haben firstSeen/lastSeen,
Beschaeftigungen verfallen nach 120 Tagen ohne Bestaetigung. Das ist
mehr Provenienz als bei den meisten Wettbewerbern — aber nicht als
Betroffenen-Auskunft abrufbar und ohne Zuordnung, WER die Daten erhoben hat.

**Massnahmen (C1):**
1. `Observation.tenantId` + `actorId` (nullable, Backfill NULL): wer hat
   wann was erhoben. Persist-Events tragen beides schon im Auth-Kontext.
2. Route `GET /v1/persons/:id/herkunft`: vollstaendiger Herkunftsnachweis
   einer Person (alle Fakten mit Quelle, Beleg, Zeitpunkt, erhebender
   Tenant) — als JSON und als druckbares PDF/Markdown. Das ist die
   Antwort auf ein Auskunftsersuchen nach Art. 15 in einer Minute, nicht
   ueber 30 Laptops.
3. Route `DELETE /v1/persons/:id` mit **Personen-Tombstone** (Zwilling des
   Company-Tombstones): Loeschung im geteilten Bestand, Sperre gegen
   Wiedererfassung ueber Namens-/Profil-Hash, Audit-Eintrag. Ausloesbar
   durch jeden Tenant, der die Person erhoben hat, und durch den Operator.
4. **Informationspflicht Art. 14 als Produktbaustein:** AVA liefert je
   Kontakt einen vorformulierten Hinweistext (Quelle, Zweck, Loeschfrist,
   Widerspruchsweg) und im Chat/CRM-Export ein Feld „Informiert am".
   Vorlage fuer das Verarbeitungsverzeichnis (Art. 30) als Dokument in
   `docs/compliance/` mit den Datenklassen aus Abschnitt 0.
5. **Aufbewahrung sichtbar und einstellbar:** Personen ohne Bestaetigung
   seit N Tagen (Default 180) werden automatisch getilgt; Einstellung je
   Tenant, im Chat per Tool sichtbar (Self-Service-Prinzip).

## 2. LinkedIn: Haftung, ToS, Zweitkonto

Joyces Position: generelles Branchenrisiko, entweder so oder gar nicht.

**Massnahmen (C2), ohne Funktionsverlust:**
1. **Modul-Schalter je Tenant** (Tenant-Policy im Gateway, T4-Tabellen
   sind da): `linkedin.beobachter`, `linkedin.watchlist`, `linkedin.radar`,
   `linkedin.bildanalyse` — der Operator oder Tenant-Owner kann jedes
   Modul fuer den ganzen Tenant deaktivieren; der Desktop blendet es aus
   und der Chat-Agent bekommt die Tools nicht. Damit ist „Modul separat
   abschaltbar" keine Frage mehr, sondern eine Einstellung.
2. **Risikohinweis als Erst-Consent bleibt** (Zeitstempel je Konto) und
   wird um einen Satz zur Arbeitgeber-Verantwortung ergaenzt: „Der Einsatz
   mit einem Firmen-Login liegt in der Verantwortung des Arbeitgebers."
   Der Consent-Zeitstempel wandert in den Audit-Trail des Tenants.
3. Keine Automatisierung von Interaktionen (kein Liken, Kommentieren,
   Anschreiben) — das bleibt Produktgrenze und wird so benannt: AVA
   liest, AVA handelt nicht.

## 3. Profiling, DSFA, AI Act — Werksbesuch-Erkennung und Bildanalyse

Joyces Position: nicht „loesbar", aber alles auf souveraener Infrastruktur
betreibbar; wer das nicht anbietet, hat den Nachteil auf ewig.

**Massnahmen (C3):**
1. **DSFA-Vorlage mitliefern** (`docs/compliance/DSFA_LinkedIn.md`): Zweck,
   Datenkategorien, Risiken, Massnahmen — vorausgefuellt mit dem, was AVA
   technisch tut. Der Kunde muss sie nur pruefen und unterschreiben.
2. **Bildanalyse standardmaessig lokal-only:** Bilder gehen nur an ein
   lokales Vision-Modell; Cloud-Vision ist eine explizite Einstellung mit
   Hinweis („Bilder von Personen-Posts verlassen den Rechner"). Ohne
   lokales Vision-Modell bleibt die Bildanalyse aus.
3. **Zweckbindung sichtbar:** Signale sind Gespraechsanlaesse, keine
   Bewertung der Person; Speicherung der Rohposts entfaellt, nur der
   Anlass (Typ, Datum, Firma, Link) bleibt.
4. **Souveraene Infrastruktur als Produktoption** — Abschnitt 5.

## 4. Cloud-Modelle vs. Lokal-Argument

Ehrliche Aussage: Mit einem Cloud-Anbieter gehen Firmen- und Personentexte
an dessen API (AVV/TIA beim Kunden). Massnahmen (C4):
1. **Datenfluss-Anzeige je Anbieter** in Einstellungen → Modelle: „Dieser
   Anbieter erhaelt: Website-Texte, Registerauszuege, LinkedIn-Post-Texte,
   [Bilder]". Ein Satz, kein Kleingedrucktes.
2. **Modell-Klassen je Datenklasse** (Tenant-Policy): Der Tenant kann
   festlegen, dass Personendaten (LinkedIn-Texte, Kontaktextraktion) nur
   an lokale oder EU-gehostete Modelle gehen, waehrend Registerauszuege
   Cloud duerfen. Technisch ein Filter im Provider-Routing (getLLM mit
   Datenklasse), im Chat einsehbar.
3. EU-Anbieter im Katalog benennen (Mistral EU, Azure OpenAI EU-Region
   als Endpunkt-Variante) — die OpenAI-kompatiblen Endpunkte (v0.1.503)
   machen das zu Konfiguration statt Code.

## 5. Souveraener Betrieb: Self-Hosted Substrat

Joyces Position: theoretisch alles bei Hetzner oder On-Prem betreibbar —
das muss real und sichtbar sein.

**Ist:** `infra/docker-compose.dev.yml` bringt Postgres, RabbitMQ, Keycloak;
Dockerfiles fuer db-gateway und master-data existieren; Producer laufen
ohnehin auf Nutzer-Rechnern; einzige Operator-Abhaengigkeit ist der
ValueSerp-Proxy (Operator-Key).

**Massnahmen (C5):**
1. `infra/docker-compose.sovereign.yml`: Gateway, master-data, Keycloak,
   RabbitMQ, Postgres, optional Ollama-Server (GPU-Host fuer alle Clients)
   — ein Befehl auf einem Hetzner-/On-Prem-Host. ValueSerp-Key als
   Kundenkonfiguration (eigener Key) statt Operator-Key.
2. Desktop: Gateway-URL/Auth-Issuer als Konfiguration (heute `config.ts`
   mit prod/dev), ueber Enterprise-Rollout setzbar (MDM-Profil oder
   `ava.config.json` neben der App), kein Rebuild.
3. Enterprise-Kanal: signierte Pakete auch per MSI/PKG fuer Intune/Jamf
   statt nur GitHub Releases; Hinweis fuer EDR-Freigaben (der
   LinkedIn-Browser ist ein separates Electron-Fenster, kein Fremdprozess).
4. Aussage fuer die Website: „Betrieb wahlweise als Service (Frankfurt,
   Fly.io) oder vollstaendig in deiner Infrastruktur (Docker, On-Prem
   oder EU-Hoster). Modelle wahlweise lokal, auf deinem Server oder in
   der Cloud."

## 6. Telemetrie- und Kontingent-Claim schaerfen

Massnahmen (C6):
1. Website/Doku: die Tabelle aus Abschnitt 0 als „Was verlaesst deinen
   Rechner?" veroeffentlichen. Kontingent = serverseitige Zaehlung der
   Firmen je Monat (Firmen-ID, Zeitpunkt), keine Inhalte, kein Tracking.
2. In der App: Einstellungen → Datenschutz zeigt dieselbe Tabelle live
   (welche Endpunkte, letzte Uebertragung), plus „Alle lokalen Daten
   dieses Kontos loeschen" (existiert als Werksreset) und „Meinen Anteil
   am geteilten Bestand anzeigen" (Route aus C1.2 je Tenant).

## 7. Enterprise: Skalierung, Governance, Integrationen

- **Gemeinsamer Wissensbestand:** existiert bereits serverseitig (geteilte
  Firmen-/Personenfakten); mit T6 (Tenant-Sicht auf Transaktionen) sieht
  Vertriebler B, was A recherchiert hat. Kein Umweg ueber HubSpot noetig.
- **Verfuegbarkeit:** Scans laufen auf dem Laptop — als Enterprise-Option
  ein „AVA-Worker" (headless Producer-Set auf dem Kunden-Server), der
  Beobachtung und Radar fuer den Tenant uebernimmt. Technisch: die
  Producer sind schon Subprozesse mit AMQP-Queues je Nutzer; ein Worker
  ist derselbe Code mit Tenant-Queue. Aufwand mittel.
- **Mitarbeiterwechsel:** Recherche liegt im geteilten Bestand, Chats/ICP
  im Konto-Space — Operator kann Konten in den Tenant uebertragen;
  Dokumentation dazu.
- **M365-CRM (Dynamics 365 Sales) und ERP:** Anbindung ueber den
  bestehenden CRM-Adapter-Pfad (HubSpot heute); Dynamics als naechster
  Adapter, ERP-Anbindungen (SAP/DATEV/…) im Enterprise-Plan als
  Projektleistung mit den AVA-Entwicklern — das gehoert auf die Website.
- **Was AVA nicht ist:** kein Purview, kein M365-Copilot-Ersatz. AVA ist
  Ingestion + Anlass-Erkennung; Governance kommt vom Kunden-Stack. Das
  ehrlich zu sagen ist glaubwuerdiger als das Gegenteil.

## 8. Reihenfolge und Aufwand

| Stufe | Inhalt | Aufwand |
|---|---|---|
| C6 | Datenfluss-Tabelle (Website + Einstellungen → Datenschutz), Claim schaerfen | 1 Tag |
| C2 | Tenant-Policy fuer LinkedIn-Module (Gateway + Desktop + Chat-Tools), Consent-Satz | 2 Tage + Deploy |
| C1 | Observation tenantId/actorId, Herkunftsnachweis je Person, Personen-Tombstone, Art.-14-Baustein, Aufbewahrung je Tenant | 3–4 Tage + Deploy |
| C3 | DSFA-Vorlage, Bildanalyse lokal-only Default, Rohpost-Verzicht | 1–2 Tage |
| C4 | Datenfluss je Anbieter, Modell-Klassen je Datenklasse, EU-Endpunkte | 2 Tage |
| C5 | compose.sovereign, konfigurierbare Gateway-URL, MSI/PKG-Kanal | 3–5 Tage |
| Enterprise-Worker, Dynamics-Adapter, T6 | eigene Konzepte | spaeter |

## 9. Entscheidungen (2026-09-03, Joyce)
1. **Personen-Loeschung global.** Ein Loeschwunsch tilgt die Person im
   zentralen Bestand fuer alle Tenants; Tombstone sperrt die
   Wiedererfassung (Namens-/Profil-Hash).
2. **Aufbewahrung „unbestaetigt":** gemeint ist *nicht erneut beobachtet*.
   Jede Person/Beschaeftigung traegt `lastSeen` = letzter Lauf, der sie auf
   einer Quelle wiedergefunden hat. Wird eine Person N Tage lang von
   keinem Lauf (keines Tenants) mehr gesehen, gilt sie als veraltet und
   wird getilgt. Der Mechanismus existiert fuer Beschaeftigungen bereits
   (TTL 120 Tage, `emit-removals-by-ttl`); die Person selbst bleibt heute
   liegen. Vorschlag: Person 180 Tage nach letzter Beobachtung tilgen,
   Beschaeftigung weiterhin 120 Tage. Einstellbar je Tenant, im Chat sichtbar.
3. **Bildanalyse lokal-only ist bereits Default** (`imageAnalysis: "local"`,
   `imageAnalysisCloudOptIn: false`). C3.2 reduziert sich auf den Hinweistext
   beim Cloud-Opt-in („Bilder aus Personen-Posts verlassen den Rechner").
4. **Enterprise-Plan ohne feste Zusagen:** Aussage ist „individuelle
   Konnektoren (ERP, CRM, Datenquellen) sind umsetzbar, Umfang und Preis
   nach Absprache". Kein Preis, keine Feature-Liste.
