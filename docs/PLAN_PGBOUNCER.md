# Plan: Verbindungsbudget der geteilten Postgres (PgBouncer als Trichter)

Stand 2026-09-15. Anlass: wiederkehrende Fehler „remaining connection slots
are reserved for roles with the SUPERUSER attribute“ (SQLSTATE 53300) im
Gateway und in master-data; am 15.09. um 09:02 und erneut ab 09:18 UTC war
der Cluster für alle Clients voll, auch für den Betreiber-Proxy.

## 1. Befunde

**Cluster:** Fly Managed Postgres `kyzl60xw8qlrpj9g` („ava-db“, fra, eine
Replika, 10 GB), `max_connections = 100`, davon 3 für Superuser reserviert.
Rolle `fly-user` (schema_admin) für alle Dienste; keine Superuser-Rolle für
uns, daher keine Sicht auf Status oder Adresse fremder Sitzungen und kein
`pg_terminate_backend`.

**Alle Dienste gehen bereits durch einen PgBouncer des Anbieters:** Host
in `DATABASE_URL` und `DIRECT_URL` ist `pgbouncer.<cluster>.flympg.net:5432`
(Rolle `_crunchypgbouncer` sichtbar). Dessen Konfiguration (Pool-Modus,
`default_pool_size`, `server_idle_timeout`, `max_db_connections`) ist für
uns nicht einsehbar (Admin-Datenbank `pgbouncer` nicht erreichbar) und
nicht einstellbar. Die Zahl in `pg_stat_activity` ist die Zahl der
**Server-Verbindungen des PgBouncers** zu Postgres, nicht die Zahl unserer
Client-Verbindungen.

**Messung 15.09., 10:0x UTC (47 von 100):**

| Datenbank / Herkunft | Verbindungen |
|---|---|
| pattern_paradise_prod (anderes Produkt, nicht im Fly-Konto von AVA sichtbar) | 12 |
| ava_master_data | 11 |
| ava_db_gateway | 11 |
| keycloak | 2 |
| Cluster-intern (pgbouncer, Replikation, Patroni, Monitoring) | 10 |
| Betreiber-Proxy (psql) | 1 |

Nach den Deploys um 10:4x: 48, Gateway 13, master-data 12; kurz darauf
voll. Die gestoppte zweite master-data-Maschine und die
Release-Maschine der Migration hinterlassen Server-Verbindungen, die der
PgBouncer erst mit seinem Leerlauf-Timeout abbaut.

**Warum es voll wird:** Der Cluster hat **zehn Datenbanken** (Gateway,
master-data, sechs Producer-Datenbanken, pattern_paradise, keycloak). Ein
PgBouncer hält je (Datenbank, Rolle) einen eigenen Server-Pool. Im
Session-Modus (Verdacht; Transaktionsmodus wäre mit Prisma nicht ohne
Weiteres verträglich) hält jede Client-Verbindung eine Server-Verbindung,
solange sie lebt. Unsere Clients halten viele: Gateway 7 pg-Pools × 2,
Discovery 2, zwei Prisma-Clients (Audit, Kontakte); master-data ein
Prisma-Client je Maschine; dazu Deploy-Überlappungen (alte Maschine, neue
Maschine, Release-Maschine) und pattern_paradise mit 12 bis 13. Idle-
Verbindungen bleiben im PgBouncer erhalten, bis sein Timeout greift.

**Sofortmaßnahme (15.09., umgesetzt):** `connection_limit=2&pool_timeout=20`
an `DATABASE_URL` von ava-db-gateway und ava-master-data (Prisma); die
pg-Pools standen bereits auf `max 2`. Wirkt nur auf die Client-Seite.

## 2. Ziel

Die Zahl der Server-Verbindungen zu Postgres ist **fest gedeckelt und
unabhängig von Deploys, Maschinenzahl und Lastspitzen**. Richtwert für
AVA: höchstens 40 Server-Verbindungen, damit pattern_paradise (bis 15),
Keycloak (bis 15) und Cluster-Interna (10) darunter Platz haben.

## 3. Optionen

| Option | Was | Bewertung |
|---|---|---|
| A | Fly-Support um PgBouncer-Einstellungen bitten: `pool_mode = transaction` für unsere Datenbanken, `default_pool_size` 4, `server_idle_timeout` 60 s, `max_db_connections` je Datenbank | Kein eigener Betrieb; unklar, ob Fly je Cluster konfiguriert; Prisma im Transaktionsmodus verlangt `pgbouncer=true` in der URL (keine Prepared Statements), pg-Pools sind unkritisch |
| B | **Eigener PgBouncer als Fly-App** (`ava-pgbouncer`, fra, 256 MB) im **Transaktionsmodus** vor dem Anbieter-PgBouncer; alle AVA-Dienste zeigen auf ihn | Volle Kontrolle: `default_pool_size` 4 je Datenbank → 8 Datenbanken × 4 = 32 Server-Verbindungen, `max_client_conn` 500, `server_idle_timeout` 60 s. Prisma braucht `?pgbouncer=true`, Migrationen weiterhin über `DIRECT_URL` (Anbieter-PgBouncer). Ein zusätzlicher Hop (unter 1 ms im selben Rechenzentrum) |
| C | Datenbanken konsolidieren: die sechs Producer-Datenbanken und die Gateway-Datenbank als **Schemas einer Datenbank** | Halbiert die Pools dauerhaft; größerer Umbau (Prisma-Schemas je Producer, Migrationen, Persist-Pfade); mittelfristig |
| D | pattern_paradise auf einen eigenen Cluster | Entfernt 12 bis 15 Verbindungen und einen fremden Lastfaktor; Entscheidung des Betreibers |

Empfehlung: **B sofort, D zeitnah, C als Folgeprojekt.** A parallel
anfragen (kostet nur eine Support-Anfrage), ersetzt B aber nicht, weil
die Kontrolle beim Anbieter bliebe.

## 4. Umsetzung Option B

1. **App `ava-pgbouncer`** (Docker `edoburu/pgbouncer` oder `bitnami/pgbouncer`,
   fra, 1 Maschine shared-cpu-1x 256 MB, Fly-interne Adresse
   `ava-pgbouncer.internal:6432`, nur im privaten Netz, kein öffentlicher
   Port). Konfiguration als Fly-Secrets: `DATABASE_HOST =
   pgbouncer.<cluster>.flympg.net`, `DATABASE_USER/PASSWORD = fly-user`,
   `pool_mode = transaction`, `default_pool_size = 4`, `min_pool_size = 0`,
   `reserve_pool_size = 2`, `max_client_conn = 500`, `server_idle_timeout =
   60`, `server_lifetime = 1800`, `ignore_startup_parameters =
   extra_float_digits,search_path`, Datenbanken: `ava_db_gateway`,
   `ava_master_data`, `ava_company_profile`, `ava_structured_content`,
   `ava_company_publication`, `ava_company_evaluation`, `ava_company_contact`,
   `ava_website`. Health: `SHOW POOLS` über einen kleinen Sidecar-Check oder
   TCP-Check auf 6432.
2. **Gateway:** `DATABASE_URL` auf `postgres://fly-user:…@ava-pgbouncer.internal:6432/ava_db_gateway?pgbouncer=true&connection_limit=4`;
   `DIRECT_URL` bleibt auf dem Anbieter-PgBouncer (Migrationen). Die
   abgeleiteten Producer-URLs (`db-urls.ts`) übernehmen Host und Parameter
   automatisch. pg-Pools: `max 2` bleibt; `idleTimeoutMillis` 5 s bleibt.
3. **master-data:** `DATABASE_URL` analog mit `pgbouncer=true`,
   `DIRECT_URL` unverändert. Prisma-Clients: keine Prepared Statements im
   Transaktionsmodus; `pgbouncer=true` schaltet das um.
4. **Keycloak:** bleibt zunächst am Anbieter-PgBouncer (JDBC, eigener Pool
   `KC_DB_POOL_MAX_SIZE=15`); später ebenfalls umhängen (Session-Modus
   nötig, eigener Pool im Bouncer).
5. **Reihenfolge:** Bouncer deployen → master-data umhängen (weniger
   Pfade) → einen Tag beobachten (`pg_stat_activity` je Datenbank, Fehler
   53300 in den Logs) → Gateway umhängen → Keycloak.
6. **Rollback:** Secrets auf den Anbieter-Host zurücksetzen, Deploy. Kein
   Datenpfad ändert sich.

Risiken: Transaktionsmodus verbietet sitzungsgebundene Dinge
(`SET`, `LISTEN/NOTIFY`, Advisory Locks über Transaktionen hinaus,
Prepared Statements). Im Gateway ist `FOR UPDATE SKIP LOCKED` innerhalb
einer Transaktion unkritisch; `SET` oder `LISTEN` sind im Code zu prüfen
(Grep vor dem Umhängen). Prisma mit `pgbouncer=true` ist der dokumentierte
Weg.

## 4a. Stand der Umsetzung (2026-09-15)

- `infra/pgbouncer` (Alpine, pgbouncer, Konfiguration aus Secrets), App
  `ava-pgbouncer` in fra, TCP-Check auf 6432, erreichbar als
  `ava-pgbouncer.internal:6432`. Transaktionsmodus, `default_pool_size 4`,
  `max_db_connections 6`, `server_idle_timeout 60`, Wildcard-Datenbanken.
- master-data umgehängt (10:2x UTC), Gateway umgehängt (10:3x UTC), jeweils
  `DATABASE_URL` mit `pgbouncer=true&connection_limit=4&pool_timeout=20`;
  `DIRECT_URL` (Migrationen) bleibt beim Anbieter-PgBouncer. Keycloak noch
  nicht.
- Befund bei der Wiederherstellung um 09:22 UTC (104 Verbindungen): je
  Producer-Datenbank 12 bis 13 Server-Verbindungen im Anbieter-PgBouncer,
  obwohl die Gateway-Pools nur 2 halten. Der Anbieter-Bouncer sammelt also
  Leerlauf-Verbindungen je Datenbank an; genau das deckelt der eigene
  Bouncer.

**Nachtrag 10:4x UTC, Ursache gefunden:** Die lokalen Producer auf den
Nutzerrechnern verbinden sich direkt mit den sechs Producer-Datenbanken
(Handout `GET /v1/local-credentials`, Prisma `connection_limit=2` je
Producer). Bei 4 bis 6 Nutzern sind das die 12 bis 13 Server-Verbindungen
je Producer-Datenbank, zusammen rund 60 von 100. Umgesetzt:

- Bouncer öffentlich: dedizierte IPv4 (2 US-Dollar je Monat) plus IPv6,
  rohes TCP auf 5432, der Bouncer beendet TLS selbst mit einem
  selbstsignierten Zertifikat je Start (`client_tls_sslmode = allow`,
  intern bleibt Klartext). Ein Fly-TLS-Handler geht nicht, weil das
  Postgres-Protokoll TLS erst nach dem SSLRequest verhandelt.
- Handout an die Producer: `PRODUCER_DATABASE_URL_PUBLIC` =
  `ava-pgbouncer.fly.dev:5432` mit `sslmode=require&sslaccept=accept_invalid_certs&pgbouncer=true`,
  `connection_limit=1`. Wirkt bei jedem Producer-Neustart (Handout wird
  beim Spawn geholt). Geprüft mit einem Prisma-Client von außen.
- Handout-Fehler nach dem ersten Umhängen (interne Adresse verteilt) war
  15 Minuten wirksam und ist behoben (Gateway v150).
- Erwartung: Producer-Datenbanken fallen von 12 bis 13 auf höchstens 6
  Server-Verbindungen je Datenbank (Pool 4 plus Reserve 2), sobald die
  Nutzer ihre App neu gestartet haben und der Anbieter-Bouncer die alten
  Leerlaufverbindungen abgebaut hat.

## 5. Beobachtung und Betrieb

- Wöchentlich (oder per Cron im Gateway als Log-Zeile): `SELECT datname,
  count(*) FROM pg_stat_activity GROUP BY 1`; Schwelle 70 → Warnung.
- Bei Deploys: keine zwei Maschinen je Dienst dauerhaft (`min_machines_running
  = 1`, `ha = false` für master-data prüfen), Release-Maschine beendet sich
  selbst.
- Betreiber-Proxy-Sitzungen (`fly mpg proxy`, Notebooks) nach Gebrauch
  schließen; jede zählt.

## 6. Aufwand

Option B: ein halber Tag (App, Secrets, zwei Umhängungen, Beobachtung).
Option C: zwei bis drei Tage. Option D: Entscheidung plus ein Umzug des
anderen Produkts, außerhalb von AVA.

## Nachtrag 2026-09-16 (Direktweg zum Primary)

- `ava-pgbouncer` verbindet sich jetzt direkt mit dem Postgres-Primary
  (`DB_HOST` = Direct IP des Clusters, `SERVER_TLS_SSLMODE=disable`; der
  Primary bricht den TLS-Handshake ab, und pgbouncer fällt bei `prefer`
  nicht auf Klartext zurück, was beim ersten Versuch einen 20-Minuten-Ausfall
  verursacht hat). Klartext gilt nur im privaten Fly-Netz (WireGuard).
- Grund: der Anbieter-Bouncer verwendet die von uns geschlossenen
  Serververbindungen nicht wieder und hielt je Datenbank 10 bis 13
  Leerlaufverbindungen; der Cluster stand mehrfach bei 94 bis 100 von 100
  (App wurde langsam, Graph lud nicht).
- Befund danach: unsere Cloud-Dienste halten zusammen 4 Serververbindungen.
  Die verbleibenden rund 80 Sitzungen stammen von Nutzer-Desktops, deren
  Producer noch die alte direkte Handout-Adresse nutzen; sie verschwinden mit
  dem nächsten Producer-Neustart (Update auf v0.1.672).
- Pattern Paradise (`cbj-backend-wandering-night-1250`, gleiche Datenbank)
  läuft ebenfalls über `ava-pgbouncer` (`pgbouncer=true&connection_limit=2`).
- Deploys mit zwei Maschinen je Dienst kollidieren mit `max_db_connections = 6`
  (2 × Prisma 4); master-data hat deshalb eine Neustartschleife erlebt. Offen:
  `MAX_DB_CONNECTIONS` 8 oder Prisma-Limit 2.