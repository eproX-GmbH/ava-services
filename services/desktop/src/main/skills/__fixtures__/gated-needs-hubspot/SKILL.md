---
name: hubspot-enrich
description: >
  Reichert HubSpot-Firmen mit Konkurrenz-Daten an. Gate: erfordert
  verbundenes HubSpot-CRM — wird ohne aktive Verbindung übersprungen.
b2b-scope: data-extraction
allowed-tools:
  - crm_fetch_details_raw
  - crm_enrich_now
metadata:
  ava:
    requires:
      crm: hubspot
---

# HubSpot Enrich

TODO(S2): wenn der CRM-Gate-Evaluator gewired ist, wird dieses Skill
nur geladen, sobald HubSpot verbunden ist.
