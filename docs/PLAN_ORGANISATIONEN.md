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

- Nutzer folgt einem **Einladungslink** (`ava://join/<slug>`; Link-
  Handling gibt es fuer OAuth schon; Admin erzeugt den Link in der
  Organisations-Ansicht, kopierbar). Entscheidung 2026-09-04: nur Link,
  kein manuell einzugebender Code. Ergebnis: `TenantJoinRequest open`. Der Nutzer bleibt in
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
- **Nur wenn noetig** (Entscheidung 2026-09-04): Der Stellvertreter-Weg
  gilt ausschliesslich fuer Aufrufe mit dem **Organisationsschluessel**.
  Hat der Nutzer fuer einen Anbieter einen **eigenen** Schluessel oder
  das Abo hinterlegt, laeuft alles lokal und direkt wie heute — kein
  Proxy, keine Sicht des Gateways auf Prompts. Je Anbieter waehlt der
  Nutzer in Einstellungen → Modelle (und per Chat-Tool) die Quelle:
  „Schluessel der Organisation" oder „Eigener Schluessel/Abo"; die
  Auswahl ist jederzeit umschaltbar, solange die Policy Ueberschreiben
  erlaubt. Ohne eigenen Schluessel ist „Organisation" der Default.
- **Lokale Modelle** (Ollama) bleiben unberuehrt: kein Schluessel, kein
  Proxy, kein Limit — Policy kann sie erlauben oder verbieten.
- **Datenschutz-Ehrlichkeit**: Beim Stellvertreter-Weg sieht das Gateway
  die Prompts. Als AVA-Service heisst das: Frankfurt, EU, kein Speichern
  der Inhalte (nur Zaehler). Fuer Organisationen mit hoeherem Anspruch ist
  das der Anwendungsfall fuer das souveraene Substrat (C5) — dann ist das
  Gateway ihr eigenes. Das gehoert in die Datenfluss-Tabelle (C6).
- **Abo-Pfad (ChatGPT/Codex)** bleibt Konto-gebunden und laesst sich nicht
  zentralisieren (OAuth des einzelnen Nutzers). Ist Ueberschreiben
  erlaubt, ist das Abo erlaubt (Entscheidung 2026-09-04); bei Sperre
  nicht.
- **Prompt-Audit opt-in** (Entscheidung 2026-09-04): je Organisation
  kann ein Admin aktivieren, dass der Proxy Prompts und Antworten fuer
  Audit-Zwecke speichert (TenantPolicy.promptAudit, Default aus; sichtbar
  fuer Mitglieder in der Datenfluss-Anzeige). Ohne Opt-in werden nur
  Zaehler gespeichert.

## 6. Sperre lokaler Ueberschreibung und Modellvorgabe

- `TenantPolicy.providerLock = true`: Einstellungen → Modelle zeigt die
  Organisationsvorgabe read-only (Anbieter, Chat-Modell, Producer-Modell,
  „Schluessel: von der Organisation"), keine Key-Eingabe, kein Abo-Login,
  Ollama nur wenn Policy es erlaubt. Der Chat-Agent bekommt die Provider-
  Tools nicht. Producer-Supervisor baut die Env aus der Policy
  (LLM_PROVIDER, LLM_MODEL, Proxy-`baseURL`, PRODUCER_GATEWAY_TOKEN).
- `providerLock = false`: Organisationsvorgabe ist Default, Mitglieder
  duerfen lokal alles angeben wie heute (eigener Key jedes Anbieters,
  Abo, Ollama) und je Anbieter zwischen eigenem und Organisations-
  Schluessel umschalten. Limits gelten fuer Aufrufe ueber den
  Stellvertreter (Organisationsschluessel); eigene Schluessel sind
  nicht messbar und bleiben unlimitiert (Entscheidung 2026-09-04) —
  die UI benennt das.
- Vorgaben werden beim Start und bei jedem /whoami-Refresh geladen; die
  Policy traegt eine Version, der Desktop laedt bei Aenderung neu.

## 7. Umsetzungsstufen

| Stufe | Inhalt | Aufwand | Deploy |
|---|---|---|---|
| O1 ✅ | Gateway: Tenant.kind/inviteToken, TenantJoinRequest, TenantPolicy; Routen `/v1/tenants*` (anlegen, Beitritt per Link, annehmen/ablehnen, entfernen mit Rueckfall auf persoenlichen Tenant, Rolle, Vorgaben, Link erneuern); Keycloak-Gruppe `tenant:<id>` best-effort nach Commit; /whoami liefert tenantKind, policy, openJoinRequest. Umgesetzt 2026-09-04 (Migration `20260904_organisationen`, Ablauftest in PGlite; Deploy ausstehend) | 3–4 Tage | ja (Go) |
| O2 ✅ | Desktop v0.1.541: Seite „Organisation" (anlegen, Beitritt per Link `ava://join/<token>`, Anfragen freigeben, Mitglieder/Rollen, Einladungslink, Austritt, Vorgaben lesend), Tenant-Wechsel-Erkennung ueber /whoami (10-Min-Takt, nach Anmeldung, auf Anforderung) mit Hinweis + Neustart, OS-Benachrichtigung fuer Admins bei neuen Anfragen, Chat-Tools org_info/org_members/org_member_approve/org_member_remove. Gateway: Tenant-Aufloesung ueber TenantMember, wenn das Token keinen tenant_id-Claim traegt (tenantSource "membership") | 3 Tage | – |
| O3 ✅ | Desktop v0.1.542: Vorgaben je Konto-Space persistiert (org-policy.json, aus /whoami), Gates fuer Mail, Telegram, LinkedIn-Scheduler, Watchlist, Radar, Bildanalyse, Apify-Token (Kontakt-Recherche); Navigation, Einstellungen (Abschnitte + Sprungmarken), Mail-Triage-Route, Signale-Seite; Tool-Registry sperrt mail_*, linkedin_*, personen_radar_*, company_contacts, contact_linkedin_lookup; Laufzeit-Umschaltung bei Aenderung. Admin-Formular auf der Organisations-Seite + Chat-Tools org_features_set/org_provider_set. Gateway: 403 feature_disabled:kontakte fuer Kontakt-Schreibrouten (Policy-Cache 60 s). v0.1.543: Desktop injiziert AVA_TENANT_ID (wirksamer Tenant) in die Producer, Persist-Bus verwirft `tenant.persist.company-contact.v1` bei „Kontakt-Recherche aus" (Matrix: uebersprungen, feature_disabled:kontakte); Vorgabe wird ueber Tenant-ID UND Mitgliedschaft aufgeloest | 2–3 Tage | ja |
| O4 ✅ | Gateway (2026-09-04): TenantProvider (AES-256-GCM, Master-Schluessel `TENANT_SECRETS_KEY` als Fly-Secret, AAD tenant:kind, nur Hinweis auslesbar), LlmUsage (Zaehler + Kosten in Mikro-USD aus vendored Preistabelle), PromptAudit (nur bei promptAudit=true). Routen: GET/PUT/DELETE `/v1/tenants/me/providers[/{kind}]`, Passthrough `ALL /v1/llm/{openai|anthropic|google|mistral|deepseek|xai|qwen}/*` (Header-Injektion je Anbieter, Streaming per TransformStream, usage aus JSON/SSE), `ALL /v1/proxy/apify/*`. Ohne hinterlegten Schluessel 404 provider_not_configured; ohne Master-Schluessel 503 secrets_unconfigured. Limits/Vorabpruefung folgen in O6 | 4–5 Tage | ja |
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

## 9. Entscheidungen (2026-09-04, Joyce)
1. Beitritt **nur per Einladungslink**.
2. Ist Ueberschreiben erlaubt, darf auch das ChatGPT-Abo genutzt werden;
   Mitglieder koennen dann alles angeben wie heute.
3. Eigene Schluessel bleiben unlimitiert (nur Stellvertreter-Aufrufe
   sind messbar). Akzeptiert.
4. Prompt-Audit im Proxy **per Opt-in je Organisation** aktivierbar,
   Default aus.
5. KI-Gateway (Stellvertreter) **nur wo noetig**: fuer Nutzer, die den
   Organisationsschluessel verwenden UND lokal keinen eigenen haben.
   Mit eigenem Schluessel laeuft alles lokal wie heute. Nutzer koennen je
   Anbieter zwischen eigenem und Organisations-Schluessel wechseln.
