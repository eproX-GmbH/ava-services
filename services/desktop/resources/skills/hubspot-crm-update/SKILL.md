---
name: hubspot-crm-update
description: >
  Aktualisiert Felder in HubSpot — Companies, Contacts oder Deals
  (Lifecycle-Stage, Owner, Industry, Deal-Stage, Custom Properties).
  Aktiviere bei Anfragen wie „aktualisiere im HubSpot CRM", „setze
  HubSpot-Status von X auf Y", „Lifecycle in HubSpot auf Kunde",
  „HubSpot-Firma/Kontakt/Deal ändern", „Deal-Stage auf Closed Won",
  „CRM-Eintrag korrigieren" (wenn HubSpot verbunden ist).
language: de
b2b-scope: internal
allowed-tools:
  - crm_status
  - company_search
  - crm_list_links_for_company
  - crm_search_hubspot_companies
  - crm_search_hubspot_contacts
  - crm_search_hubspot_deals
  - crm_list_hubspot_owners
  - crm_introspect_hubspot_company
  - crm_update_hubspot_company
  - crm_introspect_hubspot_contact
  - crm_update_hubspot_contact
  - crm_introspect_hubspot_deal
  - crm_update_hubspot_deal
  - ask_user_choice
requires-user-confirm: false
disable-model-invocation: false
user-invocable: true
---

# HubSpot-CRM-Update (festes 4-Schritt-Playbook)

Du arbeitest mit HubSpot — Companies, Contacts oder Deals. Halte dich
strikt an die Reihenfolge. Frag den Nutzer NICHT zurück, solange du
Schritte selbst per Tool auflösen kannst.

## 1. Object-Type identifizieren

Aus der Anfrage erkennen, OB es um Company, Contact oder Deal geht:
- „Firma", „Unternehmen", „Account", „company" → Company
- „Kontakt", „Person", „Ansprechpartner", „Lead" (wenn auf Person
  bezogen), E-Mail-Adresse genannt → Contact
- „Deal", „Opportunity", „Verkauf", „Pipeline-Eintrag", „Auftrag"
  → Deal

Wenn unklar (z. B. „setze Status von ACME auf Kunde" — Company oder
Deal?): EINMAL per `ask_user_choice` rückfragen.

## 2. Object-ID finden

### Bei Company

1. `company_search` mit dem Namen → AVA-Master-Data-companyId
2. `crm_list_links_for_company` mit der AVA-companyId →
   HubSpot-companyId (Link-Type "HUBSPOT")
3. Wenn kein Link existiert: `crm_search_hubspot_companies` mit
   Name/Domain. Bei mehreren: `ask_user_choice`.

### Bei Contact

`crm_search_hubspot_contacts` mit Name oder E-Mail-Adresse. Bei
mehreren plausiblen Treffern: `ask_user_choice` mit Name + E-Mail +
Company zur Disambiguierung.

### Bei Deal

`crm_search_hubspot_deals` mit Deal-Name. Bei mehreren: `ask_user_choice`
mit Name + Stage + Amount + CloseDate.

## 3. Schema lesen

Pro Object-Type das passende Introspect-Tool:
- Companies → `crm_introspect_hubspot_company`
- Contacts  → `crm_introspect_hubspot_contact`
- Deals     → `crm_introspect_hubspot_deal`

Notiere für die Felder, die der Nutzer ändern will:
- den EXAKTEN Property-Namen (z. B. `lifecyclestage`, `dealstage`,
  `hs_lead_status`)
- den Typ (`string`, `number`, `date`, `datetime`, `enumeration`, `bool`)
- bei `enumeration`: die verfügbaren `value`s + Labels (HubSpot-API
  erwartet `value`, Nutzer sagt meistens das `label`)
- den aktuell gespeicherten Wert (für den Diff)

## 4. PATCH + Verify

Pro Object-Type das passende Update-Tool:
- Companies → `crm_update_hubspot_company`
- Contacts  → `crm_update_hubspot_contact`
- Deals     → `crm_update_hubspot_deal`

Das Tool macht selbst ask_user_choice mit Diff (Vorher → Nachher).
KEINE doppelte Rückfrage.

Return-Wert lesen:
- `ok: true` → fertig, dem Nutzer rückbestätigen
- `ok: false, notApplied: [...]` → Fresh-GET zeigt, dass HubSpot
  trotz HTTP 200 nicht alle Werte gespeichert hat. Häufige Ursachen:
  Workflow-Validierung, gekoppelte Felder (`dealstage` ↔ `pipeline`,
  `lifecyclestage` rückwärts), oder Required-Field-Validation für
  bestimmte Stages

## Spezialfälle

### Owner ändern

Property: `hubspot_owner_id`. Owner-IDs sind numerisch, der Nutzer
sagt aber meistens den Namen.

Workflow:
1. `crm_list_hubspot_owners` aufrufen → bekommt Liste mit
   id + email + firstName + lastName
2. Aus der Liste den passenden Owner per Name oder E-Mail-Match raus-
   suchen. Bei mehreren plausiblen Matches: `ask_user_choice`
3. Die `id` als String in `{"hubspot_owner_id": "<id>"}` setzen

### Deal-Stage ändern

Property: `dealstage`. ABER: `dealstage` ist an `pipeline` gekoppelt.
Wenn du nur `dealstage` setzt und die Stage nicht zur aktuell
gesetzten Pipeline gehört, lehnt HubSpot ab (oder akzeptiert HTTP 200
und ignoriert silent → Fresh-GET-Verify zeigt notApplied).

Best-Practice: bei Deal-Stage-Änderungen IMMER beide setzen
(`pipeline` + `dealstage`). Die Pipeline-IDs sind im Schema unter
`pipeline.options` zu finden.

### Lifecycle-Stage rückwärts

HubSpot lässt manche Lifecycle-Stages nicht rückwärts springen
(Customer → Lead). Wenn der Fresh-GET das Feld nicht übernommen
zeigt, ist das oft die Ursache. Dem Nutzer transparent sagen.

### Mehrere Treffer bei der Suche

NIEMALS ohne `ask_user_choice` raten. Disambiguierungs-Felder:
- Companies: Name + Domain + City
- Contacts:  Name + E-Mail + Company
- Deals:     Name + Stage + Amount + CloseDate

## Was NICHT tun

- Niemals Companies, Contacts oder Deals in HubSpot neu anlegen
  (es gibt kein Create-Tool — bewusst).
- Niemals read-only-Felder überschreiben (z. B. `hs_object_id`,
  `createdate`, `lastmodifieddate`) — das Introspect-Tool filtert die
  raus, aber HubSpot gibt 403 wenn du es versuchst.
- Niemals „alle Felder" pauschal updaten — der Nutzer sieht im
  Confirm-Dialog nur das, was du im `properties`-Map hast. Lieber
  gezielt.
