# Plan: AVA-Konsole im Web — Organisation verwalten ohne App (2026-10-10)

Anlass: Ein größeres Unternehmen beauftragt Server-Instanzen (docs/PLAN_AVA_CLOUD.md §14); eine
Installation der Desktop-App ist dort nicht möglich. Frage des Operators: Wie verwaltet der Org-Admin
Vorgaben, Schlüssel, Mitglieder und Abrechnung? Ist eine neue Next.js-App (App Router) mit Anmeldung
sinnvoll?

## 0. Ergebnis in einem Absatz

Ja: eine **Web-Konsole unter `admin.ava.bi`**, gebaut mit **Next.js (App Router) als Backend-for-Frontend**,
betrieben auf **Fly in Frankfurt** neben dem Gateway (nicht auf Vercel). Die Organisationsverwaltung
existiert fachlich schon vollständig im Gateway (`/v1/tenants/me/…`); die Desktop-Seite `Organisation.tsx`
ist nur eine Oberfläche darauf. Die Konsole übernimmt deren Bausteine über ein gemeinsames Paket, ergänzt
den **Beitritt per Web-Link**, eine **Instanzenübersicht** der Organisation, die Mitgliedersicht
**„Meine AVA“** und den Auftrag **„Instanz anfordern“**. Mitglieder brauchen sonst keine Oberfläche: Sie
arbeiten über Claude/ChatGPT (MCP), optional Telegram, und stellen Persönliches im Chat ein. Aufwand bis zur
ersten nutzbaren Fassung (A1–A4) rund **2 Wochen**, mit A5–A6 rund 3 Wochen.

## 1. Ausgangslage

### 1.1 Was der Gateway schon kann (Rechte prüft der Gateway, Rolle = `TenantMember.role`)

| Bereich | Endpunkte | Wer |
| --- | --- | --- |
| Zustand, Mitglieder, Anfragen | `GET /v1/tenants/me`, `POST /requests/{id}`, `DELETE`/`PATCH /members/{actorId}` | Admin; Rolle setzen nur Owner |
| Einladung | `POST /v1/tenants/me/invite` (liefert Token), `POST /v1/tenants/join` | Admin / jedes Konto |
| Vorgaben, Funktionen, Relevanz, KI-Vorgaben, Abo-/Apify-Erlaubnis | `PUT /v1/tenants/me/policy` | Admin |
| Organisationsschlüssel | `GET/PUT/DELETE /v1/tenants/me/providers/{kind}` | Admin; Schlüssel nie auslesbar (Stellvertreter-Weg, PLAN_ORGANISATIONEN §5) |
| Limits, Verbrauch | `GET/PUT /quota`, `GET /usage` | Admin |
| Abrechnung | `/v1/tenants/me/billing/…`, `/v1/billing/portal` | Owner/Admin |
| Geteilte Workflows, Radar-Freigaben | `/v1/tenants/me/workflows`, `/shares` | Mitglieder |

Server-Instanzen nutzen den Organisationsschlüssel ohne eigenes Zutun: Aufrufe laufen über den
Gateway-Stellvertreter, der Schlüssel verlässt den Gateway nie. Vorgaben holen die Instanzen alle
10 Minuten selbst (`checkTenantChange`, `organisation.ts`).

### 1.2 Was heute an der App hängt

`Organisation.tsx` (1 573 Zeilen, 14 Bausteine: Überblick, Anfragen, Mitglieder, Abrechnung, Vorgaben,
Modellauswahl, Schlüssel, Apify-/ChatGPT-Schalter, Limits, Verbrauch, Verlassen, Persönlich) nutzt außer
`gatewayFetch` nur fünf App-Funktionen:

| App-Funktion | Ersatz im Web |
| --- | --- |
| `org.consumePendingJoin`, `org.extractJoinToken` (Link `ava://join/<token>`) | Beitrittsseite `https://admin.ava.bi/beitreten/<token>` (A3) |
| `org.checkTenant`, `org.refreshPolicy` | Token neu holen in der Konsole; Instanzen ziehen selbst nach (10 Min.), optional Anstoß übers Relais (A4) |
| `org.onRequestsChanged` | Abfrage alle 30 s (react-query) |
| `agent.listModels` (lokaler Modellkatalog) | Gateway liefert den Katalog (`GET /v1/modelle`, A2) |

Schlüssel-Eingaben sind bewusst **nur in einer Oberfläche** möglich, nicht im Chat
(PLAN_ORGANISATIONEN §4). Ohne App hat ein Org-Admin heute also keinen Weg, Organisationsschlüssel zu
hinterlegen. Das ist der eigentliche Grund für die Konsole.

### 1.3 Was fehlt, unabhängig von der Oberfläche

- Eine Sicht der Organisation auf ihre **Instanzen** (heute sieht jede Person nur die eigenen, `GET /v1/instanzen`).
- **Beitritt ohne App** (Link-Schema `ava://`).
- Ein Weg, eine **Instanz anzufordern** (heute nur `scripts/instanz-anlegen.mjs` beim Operator).
- Die Setup-Seite einer Instanz braucht heute einen **Token-Link**, den der Operator weitergeben muss (§4.3).

## 2. Ablauf bei einem Unternehmenskunden (Zielbild)

1. **Operator:** Organisation anlegen (Konto des Ansprechpartners wird Owner) oder Ansprechpartner legt sie
   in der Konsole selbst an; Seats/Tarif vereinbaren.
2. **Org-Admin in der Konsole:** Organisationsschlüssel (OpenAI, …), KI-Vorgaben, Funktionen, Limits,
   Einladungslink kopieren und intern verteilen.
3. **Mitarbeitende:** Link öffnen → Konto anlegen oder anmelden → Beitritt angefragt → Admin nimmt an
   (Konsole oder Chat-Werkzeug). Mit Entra-SSO (Enterprise-Plan E6.1/E6.2) entfällt das später: Gruppe in
   Entra = Mitgliedschaft.
4. **Instanz je Person:** Admin klickt „Instanz anfordern“ (A5) → Operator stellt bereit
   (`instanz-anlegen --konto …`, später automatisch, A6).
5. **Mitarbeitende:** Konsole → „Meine AVA“ → Einrichtung öffnen: Anmeldung per Gerätecode (nur das eigene
   Konto kommt durch, Kontobindung), optional eigener Telegram-Bot. Einen Schlüssel brauchen sie nicht.
   Danach `https://mcp.ava.bi` in Claude oder ChatGPT; bei Claude Team/Enterprise kann der Admin AVA als
   Organisations-Connector für alle hinterlegen.
6. **Alltag:** Persönliche Einstellungen per Chat (jede Einstellung hat ein Werkzeug), Org-Admin sieht in der
   Konsole Mitglieder, Verbrauch, Abrechnung und den Zustand der Instanzen.

## 3. Architektur

### 3.1 Next.js als Backend-for-Frontend (BFF)

```
Browser ──(Cookie, httpOnly)──▶ ava-admin (Next.js, Fly fra) ──(Bearer, privates Netz)──▶ ava-db-gateway
                                   │
                                   └──(OIDC, Code + PKCE, Client-Geheimnis)──▶ Keycloak
```

- **Anmeldung:** eigener Keycloak-Client `ava-web`, **vertraulich** (Client-Geheimnis im BFF) plus PKCE,
  Redirect nur `https://admin.ava.bi/auth/callback`. Scopes wie `ava-desktop` (Spiegelung wie bei den
  MCP-Clients), aber **ohne `offline_access`**: Sitzung höchstens 8 h, Refresh nur serverseitig.
- **Sitzung:** verschlüsseltes, httpOnly-, `SameSite=Lax`-, `Secure`-Cookie mit Access- und Refresh-Token
  (oder Sitzungs-ID plus Ablage im Speicher; eine Maschine reicht). Im Browser-JavaScript liegt nie ein Token.
- **Gateway-Zugriff:** eine Route `app/api/gw/[...pfad]/route.ts`, die nur eine **Allowlist** von Pfaden
  durchreicht (`/v1/tenants/…`, `/v1/billing/portal`, `/v1/modelle`, `/v1/instanzen…`, `/v1/whoami`)
  und den Bearer ergänzt. Zum Gateway über das private Fly-Netz (`ava-db-gateway.internal`), kein CORS
  nötig, `GATEWAY_ALLOWED_ORIGINS` bleibt unverändert.
- **CSRF:** mutierende Aufrufe nur mit passendem `Origin`/`Sec-Fetch-Site`; dazu `SameSite`.
- **Schlüsseleingabe:** Formular schickt direkt an die Allowlist-Route; der BFF protokolliert keine Bodies
  auf `/providers`. Optional (E4) erneute Anmeldung (`max_age=300`) vor Schlüssel- und Rollenänderungen.
- **Seiten:** Server Components für Layout, Rollenweiche und erste Daten; die übernommenen Bausteine
  laufen als Client Components mit react-query wie in der App.

### 3.2 Warum nicht Vercel

Mit dem BFF laufen Organisationsschlüssel und Sitzungen durch die Server-Funktionen des Hosters. Auf
Vercel wäre das ein zusätzlicher Auftragsverarbeiter für Geheimnisse, und genau das fragt eine
Enterprise-Freigabe ab (Datenfluss-Tabelle C6). Auf Fly in Frankfurt bleibt es bei der bestehenden
Betriebsumgebung, und der Weg zum Gateway läuft über das private Netz. Vercel ginge nur als rein statische
Seite ohne BFF; dann lägen die Tokens im Browser.

### 3.3 Gateway-Änderungen

| Änderung | Warum |
| --- | --- |
| **Client-Prüfung** in `middleware/auth.ts`: `azp` ∈ {`ava-desktop`, `ava-web`} oder Präfix `mcp-` | Heute prüft der Gateway nur den Aussteller (Befund im Enterprise-Plan). Vorher eine Woche lang die `azp`-Werte im Audit messen, dann scharf schalten. |
| `GET /v1/modelle` | Modellkatalog für die KI-Vorgaben (heute lokal in der App). |
| `GET /v1/tenants/me/instanzen` (Admin) | Instanzen aller Mitglieder: Art, Name, Version, verbunden/zuletzt, Adresse; **nicht** ICP, Telegram, Radar-Inhalte (E9). |
| Tabelle `KopfInstanz` (actorId, instanzId, art, name, version, adresse, zuletzt) | Relais-Zustand liegt nur im Speicher; nach einem Gateway-Neustart wären Offline-Instanzen unsichtbar. Schreiben bei `hallo`/Trennung, kein Hochfrequenz-Update. |
| `POST /v1/instanzen/{id}/setup-link` | Holt über das Relais einen Einmal-Setup-Link von der eigenen Instanz (§4.3). Nur für die Person selbst. |
| `POST /v1/tenants/me/instanz-auftraege`, `GET …` | Auftrag „Instanz anfordern“ (A5): Person, Größe, Status offen/bereit/abgelehnt. Benachrichtigung an den Operator. |
| Einladungslink zusätzlich als `https://admin.ava.bi/beitreten/<token>` | Desktop akzeptiert beide Formen (`extractJoinToken` erweitern), die App zeigt weiter `ava://`. |

### 3.4 Code-Teilung

Neues Paket `packages/org-ui` mit den Bausteinen aus `Organisation.tsx`. Sie bekommen ihre Umgebung als
Kontext statt `window.api`:

```ts
interface OrgUmgebung {
  gateway<T>(pfad: string, opts?: GatewayOptions): Promise<T>;
  vorgabenNeuLaden(): Promise<void>;      // App: org.refreshPolicy, Web: Token auffrischen
  modelle(): Promise<ModellEintrag[]>;    // App: agent.listModels, Web: GET /v1/modelle
  beitrittsLink(token: string): string;   // App: ava://join/…, Web: https://admin.ava.bi/beitreten/…
}
```

Die Desktop-Seite wird dadurch zur dünnen Hülle; App und Konsole zeigen dieselben Bausteine und bleiben
von selbst gleich. Gestaltung: dieselben Tailwind-v4-Tokens (Farben aus `styles.css` als gemeinsames
Theme), Marken-Farben #F2F7F6 / #00C0A7 / #0A1F2A.

## 4. Funktionsumfang

### 4.1 Für Owner und Admins

Alles, was die App-Seite heute kann: Überblick, Mitglieder und Rollen, Anfragen, Einladungslink, Vorgaben,
Funktionen, Relevanz, KI-Vorgaben, Organisationsschlüssel, Apify, ChatGPT-Abo-Erlaubnis, Limits, Verbrauch,
Abrechnung und Rechnungen. Neu: **Instanzen** (Tabelle je Mitglied: Desktop/Server, Version, verbunden seit /
offline seit, Adresse) und **Instanz anfordern**.

### 4.2 Für Mitglieder

Schlanke Sicht: Organisation, Admins, Austritt, dazu **„Meine AVA“**: eigene Instanzen mit Adresse und Zustand,
Knopf „Einrichtung öffnen“ (§4.3), kurze Anleitung „AVA in Claude/ChatGPT verbinden“ mit der MCP-Adresse.
Kein Ersatz für die Chat-Einstellungen: Persönliches bleibt im Chat.

### 4.3 Setup ohne geheimen Link (Kontobindung nutzen)

Heute schützt ein Token in der Adresse die ganze Setup-Seite, und der Operator muss diesen Link weitergeben.
Mit der Kontobindung (§14 Cloud-Plan) geht es einfacher:

- **Vor der ersten Anmeldung** zeigt `/setup` einer gebundenen Instanz ohne Token **nur den Gerätecode**.
  Unschädlich, weil nur das gebundene Konto den Code erfolgreich bestätigen kann; alle anderen weist die
  Instanz ab.
- **Danach** ist die Instanz mit dem Relais verbunden. Die Konsole holt über
  `POST /v1/instanzen/{id}/setup-link` einen **Einmal-Link** (15 Minuten gültig, einmal benutzbar) bei der
  Instanz selbst ab und öffnet ihn. Schlüssel, Telegram und Umzug sind so nur für die angemeldete Person
  erreichbar, ohne dass je ein dauerhafter Token verteilt wird.
- `AVA_SETUP_TOKEN` bleibt als Notzugang des Operators.

## 5. Stufen

| Stufe | Inhalt | Aufwand |
| --- | --- | --- |
| **A0** | Entscheidungen §7; Keycloak-Client `ava-web` (per `keycloak-config.mjs`, Prod nur mit Zustimmung); Fly-App `ava-admin`, DNS `admin.ava.bi` (eigener Eintrag vor dem Wildcard), Zertifikat | 0,5 Tage |
| **A1** | Next.js-Gerüst, Anmeldung/Abmeldung, Sitzungs-Cookie, BFF-Route mit Allowlist, Rollenweiche, Überblick, Mitglieder, Anfragen, Einladung | 3 Tage |
| **A2** | Paket `packages/org-ui` (Bausteine aus der App herausgelöst, App auf das Paket umgestellt), `GET /v1/modelle`, alle übrigen Bereiche in der Konsole | 4 Tage |
| **A3** | Beitritt im Web (`/beitreten/<token>`, Registrierung über Keycloak, Anfrage, Statusanzeige), `extractJoinToken` mit https-Form | 1 Tag |
| **A4** | `KopfInstanz`-Tabelle, `GET /v1/tenants/me/instanzen`, Instanzen-Tabelle für Admins, „Meine AVA“ für Mitglieder | 2 Tage |
| **A5** | Setup ohne geheimen Link (§4.3) und „Instanz anfordern“ als Auftrag an den Operator (`instanz-anlegen --auftrag <id>` setzt den Auftrag auf bereit) | 2–3 Tage |
| **A6** | Später: automatische Bereitstellung aus der Konsole über einen eigenen kleinen Dienst mit Fly-Token (nicht im Gateway), Freigabe durch Operator oder Seat-Vertrag | 3–4 Tage |
| **A7** | Mit dem Enterprise-Plan: Entra-SSO (E6.1), SCIM (E6.2), Lizenz über Gruppen (E6.3) | dort geplant |

Reihenfolge: A0 → A1 → A2 → A3 → A4 → A5; A6/A7 nach Bedarf des ersten Kunden. Die Client-Prüfung im Gateway
(§3.3) läuft ab A1 im Messmodus und wird vor dem ersten Kunden scharf geschaltet.

## 6. Betrieb und Kosten

- Fly-App `ava-admin`, fra, 512 MB shared, eine Maschine (Sitzungen im Cookie, daher auch zwei möglich):
  rund 4–5 $/Monat.
- Secrets: `KEYCLOAK_CLIENT_SECRET`, `SESSION_SECRET`, `GATEWAY_URL=http://ava-db-gateway.internal:8080`.
- Ausrollen wie Router/Gateway per `fly deploy` mit absoluten Pfaden; ein GitHub-Workflow ist möglich, weil
  das Repo öffentlich ist (keine Actions-Kosten).
- Prüfung: Playwright-Rauchtest (Anmeldung mit Testkonto, Seiten laden, Rollenweiche) im Repo, läuft gegen
  eine lokale Konsole mit Test-Keycloak.

## 7. Entscheidungen (Empfehlung jeweils zuerst)

| # | Frage | Empfehlung | Alternative |
| --- | --- | --- | --- |
| E1 | Hosting | Fly fra neben dem Gateway | Vercel nur statisch, ohne BFF |
| E2 | Adresse | `admin.ava.bi` (schon für Kunden gesperrt) | `konsole.ava.bi`, `app.ava.bi` |
| E3 | Code-Teilung | gemeinsames Paket `packages/org-ui` | Kopie der Bausteine (schneller, läuft auseinander) |
| E4 | Erneute Anmeldung vor Schlüssel- und Rollenänderungen | ja, `max_age=300` | nein |
| E5 | Mitglieder in der Konsole | ja, schlanke Sicht mit „Meine AVA“ | nur Admins |
| E6 | Setup ohne geheimen Link für gebundene Instanzen | ja (§4.3) | Token-Link bleibt Standard |
| E7 | Instanz anfordern | erst Auftrag an den Operator (A5), Automatik später (A6) | sofort automatisch |
| E8 | Instanz-Zustand dauerhaft im Gateway | ja, kleine Tabelle `KopfInstanz` | nur Speicher (nach Neustart lückenhaft) |
| E9 | Was Admins über Instanzen sehen | nur Betrieb (Art, Version, verbunden, Adresse) | auch Modell, Radar, Telegram |
| E10 | Abrechnung der Server-Instanz | eigene Position je Instanz im Seat-Plan (`docs/PLAN_ABRECHNUNG_SEATS.md`) | im Seat-Preis enthalten |

## 8. Risiken

- **Zweite Oberfläche läuft auseinander:** nur mit E3 beherrschbar; neue Org-Funktionen entstehen ab dann im
  Paket, nicht in der App.
- **Client-Prüfung sperrt versehentlich jemanden aus** (z. B. alte MCP-Clients ohne `mcp-`-Präfix): deshalb
  erst messen, dann scharf.
- **Tenant-Wechsel nach Beitritt:** Das Token trägt die neue `tenant_id` erst nach dem nächsten Refresh;
  die Konsole holt nach der Annahme aktiv neu, Instanzen spätestens nach 10 Minuten.
- **Einmal-Setup-Link** hängt am Relais: Ist die Instanz offline, gibt es keinen Link. Notzugang bleibt
  `AVA_SETUP_TOKEN` beim Operator.
- **Keycloak 20 (EOL)** und offene Registrierung bleiben Befunde des Enterprise-Plans; die Konsole ändert
  daran nichts, macht SSO (A7) aber zur naheliegenden nächsten Stufe.

## 9. Nicht Teil dieses Plans

- Ein Web-Client für die AVA-Arbeit selbst (Chat, Firmen, Radar): bewusst nicht, die Arbeit läuft über
  Claude/ChatGPT per MCP und Telegram (PLAN_AVA_CLOUD §11).
- Operator-Konsole über alle Organisationen hinweg (Kunden anlegen, Instanzen aller Kunden). Bleibt vorerst
  bei den Skripten; kann später als eigener Bereich der Konsole mit Operator-Rolle folgen.
