# Offene Fragen und Befunde je Ast (Wortlaut der Erfassung)

Stand 2026-11-07. Kuratierte Fassung: INVENTAR.md §6 bis §8. Karten-ids auf den Stand nach dem Zusammenführen gebracht. Erledigt seit der Erfassung: PRICING_TIERS ist an (gelesen), Problem melden ist live, app_oeffnen-Ziele firmenliste/firmensuche sind korrigiert, die Prüfregel erlaubt die Adresse mcp.ava.bi.

## Offene Fragen an Joyce (Äste erste-schritte, konto, abrechnung, datenschutz)

### Fragen

**F1. Ist `PRICING_TIERS=1` in Produktion gesetzt?**
Kontext: Ohne den Schalter sieht der Nutzer das alte Modell (Free / Pro 49 € je Nutzer plus Stufenpreis je Firma, Ausgabenlimit, Stripe-Kasse, „Abonnement verwalten“). Mit dem Schalter das Sitz-Modell (Free/Pro/Max/Ultra, Monatskontingent in Euro, Ultra über das Kontingent hinaus, LinkedIn nach Verbrauch, Aktiv/Ruhend). Im Repo nicht ablesbar; Notiz vom 2026-11-02 sagt „noch AUS“.
Gefunden: G/lib/kontingent.ts:18, G/routes/v1/sitze.ts:39 (404 ohne Schalter), R/routes/Settings.tsx:4843.
Zu entscheiden: Sollen die Karten bis zur Umstellung zustandsneutral bleiben (so geschrieben: „je nach Ansicht“, „steht dort das Feld …“), oder nach der Umstellung nur noch das Sitz-Modell beschreiben? Die Karten ausgabenlimit, firma-ruhen-aktivieren und linkedin-kosten-limit sind an sichtbare Merkmale gekoppelt und müssten nach der Umstellung angepasst bzw. ausgabenlimit gestrichen werden.

**F2. Dürfen Preise in die Karten?**
Kontext: Stufenpreise 0,50 / 1,00 / 1,50 € stehen hart in beiden Oberflächen (PLAN_CARDS, PaygKarte, Konsole sitze.tsx/kosten.tsx) und im Chat-Werkzeug, sind im Gateway aber per Env änderbar (G/lib/stufen.ts). Planpreise Pro 49 / Max 149 / Ultra 299 € sind ebenfalls Env-Standardwerte (G/lib/billing-plans.ts:57-60), und Pro bedeutet in beiden Modellen etwas anderes (alt: 49 € plus jede Firma; neu: 49 € inklusive 49 € Kontingent).
Zu entscheiden: Ich habe keine Preise in die Karten geschrieben, AVA nennt sie aus dem Abrechnungsstand. Falls Preise in die Karten sollen: welche, und wer pflegt die Karte bei Preisänderung (Karte braucht ein Release)?

**F3. Zählt eine Firma im Sitz-Modell einmal je Organisation oder je Nutzer?**
Kontext: Altes Modell sagt ausdrücklich „einmal je Organisation“ (PLAN_CARDS, Werkzeugtext). Im Sitz-Modell ist das Kontingent je Nutzer; ob zwei Mitglieder mit derselben Firma doppelt verbrauchen, habe ich nicht belegen können. Karte firmen-kosten-stufen lässt das offen.

**F4. Stimmt die Zählregel „ruhend zählt bis Monatsende“?**
Kontext: Werkzeug und Dialog sagen „zählt bis Monatsende weiter“, der Tooltip der Ruhend-Marke in Meine Firmen sagt „sie zählt nicht in deinem Kontingent“ (R/routes/AllCompanies.tsx:520). Karte folgt dem Werkzeug. Siehe Befund B8.

**F5. Welcher KI-Anbieter steckt hinter dem Betreiber-Modell, und soll die Karte ihn nennen?**
Kontext: Die Firmenverarbeitung (website, company-profile, company-contact, company-email, company-publication, structured-content) läuft, sofern verfügbar, über die Betreiber-Spur (Standard gpt-6-luna, also OpenAI) und damit über das Gateway, auch wenn der Nutzer lokal oder mit eigenem Schlüssel arbeitet (services/desktop/src/core/bootstrap.ts:555, M/producer-supervisor.ts:744-790). Dabei gehen öffentliche Firmentexte inklusive Impressums-Namen an den Anbieter. Karte ki-anbieter-daten sagt das ohne Anbieternamen („ein Modell, das AVA selbst bereitstellt“).
Zu entscheiden: Anbieter nennen? Gibt es einen AV-Vertrag, auf den die Karte verweisen soll? Gilt das auch für Enterprise-Organisationen mit Anbieter-Sperre?

**F6. „Beschäftigungen verfallen nach 120 Tagen“ – wo ist das umgesetzt?**
Kontext: Die Konsole (K/vorgaben/page.tsx:196) und der Compliance-Prompt behaupten es. Im Gateway habe ich nur die Personen-Tilgung nach 180 Tagen gefunden (G/lib/person-retention-reaper.ts), keinen 120-Tage-Lauf für Beschäftigungen. Karte personen-aufbewahrung nennt die 120 Tage deshalb nicht.

**F7. Passwort vergessen / Passwort ändern**
Kontext: Die App hat keinen eigenen Weg; die Anmeldung läuft im Browser. Ob die Anmeldeseite „Passwort vergessen“ anbietet und ob es eine Seite zum Ändern des Passworts gibt, ist im Repo nicht belegbar. Keine Karte geschrieben. Bitte bestätigen, dann ergänze ich eine Karte „passwort-zuruecksetzen“.

**F8. Konto auf dem Server löschen, Datenexport**
Kontext: Es gibt nur den lokalen Werksreset und „Konto vom Gerät entfernen“. Kein Weg, das AVA-Konto samt Serverdaten (Bestand, Buying Center, Relevanz, Notizen, Abrechnung) zu löschen, und kein Gesamtexport (nur Verlauf als JSON). Karten konto-loeschen und eigene-daten-loeschen verweisen ans AVA-Team (Problem melden / info@eprox-gmbh.de).
Zu entscheiden: Ist das der gewünschte Prozess (Art. 15/17/20 für eigene Nutzerdaten)? Welche Adresse soll genannt werden?

**F9. Organisation wechseln**
Kontext: Kann ein Nutzer, der schon in einer Organisation ist, per Einladungslink direkt in eine andere wechseln, oder muss er erst austreten? TenantMembership spricht für Mehrfachmitgliedschaft, die Oberfläche zeigt aber nur eine Organisation. Karte organisation-verlassen sagt dazu nichts.

**F10. Überspringen des Organisationsschritts**
Kontext: Während „Organisation wird geprüft…“ lädt, gibt es einen Link „Überspringen“ (R/routes/FirstRunWizard.tsx:1262-1268), danach nicht mehr. So kommt man ohne Organisation durch, obwohl sie Pflicht ist. Gewollt? Die Karte organisation-anlegen erwähnt den Fall vorsichtig („Hast du den Schritt übersprungen …“).

### Fehlende app_oeffnen-Ziele

- fehlendes Ziel: `langzeitgedaechtnis` → /settings/konto#general-memory (Karten chat-gedaechtnis, eigene-daten-loeschen)
- fehlendes Ziel: `organisation` → /settings/konto#organisation (Karte organisation-konsole)
- fehlendes Ziel: `instanzen` → /settings/konto#instanzen (Karte ava-umzug)
- fehlendes Ziel: `verbundene_apps` → /settings/konto#verbindungen (Karte verbundene-apps)
- fehlendes Ziel: `verlauf` → /settings/erweitert#audit-trail (Karte verlauf-ansehen)
- fehlendes Ziel: `zuruecksetzen` → /settings/erweitert#danger-zone (Karte konto-loeschen)
- fehlendes Ziel: `status` → /whoami (Karte app-rundgang)
- Hinweis: Das Prüfskript kennt inzwischen `firmenliste`, `firmensuche`, `importieren`, `vorgang`, `stammdaten_mitpflegen`, die app-oeffnen.ts im Repo noch nicht hat. Ich habe `firmenliste` für „Meine Firmen“ verwendet (Karten app-rundgang, firma-ruhen-aktivieren) und gehe davon aus, dass firmenliste künftig auf /alle-firmen zeigt. Siehe Befund B2.
- Hinweis: Das Prüfskript verbietet „mcp“ auch in der Adresse mcp.ava.bi, obwohl die Vorgabe die Adresse erlaubt. In verbundene-apps deshalb Verweis auf „Meine AVA“ in der Konsole statt der Adresse.

### Überschneidungen mit anderen Ästen

- Ü1 verbindungen: Konsole „Agenten-Zugang“ (Copilot Studio, A2A) und das Verbinden von Claude/ChatGPT über mcp.ava.bi. Meine Karte verbundene-apps behandelt nur Ansehen/Trennen in Einstellungen → Konto.
- Ü2 firmen: Neuverarbeitung erzwingen zählt im Sitz-Modell wie eine weitere Aufnahme (G/lib/rollen.ts). Gehört in eine Firmen-Karte, mit Abrechnungsbezug.
- Ü3 kontakte: Herkunftsnachweis, Art.-14-Hinweis und Person löschen habe ich unter datenschutz geschrieben; der Ast kontakte sollte nur darauf verweisen.
- Ü4 linkedin: Kosten der LinkedIn-Beobachtung (linkedin-kosten-limit) liegen bei mir; Einverständnis, Bildanalyse, Zweitkonto beim Ast linkedin.
- Ü5 ki: Einrichtungsassistent Schritt 2 und ki-anbieter-daten berühren die Anbieterwahl; die Einrichtung des Anbieters selbst gehört zu ki.
- Ü6 hilfe: Problem melden als Vorgang (Dialog, Antworten, „Meine Problemmeldungen“) gehört zu hilfe; ich habe nur den Datenumfang (problem-melden-daten).
- Ü7 app: AVA-App app.ava.bi nur als Verweis in ava-installieren.
- Ü8 firmen: Karte firma-ruhen-aktivieren ist abrechnungsnah, berührt aber Meine Firmen.

### Befunde (Fehler und Unstimmigkeiten in der App)

- **B1 Doku veraltet (Datenschutz):** docs/WEBSITE_PROMPT_COMPLIANCE.md (Stand 2026-09-03) führt Herkunftsnachweis, Löschung mit Sperre, Art.-14-Vorlage und 180-Tage-Tilgung als „in Arbeit“; alles ist gebaut. Gleichzeitig sagt er, Rechenarbeit laufe vollständig auf den Nutzer-Rechnern und eigener Schlüssel „bleibt komplett lokal“; die Firmenverarbeitung läuft aber über die Betreiber-Spur (F5). Auch README.md:7 („KI läuft beim Nutzer“) ist dadurch zu weitgehend. Server-seitig gespeichert werden außerdem Buying Center, Relevanz-Signale und Firmennotizen, die die Liste „bleibt immer lokal / geht ans Substrat“ nicht nennt.
- **B2 Ziele vertauscht in app-oeffnen.ts:** `firmenliste` → /companies ist die Seite „Firmensuche“, beschrieben als „deine Firmenliste“; `alle_firmen` → /alle-firmen ist „Meine Firmen“, beschrieben als „die Suche über alle Firmen“ (M/agent/tools/app-oeffnen.ts:17-18 gegen R/components/AppShell.tsx:713-714 und die Seitentitel). AVA öffnet damit beim Wunsch „meine Firmenliste“ die falsche Seite und benennt sie falsch.
- **B3 Veralteter Klickpfad im Assistenten:** FirstRunWizard Schritt 2 sagt „Die Wahl lässt sich später unter Einstellungen → Modelle ändern.“ Den Tab „Modelle“ gibt es nicht mehr, richtig ist „KI & Kosten → Anbieter & Modell“ (R/routes/FirstRunWizard.tsx:368).
- **B4 Organisationspflicht umgehbar:** „Überspringen“ im Ladezustand des Organisationsschritts (siehe F10).
- **B5 window.confirm statt bestaetigen():** „Person löschen“ in der Kontaktkarte (R/routes/CompanyDetail.tsx:2216-2222) und „Konto entfernen“ im Konto-Menü (R/components/AppShell.tsx:1092-1097) nutzen den Browser-Dialog, obwohl app-weit bestaetigen() Vorgabe ist; ein Fehlschlag beim Entfernen nutzt window.alert.
- **B6 Jargon in Nutzertexten:** Profil-Abschnitt „Wird in jeden Agenten-Turn als Lese-Kontext eingewoben. Der Agent passt …“ (R/routes/Settings.tsx um 3236); leeres Gedächtnis „Der Agent legt Einträge an …“ (um 4573); Verbundene Apps „Deine Organisation hat den MCP-Zugang nicht freigeschaltet … erhalten dann keine Werkzeuge“ und Pille „MCP“ (R/routes/settings/VerbindungenSection.tsx:46-49,72); Hinweise für den Support „Top-Tools mit Workaround“ mit Werkzeugnamen in Code-Schrift (R/routes/settings/VerlaufTab.tsx um 615); Assistent „EmbeddingGemma … Embedding-Raum … Indizes“ (R/routes/FirstRunWizard.tsx:372-376); Verlauf-Kategorie „Producer“.
- **B7 „Tenant“ im Konto-Menü:** Das Menü zeigt „Tenant: …“ bzw. „persönlicher Tenant“ (R/components/AppShell.tsx:1066-1072,1127-1129); die Oberfläche nennt das sonst „Organisation“ bzw. „persönlicher Bereich“.
- **B8 Widerspruch ruhende Firma:** Tooltip „sie zählt nicht in deinem Kontingent“ (R/routes/AllCompanies.tsx:520) gegen „zählt bis Monatsende weiter“ (Werkzeug firma_ruhen_lassen, AktivierenDialog.tsx:80, Tooltip des Mond-Knopfs „zählt ab Folgemonat nicht mehr“).
- **B9 Kommentar veraltet:** M/agent/tools/organisation.ts:9-11 nennt Werkzeuge org_billing_activate_seats / _deactivate_seats / _set_tier, die es in der Datei nicht gibt.
- **B10 Konsole Mitglieder:** Der Hinweis „Als letzter Owner kannst du nicht austreten“ erscheint jedem Owner, auch wenn es weitere Owner gibt (K/mitglieder/page.tsx:243).
- **B11 Kommentar widerspricht Code:** AppShell-Kommentar „der Signale-Tab ist IMMER sichtbar“ (R/components/AppShell.tsx:686-689), der Code blendet ihn aus, wenn alle LinkedIn-Module aus sind (Zeile 733). Verhalten passt zur Regel „gesperrte UI ausblenden“, nur der Kommentar ist falsch.
- **B12 Startchip ohne Gruppe:** Der feste Chip „Best-Match über meine Firmen“ hat gruppe `best_match`, die es in FAEHIGKEITEN nicht gibt (Gruppe heißt `icp_abgleich`); er wird deshalb nie angezeigt (M/suggestions/erzeugung.ts:135).
- **B13 Erweitert-Untermenü unvollständig:** „Problem melden“ (ProblemSection) und „Hinweise für den Support“ werden im Tab Erweitert gerendert, stehen aber nicht in SETTINGS_TAB_SUB_ITEMS.erweitert (R/routes/Settings.tsx:233-242).

## Offene Fragen und Befunde, Ast `firmen`

### Fragen an Joyce

1. **Jahresabschlüsse für UK-Firmen**
   Kontext: Karte `firmen-uk` und `laender-uebersicht` sagen „keine Jahresabschlüsse für UK“.
   Gefunden: Der Abschluss-Schritt liest laut README nur Unternehmensregister/Bundesanzeiger; `publication_search` nennt nur Bundesanzeiger. Der Finanzen-Reiter wird für AT/CH/NO/FI hart ausgeblendet, für UK nicht (nur über „keine Daten“). Den Producer-Code (company-publication) konnte ich im Worktree nicht lesen.
   Zu entscheiden: Stimmt „UK ohne Abschlüsse“? Falls ja, UK in `istAt` (CompanyDetail.tsx) mit aufnehmen.

2. **Falsche Website zugeordnet: was darf der Nutzer?**
   Kontext: häufige Frage „falsche Website“.
   Gefunden: PLAN_WEBSITE_ZUORDNUNG W5 (Hinweis „trotzdem verwenden“, Website von Hand bestätigen) finde ich weder in der Oberfläche noch als Werkzeug. Die Karte `falsche-website` sagt deshalb: neu verarbeiten anstoßen, sonst „Problem melden“; Website von Hand festlegen geht nicht. Ob `retry_stage website` überhaupt neu sucht (Frische überspringt frische Stufen), ist offen.
   Zu entscheiden: Soll es eine Funktion „richtige Website setzen“ (Chat + Firmenseite) geben? Bis dahin: ist der Weg über „Problem melden“ richtig?

3. **Firma per Chat entfernen / aussetzen**
   Gefunden: Papierkorb und Pause je Firma gibt es nur in Meine Firmen; kein Agent-Werkzeug (Regel „jede Einstellung braucht ein Agent-Werkzeug“). Ruhen lassen geht im Chat.
   Zu entscheiden: Werkzeug `firma_entfernen` (mit Bestätigung) und `firma_aussetzen` bauen? Die Karte `firma-entfernen` sagt heute ehrlich „im Chat nicht“.

4. **Übernehmen eines geteilten Vorgangs und Kontingent**
   Gefunden: `transaction_adopt` kopiert Firmen in Meine Firmen. Ob das im Kontingent zählt (je Firma eine Aufnahme?), steht weder im Werkzeug noch in der UI. In der App gibt es keinen Bestätigungsdialog, im Chat schon.
   Zu entscheiden: Kostenwirkung festlegen und in Knopf-Titel, Werkzeug und Karte `vorgang-uebernehmen` nennen.

5. **Aktiv/Ruhend live?**
   Gefunden: Alle Aktiv/Ruhend-Elemente hängen an `aktivModell` (PRICING_TIERS); laut Notiz noch aus. Karten formulieren deshalb „falls dein Plan mit aktiven und ruhenden Firmen arbeitet“.
   Zu entscheiden: Sobald der Schalter an ist, Karten `firma-entfernen`, `firma-einzeln-aufnehmen`, `firmen-filtern`, `reiter-fehlt-auf-firmenseite` ohne Vorbehalt formulieren.

6. **Excel-Import und Firmen außerhalb Deutschlands**
   Gefunden: `/v1/imports/excel` kennt kein Land (schemas.ts:440); eine Datei mit AT/CH-Firmen wird gegen das deutsche Register zugeordnet. Die Karte rät, solche Firmen als Liste mit Land zu nennen.
   Zu entscheiden: Länder-Spalte im Excel-Import unterstützen?

7. **Norwegen/Finnland: Bestand vollständig?**
   Gefunden: PLAN_SKANDINAVIEN N5 „Erstabzug: Trigger offen (Betreiber)“. Die Karte nennt keine Mengen.
   Zu entscheiden: Sind die Erstabzüge NO und FI gelaufen? Sonst Hinweis „noch im Aufbau“ in `firmen-norwegen-finnland`.

8. **Österreich: Geschäftsführung**
   Gefunden: Nur im Plan (PLAN_OESTERREICH §3): Personen nur im kostenpflichtigen Firmenbuchauszug, Weg 1 ohne Kauf. `company_get` sagt „keinen kostenlosen Vollauszug“.
   Zu entscheiden: Gilt das weiter (Karte `firmen-oesterreich`, `geschaeftsfuehrung`)?

9. **Stammdaten mitpflegen: welcher Ast?**
   Gefunden: Einstellungen → Recherche → Stammdaten mitpflegen (Opt-in, Org-Modul `stammdaten.mithelfen`). In keinem der verteilten Äste ausdrücklich genannt. Keine Karte geschrieben.
   Zu entscheiden: Karte im Ast firmen oder recherche?

10. **Fehlende app_oeffnen-Ziele**
    - fehlendes Ziel: `importieren` (/ingest, Seite „Excel hochladen“)
    - fehlendes Ziel: `firmensuche` als sprechender Name (heute nur über das falsch beschriftete `firmenliste`, siehe Befund 1)
    - fehlendes Ziel: `stammdaten_mitpflegen` (/settings/recherche#mithelfen-section)
    - fehlendes Ziel: `vorgang` mit transactionId (/transactions/:id), analog zu `firma`

### Befunde

1. **app_oeffnen: Ziele `firmenliste` und `alle_firmen` vertauscht beschriftet.** `firmenliste` führt auf /companies, das ist die **Firmensuche** (Companies.tsx, Menü „Firmensuche“), der Text sagt aber „deine Firmenliste“. `alle_firmen` führt auf /alle-firmen, das ist **Meine Firmen** (AllCompanies.tsx, Menü „Meine Firmen“), Text „die Suche über alle Firmen“. AVA sagt dem Nutzer also das Falsche. Die Karten nutzen die Ziele nach dem tatsächlichen Pfad (firmenliste = Firmensuche öffnen, alle_firmen = Meine Firmen öffnen). Vorschlag: Ziele umbenennen (`firmensuche` → /companies, `meine_firmen` → /alle-firmen) oder Texte tauschen; danach Karten anpassen. Auch die Auftragsbeschreibung des Asts hatte die Zuordnung vertauscht.
2. **UK-Insolvenzprüfung in der Oberfläche läuft ins deutsche Insolvenzportal.** InsolvenzAbschnitt.tsx: Für UK-Firmen schickt „Jetzt prüfen“ an `/v1/register-jobs/insolvenz` und beschriftet die Quelle „Insolvenzportal“/„Insolvenzbekanntmachungen der Justiz“. Das Chat-Werkzeug nutzt richtig `/v1/register-jobs/uk`.
3. **Chat-Suche ohne Länderfilter.** `company_search` hat keinen `country`-Parameter, obwohl Gateway, UI und MCP (`firma_suchen` mit `land`) ihn kennen. Außerdem nennt die Beschreibung bei `country` nur „DE | AT | CH | UK“.
4. **import_excel: Stadt-Spalte optional im Werkzeug, Pflicht im Gateway.** `cityColumns` ist optional, `ImportExcelQuery.city` ist Pflicht; ohne Stadt scheitert der Aufruf.
5. **Entfernen in Meine Firmen nutzt `window.confirm`** statt `bestaetigen()` (AllCompanies.tsx hideCompany), anders als Ruhen lassen.
6. **Fachjargon in der Oberfläche:** „Pipeline-Verlauf“ (AllCompanies, TransactionDetail), Eyebrow „Pipeline“ (Transactions.tsx), „über alle Transaktionen hinweg“ (Meine Firmen), Schrittnamen in „Erneut versuchen“ auf Englisch („Structured Content“, „Company Publication“, „Company Profile“, „Company Contact“), während die Matrix „Struktur, Publikation, Profil, Kontakt“ sagt. Tooltip „Zeitüberschreitung (abgebrochen — kein Datenfehler)“ und „Pausiert — fortsetzen“ mit Geviertstrich.
7. **Konzern-Töchter nur im Reiter Verflechtungen.** Das Panel „Laut Konzernabschluss“ hängt im Verflechtungen-Reiter, der nur mit Modul `verflechtungen` und deutschem Register erscheint. Schaltet eine Organisation Verflechtungen ab, sind die Töchter aus dem Konzernabschluss in der App unsichtbar, im Chat aber abrufbar.
8. **Systemprompt veraltet zu CRM-Import:** prompts.ts „Aus CRM (heute nur HubSpot)“, der Code übernimmt auch Close-Leads (crm/fetch-companies.ts:65). Die Fehlermeldung bei leerem Ergebnis spricht nur von HubSpot-City-Feldern.
9. **README veraltet:** Länderzeile ohne Norwegen/Finnland; „Fünf Producer“, die Matrix zeigt sechs Schritte inkl. E-Mail; Import „aus HubSpot“ ohne Close.
10. **PLAN_AUFFRISCHUNG veraltet:** Takte 7 Tage, Code 14 Tage (freshness-prefs-store.ts). PLAN_FIRMEN_UX B2 („Löschen löscht nichts“) ist überholt.
11. **app_oeffnen `aufgaben`:** Text „die laufenden Aufgaben“, die Seite heißt „Vorgänge“.
12. **Ingest-Seite nur .xlsx**, der Chat nimmt auch .xls/.csv/.tsv; die Seite sagt das nicht.

## Offene Fragen an Joyce (Äste kontakte, radar, recherche)

### Fragen

1. **Radar im kostenlosen Plan: welcher Plan schaltet frei?**
   Kontext: Karte radar-verdeckt.
   Gefunden: Radar-Seite sagt „Ab dem Plan Pro sichtbar“ / „im Plan Pro siehst du alle“ (R/routes/DiscoveryRadar.tsx:533, 598). Der Hinweis an das Modell sagt „Alle Namen und Begründungen gibt es im Starter-Plan (Einstellungen → Abo)“ (T/discovery.ts:52-57, auch Platzhalter „[Im Starter-Plan sichtbar]“ :243, :347). Automatik-Hinweis: „Mehr im Starter-/Pro-Plan (Einstellungen → Abo)“ (M/discovery/radar-supervisor.ts:36-37). WEBSITE_PROMPT_PRICING: kein „Starter“-Plan.
   Zu entscheiden: Karte sagt „ab dem Plan Pro“. Bitte bestätigen und die beiden Texte im Code auf Pro und „Einstellungen → Konto → Plan & Abrechnung“ ziehen (sonst nennt AVA im Chat einen Plan, den es nicht gibt).

2. **Person löschen: nur durch die erhebende Organisation?**
   Kontext: Karte person-loeschen.
   Gefunden: Werkzeugbeschreibung „Nur für Organisationen, die die Person erhoben haben“ (T/companies.ts:1376). Ob der Gateway das erzwingt, habe ich nicht geprüft.
   Zu entscheiden: Satz in der Karte behalten oder streichen.

3. **Fehlende app_oeffnen-Ziele** (für Aktionen der Karten):
   - fehlendes Ziel: `icp` → /icp-assistent (ICP-Seite; icp-festlegen, icp-aus-website, icp-aus-dokument, icp-anpassen).
   - fehlendes Ziel: `email_adressen` → /settings/recherche#email-muster-section.
   - fehlendes Ziel: `beobachtungen` → /settings/recherche#watches-section.
   - fehlendes Ziel: `link_ueberwachung` → /settings/recherche#link-monitor-section.
   - fehlendes Ziel: `mithelfen` → /settings/recherche#mithelfen-section.
   - fehlendes Ziel: `naehe_vorrang` → /settings/meldungen#relevanz-section (jetzt behelfsweise meldungen_einstellen).
   - fehlendes Ziel: `geteilte_buying_center` → /buying-center/geteilt.
   - fehlendes Ziel: `gerade_thema` → /thema.
   - fehlendes Ziel: `dienste_rechner` → /settings/erweitert#dienste-section (LinkedIn-Profil-Prüfung).
   - fehlendes Ziel: `verlauf` → /settings/erweitert#audit-trail (Screenshots der Link-Überwachung).

4. **Takt der Kontakt-Auffrischung und der Stellen-/Ausschreibungs-Suche**
   Gefunden: UI sagt nur „bei jeder Kontakt-Auffrischung“ (ProfilPruefungSection.tsx), Kommentar nennt 14 Tage; Stellen/Ausschreibungen „laufen immer“ (RechercheTab.tsx:1-4), aber kein nutzersichtbarer Takt. Karten beschreiben deshalb nur den manuellen Anstoß.
   Zu entscheiden: Darf AVA Takte nennen („alle 14 Tage“, „Stellen laufen automatisch mit“)? Dann bitte Quelle im Code nennen.

5. **Was heißt „Unklar“ bei Fokus-Themen?**
   Gefunden: Status gefunden/unklar/nicht_gefunden (CompanyDetail.tsx:987-991); Definition des Urteils nicht gefunden.
   Zu entscheiden: Ein Satz Erklärung für die Karte fokus-themen-ergebnisse.

6. **Link-Überwachung klickt Cookie-Banner mit „Alle akzeptieren“ weg**
   Gefunden: M/link-monitor/interstitial.ts:1-20, 210-230 (OneTrust/Cookiebot „Allow all“ u. a.). Nicht in Karten erwähnt.
   Zu entscheiden: Gewollt (Ziel: Seite überhaupt laden) oder lieber „nur notwendige“? Soll AVA das dem Nutzer sagen?

7. **E-Mail-Adressen-Abschnitt und Organisationsschalter „Kontakt-Recherche“**
   Gefunden: Fähigkeitsgruppe email_ableitung hat `feature: "kontakte"` (faehigkeiten.ts:20), der Abschnitt in RechercheTab.tsx wird aber ohne Feature-Prüfung gerendert, ANCHOR_FEATURE kennt email-muster-section nicht.
   Zu entscheiden: Abschnitt bei abgeschalteter Kontakt-Recherche ausblenden?

8. **Interaktionen im Buying Center nur HubSpot?**
   Gefunden: Meldungen „HubSpot ist nicht verbunden“ (BuyingCenterKarte.tsx:195, 627). Close CRM ist sonst angebunden.
   Zu entscheiden: Karte sagt neutral „aus dem CRM“. Reicht das, oder gilt es nur für HubSpot?

9. **Zuordnung im Auftrag weicht vom Code ab**
   - „6-Monats-Sperre bei verworfenen“: Im Code gilt die 6-Monats-Sperre für das Neuerstellen von Mini-Profilen (profiler.ts:10, 39; G/lib/discovery.ts:775). Verworfene sind dauerhaft und nutzerbezogen ausgeblendet; der Grund fließt in künftige Bewertungen. Karten folgen dem Code.
   - routes/Thema.tsx ist „Gerade Thema“ (Relevanz, Team-Übersicht), nicht Fokus-Themen. Karte gerade-thema liegt im Ast kontakte.

### Befunde (Fehler/Unstimmigkeiten in der App)

1. **app_oeffnen-Ziele vertauscht:** `firmenliste` öffnet /companies, das ist die Seite „Firmensuche“; `alle_firmen` („die Suche über alle Firmen“) öffnet /alle-firmen, das ist „Meine Firmen“ (T/app-oeffnen.ts:17-18 gegen AppShell.tsx:712-713, Companies.tsx:126, AllCompanies.tsx:356). Gleiches Muster in der Personenseite: Brotkrumen „Meine Firmen“ verlinkt /companies (PersonDetail.tsx:63).
2. **Starter-Plan / „Einstellungen → Abo“** in Chat-Hinweisen des Radars (siehe Frage 1); beides gibt es nicht mehr.
3. **ICP-Formular zeigt interne Fragecodes:** Feldbeschriftungen „K1 · Was bietest du an?“, „K3/K6 · Standort(e)…“, „K4 …“ bis „K9 …“ (IcpAssistant.tsx:542-584).
4. **Veralteter Klickpfad im Tooltip:** „Deine Fokus-Themen (Einstellungen → Datenquellen) …“ am Knopf „Fokus prüfen“ (R/components/RechercheLauf.tsx:85); richtig ist Einstellungen → Recherche.
5. **Beobachtungen-Formular:** Knopf „+ Neuen Watch anlegen“, Tooltip „Maximalanzahl Watches erreicht“ (Jargon, sonst heißt es „Beobachtung“); Fundstellen-Art „Evaluations-Flag“ obwohl die Bewertung abgeklemmt ist; Feld „Nur diese Firmen“ verlangt Firmen-Kennungen (Settings.tsx:4345-4356, 4410-4418, 4484-4494).
6. **Umlaute in nutzersichtbaren Texten fehlen:** Wärmeanzeige-Tooltip („behaelt“, „angesehen … laenger gelesen“, „geoeffnet“, „uebernommen“, „mehrfach zurueckgekommen“, aria-label „Naehe“; R/routes/waermeanzeige.tsx:18-40, 92-93); Radar-„Letzter Lauf“ zeigt „ICP unvollstaendig … ergaenzen“ (radar-supervisor.ts:201, 271); „Kopieren nicht moeglich.“ (CompanyDetail.tsx:2652).
7. **Abgelehnte/offene E-Mail-Adressen auf der Karte nicht unterscheidbar:** Laut Kommentar steht der Status „im Tooltip der Zuverlässigkeit“, der Tooltip zeigt aber nur „Zuverlässigkeit N %“ (CompanyDetail.tsx:384-388 gegen 2570-2580). Eine vom Server abgelehnte Adresse sieht damit aus wie eine gefundene (nur Prozentzahl).
8. **Buying-Center-Seitenleiste verlinkt Kontakt-Personen auf die Verflechtungen-Personenseite** (/personen/:id, BuyingCenterKarte.tsx:569). Die Seite lädt Personen aus Gesellschafterlisten/Register; ob Kontakt-IDs dort auflösen, ist unklar. Ohne Feature „verflechtungen“ zeigt sie „nicht freigeschaltet“. Bitte prüfen.
9. **Person löschen nutzt `window.confirm`** statt des app-eigenen Bestätigungsdialogs (CompanyDetail.tsx:2221-2228), anders als die übrigen Löschknöpfe.
10. **Kommentar in RelevanzSection.tsx** nennt noch „AutomatisierungenTab“ (Abschnitt sitzt im Tab Meldungen); nur Kommentar, kein Nutzerfehler.

## Offene Fragen und Befunde (Äste verbindungen, mail, telegram)

### Fragen an Joyce

### 1. Zugangsdaten im Chat: Telegram, Notion, Obsidian
- Kontext: Regel „Zugangsdaten nie im Chat“ (Prompt „Verbundene Dienste“, Karte dienst-verbinden, Notiz Self-Service „Keys ausgenommen“).
- Befund: `telegram_connect_start` sagt wörtlich „Gib mir den Token hier im Chat“, `telegram_connect_save_token`, `notion_connect_start` („Schreib mir den Token zurück“), `notion_connect_save_token` und `obsidian_connect_save_credentials` nehmen Geheimnisse aus dem Chat entgegen (m/agent/tools/telegram.ts:36-104, notion.ts:40-105, obsidian.ts:41).
- Meine Karten sagen durchgehend: in den Einstellungen eintragen, nicht in den Chat.
- Zu entscheiden: Diese Werkzeuge auf `zugang_anfordern` (sichere Eingabekarte) bzw. `app_oeffnen` umstellen oder aus dem Chat entfernen? Sonst widerspricht AVA sich selbst.

### 2. `zugang_anfordern`: welche `dienst`-Kennungen?
- Ich habe verwendet: `compleadly`, `close`, `notion`, `obsidian`, `telegram`. Für Close gibt es zwei Eingabestellen (CRM-Karte, Kopfzeile in „Weitere Dienste“); ich habe nur `close` genommen.
- Zu entscheiden: Liste der Kennungen und ob Close getrennt (`close-crm` / `close`) laufen soll. Obsidian braucht Schlüssel UND Base-URL.

### 3. Close zweimal verbinden
- Befund: Für Import/Verknüpfung den Schlüssel auf der CRM-Karte, für Kontakte/Aktivitäten/Aufgaben denselben Schlüssel noch einmal als Kopfzeile unter „Weitere Dienste“. PLAN_CLOSE_MCP C3 sagt „API-Schlüssel aus C1 wird wiederverwendet“, die Oberfläche tut das nicht.
- Zu entscheiden: Soll das Verbinden der CRM-Karte den Dienst gleich mit anlegen (oder umgekehrt)? Bis dahin erklärt Karte close-verbinden die zwei Schritte.

### 4. Wie meldet ein Nutzer Interesse an Salesforce/Dynamics?
- Oberfläche: „gib uns kurz Bescheid“, ohne Weg. Karte salesforce-dynamics sagt „gib dem AVA-Team kurz Bescheid“.
- Zu entscheiden: Über „Problem melden“, eine Mail-Adresse oder gar nicht? Und: Soll AVA Dynamics-Kunden auf den Copilot-Weg hinweisen (Copilot schreibt ins CRM)? Habe ich bewusst nicht behauptet.

### 5. Copilot und A2A: live nennen?
- Code ist gebaut (mcp.copilot, a2a.ts, Konsole „Agenten-Zugang“), Live-Test mit Copilot Studio laut PLAN_MCP_OEFFNUNG §14/§15 offen. Website-Do-not-claim verbietet A2A-Aussagen auf der Copilot-Seite.
- Meine Karten ava-in-copilot und ava-fuer-fremde-agenten beschreiben es als vorhanden und „falls freigeschaltet“.
- Zu entscheiden: So lassen, abschwächen („in Erprobung“) oder Karten zurückhalten?

### 6. ChatGPT-Einrichtung konkret
- Für Claude belegt (Einstellungen → Connectors, Custom connector). Für ChatGPT steht nur im Plan „Plus/Pro über Entwicklermodus, Business/Enterprise über Admin-Connectors, vor P0 prüfen“.
- Karte sagt allgemein „eigenen Connector anlegen“. Zu entscheiden: Ist der ChatGPT-Weg geprüft, und welche Tarife gehen?

### 7. Prüfskript gegen Brief: mcp.ava.bi
- Brief erlaubt die Adresse mcp.ava.bi, pruefe.mts meldet sie als verbotenes Wort „mcp“ (Wortgrenze vor dem Punkt). Ich habe die Adresse in ava-in-claude-chatgpt drin gelassen, weil der Nutzer sie zum Verbinden braucht. Das ist der einzige verbleibende Hinweis.
- Vorschlag: Regex um `mcp(?!\.ava\.bi)` ergänzen.

### 8. Modus-Schalter und Rückfragen verbundener Dienste
- Telegram-Oberfläche sagt, der Modus-Schalter am Eingabefeld regelt, was AVA ohne Rückfrage darf. Ob er die Rückfrage der MCP-/A2A-Werkzeuge (`ctx.ui.confirmAction`) überspringt, konnte ich nicht belegen. Deshalb steht das in dienst-bestaetigen nicht drin.
- Zu klären: Gilt der Modus auch für fremde Dienste?

### 9. Rückkanal nach „Entfernen“ und Neuverbinden
- Zugang erneuern heißt Dienst entfernen und neu anlegen. Bleibt die Rückkanal-Adresse (Gateway je Nutzer + Dienst-Kurzname) gleich, oder muss der Nutzer sie in CompLeadly neu eintragen? Nicht belegt, deshalb nicht in der Karte.

### 10. CRM-Import und Verknüpfung
- Ob ein Import aus HubSpot/Close die CRM-Verknüpfung je Firma automatisch setzt, habe ich nicht gefunden. Karte crm-firmen-uebernehmen sagt es deshalb nicht.

### 11. Mail-Abrufintervall nur per Chat
- `pollIntervalMinutes` steht im Formularzustand von MailAccountSection, hat aber kein Eingabefeld; Triage-Kontext ebenso nur per Chat. Gewollt? Karte mail-abruf-und-verlauf sagt „kein eigener Regler“.

### 12. Fehlende app_oeffnen-Ziele
- fehlendes Ziel: `verbundene_apps` → /settings/konto#verbindungen (Claude/ChatGPT trennen, ava-in-claude-chatgpt)
- fehlendes Ziel: `deine_avas` → /settings/konto#instanzen (telegram-mehrere-avas, ava-claude-findet-nichts)
- fehlendes Ziel: `notizen` → /settings/verbindungen#wissensquellen-section (notion-verbinden, obsidian-verbinden)
- fehlendes Ziel: `mail_entwuerfe` → /settings/verbindungen#mail-entwurf-section (mail-entwurf-oeffnen, mail-entwurfs-postfach, mail-feste-anhaenge; heute nur `mail_verbinden` auf #mail-section)
- fehlendes Ziel: `wiederkehrende_aufgaben` → /settings/erweitert#scheduler-section (mail-wiederkehrend)
- fehlendes Ziel: `spracherkennung` → /settings/ki#voice-settings (telegram-sprachnachrichten)
- `dienst_verbinden` mit `dienst` belegt nur close/compleadly vor; für Rückkanal fehlt ein Sprung direkt zur Dienstkarte.

### 13. Verbesserungen an den vorhandenen Karten dienst-verbinden und crm-verbinden
- crm-verbinden: „Vor jeder Änderung im CRM fragst du kurz zu“ ist grammatisch schief (gemeint: „frage ich kurz nach“ / „stimmst du kurz zu“).
- crm-verbinden: Für Close gilt „lese Kontakte, Deals und Notizen“ nur mit dem zusätzlichen Dienst unter „Weitere Dienste“; die CRM-Karte allein kann Leads importieren und verknüpfen. Hinweis auf die zwei Stellen ergänzen oder auf close-verbinden verweisen.
- crm-verbinden: Salesforce/Dynamics nicht erwähnt; Nutzer fragen danach (eigene Karte salesforce-dynamics).
- dienst-verbinden: Close-Schlüssel „aus den Entwickler-Einstellungen“, CRM-Karte sagt „unter Einstellungen erzeugen“, `connect_crm` sagt „Einstellungen → API-Schlüssel“. Einheitlich machen.
- dienst-verbinden: Rückkanal (CompLeadly-Webhooks ab Premium) und „Zugang ändern = entfernen und neu verbinden“ fehlen; jetzt in compleadly-rueckmeldungen bzw. dienst-zugang-abgelaufen.
- Prüfsatz im Repo: „wie kriege ich hubspot angebunden“ trifft mit meinen Karten hubspot-verbinden statt crm-verbinden. Vorschlag: `"erwartet": ["crm-verbinden", "hubspot-verbinden"]`.
- CompLeadly nennt den Knopf „Neuer Token“; das Wort darf nicht in den Lösungstext. Ich schreibe „neuen Zugangscode anlegen“.

### Befunde (Fehler und Unstimmigkeiten in der App)

1. Telegram-Sprachnachricht ohne Spracherkennung antwortet: „Einstellungen → Modelle → Voice“ (m/telegram/inbound.ts:599-602). Den Tab gibt es nicht mehr; richtig: Einstellungen → KI & Kosten → Spracherkennung.
2. Posteingang, Tooltip der Pille „Auto-Antwort aktiv“: „In Einstellungen → Datenquellen → Mail“ (r/routes/TriageInbox.tsx:467). Richtig: Verbindungen → E-Mail.
3. Posteingang heißt dreimal anders: Menü „Mail-Triage“, Seitenkopf „Postfach“, leerer Zustand „Triage-Inbox“ (TriageInbox.tsx:104, 120; AppShell.tsx:730). Dazu englische Begriffe „Trusted“, „Absender als trusted“, Status „IDLE“/„Polling“.
4. `connect_crm` bei nicht eingerichteter OAuth-App: „Heute funktioniert nur HubSpot“ (m/agent/tools/crm.ts:206) ist veraltet, Close geht auch.
5. `import_companies_from_crm`-Beschreibung: „HubSpot, Salesforce, or Dynamics … Today only HubSpot is wired end-to-end“ (m/agent/tools/imports.ts:510-516), obwohl Close im enum steht und `fetchCloseLeads` existiert. Prompt-Zeile „Aus CRM (heute nur HubSpot)“ (prompts.ts:727) ebenso veraltet. README Import-Zeile und „Integrationen“ nennen Close/CompLeadly nicht.
6. Prompt nennt `crm_delete_*`-Werkzeuge (prompts.ts:178), es gibt keine. Telegram-Oberfläche nennt „etwas im CRM löschen“ / „CRM-Löschungen“ als Beispiel (TelegramSection.tsx:275, 318), für HubSpot nicht möglich.
7. Jargon in Nutzertexten: Art des Dienstes „Werkzeugdienst (stellt einzelne Werkzeuge bereit)“, Dienstkarte „n Werkzeuge“, CRM-Karte Close „über die Close-Werkzeuge“, Rückkanal „fragt AVA den Stand über die Werkzeuge ab“ (DiensteSection.tsx:150, 310, 273-274; Settings.tsx:896). Widerspricht der neuen Linie „nie über Werkzeuge reden“.
8. „Verbundene Apps“: Text nennt nur Claude, ChatGPT, Claude Code (kein Copilot), sagt „verarbeitet wird weiter auf diesem Rechner“ (falsch bei Server-Instanz), leerer Zustand „Noch kein Dienst verbunden“, aria-label „Verbundene Dienste“ (VerbindungenSection.tsx:39-55). Der Abschnitt liegt unter Konto, nicht unter Verbindungen; Nutzer suchen ihn dort.
9. Telegram-Abschnitt: Einleitung spricht nur von Meldungen, nicht vom Chat in Gegenrichtung (TelegramSection.tsx:116-120).
10. Dienst-Zugang: Fehlermeldung ans Modell sagt „Zugangscode erneuern (Dienst entfernen und neu verbinden)“, die Oberfläche bietet aber „Neu verbinden“ an der Karte, das nur mit dem alten Zugang erneut prüft. Für Nutzer missverständlich; ein „Zugang ändern“ an der Karte fehlt.
11. Close-Schlüssel-Pfad dreifach verschieden beschrieben (Settings.tsx:896 „unter Einstellungen“, DiensteSection.tsx:20 „Einstellungen → Entwickler“, crm.ts:196 „Einstellungen → API-Schlüssel“).

## Offene Fragen und Befunde (Äste linkedin, meldungen)

### Fragen an Joyce

### 1. Plan Free und beobachtete Posts / Leads
- Kontext: Karte linkedin-bereich-fehlt, linkedin-kosten-limit.
- Gefunden: Die Watchlist ist im Plan Free hart gesperrt (`watchlist/store.ts` maxEintraege 0, Sperrbanner). Für beobachtete Posts (Personen-Radar) und Leads fand ich im Desktop keine Free-Sperre; die Website-Vorgabe (WEBSITE_PROMPT_PRICING §2.5) sagt „Im Plan Free stehen Beobachtungsfunktionen nicht zur Verfügung“.
- Zu entscheiden: Gilt die Free-Sperre auch für beobachtete Posts/Leads (dann fehlt sie im Code oder liegt im Gateway), oder darf Free das? Die Karten sagen bisher nur: Watchlist ab Pro.

### 2. Abrechnung nach Verbrauch: Ist sie schon an?
- Kontext: linkedin-kosten-limit.
- Gefunden: Monatslimit-Dialog und `linkedin_limit_setzen` reagieren auf 404 („noch nicht freigeschaltet“). Notiz: PRICING_TIERS=1 noch aus.
- Zu entscheiden: Bleibt die Karte bei „falls deine Organisation nach Verbrauch abrechnet“? Wer zahlt Apify, solange die Verbrauchsabrechnung aus ist (Werkzeugtexte sagen „BYOK, der Nutzer zahlt“, die Oberfläche „Apify über AVA“)?

### 3. Watchlist und beobachtete Posts auf einer Server-AVA
- Kontext: linkedin-bereich-fehlt.
- Gefunden: Der Feed-Beobachter braucht ein Fenster und läuft nur im Desktop. Watchlist/Personen-Radar arbeiten über Apify ohne Fenster; ob sie auf einer Server-Instanz gestartet werden, konnte ich nicht sicher belegen.
- Zu entscheiden: Sollen Watchlist/Posts auf Server-Instanzen laufen und darf die Karte das sagen?

### 4. „Zweitkonto“-Empfehlung
- Kontext: linkedin-konto-risiko.
- Gefunden: Die Compliance-Vorgabe nennt einen „Hinweis auf ein Zweitkonto“, in der App steht nichts dazu.
- Zu entscheiden: Soll AVA ein Zweitkonto empfehlen? Bis dahin steht es nicht in der Karte.

### 5. Leads: wer sieht was?
- Kontext: linkedin-leads.
- Gefunden: Leads sind seit dem Umbau je Nutzer (actorId), Kollegen-Übernahme steht am Lead. Die Bestätigungstexte sagen aber noch „gilt danach für die ganze Organisation als übernommen“ (Übernahme) bzw. „verschwindet für die ganze Organisation“ (Ignorieren).
- Zu entscheiden: Welche Wirkung ist gewollt? Karte beschreibt den Code-Stand (eigene Leads, Kollegen-Hinweis).

### 6. Meldungsarten einzeln abschalten
- Kontext: meldungen-zu-viele.
- Gefunden: Es gibt keinen Schalter je Meldungsart, nur Wichtigkeit, Ruhezeiten, Häufigkeit, Firmen ruhen lassen.
- Zu entscheiden: Ist ein Filter je Art gewünscht (häufige Nutzerfrage „keine Stellenanzeigen-Meldungen mehr“)?

### 7. Rückmeldung zu einzelnen Meldungen
- Kontext: meldungen-falschmeldung.
- Gefunden: Bei LinkedIn-Signalen gibt es 👍/👎, bei Meldungen nur „Verwerfen“; das Verwerfen lernt nichts.
- Zu entscheiden: Soll „Verwerfen“ (oder ein „stimmt nicht“) in die Bewertung zurückfließen?

### Fehlende app_oeffnen-Ziele
- fehlendes Ziel: `linkedin_kalibrierung` → /settings/verbindungen#signal-kalibrierung (Karte linkedin-kalibrierung nutzt ersatzweise linkedin_verbinden).
- fehlendes Ziel: `linkedin_bildanalyse` → /settings/verbindungen#linkedin-image-analysis.
- fehlendes Ziel: Reiter im LinkedIn-Bereich (`linkedin_watchlist`, `linkedin_leads`, `linkedin_posts`); `linkedin` öffnet den zuletzt gewählten Reiter, die Route kennt keinen Reiter-Parameter.
- fehlendes Ziel: `dienste_rechner` → /settings/erweitert#dienste-section (Profilprüfung der Ansprechpartner, Karte linkedin-profil-pruefung).
- fehlendes Ziel: `naehe_vorrang` → /settings/meldungen#relevanz-section (Karte meldungen-tageszusammenfassung nutzt meldungen_einstellen).

### Befunde (Fehler, Unstimmigkeiten in der App)

1. Toter Link „Datenschutz-Hinweise“ im LinkedIn-Abschnitt: `href="#/datenschutz/linkedin"`, eine Route `/datenschutz/...` gibt es nicht (HashRouter, main.tsx). `routes/Settings.tsx:1410`.
2. Kaputte Sprungmarken unter „Erfasste Daten“: `<a href="#linkedin-image-analysis">` und `<a href="#provider-section">` sind im HashRouter Routen, keine Anker; sie landen im Fallback statt beim Abschnitt bzw. bei KI & Kosten. `routes/Settings.tsx:1783,1794`.
3. Veralteter Link „Provider in Status wählen“ → `/whoami`; das Modell wählt man heute unter Einstellungen → KI & Kosten → Anbieter & Modell. `routes/Settings.tsx:1861-1866`.
4. Navigation „Signale“ berücksichtigt `linkedin.leads` nicht: Ist nur Leads freigegeben, fehlt der Einstieg, obwohl die Route ihn erlaubt. `components/AppShell.tsx:685` vs. `main.tsx:79`.
5. Watchlist-Sperrbanner verweist auf „Einstellungen → Abo“; der Abschnitt heißt „Konto → Plan & Abrechnung“. `components/WatchlistPanel.tsx:100-102`.
6. Untertitel des Reiters „Beobachtete Posts“ sagt „legt Kandidaten ins Firmen-Radar“; tatsächlich landen Treffer unter „Leads“, die Radar-Liste blendet die Quelle aus (Panel-Text sagt es richtig). Gleicher Widerspruch in der Werkzeugbeschreibung `personen_radar_status` („Aufgeloeste Firmen stehen als Kandidaten im Firmen-Radar“). `routes/LinkedIn.tsx:363`; `agent/tools/linkedin-selfservice.ts:172-178`; vgl. `personen-radar/supervisor.ts:261-263`.
7. Link „Details in den Einstellungen“ auf der Signale-Seite und im Banner geht auf `/settings#linkedin-section` (funktioniert über die Anker-Umleitung, ok), aber die Watchlist-/Posts-Einstellungen haben keine Sprungmarke.
8. Bestätigungstexte Lead übernehmen/ignorieren sprechen von „ganzer Organisation“, Code arbeitet je Nutzer (siehe Frage 5). `agent/tools/linkedin-leads.ts:83,99`.
9. `linkedin_killswitch` löscht alle LinkedIn-Daten ohne eigene Bestätigungsabfrage im Werkzeug (die Oberfläche fragt nach). Ebenso `alerts_purge` und `alerts_dismiss_all` ohne confirmAction. `agent/tools/linkedin.ts:163-180`; `agent/tools/alerts.ts:130-145,272-300`.
10. `linkedin_posts_beobachten` mit `jetztPruefen` startet einen kostenpflichtigen Lauf ohne Rückfrage, `personen_radar_check_now` fragt dagegen nach. `agent/tools/linkedin-leads.ts:150-155` vs. `linkedin-selfservice.ts:146`.
11. Kein Chat-Gegenstück für „Fehlgeschlagene Schritte automatisch erneut versuchen“ (`alerts_set_prefs` kennt `autoRetryEnabled` nicht) und für „Kontakt nachholen“ bei Leads (Self-Service-Regel). `agent/tools/alerts.ts:206-260`; `LinkedInLeadsPanel.tsx:252`.
12. Interne Begriffe in der Oberfläche: Seite Meldungen „Heartbeat“ / „Alarmwürdige Vorgänge aus dem Heartbeat-Sweep“, Etikett „Bewertungs-Flag“ (Bewertung ist abgeklemmt, Watches liefern es weiter), Knopf heißt auf der Seite „Jetzt auslösen“, in den Einstellungen „Jetzt prüfen“. `routes/Alerts.tsx:36,82-88,117`.
13. Werkzeugtexte Watchlist/Personen-Radar sprechen von „BYOK — der Nutzer zahlt“ und „4 $ je 1.000“, die Oberfläche von „Apify über AVA“ (siehe Frage 2). `agent/tools/watchlist.ts:213,252`; `linkedin-selfservice.ts:36-39`.
14. Sammelmeldung „N neue LinkedIn-Leads“ entsteht nur, wenn im selben Lauf auch Firmen-Kandidaten übertragen werden (steht im Block `kandidaten.length > 0`); Leads ohne Firma (ungeklärt) lösen keine Meldung aus. Vermutlich gewollt, aber prüfen. `personen-radar/supervisor.ts:289-321`.
15. Watchlist „Fokus“-Tooltip sagt „mindestens als Warnung gemeldet“, die Oberfläche nennt die Stufe sonst „Achtung“ bzw. „Ab wichtig“. Uneinheitliche Begriffe für dieselbe Stufe (warn = Achtung = wichtig = Warnung). `WatchlistPanel.tsx:143`; `Alerts.tsx:52`; `Settings.tsx:3660`.

## Offene Fragen an Joyce (Äste `ki`, `chat`)

### Fragen

1. **Stufe S/A/B/C in der Modell-Liste anzeigen?**
   Kontext: Karten erklären, dass Workflows per Chat Stufe S und Verflechtungen Bild-Modell ab A brauchen.
   Gefunden: `modelOptionLabel` (r/routes/Settings.tsx:1929) zeigt ★, Kontext, Kostenklasse, „vision“, aber keine Stufe. Kein Chat-Werkzeug liefert die Stufe (settings_get_provider ohne tier). AVA kann die Frage „welche Stufe hat mein Modell?“ also nicht belegt beantworten; die Karte nennt nur die Stufen der Empfehlungen.
   Zu entscheiden: Stufe ins Label (z. B. „· Stufe A“) und/oder `tier` in settings_get_provider aufnehmen.

2. **Was zählt die Tages-Obergrenze genau?**
   Gefunden: Tages-Obergrenze sagt „Gemeinsame Obergrenze für Chat und Hintergrund“ (VerbrauchTab.tsx:211), die Verbrauchsübersicht darüber „Erfasst sind die Anfragen aus dem Chat“ (VerbrauchTab.tsx:52). Gezählt wird `usageStore.tokensUsedToday()`, gespeist aus `onUsage` des Chat-Orchestrators (core/bootstrap.ts:2052). Firmenverarbeitung und Producer zählen offenbar nicht.
   Zu entscheiden: Welcher Text stimmt? Karte ki-tageslimit sagt bewusst nur „KI-Nutzung über deinen Zugang“.

3. **Sprachmodus-Kosten: 0,20 bis 0,40 € je Minute noch aktuell?**
   Gefunden: Oberfläche und Bestätigung nennen „grob 0,20–0,40 € je Minute“ (SprachmodusSection.tsx:23, tools/sprachmodus.ts:45); docs/SPRACHMODUS.md:49 und die Notiz nennen für gpt-live-1 0,05 $/Min. Karte übernimmt den App-Text mit „laut App“.
   Zu entscheiden: Text anpassen oder bestätigen (Chat-Züge kommen dazu).
   **Erledigt 2026-11-08:** Abrechnung im Gateway ist 0,05 $/Min (gpt-live-1, llm-proxy.ts); 0,20–0,40 € stammte vom Realtime-Rueckfall. App, Bestaetigung, Karte ki-sprachmodus und docs/SPRACHMODUS.md nennen jetzt rund 5 Cent je Minute plus die Chat-Zuege.

4. **Stimme des Sprachmodus: fest Marin oder wählbar?**
   Gefunden: Einstellungen zeigen fest „Stimme: Marin“ (Entscheidung 2026-09-24), `sprachmodus_konfigurieren` erlaubt aber marin/coral/sage/shimmer und die Sitzung nutzt die gespeicherte Stimme (ipc/sprache.ts:49,58). Karte ki-sprachmodus-einstellen nennt die vier Stimmen.
   Zu entscheiden: Stimmen im Chat sperren oder in den Einstellungen anbieten.

5. **„Hardware-Prüfung“ für lokale Modelle**
   Gefunden: README.md:62 „kuratierte Modelle mit Hardware-Prüfung“; im Code keine RAM-Erkennung für die Modellwahl (os.totalmem nur in problem/snapshot.ts). Nur RAM-Angaben in Labels. Karte sagt „Orientierung nach Arbeitsspeicher“, keine Prüfung.
   Zu entscheiden: README korrigieren oder Prüfung bauen.

6. **Warnung bei sehr langen Gesprächen?**
   Gefunden: Der volle Gesprächstext geht bei jedem Zug mit, nur Werkzeugergebnisse altern (kontext-kuerzung.ts). Keine Meldung, wenn das Kontextfenster des Modells voll ist. Karte chat-lange-gespraeche empfiehlt ein neues Gespräch je Thema.
   Zu entscheiden: Hinweis „neues Gespräch beginnen?“ ab einer Größe einbauen?

7. **Autonomie-Modus per Chat umstellen?**
   Gefunden: Kein Chat-Werkzeug für den Modus (nur Auswahl am Eingabefeld). Regel „Jede neue Einstellung braucht auch ein Agent-Tool“ verletzt? Karte sagt ehrlich, dass AVA das nicht kann.
   Zu entscheiden: Werkzeug mit Bestätigung ergänzen oder bewusst nur in der Oberfläche (Sicherheitsgründe).

8. **Hintergrund-Modell im Chat setzen?**
   Gefunden: Kein Werkzeug für `producerModels`; settings_set_provider setzt nur das Chat-Modell. Karte ki-hintergrund-modell verweist auf die Einstellung.
   Zu entscheiden: Werkzeug ergänzen?

9. **DeepSeek, xAI, Qwen im Chat umstellbar machen?**
   Gefunden: tools/settings.ts:33-46 kennt nur ollama/openai/anthropic/google/mistral (Kommentar „8.k1“). Karte ki-anbieter-wechseln sagt, dass die drei selbst gewählt werden.

### Fehlende app_oeffnen-Ziele

- fehlendes Ziel: `sprachmodus` → /settings/ki#sprachmodus-section (Mit AVA sprechen)
- fehlendes Ziel: `spracherkennung` → /settings/ki#voice-settings (Diktat, „Hey AVA“)
- fehlendes Ziel: `lokale_modelle` → /settings/ki#installed-models bzw. #ollama-version
- fehlendes Ziel: `verbrauch_limit` → /settings/ki#verbrauch-limit (Tages-Obergrenze; heute nur `verbrauch`)
- fehlendes Ziel: `gedaechtnis` → /settings/konto#general-memory (Langzeitgedächtnis)
- fehlendes Ziel: `sprachmodus_starten` → /sprache (Gesprächsseite)
- fehlendes Ziel: `chat_verlauf` / Suche (ChatSearchModal), heute nur `chat`

### Befunde (Fehler, Unstimmigkeiten)

1. **Hilfetext Hintergrund-Modell veraltet:** Unter „Modell für Hintergrund-Verarbeitung“ steht „Die Hintergrund-Verarbeitung (Jahresabschlüsse, Firmenprofile, Publikationen) schickt tausende Textblöcke…“ (Settings.tsx:2324-2331), dieselbe Begründung im ProducerModelBanner. Laut Karte darüber („Firmenverarbeitung über AVAs Modell“) und POOL_PRODUCER (bootstrap.ts:555) laufen genau diese Schritte über das Betreiber-Modell. Das Hintergrund-Modell trifft heute Radar, Workflows, Firma finden, ICP-Assistent, Verflechtungen.
2. **Klappen-Titel „API-Schlüssel … nötig für die Hintergrund-Verarbeitung“** (Settings.tsx:2361) passt nicht mehr zur Betreiber-Spur; ohne Schlüssel läuft die Firmenverarbeitung trotzdem.
3. **Englische Kostenklassen im Modell-Dropdown:** „· cheap / · mid / · high / · vision“ (Settings.tsx:1932), sonst alles deutsch.
4. **Veraltete Pfadnamen „Einstellungen → Modelle“** in nutzersichtbaren Texten: Abo-429-Meldung (ai-sdk-provider.ts:1016), Sprachmodus-Fehler „Schlüssel in den Einstellungen unter Modelle“ (Sprachmodus.tsx), FirstRunWizard „unter Einstellungen → Modelle wechseln“, docs/AZURE_OPENAI.md:9, docs/SPRACHMODUS.md. Tab heißt seit Umbau „KI & Kosten“.
5. **settings_set_api_key-Beschreibung veraltet:** verweist auf „Pro/Max subscription (Settings → Modelle → Anthropic)“; das Claude-Abo gibt es nicht mehr, Anthropic läuft nur per Schlüssel (Settings.tsx:94-96). Ergebnis: AVA kann keinen Anthropic-Schlüssel annehmen und schickt evtl. zu einem nicht existierenden Abo. Zudem README.md:124 „KI-Schlüssel … werden nicht über den Chat gesetzt“, das Werkzeug tut es aber (für OpenAI/Google/Mistral).
6. **Anhängen-Knopf Tooltip** „Tabelle anhängen (.xlsx, .xls, .csv, .tsv)“ (Chat.tsx:1729), angenommen wird jede Datei bis 25 MB (attachment.ts:93).
7. **Chat löschen mit window.confirm** (Chat.tsx:638) statt `bestaetigen()` wie im Rest der App.
8. **Sprungmarke voice-settings fehlt im Ladezustand:** VoiceSection rendert ohne `id="voice-settings"`, solange der Voice-Store nicht bereit ist (Settings.tsx:3424-3431); Untermenü-Sprung und Diktat-Knopf (`/settings#voice-settings`) landen dann oben.
9. **Spracheingabe ohne Whisper:** bootstrap berechnet `diktat.verfuegbar` auch über OpenAI, der Desktop-Diktatknopf ist aber nur mit Whisper aktiv (Chat.tsx:2189). Absicht oder Lücke?
10. **README.md:62 ChatGPT-Abo „für … Firmenverarbeitung nutzbar“** widerspricht Oberfläche („Firmenverarbeitung läuft über AVAs eigenes Modell“).
11. **docs/MODEL_TIERS.md** nicht auf Stand des Katalogs (qwen3:*, gemma4:12b/31b, llama3.3:70b, „current default“ gemma4:e4b).
12. **Vision-Hinweis im Chat** nennt Beispiele „Claude Sonnet, GPT-4o, Gemini, llava“ (Chat.tsx:1670); GPT-4o und llava stehen nicht mehr als Empfehlung im Katalog.
13. **Plan/Auftrag „Leiste über dem Eingabefeld“** für Hintergrundaufgaben: seit Stufe 3 Karte im Verlauf (AufgabenLeiste.tsx `AufgabenKarten`).

## Offene Fragen an Joyce (Äste workflows, app, hilfe)

### Fragen

### 1. Workflows auf der Server-Instanz: was gilt verbindlich?
- Kontext: Karten workflow-ohne-laufende-app und ava-server-instanz sagen: „Workflows legst du dort im Chat an, Freigaben per Telegram“.
- Gefunden: Der Workflow-Dienst sitzt im gemeinsamen Kern (core/bootstrap.ts:3090), den auch der Server nutzt; Telegram-Freigaben (/freigaben, /ja, /nein) sitzen in main/telegram/inbound.ts. Die Aussage selbst steht nur in der Notiz reference_fly_headless_ava, live geprüft habe ich sie nicht. Die PWA hat keine Workflow- oder Freigabe-Ansicht.
- Zu entscheiden: Darf AVA das so zusagen? Sollen Freigaben auch in der AVA-App beantwortbar werden (Meldungen)?

### 2. Wie kommt ein Kunde an eine Server-Instanz?
- Kontext: Karte ava-server-instanz verweist auf „klärst du mit dem AVA-Team“.
- Gefunden: README.md:89 „Kunden-Instanzen in Erprobung“. Kein Bestellweg, kein Preis, keine Seite in App/Konsole für Nutzer.
- Zu entscheiden: Soll AVA Server-Instanzen überhaupt anbieten, und wenn ja mit welchem Weg (Mail, Konsole, Plan)?

### 3. Plan-Grenze für Workflows nach dem Pricing-Umbau
- Kontext: Karte workflow-anlegen-blockiert sagt „kostenloser Plan: ein Workflow, bezahlte Pläne beliebig viele“.
- Gefunden: shared/workflow-types.ts:283 kennt nur free/starter/pro/enterprise. Die neuen Plan-Namen (PRICING_TIERS, noch aus) tauchen dort nicht auf.
- Zu entscheiden: Bleibt „Free = 1 Workflow“ in den neuen Plänen? Wenn nicht, Karte und Code anpassen.

### 4. Problemmeldungen: ist der Gateway-Teil live?
- Kontext: Karte problem-melden beschreibt Senden, Antworten in „Meine Meldungen“ und Löschung nach 90 Tagen.
- Gefunden: Notiz project_problem_melden (Stand 2026-11-02): Gateway NICHT deployt, nur Mail-Rückfall. Ob inzwischen deployt, konnte ich nur lesend nicht prüfen.
- Zu entscheiden: Bestätigen, dass der Weg in AVA live ist; sonst Karte auf „Als E-Mail vorbereiten“ umstellen.

### 5. Problem melden aus der AVA-App
- Kontext: In app.ava.bi gibt es keine Problem-melden-Funktion.
- Gefunden: ava-app ohne Fundstelle; Notiz „PWA nur Mail-Link“ (offen).
- Zu entscheiden: Soll AVA in der App auf info@eprox-gmbh.de verweisen oder auf die Desktop-App? (Ich habe keine App-Karte dazu geschrieben.)

### 6. „AVA startet gar nicht“
- Kontext: Ein häufiges Supportanliegen, für das ich keine Karte mit konkreten Schritten schreiben konnte.
- Gefunden: Kein Startfehler-Bildschirm, keine dokumentierte Selbsthilfe (Neuinstallation? Protokollpfad je System?). Nur der Mail-Rückfall info@eprox-gmbh.de.
- Zu entscheiden: Welche Schritte soll AVA nennen (zum Beispiel neu installieren, Protokolldatei unter welchem Pfad mitschicken)? Die Karte kann dann nur über Telegram/App gelesen werden, weil die Desktop-App ja nicht läuft.

### 7. Zurücksetzen: was passiert mit den Firmen im Konto?
- Kontext: Karte zuruecksetzen nennt nur, was die Oberfläche nennt (lokale Daten).
- Gefunden: DangerZoneSection.tsx spricht von „allen lokal gespeicherten Daten“. Ob Firmenliste, Radar-Treffer und Leads im Konto (Cloud) erhalten bleiben, ist dort nicht gesagt.
- Zu entscheiden: Darf AVA sagen „deine Firmenliste im AVA-Konto bleibt erhalten“? Das ist die häufigste Rückfrage vor einem Reset.

### 8. Workspace-Skills
- Kontext: docs/SKILLS.md beschreibt Skills im Projektordner `.ava/skills`.
- Gefunden: Für Endnutzer der Desktop-App praktisch nicht erreichbar (Arbeitsverzeichnis der App).
- Zu entscheiden: Funktion für Nutzer erwähnen oder als Entwicklerfunktion ausblenden? (Keine Karte geschrieben.)

### 9. Mail-Schleifen-Karte
- Kontext: Wiederkehrende Mails (Neue Mail-Aufgabe, schedule_mail_loop) gehören laut Auftrag zum Mail-Helfer.
- Zu entscheiden: Nur sicherstellen, dass der Mail-Ast eine Karte dazu hat; wiederkehrende-aufgaben-verwalten verweist darauf.

### Fehlende app_oeffnen-Ziele
- fehlendes Ziel: `instanzen` (Einstellungen → Konto → Deine AVAs, Anker `instanzen`); Karten ava-instanzen-ueberblick, ava-umzug behelfen sich mit `profil`.
- fehlendes Ziel: `problem_melden` (Dialog öffnen, `problemMeldenOeffnen`) bzw. Anker `problem-section`; Karte problem-melden nutzt nur chat_vorschlag.
- fehlendes Ziel: `skills` (Anker `skills-list`); Karten skill-anlegen, skill-freigeben-importieren.
- fehlendes Ziel: `wiederkehrende_aufgaben` (Anker `scheduler-section`).
- fehlendes Ziel: `updates` (Anker `updates`).
- fehlendes Ziel: `speicherplatz` (Anker `storage`); Karte speicherplatz behilft sich mit `modell`.
- fehlendes Ziel: `diagnose` (Anker `diagnose`) und `dienste_rechner` (Anker `dienste-section`).
- fehlendes Ziel: `verlauf` (Anker `audit-trail`).
- fehlendes Ziel: `zuruecksetzen` (Anker `danger-zone`), bewusst ohne Aktion gelassen.
- fehlendes Ziel: `workflow_laeufe` (`/workflows/laeufe`) und `workflow` mit ID (Editor).
- fehlendes Ziel: `status` (`/whoami`, Erreichbarkeit der Quellen).

### Befunde (Fehler und Unstimmigkeiten in der App)

1. **Updates-Text widerspricht dem Code.** Einstellungen → Erweitert → Updates sagt „prüft beim Start und alle vier Stunden … Du bestätigst jeden Download und jeden Neustart selbst. Es gibt keine stillen Updates.“ (routes/Settings.tsx:515-518). Code: Prüfung alle 15 Minuten (main/updater.ts:58), `autoDownload = true` und `autoInstallOnAppQuit = true` (main/updater.ts:138-139), also Download ohne Bestätigung und Installation beim Beenden. Karte updates folgt dem Code.
2. **Update per Chat ohne Rückfrage.** `updater_install` startet die App ohne confirmAction neu (main/agent/tools/updater.ts:145-175).
3. **Falscher Pfad in der Plan-Grenzen-Meldung.** „Mehr im Starter-Plan (Einstellungen → Abo)“ (main/workflows/index.ts:186); den Reiter „Abo“ gibt es nicht, richtig wäre Einstellungen → Konto → Plan & Abrechnung.
4. **Modell-Sperre blockiert auch Pausieren per Chat.** `workflow_update` prüft die Modellstufe vor jeder Änderung, auch für `enabled` (main/agent/tools/workflows.ts:330); laut Kommentar in modellstufe.ts sollte nur Anlegen/Ändern gesperrt sein. Pausieren eines laufenden Workflows im Chat geht mit Stufe-A-Modell nicht.
5. **Modellstufe-Meldung nennt alte Beispielmodelle** („GPT-5.6 Sol/Terra, GPT-5.5“, modellstufe.ts:30), Katalog ist bei GPT-6.x.
6. **Problem melden per Chat verspricht Gesprächsauszug, schickt ihn nicht.** Bestätigungstext „sowie die letzten Schritte dieses Gesprächs“, aber `chatAuszug: null` (main/agent/tools/problem.ts:46-55); nur die Kennung des Gesprächs geht mit.
7. **Erinnerungen ohne Verwaltung, wenn Mail abgeschaltet ist.** Der Abschnitt „Wiederkehrende Aufgaben“ hängt an der Org-Funktion `mail` (settings/ErweitertTab.tsx:22, routes/Settings.tsx:180), Erinnerungen funktionieren aber ohne Mail und erscheinen genau dort. Außerdem sagt der Abschnittstext „zurzeit wiederkehrende Mails“, obwohl auch Erinnerungen gelistet werden; Statuszeile spricht von „Runs“.
8. **Kein Chat-Werkzeug für „Verarbeitung pausieren“.** Der Schalter existiert nur als Knopf (components/ProcessingToggle.tsx); widerspricht der Regel „jede Einstellung braucht auch ein Agent-Werkzeug“. Karte verarbeitung-pausieren sagt das ehrlich.
9. **Fachjargon in Nutzertexten:**
   - Banner Erreichbarkeit: „Der Producer für strukturierte Inhalte ist pausiert … Andere Stages laufen weiter normal.“ (components/AppShell.tsx:533-535).
   - Verlauf: Kategorie „Producer“ (settings/VerlaufTab.tsx:45).
   - Workflows-Seite: „Gespeicherte Abläufe aus Tool-Schritten“ (routes/Workflows.tsx:225); Editor: „Tool-Aufrufe“, „Expression“, „Items“, „Pin-Daten“.
   - Skill-Editor und Vertrauensdialog: „Erlaubte Tools“, „allowed-tools“, „Body (Markdown)“, „Hash“, Bereiche „Outreach“/„Qualifying“ (components/skills/*.tsx).
   - Status-Seite: „Tenant“, „Tenant-ID“, „persönlicher Tenant“ (routes/Whoami.tsx:53-68).
10. **„Im Finder anzeigen“ auch unter Windows** (components/DiagnoseSection.tsx), dort heißt es Explorer.
11. **Name der Instanz nur per Chat änderbar.** Deine AVAs hat kein Namensfeld, obwohl `window.api.instanz.set` den Namen kennt (InstanzenSection.tsx:58-63).
12. **Website-Prompt Workflows veraltet:** nennt vier Vorlagen, der Code hat sieben (main/workflows/templates.ts).
