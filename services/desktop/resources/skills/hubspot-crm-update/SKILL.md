---
name: hubspot-crm-update
description: >
  Vollständige HubSpot-CRM-Bedienung aus dem Chat — Companies, Contacts,
  Deals, Notizen und Aufgaben anlegen, aktualisieren, löschen, verknüpfen.
  Aktiviere bei Anfragen wie „in HubSpot anlegen", „im CRM eintragen",
  „HubSpot aktualisieren", „Lifecycle setzen", „Deal anlegen", „Kontakt
  hinzufügen", „aus HubSpot löschen", „Verknüpfung mit Company", „Notiz
  zum Account", „Aufgabe für morgen", „abhaken".
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
  - crm_create_hubspot_company
  - crm_delete_hubspot_company
  - crm_introspect_hubspot_contact
  - crm_update_hubspot_contact
  - crm_create_hubspot_contact
  - crm_delete_hubspot_contact
  - crm_introspect_hubspot_deal
  - crm_update_hubspot_deal
  - crm_create_hubspot_deal
  - crm_delete_hubspot_deal
  - crm_introspect_hubspot_note
  - crm_update_hubspot_note
  - crm_create_hubspot_note
  - crm_delete_hubspot_note
  - crm_introspect_hubspot_task
  - crm_update_hubspot_task
  - crm_create_hubspot_task
  - crm_delete_hubspot_task
  - crm_list_hubspot_tasks
  - crm_list_hubspot_notes_for_object
  - crm_complete_hubspot_task
  - crm_list_hubspot_associations
  - crm_associate_hubspot_objects
  - crm_disassociate_hubspot_objects
  - crm_link_manual
  - ask_user_choice
requires-user-confirm: false
disable-model-invocation: false
user-invocable: true
---

# HubSpot Full-CRUD via Chat

## Operations-Matrix

Welche Operation existiert für welchen Objekt-Typ. **Jede Schreib-Operation
hat einen eingebauten Confirm-Dialog** (Tool fragt selbst per ask_user_choice
nach) — du musst KEINE doppelte Rückfrage stellen.

| Operation        | Companies | Contacts | Deals | Notes | Tasks |
|------------------|-----------|----------|-------|-------|-------|
| Search           | ✓         | ✓        | ✓     | (via Assoc) | ✓ |
| Read (introspect)| ✓         | ✓        | ✓     | ✓     | ✓     |
| Create           | **✓**     | **✓**    | **✓** | **✓** | **✓** |
| Update           | ✓         | ✓        | ✓     | ✓     | ✓     |
| Delete (archive) | **✓**     | **✓**    | **✓** | **✓** | **✓** |
| Associate        | ✓         | ✓        | ✓     | (inline create) | (inline create) |
| Disassociate     | ✓         | ✓        | ✓     | —     | —     |

Zusätzlich:
- `crm_complete_hubspot_task` — Aufgabe abhaken (Confirm)
- `crm_list_hubspot_owners` — Owner-Liste für hubspot_owner_id-Auflösung
- `crm_list_hubspot_tasks` — gefiltert (Owner, Status, Due-Date)
- `crm_list_hubspot_notes_for_object` — Notizen einer Company/Contact/Deal
- `crm_link_manual` — AVA-Firma ↔ HubSpot-Record (Confirm)

**Wichtig**: Wenn du nicht sicher bist, ob ein Tool für deinen Use-Case
existiert, ruf `tool_search` mit passenden Keywords auf. NIEMALS „kann
ich nicht" antworten ohne vorher zu suchen.

## Standard-Flow für Schreib-Operationen

1. **Objekt-Typ identifizieren** aus der Nutzer-Anfrage:
   - „Firma", „Account", „Unternehmen", „company" → Company
   - „Kontakt", „Person", „Ansprechpartner", E-Mail genannt → Contact
   - „Deal", „Opportunity", „Pipeline", „Verkauf" → Deal
   - „Notiz", „Note", „dokumentieren" → Note
   - „Aufgabe", „Task", „erinnere mich", „to-do" → Task

2. **IDs auflösen**:
   - Companies: `company_search` (AVA) → `crm_list_links_for_company`
     ODER `crm_search_hubspot_companies` direkt
   - Contacts: `crm_search_hubspot_contacts` (Name oder E-Mail)
   - Deals: `crm_search_hubspot_deals` (Deal-Name)
   - Bei Mehrdeutigkeit: EINMAL `ask_user_choice`. Disambiguierungs-
     Felder: Companies = Name+Domain+City, Contacts = Name+E-Mail+Company,
     Deals = Name+Stage+Amount+CloseDate.

3. **Schema lesen vor Update/Create** (außer Delete):
   - `crm_introspect_hubspot_<type>` mit einer existierenden ID
   - Liefert Property-Namen, Typen, Enum-Optionen (label + value).
   - Bei Enum-Feldern: API erwartet `value`, Nutzer sagt typischer-
     weise `label`. Mapping vor Tool-Call durchführen.

4. **Tool aufrufen**. Das Tool macht selbst Confirm + ggf. Fresh-GET-
   Verify (Update). KEINE doppelte Rückfrage.

## Operations-Details

### Companies

**Create** (`crm_create_hubspot_company`):
- Pflicht: `name`. Domain dringend empfohlen (Dedup).
- Standardmäßig IMMER `linkToAvaCompanyId` mitgeben, wenn die Firma
  schon in AVA existiert — Tool legt dann in einem Schritt auch die
  AVA↔HubSpot-Verknüpfung an.
- Vorher Dublettencheck mit `crm_search_hubspot_companies` (Name UND
  Domain).

**Update** (`crm_update_hubspot_company`): Property-Map mit HubSpot-
internen Namen. Enum-Werte als `value`. Tool macht Fresh-GET-Verify.

**Delete** (`crm_delete_hubspot_company`): Soft-delete (90 Tage
wiederherstellbar). Vorher Vorschau zeigen, Confirm-Dialog vom Tool.
Verknüpfte Contacts/Deals bleiben erhalten, nur disassoziiert.

### Contacts

**Create** (`crm_create_hubspot_contact`):
- Pflicht: `email` (Dedup-Key). Empfohlen: firstname, lastname.
- Optional `linkToHubspotCompanyId` für Inline-Verknüpfung.
- Vorher `crm_search_hubspot_contacts` mit der E-Mail prüfen.

**Update/Delete**: wie Companies.

### Deals

**Create** (`crm_create_hubspot_deal`):
- Pflicht: `dealname`, `pipeline`, `dealstage`. `dealstage` ist an
  `pipeline` gekoppelt — IMMER vorher Schema lesen (introspect auf
  einem bestehenden Deal liefert die gültigen Pipeline-Stage-Kombis
  in den enum-Optionen).
- Pflicht-Association zu Company oder Contact (mind. 1) — sonst
  orphan deal.
- Optional: amount, closedate (ISO), dealtype, hubspot_owner_id.

**Update**: `dealstage` rückwärts springen ist oft durch HubSpot-
Workflows blockiert. Wenn Fresh-GET-Verify `notApplied` zeigt: dem
Nutzer transparent erklären (Workflow-Validation, nicht unser Bug).

**Delete**: wie Companies.

### Notes (Engagements)

**Create** (`crm_create_hubspot_note`):
- Pflicht: `body` + mind. 1 `associations`-Eintrag (Company/Contact/Deal).
  Ohne Verknüpfung ist die Notiz in HubSpot kaum auffindbar.
- Optional `timestamp` (Default jetzt).

**Update/Delete**: Confirm wie üblich.

### Tasks (Engagements)

**Create** (`crm_create_hubspot_task`):
- Pflicht: `subject` + mind. 1 Association.
- Optional: body, dueAt (ISO — „morgen", „Freitag" vorher selbst zu
  ISO konvertieren), priority (LOW/MEDIUM/HIGH), type (EMAIL/CALL/TODO),
  ownerId.

**Complete** (`crm_complete_hubspot_task`): Confirm-Gate, setzt
Status=COMPLETED + completion_date.

**Update/Delete**: wie üblich.

## HubSpot Auto-Magic (vorsicht: Side-Effects)

HubSpot legt bei einem Contact-Create AUTOMATISCH eine Company an, wenn
die E-Mail-Domain (`kluck@herbst.de` → `herbst.de`) zu keiner bestehenden
Company passt. Selbst wenn du beim Contact-Create eine
`linkToHubspotCompanyId` angibst, kann HubSpot zusätzlich eine zweite
Company aus der E-Mail-Domain erzeugen.

Vorgehensweise um das zu vermeiden:

1. **Vor jedem Contact-Create**: `crm_search_hubspot_companies` mit der
   E-Mail-Domain (z. B. "herbst.de"). Wenn keine Company da ist und du
   eine andere Company für den Contact verknüpfen willst (z. B. der
   Contact arbeitet als Externer für einen Kunden), warne den Nutzer
   transparent: "HubSpot wird vermutlich automatisch eine zweite
   Company aus der E-Mail-Domain anlegen. Soll ich die hinterher
   löschen?"
2. **Nach jedem Contact-Create**: `crm_search_hubspot_companies` mit
   der E-Mail-Domain erneut prüfen. Wenn eine neue Company aufgetaucht
   ist (die du nicht erwartet hast), dem Nutzer das melden und
   `crm_delete_hubspot_company` anbieten.

Best-Case-Vermeidung: wenn der Contact zur bekannten Company gehört,
empfiehlt sich oft eine Contact-Search NACH dem Create, um zu
verifizieren dass NUR die intended Company verknüpft ist (nicht zwei).

## Spezialfälle

### Owner ändern

`hubspot_owner_id` ist numerisch. Nutzer sagt meistens den Namen:
1. `crm_list_hubspot_owners` → Liste (id + email + name)
2. Aus der Liste matchen. Bei Mehrdeutigkeit `ask_user_choice`.
3. ID in `properties.hubspot_owner_id` setzen.

### AVA-Firma ↔ HubSpot verknüpfen (nachträglich)

`crm_link_manual` — Confirm-Gate dabei. Nur nötig wenn die HubSpot-
Firma schon existiert und du sie mit einer bekannten AVA-Firma
verbinden willst. Bei Company-Create direkt `linkToAvaCompanyId`
verwenden — spart einen Tool-Call.

### Dublettencheck bei Create

VOR JEDEM Create einen Such-Aufruf. Bei klaren Treffern (gleicher
Name/E-Mail/Domain) den Nutzer transparent fragen: „Update statt
Create?" — Default-Empfehlung Update.

### Mehrstufige Workflows

Beispiel: „Leg ACME als Kunde an, mit Deal RAG Workshop":
1. `company_search` → AVA-companyId merken
2. `crm_search_hubspot_companies` → Dublettencheck
3. `crm_create_hubspot_company` mit linkToAvaCompanyId + lifecyclestage
   "customer" (Schema vorher lesen, um den value zu kennen)
4. Mit der zurückgegebenen HubSpot-companyId:
   `crm_introspect_hubspot_deal` (auf irgendeinem bestehenden Deal) →
   Pipeline/Stage-Optionen kennen
5. `crm_create_hubspot_deal` mit associations=[{objectType:"companies",
   objectId:<neue>}]

Der Nutzer bestätigt jeden Schritt einzeln (via Tool-eigenen
Confirm) — also kein „all-or-nothing"-Bündel, sondern eine ehrliche
Confirm-Kette.

## Was NICHT tun

- Niemals Companies/Contacts/Deals OHNE vorherigen Dublettencheck
  anlegen.
- Niemals read-only-Felder überschreiben (hs_object_id, createdate,
  lastmodifieddate, calculated). Werden vom Introspect-Tool eh
  rausgefiltert; falls du es trotzdem versuchst, HubSpot 403't.
- Niemals doppelte Rückfragen stellen — der Confirm liegt im Tool.
- Niemals „kein Tool dafür" antworten ohne vorher `tool_search` zu
  versuchen. ALLE Standard-CRUD-Operationen existieren (siehe Matrix
  oben).
- Beim Delete: Niemals raten welcher Record gemeint ist. Die Tool-
  eigene Record-Vorschau zeigt dem Nutzer was gelöscht würde — wenn
  das nicht das ist was er meinte, sagt er „abbrechen".
