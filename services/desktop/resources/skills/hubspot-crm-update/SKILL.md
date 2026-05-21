---
name: hubspot-crm-update
description: >
  Aktualisiert Felder einer HubSpot-Firma (Lifecycle-Stage, Owner,
  Industry, Custom Properties). Aktiviere bei Anfragen wie „aktualisiere
  im HubSpot CRM", „setze HubSpot-Status von X auf Y", „Lifecycle in
  HubSpot auf Kunde", „HubSpot-Firma ändern", „CRM-Eintrag korrigieren"
  (wenn HubSpot verbunden ist).
language: de
b2b-scope: internal
allowed-tools:
  - crm_status
  - company_search
  - crm_list_links_for_company
  - crm_search_hubspot_companies
  - crm_introspect_hubspot_company
  - crm_update_hubspot_company
  - ask_user_choice
requires-user-confirm: false
disable-model-invocation: false
user-invocable: true
---

# HubSpot-CRM-Update (festes 4-Schritt-Playbook)

Halte dich strikt an die Reihenfolge. Frag den Nutzer NICHT zurück,
solange du Schritte selbst per Tool auflösen kannst.

## 1. HubSpot-companyId finden

Wenn der Nutzer eine Firma beim Namen nennt (z. B. „setze Status von
ACME GmbH auf Kunde"):

1. `company_search` mit dem Firmennamen → AVA-Master-Data-companyId
2. `crm_list_links_for_company` mit der AVA-companyId →
   HubSpot-companyId (Link-Type "HUBSPOT")

Wenn KEIN HubSpot-Link existiert:
- `crm_search_hubspot_companies` mit Name/Domain → Kandidaten
- Bei eindeutigem Treffer: weiter (oder dem Nutzer EINMAL
  `ask_user_choice` bei mehreren plausiblen Kandidaten)
- Bei keinem Treffer: dem Nutzer mitteilen, dass die Firma in HubSpot
  fehlt, NICHT „blind" eine neue anlegen (das gibt's noch nicht).

Wenn der Nutzer die HubSpot-ID direkt gibt: Schritt 1 überspringen.

## 2. Schema lesen

`crm_introspect_hubspot_company` mit der HubSpot-companyId. Notiere
für die Felder, die der Nutzer ändern will:
- den EXAKTEN Property-Namen (z. B. `lifecyclestage`, NICHT
  „Lifecycle Stage")
- den Typ (`string`, `number`, `date`, `datetime`, `enumeration`,
  `bool`)
- bei `enumeration`: die verfügbaren `value`s + Labels (HubSpot
  unterscheidet das: API erwartet `value`, der Nutzer sagt
  meistens das `label`)
- den aktuell gespeicherten Wert (für den Diff in der Bestätigung)

## 3. Update vorbereiten

Baue das `properties`-Map: HubSpot-interner Property-Name →
neuer Wert.

Bei Enum-Feldern: mappe das vom Nutzer genannte Label auf den
`value`. Beispiel: Nutzer sagt „setze auf Kunde", Schema zeigt
`lifecyclestage` mit Optionen
`[{label: "Subscriber", value: "subscriber"}, {label: "Lead", value: "lead"}, {label: "Kunde", value: "customer"}]`.
→ properties: `{"lifecyclestage": "customer"}`.

Bei mehreren Feldern: alle ins gleiche `properties`-Map packen,
HubSpot patcht atomar.

`rationale`: ein Satz zur Begründung (z. B. „Vertrag wurde
unterschrieben — Lifecycle auf Customer"). Wird im Confirm-Dialog
gezeigt.

## 4. PATCH + Verify

`crm_update_hubspot_company` aufrufen. Das Tool zeigt selbst per
ask_user_choice den Diff (Vorher → Nachher) und sendet erst bei
Confirm den PATCH. KEINE doppelte Rückfrage.

Return-Wert lesen:
- `ok: true` → fertig, dem Nutzer die übernommenen Werte rück-
  bestätigen.
- `ok: false, notApplied: [...]` → HubSpot hat den PATCH akzeptiert
  (HTTP 200), aber server-seitig nicht alle Werte gespeichert.
  Gründe: Workflow-Validierung greift, Property ist mit anderem
  Feld gekoppelt (z. B. dealstage hängt an pipeline), oder Rate-
  Limit. Dem Nutzer den Diff zeigen + auf das Workflow-Problem
  hinweisen.

## Spezialfälle

- **Owner ändern**: Property `hubspot_owner_id`. Owner-IDs sind
  numerisch — wenn der Nutzer einen Namen sagt, gibt es aktuell
  KEIN Tool um Owner aufzulisten. Dem Nutzer das transparent sagen
  und nach der Owner-ID fragen (manche kennen die, weil HubSpot
  sie in der URL anzeigt: `/contacts/<portal>/contact/<owner>`).

- **Mehrere Companies in HubSpot mit gleichem Namen**: NIEMALS
  ohne `ask_user_choice` raten. Eindeutiger ist die Kombination
  aus Name + Domain.

- **Lifecycle-Stage rückwärts**: HubSpot lässt manche Stages
  nicht rückwärts springen (Customer → Lead). Falls der Fresh-GET
  zeigt, dass der Wert nicht übernommen wurde, ist das oft die
  Ursache.

## Was NICHT tun

- Niemals Companies oder Contacts in HubSpot neu anlegen (kein
  Create-Tool).
- Niemals read-only-Felder (`hs_object_id`, `hs_created_at`)
  überschreiben — die filtert das introspect-Tool eh raus, aber
  falls du dich vertust, gibt HubSpot 403.
- Niemals einfach „alle Felder" updaten — der Nutzer sieht im
  Confirm-Dialog nur das, was du im `properties`-Map hast.
  Lieber gezielt.
