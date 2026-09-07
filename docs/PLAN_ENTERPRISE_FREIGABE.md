# Plan: Enterprise-Freigabe (Konzern-Anforderungen)

Stand 2026-09-04 (Code v0.1.543, Gateway mit O1–O4). Status: Konzept,
wartet auf Entscheidungen in Abschnitt 3.

Antwort auf die externe Anforderungsliste (9 Bloecke, [K.o.] / [Muss]).
Baut auf `PLAN_COMPLIANCE_ENTERPRISE.md` (C1–C6), `PLAN_ORGANISATIONEN.md`
(O1–O7), `PLAN_TENANT_MULTI_ACCOUNT.md` (T1–T6) und
`PLANS_server_deployment.md` auf. Der Status quo wurde am Code erhoben
(sechs parallele Erhebungen, Belege als Datei:Zeile).

Legende: ✅ vorhanden · ◐ teilweise · ❌ fehlt · **[K.o.]** blockiert
Konzern-Freigabe · **[Muss]** fuer produktiven Betrieb noetig.

---

## 0. Ergebnis in einem Absatz

AVA hat die *Bausteine* fuer Enterprise (Tenant/Rollen im Gateway,
Feature-Policy, verschluesselte Organisationsschluessel mit Proxy,
Request-Audit, Provenienz je Beobachtung, lokale Bildanalyse als
Default), aber drei strukturelle Luecken ziehen sich durch fast alle
neun Bloecke:

1. **Durchsetzung ist clientseitig.** Policies, Consent, Retention und
   Audit leben im Desktop (`org-policy.json` unsigniert, lokale PGlite),
   das Gateway erzwingt nur `kontakte`. Ein Konzern-DSB bewertet den
   schlimmsten Fall, und der ist heute: Nutzer editiert eine JSON-Datei.
2. **Es gibt keine Operator-/Admin-Ebene ueber dem Tenant-Owner** und
   kein fachliches, manipulationssicheres, exportierbares Audit-Log.
   Policy-Aenderungen sind als `PUT /v1/tenants/me/policy` sichtbar,
   nicht *was* geaendert wurde.
3. **Personenbezogene Daten liegen verteilt** (geteilter Bestand ohne
   Tenant-/Akteurs-Zuordnung, Watchlist/Radar/Feed/Mail nur lokal je
   Laptop). Betroffenenrechte sind damit heute nicht geraeteuebergreifend
   erfuellbar; Sperrliste, Personen-Loeschung, Auskunftsroute fehlen.

Die Priorisierung der Liste (Server-Modus, Audit-Log, LinkedIn per
Policy) ist am Code gemessen richtig, aber in anderer Reihenfolge
umsetzbar: **LinkedIn-Policy ist zu ~80 % da** (O3) und braucht nur
noch Signatur, Operator-Sperre und Audit (1 Woche). **Audit-Log** ist
2–3 Wochen. **Server-Modus** zerfaellt in ein schnelles Teil
(souveraenes Substrat per Compose, 2–3 Wochen) und ein grosses Teil
(zentraler Personen-Index + AVA-Worker, 6–10 Wochen), das erst nach dem
Datenmodell-Umbau (Block 2) sinnvoll ist.

Realistischer Gesamtaufwand bis „bewertbar im Konzern" (alle K.o.):
**~14–18 Entwicklerwochen** plus externe Leistungen (Zertifikate,
Pen-Test, juristische Dokumente). Details in Abschnitt 5.

---

## 1. Status quo je Block (Ampel)

| # | Anforderung | Stufe | Ist | Luecke in einem Satz |
|---|---|---|---|---|
| 1a | LinkedIn zentral abschaltbar, Client kann nicht ueberschreiben, Audit-Nachweis | K.o. | ◐ | Policy existiert (O3), aber unsigniert, lokal editierbar, offline dauerhaft, ohne Operator-Sperre, Audit ohne Inhalt |
| 1b | Bildanalyse/Logo-Erkennung auf Personen-Posts streichen | K.o. | ◐ | Default lokal, Cloud-Opt-in; Feature existiert weiterhin fuer alle Post-Autoren |
| 1c | Konnektor zu lizenziertem Datenanbieter (Dealfront o. ae.) | — | ❌ | Nur Apify (BYOK); Adapter-Schicht `linkedin.profile-activity` existiert als Vertrag |
| 1d | Haftung Kontosperre vertraglich | — | ❌ | Consent-Modal ohne Arbeitgeber-Satz; kein Vertragstext |
| 2a | Zweistufiger Bestand (Sichtung → Arbeitsbestand, protokollierter Akt) | K.o. | ❌ | Personen landen sofort im geteilten Bestand; Lifecycle nur fuer Firmen (DiscoveryDecision) |
| 2b | Art.-14-Workflow erzwungen beim Erstkontakt | K.o. | ❌ | Ein statischer Hinweistext im Watchlist-Panel; keine Hooks in mail_send/CRM |
| 2c | Betroffenenrechte geraeteuebergreifend (Sperrliste, Suche) | K.o. | ❌ | Kein Personen-Tombstone, keine Sperrliste, keine Auskunftsroute; 7 nur-lokale Personenbestaende |
| 2d | Art.-9-Filter technisch | K.o. | ❌ | Kein Filter; einziger „religion"-Treffer ist ein OSM-Firmenfilter |
| 2e | Loeschfristen als Admin-Policy | Muss | ◐ | Employment-TTL 120 d (producer-getriggert, nicht zentral), Person nie, nicht je Tenant |
| 2f | Sperrliste ins VVT, eigene Frist | Muss | ❌ | Sperrliste existiert nicht |
| 3a | Bring-your-own-Endpoint (Azure OpenAI EU, vLLM, eigener AVV) | K.o. | ◐ | 8 Provider, 3 fest verdrahtete OpenAI-kompatible; **keine freie Base-URL fuer `openai`, kein Azure** |
| 3b | Verarbeitungsort je Feld | Muss | ◐ | `llmTier`+`llmModel` nur je (Firma, Stage) in ContentFreshness; Observation ohne Modell/Provider/Ort |
| 3c | Fakt vs. Interpretation als Feldtyp | Muss | ❌ | Nur `confidence`; Urteile in Extra-Tabellen, UI ohne Kennzeichnung |
| 4a | Enterprise-Verteilkanal (MSI/PKG, Intune/Jamf, EV, Notarisierung) | K.o. | ◐ | macOS signiert+notarisiert; **Windows unsigniert**, nur NSIS, kein MSI/PKG, Linux ohne CI |
| 4b | Update-Kontrolle (Admin, Staging-Ring, kein Auto-Update) | K.o. | ❌ | autoDownload + autoInstallOnAppQuit, Check alle 15 min, Kanaele wirkungslos, **GitHub-PAT im Binary** |
| 4c | Netzwerkdoku, Proxy inkl. NTLM/Kerberos, TLS-Inspection | Muss | ❌ | Node-fetch ignoriert System-Proxy; kein Custom-CA-Pfad; keine Zielliste |
| 4d | EDR-Verhaltensprofil + Allowlist | Muss | ❌ | Versteckte Chromium-Fenster mit Stealth-Injection, 6 Node-Subprozesse, Selenium+User-Chrome, Watchdog mit SIGKILL, `taskkill /F` im Installer |
| 4e | Verschluesselter Store, Remote-Wipe | Muss | ◐ | Secrets via safeStorage; PGlite/Medien/Logs Klartext; kein Remote-Wipe |
| 5 | Self-hosted Server-Modus | K.o. (≥10 Nutzer) | ◐ | Substrat ist containerisierbar (Dockerfiles, dev-compose), kein sovereign-compose, kein Worker, Desktop-Endpunkte hart codiert |
| 6a | SSO Entra ID, SCIM, Lizenz ueber Gruppen | K.o. | ❌ | Keycloak 20 (EOL), Registrierung offen, kein Brokering, kein SCIM, kein MFA |
| 6b | Zentrales manipulationssicheres Audit-Log, SIEM-Export | K.o. | ◐ | AuditLog je Request (Metadaten), keine Fach-Events, keine Hash-Kette, keine Retention, keine Leseroute |
| 6c | Rollenmodell mit Modul-Berechtigungen | Muss | ◐ | owner/admin/member, Features nur tenant-weit |
| 6d | Zentrales Konfigurationsmanagement (gesetzt, nicht empfohlen) | Muss | ◐ | TenantPolicy ohne Version/Historie; providerLock/Modelle nicht durchgesetzt (O5 offen) |
| 7a | CRM nur dedizierte Felder mit Provenienz | Muss | ❌ | HubSpot-Standard-Properties, Ueberschreiben nach Bestaetigung, keine Quelle/Datum/Modell im CRM |
| 7b | Export pro Person/Nutzer/global | Muss | ❌ | Nur Import-Report (xlsx) und lokaler Verlauf (json) |
| 7c | REST/OData + Webhooks | Muss | ◐ | OpenAPI 3.1 am Gateway; nur JWT, keine API-Keys, keine ausgehenden Webhooks |
| 8a | AVV mit TOM | K.o. | ❌ | Nicht im Repo |
| 8b | Compliance-Unterlagen (VVT, TOM, DSFA, Interessenabwaegung, Matrix) | K.o. | ❌ | `docs/compliance/` existiert nicht |
| 8c | Exit/Escrow, SBOM/CVE, SLA | Muss | ❌ | Keine SBOM in CI, kein Dependabot, kein SECURITY.md |
| 9 | Marketing-Claims | — | ◐ | Website nicht im Repo (`WEBSITE_PROMPT_COMPLIANCE.md` steuert sie); README behauptet weiter „keine fremden Server" |

### 1.1 Nebenbefunde (nicht in der Liste, aber jeder Security-Fragebogen findet sie)

| Befund | Beleg | Massnahme |
|---|---|---|
| GitHub-PAT (`SUBMODULES_PAT` → `AVA_RELEASE_TOKEN`) wird in jedes Desktop-Binary eingebacken | `services/desktop/electron.vite.config.ts:43-46`, `src/main/updater.ts:125-128` | Generic-Update-Feed (E4.2), PAT entfernen, Token rotieren |
| Windows-Builds unsigniert | `.github/workflows/desktop-release.yml:27-29` | EV/Azure Trusted Signing (E4.1) |
| JWT-Audience-Pruefung standardmaessig aus | `services/db-gateway/src/middleware/auth.ts:135-153` | `JWT_AUDIENCE_STRICT=1` Default |
| Keycloak 20.0.3 (EOL), Admin-Passwort-Default `admin` in `fly.toml`, Registrierung offen, kein MFA, keine Passwort-Policy | `infra/keycloak/Dockerfile:27`, `infra/keycloak/fly.toml:51-52`, `infra/scripts/keycloak-config.mjs:97-110` | E0 |
| Nutzer-LLM-Key transitiert das Gateway bei Excel-Import (`X-Ava-User-Llm-Key`) | `services/desktop/src/main/agent/gateway-client.ts:73-80`, `services/db-gateway/src/lib/upstream.ts:13-27` | Pfad pruefen: fuer Organisationen Org-Key (O4) statt Nutzer-Key; sonst dokumentieren |
| `rejectUnauthorized: false` im website-Producer | `website/src/infrastructure/di.ts:104-106` | entfernen, Custom-CA-Pfad (E4.3) |
| `AuditLog.requestHash`/`errorMessage` nie befuellt | `services/db-gateway/src/middleware/audit.ts:36-48` | E1.3 |
| Personen-Radar-Route ohne `requireFeature("linkedin.radar")` | `routes/v1/discovery.ts` (`/candidates/direct`) | E1.1 |
| Zweiter, aelterer `Contact`-Bestand in der Evaluation-DB ohne Quelle/Tenant | `company-evaluation/prisma/schema.prisma:418-450` | in Loesch-/Sperrpfad (E2.4) einbeziehen |
| Feed-Rohposts, `raw_html` (64 kB), Kommentar-Volltexte, Bilder lokal ohne Alters-Retention | `services/desktop/src/main/linkedin/db.ts:72-107` | E1.5 |
| Doku D4 („Embeddings OpenAI") und Memory-Notiz („company-evaluation braucht OPENAI_API_KEY") veraltet: Embeddings laufen lokal (Ollama `embeddinggemma`, v0.1.184), Evaluation-Boot ohne Key | `services/desktop/src/main/index.ts:692-693`, `company-evaluation/src/infrastructure/di.ts:16-22` | Doku korrigieren |

---

## 2. Einordnung: Was ist wirklich einschneidend?

Nicht jeder Punkt ist Arbeit; einige aendern, *was AVA ist*. Diese
Aenderungen muessen vor der Umsetzung entschieden werden (Abschnitt 3).

**A. „Lokal" wird zu „unter Kundenkontrolle".** Die Compute-Lokalitaets-
Invariante (LLM + Scraping auf der Nutzer-Maschine) bleibt technisch,
aber das Versprechen aendert sich: Im Enterprise-Bild liegen geteilter
Bestand, Audit, Sperrliste, Policies und optional der Worker im
Rechenzentrum des Kunden. Der Laptop wird Client. Das ist die Version
von „lokal", die der Gutachter meint, und sie widerspricht dem heutigen
README („keine fremden Server").

**B. Der LinkedIn-Feed-Beobachter wird Enterprise-Default AUS und
verliert die Bildanalyse fuer Personen-Posts.** Das Modul bleibt fuer
Einzelnutzer und kleine Teams. Fuer Organisationen ist die Reihenfolge:
aus, per Operator- oder Admin-Policy an, Konsequenz dokumentiert. Die
Bildanalyse fuer Posts natuerlicher Personen entfaellt als Produktgrenze
(nicht als Einstellung); Posts von Unternehmensseiten koennen bleiben.
Ein Dealfront-/Cognism-Konnektor ersetzt das Signal fuer Konzerne, nicht
fuer den Rest.

**C. Der geteilte Personen-Bestand bekommt eine Tenant-Ebene.** Heute
ist eine Person global (Firmenwissen kopieren wir bewusst nicht). Der
zweistufige Bestand verlangt aber einen protokollierten Uebergang je
Verantwortlichem. Loesung ohne Bruch: Der geteilte Bestand *ist* die
Sichtungsstufe (kurze globale Frist), die Uebernahme in den
Arbeitsbestand ist ein **tenant-scoped Claim** (`PersonTenantState`)
mit Art.-14-Pflichten. Die Person bleibt eine Zeile; der Status ist je
Tenant. Loeschung/Widerspruch bleibt global (Entscheidung 2026-09-03).

**D. Auto-Update wird fuer Organisationen abgeschaltet.** Damit
entsteht Versionsdrift zwischen Gateway und Clients. AVA braucht eine
N-2-Kompatibilitaetsregel am Gateway und ein Support-Fenster. Das ist
kein Code-, sondern ein Betriebsversprechen.

**E. Desktop-Ereignisse werden an den Tenant gemeldet.** Ein
zentrales Audit-Log („welcher Nutzer, welche Quelle, welches Modell,
welche Felder") erfordert, dass der Desktop Metadaten seiner lokalen
Aktionen hochspielt. Das kollidiert mit „Chats bleiben lokal" nur, wenn
Inhalte mitgehen. Regel: **Metadaten ja, Inhalte nie** (Tool-Name,
Quell-Domain, Modell-ID, Feldnamen, Zeit), und nur fuer
Organisations-Tenants.

**F. Keycloak wird zur Enterprise-Komponente.** Entra-Brokering, SCIM,
MFA und Gruppen-Lizenzierung setzen ein aktuelles Keycloak (26.x, Fly
laeuft 20.0.3), geschlossene Registrierung fuer Organisations-Realms und
eine Rollen-Synchronisation voraus. Die Selbstregistrierung bleibt fuer
den SaaS-Pfad.

**G. Das Marketing-Versprechen dreht sich.** „DSGVO-konform" wird
„unterstuetzt den DSGVO-konformen Einsatz" plus Verantwortungsmatrix.
Das ist ein Text, aber es ist die Aenderung, die am meisten Vertrauen
kostet, wenn sie *nicht* passiert.

---

## 3. Entscheidungen, die vor der Umsetzung fallen muessen

| # | Frage | Empfehlung |
|---|---|---|
| E-1 | LinkedIn-Feed-Beobachter: (a) fuer Organisationen ganz entfernen, (b) Default aus + Operator-Sperre, (c) wie heute | **(b)**. Zusaetzlich (b'): Bildanalyse fuer Personen-Posts als Produktgrenze streichen, nur Unternehmensseiten-Posts. |
| E-2 | Lizenzierter Datenanbieter: Dealfront-Konnektor bauen? | Ja, aber als **Adapter auf die vorhandene Capability-Schicht**, nach den K.o.-Punkten; braucht Partnervertrag zuerst. |
| E-3 | Zweistufiger Bestand: Status je Tenant (Claim) oder Bestand je Tenant kopieren? | **Claim je Tenant** (Abschnitt 2C), geteilter Bestand bleibt. Im souveraenen Betrieb ist der Bestand ohnehin je Kunde. |
| E-4 | Sichtungsfrist global: 30 Tage ohne Claim → Tilgung? Arbeitsbestand: 180 Tage nach letzter Beobachtung (bestehende Entscheidung)? | **30 / 180**, je Tenant nach unten aenderbar, nie nach oben. |
| E-5 | Sperrliste: Hash ueber normalisierte Profil-URL UND Namensform ohne companyId? Frist der Sperrliste? | Beide Hashes. **Frist 3 Jahre**, dann Erneuerung durch erneuten Widerspruch; VVT-Eintrag. |
| E-6 | Art.-9-Filter: nur deterministisch (Lexikon) oder Lexikon + lokales Modell? | **Lexikon zuerst, lokales Modell als zweite Stufe**; Verworfenes wird gezaehlt, nie gespeichert. |
| E-7 | Bring-your-own-Endpoint: generischer Kind `openai-compatible` + `azure-openai`; Tier fuer Fremdmodelle vom Admin gesetzt? | Ja; **Admin setzt Tier je Endpunkt** (Default B), sonst Persist-Sperre. |
| E-8 | Update-Kontrolle: Generic-Feed selbst hosten (Gateway liefert `latest.yml`) oder oeffentliches Release-Repo? | **Generic-Feed am Gateway** (auch souveraen nutzbar), GitHub-PAT verschwindet. |
| E-9 | Verschluesselter Store: (a) Geraeteverschluesselung pruefen + dokumentieren, (b) PGlite ersetzen durch SQLCipher | **(a)** jetzt, (b) nicht. PGlite hat keine Verschluesselung; ein Wechsel waere ein Monatsprojekt ohne Enterprise-Mehrwert gegenueber FileVault/BitLocker + Keychain. |
| E-10 | Server-Modus: (A) souveraenes Substrat + Desktop-Clients, (B) zusaetzlich AVA-Worker (headless Producer/Scheduler), (C) Web-Client | **A zuerst, B danach**, C nicht. |
| E-11 | SCIM: Keycloak-Extension oder minimaler SCIM-2.0-Endpunkt im Gateway? | **Gateway** (`/scim/v2/Users`, `/Groups`), da Keycloak-Admin-Client dort schon existiert. |
| E-12 | Rollen: `owner/admin/member` + `lead` (Vertriebsleitung)? Berechtigungen je Modul je Rolle? | Ja; `features` wird `Record<Feature, "off"\|"admin"\|"lead"\|"all">`. |
| E-13 | CRM-Schreibmodus: dedizierte `ava_*`-Properties als Enterprise-Default, Standardfelder nur „wenn leer" per Policy | Ja. |
| E-14 | OData: bauen? | **Nein**; REST + OpenAPI + ndjson-Export + Webhooks. OData als spaeterer Adapter, falls eine Ausschreibung es hart verlangt. |
| E-15 | Elasticsearch im souveraenen Betrieb: mitliefern oder Postgres-Volltext in master-data? | **Mitliefern** (offizielles Image), Postgres-Fallback nicht bauen. |

---

## 4. Arbeitspakete

Notation: **Gw** Gateway · **Dt** Desktop · **Pr** Producer · **Inf** Infra ·
**Doc** Dokument. Aufwand in Entwicklertagen (ohne Review/Deploy).

### E0 — Hygiene und Sofortmassnahmen (≈ 5 Tage, parallelisierbar)

Kein K.o.-Punkt, aber jeder ist ein Fragebogen-Treffer.

| # | Massnahme | Wo | Tage |
|---|---|---|---|
| E0.1 | `JWT_AUDIENCE_STRICT` Default an; Fehlerpfad testen | Gw `middleware/auth.ts` | 0,5 |
| E0.2 | Keycloak auf 26.x heben (Fly + dev-compose angleichen), Admin-Passwort aus `fly.toml` (Fly-Secret), Brute-Force-Schutz, Passwort-Policy, optional TOTP | Inf `infra/keycloak/*`, `infra/scripts/keycloak-config.mjs` | 1,5 |
| E0.3 | `requestHash` (sha256 des Bodys) und `errorMessage` im AuditLog befuellen | Gw `middleware/audit.ts` | 0,5 |
| E0.4 | `requireFeature("linkedin.radar")` an `/discovery/candidates/direct`; `requireFeature` an `/v1/proxy/apify/*` fuer `kontakte`/`linkedin.*` | Gw | 0,5 |
| E0.5 | `rejectUnauthorized:false` entfernen | Pr `website/src/infrastructure/di.ts` | 0,25 |
| E0.6 | Consent-Modal: Satz zur Arbeitgeber-Verantwortung; Consent-Zeitstempel als Audit-Event an den Tenant (nach E1.3) | Dt `LinkedInConsentModal.tsx`, `linkedin/index.ts` | 0,5 |
| E0.7 | README/DECISIONS korrigieren: D4 (Embeddings lokal), Compute-Lokalitaet ehrlich (Abschnitt 0 des Compliance-Plans), „keine fremden Server" streichen | Doc | 0,5 |
| E0.8 | `docs/compliance/DATENFLUSS.md` = Tabelle „Was verlaesst den Rechner" (C6) inkl. `PromptAudit` und `X-Ava-User-Llm-Key` | Doc | 0,5 |
| E0.9 | GitHub-PAT aus dem Binary: Zwischenloesung Release-Repo oeffentlich lesbar ODER E4.2 vorziehen | Inf | 0,5 (bzw. E4.2) |

### E1 — Policy-Durchsetzung, Operator-Ebene, Audit-Log [K.o. 1a, 6b, 6d] (≈ 15 Tage)

**E1.1 Signierte, ablaufende Policy (Dt+Gw, 3 Tage).**
- Gw signiert die Policy (Ed25519, Schluessel als Secret; souveraen: Kunde) und liefert `{policy, version, issuedAt, expiresAt, signature}` in `/whoami` und `GET /v1/tenants/me/policy`.
- Dt verifiziert mit eingebettetem Public Key (bzw. Konfigurationswert im souveraenen Betrieb), speichert nur verifizierte Policies; `org-policy.json` wird zur Cache-Datei mit Signatur.
- **Fail-closed fuer Organisationen:** nach `expiresAt` + 24 h Karenz ohne erfolgreichen Refresh fallen alle personenbezogenen Module (`linkedin.*`, `bildanalyse`, `kontakte`, `mail`) auf AUS. Persoenliche Tenants unveraendert.
- Einschneidend: Offline-Arbeit mit LinkedIn-Modulen endet fuer Organisationen nach einem Tag. Bewusst.

**E1.2 Operator-Ebene (Gw+Dt, 2 Tage).**
- Keycloak-Realm-Rolle `ava-operator` → Scope `operator:admin`.
- `TenantPolicy.locks: string[]` (Feature-Keys, die nur der Operator aendern darf) + `TenantPolicy.operatorDefaults`. Owner/Admin sehen gesperrte Schalter read-only mit Hinweis.
- Routen `GET/PUT /v1/operator/tenants/{id}/policy`, `GET /v1/operator/tenants`. Im souveraenen Betrieb ist der Operator der Kunden-IT-Admin; damit ist „Admin-Policy, die der Client nicht ueberschreibt" fuer beide Betriebsformen gleich.
- Enterprise-Default beim Anlegen einer Organisation vom Kind `enterprise` (E6.4): `linkedin.*=off`, `bildanalyse=off`, Locks gesetzt.

**E1.3 Fachliches, manipulationssicheres Audit-Log (Gw, 5 Tage).**
- Neue Tabelle `AuditEvent(id, tenantId, actorId, ts, category, action, subject, sourceKind, sourceRef, modelId, provider, processingLocation, fieldsWritten JSON, meta JSON, prevHash, hash)`; `hash = sha256(prevHash‖kanonisches Event)` **je Tenant** verkettet.
- Postgres-Rolle `audit_writer` ohne UPDATE/DELETE; Trigger verhindert Aenderung; taeglicher Anker (Root-Hash je Tenant) wird in `AuditAnchor` geschrieben und optional signiert/ausgegeben (Kunde kann Anker extern ablegen).
- Emitter an allen Organisationsvorgaengen (Beitritt, Rolle, Policy-Diff alt→neu, Schluessel gesetzt/geloescht, Einladungslink), am Persist-Bus (welche Stage, welche Felder je Firma/Person, Modell, Provider, Ort), an Proxy-Aufrufen (Modell, Zweck), an Loesch-/Sperr-/Claim-Vorgaengen (E2).
- Retention `TenantPolicy.audit.retentionDays` (Default 365, Minimum 90), Purge-Job mit eigenem Anker-Event.
- Leseroute `GET /v1/tenants/me/audit?since&until&category&format=json|ndjson|cef` (owner/admin/lead), Operator-Variante je Tenant.
- Bestehendes `AuditLog` (Request-Metadaten) bleibt als technisches Log.

**E1.4 Desktop-Ereignisse an den Tenant (Dt, 3 Tage).**
- Fuer Organisations-Tenants spielt der Desktop Metadaten aus dem lokalen Audit-Store hoch (Batch, Outbox, Retry): Tool-Aufrufe (Name, Ziel-Typ, Objekt-ID), besuchte Quellen (Domain), verwendetes Modell/Provider/Ort, CRM-Schreibvorgaenge (Feldnamen), Consent-Zeitstempel, Policy-Empfang (Version). **Nie Inhalte, nie Prompts.**
- Local-only-Kategorien (`agent.claim.unverified`, Self-Corrections) bleiben lokal.
- Datenfluss-Tabelle und Consent-Text werden entsprechend ergaenzt.
- Einschneidend: `audit:purgeAll` lokal bleibt erlaubt, wirkt aber nicht auf den Tenant-Spiegel.

**E1.5 Feed-Beobachter: Rohdaten-Verzicht und Bildanalyse-Grenze (Dt, 2 Tage).** [K.o. 1b]
- `raw_html`, Kommentar-Volltexte und Medien werden nach der Signal-Extraktion verworfen; es bleiben Anlass (Typ, Datum, Firma, Link, Zusammenfassung). Debug-Runs mit Feed-HTML nur bei explizit aktiviertem Debug-Modus, 24-h-TTL.
- Bildanalyse nur fuer Posts, deren Autor ein `linkedin_actor` vom Typ Unternehmensseite ist; Personen-Posts werden nicht an ein Vision-Modell gegeben, unabhaengig von lokal/Cloud. UI-Text und Datenfluss-Tabelle entsprechend.
- Alters-Retention fuer die lokale LinkedIn-DB (`TenantPolicy.retention.linkedinSignalsDays`, Default 90).

**E1.6 SIEM-Export (Gw, Doc, 1 Tag).** ndjson/CEF-Route aus E1.3 plus Anleitung fuer Microsoft Sentinel (Logs Ingestion API / Data Collection Rule) und generisches Syslog-Forwarding per Sidecar im souveraenen Compose.

### E2 — Personen-Datenmodell und DSGVO-Mechanik [K.o. 2a–2d, Muss 2e–2f] (≈ 22 Tage)

**E2.1 Provenienz je Wert (Pr+Gw, 3 Tage).** [Muss 3b]
- `Observation` + `Fact`: `llmProvider`, `llmModel`, `llmTier`, `processingLocation: local|customer|external`, `externalVendor`, `tenantId`, `actorId` (Backfill NULL).
- Producer stempeln in den vier `compute-worker.ts` neben `llmModel` auch Provider und Ort (`getCurrentModel()` liefert den Provider bereits; Ort: `ollama`→local, `openai-compatible` mit `location`-Flag aus Konfiguration→customer, sonst external).
- Persist-Bus reicht die Felder bis `createObservationIdempotent` durch; `ContentFreshness` bekommt dieselben Spalten.

**E2.2 Fakt vs. Interpretation (Pr+Gw+Dt, 3 Tage).** [Muss 3c]
- `Observation.kind: extracted | derived | inferred` (Enum). Extraktions-Prompts liefern nur `extracted`; Website-Urteil, Best-Match-Erklaerung, Radar-Ausloeser-Rolle, LinkedIn-Signal-Zusammenfassung sind `inferred`.
- UI: Badge je Wert („Quelle" vs. „Einschaetzung des Modells"), getrennte Bloecke auf der Firmenseite; Chat-Tools liefern `kind` mit, Systemprompt verbietet, `inferred` als Fakt zu formulieren.
- CRM-Export schreibt standardmaessig nur `extracted` (E7.1).

**E2.3 Zweistufiger Bestand (Gw+Dt+Pr, 5 Tage).** [K.o. 2a]
- Geteilter Bestand = Sichtung: `Person.lastSeen` (neu), globale Sichtungsfrist 30 Tage ohne Claim (E-4) → Tilgung durch zentralen Cron (heute existiert nur der producer-getriggerte Employment-Sweep).
- `PersonTenantState(tenantId, personId, state: sichtung|arbeitsbestand, claimedAt, claimedBy, informedAt, informedVia, expiresAt)`; Uebernahme ist explizit: Chat-Tool `person_uebernehmen` (confirmAction), Button auf der Kontaktkarte, Bulk je Firma. Jeder Uebergang = AuditEvent.
- Sichtung ist in der UI sichtbar reduziert (Name, Rolle, Firma, Quelle, Stand-Datum, Restfrist); Anreicherung (LinkedIn-Nachschlag, Watchlist-Add, CRM-Export, Mail an die Person) nur im Arbeitsbestand → Tools pruefen den Status.
- Arbeitsbestand: `expiresAt = lastSeen + 180 d` (je Tenant nach unten einstellbar), Tilgung durch denselben Cron, Vorwarnung als Alert.
- Einschneidend: Heutige Nutzer sehen Kontakte weiterhin, koennen aber ohne Uebernahme nichts damit tun. Migration: bestehende Kontakte verarbeiteter Firmen werden fuer persoenliche Tenants automatisch als Arbeitsbestand mit `informedAt = null` uebernommen; Organisationen starten leer in der Arbeitsstufe.

**E2.4 Personen-Loeschung, Tombstone, Sperrliste (Gw+Dt+Pr, 5 Tage).** [K.o. 2c]
- `DELETE /v1/persons/{id}` (owner/admin/lead des erhebenden Tenants, Operator): loescht Person, Employment, Facts, Observations, `meta.ausloeser`-Eintraege an Discovery-Kandidaten, den Evaluation-`Contact`-Zwilling; schreibt `PersonTombstone`.
- `PersonBlock(hashKind: url|name, hash, reason: widerspruch|loeschung|manuell, createdAt, expiresAt, createdByTenant)`; Hashes = sha256(kanonische Profil-URL) und sha256(`nameIdentityForm(fullName)`) **ohne companyId** (heutiger `identityKey` ist firmengebunden und deshalb als Sperrschluessel ungeeignet). Frist 3 Jahre (E-5).
- Persist-Nadeloehr (`observation.ts`, `contact-extraction-apply.ts`) und Discovery-Direct-Route prüfen die Sperrliste vor dem Schreiben; Producer pruefen zusaetzlich vor dem LLM-Schritt (Sperrliste als Bloom-Filter/Hash-Set an den Producer, spart Tokens).
- **Verteilung an Clients:** `GET /v1/blocklist?since=` (nur Hashes); Desktop zieht sie mit jedem `/whoami`-Refresh und tilgt lokal in Watchlist, Radar-Stores, LinkedIn-Akteuren/-Signalen, Mail-Absenderindex, Agent-Memory-Eintraegen mit Personenbezug (Suche ueber Namensform) und weigert sich, gesperrte Profile erneut aufzunehmen. Lokaler Vollzug wird als AuditEvent gemeldet (E1.4).
- Chat-Tool `person_loeschen` / `person_widerspruch` (confirmAction, Klasse mit Rueckfrage).

**E2.5 Auskunft Art. 15 (Gw+Dt, 2 Tage).**
- `GET /v1/persons/{id}/herkunft` (JSON + Markdown/PDF): alle Facts/Observations mit Quelle, Beleg, Zeitpunkt, erhebender Tenant/Akteur, Modell/Provider/Ort, Claim-Status, Informiert-am.
- Suche ueber alle Instanzen: zentral ueber Namensform/Profil-URL; **lokale Bestaende** werden ueber einen **Personen-Index je Tenant** erfasst: der Desktop meldet fuer Organisationen die Identitaetsschluessel (nur Hashes + Fundstelle-Typ, z. B. `watchlist`, `linkedin_actor`, `mail_sender`) an `PersonLocalIndex(tenantId, actorId, hash, storeKind, lastSeen)`. Die Auskunft listet damit auch „Laptop von Nutzer X, Watchlist" und stoesst dort per Policy-Push die Auskunft/Loeschung an.
- Einschneidend: Der Tenant sieht, welche Personen auf welchem Geraet in welchem lokalen Store vorkommen (nur Hashes, kein Inhalt). Ohne diesen Index ist die geraeteuebergreifende Auskunft nicht ehrlich moeglich.

**E2.6 Art.-14-Workflow (Dt+Gw, 3 Tage).** [K.o. 2b]
- `TenantPolicy.art14 = { mode: attach|link, text, url }`; Standardtext + VVT-Verweis aus `docs/compliance/`.
- Hooks in `mail_send/reply/forward` (Empfaenger im Arbeitsbestand ohne `informedAt` → Informationstext wird angehaengt bzw. verlinkt; ohne Policy-Text wird der Versand verweigert), im CRM-Contact-Create/-Sync (Notiz + Property `ava_informiert_am`), bei LinkedIn-Watchlist-Add (Hinweis, dass Beobachtung erst nach Information zulaessig ist, sofern Policy `art14.requireBeforeWatch`).
- `PersonTenantState.informedAt/informedVia` wird gesetzt und als AuditEvent protokolliert; Chat-Tool `person_informiert_markieren` fuer Kontakte ausserhalb von AVA (Telefonat).
- Einschneidend: Mails an nicht informierte Personen gehen nicht mehr ohne Anhang raus. Das ist der Zweck.

**E2.7 Art.-9-Filter (Pr+Dt+Gw, 3 Tage).** [K.o. 2d]
- Modul `packages/pii-guard` (geteilt): deutsches/englisches Lexikon fuer Gewerkschaft, Politik/Partei, Religion, Gesundheit, Sexualitaet, Ethnie; Regex + Wortstamm; zweite Stufe lokales Modell (Klassifikation je Textabschnitt) mit derselben Halluzinationssperre wie im Tech-Stack-Plan (Treffer muss woertlich vorkommen).
- Einsatzpunkte: `prompt-rules.ts` (Website/People/SERP-Extraktion, vor dem LLM), LinkedIn-`extractor.ts` (Topics/Entities), Radar-`matching.ts` (Headline), Kommentar-Auszug im Radar-Supervisor, Gateway-Nadeloehr als zweite Linie (Wertepruefung vor `createObservation`).
- Verworfenes wird gezaehlt (`AuditEvent art9.dropped`, Kategorie, Quelle), nie gespeichert.

**E2.8 Retention als Policy (Gw+Dt, 1 Tag).** [Muss 2e, 2f]
- `TenantPolicy.retention = { sichtungDays, arbeitsbestandDays, employmentDays, linkedinSignalsDays, auditDays, blocklistYears }` mit Operator-Locks; Nutzer koennen nichts verlaengern; Chat-Tool read-only fuer Mitglieder, Admin-Tool zum Verkuerzen.
- VVT-Muster (E8) fuehrt die Sperrliste als eigene Verarbeitung.

### E3 — Modelle und Verarbeitung [K.o. 3a] (≈ 8 Tage)

**E3.1 Bring-your-own-Endpoint (Pkg+Pr+Dt+Gw, 4 Tage).**
- `packages/ai-provider`: Kinds `openai-compatible` (`baseURL`, `apiKey`, `model`, `headerStyle: bearer|api-key`, `extraHeaders`, `location: customer|external`) und `azure-openai` (`resource`, `deployment`, `apiVersion`, `api-key`), Env `LLM_BASE_URL`, `LLM_HEADER_STYLE`, `AZURE_OPENAI_*`; Provider-Name im `getCurrentModel()`.
- Katalog: Fremdmodelle bekommen Tier aus der Konfiguration (Admin setzt, Default B), `hasVision` als Flag.
- Desktop: neuer Provider-Typ in Store/UI/Validate-Key; Producer-Env entsprechend (`producer-supervisor.ts`).
- Gateway-Proxy (O4): `TenantProvider.kind = "custom"` mit eigener Upstream-URL, damit ein Endpunkt zentral fuer alle Mitglieder gilt.

**E3.2 Modellvorgabe durchsetzen (Dt, O5, 3 Tage).**
- `providerLock`, `chatModel`, `producerModel`, erlaubte Provider-Liste (`policy.llm.allowedKinds`, `policy.llm.allowLocal`) werden im Provider-Manager und im Producer-Supervisor angewendet; Einstellungen read-only; Chat-Provider-Tools gesperrt; Auth-Art `organisation` fuer den O4-Proxy.
- Datenklassen-Routing (C4.2) in der Minimalform: `policy.llm.personData: local|customer|any` steuert, welche Kinds fuer `company-contact`, LinkedIn-Extraktion und Mail-Triage erlaubt sind.

**E3.3 Datenfluss-Anzeige je Anbieter (Dt, 1 Tag).** Einstellungen → Modelle zeigt je Anbieter Ort, Vertragspartner (Nutzer-Key/Org-Key/Operator), erhaltene Datenklassen.

### E4 — Deployment und Endpoint [K.o. 4a, 4b; Muss 4c–4e] (≈ 14 Tage + externe Leistungen)

**E4.1 Verteilkanal (Inf, 4 Tage + Zertifikat).**
- Windows: Code-Signing mit EV oder Azure Trusted Signing (Antrag ist eine externe Leistung, 2–4 Wochen Vorlauf); Targets `nsis` + `msi` (electron-builder/WiX; `perMachine`, `/qn`-Silent, Properties `AVA_GATEWAY_URL`, `AVA_AUTH_ISSUER`, `AVA_UPDATE_MODE`); `installer.nsh` ohne `taskkill /F` (Graceful-Close mit Timeout).
- macOS: Target `pkg` (signiert, notarisiert) fuer Jamf; `com.eprox.ava` Managed Preferences (Abschnitt E4.3).
- Doku: Intune (`.intunewin`, Detection-Rules), Jamf (PKG + Config-Profile), SHA-256-Manifest je Release, Provenance-Attestation in CI.

**E4.2 Update-Kontrolle (Gw+Dt+Inf, 4 Tage).**
- Generic-Update-Feed am Gateway (`/v1/updates/{channel}/latest.yml` + Assets oder Redirect), Ringe `stable|staging`, Operator pinnt je Tenant `TenantPolicy.update = { mode: auto|pinned|ring, version, ring }`.
- Desktop-Updater liest die Policy vor jedem Check; `pinned` → nur die freigegebene Version, kein Auto-Download; `autoInstallOnAppQuit` nur bei `auto`; Kanal-Setting wird wirksam (`autoUpdater.channel`).
- GitHub-PAT verschwindet aus dem Binary; Release-Assets werden vom Feed bereitgestellt (souveraen: Kunde spiegelt sie).
- Gateway-Kompatibilitaetsregel: N-2 Desktop-Versionen; `/whoami` meldet `minSupportedVersion`, aeltere Clients bekommen einen Hinweis statt Fehlern.

**E4.3 Konfiguration ohne Rebuild (Dt, 2 Tage).**
- Lade-Reihenfolge: Managed Preferences (macOS plist `/Library/Managed Preferences/com.eprox.ava.plist`, Windows `HKLM\Software\Policies\eproX\AVA`) → `ava.config.json` neben der App bzw. in `ProgramData`/`/Library/Application Support/AVA` → Env → Defaults. Felder: Gateway-URL, Issuer, Client-ID, Update-Modus, Proxy, Extra-CA, Feature-Locks-Public-Key.
- Producer erhalten `GATEWAY_URL` aus `APP_CONFIG`, nicht aus Prozess-Env (heutige Inkonsistenz `producer-supervisor.ts:705`).

**E4.4 Proxy und TLS (Dt+Pr, 3 Tage).**
- Main-Prozess: Gateway-, Auth- und Provider-Aufrufe auf Electron `net.fetch` (Chromium-Stack: System-Proxy, PAC, NTLM/Kerberos, OS-Zertifikatsspeicher) umstellen, wo Streaming es zulaesst; sonst undici `EnvHttpProxyAgent` aus `session.resolveProxy`.
- Producer: Desktop setzt `HTTPS_PROXY/NO_PROXY` und `NODE_EXTRA_CA_CERTS` (aus Managed Config oder OS-Store-Export) in die Kind-Env; Selenium nutzt Nutzer-Chrome (bereits proxy-faehig).
- Kein Cert-Pinning (ist heute so, wird dokumentiert).
- `docs/compliance/NETZWERK.md`: vollstaendige Zielliste mit Zweck, Richtung, Bedingung (nur mit Modul X / nur mit Nutzer-Key), aus Abschnitt 4 der Deployment-Erhebung.

**E4.5 EDR-Profil (Doc+Dt, 1 Tag).**
- `docs/compliance/EDR_PROFIL.md`: Prozessbaum (AVA, 6× `AVA --producer` mit `ELECTRON_RUN_AS_NODE`, `ollama serve`, whisper-cli, Watchdog-Node), Netzwerkverhalten, Dateipfade, Verhalten je Policy (ohne LinkedIn-Modul kein verstecktes Chromium-Fenster, keine Stealth-Injection), Allowlist-Vorlagen fuer Defender for Endpoint und CrowdStrike (Pfad + Publisher-Signatur).
- Stealth-Injection und Fingerprint nur laden, wenn `linkedin.beobachter` aktiv ist (heute: Modul-Import).

**E4.6 Lokaler Store und Remote-Wipe (Dt+Gw, 2 Tage).**
- Startpruefung Geraeteverschluesselung (FileVault/BitLocker via OS-API); Ergebnis als Device-Compliance in `/whoami`-Heartbeat; Policy `requireDiskEncryption` verweigert sonst den Start personenbezogener Module.
- Remote-Wipe: `TenantMember.wipeRequestedAt` (Admin/Operator/SCIM-Deprovisioning setzt es) → `/whoami` liefert `wipe: true` → Desktop loescht den Konto-Space, meldet Vollzug als AuditEvent, beendet sich. Zusaetzlich: Refresh-Fehler `account_disabled` loest bei `policy.wipeOnOffboarding` denselben Pfad aus; Offline-Token-Laufzeit fuer Organisationen auf 24 h.
- Klartext-Artefakte reduzieren: Producer-Screenshots und Logs mit 7-Tage-TTL, `raw_html` weg (E1.5).

### E5 — Self-hosted Server-Modus [K.o. 5] (≈ 12 Tage Stufe A, +30 Tage Stufe B)

**E5.1 Souveraenes Substrat (Inf+Gw, 6 Tage).**
- `infra/docker-compose.sovereign.yml` + Helm-Chart `infra/helm/ava-substrat`: db-gateway, master-data, Keycloak 26 (Realm-Import mit geschlossener Registrierung), RabbitMQ, Postgres, Elasticsearch (E-15), optional Ollama-Server (GPU), optional Syslog-Forwarder; Reverse-Proxy-Beispiel (Caddy/Traefik) mit Kunden-TLS.
- Dockerfiles fuer die vier Producer, die heute nur im Desktop vendored sind (fuer E5.3 und Cloud-Paritaet).
- Gateway: Stripe/Billing per `BILLING_DISABLED`, ValueSerp-Key als Kundenkonfiguration, `TENANT_SECRETS_KEY`/Policy-Signaturschluessel als Kunden-Secrets, Update-Feed (E4.2) lokal, `.env.sovereign.example` vollstaendig, Backup-/Restore-Runbook (pg_dump, ES-Snapshot, Keycloak-Export).
- Desktop: Endpunkte per Managed Config (E4.3); Login-Flow gegen Kunden-Keycloak; Ollama-/Whisper-Modellquellen konfigurierbar (interner Spiegel statt ollama.com/huggingface).
- Einschneidend: Compute-Lokalitaets-Notiz wird „Kunde betreibt Substrat *und* den einen Operator-Dienst (ValueSerp) mit eigenem Key".

**E5.2 Zentraler Personen-Index (siehe E2.5) und Audit (E1) sind die Voraussetzung dafuer, dass Stufe A die Punkte „geraeteuebergreifende Betroffenenrechte" und „zentrales Audit-Log" wirklich abdeckt.** Ohne E1/E2 ist das Substrat nur ein anderer Standort fuer dieselben Luecken.

**E5.3 AVA-Worker (Stufe B, ≈ 30 Tage).**
- Extraktion `packages/core` aus `services/desktop/src/main` hinter Interfaces (`CredentialStore`, `Paths`, `Notifier`, `ProcessSpawner`); 78 Dateien importieren `electron`, 20 nutzen `safeStorage`, 20 `BrowserWindow`. Der Plan aus `PLANS_server_deployment.md` Phase 1 gilt, aber mit Tenant statt Single-User.
- `services/worker`: headless Producer-Set + Scheduler (Heartbeat, Watchlist, Personen-Radar, Link-Monitor, Discovery-Automatik) auf Tenant-Queues; PGlite-Stores werden zu Postgres-Schemata je Tenant; Desktop schaltet je Modul auf „laeuft auf dem Server" um.
- LinkedIn-Feed-Beobachter bleibt ausserhalb des Workers (Personenkonto, Chromium-Fenster); im Enterprise-Bild ist er ohnehin aus.
- Einschneidend: Erst damit gilt „Verfuegbarkeit unabhaengig vom Laptop-Zustand" und „gemeinsamer Wissensbestand" auch fuer Watchlist/Radar/Signale.

### E6 — Identity und Governance [K.o. 6a; Muss 6c, 6d] (≈ 12 Tage)

**E6.1 Entra-ID-Brokering (Inf+Gw, 3 Tage).** Keycloak-IdP `oidc` je Organisation (Kunden-Tenant-ID, Client-ID/-Secret als TenantProvider-Eintrag, Realm-Konfig per `keycloak-config.mjs` → Route `PUT /v1/operator/tenants/{id}/sso`), `login_hint`/`kc_idp_hint` aus Managed Config, JIT-Provisioning mit Gruppen-Mapper (Entra-Gruppe → `tenant:<slug>`, Rolle aus Gruppenname). Lokale Passwoerter fuer SSO-Tenants deaktiviert.

**E6.2 SCIM 2.0 im Gateway (Gw, 5 Tage).** `/scim/v2/Users`, `/scim/v2/Groups` mit Bearer-Token je Tenant (`TenantApiKey`, Scope `scim`), Mapping auf Keycloak-User (enable/disable/delete) und `TenantMember` (Rolle aus Gruppe); Deprovisioning setzt `wipeRequestedAt` (E4.6). Getestet gegen die Entra-Provisioning-Referenz.

**E6.3 Lizenzsteuerung ueber Gruppen (Gw, 1 Tag).** `TenantBilling.seats` + Zaehlung aktiver Mitglieder; Gruppe `ava-lizenz-<tier>` in Entra → Rolle/Sitz; Ueberschreitung blockt neue Mitglieder, nicht bestehende.

**E6.4 Rollenmodell (Gw+Dt, 3 Tage).** Rolle `lead` (Vertriebsleitung); `policy.features` wird `Record<Feature, "off"|"admin"|"lead"|"all">`; Tenant-Kind `enterprise` mit Operator-Defaults; Tenant-Sicht auf Transaktionen (T6) fuer `lead/admin`; Gateway-Guards und Desktop-Gates lesen die Rolle. Policy bekommt `version` + `TenantPolicyHistory` (jede Aenderung als Zeile + AuditEvent) — damit sind „Policies werden gesetzt, nicht empfohlen" und der Verlauf abgedeckt.

### E7 — Integration [Muss 7a–7c] (≈ 12 Tage)

**E7.1 CRM-Provenienzfelder (Dt, 4 Tage).** Property-Gruppe „AVA" in HubSpot (`ava_<feld>`, `ava_<feld>_quelle`, `ava_<feld>_abgerufen_am`, `ava_<feld>_konfidenz`, `ava_<feld>_modell`, `ava_informiert_am`), automatisch angelegt; `policy.crm.writeMode = dedicated|standard_if_empty|standard_overwrite` (Enterprise-Default `dedicated`); Sync schreibt nur `extracted`-Werte (E2.2), `inferred` nur als Notiz mit Kennzeichnung; Konfliktprotokoll als AuditEvent. Dynamics-Adapter als naechster (eigenes Konzept; OAuth-Proxy existiert), Salesforce danach.

**E7.2 Exporte (Gw+Dt, 4 Tage).** `GET /v1/persons/{id}/herkunft` (E2.5); `GET /v1/me/export` (Transaktionen, Claims, Audit des Nutzers) + lokaler Export-Bundle (Chats, Memory, Watchlist als JSON/ndjson) fuer Offboarding; `POST /v1/tenants/me/exports` (asynchroner Job → ndjson-Archiv aller Tenant-Daten inkl. Datenmodell-Beschreibung) fuer Vendor-Exit; Datenmodell als `docs/DATENMODELL.md` aus den Prisma-Schemata generiert.

**E7.3 API-Keys und Webhooks (Gw, 4 Tage).** `TenantApiKey(hash, scopes, expiresAt)` mit denselben Scopes wie JWT plus `scim`; `TenantWebhook(url, secret, events[])`, HMAC-signiert, Retry mit Backoff, Ereignisse `company.processed`, `person.claimed`, `person.deleted`, `signal.new`, `policy.changed`; Zustellprotokoll als AuditEvent. OpenAPI wird um die neuen Routen ergaenzt; kein OData (E-14).

### E8 — Vertrag, Vendor Risk, Marketing [K.o. 8a, 8b; Muss 8c, 9] (≈ 6 Entwicklertage + juristische/externe Leistungen)

- `docs/compliance/`: `AVV_TOM.md` (Vorlage; Telemetrie = Zaehler, Support-Zugriffe, Update-Kanal, Proxy-Pfade, PromptAudit als Opt-in), `VVT_MUSTER.md` (Datenklassen aus der Datenfluss-Tabelle, Sperrliste als eigene Verarbeitung), `DSFA_VORPRUEFUNG.md` (LinkedIn, Personen-Radar, Bildanalyse), `INTERESSENABWAEGUNG_MUSTER.md`, `VERANTWORTUNGSMATRIX.md` (Anbieter/Kunde je Verarbeitung und Betriebsform), `NETZWERK.md`, `EDR_PROFIL.md`, `DATENMODELL.md`. Juristische Pruefung ist extern.
- Supply-Chain: CycloneDX-SBOM fuer Desktop, Gateway, Producer in CI (Release-Asset), Dependabot/Renovate, `SECURITY.md` mit CVE-Prozess und Reaktionszeiten (z. B. kritisch 72 h), Pen-Test extern nach E1/E4, Selbstauskunft nach CAIQ/SIG-Lite-Fragebogen, ISO-27001-Roadmap als Dokument.
- Exit: Source-Escrow als Vertragsbaustein; technische Voraussetzung ist E7.2.
- SLA-Dokument mit Support-Zeiten und Eskalationspfad.
- Marketing: `WEBSITE_PROMPT_COMPLIANCE.md` um die Formulierungen ergaenzen („unterstuetzt den DSGVO-konformen Einsatz", Vergleichstabelle ohne Konformitaetsurteile ueber Wettbewerber, „Betrieb wahlweise als Service oder in deiner Infrastruktur"), `README.md` angleichen, `MARKETING_FEATURE_REALITY` nachziehen, sobald E1/E5 live sind.

---

## 5. Reihenfolge, Abhaengigkeiten, Aufwand

```
E0 Hygiene ──┐
             ├─▶ E1 Policy/Operator/Audit ──▶ E2 Datenmodell/DSGVO ──▶ E5.1 Substrat ──▶ E5.3 Worker
             │                                       │
             │                                       └─▶ E7 Integration/Export
             ├─▶ E4 Deployment/Updates (parallel, externe Zertifikate frueh beantragen)
             ├─▶ E3 Modelle (parallel)
             └─▶ E6 Identity (Keycloak-Upgrade aus E0.2 zuerst)
E8 Dokumente laufen parallel und werden mit jedem Paket konkreter.
```

| Paket | Tage | K.o. abgedeckt | Voraussetzung |
|---|---|---|---|
| E0 | 5 | — | — |
| E1 | 15 | 1a, 1b, 6b, 6d | E0.2–E0.4 |
| E2 | 22 | 2a–2d | E1.3 (Audit-Events) |
| E3 | 8 | 3a | — |
| E4 | 14 (+ Zertifikat extern) | 4a, 4b | E4.2 braucht Gateway-Feed |
| E5 Stufe A | 12 | 5 (fuer Substrat) | E1, E2.5, E4.3 |
| E5 Stufe B | 30 | 5 (Verfuegbarkeit, lokale Stores) | E5.1, E2 |
| E6 | 12 | 6a | E0.2 |
| E7 | 12 | — (Muss) | E2.2, E2.5 |
| E8 | 6 (+ extern) | 8a, 8b | alle, fortlaufend |
| **Summe bis alle K.o. ohne Worker** | **≈ 94 Tage ≈ 19 Wochen (eine Person)** | | |
| mit zwei Entwicklern (E3/E4/E6 parallel zu E1/E2) | ≈ 12–14 Wochen | | |
| Worker (Stufe B) zusaetzlich | +6 Wochen | | |

Die drei Prioritaeten des Gutachters in dieser Reihenfolge waeren
Server-Modus, Audit, LinkedIn-Policy. Am Code gemessen ist die
schnellste Route zur „Bewertbarkeit": **E0 → E1 (LinkedIn-Policy hart +
Audit) → E4.1/E4.2 (signierte Pakete, Update-Kontrolle) → E2 → E5.1**.
Damit sind nach ~8 Wochen die Punkte erreichbar, bei denen ein DSB
ueberhaupt weiterliest; das Substrat kommt dann als Betriebsform
dazu, statt als leeres Versprechen.

## 6. Was sich fuer bestehende Nutzer aendert

- Persoenliche Tenants: keine Funktionsverluste; Kontakte werden
  automatisch als Arbeitsbestand uebernommen (E2.3); Bildanalyse fuer
  Personen-Posts entfaellt fuer alle (E1.5); Auto-Update bleibt.
- Organisationen: personenbezogene Module fail-closed nach 24 h ohne
  Gateway (E1.1), Enterprise-Defaults aus, Metadaten-Audit an den
  Tenant (E1.4), Mails an nicht informierte Personen nur mit
  Art.-14-Anhang (E2.6), Update-Modus je Policy (E4.2).
- Operator: Keycloak-Upgrade, neue Secrets (Policy-Signatur), neue
  Cron-Jobs (Sichtungs-/Arbeitsbestand-Tilgung, Audit-Purge, Anker),
  Update-Feed-Hosting, N-2-Supportregel.

## 7. Offene Punkte

- Dealfront/Cognism: Partnerschaft und Datenlizenz klaeren, bevor ein
  Adapter gebaut wird (E-2).
- Windows-Zertifikat: EV vs. Azure Trusted Signing (Kosten, Vorlauf)
  jetzt anstossen, unabhaengig vom Rest.
- Juristische Pruefung der `docs/compliance/`-Vorlagen und des
  Haftungspassus zur LinkedIn-Kontosperre.
- Keycloak-26-Upgrade auf Fly: Migrationspfad fuer bestehende Sessions
  und das Theme `ava` testen.
- Sperrlisten-Frist und globale Loeschung ueber Tenant-Grenzen im
  SaaS-Betrieb mit dem DSB abstimmen (Entscheidung 2026-09-03 bleibt
  bis dahin).
