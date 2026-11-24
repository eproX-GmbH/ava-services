# Staging/UAT auf Produktionsdaten

Stand: 2026-11-22 · Auftrag Joyce: „kompletten Registrierungsflow mit Test-Stripe-Zahlung durchtesten,
getrennte Staging-Releases für Patrick, Henning und mich, Production nur nach expliziter Freigabe“.
Joyce steuert als Betreiberin, welche Konten Staging bekommen. Staging arbeitet mit den
Produktionsdaten, ist also keine abgekapselte zweite Welt.

## 1. Ziel und Abnahme

| # | Muss | Abnahme |
|---|---|---|
| A1 | Registrierung bis zum laufenden AVA-Server mit Stripe-**Testzahlung** | Neue Test-Adresse registriert sich, kauft mit Karte 4242…, bekommt einen Server, sieht überall „Staging“ |
| A2 | Eigene Staging-Releases (Desktop, Server-Image, Gateway, App, Konsole, Website) | Kandidat v0.1.N landet nur bei Staging-Konten; Prod-Konten sehen ihn nie |
| A3 | Produktion nur nach Freigabe | Ein Knopf „Für Produktion freigeben“ in der Konsole; ohne ihn ändert sich in Prod nichts |
| A4 | Joyce steuert die Konten | Konsole → Betreiber → Staging: Konten hinzufügen/entfernen, Test-Adressen-Muster pflegen |
| A5 | Kennzeichnung | Desktop-Kopfzeile oben rechts „Staging“, ebenso App, Konsole, Website im Staging |
| A6 | Kunden-Server | Nur Server von Staging-Konten bekommen Kandidaten; alle anderen nur freigegebene Versionen |

## 2. Grundidee: Kanal statt Umgebung

Eine Datenwelt, zwei Code-Stände. Drei Begriffe tragen alles:

- **Kanal je Konto** (`prod` | `staging`): bestimmt, welcher Code-Stand ein Konto bedient: Gateway,
  Desktop-Version, Server-Image, Web-Apps. Joyce pflegt die Liste.
- **Zahlungsmodus je Organisation** (`live` | `test`): bestimmt, gegen welches Stripe gebucht wird.
  Test gibt es nur für Organisationen, die ein Staging-Testkonto anlegt (sonst wäre AVA mit der
  Testkarte gratis). Eine Organisation mit Live-Kunde oder Live-Abo wird nie auf Test gestellt.
- **Release-Kandidat** vs. **freigegebene Version**: Jeder Tag v0.1.N ist zuerst Kandidat (nur
  Staging). Erst Joyces Freigabe macht ihn zur Prod-Version, ohne Neubau: Was getestet wurde, geht raus.

## 3. Architektur-Optionen

| Option | Kern | Bewertung |
|---|---|---|
| A: Schalter im Prod-Code | Neuer Code steckt hinter Konto-Schaltern im laufenden Prod-Gateway | Jede Gateway-Änderung bräuchte Schalterlogik; ein Fehler trifft trotzdem Prod. Verworfen |
| B: Getrennte Umgebung | Eigene Datenbanken, eigenes Keycloak, eigene Producer | Viel Betrieb und Kosten, leere Daten, nicht gewünscht. Verworfen |
| **C: Staging-Gateway auf Prod-Daten, Routing je Konto** | Zweite Gateway-App mit dem Kandidaten-Code, gleiche Datenbanken; das Prod-Gateway leitet alle Anfragen von Staging-Konten dorthin weiter | **Gewählt** |

Warum C trägt: Desktop, Kunden-Server, Claude/ChatGPT-Verbindungen und Telegram-Wege kennen nur
die Prod-Adresse. Das Relais (Verbindungen der AVAs) lebt im Arbeitsspeicher **eines**
Gateway-Prozesses. Nur wenn **jede** Anfrage eines Kontos beim selben Gateway landet, finden App,
Claude und Desktop dieselbe AVA. Das Routing nach Konto im Prod-Gateway garantiert das, ohne dass
ein Client seine Adresse ändern muss.

Fly-Replay (wie beim Instanz-Router) scheidet als alleiniger Weg aus: Fly spielt nur Anfragen bis
1 MB neu ab (Dateien im Chat, Importe), WebSocket-Verhalten ist nicht dokumentiert. Deshalb leitet
das Prod-Gateway selbst weiter (Streaming für HTTP, Socket-Durchreichung für WebSocket) über das
private Fly-Netz (`ava-db-gateway-staging.internal:8080`, beide Apps in der Org `personal`).

```
Desktop / Kunden-Server / Claude / ChatGPT ──► ava-db-gateway (Prod)
                                                │  Konto im Kanal staging?
                                                ├─ nein → bedient selbst
                                                └─ ja ──► ava-db-gateway-staging (Kandidat)
app-staging / konsole-staging / website-staging ─────────► ava-db-gateway-staging (direkt)
                  beide ──► dieselben Datenbanken, dasselbe Keycloak, dieselben Producer
```

## 4. Bausteine

### 4.1 Kanal-Zugang (Datenmodell, Konsole)

- Tabelle `KanalZugang` (actorId PK, kanal, testZahlung bool, email, notiz, von, createdAt).
  Fehlt ein Eintrag, gilt `prod`.
- Tabelle `TestAdressMuster` (muster, notiz, von): z. B. `joyce+*@quikk.de`. Wer sich mit einer
  passenden Adresse registriert, bekommt beim ersten Kontakt mit dem Gateway automatisch
  `staging` + `testZahlung`, und seine persönliche Organisation entsteht im Zahlungsmodus `test`.
  Ohne Muster gibt es keine Testzahlung.
- Spalte `TenantBilling.stripeModus` (`live` Standard | `test`).
- Gateway hält den Kanal je Konto im Speicher (Neuladen alle 30 s und sofort bei Änderung) und
  liefert ihn in `GET /v1/tenants/me/...` bzw. `GET /v1/kanal` an die Clients.
- Betreiber-Routen `GET/PUT/DELETE /v1/betreiber/staging/konten`, `…/muster`, `GET /v1/betreiber/releases`,
  `POST /v1/betreiber/releases/{version}/freigeben|verwerfen`.
- Konsole (admin.ava.bi, nur Betreiber): Seite **Staging** mit Konten (per E-Mail hinzufügen),
  Test-Adressen-Mustern, Release-Kandidat mit Komponenten und Testständen, Knopf **Für Produktion
  freigeben**, Prod-Version, Verteilung (welche Konten/Server auf welcher Version).

### 4.2 Staging-Gateway

- Fly-App `ava-db-gateway-staging` in derselben Org, gleiche Secrets wie Prod (Datenbanken,
  Keycloak, Mailgun) plus `GATEWAY_ROLLE=staging`, Stripe-Testschlüssel, kleinere Pools.
- **Rollen statt Doppelarbeit:** Mit `GATEWAY_ROLLE=staging` startet das Gateway **keine**
  globalen Jobs: Persist-Bus, Register-Cron, Verflechtungen, Personen-Tilgung, Relevanz,
  GF-Nachtrag, Stuck-Reaper und Quota-Resume bleiben im Prod-Gateway. Konto- und
  organisationsbezogene Jobs laufen geteilt nach Kanal: der Cloud-Abgleicher für Server von
  Staging-Konten, Neuigkeiten-Mail, A2A-Takt, Start-Analyse. Jeder Job filtert auf seinen Kanal,
  das Prod-Gateway überspringt Staging-Konten.
- **Wächter:** Das Staging-Gateway bedient angemeldete Anfragen nur für Staging-Konten (sonst 403
  „Kein Zugang zu Staging“). Öffentliche Wege (Registrierung, Angebot, Webhooks) bleiben offen.
- **Verbindungsbudget:** Die gemeinsame Fly-MPG hat max_connections=100. Das Staging-Gateway läuft
  mit halbierten Pools (je Pool höchstens 2–3) und `min=0`.
- **Migrationen:** Das Staging-Deploy wendet Migrationen auf die Prod-Datenbank an. Deshalb gilt
  ab jetzt **erweitern, dann aufräumen**: Im Kandidaten nur additive Änderungen (neue Tabellen,
  Spalten mit Standardwert, kleine Indizes). Löschen/Umbenennen/NOT NULL erst in einem späteren
  Release, wenn kein laufender Code sie mehr nutzt. Prüfskript `scripts/migration-pruefen.mjs`
  läuft vor jedem Staging-Deploy und bricht bei DROP/RENAME/ALTER TYPE/SET NOT NULL ohne
  Freigabevermerk ab. Kein großer CREATE INDEX (OOM-Erfahrung 2026-10-07).

### 4.3 Konto-Routing im Prod-Gateway

- Middleware ganz vorn (nach dem Instanz-Router): Bearer-Token prüfen wie die Anmeldung
  (gleicher Prüfer, Ergebnis zwischengespeichert), Kanal nachschlagen, bei `staging` die Anfrage
  unverändert und gestreamt ans Staging-Gateway weiterreichen (Antwort inkl. SSE gestreamt
  zurück). Kennzeichen `x-ava-weitergeleitet: 1` gegen Schleifen.
- WebSocket (Relais `?access_token=`): im `upgrade`-Ereignis vor dem Relais prüfen und den Socket
  an das Staging-Gateway durchreichen.
- Nicht weitergeleitet: Instanz-Router, Health, Stripe-Webhooks, interne Wege (HMAC/Loopback der
  Producer, master-data), öffentliche Wege ohne Token.
- **Notschalter** `STAGING_ROUTING=0` am Prod-Gateway: Alle Konten laufen sofort wieder über Prod.
  Ist das Staging-Gateway nicht erreichbar, antwortet das Prod-Gateway mit 503 und einem klaren
  Hinweis, statt still auf Prod zurückzufallen (sonst zwei Code-Stände für ein Konto). Joyce kann
  ein Konto in der Konsole herausnehmen.

### 4.4 Stripe-Testmodus je Organisation

- `getStripe(modus)` statt `getStripe()`; Schlüssel `STRIPE_SECRET_KEY` bzw. `STRIPE_TEST_SECRET_KEY`
  in **beiden** Gateways, damit Jobs gleich welchen Kanals jede Organisation richtig abrechnen.
- Preise je Modus: `STRIPE_TEST_PRICE_PRO|MAX|ULTRA|CLOUD` (im Testmodus per Skript angelegt,
  gleiche Beträge und Steuercodes).
- Webhook im Testmodus: eigener Endpunkt `…/v1/billing/webhook/test` mit eigenem Geheimnis; das
  Ereignis wird abgewiesen, wenn `livemode` nicht zum Endpunkt passt.
- Erst-Anlage im Testmodus: wenn das anlegende Konto `testZahlung` hat (Muster oder Konsole).
  Umstellen in der Konsole nur ohne Stripe-Kunde/-Abo.
- Kosten und Statistiken: Test-Organisationen in Umsatz, Nutzer-Einsicht und Aktiven Nutzern
  gekennzeichnet und aus Summen herausgerechnet. Betreiber-Kosten (Pool-Modell, Apify, Fly-Server)
  fallen echt an; Testserver werden nach dem Test gelöscht.

### 4.5 Releases und Freigabe

| Komponente | Kandidat (Staging) | Freigabe (Prod) |
|---|---|---|
| Desktop | Tag v0.1.N baut wie heute, veröffentlicht aber als **Vorabversion** in ava-releases | Vorabversion → „latest“ (kein Neubau) |
| Update-Weg Desktop | Neuer Update-Feed im Gateway `/v1/updates/<datei>`: liefert je Konto die passende Version (Kandidat für Staging, sonst freigegeben); Rückfall GitHub-latest | Feed liefert die neue Version an alle |
| Server-Image | wie heute nach `ava-server-image` und `ava-kunden-image` | Rollout (Z7-Wellen) zieht nur freigegebene Versionen; Staging-Server sofort den Kandidaten |
| Alt-Instanzen ava-i-* | `instanzen-aktualisieren.mjs` nimmt ohne `--version` die freigegebene Version | dto. |
| Gateway | CI deployt Tag v0.1.N nach `ava-db-gateway-staging` (Migrationsprüfung vorher) | Freigabe deployt denselben Commit nach `ava-db-gateway` |
| AVA-App / Konsole / Website | Zweig `staging` → eigene Vercel-Projekte `*-staging` (Produktionszweig = staging) | Freigabe spult `main` auf den getesteten Commit vor (Vercel baut Prod) |

- Tabelle `AvaRelease` (version PK, status `kandidat|freigegeben|verworfen`, commit, komponenten
  JSON {app, admin, website}, getaggtAt, freigegebenAt, von, notiz).
- CI meldet jeden Tag als Kandidat ans Gateway (`POST /internal/releases`, HMAC).
- **Freigabe-Knopf** (Konsole, nur Betreiber, mit Bestätigung): setzt `freigegeben`, stößt den
  GitHub-Workflow `freigabe.yml` an (Desktop-Release auf latest, Prod-Gateway-Deploy, Web-Zweige
  vorspulen). Der Z7-Rollout startet von selbst. Ohne Knopf passiert in Prod nichts.
- Verworfene Kandidaten bleiben Vorabversion; der nächste Tag v0.1.N+1 ersetzt sie (Versionen
  sind billig, kein Zurückdrehen nötig).
- Hotfix: Tag + sofortige Freigabe, aber immer über denselben Knopf.

### 4.6 Kunden-Server

- Kanal der Instanz = Kanal ihres Kontos (bei jedem Abgleich frisch gelesen).
- Rollout je Kanal: Staging-Server bekommen den neuesten Kandidaten sofort (ohne Nachtfenster),
  Prod-Server nur freigegebene Versionen in den Z7-Wellen. Ein Server, der Staging verlässt,
  behält seine (neuere) Version, bis Prod gleichzieht.
- Neue Server holen die Version ihres Kanals.

### 4.7 Kennzeichnung

- Desktop: Kopfzeile oben rechts neben dem Konto ein Hinweis „Staging · v0.1.N“, solange das
  aktive Konto im Kanal staging ist (Hinweis aus dem Gateway, nicht aus dem Build).
- App, Konsole, Website im Staging: feste Leiste „Staging – Zahlungen im Testmodus“ (Build-Variable).
- Mails an Staging-Konten: Betreff mit „[Staging] “, Links auf die Staging-App.

### 4.8 Abwärtsverträglichkeit

Ein Konto kann Staging verlassen und läuft dann mit einem neueren Desktop gegen das ältere
Prod-Gateway. Regel: Clients prüfen neue Gateway-Fähigkeiten (Rückfall bei 404), neue Daten
schreibt der Kandidat so, dass der Prod-Code sie lesen kann (gemeinsame Organisationen!).

## 5. Abläufe

**Tester registriert sich:** Joyce trägt `joyce+*@quikk.de` als Muster ein → Registrierung auf
website-staging mit joyce+t1@quikk.de → Gateway erkennt das Muster beim ersten Kontakt: Kanal
staging, Testzahlung, persönliche Organisation im Testmodus → /willkommen bietet Server → Stripe-
Checkout im Testmodus (4242…) → Test-Webhook → Server mit Kandidaten-Image → Mail „[Staging]
Deine AVA läuft“ → Desktop-Download auf website-staging lädt den Kandidaten.

**Release:** Claude taggt v0.1.N (nach lokaler Prüfung) → CI: Desktop-Vorabversion, Images,
Staging-Gateway, Kandidat gemeldet; Web-Apps über Zweig `staging` → Patrick/Henning/Joyce
bekommen das Update, sehen „Staging · v0.1.N“ → Joyce klickt „Für Produktion freigeben“ →
Prod-Gateway, Desktop latest, Web-Apps, Server-Wellen.

**Notfall:** Staging kaputt → Konsole: Konto aus Staging nehmen oder `STAGING_ROUTING=0`.

## 6. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Kandidaten-Code beschädigt Prod-Daten | additive Migrationen + Prüfskript, keine globalen Jobs im Staging, kleine Testergruppe, MPG-Sicherungen |
| Doppelte Jobs/Mails | Rollen + Kanalfilter je Job, Tests dafür |
| Gratis-Nutzung über Testkarte | Testmodus nur per Muster/Konsole durch Betreiber, nie Live→Test mit Stripe-Bezug |
| Verbindungsbudget MPG | kleine Pools im Staging, Messung nach Start |
| Prod-Gateway als Weiche fällt aus | betrifft auch heute alles; Weiterleitung ist zustandslos |
| Desktop-Kandidat startet nicht | Tester lädt die Prod-Version von ava.bi; Konto aus Staging nehmen |

## 7. Stufen

| Stufe | Inhalt | Abnahme |
|---|---|---|
| ST1 | Tabellen KanalZugang, TestAdressMuster, AvaRelease, stripeModus; Betreiber-Routen; Konsole-Seite Staging; Kanal in /v1/kanal | Joyce trägt Konten/Muster ein, sieht Releases |
| ST2 | Staging-Gateway (Fly-App, Rolle, Jobfilter, Pools, Wächter), Migrationsprüfung | Staging-Gateway läuft, keine doppelten Jobs |
| ST3 | Routing im Prod-Gateway (HTTP-Streaming, WebSocket, Notschalter) | Staging-Konto: App, Desktop, Claude landen auf Staging; Prod-Konto unverändert |
| ST4 | Stripe-Testmodus (Schlüssel, Preise, Webhook, Erst-Anlage per Muster) | Testkauf legt Server an |
| ST5 | Desktop: Update-Feed im Gateway, Hinweis in der Kopfzeile | Staging-Konto bekommt Kandidaten, Prod nicht |
| ST6 | Release-Pipeline: Vorabversion, Kandidat melden, Staging-Deploy, freigabe.yml, Server-Rollout je Kanal | Tag → nur Staging; Knopf → Prod |
| ST7 | Web-Apps: Vercel-Projekte app/konsole/website-staging, Leiste, Gateway-Adresse | Registrierung im Staging mit Testzahlung |
| ST8 | Durchstich A1–A6 mit Testkonto | alle Abnahmen grün |

## 8. Festlegungen (änderbar)

- F1 Staging-Gateway nutzt dieselben Datenbanken und dasselbe Keycloak (Joyce-Vorgabe).
- F2 Routing im Prod-Gateway statt Adresswechsel in jedem Client.
- F3 Test-Adressen über Muster (Plus-Adressen) statt Freischaltung jeder einzelnen Registrierung.
- F4 Kandidat = finale Versionsnummer, Freigabe ohne Neubau.
- F5 Staging-Adressen zunächst `*.vercel.app` (eigene Subdomains unter ava.bi brauchen DNS bei
  United Domains → später, Joyce).
- F6 Staging-Server bekommen Kandidaten sofort, ohne Nachtfenster.

## 9. Was Joyce beitragen muss

- Stripe-Testschlüssel (`sk_test_…`) als Secret setzen oder freigeben, dass ich ihn im
  Dashboard abrufe; Testmodus-Webhook anlegen (kann ich per Skript).
- Keycloak: gültige Weiterleitungsadressen für die Staging-Apps (per Admin-API, falls der
  Dienstzugang darf, sonst im Keycloak-Admin).
- Optional DNS: app-staging.ava.bi, admin-staging.ava.bi, staging.ava.bi bei United Domains.

## 10. Stand der Umsetzung (2026-11-22)

Gebaut, getestet und ausgerollt (Abweichungen vom Plan in *kursiv*):

| Stufe | Stand |
|---|---|
| ST1 | Tabellen + Spalte live (Migration `20261123_staging_kanal`, additiv); Betreiber-Routen; `/v1/kanal`; Konsole → Betreiber → **Staging** (admin.ava.bi) |
| ST2 | Fly-App `ava-db-gateway-staging` (Org personal, 36 Prod-Secrets übernommen, ohne Live-Webhook-Geheimnis/Register-Worker/OpenAI-Domain). *Staging startet nur den Cloud-Abgleich für Staging-Server, alle anderen Jobs (Neuigkeiten, A2A, Start-Analyse, Abrechnung, Register …) laufen nur in Prod und bedienen alle Konten.* Progress-Bus mit eigener Queue (Ablauf 1 h) ohne Speichern. `scripts/migration-pruefen.mjs` |
| ST3 | Weiche im Prod-Gateway (HTTP gestreamt, SSE, Relais-WebSocket, 503 statt stillem Rückfall), Wächter im Staging. Tests `npm run test:staging` (12) |
| ST4 | Stripe-Modus je Organisation als Kontext; `/v1/billing/webhook/test`; Live-Cron überspringt Testmodus-Organisationen; Organisationen von Testkonten im Testmodus |
| ST5 | Update-Feed `/v1/updates/{staging\|prod}/latest*.yml`; Desktop: Kanal-Wächter, Feed-Umschaltung, Hinweis „Staging · vX“ |
| ST6 | Tags → Vorabversion (Kandidat); `staging-gateway.yml` (Tag → Staging-Gateway), `freigabe.yml` (Knopf → Latest, Prod-Gateway, Web-Zweige); Server-Rollout je Kanal; `instanzen-aktualisieren.mjs` nimmt die freigegebene Version |
| ST7 | Vercel-Projekte `ava-app-staging`, `ava-admin-staging`, `ava-website-staging` (Produktionszweig `staging`, Adressen `*-staging.vercel.app`, Leiste, Website ohne Suchmaschinen). *Keycloak: eigener öffentlicher Client `ava-web-staging` (PKCE, nur Staging-Adressen) statt der Prod-Clients.* Staging-Website registriert über den Registrierungszugang des Gateways |

Secrets/Zugänge: GitHub `FLY_STAGING_GATEWAY_TOKEN`, `FLY_GATEWAY_TOKEN` (je 1 Jahr, bis 2027-11-22).
Prod-Gateway: `STAGING_GATEWAY_URL=http://ava-db-gateway-staging.internal:8080`.

**Noch offen (Joyce):**
1. Stripe-Testschlüssel als Secret an beide Gateways (Stripe-Dashboard → Testmodus → Entwickler →
   API-Schlüssel), danach legt Claude Testprodukte, Testpreise und den Test-Webhook an.
2. GitHub-Token für den Freigabe-Knopf: fein granular, nur `eproX-GmbH/ava-services`, Recht
   „Actions: Read and write“ → `GH_FREIGABE_TOKEN` am Prod-Gateway. Optional `WEB_FREIGABE_PAT`
   (Contents: write auf ava-app/ava-admin/ava-website) als GitHub-Secret, sonst spult Claude die
   Web-Zweige bei der Freigabe von Hand vor.
3. In der Konsole: Test-Adressen eintragen (z. B. `joyce+*@quikk.de`), Patrick/Henning als Konten
   hinzufügen, Staging einschalten.

**Bedienung:** Neue Version = Tag (Kandidat) → Staging-Konten bekommen sie (Desktop über den Feed,
Server sofort, Gateway per CI, Web-Apps über den Zweig `staging`) → Konsole „Für Produktion
freigeben“. Web-Änderungen gehen zuerst auf `staging` (Vercel baut die Staging-Projekte), die
Freigabe spult `main` vor. Notschalter: Staging in der Konsole ausschalten.

### 10.1 Erster Durchlauf und Freigabe (2026-11-23)

- Durchlauf mit Testkonto, Testkauf und Server bestanden; dabei behoben: Test-Adressen gelten ab
  der ersten Anfrage (die Website kauft vor `/v1/whoami`, sonst Live-Checkout), der Wächter lädt
  frisch eingetragene Konten nach, Test-Adressen ohne Beitrittsanfrage an die eigene Firma,
  Rücksprung nach dem Checkout in die Staging-App. Die Steuerung von Staging (`/v1/betreiber/
  staging*`, `/v1/betreiber/releases*`) leitet die Weiche nie weiter (Notschalter und Freigabe
  brauchen Prod).
- 0.1.977 freigegeben. **Vorfall:** Drei Gateway-Korrekturen waren zuvor direkt auf Prod
  deployt worden; die Freigabe baute das Prod-Gateway aus dem älteren Tag und nahm sie still
  zurück (behoben durch erneuten Deploy von main).

**Regel seither:** Gateway-Code kommt nur als Kandidat nach Prod (Tag → Staging → Freigabe), nie
per Direkt-Deploy. Ein Not-Hotfix von Hand trägt `--env GATEWAY_COMMIT=$(git rev-parse HEAD)` und
bekommt sofort einen neuen Tag.

**Schutz (doppelt):**
1. Das Gateway kennt seinen Stand (`GATEWAY_COMMIT`, setzen `staging-gateway.yml` und
   `freigabe.yml`; sichtbar unter `/health` → `commit`). Vor dem Freigeben vergleicht das
   Prod-Gateway den Tag mit seinem eigenen Stand (GitHub-Vergleich); hat Prod Änderungen unter
   `services/db-gateway`, die der Tag nicht enthält, lehnt der Knopf ab (409 mit Erklärung), und
   die Version bleibt Kandidat. Ist der eigene Stand unbekannt, gilt der strengere Vergleich mit
   `main`.
2. `freigabe.yml` prüft dasselbe als ersten Schritt (`scripts/freigabe-pruefen.mjs`), alle
   weiteren Schritte hängen daran: Bei einem Treffer wird nichts ausgeliefert. Von Hand mit
   `erzwingen=ja` überspringbar (bewusstes Zurückgehen). Probelauf ohne Auslieferung:
   `gh workflow run freigabe.yml -f version=vX -f nur_pruefen=ja`.

Web-Repos: Eiliges für Prod (Rechtstexte) geht auf `main`; danach `main` in `staging` mergen,
sonst scheitert das Vorspulen der nächsten Freigabe.
