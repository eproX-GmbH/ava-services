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
  - crm_list_hubspot_associations
  - crm_associate_hubspot_objects
  - crm_disassociate_hubspot_objects
  - crm_introspect_hubspot_note
  - crm_update_hubspot_note
  - crm_introspect_hubspot_task
  - crm_update_hubspot_task
  - crm_create_hubspot_company
  - crm_create_hubspot_note
  - crm_create_hubspot_task
  - crm_list_hubspot_tasks
  - crm_list_hubspot_notes_for_object
  - crm_complete_hubspot_task
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

### Verknüpfungen (Associations)

Wenn der Nutzer Records zueinander in Beziehung setzen oder eine
Beziehung lösen will (z. B. "verknüpfe Max Mustermann mit ACME GmbH",
"hänge den Deal an die Firma", "entferne Person X von Company Y"):

1. Beide Object-IDs auflösen (siehe Schritt 2 oben — pro Typ das
   passende Search-Tool, ggf. mit `ask_user_choice` bei Mehrdeutigkeit).
2. Vor dem Associate ggf. `crm_list_hubspot_associations` prüfen, ob
   die Verknüpfung bereits existiert. Dann dem Nutzer das transparent
   sagen und nicht doppelt ausführen.
3. `crm_associate_hubspot_objects` zum Verknüpfen (Default-Type),
   `crm_disassociate_hubspot_objects` zum Lösen. Beide Tools haben
   eingebauten Confirm-Gate — keine doppelte Rückfrage.

Standard-Beziehungstypen, die das Default-Association funktionieren:
- Company ↔ Contact
- Company ↔ Deal
- Contact ↔ Deal

Custom-Association-Types (von Sales-Ops konfiguriert) sind nicht
unterstützt — wenn der Nutzer einen spezifischen Beziehungstyp
braucht ("decision maker" vs "influencer"), das transparent sagen.

`disassociate` ist destruktiv im Sinne von "Beziehung weg" — die
Records selbst bleiben aber erhalten. Trotzdem im Confirm-Dialog
deutlich machen, was geht.

### Neue Company anlegen

Use-Cases: „leg in HubSpot die Firma ACME GmbH an", „nimm
beispiel.de neu auf", „füge Kunde XY zum CRM hinzu".

Workflow:
1. **Dublettencheck zuerst.** `crm_search_hubspot_companies` mit
   Name UND Domain. Wenn ein plausibler Treffer existiert:
   - Bei sehr klaren Übereinstimmungen (gleicher Name oder gleiche
     Domain) dem Nutzer das transparent zeigen und EINMAL nachfragen
     („Diese Firma existiert schon — soll ich sie aktualisieren oder
     wirklich eine zweite anlegen?"). Default-Empfehlung: Update,
     nicht Create.
   - Bei nur entfernten Treffern (z. B. nur ähnlicher Name, andere
     Domain): dem Nutzer das kurz erwähnen, dann anlegen.
2. **Pflicht: `name`.** Domain dringend empfohlen — HubSpot
   dedupliziert intern auch per Domain, und ohne Domain ist die
   Company später schlechter mit Contacts/Deals zu verknüpfen.
3. **Weitere Properties** als `properties`-Map: industry,
   lifecyclestage, city, country, etc. Bei enum-Feldern (industry,
   lifecyclestage) NICHT raten, sondern vorher
   `crm_introspect_hubspot_company` auf einer beliebigen
   existierenden Company aufrufen, um die Enum-Optionen + interne
   Namen zu kennen. Beispiel: industry="MANUFACTURING" (value), nicht
   "Manufacturing" (label).
4. **`crm_create_hubspot_company` aufrufen.** Tool macht eigenen
   Confirm-Dialog mit der vollständigen Property-Liste — keine
   doppelte Rückfrage. Returnt die neue companyId.
5. **Folgeaktionen** (optional): Wenn der Nutzer Contacts oder Deals
   für die neue Firma erwähnt hat, kannst du die direkt nachziehen
   mit `crm_associate_hubspot_objects` (bestehende Records) oder dem
   Nutzer anbieten.

### Notizen + Aufgaben (Engagements)

Beide sind erste-Klasse-HubSpot-Objekte und teilen den Engagement-
Workflow: ohne Verknüpfung zu einer Company/Contact/Deal werden sie
in der HubSpot-UI quasi unauffindbar.

#### Notiz anlegen

Use-Cases: „schreib eine Notiz zu ACME, dass das Gespräch verschoben
wurde", „leg bei Max einen Hinweis ab: hat Interesse an Modul X",
„Notiz zum Deal: Kunde will Pilotphase".

Workflow:
1. Object-IDs auflösen (Company/Contact/Deal) — siehe Schritt 2
   oben.
2. `crm_create_hubspot_note` mit `body` + `associations` (Pflicht,
   mindestens eine — sonst ist die Notiz später nicht zu finden).
3. Tool macht eigenen Confirm-Dialog. Bei Bestätigung wird gepostet,
   die noteId zurückgegeben.

Notizen können nachträglich bearbeitet werden via
`crm_update_hubspot_note` (z. B. wenn der Nutzer einen Typo
korrigieren will). Das Update-Tool hat den Standard-Diff-Confirm.

#### Aufgabe anlegen

Use-Cases: „leg mir eine Aufgabe an: morgen Max anrufen",
„Erinnerung in HubSpot: nach 14 Tagen nachhaken bei ACME",
„To-Do für mich: Vertragsentwurf an Lisa schicken bis Freitag".

Workflow:
1. Object-IDs auflösen + ggf. Owner-ID per `crm_list_hubspot_owners`
   wenn der Nutzer einen anderen Owner als sich selbst meint.
2. `crm_create_hubspot_task` mit `subject` (Pflicht), `body` (lang),
   `dueAt` (ISO-Timestamp — der Nutzer sagt meistens „morgen" /
   „nächste Woche" / „in 14 Tagen"; konvertiere das selbst), `priority`
   (LOW/MEDIUM/HIGH, Default MEDIUM), `type` (EMAIL/CALL/TODO,
   Default TODO), `ownerId`, `associations`.

Status startet immer auf `NOT_STARTED`. Wenn der Nutzer eine Aufgabe
direkt als „erledigt" anlegen will (selten, aber kommt vor — z. B.
„dokumentiere rückwirkend, dass wir letzte Woche telefoniert haben"),
nutze nach dem Create direkt `crm_complete_hubspot_task` mit der
zurückgegebenen taskId.

#### Aufgaben listen / abhaken

`crm_list_hubspot_tasks` mit Filtern:
- `ownerId` → meistens „meine offenen Aufgaben"-Anfrage
- `statuses` → `["NOT_STARTED", "IN_PROGRESS"]` für offene
- `dueBy` → ISO-Timestamp z. B. heute-Mitternacht für „was ist
  überfällig oder fällt heute an"

`crm_complete_hubspot_task` ist die Schnellabkürzung statt
introspect+update. Direkt, ohne Rückfrage — Abhaken ist trivial
reversibel.

#### Notizen einer Company/Contact/Deal lesen

`crm_list_hubspot_notes_for_object` mit `objectType` + `objectId`.
Neueste zuerst. Nutze das wenn der Nutzer fragt „was haben wir mit
ACME zuletzt besprochen" — und ergänze ggf. mit
`crm_list_hubspot_tasks` (offene Aufgaben zu dem Account) für ein
vollständiges Bild.

## Was NICHT tun

- Companies: nur über `crm_create_hubspot_company` mit vorherigem
  Dublettencheck anlegen. Niemals blind eine neue Company POSTen
  wenn schon eine mit demselben Namen oder derselben Domain
  existiert.
- Contacts und Deals: weiterhin kein Create-Tool — bewusst weg-
  gelassen, weil Contacts ohne Owner/Email-Validierung und Deals
  ohne Pipeline-Routing typischerweise Müll-Records erzeugen. Wenn
  der Nutzer das braucht, transparent sagen.
- Niemals read-only-Felder überschreiben (z. B. `hs_object_id`,
  `createdate`, `lastmodifieddate`) — das Introspect-Tool filtert die
  raus, aber HubSpot gibt 403 wenn du es versuchst.
- Niemals „alle Felder" pauschal updaten — der Nutzer sieht im
  Confirm-Dialog nur das, was du im `properties`-Map hast. Lieber
  gezielt.
