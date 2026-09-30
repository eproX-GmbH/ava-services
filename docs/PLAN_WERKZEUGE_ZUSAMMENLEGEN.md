# Plan: Werkzeuge zusammenlegen (K5 aus PLAN_CHAT_DATEIEN_KONTEXT, 2026-09-30)

Anlass: 271 registrierte Werkzeuge. Seit v0.1.240 werden sie lazy geladen
(Kern + `tool_search`/`tool_load`), trotzdem kostet jede Firmenfrage eine
Suche, ein Laden und mehrere Einzelaufrufe. Anthropic („Writing tools for
agents“): ähnliche Werkzeuge zusammenlegen, damit das Modell weniger
auswählen und weniger Beschreibungen tragen muss.

## Bestand (v0.1.740)

| Präfix | Anzahl | Präfix | Anzahl |
| --- | --- | --- | --- |
| crm | 26 | mail | 9 |
| company | 16 | telegram | 8 |
| workflow | 14 | alerts | 8 |
| obsidian | 14 | link | 7 |
| linkedin | 13 | transaction | 6 |
| buying | 13 | settings / freshness / email | je 6 |
| org | 11 | watch / skill / relevanz / evaluation / discovery | je 5 |
| notion | 11 | übrige | < 5 |

## Nutzung (PromptAudit, 30 Tage bis 2026-09-30, eindeutige Aufrufe)

| Werkzeug | Aufrufe | Werkzeug | Aufrufe |
| --- | --- | --- | --- |
| tool_load | 88 | company_profile | 30 |
| crm_search_hubspot_companies | 55 | company_publications | 23 |
| company_contacts | 50 | crm_create_hubspot_contact | 20 |
| company_search | 48 | import_companies | 20 |
| skill_search | 48 | workflow_save | 15 |
| company_get | 47 | company_website | 15 |
| tool_search | 46 | company_structured_content | 11 |
| crm_search_hubspot_contacts | 43 | buying_center_setzen | 11 |
| company_crm_summary | 35 | company_keywords | 10 |

Lesart: `tool_load` und `tool_search` zusammen 134 Aufrufe sind reiner
Suchaufwand. Die zehn `company_*`-Leser werden fast immer zu mehreren für
dieselbe Firma aufgerufen. Alles andere ist selten; dort lohnt kein Umbau.

## W1 — company_get mit Bereichen (umgesetzt v0.1.741)

`company_get(companyId, bereiche?: [...], ansicht?)` liefert die Stammdaten
und in demselben Aufruf die gewünschten Abschnitte: profil, website,
register, stichworte, publikationen, kontakte, crm, datenqualitaet,
technik, insolvenz, linkedin, gesellschafter. Jeder Abschnitt scheitert für
sich (`fehler` je Bereich). `ansicht` gilt für publikationen und kontakte.
Die Einzelwerkzeuge bleiben registriert (Skills, Workflows, Bundles), aber
`company_profile` und `company_publications` sind nicht mehr im Kern.
Prompt-Regel: eine Firmenfrage ist ein `company_get` mit Bereichen.

Erwartung für den Betzemeier-Fall: statt tool_search + tool_load + 5
Einzelaufrufe ein Aufruf, rund 1.500 Tokens weniger Beschreibungen je Zug
und drei Modellschritte weniger.

## W2 — Kandidaten (nicht umgesetzt, nach Messung entscheiden)

- **crm (26):** `crm_search_hubspot_companies` und `_contacts` sind häufig,
  der Rest selten. Kandidat: `crm_get(objekt: firma|kontakt|deal, id,
  bereiche: [details, verknuepfungen, aufgaben, notizen])` statt
  introspect/list/fetch je Objekt. Schreibende bleiben getrennt
  (confirmAction).
- **buying_center (13):** anzeigen/anlegen/setzen/kante/vorschlaege sind
  ein Ablauf; Kandidat `buying_center(aktion, …)`. Aufrufe sind selten,
  Nutzen gering.
- **obsidian (14) / notion (11):** je Anbieter ein Lese- und ein
  Schreibwerkzeug mit `aktion`. Aufrufe in 30 Tagen: null. Kein Umbau,
  solange niemand sie nutzt.
- **workflow (14):** save/update/get/list/run/catalog/templates; Kandidat
  `workflow(aktion)`. 35 Aufrufe, meist save. Prüfen, ob `tool_search` sie
  zuverlässig findet; sonst zusammenlegen.

Nicht zusammenlegen: Werkzeuge mit Bestätigung (confirmAction) bleiben
einzeln, damit der Bestätigungstext zur Aktion passt.

## Regeln für neue Werkzeuge

1. Lesende Werkzeuge derselben Sache bekommen `bereiche`, nicht neue Namen.
2. Standard kompakt, `ansicht: "voll"` nur ausdrücklich (AIP-157).
3. Namen statt IDs in Antworten; wo eine ID nötig ist, beides.
4. Fehlertexte nennen den nächsten Schritt.
5. Ein neues Werkzeug kommt in eine Fähigkeitsgruppe
   (`suggestions/faehigkeiten.ts`) und in ein Bundle in `tools/meta.ts`,
   wenn es zu einem Ablauf gehört.

## Messung

`tool_search` + `tool_load` je 100 Züge und Tokens je Zug in
`LlmUsage.inputTokens`, vor/nach v0.1.741. Ziel: Suchaufwand halbiert.
