---
name: notion-crm-update
description: >
  Aktualisiert Felder in einer Notion-Datenbank (CRM, Pipeline, Deals).
  Aktiviere bei Anfragen wie „aktualisiere im Notion CRM", „setze Status
  von X auf Y in Notion", „Follow-Up von Z auf 2026 korrigieren",
  „erledigt eintragen", „verloren markieren", „in Notion ändern".
language: de
b2b-scope: internal
allowed-tools:
  - notion_list_databases
  - notion_introspect_database
  - notion_query_database
  - notion_update_page
  - ask_user_choice
requires-user-confirm: false
disable-model-invocation: false
user-invocable: true
---

# Notion-CRM-Update (festes 4-Schritt-Playbook)

Du arbeitest in einer Notion-Datenbank, die als CRM / Pipeline genutzt wird.
Halte dich strikt an die folgende Reihenfolge. Frag den Nutzer NICHT zurück,
solange du Schritte selbst per Tool auflösen kannst.

## 1. Database finden

`notion_list_databases` aufrufen. Wähle die CRM-DB automatisch nach dem
Titel: „CRM", „QUIKK CRM", „Pipeline", „Kontakte", „Deals". Bei mehreren
plausiblen Kandidaten EINMAL per `ask_user_choice` rückfragen, sonst NIE.

## 2. Schema lesen

`notion_introspect_database` mit der Database-ID. Notiere für die Felder,
die der Nutzer ändern will:
- den EXAKTEN Property-Namen (z. B. „Follow-Up (Datum)", nicht nur
  „Follow-Up")
- den Typ (`title`, `rich_text`, `status`, `select`, `multi_select`,
  `date`, `number`, `checkbox`, `url`, `email`, `phone_number`)
- bei `status`/`select`/`multi_select`: die verfügbaren OPTIONS

## 3. Zeile finden

`notion_query_database` mit einem korrekten Filter. Pflicht-Shape:

```
{ "property": "<title-property-name>", "title": { "contains": "<wert>" } }
```

Beispiele:
- `{ "property": "Name", "title": { "contains": "Kerstin" } }`
- `{ "property": "Name", "title": { "equals": "Sascha Beckmann" } }`

KEIN Filter ohne `property`-Key. KEIN Empty-`{}`-Filter. Bei mehreren
Zeilen-Treffern: `ask_user_choice` mit den Titeln zur Auflösung.

## 4. Updaten

`notion_update_page` mit der pageId aus Schritt 3. Properties als FLAT
JSON-Objekt mit den EXAKTEN Schema-Namen aus Schritt 2.

```
{
  "pageId": "<uuid>",
  "properties": {
    "Aktion": "Disqualifiziert",
    "Follow-Up (Datum)": "2026-07-16",
    "Comment": "Wahrscheinlich zu teures Angebot"
  }
}
```

## Status-/Select-Mapping (Nutzer-Worte → Schema-Option)

Wenn der Nutzer informelle Worte benutzt, mappe auf Schema-Options aus
Schritt 2. Häufige Fälle:

- „erledigt" / „verloren" / „nicht relevant" → meistens „Disqualifiziert"
  / „Verloren" / „Lost" / „Closed Lost" — wähle DIE Option die im
  Schema EXAKT existiert. Bei mehreren plausiblen Options EINMAL per
  `ask_user_choice` rückfragen, sonst nimm die erste plausible.
- „hot" / „heiß" → „Hot" / „Heiß"
- „cold" / „kalt" / „kalter Lead" → „Cold" / „Kalt"
- „qualifiziert" / „qualified" → „Qualified" / „Qualifiziert"

NIEMALS eine Option erfinden, die nicht im Schema steht. Der Update-Call
verifiziert After-Write und meldet dir präzise Fehler.

## Datums-Werte

ISO-8601 ohne Zeitzone: `"2026-07-16"`. Wenn der Nutzer nur ein Jahr
nennt („auf 2026 korrigieren") und ein bestehendes Datum existiert (siehe
Schritt 2/3), behalte Tag + Monat des bestehenden Datums und tausche nur
das Jahr.

## Mehrere Updates parallel

Wenn der Nutzer mehrere Zeilen in einer Nachricht ändern will (z. B.
„Kerstin auf erledigt UND Sascha Follow-Up auf 2026"), führe die
`notion_update_page`-Calls PARALLEL im selben Turn aus. Nicht
nacheinander warten.

## Fehler-Behandlung

Wenn ein Tool-Call fehlschlägt:
1. Lies die VOLLSTÄNDIGE Fehler-Meldung (Verfügbare Properties, gesendeter
   Filter etc. stehen darin).
2. Korrigiere GENAU den im Fehler genannten Punkt (Property-Name,
   Option-Name, Filter-Form).
3. Versuche es EINMAL erneut. Nicht 3× identisch retryen.
4. Wenn der zweite Versuch auch fehlschlägt, melde dem Nutzer den
   konkreten Fehlertext + was du versucht hast.

## Abschluss-Bericht

Nach erfolgreichem Update knapp zusammenfassen:

```
Aktualisiert in [QUIKK CRM]:
- Kerstin Komarnicki: Aktion = Disqualifiziert, Comment = "Wahrscheinlich zu teures Angebot"
- Sascha Beckmann: Follow-Up (Datum) = 2026-07-16
```

Wenn `notion_update_page` Warnings zurückgibt (z. B. „Follow-Up" wurde
auf „Follow-Up (Datum)" fuzzy-gemappt), zitiere die Warnings einzeilig
am Ende des Berichts, damit der Nutzer es beim nächsten Mal direkt
exakt schreiben kann.
