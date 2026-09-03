# Plan: Tenant-Konzept und Multi-Account auf einem Geraet

Stand 2026-09-03. Status: T1 (v0.1.527), T2 (v0.1.528) umgesetzt; T3 Skript bereit (v0.1.529), Anwendung auf Keycloak ausstehend; T4 implementiert, Deploy ausstehend; T5–T6 offen.

## 1. Ziele

1. **Tenant im Backend definieren** und in der App anzeigen, welchem Tenant
   der angemeldete Account zugeordnet ist. Kollaboration innerhalb eines
   Tenants ist das perspektivische Ziel; ihre Form ist offen, das Konzept
   darf sie nicht verbauen.
2. **Mehrere Accounts auf demselben Geraet**, einfacher Wechsel.
3. **Lokale Daten strikt pro Account**: Die Anmeldung ist der Schluessel zu
   den lokalen Daten. Kein Account sieht die lokalen Daten eines anderen.
   Daten mehrerer Accounts liegen parallel vor.
4. Migration der heutigen lokalen Daten ist nicht Pflicht, aber erwuenscht,
   wenn sie sich sauber loesen laesst.

## 2. Ist-Zustand (erhoben am Code)

**Identitaet.** Keycloak-Realm `ava`, Client `ava-desktop`, PKCE ueber den
System-Browser. Das Access-Token traegt `sub` (User-UUID) und `scope`. Ein
`tenant_id`-Claim ist im Desktop vorgesehen (`auth.ts`), aber der Realm
liefert **keinen Tenant-Mapper**. Das Gateway faellt deshalb auf
`tenantId = sub` zurueck (Middleware `auth.ts`, dreistufige Suche
`tenant` → `tenant_id` → `sub`). **Heute gilt: Tenant = User.** Alle
tenant-gebundenen Tabellen (TenantBilling, UsageEntry, ParkedCompany,
CompanyCrmLink, ProxyAudit, ProxyQuotaOverride) sind faktisch pro User
geschluesselt, ihre Zeilen tragen die User-UUID als tenantId.

**Remote-Daten.** master-data scoped Transaktionen per `userId` aus dem
Token; das Gateway filtert Events zusaetzlich auf `tenantId`. Die
Fachdaten (Company, Person, Fact, Publication ...) sind **nicht**
tenant-partitioniert: Company-IDs sind Handelsregister-IDs, die Zuordnung
zum Nutzer laeuft ausschliesslich ueber seine Transaktionen. Das ist fuer
Kollaboration ein Vorteil (kein Kopieren von Firmenwissen), erfordert aber,
dass „meine Firmen" kuenftig „Firmen meines Tenants" heissen kann.

**Lokale Daten.** Alles liegt flach unter `userData` (`@ava/desktop`):
`agent/` (Profil, Memory, Provider-Config + verschluesselte Keys,
Alerts, ICP), `pglite/` (Mail, Audit, Usage, Scheduler, Self-Corrections,
Link-Monitor, Postgres-Gateway), `linkedin/` (Session, Watchlist, Radar),
`crm/`, `discovery/`, `research/`, `telegram/`, `mail-creds.bin`,
`producer-logs/`, `screenshots/`, `skills/`, dazu geraetweite Dinge:
`ollama-managed/`, `whisper/`, `ava-watchdog.cjs`, Updater-Zustand.
58 Stellen in 30 Dateien rufen `app.getPath("userData")` direkt auf. Alle
Store-Singletons werden **auf Modulebene** in `index.ts` konstruiert, also
vor `app.whenReady()` und vor jeder Anmeldung. Genau dieses Muster nutzt
bereits der Werksreset (`reset-store.ts`): ein Marker wird beim Boot
**vor** der Store-Konstruktion ausgewertet.

**Anmeldung.** Genau ein Refresh-Token in `userData/auth.bin`
(safeStorage). Abmelden loescht es. Ein zweiter Account ist heute nur durch
Abmelden und Neuanmelden moeglich, und er saehe dieselben lokalen Daten.

**Producer.** Laufen als Subprozesse mit `AVA_USER_ID` (per-User-AMQP-
Queues) und `AVA_TENANT_ID`; Logs und Screenshots unter `userData`.

## 3. Zielbild

```
userData/
  accounts.json                 Registry: bekannte Accounts + zuletzt aktiver
  shared/                       geraetweit: ollama-managed, whisper, updater
  accounts/<sub>/               EIN Space je Keycloak-User (sub = UUID)
    auth.bin                    Refresh-Token NUR dieses Accounts
    identity.json               sub, email, name, tenantId, tenantName (Anzeige)
    agent/ pglite/ linkedin/ crm/ discovery/ research/ telegram/
    mail-creds.bin producer-logs/ screenshots/ skills/
```

Der **Account-Space ist das `userData` der laufenden Instanz.** Beim Boot
entscheidet ein winziger Profil-Waehler, welcher Space gilt, und setzt
`app.setPath("userData", …)` **bevor** irgendein Store konstruiert wird.
Damit bleiben alle 58 Aufrufstellen unveraendert korrekt; nichts muss
einzeln umgezogen werden. Chromium-Session (Cookies, Cache) haengt am
selben Pfad und ist damit ebenfalls pro Account getrennt.

**Account-Wechsel = Relaunch.** Wechsel setzt `accounts.json.active` und
startet die App neu (wie der Werksreset). Ein Laufzeit-Wechsel ohne
Neustart ist bewusst ausgeschlossen: PGlite-Instanzen, Producer-
Subprozesse, AMQP-Queues, Telegram-Polling und der LinkedIn-Browser
haengen alle am Account; sie sauber zu tauschen ist der teuerste und
fehleranfaelligste Weg. Der Neustart dauert wenige Sekunden und ist
ehrlich.

**Tenant = eigene Entitaet im Backend**, nicht mehr `sub`. Kollaboration
wird spaeter darauf gebaut; heute reicht Anzeige plus saubere Trennung.

## 4. Backend

### 4.1 Keycloak
- Realm-Gruppen als Tenant-Traeger: Gruppe `tenant:<slug>` mit Attribut
  `tenant_id` (UUID) und `tenant_name`. Ein User gehoert genau einer
  Tenant-Gruppe an (Default: bei Registrierung eine persoenliche Gruppe
  `tenant:<sub>`, damit Einzelnutzer nahtlos bleiben).
- Protocol-Mapper im Client `ava-desktop`: `tenant_id` und `tenant_name`
  ins Access- und ID-Token. Das Desktop liest `tenant_id` schon heute.
- Pflege ueber das idempotente Realm-Skript (im README referenziert, im
  Repo aktuell nicht vorhanden; muss angelegt bzw. wiederhergestellt
  werden). Tenant-Zuordnung von Usern zunaechst per Admin-UI/Skript, spaeter
  per Einladung (Kollaborationsthema).

### 4.2 Gateway
- Neue Tabelle `Tenant` (id, name, createdAt) und `TenantMember`
  (tenantId, actorId, role, joinedAt). Rolle vorerst `owner` | `member`.
- Auth-Middleware: `tenantId` aus dem Claim; der `sub`-Fallback bleibt fuer
  Alt-Tokens, wird aber im Log als `tenant_fallback=sub` markiert und nach
  der Migration entfernt.
- `/v1/whoami` liefert zusaetzlich `tenantName`, `role`, `email`.
- **Kompatibilitaetsmigration**: fuer jede heute existierende tenantId
  (= User-UUID) einen Tenant mit derselben UUID anlegen und den User als
  `owner` eintragen. Damit bleiben TenantBilling, UsageEntry,
  ParkedCompany, CrmLink ohne Datenaenderung gueltig. Keine Umschluesselung.
- Transaktionslisten: heute `getMyTransactions` (per User). Fuer Tenant-
  Sicht spaeter ein `GET /v1/tenants/me/transactions`, das ueber
  TenantMember die userIds der Mitglieder aufloest. Nicht Teil dieser
  Stufe, aber die Tabellen machen es moeglich.

### 4.3 master-data
Unveraendert: scoped weiter per `userId`. Der Tenant-Blick entsteht im
Gateway durch Aggregation ueber Mitglieder. Das vermeidet Aenderungen am
cbj-Backend (Regel: nicht anfassen).

## 5. Desktop

### 5.1 Profil-Waehler beim Boot (`account-space.ts`)
1. `userData` (Basis) lesen, `accounts.json` laden.
2. Ist `active` gesetzt und `accounts/<active>/` vorhanden →
   `app.setPath("userData", accounts/<active>)`.
3. Sonst: „Onboarding-Space" `accounts/_pending/` verwenden. Nach der
   ersten erfolgreichen Anmeldung wird `_pending` nach `accounts/<sub>/`
   **umbenannt** (atomar, kein Kopieren) und als `active` registriert.
4. Migration (Abschnitt 6) laeuft an dieser Stelle, vor jedem Store.

### 5.2 Auth
- Refresh-Token liegt im Account-Space (`auth.bin` dort). Abmelden loescht
  nur dieses Token; der Space bleibt bestehen und ist beim naechsten Login
  desselben Accounts sofort wieder da.
- **Identitaets-Sperre**: meldet sich im aktiven Space ein anderes `sub`
  an (Nutzer waehlt im Browser einen anderen Account), akzeptiert die App
  das Token nicht fuer diesen Space, sondern registriert den neuen Account
  und wechselt per Relaunch in dessen Space. Ein Space kann nie Daten
  zweier Accounts mischen.
- `identity.json` haelt sub, email, name, tenantId, tenantName fuer die
  Anzeige ohne Netz (Kontowechsler, Header).

### 5.3 Oberflaeche
- Header/Sidebar: Avatar-Chip „Name · Tenant". Klick oeffnet den
  Kontowechsler: Liste der bekannten Accounts (aus `accounts.json`),
  „Anderes Konto hinzufuegen" (startet PKCE mit `prompt=login`, damit
  Keycloak nicht stillschweigend die bestehende SSO-Session nimmt),
  „Abmelden", „Dieses Konto vom Geraet entfernen" (loescht den Space nach
  Rueckfrage).
- Whoami-Seite zeigt Tenant-Name, Rolle, Mitglieder-Zahl (spaeter).
- Wechsel zeigt einen kurzen „AVA startet als <Name> neu"-Zustand.

### 5.4 Producer und Nebenlaeufer
- Producer-Subprozesse erben das Account-`userData` (Logs, Screenshots)
  und `AVA_USER_ID`/`AVA_TENANT_ID` aus dem aktiven Token; unveraendert.
- Watchdog-Skript und Heartbeat-Pfad bleiben geraetweit (`shared/`), da
  sie den Prozess, nicht den Account, ueberwachen.
- Ollama-Modelle (`~/.ollama`), verwaltete Ollama-Binary und Whisper
  bleiben geraetweit: gross, accountneutral, kein Datenschutzbezug.

### 5.5 Was bewusst NICHT pro Account ist
`shared/`: ollama-managed, whisper, Updater-Zustand, Watchdog. Alles
andere, insbesondere Provider-Keys und Telegram/Mail-Zugaenge, ist
Account-Daten. Wer zwei Accounts nutzt, hinterlegt seinen OpenAI-Key
zweimal. Das ist Absicht: Keys sind Zugangsdaten des Accounts.

## 6. Migration des heutigen Bestands (erwuenscht, loesbar)

Beim ersten Boot der neuen Version existiert noch kein `accounts/`.
Dann:
1. Vorhandenes `auth.bin` stillschweigend erneuern (Refresh) und `sub`
   ermitteln. Gelingt das, wird der **komplette heutige `userData`-Inhalt
   in `accounts/<sub>/` verschoben** (Rename je Eintrag, keine Kopie,
   Sekundenbruchteile), `shared/`-Kandidaten werden nach `shared/` gehoben.
2. Gelingt kein Refresh (kein oder abgelaufenes Token): Inhalt nach
   `accounts/_pending/` verschieben; bei der naechsten Anmeldung wird er
   dem dann angemeldeten `sub` zugeordnet. Damit gehen Daten auch im
   Offline-Fall nicht verloren. Meldet sich ein anderer Nutzer an, wird
   `_pending` diesem Account zugeordnet; hier ist die Abfrage „Vorhandene
   lokale Daten diesem Konto zuordnen oder verwerfen?" vorgesehen.
3. Ein einmaliger Marker `migrated-to-accounts` verhindert Wiederholung.
Ergebnis: Der heutige Nutzer sieht nach dem Update exakt seine Daten,
nur an neuem Ort. Kein Datenverlust, kein Import.

## 7. Risiken und Gegenmassnahmen
- **`app.setPath` vor Modul-Stores**: Der Waehler muss die erste Zeile
  nach dem Electron-Import sein. Ein Test-Skript prueft, dass kein Store
  `userData` vor dem Waehler liest (Grep ueber Import-Reihenfolge).
- **Verschluesselte Dateien** (auth.bin, Keys, mail-creds) sind mit
  safeStorage an das OS-Konto gebunden, nicht an den Pfad; Verschieben
  ist sicher.
- **PGlite-Verzeichnisse** duerfen nur bei geschlossener App bewegt
  werden; die Migration laeuft ausschliesslich beim Boot vor jedem Open.
- **Keycloak-SSO-Cookie**: ohne `prompt=login` wuerde „anderes Konto"
  denselben User zurueckliefern. Pflicht im Wechsler.
- **Producer-Queues** sind per User; beim Relaunch startet der Supervisor
  ohnehin neu. Kein Queue-Leak zwischen Accounts.
- **Tenant-Fallback auf `sub`** bleibt bis zur Migration aller Nutzer;
  danach hart entfernen, sonst bleibt „Tenant = User" unbemerkt bestehen.

## 8. Umsetzungsstufen

| Stufe | Inhalt | Umfang |
|---|---|---|
| T1 ✅ v0.1.527 | Desktop: Account-Space-Waehler (`account-space.ts`), Registry, Migration des Bestands per Rename, Relaunch-Wechsel, `identity.json`, E-Mail/Name im Auth-Status, IPC `accounts:*` | erledigt |
| T2 ✅ v0.1.528 | Desktop: Kontowechsler in der Topbar (Chip Name · Tenant, Menue mit bekannten Konten, Wechsel/Hinzufuegen per Neustart, Konto vom Geraet entfernen), Identitaets-Sperre (T1), `prompt=login` nach "Anderes Konto" | erledigt |
| T3 ◐ v0.1.529 | `scripts/keycloak-tenants.mjs` (Plan/Apply, idempotent): Mapper `tenant_id`/`tenant_name` am Client, persoenliche Gruppen `tenant:<sub>` je User; Desktop liest `tenant_name`. **Anwendung auf Keycloak: Operator mit Admin-Zugang, erst Plan, dann `--apply`.** | Skript fertig |
| T4 ◐ | Gateway: Migration `20260903_tenants` (Tenant/TenantMember + Kompat-Inserts aus allen tenantId-Quellen, Owner = gleichnamiger User), `lib/tenants.ts` (Upsert nur in /whoami), `/whoami` liefert tenantName/role/memberCount/email/tenantSource, Auth-Middleware loggt `tenant_fallback=sub` einmal je User. Getestet in PGlite (13/13 Migrationen, Idempotenz, Cascade). **Deploy: mit Go.** | implementiert |
| T5 | Desktop: Tenant-Anzeige (Chip, Whoami), Chat-Tool `account_info` (Self-Service-Prinzip) | 0,5 Tag |
| T6 | Vorbereitung Kollaboration: `GET /v1/tenants/me/transactions`, „Firmen meines Tenants" in der Firmenuebersicht als Filter | spaeter, eigenes Konzept |

Reihenfolge: T1 → T2 zuerst (lokale Trennung ist die Sicherheitsanforderung
und unabhaengig vom Backend), dann T3 → T4 → T5.

## 9. Entscheidungen (2026-09-03, Joyce)
1. **Genau ein Tenant je User.** Kein Tenant-Umschalter, lokal
   `accounts/<sub>/` ohne weitere Tenant-Ebene.
2. **Tenants und Mitglieder werden vorerst manuell vom Operator direkt in
   der DB gepflegt.** Keine Einladungs-UI in dieser Stufe. Die Gateway-
   Tabellen Tenant/TenantMember sind dafuer ausreichend; die Keycloak-
   Gruppe liefert nur den Claim.
3. **Nicht zugeordneter Altbestand (`_pending`) wird bei fremdem
   Erst-Login verworfen**, ohne Rueckfrage. Die Migration des eigenen
   Bestands (Abschnitt 6, Schritt 1) bleibt bestehen.
4. **Provider-Keys strikt je Account** (OpenAI, Anthropic & Co. unter
   `agent/`, Apify unter `linkedin/`). Geraeteweit geteilt werden NUR
   lokale Modelle: Ollama (`shared/ollama-managed`, Modelle in ~/.ollama)
   und Whisper (`shared/whisper`).
