# Plan: AVA in Microsoft Copilot und Dynamics 365 (über MCP, ohne Marketplace)

Stand 2026-10-23. Gespräch mit dem Operator: Größere Kunden haben ein
angepasstes Dynamics, sehen KI-Agenten kritisch und der Microsoft-Marketplace
ist ein langer Weg. Die Idee: AVA wird nicht in Dynamics eingebaut, sondern
als Werkzeug des Microsoft Copilot angeboten. Der Copilot, der im Tenant des
Kunden schon angemeldet ist, holt sich Firmen-, Kontakt- und Signaldaten von
AVA und schreibt sie selbst ins CRM. Umgekehrt legt er Gesprächsprotokolle und
Hinweise bei AVA ab. AVA löscht und überschreibt nichts beim Kunden; das Risiko
bleibt dort, wo es ohnehin liegt.

Verwandt: `PLAN_MCP_OEFFNUNG.md` (MCP-Server, Aufträge, Org-Schalter),
`PLAN_AVA_CLOUD.md` (Server-Instanzen), `PLAN_ENTERPRISE_FREIGABE.md`
(Compliance), `PLAN_VOLLMACHT.md`.

## 1. Zielbild

```
Kunde (Microsoft-Tenant)                          AVA (EU, Fly Frankfurt)
┌──────────────────────────────┐                  ┌───────────────────────────┐
│ Microsoft 365 Copilot        │  MCP über HTTPS  │ Gateway mcp.ava.bi        │
│ Copilot in Dynamics 365 Sales│ ───────────────► │  OAuth, Org-Schalter,     │
│ Copilot-Studio-Agent "AVA"   │ ◄─────────────── │  Werkzeugmenge "copilot"  │
│   • fragt AVA (Werkzeuge)    │   Antworten      │  Audit je Aufruf          │
│   • schreibt ins CRM selbst  │                  │          │ Kopf-Relais    │
│   • legt Protokolle bei AVA  │                  │          ▼                │
│     ab (Schreibwerkzeug)     │                  │ Server-Instanz des Nutzers│
│                              │                  │  <kunde>.ava.bi           │
│ Microsoft-Graph-Index        │  Graph-Connector │                           │
│  (Copilot kennt AVA-Daten    │ ◄─────────────── │ Push: Firmenprofile,      │
│   ohne Live-Aufruf)          │                  │  Kontakte, Signale        │
│                              │                  │                           │
│ Entra ID ───────────────────────► Keycloak (Identitätsanbieter je Org)      │
└──────────────────────────────┘                  └───────────────────────────┘
```

Drei Verbindungen, in dieser Reihenfolge gebaut:

1. **MCP** (vorhanden, zu härten): Der Copilot ruft AVA. Lesend plus zwei
   Schreibwege ("Protokoll ablegen", "Firma aufnehmen").
2. **Graph-Connector** (neu): AVA schiebt Firmenprofile in den Index des
   Kunden-Tenants. Damit "kennt" der Copilot AVA-Daten in Outlook, Teams und
   Dynamics, ohne jedes Mal zu fragen.
3. **Rückkanal** (klein): AVA liefert Meldungen per Webhook an einen Trigger
   in Copilot Studio oder Power Automate. Kein A2A.

## 2. Warum MCP und nicht A2A

| Frage | MCP | A2A |
|---|---|---|
| Unterstützung bei Microsoft | Copilot Studio bindet MCP-Server als Werkzeuge ein, allgemein verfügbar; Veröffentlichung nach Microsoft 365 Copilot und Dynamics aus Copilot Studio heraus | in Copilot Studio als Vorschau; Partner-Agenten müssen eine Agentenkarte und Webhook-Adresse mitbringen |
| Was AVA hat | MCP-Server mit OAuth, Org-Schalter je Werkzeug, Aufträge, Audit (`PLAN_MCP_OEFFNUNG.md`) | nichts; als Fassade über dieselben Aufträge denkbar (M6 dort) |
| Bidirektional | Copilot → AVA über Werkzeuge; AVA → Copilot über Webhook an Trigger | beide Richtungen als Tasks |
| Risiko beim Kunden | Werkzeugmenge je Organisation festlegbar, lesend als solche markiert | Agenten-zu-Agenten-Aufträge sind für Sicherheitsabteilungen schwerer zu bewerten |

Entscheidung: MCP zuerst. A2A nur, wenn ein Kunde einen konkreten Partner-
Agenten benennt. Was der Operator "bidirektional" nennt, ist mit MCP plus
Webhook abgedeckt.

## 3. Was es schon gibt

- MCP-Server unter `https://mcp.ava.bi` mit OAuth über das AVA-Konto
  (Keycloak), dynamischer Client-Registrierung, Opt-in auf Organisations- und
  Nutzerebene, Org-Schalter je Werkzeug, Audit-Protokoll je Aufruf.
- Werkzeuge: Firmen suchen und lesen, Kontakte, Publikationen, Kunden,
  Netz, Meldungen, Aufträge (Import über Firmen-IDs oder Liste,
  Neuverarbeitung, Recherche), `ava_fragen` (AVAs Agent beauftragen),
  `ava_kontext` (Rolle, Profil, ICP, Gedächtnis), `werkzeug_suchen` und
  `werkzeug_ausfuehren` (beliebige Werkzeuge der laufenden AVA über das
  Relais, Org-Schalter).
- Server-Instanzen je Kunde (`<name>.ava.bi`), an ein Konto gebunden, aus
  einem gemeinsamen Image; Kopf-Relais wählt die laufende Instanz.
- Audit-Protokoll, Verbrauch je Mitglied, Abrechnung, EU-Hosting.

## 4. Was fehlt

| Lücke | Warum nötig | Aufwand |
|---|---|---|
| **Entra-ID-Kopplung** in Keycloak (Identitätsanbieter je Organisation, Zuordnung Entra-Tenant → AVA-Organisation, Auto-Anlage der Mitglieder) | Kunden melden sich mit ihrem Microsoft-Konto an; ohne das ist jede Enterprise-Einführung tot | 3 bis 4 Tage |
| **Werkzeugmenge "copilot"** als feste, kleine Liste mit Microsoft-tauglichen Beschreibungen und begrenzten Antworten; `werkzeug_ausfuehren` für diese Menge aus | Copilot Studio zeigt jedes Werkzeug dem Admin; eine kleine, lesbare Liste ist freigabefähig | 2 Tage |
| **Schreibwerkzeug "Protokoll ablegen"** (Gesprächsnotiz an Firma oder Person, Quelle "copilot", Anlass, Datum) | der Rückweg vom Copilot zu AVA | 1 Tag (vorhanden: `person_hinweis`, `remember`; neu: firmenbezogene Notiz als Fakt mit Quelle) |
| **Graph-Connector** (externe Elemente: Firma mit Profil, Status, Ansprechpartnern; ACL je Organisation; Aktualisierung bei Auffrischung) | Copilot kennt AVA-Daten ohne Live-Aufruf | 5 Tage plus Entra-App beim Kunden |
| **Webhook für Meldungen** je Organisation (signiert, Wiederholung, Filter nach Art) | Rückkanal zu Copilot Studio oder Power Automate | 1 Tag |
| **Audit-Export** der MCP-Aufrufe je Organisation (CSV, Konsole) | Nachweis für den Kunden | 1 Tag |
| **Einrichtungsleitfaden** für den Tenant-Admin (Entra-App, Consent, Copilot-Studio-Agent, Veröffentlichung) | ohne den läuft kein Pilot | 1 Tag |

## 5. Phasen

### C0 Entscheidungen (Operator)

- Werkzeugmenge für Copilot: Vorschlag unten in §6.
- Identität: Entra-Kopplung per OIDC-Brokering in Keycloak, eine AVA-
  Organisation je Entra-Tenant, Mitglieder bei erster Anmeldung automatisch.
- Daten im Graph-Index: nur Firmen im Bestand der Organisation, keine
  Personendaten im Index (Ansprechpartner nur über MCP, mit Beleg und
  Art.-14-Hinweis). Zu entscheiden.

### C1 Werkzeugmenge und Schreibweg (3 Tage)

- Gateway: Werkzeugmenge `copilot` neben der Kernmenge; Antworten gekürzt
  (Profil kompakt, höchstens 20 Treffer, Kontakte mit Beleg-URL).
- Neues Werkzeug `protokoll_ablegen` (companyId oder personId, Text, Datum,
  Quelle "copilot"); landet als Fakt mit Herkunft und erscheint in der
  Firmenansicht und im Chat (`company_get` Bereich `notizen`).
- Org-Schalter: Vorlage "Copilot: lesend plus Protokoll" in der Konsole.

### C2 Entra-ID-Kopplung (4 Tage)

- Keycloak: Identitätsanbieter "Microsoft Entra" je Organisation (Client-ID
  und Geheimnis des Kunden), First-Login-Flow legt das AVA-Konto an und
  ordnet es der Organisation zu; Rollen aus Entra-Gruppen optional.
- Konsole: Seite "Anmeldung", Eingabe der Entra-Daten, Test-Knopf.
- Gateway: Mitgliedschaft automatisch, Seat-Abrechnung wie bisher.

### C3 Pilot bei einem Kunden (2 Wochen Laufzeit, 2 Tage Aufwand)

- Server-Instanz für den Kunden, Werkzeugmenge `copilot`, Entra-Kopplung.
- Tenant-Admin: Entra-App-Registrierung, Admin-Consent, Copilot-Studio-
  Agent "AVA" mit MCP-Verbindung, Veröffentlichung für zwei bis drei Nutzer
  in Microsoft 365 Copilot und Copilot in Dynamics 365 Sales.
- Messgrößen: Aufrufe je Tag, Anteil beantworteter Fragen, Protokolle, die
  zurückkommen, Fehler.

### C4 Graph-Connector (5 Tage)

- Gateway-Dienst "graph-push": je Organisation ein Connector im Kunden-
  Tenant (Entra-App des Kunden mit `ExternalItem.ReadWrite.OwnedBy`),
  Schema Firma (Name, Sitz, Branche, Status, Kurzprofil, Website, Link in
  die AVA-App), Vollabgleich nachts, Delta bei Auffrischung und Statuswechsel.
- Konsole: Schalter, letzter Lauf, Anzahl Elemente, Fehler.

### C5 Rückkanal und Audit-Export (2 Tage)

- Webhook je Organisation für Meldungen (signiert, Wiederholung, Filter).
- CSV-Export der MCP-Aufrufe in der Konsole.

### C6 Einführung (laufend)

- Einrichtungsleitfaden, Datenschutzunterlagen (AVV, Datenflüsse, TOMs),
  Preisposition "Copilot-Anbindung" im Enterprise-Vertrag.

Summe Entwicklung: rund 17 Tage, dazu der Pilot.

## 6. Vorschlag Werkzeugmenge "copilot"

| Werkzeug | Art | Zweck im Copilot |
|---|---|---|
| `firma_suchen` | lesend | "Was weiß AVA über die Müller GmbH in Bielefeld?" |
| `firma_lesen` (kompakt) | lesend | Profil, Status, Register, Kennzahlen, Signale |
| `firma_kontakte` | lesend | Ansprechpartner mit Beleg und Art.-14-Hinweis |
| `meldungen` | lesend | Was ist bei meinen Firmen neu |
| `meine_firmen` | lesend | Bestand des Nutzers |
| `kunden_umkehrsuche` | lesend | Wer nennt diese Firma als Kunden |
| `import_anlegen` | schreibend (AVA) | Firma aufnehmen und verarbeiten |
| `protokoll_ablegen` (neu) | schreibend (AVA) | Gesprächsnotiz aus Teams oder Dynamics bei AVA ablegen |
| `ava_fragen` | Auftrag | Freitext an AVAs Agenten, etwa Ansprache vorschlagen |

Nicht in der Menge: `werkzeug_ausfuehren`, Mail, Workflows, Buying Center,
Verflechtungen. Alles, was AVA selbst schreiben würde, bleibt aus.

## 7. Risiken

- **Microsoft ändert Copilot Studio schnell.** MCP-Unterstützung ist da,
  Details (Auth-Varianten, Antwortgrößen) wandern. Gegenmittel: kleine,
  stabile Werkzeugmenge, Pilot früh.
- **Identität ist der Engpass.** Ohne Entra-Kopplung bleibt jeder Pilot ein
  Bastelaufbau. Deshalb C2 vor C3.
- **Personendaten im Index.** Ein Graph-Connector mit Ansprechpartnern wäre
  eine Übermittlung in den Kunden-Tenant ohne Beleg je Zugriff. Vorschlag:
  nur Firmen im Index, Personen nur über MCP.
- **Kosten beim Kunden.** Copilot-Studio-Lizenzen und Nachrichtenkontingente
  trägt der Kunde; das gehört in das Angebot.
- **Verfügbarkeit der Instanz.** Der Copilot bekommt nur Antworten, wenn die
  Server-Instanz läuft. Pilot auf Server-Instanz, nicht Desktop.

## 8. Was der Kunde mitbringen muss

1. Entra-ID-Tenant mit Admin, der Apps registrieren und Consent geben darf.
2. Copilot-Studio-Lizenz und Microsoft 365 Copilot für die Pilotnutzer.
3. Entscheidung, welche Dynamics-Entitäten der Copilot schreibt (Leads,
   Kontakte, Notizen) und mit welchen Rechten; das liegt beim Kunden.
4. Auftragsverarbeitungsvertrag mit eproX, Freigabe der Datenflüsse.
5. Zwei bis drei Pilotnutzer aus dem Vertrieb und einen Ansprechpartner
   aus der IT.

## 9. Stand (2026-10-23, C1 und C2 gebaut)

- **C1 gebaut:** Org-Schalter `mcp.copilot` (Konsole: "MCP: Werkzeugmenge
  Copilot") beschränkt die sichtbaren MCP-Werkzeuge auf `ava_kontext`,
  `firma_suchen`, `firma_lesen`, `firma_kontakte` (nur mit `mcp.kontakte`),
  `meine_firmen`, `meldungen`, `import_anlegen`, `protokoll_ablegen`,
  `auftrag_status`; Kopf-Werkzeuge sind dann aus. Neues Werkzeug
  `protokoll_ablegen` (für alle MCP-Clients) legt Notizen in `CompanyNotiz`
  ab (Routen `GET/POST /v1/companies/{id}/notizen`, `DELETE /v1/notizen/{id}`);
  `firma_lesen` kennt den Bereich `notizen`. Offen: Anzeige der Notizen in der
  Desktop-App und in `company_get` (Bereich `notizen`).
- **C2 gebaut:** Tabelle `TenantSso` (ohne Geheimnis), Keycloak-Identity-
  Provider `entra-<tenantId>` (OIDC gegen `login.microsoftonline.com/<tid>/v2.0`,
  versteckt auf der Anmeldeseite, PKCE) mit Mapper "Advanced Claim to Group":
  Claim `tid` = Entra-Tenant → Gruppe `tenant:<tenantId>` → Claim `tenant_id`
  → Mitgliedschaft beim ersten Gateway-Aufruf. Routen `GET/PUT/DELETE
  /v1/tenants/me/sso`, `POST /v1/tenants/me/sso/pruefen`. Konsole: Seite
  "Anmeldung" (Admin) mit Einrichtungsanleitung und Anmeldelinks
  `…/auth/login?idp=entra-<tenantId>` für Konsole und AVA-App (beide reichen
  `idp` als `kc_idp_hint` durch).
- **Betreiber, einmalig:** Dem Keycloak-Dienstkonto des Gateways
  (`ava-registrar`) die Realm-Management-Rollen `manage-identity-providers`
  und `view-identity-providers` geben; sonst meldet die Konsole beim
  Einrichten einen Keycloak-Fehler. Beim ersten Microsoft-Login zeigt Keycloak
  einmal "Kontoinformationen prüfen" (Standard-Flow "first broker login");
  ein eigener Flow ohne diese Seite ist offen.
- **Offen:** Desktop-Anmeldung mit `idp`-Hinweis, Migration beim nächsten
  Gateway-Deploy (`prisma migrate deploy`), Live-Test mit einem echten
  Entra-Tenant, Notizen in der Desktop-App.

