---
name: qualifying-deep
description: >
  Tiefen-Qualifying-Fragebogen für Maschinenbau-Leads, der die Lead-Quelle,
  den ICP-Match und Budget-Indikatoren strukturiert erfasst.
language: de
b2b-scope: qualifying
allowed-tools:
  - company_get
  - company_profile
  - company_contacts
requires-user-confirm: false
disable-model-invocation: false
user-invocable: true
arguments:
  - name: company-id
    description: AVA companyId der Ziel-Firma
    required: true
  - name: notes
    description: Optionale Kontextnotizen aus dem CRM
    required: false
metadata:
  ava:
    requires: {}
---

# Qualifying – Maschinenbau

Stelle der Reihe nach die folgenden Fragen, dokumentiere die Antworten
strukturiert und schlage am Ende ein Qualifying-Verdict vor.
