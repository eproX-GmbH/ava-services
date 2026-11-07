# Systemprompt und Seele: Einordnung für die Prompt-Diät

Stand 2026-11-07, main (Commit 7335a568). Nur gelesen, nichts geändert.

## 0. Messgrundlage

- `scripts/prompt-groesse.mts` baut `buildSystemPrompt(leere Registry, profile=null, {skills:[], rememberedFacts:[], availableToolNames: ∅})`
  und schneidet mit `promptAbschnitte()` (`main/agent/kontext-messung.ts`): Trennung an `\n\n`, wenn die nächste Zeile
  wie eine Überschrift aussieht (`#…`, `Großbuchstabe…:` oder kurze Großbuchstabenzeile). Tokens = Zeichen / 3,6.
  Gleichnamige Köpfe werden summiert (z. B. zweimal „NIEMALS:“), das Skript sortiert nach Größe.
- Hier stattdessen in Prompt-Reihenfolge (64 Teile, Nummern `[n]` = Reihenfolge im Prompt). Ergebnis: **58.807 Zeichen,
  ~16.335 Tokens statisch**. Aufteilung: SOUL (soul.ts) ~2.080 · persona (prompts.ts) ~12.080 · CHART_INSTRUCTIONS ~880 ·
  BUYING_CENTER_INSTRUCTIONS ~930 · statusBlock (Firmenstatus + Land) ~360.
- Achtung Messartefakt: Der Teil „### Wie du mit dem Nutzer arbeitest“ (1.040 im Skript) enthält auch den nachfolgenden
  statusBlock, weil dieser mit `Firmenstatus — …` ohne Doppelpunkt am Zeilenende beginnt. Echt: BC-Arbeitsweise ~677,
  Firmenstatus ~118, Land ~244.
- **Dynamisch je Turn, nicht im Skript** (Reihenfolge in `buildSystemPrompt`, prompts.ts ~1033 ff.):
  Profil-Block (~80–250, nur mit Profil) · ICP-Block (≤1.500 Zeichen ≈ ≤450) · Feste Anhänge (≤1.500 Zeichen ≈ ≤450) ·
  Langzeitgedächtnis (bis 30 Einträge + ~90 Fußtext) · First-Run-Nudge (~430, nur leeres Profil, nicht übersprungen, ohne
  Gedächtnis) · Skills-Liste + Skill-Ablehnungsblock (~70) · Werkzeugnamen-Liste (nur Namen; 13 Kern-Werkzeuge ≈ 60–80,
  wächst mit tool_load) · Aktives-Skill-Hinweis · Auto-Triage-Block (~880, mit Telegram-Rückfrage/Vollmacht ~980).
  Dazu außerhalb des Systemprompts: Schemas der 13 Kern-Werkzeuge (`ALWAYS_ON_CORE_TOOL_NAMES`, tools/meta.ts:262) plus
  geladene Werkzeuge, Verlauf. Aus L0 (Minimum 22.600 Eingabe-Tokens) folgt grob ~6.000 für Kern-Schemas + kürzesten Verlauf.

Wichtiger Befund für die Zielwahl: Beschreibungen nachgeladener Werkzeuge sieht das Modell erst NACH `tool_load`.
Ablaufwissen („wie“) kann gefahrlos in die Beschreibung. Der Auslöser („wann“) muss entweder als eine Zeile im Prompt
bleiben oder über `tool_search` (summary/category) sicher gefunden werden. Ein Kartenformat für reines Modellwissen gibt es
noch nicht (`wissen/format.ts` kennt keine Zielgruppe), daher hier überall (b) Funktionsbeschreibung bzw. Werkzeugergebnis.

## 1. Tabelle prompts.ts (persona, Diagramme, Buying Center, Status), Reihenfolge wie im Prompt

Die Abschnitte [1]–[20] (soul.ts) stehen im Prompt davor, Einordnung in §5.

| Abschnitt (Überschrift/Anfang) | ~Tokens | Inhalt in 1 Satz | Klasse | Begründung | Ziel |
|---|---|---|---|---|---|
| [21] AVA: dein Recherche-Assistent … | 145 | Ton (sachlich, keine Emojis/Geviertstriche), Du-Form, Du/Sie bei Dritten. | regel | Ton/Anrede gilt in jeder Antwort. Kleiner Fehler: „deutsche B2B-Firmen“, obwohl 6 Länder. Rollenzeile doppelt mit Seele [2], zusammenlegen. | bleibt (~140) |
| [22] Sprache: IMMER Deutsch … | 65 | Sprachwechsel nur bei vollständigen englischen Sätzen. | regel | Wirkt nur, wenn immer da. | bleibt |
| [23] Fakten-Disziplin … | 182 | Nichts erfinden, Nicht-Können ehrlich sagen, Nutzerbehauptungen über App-Zustand erst prüfen. | kuerzen | Satz 1 doppelt mit Seele [8]/[9]; Hinweis „transactions_list prüfen“ steht schon in `import_companies`. Vorschlag: nur die Prämissen-Regel behalten („Behauptet der Nutzer etwas über den App-Zustand oder deine früheren Aktionen: erst nachprüfen, nie einer falschen Prämisse zustimmen, richtiges eigenes Verhalten nicht nachträglich zum Fehler erklären“). | bleibt gekürzt (~80) |
| [24] Firmen-Verlinkung (Pflicht-Format) | 400 | `[Name](company:<id>)` mit Regeln zu Wiederholung, Import-Vorschau, erfundenen Pfaden, Personen. | kuerzen | Ausgabeformat, muss immer da sein. Aber 8 Punkte mit Begründungen. Vorschlag: 4 Zeilen: Format + Beispiel, erste Nennung je Absatz; nur IDs/`avafile:`/URLs aus Tool-Ergebnissen (Import-Vorschau = noch keine ID = kein Link); nie Pfade wie `/companies/…`, ID nie im Fließtext; Personen nie verlinken. | bleibt gekürzt (~200) |
| [25] Tool-Discovery (Lazy-Loading) | 1.664 | Such-Regel (tool_search zuerst, Wissen), Laden ohne Rückfrage, Bündel-Listen (CRM, Notion, Obsidian, Alerts, Import, Watches, Link, Workflows inkl. Workflow-Regeln), Close-Hinweis. | kuerzen | Kern (~250) ist die Such-Regel und bleibt. ~1.400 sind Bündel-Namenslisten und Ablaufwissen: `tool_search` hängt schon Bündel-Hinweise an (`KNOWN_BUNDLES`, tools/meta.ts:321 ff.), es fehlen dort nur „Workflows“ und „CRM lesen“. Die Workflow-Regeln (catalog zuerst, Entwurf zeigen, dryRun, confirmed, Platzhalter, eine Firma je Lauf) gehören in `workflow_save`/`workflow_run`. Close → Karte `verbindungen/crm-verbinden` (gibt es) + `import_companies_from_crm`. Widersprüche siehe §4 Nr. 1. | Such-Regel bleibt (~250); Bündel → tools/meta.ts `KNOWN_BUNDLES` (+Workflows, +CRM-Lesen); Workflow-Regeln → tools/workflows.ts; CRM-Lese-Hinweis „ein Aufruf `crm_list_hubspot_associated_records`“ → tools/crm.ts |
| [26] Verbundene Dienste | 475 | Wo man Dienste verbindet, `mcp_<dienst>_*`/`a2a_*`-Namen, Schreibwerkzeuge fragen nach, fehlender Dienst → `app_oeffnen`, `dienst_ereignisse`, abgelaufener Zugang. | wissen | Nutzerfrage „wie verbinde ich X“ deckt Karte `verbindungen/dienst-verbinden` (gibt es). Namensschema und Ereignisse sind Modellwissen. Regel-Rest: „Zugangsdaten nie im Chat erfragen“. Die erwartete Fehlermeldung „Zugang abgelaufen oder ungültig“ gibt es im Code nicht (§4 Nr. 12). | (a) `verbindungen/dienst-verbinden` (vorhanden); (b) Namensschema → tool_search-Beschreibung (tools/meta.ts) bzw. Werkzeugbeschreibungen in main/mcp-client/werkzeuge.ts; Ereignisse → tools/dienste.ts; 1 Satz Regel bleibt (~40) |
| [27] Wiederholte Tool-Aufrufe erkennen und abbrechen | 234 | Beim dritten ähnlichen Aufruf innehalten, Sammelwerkzeuge nutzen, Sperre nach 12. | kuerzen | Abbruch-Regel muss immer da sein. Vorschlag: 2 Sätze („Dritter ähnlicher Aufruf ohne Fortschritt = falsches Vorgehen: Sammelwerkzeug suchen, ID aus früherem Ergebnis nehmen oder fragen. Mehrere Objekte immer mit einem Sammelaufruf.“). Die Sperre (12, Hinweis ab 5) meldet die App im Ergebnis selbst (orchestrator.ts:75). | bleibt gekürzt (~90) |
| [28] Selbstkorrektur melden | 280 | Nach erfolgreichem Workaround `report_self_correction` mit Beispiel und Feldern. | doppelt | Beschreibung von `report_self_correction` trägt Anlass, Beispiel, Felder, „bleibt lokal“ fast wörtlich; Kern-Werkzeug, also immer sichtbar. Nur „kein Report bei Nutzerfehler“ fehlt dort. | tools/self-correction.ts (Satz „kein Report bei Nutzerfehlern“ ergänzen); Prompt 0 |
| [29] Test oder Ernstfall | 267 | Bei Test Platzhalter nutzen; sonst unbekannte Angaben gebündelt in einer `ask_user_text`-Runde fragen; fehlende Adresse → `email_adresse_pruefen`. | kuerzen | Gilt für alle Texte an Dritte, kein Werkzeug als Auslöser, bleibt also. Punkt 3 steht in `email_adresse_pruefen` (Werkzeugbeschreibung). Vorschlag: Punkt 1 auf 2 Sätze, Punkt 2 auf 1 Satz, Punkt 3 streichen. | bleibt gekürzt (~140); Punkt 3 → tools/email-muster.ts |
| [30] Mail-Entwürfe zum Selbstversenden (2026-10-10) | 408 | ```mail-entwurf-Block mit JSON-Feldern, Adressen nie erfinden, Ablegen im Entwürfe-Ordner, reine Textaufgaben ohne Werkzeug. | kuerzen | Ausgabeformat ohne Werkzeug-Auslöser, muss bleiben. `mail_entwurf_ablegen`-Punkt doppelt mit tools/mail-entwurf.ts. Datum im Titel streichen. „Reine Textaufgaben direkt schreiben“ ist eine allgemeine Regel, nach oben zu [21] ziehen. | bleibt gekürzt (~230); Ablage-Punkt → tools/mail-entwurf.ts |
| [31] Vertriebsblick nach einer Firmenauskunft (2026-10-04) | 531 | Nach Firmenauskunft max. 3 Sätze: belegter Anlass (inkl. gemeinsame Kunden), ICP-Passung, nächster Schritt; Ausnahmen. | kuerzen | Antwortformat nach jeder Firmenauskunft (Kern-Werkzeug company_get), muss immer da sein. Der Absatz „Gemeinsame Kunden“ (~130) ist Wissen über das Feld `gemeinsameKunden`/`wirdGenanntVon` und gehört in die Beschreibung von `company_get` (Bereich kunden) bzw. `company_kunden`. Anlass-Beispielliste auf eine Zeile. | bleibt gekürzt (~280); Kunden-Absatz → tools/companies.ts |
| [32] Handeln statt Nachfragen | 554 | Nicht bei Teilergebnis stoppen, Schreibaktionen versuchen und aus Fehlern lernen, nur bei echter Mehrdeutigkeit fragen, Suchkette, Disambiguierung mit ask_user_choice. | kuerzen | Punkte 1–3 sind Kernregeln. Punkt 4 (Suchkette) doppelt mit Seele [13] und den Beschreibungen von `register_live_suche`/`firma_finden`. Punkt 5 doppelt mit Seele [14]; die Details (limit 10, label=Name, description=Ort, „Sonstiges“ kommt automatisch) gehören in `company_search`/`ask_user_choice`. | bleibt gekürzt (~200); Disambiguierungs-Details → tools/companies.ts (`company_search`) bzw. tools/ui.ts (`ask_user_choice`) |
| [33] Notion-CRM-Updates (festes Playbook) | 248 | 4-Schritt-Ablauf list → introspect → query → update, nie ask_user_text. | doppelt | Steht ausführlicher als „MANDATORY PLAYBOOK“ in `notion_update_page` und als STEP 1 in `notion_list_databases`, dazu als Bündel in [25]. | tools/notion.ts (vorhanden); Prompt 0 |
| [34] Fan-out bei Firmenfragen | 184 | Spezifisch → 1–2 Bereiche, offen → ein company_get mit 7 Bereichen. | doppelt | Seele [4] Schritt 2 und `company_get`-Beschreibung („EIN company_get mit den passenden Bereichen“) tragen das; dazu [46] Punkt 1. | Seele [4] + tools/companies.ts; Prompt 0 |
| [35] AVA-Firma nach HubSpot übernehmen (Standard) | 631 | HubSpot-Sync in einem Aufruf, dann ein Sammelsurium allgemeiner Auskunftsregeln (keine Facetten-Rückfrage, leere Facette normal, verarbeitung, Datenqualitäts-Notiz, CRM-Kontext-Format, strukturierte Übersicht, HubSpot-Link-Format). | wissen | Überschrift passt nur zu Punkt 1, der fast wörtlich in `crm_sync_hubspot_company_from_ava` steht. verarbeitung doppelt mit Seele [11] + company_get. Tier-Notiz → `company_data_quality`. CRM-Kontext-Format → `company_crm_summary`. HubSpot-Link-Format nur bei CRM nötig → `crm_status`. Regel-Rest: „Antwort als strukturierte Übersicht, kein rohes JSON; eine leere Facette ist normal, kein Retry“. | (b) tools/crm.ts (`crm_sync_…`, `crm_status` mit Link-Format), tools/companies.ts (`company_data_quality`, `company_crm_summary`); Regel-Rest ~60 nach [21] |
| [36] Self-Service (immer erlaubt, nie verweigern) | 229 | Provider, Schlüssel, LinkedIn/CRM, Ollama, Voice, Updater … per Werkzeug; Anthropic-Abo-Token; Tokens nie wiedergeben. | kuerzen | Kernsatz „Einstellungen per Werkzeug ändern, nie ‚das kann ich nicht ändern‘; Schlüssel und Tokens nie wiedergeben“ (~50) bleibt. Anthropic-Absatz ist veraltet (§4 Nr. 3). Widerspruch zu „Zugangsdaten nie im Chat“ (§4 Nr. 11). | bleibt gekürzt (~70); Anthropic-Abo → (a) Karte `ki/anthropic-abo` (Nutzersprache: Einstellungen → KI & Kosten, `app_oeffnen` ziel modell) |
| [37] Langzeit-Gedächtnis | 206 | Aktueller Chat braucht kein Werkzeug; `recall_memory` bei Bezug auf früher; `remember` nur auf Auftrag/stabile Präferenz; Löschablauf. | wissen | `recall_memory`, `remember`, `forget_memory` (inkl. Löschablauf mit ask_user_choice) tragen das. Auslöser bleibt nötig, weil die Gedächtnis-Werkzeuge nicht im Kern sind. | (b) tools/memory.ts (vorhanden); 1 Auslöse-Zeile bleibt (~30) |
| [38] Meldungen / Heartbeat | 314 | Phrasen → alerts_list/dismiss/dismiss_all/purge/trigger_heartbeat/set_prefs inkl. Minutenumrechnung Ruhezeiten. | wissen | Alle Fälle stehen in den Beschreibungen (alerts_dismiss_all, alerts_purge inkl. Fall `dismissed: 0`, alerts_set_prefs mit Beispielen); `tool_search` findet „Meldungen“ als Bündel. „Sag nie kein Lösch-API“ deckt [36]/[32]. | (a) Karte `meldungen/meldungen-einstellen` (Rhythmus, Push, Ruhezeiten; `app_oeffnen` ziel meldungen_einstellen); (b) tools/alerts.ts (vorhanden) |
| [39] Aktualisierung / Freshness (Auto-Refresh-Scheduler) | 698 | Unter falscher Überschrift: freshness_scan/run_now, Plan + Kontingent (Free/Pro/Max/Ultra, Preise), aktiv/ruhend, Problem melden, Auffrischungs-Rhythmus nicht einstellbar, Priorisieren. | wissen | Fünf Themen in einem Abschnitt. Freshness/Pin doppelt mit tools/freshness.ts. Plan/Kontingent hängt am Pricing-Schalter (§4 Nr. 10) und gehört in `abrechnung_status`/`plan_wechseln`. Aktiv/ruhend steht in `firma_aktivieren` + Feld `aktivierung` von company_get. Problem melden ≈ `problem_melden`-Beschreibung. Regel-Rest: „ruhende Firma ≠ ‚liegt nichts vor‘“ gehört zur Seele [11]; „nie ‚Tier‘ sagen“ in den Glossar-/Jargon-Check. | (a) Karten `abrechnung/plan-und-kontingent`, `firmen/aktiv-und-ruhend`, `firmen/auffrischung` (was AVA selbst aktualisiert, was nicht einstellbar ist, Priorisieren), `konto/problem-melden`; (b) tools/abrechnung.ts, tools/imports.ts (`firma_aktivieren`, `firma_ruhen_lassen`), tools/freshness.ts, tools/problem.ts; Regel-Rest ~60 in Seele [11] |
| [40] Standing Watches | 254 | watch_register mit prompt/cadence/rubric/companyIds/topics, Bestätigung, Verwalten, Cap 20. | doppelt | `watch_register` trägt Bestätigung, Cap 20, companyIds über company_search, topics. Abgrenzung zu Link-Überwachung ist Nutzerwissen. | (a) Karte `meldungen/firma-beobachten` (Watch vs. Link-Überwachung); (b) tools/watches.ts (vorhanden); Prompt 0 |
| [41] Link-/Website-Überwachung | 508 | Abgrenzung zu Watches, link_monitor_register mit Frequenz, kommentarloser Link → fragen, „Sonstiges“-Folgeaufruf, Verwalten, Cap 5. | wissen | `link_monitor_register`/`_list` tragen Frequenzen, kommentarlosen Link, Cap 5. Neu für die Beschreibung: „Sonstiges“ → erneut mit derselben url + intervalMinutes. Auslöser „kommentarlos geschickter Link → Überwachung anbieten“ muss als eine Zeile bleiben (Werkzeug ist nicht im Kern). | (a) Karte `meldungen/webseite-ueberwachen`; (b) tools/link-monitor.ts (Sonstiges-Fall ergänzen); 1 Auslöse-Zeile bleibt (~30) |
| [42] Angebot / Ausschreibung / „welche Firma passt am besten“ | 202 | Ein Aufruf `icp_bestand_abgleich`, Ranglisten-Format, kein Bewertungs-Werkzeug mehr. | kuerzen | Auslöser + Antwortformat sinnvoll im Prompt, weil das Modell sonst einzeln durchgeht. Schlusssatz „kein Bewertungswerkzeug mehr“ ist Altlast. Vorschlag: 2 Sätze („Wer passt zu ICP/Angebot/Ausschreibung → ein `icp_bestand_abgleich` mit Anfragetext; Antwort Rangliste Firma · Score · Begründung, keine Scores erfinden“). Ranglisten-Format kann alternativ ins Werkzeugergebnis. | bleibt gekürzt (~70); Format optional → tools/icp-abgleich.ts |
| [43] Bestandsfragen („Gibt es Firmen, die …“) | 728 | Ein `bestand_suchen` ohne Rückfrage, Begriffe/Quellen/Limit, Antworttabelle Firma/Beleg/Quelle, Pool außerhalb der Firmenliste mit eigenem Format. | kuerzen | Auslöser doppelt mit Seele [16], Aufrufregeln (Synonyme, quellen je Frageart, limit 5/100, pool-Regeln) fast wörtlich in `bestand_suchen`. Laut Lehre aus S5 brauchen Kern-Werkzeuge Auslöser + Antwortformat im Prompt, also bleibt: Tabelle `Firma · Beleg · Quelle`, Satz „X von Y“, Satz „N weitere“. Das Pool-Format (nur bei `bereich: pool`) ins Werkzeugergebnis. | bleibt gekürzt (~200); Pool-Format → tools/companies.ts (`bestand_suchen`, Ergebnis bei pool) |
| [44] Idealkundenprofil (ICP) + Firmen-Radar | 311 | ICP aus Beschreibung/URLs speichern, Radar-Kette scan → profile → match nur mit vollständigem ICP, Entscheidungen nur durch den Nutzer. | wissen | `icp_set` (Auslöser „beschreibt sein ICP“), `icp_assist_from_urls`, `discovery_scan` (lehnt ohne vollständiges ICP ab, discovery.ts:151), `discovery_decide` tragen das. Auslöser bleibt nötig, weil nicht im Kern; passt als Zusatz in den ICP-Block („Änderungen nur via icp_set“ steht dort schon). | (a) Karte `firmen/neue-firmen-finden` (Radar, was man dafür braucht); (b) tools/icp.ts, tools/discovery.ts; Auslöse-Zeile (~40) in den ICP-Block bzw. Prompt |
| [45] Tabellen-Anhänge (.xlsx/.xls/.csv) | 215 | Anhang-Marker lesen, Firmen-/Stadt-Spalte per ask_user_choice bestätigen, Zusammenfassung, keine Beispielzeilen zitieren. | wissen | Reiner Ablauf für `import_excel`. Mit Anhang lädt der Orchestrator schon `datei_*` automatisch (orchestrator.ts ~1203); `import_excel` dort mitladen, dann trägt seine Beschreibung den Ablauf. | (b) tools/imports.ts (`import_excel`) + Auto-Laden in agent/orchestrator.ts |
| [46] Import starten | 731 | Gemischt: company_get-Regel, Dateien lesen nur bei Bedarf, import_excel genau einmal, nicht zeilenweise suchen, „gestartet, ich melde mich“, import_companies in einem Aufruf mit Stadt/companyIds/country, CRM-Import. | wissen | Punkt 1 doppelt mit [34]. Datei-Punkt → `datei_suchen`/`datei_lesen`. import_companies-Punkt steht fast wörtlich in dessen Beschreibung (Ein-Aufruf, Stadt, companyIds, country). CRM-Punkt → `import_companies_from_crm` (veraltet, §4 Nr. 4). Regel-Rest „Ein Start ist kein Abschluss; sag, dass es im Hintergrund läuft und du dich selbst meldest, nicht ‚frag später nach‘“ bleibt, zusammen mit [50]. | (a) Karte `firmen/firmen-importieren` (vorhanden); (b) tools/imports.ts, tools/dateien.ts; Regel-Rest ~60 |
| [47] Hintergrundaufgaben (laufende Verarbeitung) | 246 | `aufgabe_beobachten` für andere Vorgänge; Antwortformat auf „[Hintergrundaufgabe abgeschlossen/abgebrochen]“-Nachrichten. | wissen | Ereignisgebunden: Die Antwortanweisung wird nur gebraucht, wenn so eine Nachricht kommt. Sie kann in die Nachricht selbst (Präfix `MELDUNG_PRAEFIX`, main/aufgaben/aufgaben.ts:130). `aufgabe_beobachten` trägt seinen Zweck selbst. | (b) main/aufgaben/aufgaben.ts (Anweisung in die Meldung), tools/aufgaben.ts; Auslöser „sag Bescheid, wenn fertig“ ~30 |
| [48] Fortschritt eines laufenden Imports | 84 | „wie weit?“ → import_status, Details nur auf Nachfrage, transactionId nicht erfragen. | doppelt | `import_status` sagt „Prefer this over transaction_pipeline when the user asks …“. | tools/imports.ts; Prompt 0 |
| [49] DryRun bei Bulk-Importen | 424 | Erst dryRun, Report-Link `avafile:`, Zusammenfassung, einmal `resolve_import_matches` mit resolveToken, dann commit. | wissen | Beschreibungen von `import_companies` (dry-run zuerst, Report) und `resolve_import_matches` (nur resolveToken) tragen das. Das Link-Format für den Report gehört ins Dry-Run-Ergebnis (mit Emoji, §4 Nr. 5). | (b) tools/imports.ts (Ergebnis liefert fertigen Link-Text) |
| [50] Retry einer gescheiterten Stage | 645 | transaction_pipeline → je failed-Zelle retry_stage, Stufennamen, research_run/firma_neu_verarbeiten abgrenzen, Berichtsformat, „angestoßen ≠ fertig“, kein Retry bei pending. | wissen | Stufennamen sind das Enum im Schema; Abgrenzung research_run/firma_neu_verarbeiten steht in deren Beschreibungen; Ablauf + Berichtsformat + pending≠failed passen in `retry_stage`. Allgemeine Regel „angestoßen ist nicht erledigt“ gilt auch für Import, freshness_run_now, research_run → einmal kurz im Prompt (zusammen mit [46]). | (b) tools/imports.ts (`retry_stage`), tools/transactions.ts (`transaction_pipeline`); Regel-Rest ~40 |
| [51]–[59] Diagramme (Wann/Wann nicht/Art/Format/Harte Regeln/Beispiele/Mehrere Serien) | 881 | ```chart-Block mit JSON-Schema, Diagrammarten, 9 harte Regeln, zwei Beispiele. | kuerzen | Ausgabeformat ohne Werkzeug-Auslöser, also bleibt der Kern. Wann/Wann-nicht auf 2 Zeilen, Beispiel [58] streichen (doppelt mit dem Format-Beispiel), [59] in die Art-Liste, harte Regeln auf 1, 2, 3, 8, 9 (int!) bündeln; „alle y-Werte aus Tool-Ergebnissen“ steht schon in Seele [9]. | bleibt gekürzt (~350) |
| [60]–[63] Buying Center (Power Map): Einleitung, Karte anzeigen | 256 | Sieck-Dimensionen mit Kürzeln; wenn ein buying_center_*-Werkzeug `anzeigen` liefert, ```buying-center-Block einfügen. | wissen | Kürzel sind in den Schemas der buying_center-Werkzeuge; der Block-Hinweis wird nur gebraucht, wenn ein Ergebnis `anzeigen` trägt, kann also ins Ergebnis selbst. | (b) tools/buying-center.ts (Dimensionen in `buying_center_setzen`, Block-Anweisung ins Ergebnis von anlegen/anzeigen/setzen); 1 Zeile Rest (~20) |
| [64] Wie du mit dem Nutzer arbeitest (Buying Center) | 677 | Vorschläge sind Vorschläge, Leitfragen, Beziehungen sofort als Kante, sachliche Gründe (Auskunftspflicht), Beobachten, Verknüpfen, Website-Vorschläge, Automatik, Recherche, Erinnerung, Freigeben/Geteilt. | wissen | Nur bei BC-Werkzeugen relevant; jede Regel hat ein Werkzeug (kante, vorschlaege, beobachten, verknuepfen, automatik, recherche, freigeben, geteilt). Die Regel „Gründe sachlich, keine Charakterurteile“ muss mit jedem schreibenden BC-Werkzeug geladen werden. | (b) tools/buying-center.ts (je Werkzeug); (a) Karte `recherche/buying-center` für „was ist ein Buying Center / wie lege ich es an“ |
| Firmenstatus — harte Regel (statusBlock) | 118 | `statusWarnung` als erste Zeile mit ⚠️, alles daran ausrichten. | regel | Gilt für jede Firmenauskunft, Kern-Werkzeug company_get liefert das Feld. Widerspruch ⚠️ vs. „keine Emojis“ (§4 Nr. 5). | bleibt (~110) |
| Land: Firmen können aus … (statusBlock) | 244 | 6 Länder, Registernamen je Land, deutsche Begriffe nicht übertragen, CH ohne Abschlüsse. | kuerzen | Regelkern (~80): „Land nennen, wenn nicht DE; deutsche Registerbegriffe nicht auf ausländische Firmen übertragen; CH hat keine öffentlichen Abschlüsse“. Registerliste je Land liefert company_get schon im Feld `land` (landText). | bleibt gekürzt (~80); Registerliste → main/firmen-status.ts (`landText`) bzw. (a) Karte `firmen/laender` |

## 2. Summen und Grundsockel

Ist-Tokens nach Hauptklasse (statisch, ~16.335):

| Klasse | prompts.ts [21]–Ende | soul.ts [1]–[20] | Summe | davon bleibt nach Umsetzung |
|---|---|---|---|---|
| regel | 330 | 930 | ~1.260 | ~1.150 |
| kuerzen | 6.520 | 740 | ~7.260 | ~2.630 |
| wissen | 6.340 | 0 | ~6.340 | ~410 (Auslöse-Zeilen) |
| doppelt | 1.050 | 390 | ~1.440 | 0 |
| **gesamt** | **~14.240** | **~2.080** | **~16.320** | **~4.200** |

- Statischer Grundsockel danach **~4.200 Tokens (−74 %)**, mit Puffer für eine saubere Such-Regel und Übergänge
  realistisch 4.500.
- Je Turn kommen dynamisch typisch +300 bis +1.500 dazu (Profil, ICP, Gedächtnis, Werkzeugnamen; Nudge ~430 nur beim
  ersten Lauf; Auto-Triage ~900). Systemprompt typisch also 5.000–6.000 statt 16.500–18.000.
- Gegenrechnung: Was in Werkzeugbeschreibungen wandert, kostet nur nach `tool_load`. Der Eingabe-Grundsockel je Modellaufruf
  sinkt so von heute mind. ~22.600 (L0) auf grob ~11.000–12.000; der Kern-Schema-Anteil (~6.000 inkl. kürzestem Verlauf)
  wird dann zum größten Brocken und ist der nächste Hebel (z. B. Beschreibungen der 13 Kern-Werkzeuge straffen;
  `tool_search` hat ~960 Zeichen, `company_get` ~2.100).

Größte Hebel (Ist → Rest): Tool-Discovery [25] 1.664 → 250 · Import/DryRun/Retry/Tabellen/Fortschritt [45]–[50]
2.345 → ~130 · Buying Center [60]–[64] 933 → 20 · Bestandsfragen [43] 728 → 200 · Freshness-Sammelabschnitt [39] 698 → 60 ·
HubSpot-Sammelabschnitt [35] 631 → 60 · Diagramme 881 → 350 · Link-/Watch-/Meldungen [38],[40],[41] 1.076 → 30 ·
Producer-Tabelle Seele [19]/[20] 359 → 0.

## 3. Regeln: immer vs. mit der Funktion laden

**Wirken nur, wenn sie IMMER im Prompt stehen** (kein Werkzeug als Auslöser, oder sie greifen vor dem ersten Aufruf):

1. Rolle, Ton, Du-Form, Du/Sie bei Dritten, Sprache, keine Emojis/Geviertstriche ([2], [21], [22]).
2. Wie ich spreche: nie über Werkzeuge reden, Wege anbieten, nächsten Schritt mitdenken, Ehrlichkeit ([6]/[7]).
3. Heilige Regel: keine Firmenaussage ohne Datenaufruf; Halluzinationsverbot ([3]–[5], [8]/[9]).
4. Prämissen-Prüfung bei Nutzerbehauptungen über App-Zustand ([23] Rest).
5. Verarbeitung unsichtbar inkl. ruhender Firmen: fehlt → importieren, unvollständig → retry, nie „liegt nicht vor“ ([10]–[12] + [39]-Rest).
6. Suchkette company_search → register_live_suche → firma_finden (beide Folgewerkzeuge sind nicht im Kern) ([13]).
7. Disambiguierung als einzige legitime Rückfrage ([14]).
8. Bestandsfragen → `bestand_suchen` + Antworttabelle ([16], [43]-Rest).
9. Such-Regel: bei Wie/Kann/Einrichten und vor „geht nicht“ zuerst `tool_search`; laden ohne Rückfrage; nichts gefunden → Alternative ([25]-Kern).
10. Handeln statt Nachfragen, Schreibaktionen versuchen ([32]-Rest).
11. Schleifenabbruch / Sammelaufrufe ([27]).
12. „Angestoßen ist nicht erledigt“ für alle Hintergrundläufe ([46]/[50]-Rest; steht für Triage schon in Punkt 3c).
13. Ausgabeformate: Firmen-Verlinkung ([24]), Firmenstatus-Zeile, Land-Kurzregel, Vertriebsblick ([31]), Mail-Entwurf-Block ([30]), Diagramm-Block ([51]–[59]), strukturierte Übersicht statt JSON ([35]-Rest).
14. Test oder Ernstfall ([29]) und „reine Textaufgaben ohne Werkzeug“.
15. Self-Service-Kern: nie „kann ich nicht ändern“; Schlüssel/Tokens nie wiedergeben, Zugangsdaten nie im Chat erfragen ([36]/[26]-Rest).
16. Auslöse-Zeilen für Funktionen außerhalb des Kerns (je 1 Zeile): früheres Gespräch → Gedächtnis; kommentarloser Link → Überwachung anbieten; Idealkunden beschrieben → ICP speichern; „sag Bescheid, wenn fertig“ → beobachten; wer passt zu Angebot/ICP → icp_bestand_abgleich.

**Nur bei bestimmten Funktionen gebraucht** (Kandidaten für „mit der Funktion laden“ = Beschreibung oder Werkzeugergebnis):

- Notion-Playbook ([33]) → notion.ts (liegt dort schon).
- HubSpot-Sync und HubSpot-Link-Format ([35]) → crm.ts (`crm_sync_hubspot_company_from_ava`, `crm_status`); CRM-Lese-Bündel ([25]) → meta.ts.
- Workflow-Regeln ([25]) → workflows.ts.
- Meldungen verwalten, Ruhezeiten-Umrechnung ([38]) → alerts.ts.
- Freshness, Priorisieren ([39]) → freshness.ts; Plan/Kontingent, aktiv/ruhend → abrechnung.ts, imports.ts; Problem melden → problem.ts.
- Watches ([40]), Link-Überwachung inkl. „Sonstiges“-Fall ([41]) → watches.ts, link-monitor.ts.
- ICP/Radar ([44]) → icp.ts, discovery.ts.
- Import-Abläufe, Tabellen-Spalten, DryRun/resolveToken, Report-Link, Retry-Ablauf, Stufennamen, Berichtsformat ([45]–[50]) → imports.ts, transactions.ts, dateien.ts (+ `import_excel` bei Anhang automatisch laden, orchestrator.ts).
- Antwort auf „[Hintergrundaufgabe …]“ ([47]) → in die Meldung selbst (aufgaben/aufgaben.ts).
- Buying Center: Dimensionen, Karten-Block, sachliche Gründe, Freigeben ([60]–[64]) → buying-center.ts (Block-Anweisung ins Ergebnis).
- Selbstkorrektur ([28]) → self-correction.ts (Kern-Werkzeug).
- Verbundene Dienste: Namensschema, Ereignisse, abgelaufener Zugang ([26]) → meta.ts/mcp-client, dienste.ts.
- Bestandssuche im Pool ([43]) → Ergebnis von `bestand_suchen` bei `bereich: pool`.
- Datenqualitäts-Notiz, CRM-Kontext-Format ([35]) → companies.ts (`company_data_quality`, `company_crm_summary`).
- Gemeinsame Kunden im Vertriebsblick ([31]) → companies.ts (`company_get` Bereich kunden / `company_kunden`).
- Länder-Registerliste → firmen-status.ts (`landText`).

## 4. Widersprüche und veraltete Stellen (Code gewinnt)

1. **[25] „Permanent verfügbar sind nur 6 Tools … Alle anderen Tools (Firmen, …) musst du AKTIV laden“**: Der Kern hat 13 Werkzeuge
   (tools/meta.ts:262–303: zusätzlich `app_oeffnen`, `report_self_correction`, `company_search`, `company_get`, `company_contacts`,
   `crm_search_hubspot_companies`, `bestand_suchen`). Der Abschnitt widerspricht sich selbst (zwei Zeilen später: „company_search und
   company_get sind immer da“).
2. **Seele [19]/[20] „Diese Tools sind IMMER verfügbar“** samt Producer-Tabelle: `company_profile`, `company_publications`,
   `company_keywords`, `company_website`, `company_linkedin_signals`, `company_crm_summary`, `crm_list_links_for_company` sind NICHT
   im Kern (meta.ts:290, W1 2026-09-30: profile/publications bewusst entfernt, über `company_get` `bereiche`). Seele [4] Schritt 2
   schickt CRM-Fragen an `crm_list_links_for_company` (nicht im Kern), obwohl `company_get` den Bereich `crm` hat.
3. **[36] `settings_set_anthropic_subscription_token`** existiert nicht (in keinem Werkzeug). `settings_set_api_key` schließt Anthropic
   ausdrücklich aus; Anmeldung nur über das Abo in den Einstellungen (tools/settings.ts:47–56, 184). Der ganze Anthropic-Absatz
   (inkl. `claude setup-token`, `sk-ant-oat01-…`) ist veraltet.
4. **[46] „Aus CRM (heute nur HubSpot)“** vs. [25] (Close über `import_companies_from_crm` provider close) und Schema-Enum
   `hubspot|close|salesforce|dynamics` (tools/imports.ts:525). Auch die Werkzeugbeschreibung selbst sagt noch „Today only HubSpot“
   (imports.ts:514) → beide angleichen.
5. **Emojis**: [21] „Keine Emojis“ vs. Firmenstatus „mit ⚠️“ und [49] `[📄 Report öffnen](avafile:…)`. Ebenso „keine Geviertstriche“,
   während der Prompt sie dutzendfach selbst benutzt, auch in Mustersätzen, die das Modell übernimmt (Triage 3c: „Import gestartet,
   läuft im Hintergrund — Status …“).
6. **Bewertung (company-evaluation, abgeklemmt seit v0.1.829)**, Reste: [46] „der Importer fächert Profil/Website/Kontakte/
   **Bewertungen** automatisch auf“ (mehrdeutig, besser streichen); [40] Watch-Thema `evaluation-flag` (watches.ts:33/106; diese
   Kandidatenart entsteht nur noch als Watch-Treffer selbst und in Demo-Daten, heartbeat.ts:739); [42] Satz „Es gibt kein
   Bewertungs-/Best-Match-Werkzeug mehr“ (unnötig); außerhalb des Prompts: `retry_stage`-Beschreibung „evaluation LLM errored“
   (imports.ts:1306), `alerts_purge` „frische Bewertung“.
7. **Werte von `verarbeitung.stand`**: Seele [11] schreibt 'unvollständig'/'läuft', das Werkzeug liefert `unvollstaendig`/`laeuft`
   (companies.ts:1105); [35] schreibt es richtig.
8. **Falsche Überschriften**: [35] „HubSpot übernehmen“ enthält allgemeine Auskunftsregeln; [39] „Freshness“ enthält Plan/Kontingent,
   aktiv/ruhend und Problem melden; [46] „Import starten“ beginnt mit der company_get-Regel und Dateiregeln. Das Modell findet die
   Regeln dort nicht, wo es sie erwartet.
9. **Bündel-Angaben**: „Alerts → 6 Tools“ nennt 7, „Obsidian → 5 Tools“ nennt 6. `KNOWN_BUNDLES` (meta.ts) hat kein Workflows- und
   kein CRM-Lese-Bündel; der Prompt ist dafür heute die einzige Quelle.
10. **Plan/Kontingent [39]** beschreibt Free/Pro/Max/Ultra und 0,50/1,00/1,50 € fest, obwohl das Sitz-Kontingent am Pricing-Schalter
    hängt (abrechnung.ts:19 „null, solange der Schalter aus ist“). Ist der Schalter aus, erklärt AVA Pläne, die es nicht gibt.
    Gehört in das Ergebnis von `abrechnung_status`.
11. **Zugangsdaten im Chat**: [26]/[25] „Nie Zugangsdaten im Chat erfragen“ und Plan §2 Nr. 5 vs. [36] Self-Service „API-Keys setzen“
    über `settings_set_api_key` (Schlüssel kommt im Klartext durch den Chat, settings.ts:28–31). Entscheidung nötig (L6 löst es).
12. **[26] „Meldet ein Werkzeug ‚Zugang abgelaufen oder ungültig‘“**: Diese Meldung gibt es im Code nicht; der MCP-Client meldet
    „Der Dienst lehnt den Zugang ab (401). Zugangscode oder Kopfzeilen prüfen.“ (mcp-client/client.ts:130). Die Regel greift nie wörtlich.
13. **Klickpfade statt `app_oeffnen`**: [26] (2×), [30], [36] diktieren „Einstellungen → Verbindungen → …“, [38]/[40]/[41]/[44] nennen
    `/alerts`, `/radar`. Seit L1 gibt es `app_oeffnen` mit genau diesen Zielen (app-oeffnen.ts:15–38); die Seele sagt das auch.
14. **Länder**: [21] „deutsche B2B-Firmen“, Seele [2] „deutsche Mittelständler“ vs. Land-Block (DE, AT, CH, UK, NO, FI).
15. **Doppelungen innerhalb des Prompts**: Fakten-Disziplin ([23] ↔ [8]/[9]), Suchkette ([32] ↔ [13]), Disambiguierung ([32] ↔ [14]),
    Fan-out ([34] ↔ [4] ↔ [46] Punkt 1), Verarbeitung ([35] ↔ [11]), Bestandsfragen ([43] ↔ [16]), Rolle ([21] ↔ [2]),
    statusWarnung ([31] ↔ Firmenstatus).
16. **Datumsstempel in Überschriften** („(2026-10-10)“, „(2026-10-04)“, „(2026-10-06)“): Rauschen ohne Nutzen fürs Modell.
17. Kommentar in soul.ts („bleibt bewusst kurz (~600 Tokens)“) stimmt nicht: die Seele hat ~2.080 Tokens.
18. Nebenbefund außerhalb des Prompts: Der Plan nennt als Kartenablage `services/desktop/resources/wissen/<ast>/`, gebaut ist
    `src/main/wissen/karten/<ast>/` (4 Karten: firmen/firmen-importieren, verbindungen/dienst-verbinden, verbindungen/crm-verbinden,
    chat/arbeitsschritte-anzeigen). Zulässige Äste laut karten/README.md: verbindungen, firmen, recherche, meldungen, workflows,
    abrechnung, konto, ki, datenschutz, erste-schritte, chat. Ein Kartentyp für reines Modellwissen fehlt im Format.

## 5. soul.ts (Abschnitte [1]–[20], stehen im Prompt ganz vorn)

| Abschnitt (Überschrift/Anfang) | ~Tokens | Inhalt in 1 Satz | Klasse | Begründung | Ziel |
|---|---|---|---|---|---|
| [1] # AVAs Seele | 3 | Überschrift. | regel | Anker. | bleibt |
| [2] Ich bin AVA, B2B-Vertriebs-Assistenz … | 57 | Rolle: verbindliche Recherche, nie geraten. | regel | Identität; mit persona [21] zu einer Rollenzeile zusammenlegen, Länder richtigstellen. | bleibt (~45) |
| [3]+[4] Heilige Regel: keine Aussage über eine Firma ohne Daten-Call | 296 | Bei Firmennennung immer erst company_search, dann company_get mit passenden Bereichen (Zuordnungsliste), dann antworten. | kuerzen | Die wichtigste Regel, bleibt. Die Bereichs-Zuordnungsliste steht in der `company_get`-Beschreibung (Bereichsliste); der CRM-Punkt verweist auf ein Nicht-Kern-Werkzeug (§4 Nr. 2). Vorschlag: „1. company_search, 2. ein company_get mit den Bereichen, die die Frage nahelegt (mehrere parallel ist billig), 3. erst dann antworten.“ | bleibt gekürzt (~150) |
| [5] Diese Regel gilt für JEDE Conversation … | 81 | Keine Ausnahme, Datenbank ist aktueller als Training. | kuerzen | Ein Satz reicht. | bleibt gekürzt (~30) |
| [6]+[7] Wie ich spreche: Nutzersprache statt Technik | 327 | Nie über Werkzeuge reden, Ersatzweg + `app_oeffnen`, 2–3 Wege anbieten, nächsten Schritt mitdenken, Ehrlichkeit vor Glätte. | regel | Kern von L1, wirkt nur immer. | bleibt |
| [8]+[9] Halluzinieren ist die schlimmste Sünde | 125 | Fakten ohne Tool-Call = Halluzination, mit Folgen für den Nutzer. | regel | Immer; ersetzt den ersten Teil von [23] und Chart-Regel 1. | bleibt (~110) |
| [10]+[11] Verarbeitung ist unsichtbar | 310 | verarbeitung fehlt → sofort import_companies, unvollständig → retry_stage, läuft → beobachten; „keine Informationen“ nur nach erfolgreicher Stufe. | kuerzen | Muss immer stehen (Befund „Verarbeitung unsichtbar“). Doppelt mit [35] und den Beschreibungen von company_get/import_companies/retry_stage; Werte-Schreibweise falsch (§4 Nr. 7). Vorschlag: 4 Sätze, Werte wie im Werkzeug, ruhende Firmen aus [39] mit aufnehmen („ruhend/außerhalb der Liste → aktivieren oder aufnehmen anbieten, nie ‚liegt nichts vor‘“). | bleibt gekürzt (~180) |
| [12] NIEMALS: ‚Zu den Jahresabschlüssen liegt mir nichts vor.‘ … | 55 | Zwei verbotene Beispielsätze. | kuerzen | Beispiele helfen, einer reicht. | bleibt gekürzt (~25) |
| [13] Findet `company_search` NICHTS Passendes … | 129 | Kette Register-Live-Suche → firma_finden → erst dann „keine eigene Website“. | regel | Folgewerkzeuge sind nicht im Kern, Auslöser muss also im Prompt stehen. Doppelt mit [32] Punkt 4 (dort streichen). | bleibt (~110) |
| [14] Die einzige legitime Rückfrage ist die Firmen-Disambiguierung | 68 | Mehrere plausible Treffer → nachfragen, ein Treffer → weiter. | regel | Immer. Details aus [32] in `company_search`/`ask_user_choice`. | bleibt (~60) |
| [15] NIEMALS: ‚<Firma> ist ein <Branche> …‘ | 33 | Beispiel für Antwort ohne company_get. | doppelt | Deckt [9] ab. | streichen |
| [16] Fragen über den Bestand sind Datenfragen | 148 | Bestandsfragen meinen immer Meine Firmen → sofort bestand_suchen, Antwort als Tabelle Firma/Beleg/Quelle. | regel | Auslöser + Antwortformat des Kern-Werkzeugs; hierhin den Format-Rest aus [43] ziehen, [43] fast ganz streichen. | bleibt (~120, mit Format aus [43] ~200 gesamt) |
| [17]+[18] Wenn die Frage NICHT firmenspezifisch ist | 75 | Allgemeinfragen frei beantworten. | regel | Gegenstück zur heiligen Regel, nötig. | bleibt (~60) |
| [19] ## Welche Producer mir was geben (Tabelle) | 324 | Tabelle Werkzeug → Inhalt für 12 company_*/crm_*-Werkzeuge. | doppelt | Jede Zeile steht in der jeweiligen Werkzeugbeschreibung bzw. in der Bereichsliste von company_get; zudem veraltet (§4 Nr. 2). | streichen; nichts nachzutragen |
| [20] Diese Tools sind IMMER verfügbar … | 35 | Behauptung, die Tabelle sei always-on. | doppelt | Falsch (§4 Nr. 2). | streichen |

Seele gesamt ~2.080 → ~1.220 Tokens. Die Seele trägt danach alle „immer“-Regeln zu Firmen; persona behält Ton, Format,
Such-Regel und die Auslöse-Zeilen.
