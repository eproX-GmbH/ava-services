# Plan: Organisationen (Mandanten-Ausbau)

Stand 2026-09-04. Status: Konzept. Baut auf PLAN_TENANT_MULTI_ACCOUNT.md
(T1–T5 umgesetzt: Konto-Spaces, Kontowechsel, Keycloak-Gruppen mit
`tenant_id`-Claim, Gateway-Tabellen Tenant/TenantMember, /whoami) und
PLAN_COMPLIANCE_ENTERPRISE.md (Modul-Schalter, Datenklassen) auf.

## 0. Einordnung der Anforderungen

| Anforderung | Einordnung | Bausteine, die es schon gibt |
|---|---|---|
| Organisation registrieren, Ersteller = Admin | Tenant mit Rolle `owner` (heute: persoenlicher Tenant je User) | Tenant/TenantMember (T4), Keycloak-Admin-Client im Gateway (Registrierung) |
| Ohne Organisation bleibt der Nutzer seine eigene | ist heute genau so (tenant:<sub>) | T3-Skript, /whoami zeigt „persoenlicher Tenant" |
| Wechsel in andere Organisation nur nach Admin-Bestaetigung | neue Entitaet Beitrittsanfrage; bis zur Freigabe unveraendert | TenantMember mit actorId-Unique (ein Tenant je User) |
| Admin-Ansicht: Mitglieder annehmen/entfernen; Entfernte fallen auf „eigene" Organisation zurueck | Gateway-Routen + neue Desktop-Seite + Chat-Tools | Konto-Menue, Whoami-Seite, Tool-Registry |
| Funktionen je Organisation abschalten und in der App ausblenden (personenbezogen zuerst) | Tenant-Policy (C2 aus dem Compliance-Plan) | Consent-Modal, Modul-Schalter je Konto |
| Zentrale API-Tokens (OpenAI, Apify …) fuer alle Mitglieder, ohne Auslesbarkeit auf Geraeten | **Stellvertreter-Aufrufe ueber das Gateway**, Schluessel verlassen den Server nie | ValueSerp-Proxy mit Operator-Key, ProxyAudit/ProxyQuota, OpenAI-kompatible Endpunkte im Provider (v0.1.503) |
| Verbrauchslimit organisationsweit ODER Tageslimit je Nutzer | Metering im Proxy, Limits serverseitig durchgesetzt | UsageEntry/TenantBilling-Muster, Quota-Middleware |
| Sperre lokaler Ueberschreibung (Anbieter, Token, Modell fuer Chat und Producer) | Policy-Flag + Desktop respektiert es (Einstellungen read-only, Producer-Env aus Policy) | Provider-Store, producer-supervisor env |

## 1. Datenmodell (Gateway)

```
Tenant            id, name, slug (Beitrittscode), kind: personal | organisation, createdAt
TenantMember      tenantId, actorId (unique), role: owner | admin | member, joinedAt   (vorhanden)
TenantJoinRequest id, tenantId, actorId, email, name, status: open | approved | rejected,
                  requestedAt, decidedAt, decidedBy
TenantPolicy      tenantId (PK), features JSON, providerLock BOOL, chatModel, producerModel,
                  updatedAt, updatedBy
TenantProvider    tenantId, kind (openai | anthropic | google | mistral | deepseek | xai |
                  qwen | apify), keyCiphertext, keyHint (letzte 4), createdBy, createdAt
TenantQuota       tenantId (PK), mode: org_total | per_user_daily, orgMonthlyCents,
                  userDailyCents, hardStop BOOL
LlmUsage          id, tenantId, actorId, kind, model, inputTokens, outputTokens, costCents,
                  purpose: chat | producer | judge, createdAt   (Index tenantId+createdAt, actorId+day)
```

Schluessel ruhen verschluesselt (AES-GCM mit einem Master-Schluessel aus
dem Fly-Secret `TENANT_KEY_MASTER`; beim souveraenen Betrieb setzt der
Kunde ihn selbst). Klartext existiert nur fuer die Dauer eines Aufrufs
im Speicher des Gateways.

## 2. Registrierung und Rollen

- **Organisation anlegen** (`POST /v1/tenants`): nur mit angemeldetem
  Konto; der Aufrufer wird `owner`. Sein persoenlicher Tenant bleibt als
  Zeile bestehen (Rueckfallziel), seine Mitgliedschaft wechselt sofort
  (er ist ja Admin). Keycloak: Gruppe `tenant:<slug>` mit `tenant_id`/
  `tenant_name`, User wird umgehaengt (Gateway nutzt den vorhandenen
  Keycloak-Admin-Client; dieselbe Logik wie das T3-Skript, nur je Vorgang).
- **Rollen** leben im Gateway (TenantMember.role). Keycloak traegt nur
  die Gruppe (fuer den Claim) — kein Realm-Rollen-Geflecht, das mit der
  Gateway-Wahrheit auseinanderlaufen kann. Der Claim `tenant_role` wird
  zusaetzlich als Gruppenattribut gespiegelt, damit der Desktop die
  Admin-Ansicht ohne Extra-Roundtrip einblenden kann; massgeblich bleibt
  das Gateway bei jedem Admin-Aufruf.
- **Ersteller = Admin** ist damit erfuellt; weitere Admins kann ein Owner
  befoerdern (`PATCH /v1/tenants/me/members/:actorId {role}`).

## 3. Beitritt und Wechsel

- Nutzer gibt in der App einen **Beitrittscode** (Slug) ein oder folgt
  einem Einladungslink (`ava://join/<slug>`; Link-Handling gibt es fuer
  OAuth schon). Ergebnis: `TenantJoinRequest open`. Der Nutzer bleibt in
  seiner bisherigen Organisation; die App zeigt „Beitritt zu X angefragt".
- Admin sieht offene Anfragen (Ansicht + Chat-Tool + Meldung im
  Meldungs-Feed des Admins), nimmt an oder lehnt ab.
- **Annahme**: Gateway setzt TenantMember (alte Mitgliedschaft wird
  ersetzt; actorId ist unique), haengt die Keycloak-Gruppe um, schreibt
  Audit. Beim naechsten Token-Refresh (spaetestens 15 min, sofort beim
  naechsten Start) traegt das Token die neue `tenant_id`.
- **Desktop** erkennt den Tenant-Wechsel im Auth-Status (tenantId
  aendert sich bei gleichem sub): Konto-Space bleibt (er haengt am sub),
  aber Producer-Env, Policy und Tenant-Sicht muessen neu geladen werden →
  kontrollierter Neustart mit Hinweis „Du bist jetzt Mitglied von X".
- **Entfernen** (`DELETE /v1/tenants/me/members/:actorId`): Mitgliedschaft
  zurueck auf den persoenlichen Tenant `tenant:<sub>` (Zeile existiert
  oder wird neu angelegt, Keycloak-Gruppe ebenso) — nie auf eine
  vorherige „richtige" Organisation. Der Entfernte bekommt beim naechsten
  Refresh den alten Claim und denselben kontrollierten Neustart.
- Selbst-Austritt eines Mitglieds: dieselbe Route auf sich selbst;
  der letzte Owner kann nicht austreten, ohne die Organisation zu
  loeschen oder einen Nachfolger zu ernennen.

## 4. Admin-Ansicht (Desktop) und Self-Service im Chat

Neue Seite „Organisation" (nur fuer owner/admin im Menue sichtbar; fuer
Mitglieder eine schlanke Variante mit Name, Admins, Austritt):
1. **Mitglieder**: Liste (Name, E-Mail, Rolle, seit), offene Anfragen mit
   Annehmen/Ablehnen, Entfernen mit Rueckfrage, Rolle aendern.
2. **Funktionen**: Schalter je Modul, personenbezogene zuerst:
   LinkedIn-Beobachter, Personen-Watchlist, Personen-Radar, Bildanalyse,
   Kontakt-Recherche (Stufe „Kontakte" des Producers), Mail-Anbindung,
   Telegram. Aus = in der App komplett ausgeblendet (Navigation, Tabs,
   Einstellungen, Chat-Tools) UND serverseitig durchgesetzt (Persist-
   Events der Stufe werden verworfen, Proxy-Aufrufe abgelehnt).
3. **KI und Schluessel**: Anbieter je Zweck (Chat, Hintergrund-
   Verarbeitung), Modell je Zweck, Schluessel je Anbieter (Eingabe →
   Gateway → verschluesselt; Anzeige nur der letzten 4 Zeichen), Apify-
   Token, Schalter „Mitglieder duerfen lokal ueberschreiben".
4. **Limits**: entweder Gesamtbudget je Monat oder Tageslimit je Nutzer
   (in Euro, Umrechnung ueber den Modell-Katalog), harter Stopp oder nur
   Hinweis; Verbrauchsuebersicht je Nutzer/Tag.

Chat-Tools (Self-Service-Prinzip, Admin-only, alle mutierenden mit
confirmAction): `org_members`, `org_member_approve`, `org_member_remove`,
`org_features_set`, `org_provider_set` (Schluessel-Eingabe bleibt UI-only,
wie bisher fuer alle Keys), `org_limits_set`; read-only fuer Mitglieder:
`org_info` (erweitert `account_info`).

## 5. Zentrale Schluessel ohne Auslesbarkeit — der Stellvertreter-Weg

**Warum Verteilen nicht sicher geht:** Ein Geraet, das einen Schluessel
benutzen kann, kann ihn auch auslesen (safeStorage schuetzt vor anderen
Nutzern desselben Geraets, nicht vor dem angemeldeten Nutzer selbst;
ein Debugger, ein Proxy oder ein Speicherabbild genuegen). Alles, was
den Klartext auf das Geraet bringt, ist Komfort-Schutz, kein Schutz.

**Loesung:** Der Schluessel bleibt im Gateway, die Geraete rufen die
Anbieter **ueber das Gateway** auf. Das Gateway authentifiziert den
Nutzer per JWT, prueft Policy und Limit, setzt den Organisations-
Schluessel ein und reicht die Antwort durch (Streaming inklusive).
Genau so laeuft heute schon ValueSerp mit dem Operator-Schluessel.

- **LLM**: Routen `POST /v1/llm/openai/...`, `/v1/llm/anthropic/...`,
  `/v1/llm/google/...`, `/v1/llm/mistral/...` etc. als Pfad-Passthrough
  auf die jeweilige Anbieter-API. Der Desktop-Provider und die Producer
  koennen bereits beliebige `baseURL`s (OpenAI-kompatibel, v0.1.503);
  fuer Anthropic/Google reicht `baseURL` des AI-SDK-Providers ebenso.
  Bearer = Nutzer-JWT (Desktop) bzw. `PRODUCER_GATEWAY_TOKEN` (Producer,
  gibt es schon). Der Provider-Store bekommt eine neue Auth-Art
  `organisation` neben `api-key` und `abo`.
- **Apify**: `/v1/proxy/apify/...` nach demselben Muster wie ValueSerp
  (Token-Injektion, Audit, Quota).
- **Metering**: das Gateway liest die Token-Zaehler aus den Antworten
  (OpenAI/Anthropic liefern usage-Bloecke, auch im Stream als letztes
  Ereignis) und schreibt LlmUsage mit Kosten aus dem Modell-Katalog.
- **Limits**: Vorabpruefung je Aufruf (Tagesbudget des Nutzers bzw.
  Monatsbudget der Organisation); bei Ueberschreitung 429 mit klarer
  Meldung, die der Desktop als Banner zeigt (Muster: Tages-Token-Limit-
  Banner existiert).
- **Lokale Modelle** (Ollama) bleiben unberuehrt: kein Schluessel, kein
  Proxy, kein Limit — Policy kann sie erlauben oder verbieten.
- **Datenschutz-Ehrlichkeit**: Beim Stellvertreter-Weg sieht das Gateway
  die Prompts. Als AVA-Service heisst das: Frankfurt, EU, kein Speichern
  der Inhalte (nur Zaehler). Fuer Organisationen mit hoeherem Anspruch ist
  das der Anwendungsfall fuer das souveraene Substrat (C5) — dann ist das
  Gateway ihr eigenes. Das gehoert in die Datenfluss-Tabelle (C6).
- **Abo-Pfad (ChatGPT/Codex)** bleibt Konto-gebunden und laesst sich nicht
  zentralisieren (OAuth des einzelnen Nutzers). Policy kann ihn erlauben
  oder sperren.

## 6. Sperre lokaler Ueberschreibung und Modellvorgabe

- `TenantPolicy.providerLock = true`: Einstellungen → Modelle zeigt die
  Organisationsvorgabe read-only (Anbieter, Chat-Modell, Producer-Modell,
  „Schluessel: von der Organisation"), keine Key-Eingabe, kein Abo-Login,
  Ollama nur wenn Policy es erlaubt. Der Chat-Agent bekommt die Provider-
  Tools nicht. Producer-Supervisor baut die Env aus der Policy
  (LLM_PROVIDER, LLM_MODEL, Proxy-`baseURL`, PRODUCER_GATEWAY_TOKEN).
- `providerLock = false`: Organisationsvorgabe ist Default, Mitglieder
  duerfen lokal abweichen (eigener Key oder Abo); Limits gelten trotzdem
  fuer Aufrufe ueber den Stellvertreter, nicht fuer eigene Schluessel
  (technisch nicht messbar — wird in der UI so benannt).
- Vorgaben werden beim Start und bei jedem /whoami-Refresh geladen; die
  Policy traegt eine Version, der Desktop laedt bei Aenderung neu.

## 7. Umsetzungsstufen

| Stufe | Inhalt | Aufwand | Deploy |
|---|---|---|---|
| O1 | Gateway: Tenant.kind/slug, TenantJoinRequest, TenantPolicy; Routen anlegen/beitreten/annehmen/ablehnen/entfernen/Rolle; Keycloak-Gruppenwechsel ueber den Admin-Client; /whoami liefert role, policy, offene Anfrage | 3–4 Tage | ja (Go) |
| O2 | Desktop: Seite „Organisation" (Mitglieder, Anfragen), Beitrittscode/Link, Tenant-Wechsel-Erkennung mit kontrolliertem Neustart, Chat-Tools org_* | 3 Tage | – |
| O3 | Funktionen-Policy: Desktop blendet Module aus (Navigation, Tabs, Einstellungen, Tool-Registry, Producer-Start), Gateway setzt serverseitig durch (Persist-Events, Proxy) | 2–3 Tage | ja |
| O4 | Stellvertreter-Proxy fuer LLM-Anbieter + Apify im Gateway (Streaming, Key-Injektion, Audit), verschluesselte TenantProvider-Ablage, Metering LlmUsage | 4–5 Tage | ja |
| O5 | Desktop/Producer: Auth-Art `organisation` im Provider-Store, baseURL auf Gateway, Producer-Env aus Policy, providerLock in Einstellungen, Limit-Banner | 3 Tage | – |
| O6 | Limits: TenantQuota, Vorabpruefung, Verbrauchsuebersicht in der Admin-Ansicht, Chat-Tool org_limits_set | 2 Tage | ja |
| O7 | Website/Doku: Organisationen, zentrale Schluessel, Datenfluss-Tabelle ergaenzen (C6) | 0,5 Tag | – |

Reihenfolge O1 → O2 → O3 (Mandantenverwaltung und Compliance-Schalter
zuerst, sie sind unabhaengig vom Proxy), dann O4 → O5 → O6.

## 8. Risiken
- **Proxy als Engpass**: LLM-Streams laufen ueber das Gateway (Fly, eine
  Maschine). Fuer Dutzende Nutzer reicht das; darueber horizontal skalieren
  (Fly-Machines) — der Proxy ist zustandslos bis auf Metering-Writes.
- **Kostenumrechnung**: Limits in Euro brauchen den Modell-Katalog auf
  dem Gateway (heute im Desktop-Paket); Katalog wird geteiltes Paket.
- **Claim-Verzoegerung**: Tenant-Wechsel wirkt erst mit dem naechsten
  Token; der Desktop stoesst nach Annahme aktiv einen Refresh an
  (Gateway-Push per bestehendem SSE-Kanal), sonst max. 15 min.
- **Keycloak-Umhaengen** ist ein Admin-API-Schreibzugriff aus dem Gateway
  heraus — existiert fuer die Registrierung schon; Fehler dort duerfen die
  Gateway-Wahrheit nicht beschaedigen (erst Gateway, dann Keycloak, bei
  Fehler Wiederholung im Hintergrund).

## 9. Entscheidungen, die anstehen
1. Beitritt per Code (Slug) UND Einladungslink, oder nur eines davon?
2. Duerfen Mitglieder bei `providerLock = false` das Abo (ChatGPT) nutzen,
   oder ist das Abo grundsaetzlich nur ohne Organisationsvorgabe erlaubt?
3. Limits nur fuer Stellvertreter-Aufrufe (messbar) — ist es akzeptabel,
   dass eigene Schluessel der Mitglieder unlimitiert bleiben?
4. Sollen Prompts im Proxy fuer Audit-Zwecke gespeichert werden koennen
   (Option je Organisation), oder grundsaetzlich nie?
