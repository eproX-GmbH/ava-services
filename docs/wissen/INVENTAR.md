# Wissensinventar AVA (Nutzersicht)

Stand 2026-11-07. Grundlage für die Lösungskarten (docs/PLAN_LOESUNGSKARTEN.md, Schritt L2).
Lesestand Code: main a4c38708. Status der Karten: **alle Äste abgenommen durch Joyce (2026-11-07/08)**
(je Themenast, Tabelle in §2). Erst nach dem OK gelten Karten als ausgeliefert; bis dahin liegen sie
nur auf dem Branch `claude/wonderful-bell-d6f985`, nicht auf main.

Zugehörige Dateien:

- Karten: `services/desktop/src/main/wissen/karten/<ast>/<id>.md` (Format: `karten/README.md` dort)
- Prüfsatz: `services/desktop/src/main/wissen/pruefsatz.json`, Test `scripts/test-wissen.mts`
- `docs/wissen/FRAGEN_UND_BEFUNDE.md`: alle offenen Fragen und Befunde je Ast im Wortlaut der Erfassung
- `docs/wissen/PROMPT_EINORDNUNG.md`: jeder Abschnitt aus prompts.ts und soul.ts als Regel oder Wissen eingeordnet (Grundlage L5)

## 1. Vorgehen und Quellen

Je Themenast systematisch abgearbeitet und gegen den Code geprüft (Code gewinnt gegen Doku und Plan):

1. Oberfläche Desktop: alle Seiten unter `renderer/src/routes/`, alle Einstellungs-Tabs und Abschnitte
   (`SETTINGS_TABS`, `SETTINGS_TAB_SUB_ITEMS`, `routes/settings/*`), Seitenleiste (`components/AppShell.tsx`).
   Web-Konsole admin.ava.bi (Repo ava-admin, nur Organisations-Admin-Seiten; Betreiber-Seiten als „betreiber“ vermerkt),
   AVA-App app.ava.bi (Repo ava-app), Telegram (Bot-Befehle, Kanalgrenzen).
2. Werkzeugkatalog: alle Werkzeuge in `main/agent/tools/`, gruppiert nach den Fähigkeitsgruppen
   (`main/suggestions/faehigkeiten.ts`); `docs/TOOLS.md`.
3. Systemprompt und Seele: jeder Abschnitt eingeordnet, siehe PROMPT_EINORDNUNG.md (Kurzfassung §5).
4. README „Was AVA heute kann“ und die „Nicht behaupten“-Listen in `docs/WEBSITE_PROMPT_*.md`.
5. `docs/PLAN_*.md`: nur der nutzersichtbare Teil. Keine Plan-Verweise, Pfade oder Schrittnummern in Kartentexten
   (maschinell geprüft).
6. Supportfälle: Problemmeldungen im Gateway (lesend, §4), Rückmeldungen von Patrick und Alessandro aus Plänen und
   Projektnotizen. Chatverläufe von Nutzern NICHT ausgewertet (offene Frage 4 im Plan, nicht freigegeben).
7. Integrationen: HubSpot, Close, Salesforce/Dynamics (gibt es nicht, ehrliche Karte), Notion, Obsidian, Mail,
   Telegram, LinkedIn, CompLeadly, beliebige Dienste und Agenten, AVA in Claude/ChatGPT/Copilot, ChatGPT-Abo,
   Azure OpenAI, eigene Schlüssel, Ollama.
8. Abrechnung, Pläne, Limits, Datenschutz, Datenhaltung lokal und auf dem AVA-Server.

Zwei Fragen der Erfassung habe ich lesend in Produktion geklärt:

- `PRICING_TIERS=1` ist im Gateway gesetzt (Umgebung von ava-db-gateway, 2026-11-07). Das Sitz-Modell
  (Free/Pro/Max/Ultra, Kontingent, Aktiv/Ruhend) ist also für Nutzer sichtbar. Die Abrechnungskarten sind
  trotzdem zustandsneutral geschrieben; siehe Frage A1.
- „Problem melden“ läuft produktiv (Einträge vom 02. bis 04.11. in der Tabelle der Problemmeldungen).

## 2. Karten je Themenast (Abnahmeblöcke)

| Block | Ast | Karten | Abnahme |
|---|---|---|---|
| 1 | erste-schritte | 11 | abgenommen 2026-11-08 (start-analyse mit Block 3) |
| 1 | konto | 12 | abgenommen 2026-11-08 |
| 1 | abrechnung | 10 (ausgabenlimit in kontingent-erreicht aufgegangen, A1) | abgenommen 2026-11-08 |
| 1 | datenschutz | 7 | abgenommen 2026-11-08 |
| 2 | firmen | 48 | abgenommen 2026-11-08 |
| 3 | kontakte | 19 (neu kontakt-suchen) | abgenommen 2026-11-08 |
| 3 | radar | 13 | abgenommen 2026-11-08 |
| 3 | recherche | 12 | abgenommen 2026-11-08 |
| 4 | verbindungen | 26 (davon 2 aus der Hauptsession) | abgenommen 2026-11-07/08 (7 Fall-Karten am 07., übrige 19 am 08.) |
| 4 | mail | 10 | abgenommen 2026-11-08 |
| 4 | telegram | 14 | abgenommen 2026-11-08 |
| 5 | linkedin | 17 | abgenommen 2026-11-08 (Leads nach 2ac245fd) |
| 5 | meldungen | 17 | abgenommen 2026-11-08 |
| 6 | ki | 20 | abgenommen 2026-11-08 (Sprachmodus-Preis wie in der App, B7 offen) |
| 6 | chat | 15 (davon 1 aus der Hauptsession) | abgenommen 2026-11-08 |
| 7 | workflows | 18 (neu start-top10, Onboarding O3) | abgenommen 2026-11-08 |
| 7 | app | 11 | abgenommen 2026-11-08 |
| 7 | hilfe | 14 | abgenommen 2026-11-08 |
| | **gesamt** | **294** | |

Inventar: rund 700 Einträge, davon 628 geprüft, 33 unklar, 14 veraltet, 11 nur für Betreiber.

Prüfung (2026-11-07):

- Format und Textregeln: alle 292 Karten fehlerfrei (Leser `format.ts`, dazu eine Prüfung auf verbotene Wörter
  wie Tool/Werkzeug/MCP/Token, Geviertstriche, Plan-Verweise, gültige `app_oeffnen`-Ziele).
- Prüfsatz: 241 Fragen (5 der Hauptsession, 207 aus der Erfassung, 29 frisch aus Supportfällen und Feedback; der frische Satz liegt vollständig mit 30 Fragen in docs/wissen/pruefsatz-frisch.json).
  Treffer unter den ersten drei: **98 % nur Volltext, 95 % mit Vektoren**; frischer Satz 29/30 in beiden Fällen (nach der Anpassung der Suche durch die Hauptsession). Einen eigenen blinden Satz von 25 Fragen hält die Hauptsession zurück (21/25 Volltext, 24/25 Vektoren).
- Ehrlich dazu: Die Schlagworte habe ich an den Fehlgriffen des Satzes nachgeschärft (Synonyme wie „pleite“, „Pop-up“,
  „Vernetzungsanfrage“). Der frische Satz aus Supportfällen lag VOR dem Nachschärfen bei 26/30 (Volltext) und 25/30
  (Vektoren). Das ist der ehrlichere Wert für unbekannte Fragen.
- Doppelungen über Astgrenzen zusammengeführt (Art.-14-Hinweis, Person löschen, Umzug, LinkedIn-Kosten,
  Profil-Prüfung, Gedächtnis, Ausschreibungen, Stellen, Vorschläge, Verlauf, Profil, CRM-Import); verbleibende nahe
  Paare mit verschiedenem Anliegen (Import hängt / Firma wird nicht fertig, KI antwortet nicht / AVA hängt) sind
  gewollt getrennt.

Regeln, nach denen geschrieben wurde: AVA spricht in Ich-Form zum Nutzer in Du-Form, erst was AVA selbst tun kann,
dann der Weg in der App, dann Grenzen und Kosten. Keine Behauptung ohne Beleg im Code; Unbelegtes steht als Frage in
§6 statt in einer Karte. Abschaltbare Module mit Hinweis „falls deine Organisation das freigeschaltet hat“.
Preise stehen in keiner Karte (Frage A2). Zugangsdaten führen immer in die sichere Eingabe, nie in den Chat.

## 3. Was beim Abnehmen besonders anzusehen ist

- Block 4 (verbindungen): die Karten zum auslösenden Fall: `compleadly-verbinden`, `compleadly-nutzen`,
  `compleadly-rueckmeldungen`, `close-verbinden`, `salesforce-dynamics`, `ava-in-copilot`.
- Block 1 (abrechnung): zustandsneutral formuliert, Entscheidung A1.
- Block 1 (datenschutz): `ki-anbieter-daten` und `daten-lokal-oder-server` sagen offen, dass die Firmenverarbeitung
  über ein Modell läuft, das AVA bereitstellt (Frage A4), auch wenn der Nutzer lokal arbeitet.
- Karten, die heute ehrlich „das geht im Chat noch nicht“ sagen (Frage A7): firma-entfernen, verarbeitung-pausieren,
  rechner-ausgelastet, ki-hintergrund-modell, chat-autonomie-modus, falsche-website.

## 4. Supportfälle und Rückmeldungen

Problemmeldungen (Gateway, lesend, alle vorhandenen Einträge; ohne Namen):

| Datum | Meldung (gekürzt) | Karte(n) |
|---|---|---|
| 2026-11-04 | Fünf Firmen für bAV gesucht, gefunden, aber nicht bearbeitet | verarbeitung-haengt, import-haengt, bestand-suchen |
| 2026-11-03 | Stellenanzeigen liefern nur Unbrauchbares („mittlere Reife“) | stellenanzeigen-firma (Qualitätsproblem selbst ist kein Kartenthema) |
| 2026-11-03 | Firmen werden nach 30 Tagen nicht neu verarbeitet („zuletzt gesehen“) | daten-aktualitaet, firma-neu-verarbeiten |
| 2026-11-02 | Heartbeat zeigt keine geprüften Kandidaten | meldungen-kommen-keine, meldungen-wie-ava-entscheidet |
| 2026-11-02 | Test | – |

Rückmeldungen aus Plänen und Notizen, die Karten bekommen haben:

- Patrick 2026-11-07: „verbinde dich mit CompLeadly“ → dreimal „kein Werkzeug“ (compleadly-verbinden, dienst-verbinden,
  chat-seiten-oeffnen); AVA wirkt programmatisch, redet über Werkzeuge (Ton aller Karten).
- Patrick 2026-11-04: „welche meiner Firmen bieten bAV“ (bestand-suchen).
- Patrick 2026-10-31: Lead übernommen, Kontakt fehlt (linkedin-lead-kontakt-fehlt).
- Patrick 2026-10-24: Quelle verlinken (meldungen-quelle, kontakt-herkunft).
- Patrick/Henning: „verarbeiten“ ist kein Nutzerwort, Daten sollen einfach da sein (verarbeitung-schritte,
  daten-fehlen-bei-firma).
- Alessandro 2026-11-05: Einrichtung blieb nach „Continue with ChatGPT“ stehen (ki-chatgpt-abo-probleme,
  einrichtungsassistent); nutzt Close und CompLeadly (close-verbinden, compleadly-*).
- Alessandro 2026-11-04: bekam per Download eine alte Version (updates, ava-installieren).

## 5. Systemprompt: Kurzfassung der Einordnung

Statischer Systemprompt gemessen ~16.300 Tokens (Seele ~2.080). Eingeordnet: Regel ~1.260, kürzen ~7.260,
Wissen ~6.340, doppelt ~1.440. Nach Umsetzung geschätzt ~4.200 Tokens statisch (minus 74 %), mit den dynamischen
Teilen je Turn ~5.000 bis 6.000. Größte Hebel: Tool-Discovery (1.664 → 250, Bündel nach `KNOWN_BUNDLES`), Import/
DryRun/Retry (2.345 → 130, Werkzeugbeschreibungen tragen es schon), Buying Center (933 → 20), Bestandsfragen,
Freshness, HubSpot-Übernahme, Diagramme, Producer-Tabelle der Seele (kann ganz weg).

Wichtig für L5: Beschreibungen nachgeladener Funktionen sieht das Modell erst nach dem Laden. Abläufe können in die
Beschreibung, der Auslöser muss als eine Zeile im Prompt bleiben. Reines Modellwissen („rufe erst X, dann Y“) ist
keine Lösungskarte; das Kartenformat kennt bisher keine Modell-Karten.

18 Widersprüche im Prompt, u. a.: „6 Werkzeuge immer verfügbar“ (Code: 13), Seele nennt 7 Firmen-Werkzeuge als
immer verfügbar, `settings_set_anthropic_subscription_token` gibt es nicht, „CRM heute nur HubSpot“ (Close geht),
Reste der abgeschalteten Bewertung, „Zugang abgelaufen“-Meldung gibt es so nicht, „Zugangsdaten nie im Chat“ gegen
Self-Service „API-Schlüssel per Chat setzen“. Alles in PROMPT_EINORDNUNG.md §4.

## 6. Offene Fragen an Joyce

Kuratiert und nach Wirkung geordnet; Einzelheiten und Fundstellen in FRAGEN_UND_BEFUNDE.md (Kürzel in Klammern:
a = erste-schritte/konto/abrechnung/datenschutz, b = firmen, c = kontakte/radar/recherche,
d = verbindungen/mail/telegram, e = linkedin/meldungen, f = ki/chat, g = workflows/app/hilfe).

**Grundsätzliches**

Entschieden 2026-11-08: A1 nur Sitz-Modell, A2 Preise nennen, A4 ohne Anbieternamen, A8 so lassen (Problem melden oder info@eprox-gmbh.de). A5 (Länder): Norwegen und Finnland werden genannt, obwohl sie am 2026-11-08 in Produktion noch nicht im Bestand waren (firma_suchen 0 Treffer, firma_lesen NO_923609016 und FI_01120389 = 404); Erstabzug läuft seit 2026-11-08 08:21 UTC (Finnland in Stunden, Norwegen bis 2026-11-09 früh); in der Suche erscheinen NO/FI erst nach dem Index-Abgleich am 10.11.

- A1. Sitz-Modell ist live (PRICING_TIERS=1). Sollen die Abrechnungskarten jetzt nur noch das Sitz-Modell
  beschreiben (Karte `ausgabenlimit` streichen, Aktiv/Ruhend ohne Vorbehalt)? (a-F1, b-5)
- A2. Dürfen Preise in Karten stehen (Planpreise, Stufen je Firma, Sprachmodus je Minute)? Heute nennt AVA sie aus
  dem Abrechnungsstand; eine Karte braucht für jede Preisänderung ein Release. (a-F2)
- A3. Zugangsdaten im Chat: Die Verbindungsfunktionen für Telegram, Notion und Obsidian nehmen Codes im Chat an,
  der Prompt erlaubt API-Schlüssel per Chat. Gilt „nie im Chat“ ausnahmslos (dann auf die sichere Zugangskarte
  umstellen), oder sind diese Wege gewollt? Die Karten führen heute alle in die Einstellungen. (d-1)
- A4. Datenschutz: Die Firmenverarbeitung läuft über ein Modell, das AVA bereitstellt (Standard gpt-6-luna), auch bei
  lokalem Arbeiten; öffentliche Firmentexte samt Impressums-Namen gehen dabei an diesen Anbieter. Anbieter nennen?
  AV-Vertrag verlinken? Gilt das auch bei Anbieter-Sperre der Organisation? README und Compliance-Text der Website
  sagen „Rechenarbeit lokal“ und sind damit zu weitgehend. (a-F5, a-B1)
- A5. Was darf AVA als vorhanden nennen, solange die Erprobung läuft: Copilot-Anbindung und Agenten (A2A, Live-Test
  offen), Server-Instanz für Kunden (kein Bestellweg), Norwegen/Finnland (Erstabzug gelaufen?). (d-5, g-2, b-7)
- A6. Grenzen im Free-Plan, die der Code uneinheitlich nennt: Radar (Oberfläche „Pro“, Hinweise „Starter-Plan“),
  LinkedIn (Code sperrt nur die Watchlist, Website sagt „keine Beobachtung in Free“), Workflows (Code kennt nur
  free/starter/pro/enterprise). (c-1, e-1, g-3)
- A7. Self-Service-Regel: Es fehlen Chat-Funktionen für Firma entfernen/aussetzen, Verarbeitung pausieren,
  Autonomie-Modus, Hintergrund-Modell, Anbieter DeepSeek/xAI/Qwen, „fehlgeschlagene Schritte automatisch
  wiederholen“, „Kontakt nachholen“, Instanzname in der Oberfläche. Bauen? Die Karten sagen heute ehrlich, dass es nur
  in der App geht. (b-3, g-8, f-7/8/9, e, g-11)
- A8. Eigene Daten: Es gibt keinen Weg, das AVA-Konto samt Serverdaten zu löschen, und keinen Gesamtexport. Karten
  verweisen ans AVA-Team (Problem melden, info@eprox-gmbh.de). Ist das der Prozess, ist die Adresse richtig? Und:
  Wie läuft „Passwort vergessen“? (a-F7, a-F8)
- A9. Sprache der Karten: nur Deutsch (offene Frage 2 im Plan)? Erfasst ist nur Deutsch.

**Fachlich, je Ast**

- B1. Falsche Website zugeordnet: Eine Funktion „richtige Website setzen“ gibt es nicht. Bauen, oder bleibt es bei
  Neuverarbeitung und „Problem melden“? (b-2)
- B2. Kontingent: Zählt eine Firma im Sitz-Modell je Organisation oder je Nutzer? Zählt das Übernehmen eines geteilten
  Vorgangs? Zählt eine ruhende Firma bis Monatsende (Werkzeug) oder nicht (Tooltip)? (a-F3, a-F4, b-4)
- B3. Leads: Laut Code je Nutzer, die Bestätigungstexte sagen „gilt für die ganze Organisation“. Was ist gewollt? (e-5)
- B4. Person löschen: nur durch die Organisation, die sie erfasst hat (Beschreibung der Funktion), ob durchgesetzt,
  ist nicht geprüft. So gewollt? (c-2)
- B5. Link-Überwachung klickt Cookie-Banner mit „Alle akzeptieren“ weg. Gewollt (Datenschutzregel „ablehnen“)? (c-6)
- B6. Updates: Einstellungen sagen „alle vier Stunden, jeden Download bestätigen, keine stillen Updates“, der Code prüft
  alle 15 Minuten, lädt selbst und installiert beim Beenden. Welches Verhalten soll gelten? Karte folgt dem Code. (g-B1)
- B7. KI: Stufe S/A/B/C in der Modell-Liste zeigen? Zählt die Tages-Obergrenze nur den Chat? Sprachmodus-Kosten
  (App 0,20 bis 0,40 € je Minute, Doku 0,05 $) und Stimme (fest Marin oder wählbar)? (f-1 bis f-4)
- B8. Länder: UK ohne Jahresabschlüsse? AT-Geschäftsführung nur im kostenpflichtigen Auszug? (b-1, b-8)
- B9. Close muss für CRM-Import und für Kontakte/Aufgaben zweimal mit demselben Schlüssel verbunden werden. So lassen?
  (d-3)
- B10. „Beschäftigungen verfallen nach 120 Tagen“ (Konsole, Website): im Code nicht gefunden, nur 180 Tage für
  Personen. (a-F6)
- B11. Workflows auf einer Server-AVA: nur im Chat anlegen, Freigaben per Telegram, verbindlich? (g-1)
- B12. Meldungen: Schalter je Meldungsart, Rückmeldung „verwerfen“ in die Bewertung? (e-6, e-7)

## 7. Ziele zum Öffnen von Seiten

Alle in der Erfassung vermissten Ziele hat die Hauptsession ergänzt (main a4c38708): Verlauf, Deine AVAs, Dienste auf
diesem Rechner, Zurücksetzen, Verbundene Apps, Langzeitgedächtnis, Wiederkehrende Aufgaben, Updates, Nähe & Vorrang,
Spracherkennung, Sprachmodus, lokale Modelle, Tages-Obergrenze, Skills, Diagnose, Speicherplatz, Notizen,
Mail-Entwürfe, Beobachtungen, Link-Überwachung, E-Mail-Adressen, ICP, LinkedIn-Kalibrierung, Bildanalyse,
Organisation, Status, Workflow-Läufe, geteilte Buying Center, „Gerade Thema“, dazu firmenliste/firmensuche (vorher
vertauscht), importieren, stammdaten_mitpflegen, vorgang. 55 Karten tragen danach einen passenden Öffnen-Knopf.
Kein eigenes Ziel gibt es für „Problem melden“ und den Chatverlauf (keine eigene Seite); diese Karten nennen den Weg
in Worten.

## 8. Befunde in der App (Auswahl, vollständig in FRAGEN_UND_BEFUNDE.md)

Behoben während der Erfassung (Hauptsession): app_oeffnen-Ziele „firmenliste“/„alle_firmen“ vertauscht; „Weitere
Dienste“ ohne eigene Sprungmarke.

Offen, nach Wirkung:

- Rückfrage fehlt bei folgenreichen Chat-Aktionen: Update installieren startet ohne Rückfrage neu, LinkedIn-Not-Aus,
  „alle Meldungen löschen/endgültig“, „Posts beobachten, jetzt prüfen“ startet einen kostenpflichtigen Lauf.
- „Problem melden“ im Chat verspricht einen Gesprächsauszug, schickt aber keinen.
- UK-Firmen: „Jetzt prüfen“ im Insolvenz-Abschnitt fragt das deutsche Insolvenzportal (der Chat nimmt den richtigen Weg).
- Chat-Firmensuche ohne Länderfilter; Excel-Import kennt kein Land (AT/CH-Firmen werden gegen das deutsche Register
  zugeordnet); Stadt-Spalte im Chat optional, im Gateway Pflicht.
- Fester Startvorschlag „Best-Match über meine Firmen“ erscheint nie (Gruppe `best_match` gibt es nicht).
- Veraltete Klickpfade in Nutzertexten: „Einstellungen → Modelle“, „→ Abo“, „→ Datenquellen“, „Modelle → Voice“,
  „Datenquellen → Mail“, `/whoami`-Verweis im LinkedIn-Abschnitt; toter Link „Datenschutz-Hinweise“ (LinkedIn);
  Sprungmarken im HashRouter wirkungslos (`#linkedin-image-analysis`, `#provider-section`).
- Falsche Aussagen in der Oberfläche: „Beobachtete Posts“ landen angeblich im Radar (tatsächlich unter Leads);
  Hilfetext Hintergrund-Modell nennt Jahresabschlüsse/Profile (laufen über AVAs Modell); Anhängen-Knopf „Tabelle“
  (jede Datei geht); „Im Finder anzeigen“ auch unter Windows.
- Organisationspflicht über „Überspringen“ im Ladezustand umgehbar.
- Erinnerungen haben keine Verwaltung, wenn die Organisation Mail abschaltet (Abschnitt hängt an Mail).
- Modellstufen-Sperre blockiert auch das Pausieren eines Workflows per Chat.
- Fachjargon in der Oberfläche: Pipeline-Verlauf, englische Schrittnamen, Agenten-Turn, MCP-Zugang, Tenant,
  Heartbeat-Sweep, Bewertungs-Flag, „+ Neuen Watch anlegen“, Evaluations-Flag (Bewertung ist abgeschaltet),
  ICP-Fragecodes „K1 ·“, englische Kostenklassen im Modell-Dropdown, „Werkzeugdienst“.
- `window.confirm` statt app-eigener Bestätigung: Person löschen, Konto entfernen, Firma entfernen, Chat löschen.
- Fehlende Umlaute: Wärmeanzeige-Tooltip, „ICP unvollstaendig“, „Kopieren nicht moeglich“.
- Doku veraltet: README (Länder ohne NO/FI, „fünf Producer“, ChatGPT-Abo für Firmenverarbeitung, Rechenarbeit lokal),
  Website-Compliance-Text (Art. 14/Löschung als „in Arbeit“), MODEL_TIERS.md, PLAN_AUFFRISCHUNG (7 statt 14 Tage),
  Website-Workflows-Text (4 statt 7 Vorlagen).

## 9. Themenbaum

Je Ast: Eintrag, Nutzen und Grenzen, Quelle (Datei:Zeile; R = services/desktop/src/renderer/src, T oder M =
services/desktop/src/main/agent/tools bzw. main, G = services/db-gateway/src, K = Repo ava-admin), Status, Karte(n).
Karten-ids sind auf den Stand nach dem Zusammenführen gebracht.

### Inventar: Äste erste-schritte, konto, abrechnung, datenschutz

Stand 2026-11-07, Lesestand main plus ~/Desktop/Repos/ava-admin (main, 28c48d9).
Pfadkürzel: `R/` = services/desktop/src/renderer/src, `M/` = services/desktop/src/main, `G/` = services/db-gateway/src, `K/` = ava-admin/src/app/(konsole).

Wichtiger Vorbehalt Abrechnung: Ob das Gateway in Produktion mit `PRICING_TIERS=1` läuft, ist im Repo nicht ablesbar (kein Eintrag in fly.toml, Notiz vom 2026-11-02: „noch AUS“). Zwei Modelle existieren parallel; die Karten sind zustandsneutral formuliert (siehe fragen.md F1).

#### erste-schritte

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Was ist AVA | B2B-Vertriebsassistent für DE/AT/CH/UK: finden, einordnen, recherchieren, beobachten, nächste Schritte. | README.md:7-11, 24-90 | geprüft | was-ist-ava |
| Kanäle | Desktop-App, AVA-App (app.ava.bi), Telegram, Claude/ChatGPT, Workflows. | README.md:11 | geprüft | was-ist-ava |
| Download/Plattformen | macOS arm64 + x64 (dmg), Windows x64 (nsis); Linux nur als Build-Ziel, nicht im Release. | .github/workflows/desktop-release.yml:130,557,956; services/desktop/electron-builder.yml:89-182 | geprüft | ava-installieren |
| Updates | Banner „Update verfügbar“, Klick lädt und installiert; Abschnitt „Updates“ unter Erweitert. | R/components/UpdateBanner.tsx:130; R/routes/Settings.tsx:506-515 | geprüft | ava-installieren |
| Anmelden | „Anmelden“ öffnet den Standard-Browser (OIDC), Rückkehr ins Fenster. | R/routes/SignIn.tsx:27-96 | geprüft | anmelden-registrieren |
| Konto erstellen (in der App) | Vorname, Nachname, E-Mail, Passwort ≥ 8, AGB/Datenschutz; danach sofort angemeldet. | R/routes/SignUpForm.tsx:52-70,131-140 | geprüft | anmelden-registrieren |
| Passwort vergessen | In der App kein eigener Weg; ob die Browser-Anmeldeseite das anbietet, nicht im Repo belegbar. | R/routes/SignIn.tsx (nichts) | unklar | – (fragen.md F7) |
| E-Mail-Bestätigung | In der App registrierte Konten sind bestätigt; Restfall meldet „email_nicht_bestaetigt“ mit Hinweis ab-/anmelden. | G/lib/keycloak-admin.ts:149-163; G/lib/upstream.ts:215; R/routes/SignUpForm.tsx:134 | geprüft | email-bestaetigung |
| Einrichtungsassistent Schritt 1 Organisation | Anlegen (Owner) oder Einladungslink; Organisationsschlüssel übernehmen, falls vorhanden. | R/routes/FirstRunWizard.tsx:275-310,1176-1384 | geprüft | einrichtungsassistent, organisation-anlegen, organisation-beitreten |
| Einrichtungsassistent Schritt 2 KI-Anbieter | ChatGPT-Abo (Plus/Pro), eigener Schlüssel oder lokales Modell; unter Anbieter-Sperre nur Organisationsschlüssel. | R/routes/FirstRunWizard.tsx:311-380 | geprüft (Text dort veraltet, siehe Befund B3) | einrichtungsassistent |
| Einrichtungsassistent Schritt 3 Modelle | Einbettungsmodell (~600 MB) immer, LLM nur beim lokalen Weg; einmal je Rechner. | R/routes/FirstRunWizard.tsx:378-470 | geprüft | einrichtungsassistent |
| Organisation Pflicht | Persönlicher Fall zeigt nur Anlegen oder Einladungslink, kein Weiter ohne. | R/routes/FirstRunWizard.tsx:1330-1384; README.md:80 | geprüft (Lücke: „Überspringen“ während des Ladens, Befund B4) | organisation-anlegen |
| Organisation später anlegen | Konsole-Übersicht „Du bist in keiner Organisation“ mit Anlegen und Beitritt. | K/page.tsx (Texte „Organisation angelegt. Du bist Owner.“) | geprüft | organisation-anlegen |
| Beitritt per Link | Anfrage stellen, „Freigabe prüfen“, nach Freigabe Neustart in der Organisation. | R/routes/FirstRunWizard.tsx:1347-1380; K/beitreten/[token]/page.tsx:27-45 | geprüft | organisation-beitreten |
| Erste sinnvolle Schritte | Feste Startchips: KI-Modell, HubSpot, Telegram, Mail, ICP, Fokus-Themen, Radar, Import, Workflow. | M/suggestions/erzeugung.ts:120-138 | geprüft | erste-schritte-start |
| ICP aus Websites | eigene Website + bis zu fünf Kunden-Websites oder Fragebogen. | README.md:37 | geprüft (README; Werkzeug icp_* vorhanden) | erste-schritte-start |
| Navigation Desktop | Chat, Vorgänge (Alle Vorgänge, Importieren, Workflows*), Firmen (Meine Firmen, Firmensuche, Radar, Gerade Thema*, Geteilte Buying Center*), Meldungen (Aktive Meldungen, Mail-Triage*), Signale*, Einstellungen, Status; rechts Glocke, Hell/Dunkel, Konto-Menü. | R/components/AppShell.tsx:699-748 | geprüft | app-rundgang |
| Seite Status | „Konten auf diesem Gerät“, „Erreichbarkeit der Quellen“. | R/routes/Whoami.tsx:46,108,155 | geprüft | app-rundgang |
| Fähigkeitsgruppen | 43 Gruppen, Verwaltung nie auf der Startseite, Module per Org-Vorgabe ausgeblendet. | M/suggestions/faehigkeiten.ts:13-60 | geprüft | was-kannst-du |
| Mehrere Konten auf einem Gerät | Getrennte Account-Spaces, nur lokale Modelle geteilt; Wechsel = Neustart. | M/account-space.ts:1-30; R/components/AppShell.tsx:1033-1195 | geprüft | konto-wechseln |
| AVA-App ohne Installation | app.ava.bi spricht mit der laufenden AVA (Desktop oder Server). | README.md:71 | geprüft (README) | ava-installieren (nur Verweis; Ast app macht ein anderer) |

#### konto

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Tab Konto, Untermenü | Profil, Plan & Abrechnung, Langzeitgedächtnis, Organisation, Deine AVAs, Verbundene Apps. | R/routes/Settings.tsx:196-203; R/routes/settings/KontoTab.tsx | geprüft | mehrere |
| Profil: Bio | bis 600 Zeichen. | R/routes/Settings.tsx:3236-3250; services/desktop/src/shared/types.ts:1684 | geprüft | profil-pflegen |
| Profil: Rolle, Branchen, Regionen, Schwerpunktthemen | Komma-Listen, wirken auf Ton, Filter, Priorisierung. | R/routes/Settings.tsx:3252-3302 | geprüft | profil-pflegen |
| Profil: Bevorzugter Ton | keine Vorgabe / Neutral / Knapp / Ausführlich. | R/routes/Settings.tsx:3304-3318 | geprüft | antwort-ton |
| Profil: Relevant auf LinkedIn | Freitext ≤ 600, erhöht Signalstärke passender Beiträge ab dem nächsten Scan. | R/routes/Settings.tsx:3320-3342 | geprüft | profil-pflegen |
| Profil zurücksetzen | leert Bio, Rolle, Listen (Bestätigung). | R/routes/Settings.tsx:3214-3232 | geprüft | profil-pflegen, eigene-daten-loeschen |
| Profil per Chat | direkte Änderung auf Wunsch, abgeleitete Änderung nur als Vorschlag. | M/agent/tools/profile.ts:50-250 | geprüft | profil-pflegen, antwort-ton |
| Profil-Beschreibungstext | Abschnittstext nennt „Agenten-Turn“ und „Lese-Kontext“. | R/routes/Settings.tsx:3236-3240 | geprüft (Befund B6) | – |
| Langzeitgedächtnis | Liste mit „vergessen“, Einträge per Chat merken/abrufen/vergessen. | R/routes/Settings.tsx:4528-4612; M/agent/tools/memory.ts:23,69,115 | geprüft | chat-gedaechtnis |
| Abschnitt Organisation | Rolle und Name, Knopf „AVA Konsole öffnen“. | R/routes/settings/KonsoleSection.tsx:12-30 | geprüft | organisation-konsole |
| Organisation per Chat | org_info (Einladungslink für Admins), org_members, org_member_approve/remove, org_features_set, org_provider_set, org_limits_set, org_usage, org_billing_info/invoices. | M/agent/tools/organisation.ts:38-500 | geprüft | organisation-konsole, mitglieder-*, funktionen-vorgaben, org-schluessel-limits |
| Konsole Navigation | Übersicht, Mitglieder, Funktionen & Vorgaben, Schlüssel, Limits & Verbrauch (alle Org-Mitglieder); Anmeldung, Agenten-Zugang, Abrechnung, Instanzen (Admin); Meine AVA, Was AVA kann (alle). | ava-admin/src/components/konsole/navigation.tsx:14-24 | geprüft | organisation-konsole |
| Konsole Übersicht: Einladungslink | Link anzeigen, neu erzeugen (alter sofort ungültig). | K/page.tsx | geprüft | mitglieder-einladen |
| Konsole Mitglieder: Anfragen | Aufnehmen/Ablehnen, im Sitz-Modell mit Sitzwahl. | K/mitglieder/page.tsx:60-80 | geprüft | mitglieder-einladen |
| Konsole Mitglieder: Rollen, Entfernen | Rollen nur Owner, Entfernen Admin; Plan-Spalte im Sitz-Modell. | K/mitglieder/page.tsx:85-215 | geprüft | mitglieder-verwalten |
| Organisation verlassen | Konsole, letzter Owner gesperrt; nicht per Chat. | K/mitglieder/page.tsx:217-249; M/agent/tools/organisation.ts:13-14 | geprüft | organisation-verlassen |
| Funktionen & Vorgaben | 21 Schalter (ORG_FEATURES), Relevanz-Unterschalter, KI-Vorgaben (Chat-Modell, Hintergrund, Deep Research), Anbieter-Sperre, Prompt-Audit, Aufbewahrung Personen; Übernahme ≤ 10 Min. | K/vorgaben/page.tsx:31-205; services/desktop/src/shared/types.ts:60-86 | geprüft | funktionen-vorgaben, personen-aufbewahrung |
| Konsole Schlüssel | Organisationsschlüssel verschlüsselt (Frankfurt), nicht wieder anzeigbar, Azure-Variante, ChatGPT-Abo erlauben. | K/schluessel/page.tsx:27-160 | geprüft | org-schluessel-limits |
| Konsole Limits & Verbrauch | Monatsbudget Org oder Tagesbudget je Mitglied, Split Chat/Hintergrund, harter Stopp; nur Org-Schlüssel, USD-Schätzung. | K/verbrauch/page.tsx:24-127 | geprüft | org-schluessel-limits |
| Konsole Anmeldung (Microsoft Entra) | App-Registrierung, Client-Geheimnis, Anmeldelinks; nur Admin. | K/anmeldung/page.tsx:43-171 | geprüft | org-microsoft-anmeldung |
| Konsole Agenten-Zugang (Copilot Studio, A2A) | Client-ID/Geheimnis für externe Agenten; nur Admin. | K/agenten/page.tsx:66-151 | geprüft | – (Ast verbindungen, fragen.md Ü1) |
| Konsole Instanzen | Wo die AVAs der Mitglieder laufen, nur Betriebsdaten; Server-Instanz stellt der Betrieb bereit. | K/instanzen/page.tsx:23-110 | geprüft | ava-umzug, chats-mitlesen |
| Konsole Meine AVA | eigene Instanzen, Anleitung „AVA in Claude oder ChatGPT verbinden“. | K/meine-ava/page.tsx:15-47 | geprüft | verbundene-apps |
| Konsole Was AVA kann | Funktionsübersicht für alle. | K/funktionen/page.tsx | geprüft | – |
| Konsole Abrechnung | Sitze (Sitz-Modell) oder Sammelabrechnung; nur Admin, Aktivieren nur Owner. | K/abrechnung/page.tsx:25-230; K/abrechnung/sitze.tsx | geprüft | organisation-zahlt |
| Konsole Betreiber-Seiten | Bestand, Verarbeitungskosten, Vorabanalyse, Stammdaten, Aktive Nutzer, Problemmeldungen. | ava-admin/src/components/konsole/navigation.tsx:27-32 | betreiber | keine Karte |
| Deine AVAs | Instanzliste, wer Telegram/Radar/MCP übernimmt (Server vor Rechner), Schalter „Dieses Gerät darf Anfragen aus Claude und ChatGPT beantworten“, Umzug holen/senden. | R/routes/settings/InstanzenSection.tsx:104-182; M/agent/tools/instanzen.ts:21,53; M/agent/tools/umzug.ts:18-30 | geprüft | ava-umzug |
| Verbundene Apps | OAuth-Freigaben mit Datum, „Trennen“; Hinweis wenn Org-Schalter aus. | R/routes/settings/VerbindungenSection.tsx:19-85 | geprüft (Hinweistext mit Jargon, Befund B6) | verbundene-apps |
| Konto-Menü | Name, E-Mail, „Tenant: …“, weitere Konten, „Anderes Konto hinzufügen …“, „Abmelden“, Kreuz = Konto samt lokalen Daten entfernen. | R/components/AppShell.tsx:1033-1195 | geprüft (Befunde B5, B7) | konto-wechseln |
| Abmelden | signOut, zurück zum Anmeldebildschirm; Account-Space bleibt. | M/auth.ts:416; R/components/AppShell.tsx:1180-1192 | geprüft | konto-wechseln |
| Zurücksetzen (Werksreset) | Löscht alles Lokale außer KI-Anbietern/Schlüsseln/Modellen, Eingabe ZURÜCKSETZEN, Neustart. | R/components/DangerZoneSection.tsx:17-130; M/ipc/system.ts:214 | geprüft | konto-loeschen, eigene-daten-loeschen |
| Konto auf dem Server löschen | Kein Weg in App, Konsole oder Gateway gefunden. | Suche „deleteAccount/Konto löschen“ ohne Treffer außer Mail-Konto | unklar | konto-loeschen (nur „AVA-Team fragen“), fragen.md F8 |
| Kontoinfo per Chat | account_info liest Konto, Tenant, weitere Konten; Wechsel nur UI. | M/agent/tools/account.ts:36-45 | geprüft | konto-wechseln |

#### abrechnung

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Schalter PRICING_TIERS | Nur mit `PRICING_TIERS=1` liefert `/v1/usage` ein `kontingent`, dann zeigt die App das Sitz-Modell; sonst die alte Seite. Produktionsstand unbekannt. | G/lib/kontingent.ts:18; G/routes/v1/sitze.ts:39; R/routes/Settings.tsx:4843-4851 | unklar | alle zustandsneutral, fragen.md F1 |
| Altes Modell: Plan-Karten | Free 0 € (25 Firmen lebenslang), Pro 49 €/Monat je Nutzer + 0,50/1,00/1,50 € je Firma im Bestand und Monat, Enterprise auf Anfrage. | R/routes/Settings.tsx:4708-4753 | geprüft (nur ohne Schalter sichtbar) | plan-ansehen (ohne Preise) |
| Altes Modell: Upgrade/Verwalten | „Upgraden“ öffnet Stripe-Kasse, „Abonnement verwalten“ das Kundenportal, Downgrade „Wechsel im Portal“. | R/routes/Settings.tsx:4853-5185 | geprüft | plan-wechseln, abo-kuendigen, rechnungen-zahlungsmittel |
| Altes Modell: Ausgabenlimit je Monat | Feld in Euro, leer = kein Limit; Seat: nur Owner/Admin; Betreiber-Vertrag: fest. | R/routes/Settings.tsx:4761-4841; M/agent/tools/abrechnung.ts:119-160 | geprüft | ausgabenlimit |
| Altes Modell: Seat über Organisation | „Dein Zugang wird über die Sammelabrechnung deiner Organisation bezahlt“, Hinweis auf eigenes Rest-Abo. | R/routes/Settings.tsx:4905-4975 | geprüft | organisation-zahlt |
| Neues Modell: Plan-Katalog | Free/Pro/Max/Ultra/Enterprise; Preise per Env (Standard 49/149/299 €), Kontingent = Preis. | G/lib/billing-plans.ts:57-100 | geprüft (Preise per Env änderbar) | plan-ansehen, plan-wechseln (ohne Preise) |
| Neues Modell: Kopfkarte | „Dein Plan“, Kontingentbalken in Euro, Firmen nach Stufe, „reicht noch für etwa … mittlere Firmen“. | R/routes/settings/PlanAbrechnungSection.tsx:200-270 | geprüft | plan-ansehen |
| Neues Modell: Plan ändern | Upgrade sofort anteilig (freier Sitz oder Kauf), Downgrade/Free zum Zyklusende, rückgängig; Mitglieder „Wechsel anfragen“. | R/routes/settings/PlanAbrechnungSection.tsx:96-172,271-325; M/agent/tools/abrechnung.ts:211-258 | geprüft | plan-wechseln, abo-kuendigen |
| Neues Modell: Ultra über das Kontingent hinaus | Monatsfreigabe mit Deckel, endet am Monatsersten; nur Owner/Admin. | R/routes/settings/PlanAbrechnungSection.tsx:329-373; M/agent/tools/abrechnung.ts:261-280 | geprüft | kontingent-erreicht |
| Neues Modell: LinkedIn-Beobachtung nach Verbrauch | Monatslimit Pflicht, Verbrauch je Funktion, Preise je 1.000; Free ohne. | R/routes/settings/PlanAbrechnungSection.tsx:375-436; M/agent/tools/abrechnung.ts:166-208; K/abrechnung/sitze.tsx:91 | geprüft | linkedin-kosten-limit |
| Neues Modell: „Rechnungen und Zahlungsmittel“, „Sitze der Organisation“ | Stripe-Portal bzw. Link in die Konsole. | R/routes/settings/PlanAbrechnungSection.tsx:262-270 | geprüft | rechnungen-zahlungsmittel, organisation-zahlt |
| Free-Plan | 25 Firmen einmalig; Ansprechpartner nur von der Website, LinkedIn-Mitarbeiter ab bezahltem Plan (beide Modelle); im Sitz-Modell max. 3 Free-Plätze je Organisation. | G/routes/v1/llm-proxy.ts:229-235,331-341; G/lib/billing-plans.ts:62-65 | geprüft (Commit 017a740a laut Notiz nicht deployt) | free-plan |
| Stufen klein/mittel/groß | klein ohne LinkedIn-Firmenprofil, mittel < 50 Personen, groß ≥ 50; Preise 50/100/150 ct per Env. | G/lib/stufen.ts:1-45; M/agent/tools/abrechnung.ts:38 | geprüft (Preise env-abhängig) | firmen-kosten-stufen |
| Zählung je Monat | Firma zählt im Monat der Aufnahme und jedem Monat, an dessen Ende sie im Bestand ist; „einmal je Organisation“ nur im alten Modell belegt. | M/agent/tools/abrechnung.ts:38 | unklar für Sitz-Modell | firmen-kosten-stufen (ohne „je Organisation“), fragen.md F3 |
| Kontingent erreicht | Banner „Kontingent aufgebraucht“ (alt) bzw. „Monatskontingent ausgeschöpft“ (neu), Teil-Import-Dialog „Nur X passende Firmen aufnehmen“. | R/components/QuotaExhaustedBanner.tsx:50-170; R/components/KontingentDialog.tsx:31-69 | geprüft | kontingent-erreicht |
| Nutzungs-Chip oben | erscheint ab 80 % Verbrauch, Klick → Plan & Abrechnung. | R/components/UsageChip.tsx:12-55 | geprüft | plan-ansehen |
| Firmen ruhen/aktivieren | Nur mit Schalter: Reiter Aktiv/Ruhend, Mond/Blitz, Vormerkung zum Monatsersten mit Tausch; Free kein Tausch. | R/routes/AllCompanies.tsx:167,407-575; R/components/AktivierenDialog.tsx; M/agent/tools/imports.ts:1521-1615; G/routes/v1/firmen-zustand.ts:1-4 | geprüft (Tooltip widerspricht, Befund B8) | firma-ruhen-aktivieren |
| Zahlung offen/pausiert | past_due: Hinweis, suspended: Importe und Radar pausiert. | R/routes/Settings.tsx:5000-5015; R/routes/settings/PlanAbrechnungSection.tsx:212-213 | geprüft | rechnungen-zahlungsmittel |
| Kündigung | Altes Modell über Kundenportal, „Kündigung vorgemerkt“, rücknehmbar; neues Modell Free zum Zyklusende. | R/routes/Settings.tsx:5017-5040; R/routes/settings/PlanAbrechnungSection.tsx:150-160 | geprüft | abo-kuendigen |
| Enterprise | ava.bi/kontakt; Konsole „Vertrag“ mit Monatslimit Hintergrundverarbeitung. | R/routes/Settings.tsx:4755; K/abrechnung/kosten.tsx:33-52 | geprüft | enterprise-anfragen |
| Abrechnung per Chat | abrechnung_status (beide Modelle), abrechnung_limit_setzen (alt), plan_wechseln/payg_freigeben (nur neu), linkedin_limit_setzen (neu). | M/agent/tools/abrechnung.ts:44-280 | geprüft | plan-ansehen, ausgabenlimit, plan-wechseln, linkedin-kosten-limit |
| Org-Abrechnung per Chat | org_billing_info, org_billing_invoices (Admin); Kopfkommentar nennt Aktivieren-Werkzeuge, die es nicht gibt. | M/agent/tools/organisation.ts:9-11,452,498 | veraltet (Kommentar) | organisation-zahlt |
| Erzwungene Neuverarbeitung | Mit Schalter jede Rolle (zählt wie Aufnahme), ohne nur Owner/Admin. | G/lib/rollen.ts:7-40 | geprüft | – (Ast firmen, fragen.md Ü2) |
| Website-Prompt Pricing | Preise Pro 49/Max 149/Ultra 299 als Website-Text. | docs/WEBSITE_PROMPT_PRICING_2026-11-02.md | unklar (Freigabe hängt am Schalter) | – |

#### datenschutz

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Lokal: Chats, Gedächtnis, Profil, ICP, Mail, Verlauf | liegen in der AVA (Account-Space), Schlüssel über Betriebssystem-Verschlüsselung. | M/account-space.ts; M/platform-electron.ts:42-44; R/routes/settings/VerlaufTab.tsx:258; README.md:138 | geprüft | daten-lokal-oder-server |
| AVA-Server Frankfurt | Firmenbestand, Verarbeitungsstand, Personen mit Herkunft, Buying Center, Relevanz-Signale, Notizen, Abrechnung, Problemmeldungen. | services/db-gateway/prisma/schema.prisma (BuyingCenter, RelevanzSignal, CompanyNotiz, ProblemMeldung); services/db-gateway/fly.toml:9 (fra) | geprüft | daten-lokal-oder-server |
| Compliance-Website-Text „bleibt immer lokal“ | nennt Relevanz/Notizen nicht, behauptet Rechenarbeit vollständig lokal und Art.-14/Löschung „in Arbeit“. | docs/WEBSITE_PROMPT_COMPLIANCE.md:20-60 | veraltet (Befund B1) | – |
| KI: lokal / eigener Schlüssel / Abo / Org-Schlüssel | Datenfluss je Weg; Org-Schlüssel über Gateway, Inhalte nur mit Prompt-Audit. | K/schluessel/page.tsx:27-33; docs/WEBSITE_PROMPT_COMPLIANCE.md §5 | geprüft | ki-anbieter-daten, chats-mitlesen |
| Firmenverarbeitung über Betreiber-Modell | Pool-Producer (website, profile, contact, email, publication, structured-content) nutzen die Betreiber-Spur (Standard gpt-6-luna), sofern verfügbar. | services/desktop/src/core/bootstrap.ts:555,597; M/producer-supervisor.ts:744-790 | geprüft (Anbieter-Nennung offen, fragen.md F5) | ki-anbieter-daten |
| Prompt-Audit | Sichtbar für Mitglieder unter Vorgaben. | K/vorgaben/page.tsx:40,185-186 | geprüft | chats-mitlesen |
| Relevanz-Signale | getrennt je Mitglied, „Gerade Thema“ nur Anzahl ab zwei in Orgs ab drei. | K/vorgaben/page.tsx:116-131 | geprüft | chats-mitlesen |
| Herkunftsnachweis (Art. 15) | Tabelle Zeitpunkt/Feld/Wert/Quelle/Beleg/Lauf/erhoben von, Kopieren; Chat als Markdown-Bericht. | R/routes/CompanyDetail.tsx:2177-2195,2598-2660; M/agent/tools/companies.ts:1320-1337; G/lib/person-compliance.ts:210-330 | geprüft | kontakt-herkunftsnachweis |
| Art.-14-Hinweis, „als informiert markieren“ | Text mit Quelle, Zweck, Speicherdauer, Rechten, Kontakt; Vermerk „Art. 14 informiert am“. | R/routes/CompanyDetail.tsx:2196-2215,2610-2630; M/agent/tools/companies.ts:1340-1368 | geprüft | kontakt-art14-hinweis |
| Person löschen (Art. 17) | global, Sperre gegen Wiedererfassung, Buying-Center-Einträge weg, Audit; nur erhebende Organisation. | G/routes/v1/persons.ts:157-205; M/agent/tools/companies.ts:1370-1395 | geprüft (UI nutzt window.confirm, Befund B5) | person-loeschen |
| Aufbewahrung Personen | täglich, Standard 180 Tage ohne Beobachtung, je Org einstellbar, kleinster Wert gilt. | G/lib/person-retention-reaper.ts:1-30; K/vorgaben/page.tsx:195-199 | geprüft | personen-aufbewahrung |
| Beschäftigungen verfallen nach 120 Tagen | Konsole und Website-Text behaupten es; Code dafür nicht gefunden. | K/vorgaben/page.tsx:196; docs/WEBSITE_PROMPT_COMPLIANCE.md:72 | unklar | – (fragen.md F6) |
| Chats löschen | per Chat oder Verlaufsauswahl, dauerhaft. | M/agent/tools/chat-history.ts:146-175 | geprüft | eigene-daten-loeschen |
| Datenexport eigener Daten | Nur Verlauf als JSON und Support-Hinweise; kein Gesamtexport. | R/routes/settings/VerlaufTab.tsx:197,383; Suche ohne Treffer | geprüft (fehlt) | eigene-daten-loeschen, fragen.md F8 |
| Verlauf (Audit lokal) | Zeitraum, Suche, Kategorie, Schwere; JSON-Export, leeren nur lokal. | R/routes/settings/VerlaufTab.tsx:74-460 | geprüft | verlauf-ansehen |
| Audit auf dem Server | AuditLog für sicherheits-/kostenrelevante Aktionen (z. B. Person löschen); für Nutzer nicht einsehbar. | G/routes/v1/persons.ts:190-198; README.md:84 | geprüft | verlauf-ansehen |
| Hinweise für den Support | lokale Liste der Selbstkorrekturen, Export/Löschen. | R/routes/settings/VerlaufTab.tsx:608-640 | geprüft (Jargon, Befund B6) | – (Ast hilfe) |
| Problem melden: Datenumfang | Beschreibung, Dateien (≤ 5 MB), Protokolle, Versionen, Plan, Aufgaben; maskiert; Haken Bildschirmfoto (Standard an) und Chat-Auszug; 90 Tage; Mail-Weg. | R/components/ProblemMeldenDialog.tsx:95-210; M/agent/tools/problem.ts:58; docs/WEBSITE_PROMPT_PROBLEM_MELDEN_2026-11-02.md | geprüft | problem-melden-daten |
| LinkedIn-Transparenz | eigenes Konto, Einverständnis, Bildanalyse lokal Standard. | docs/WEBSITE_PROMPT_COMPLIANCE.md §4 | unklar (Ast linkedin) | – (Kurzverweis in daten-lokal-oder-server) |
| Kontaktdaten firmengebunden | E-Mail/Telefon/Position nur bei der Firma, wo gefunden. | README.md:59 | geprüft (README) | – (Ast kontakte) |
| Hintergrund-Browser gehärtet | keine Downloads außer Registerdateien. | README.md:139 | geprüft (README) | – |
| MCP-Daten an Fremdanbieter | Daten gehen an das Modell des Clients; Org-Hauptschalter Standard aus. | services/desktop/src/shared/types.ts:79 | geprüft | verbundene-apps |

### Inventar Ast `firmen`

Quellen relativ zu `services/desktop/src/` (R = renderer/src, T = main/agent/tools), Gateway = `services/db-gateway/src/`. Stand 2026-11-07, Lesestand main (7335a568).

#### 1. Firmen suchen

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Seite Firmensuche (/companies) | Unscharfe Suche über ~10,5 Mio. Firmen aus 6 Ländern nach Name, Ort, Registernummer; ohne Suchbegriff keine Liste. | R/routes/Companies.tsx:130-180; R/components/AppShell.tsx:714 | geprüft | firma-suchen |
| Länderfilter Firmensuche | Filter DE/AT/CH/UK/NO/FI. | R/routes/Companies.tsx:150; R/components/RegisterStatusBadge.tsx:104-118 | geprüft | firmen-filtern |
| Gründungsjahr-Filter + Sortierung | von/bis, „Älteste/Jüngste zuerst“; nur Firmen mit abgerufenem Registerinhalt, Name dann wörtlich. | R/components/GruendungsjahrFilter.tsx:45-89; R/routes/Companies.tsx:160-166 | geprüft | firmen-filtern |
| Chat-Suche (company_search) | Unscharf, mit Gründungsjahr; KEIN Länderfilter im Chat (anders als UI und MCP firma_suchen). | T/companies.ts:79-147; Gateway routes/mcp.ts:74 | geprüft (Befund) | firma-suchen, firmen-filtern |
| Suche nach Registernummer | Firmensuche nimmt Registernummer; Kennungen je Land (HRB, FN, CHE, CRN, Org.nr., Y-Tunnus). | R/routes/Companies.tsx:143; RegisterStatusBadge.tsx:84-95 | geprüft | firma-per-registernummer |
| Import per Firmen-ID (companyIds) | Eindeutig, jedes Land, ohne Vorschau. | T/imports.ts:712-760 | geprüft | firma-per-registernummer |
| Firma nicht gefunden: Live-Suche Handelsregister | handelsregister.de mit Browser der AVA, 30-90 s, nur DE, Sperre → in einer Stunde erneut. | T/register-delta.ts:123-170; prompts.ts:391-395 | geprüft | firma-nicht-gefunden |
| Firma ohne Register (firma_finden) | Google-Eintrag + Website-Gate + KI-Urteil ≥ 0,8, ID = Domain, keine Register-/Abschlussstufen, nur 6 Länder. | T/firma-finden.ts:1-140; README Was AVA heute kann | geprüft | firma-ohne-registereintrag, firma-nicht-gefunden |
| Firmen anderer Länder | Nicht im Bestand und nicht aufnehmbar (firma_finden nur DE..FI). | R/routes/Companies.tsx:206; T/firma-finden.ts:124 | geprüft | laender-uebersicht |
| Firmenlink im Chat | Firmen als company:-Link, Klick öffnet Firmenseite; Vorschau ohne Links; Personen nie verlinkt. | main/agent/prompts.ts:108-130; T/app-oeffnen.ts (ziel firma) | geprüft | firmenlink-im-chat |
| Bestandssuche (bestand_suchen) | „Welche meiner Firmen bieten/nutzen X“ mit Belegen. | T/companies.ts:981 | geprüft, Querverweis recherche | firmen-filtern (nur Hinweis) |

#### 2. Meine Firmen (/alle-firmen)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Seite Meine Firmen | Alle eigenen Firmen über alle Vorgänge, Matrix Struktur/Publikation/Website/Profil/Kontakt/E-Mail, Zustände wartet/läuft/fertig/fehlgeschlagen/übersprungen/Zeitüberschreitung. | R/routes/AllCompanies.tsx:110-140, 352-560 | geprüft | meine-firmen-liste |
| Spalte „Zuletzt verarbeitet“ | Jüngster Stufen-Zeitstempel inkl. Auffrischung. | R/routes/AllCompanies.tsx:481, 800-812 | geprüft | meine-firmen-liste, daten-aktualitaet |
| Suchfeld, Land-, Fokus-Thema-, Zustandsfilter | Fokus-Filter nur mit angelegten Themen, Zustand nur mit Aktiv-Modell. | R/routes/AllCompanies.tsx:368-430 | geprüft | firmen-filtern |
| Seitenpanel je Firma | Verlauf der Schritte, Fehler, „Erneut versuchen“, „Firma komplett neu verarbeiten“, Diagnose. | R/routes/AllCompanies.tsx:648-830; R/components/RetryStageForm.tsx | geprüft | meine-firmen-liste, schritt-wiederholen |
| Verarbeitung je Firma aussetzen (Pause/Play) | Keine Wiederanläufe; Retry blockiert solange. | R/routes/AllCompanies.tsx:250-265, 575-605; RetryStageForm.tsx:23 | geprüft | verarbeitung-pausieren |
| „Verarbeitung pausieren“ global + Feed „Verarbeitung“ | Pausiert alle Verarbeitung auf dem Rechner; Import aus dem Chat dann gesperrt. | R/components/ProcessingToggle.tsx:34-48; ProcessingFeedPanel.tsx:122-181; T/imports.ts:249 | geprüft | verarbeitung-pausieren |
| Papierkorb „Aus der Liste entfernen“ | Echtes Entfernen aus eigener Sicht, leere Vorgänge verschwinden, Bestand bleibt; Abrechnung ab Folgemonat; nur in der UI, kein Chat-Werkzeug. | R/routes/AllCompanies.tsx:267-292, 607-617; T/abrechnung.ts:113 | geprüft (Befund) | firma-entfernen |
| Aktiv/Ruhend (Mond/Blitz), Vormerkung Monatswechsel | Nur sichtbar mit Aktiv-Modell (Pricing-Tiers). | R/routes/AllCompanies.tsx:160-200, 515-575; T/imports.ts:1522-1630 | unklar (Schalter PRICING_TIERS) | firma-entfernen (Querverweis), Rest abrechnung |
| CRM-Badges je Zeile | Zeigt verknüpfte CRM-Einträge. | R/routes/AllCompanies.tsx:300-318 | geprüft, Querverweis verbindungen | keine |

#### 3. Firma aufnehmen / importieren

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Excel/CSV im Chat (import_excel) | xlsx/xls/csv/tsv, Spaltenzuordnung bestätigen, Vorschau, ein Vorgang; Datei 30 Min. vorgehalten; ordnet nur gegen DE zu. | T/imports.ts:174-300; main/agent/attachment-store.ts:52; Gateway routes/v1/schemas.ts:440-456 | geprüft | excel-liste-importieren |
| Seite Importieren (/ingest) | Nur .xlsx, Spalten Firmenname + Stadt Pflicht, Vorgangsname, Fuzzy-Match; Kontingent-Hinweis. | R/routes/Ingest.tsx:46-195 | geprüft | excel-liste-importieren |
| Eingefügte Liste / Namen (import_companies) | Ein Vorgang, Dry-Run mit Excel-Bericht in Downloads, Ort Pflicht (sonst Hauptsitz), Land für Nicht-DE. | T/imports.ts:712-1040; prompts.ts:713-760 | geprüft | firmenliste-einfuegen |
| Zuordnungskarte (resolve_import_matches) | Eine Karte, „bester Treffer“, „Top-Vorschlag überall“, „Alle überspringen“, „Filtern…“, „Auswahl übernehmen“. | T/imports.ts:1050-1300; R/routes/Chat.tsx:2618-2830 | geprüft | import-treffer-zuordnen |
| Einzelne Firma: Knopf „Übernehmen und verarbeiten“ / „Neu verarbeiten“ | Auf der Firmenseite; danach „Fortschritt ansehen“, „in Meine Firmen“; voll → ruhend. | R/routes/firma-uebernehmen.tsx:77-183 | geprüft | firma-einzeln-aufnehmen |
| Automatische Aufnahme bei Firmenfrage | stand fehlt → sofort aufnehmen, unvollständig → Schritt nachholen. | T/companies.ts:1099-1160; prompts.ts:449-456 | geprüft | firma-einzeln-aufnehmen, daten-fehlen-bei-firma |
| Import aus CRM (import_companies_from_crm) | HubSpot (Firmen) und Close (Leads), max. 5.000, ohne Ort übersprungen; Salesforce/Dynamics nicht. | T/imports.ts:508-700; main/crm/fetch-companies.ts:40-66 | geprüft | crm-firmen-uebernehmen |
| Import aus Radar | Radar-Kandidaten übernehmen. | README; faehigkeiten.ts:28 | geprüft, Querverweis radar | firma-einzeln-aufnehmen (Hinweis) |
| Import aus Referenzen/Töchtern | Knopf „Übernehmen“ im Reiter Referenzen & Partner und im Konzern-Panel. | R/components/KundenTab.tsx; VerflechtungenTab.tsx:289-336 | geprüft | kunden-referenzen, konzern-toechter |
| Fortschritt (import_status, Aufgaben-Leiste) | „x von y Firmen fertig“, 15 Min. „keine Bewegung“, „Nicht mehr verfolgen“, Selbstmeldung bei Abschluss; übersprungen ≠ Fehler. | T/imports.ts:371-505; R/components/AufgabenLeiste.tsx:73-107; T/aufgaben.ts | geprüft | import-fortschritt |
| Hänger: Zeitüberschreitung 30 Min., Abbruch 60 Min., 5 Auto-Versuche | Stillstand erkennen und neu anstoßen. | R/routes/AllCompanies.tsx:73-80; TransactionDetail.tsx:600-620; prompts.ts:745-755 | geprüft | import-haengt |
| Kontingent beim Import | Über Kontingent → Rest ruhend bzw. „Kontingent überschritten“. | prompts.ts:524-543; R/routes/Ingest.tsx:186-193 | geprüft, Querverweis abrechnung | firma-einzeln-aufnehmen, firmenliste-einfuegen |

#### 4. Firmenseite (/companies/:id)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Kopf: Chips, Registerzeile, Kacheln, Schlagworte, Wärmeanzeige | Standort, Register, Gegründet, Mitarbeiter, Website, Social Media. | R/routes/CompanyDetail.tsx:710-840 | geprüft | firmenseite-reiter |
| Reiter-Logik | Reiter nur mit Daten; Finanzen aus für AT/CH/NO/FI; Verflechtungen nur DE-Register + Modul; Kontakte/Buying Center modulabhängig; ruhend = nur Steckbrief. | R/routes/CompanyDetail.tsx:95-107, 560-690, 850-880 | geprüft | reiter-fehlt-auf-firmenseite |
| Übersicht (Firmenprofil, Kontakt & Standort, Bewertung) | Geschäftszweck, Gründungsjahr, Stammkapital, Rechtsform, Branche, Adresse, Telefon, Website. | R/routes/CompanyDetail.tsx:1230-1380 | geprüft | firmenseite-reiter |
| Finanzen (Jahresübersicht, Jahresberichte, KPIs) | Umsatz/Bilanzsumme-Kacheln bewusst ausgeblendet; Mitarbeiterzahl deterministisch. | R/routes/CompanyDetail.tsx:1400-1590 | geprüft | jahresabschluss-lesen, kennzahlen-fehlen |
| publication_search / company_publications | Volltext über Abschlussblöcke, kompakt/voll, Konzern = Muttergesellschaft. | T/publications.ts:126-150; T/companies.ts:505-548 | geprüft | jahresabschluss-lesen, kennzahlen-fehlen |
| Konzern (KonzernBadge, Panel „Laut Konzernabschluss“, Bereich konzern) | Töchter, Mutter, Stand Abschlussjahr; Panel nur im Reiter Verflechtungen. | R/routes/CompanyDetail.tsx:273-283; R/components/VerflechtungenTab.tsx:296-360; T/companies.ts:883-900 | geprüft (Befund) | konzern-toechter |
| Geschäftsführung | Register (DE), Directors (UK), Rollen (NO); AT/CH/FI keine Personen; Fallback Website. | CompanyDetail.tsx:678; packages/register-delta/src/no-brreg.ts:33; docs PLAN_UK §4a, PLAN_SCHWEIZ §6, PLAN_OESTERREICH §3 | geprüft (AT aus Plan) | geschaeftsfuehrung |
| Kontakte (Reiter) | Personen mit Beleg; Modul kontakte. | CompanyDetail.tsx:1717ff | Querverweis kontakte | daten-fehlen-bei-firma (kurz) |
| Erkenntnisse | Branche, Firmenalter, Unternehmensgegenstand, aktuelle Finanzen. | CompanyDetail.tsx:2090-2140 | geprüft | firmenseite-reiter |
| Stellenanzeigen | „Was die Firma Beschäftigten bietet“, je Anzeige Anforderungen, Leistungen, Technologien. | CompanyDetail.tsx:3160-3250; T/companies.ts:920 | geprüft | stellenanzeigen-firma |
| Expansion & Ausschreibungen | Expansion, Ausschreibung, Beschaffung mit Quelle; gezielte Suche kostenlos über Betreiber-Spur. | CompanyDetail.tsx:1080; T/companies.ts:951; prompts.ts:790-797 | geprüft | recherche-ausschreibungen |
| Verflechtungen (Gesellschafter, Netz, tiefer verfolgen) | Nur DE HRB/HRA, Modul verflechtungen, Tiefe 6/200 Firmen, Notbremse, Bild-Modell. | R/components/VerflechtungenTab.tsx:371-520; T/companies.ts:150-250; faehigkeiten.ts:18 | geprüft | gesellschafter, verflechtungen-netz |
| Referenzen & Partner + Umkehrsuche | Kategorien, sicher/unsicher, gemeinsame Kunden; Umkehrsuche nur über eigene Firmen. | R/components/KundenTab.tsx:19-130; T/companies.ts:288-440 | geprüft | kunden-referenzen, wer-nennt-als-kunden |
| Mein Fokus (Fokus-Themen-Befund) | Gefunden/Unklar/Nicht gefunden, „Jetzt prüfen“. | CompanyDetail.tsx:993-1060 | Querverweis recherche | firmenseite-reiter (nur genannt) |
| Buying Center | Erst nach Anlage. | CompanyDetail.tsx:578-584 | Querverweis kontakte | reiter-fehlt-auf-firmenseite |
| Tech-Stack (nur Chat) | Systeme aus Datenschutzerklärung, Kategorien, nur Nennung, kein Beleg für Einsatz. | T/companies.ts:581-645 | geprüft | tech-stack |
| Datenqualität (nur Chat) | Modell und Stufe je Schritt; schwächere Modelle überschreiben nichts. | T/companies.ts:670-712; prompts.ts:457-460; README Persist-Bus | geprüft | datenqualitaet |
| Falsche Website zugeordnet | Kein Weg, Website von Hand zu setzen/verwerfen; nur neu verarbeiten bzw. Problem melden. | docs PLAN_WEBSITE_ZUORDNUNG §4-5 (W5 nicht in der UI gefunden); T/imports.ts:1302ff | unklar | falsche-website |
| Ruhend-Hinweis „Diese Firma ruht bei dir“ + „Aktivieren“ | Nur Grunddaten. | CompanyDetail.tsx:855-870 | unklar (Aktiv-Modell) | reiter-fehlt-auf-firmenseite, daten-fehlen-bei-firma |

#### 5. Firmenstatus, Insolvenz, Länder

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Chips gelöscht / in Löschung / insolvent / Insolvenzantrag / Insolvenzverfahren / abgewiesen / beendet | Überall, mit Tooltip und Datum. | R/components/RegisterStatusBadge.tsx:5-60 | geprüft | firmenstatus-chips |
| Insolvenz-Abschnitt + „Jetzt prüfen“ | Quelle je Land, AT ohne Knopf. | R/components/InsolvenzAbschnitt.tsx:24-80; T/companies.ts:256-285 | geprüft (Befund UK) | insolvenz-pruefen |
| Deutschland | Vollständig (Register, Abschlüsse, Gesellschafter, Insolvenzportal). | README Länder; T/publications.ts | geprüft | laender-uebersicht |
| Österreich | Firmenbuch FN, keine Personen (kostenpflichtiger Auszug), keine Abschlüsse, Ediktsdatei monatlich. | docs PLAN_OESTERREICH §1, §3, §4b; CompanyDetail.tsx:562; InsolvenzAbschnitt.tsx:25 | geprüft | firmen-oesterreich |
| Schweiz | UID CHE, Zweck/Kapital/Gründung, keine Personen, keine Abschlüsse, SHAB täglich, keine Live-Suche. | docs PLAN_SCHWEIZ §6 | geprüft | firmen-schweiz |
| Vereinigtes Königreich | CRN, Directors, SIC, Insolvenz Companies House/Gazette; keine Abschlüsse (aus README-Quellenliste geschlossen). | docs PLAN_UK §4a; T/companies.ts:262 | unklar (Abschlüsse) | firmen-uk |
| Norwegen / Finnland | Org.nr./Y-Tunnus, NO Rollen, FI keine Personen, keine Abschlüsse. | docs PLAN_SKANDINAVIEN §2-4; no-brreg.ts:33 | geprüft (Erstabzug-Stand unklar) | firmen-norwegen-finnland |
| Land beim Namensimport | Nicht-DE-Namenszeilen brauchen country, sonst DE-Register. | T/imports.ts:740-760; shared/register-land.ts | geprüft | firmenliste-einfuegen, Länderkarten |
| README „Länder“ | Nennt nur DE/AT/CH/UK, nicht NO/FI. | README.md Abschnitt Was AVA heute kann | veraltet | – |

#### 6. Verarbeitung, Aktualität

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Schritte der Verarbeitung | Struktur, Publikation, Website, Profil, Kontakt, E-Mail; lokal in der AVA; geteilte Daten → übersprungen. | R/routes/AllCompanies.tsx:110-128; README; producer-resume.ts:1-15 | geprüft | verarbeitung-schritte |
| README „Fünf Producer“ | Matrix zeigt sechs Schritte (E-Mail zusätzlich). | README.md; AllCompanies.tsx:110 | veraltet | – |
| Dauer | Einige Minuten je Firma, große Listen Stunden; App zu = Pause, Fortsetzen beim Start. | T/imports.ts:1480; Gateway routes/mcp.ts:149; producer-resume.ts | geprüft | verarbeitung-dauer |
| retry_stage / „Schritt erneut starten“ | Kostenlos, respektiert Frische; „neu gestartet“ ≠ fertig; 5 Auto-Versuche. | T/imports.ts:1302-1470; RetryStageForm.tsx:49-170; TransactionDetail.tsx:603 | geprüft | schritt-wiederholen |
| firma_neu_verarbeiten / „Firma komplett neu verarbeiten“ | Alle Schritte erzwungen, zählt im Kontingent, mit Rückfrage. | T/imports.ts:1477-1520; RetryStageForm.tsx:205-237; firma-uebernehmen.tsx:84 | geprüft | firma-neu-verarbeiten |
| Auffrischung (Takte) | Website/Profil/Kontakte 14 Tage, Register/Abschlüsse 30 Tage; Relevanz-Faktor; Fehlversuch 24 h Pause; ruhend nie; Nutzer kann Takt nicht ändern. | main/agent/freshness-prefs-store.ts:21-47; freshness-scheduler.ts:43-70, 416; prompts.ts:550-553 | geprüft | daten-aktualitaet |
| PLAN_AUFFRISCHUNG Takte 7 Tage | Code sagt 14 Tage. | docs/PLAN_AUFFRISCHUNG.md:23 | veraltet | – |
| freshness_scan / run_now / pin / unpin | Anstehendes zeigen, Runde starten (5 je Runde, gedrosselt), priorisieren (×10), zurücknehmen. | T/freshness.ts:36-150 | geprüft | daten-aktualitaet, firma-priorisieren |
| Einstellungen → Erweitert → Wiederkehrende Aufgaben | Zeitpläne/Mail-Aufgaben, nicht die Auffrischung. | R/routes/settings/SchedulerSection.tsx | Querverweis chat/workflows | keine |
| Einstellungen → Recherche → Stammdaten mitpflegen | Register-Jobs auf dem Rechner (Opt-in, Org-Modul). | R/routes/settings/MithelfenSection.tsx:59-126; faehigkeiten.ts:62 | geprüft, kein Ast zugeteilt | keine (siehe fragen.md) |
| PLAN_FIRMEN_UX B2 „Löschen löscht nichts“ | Seit Gateway-Löschung echt entfernt. | docs/PLAN_FIRMEN_UX.md B2; AllCompanies.tsx:267 | veraltet | – |

#### 7. Vorgänge und Teilen

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Seite Vorgänge (/transactions) | Liste mit Name, Gestartet, Firmen, Live; „geteilt“; Abschnitt „Aus der Organisation“. | R/routes/Transactions.tsx:40-140; AppShell.tsx:700-707 | geprüft | vorgaenge-seite |
| Vorgang-Detail | Matrix je Firma/Schritt, Tooltip mit Wiederholungsplan, Seitenpanel, Diagnose. | R/routes/TransactionDetail.tsx:300-560 | geprüft | vorgaenge-seite |
| Roh-Eventprotokoll (/transactions/:id/stream) | Live-Ereignisse. | R/routes/TransactionStream.tsx | geprüft | vorgaenge-seite |
| Teilen / Freigabe zurücknehmen | Ganze Organisation, Notiz, Kopien bleiben. | T/transactions.ts:196-243; TransactionDetail.tsx:700-750 | geprüft | vorgang-teilen |
| Übernehmen (adopt) | Eigene Kopie mit Fortschritt, nichts neu verarbeitet; UI ohne Rückfrage, Chat mit Rückfrage. | T/transactions.ts:245-275; TransactionDetail.tsx:725-752 | geprüft (Kontingent unklar) | vorgang-uebernehmen |
| Radar/Workflow teilen | radar_share, workflow_share. | faehigkeiten.ts:22 | Querverweis radar/workflows | vorgang-teilen (Hinweis) |

#### 8. Betreiber / nicht für Karten

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Einzelschritt erzwingen trotz Frische | Nur Betreiber. | T/imports.ts:1318; prompts.ts:801 | betreiber, keine Karte | – |
| Takte/Drossel der Auffrischung | Steuert und bezahlt der Betreiber. | freshness-prefs-store.ts:21-24 | betreiber, keine Karte | – |
| Register-Erstabzüge AT/CH/UK/NO/FI, Zefix-Konto | Betreiber-Worker. | docs PLAN_SCHWEIZ §6, PLAN_SKANDINAVIEN N5 | betreiber, keine Karte | – |
| Vorabanalyse CRM-Liste | Betreiber-Konsole. | README Organisationen | betreiber, keine Karte | – |
| producers_status / producers_logs_tail / Diagnose-Logs | Technische Diagnose (verwaltung: true). | T/producers.ts; faehigkeiten.ts:63 | geprüft, keine Karte (System) | – |

### Inventar Äste kontakte, radar, recherche (Stand 2026-11-07, Lesestand main)

Pfadkürzel: R = services/desktop/src/renderer/src, M = services/desktop/src/main, T = M/agent/tools, G = services/db-gateway/src.

#### kontakte

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Reiter „Kontakte“ in der Firmenansicht | Firmen-Telefon/E-Mail/Adresse plus „Zugeordnete Personen“; Reiter nur mit Daten und bei Feature `kontakte`. | R/routes/CompanyDetail.tsx:99, 474, 1834-1930 | geprüft | kontakte-einer-firma |
| Sortierung nach Rolle (Geschäftsleitung, Leitung, Vertrieb und Einkauf, Weitere) | Wichtigste Personen oben, Rang aus dem Titel für alle Quellen. | R/routes/kontakt-rang.ts:20-45 | geprüft | kontakte-einer-firma |
| Kontaktsuche (ab 6 Personen) | Unscharfe Suche über Name, Position, Abteilung, Kontaktdaten, Herkunft, Rolle; Umlaut-Faltung, Teilfolge. | R/routes/kontakt-suche.ts; CompanyDetail.tsx:1869-1900 | geprüft | kontakte-einer-firma |
| Herkunftsangabe an der Personenkarte (LinkedIn/Firmenwebsite/Websuche/Datenschutzerklärung) | Erste Frage bei falschen Kontakten beantwortbar; „Firmenwebsite“ verlinkt die Belegseite. | R/routes/kontakt-quellen.ts:20-80; CompanyDetail.tsx:2408-2432 | geprüft | kontakt-herkunft, kontakte-passen-nicht |
| „Quelle“-Link und Zuverlässigkeit in % je Angabe | Belegseite je Telefon/E-Mail/Adresse; Prozent aus Beleglage. | CompanyDetail.tsx:2540-2590, 2783 | geprüft | kontakt-herkunft |
| Herkunftsnachweis (Art. 15) | Alle Angaben mit Quelle, Beleg, Zeitpunkt, kopierbar; auch per Chat. | CompanyDetail.tsx:2180-2195, 2600-2612; T/companies.ts:1321 | geprüft | kontakt-herkunft |
| „Frühere Angaben“ | Ersetzte/nicht mehr gefundene Werte einsehbar (ohne deaktivierte Ableitungen). | CompanyDetail.tsx:2310-2316, 2680-2702 | geprüft | kontakt-herkunft |
| Art.-14-Hinweis kopieren / als informiert markieren | Vorformulierter Hinweistext, Vermerk „Art. 14 informiert am“ je Organisation. | CompanyDetail.tsx:2196-2220, 2436-2444, 2614-2632; T/companies.ts:1341-1370 | geprüft | kontakt-art14-hinweis |
| Person löschen (Art. 17) | Global für alle Organisationen, Sperre gegen Wiedererfassung, nicht umkehrbar. | CompanyDetail.tsx:2221-2236; T/companies.ts:1372-1395 | geprüft (Einschränkung „nur erhebende Organisation“ nur laut Werkzeugbeschreibung) | person-loeschen |
| Mailen/Anrufen/Profil öffnen an der Karte | Schnellaktionen; LinkedIn/XING als Icons. | CompanyDetail.tsx:2446-2500 | geprüft | kontakte-einer-firma |
| Auf Personen-Watchlist (Augen-Icon) | Nur bei LinkedIn-/in/-Profil; Watchlist gehört Ast linkedin. | CompanyDetail.tsx:2500-2525 | geprüft | linkedin-profil-finden (Verweis) |
| Kontakte neu suchen (Schritt wiederholen / Firma neu verarbeiten) | Fehlende Schritte kostenlos, Neuverarbeitung zählt als weitere Aufnahme. | T/imports.ts:1302, 1477-1483 | geprüft | kontakte-passen-nicht |
| Free-Plan: Ansprechpartner nur von der Website | LinkedIn-Mitarbeiter ab Pro. | G/lib/billing-plans.ts:74 | geprüft | kontakte-passen-nicht |
| Dubletten zusammenführen (wöchentlich, sofort per Chat, Liste, Rücknahme) | Sichere Paare automatisch, „nur Vorname“ per KI-Urteil; Rücknahme stellt beide wieder her; keine eigene Oberfläche. | M/contacts/personen-abgleich.ts:1-45; T/personen-zusammenfuehren.ts | geprüft | dubletten-zusammenfuehren |
| LinkedIn-Profil eines Kontakts suchen | Websuche, Namens-Plausibilität, Auswahl bei mehreren, nichts raten; Speichern mit Rückfrage. | T/companies.ts:1189-1318 | geprüft | linkedin-profil-finden |
| LinkedIn-Profil-Prüfung lokal / Datendienst | Arbeitgeberwechsel bei Kontakt-Auffrischung; Statistik in Erweitert → Dienste auf diesem Rechner. | R/routes/settings/ProfilPruefungSection.tsx; ErweitertTab.tsx:35 | geprüft (Takt der Auffrischung nicht im UI) | linkedin-profil-pruefung |
| Einstellungen → Recherche → E-Mail-Adressen | Ableitung an/aus, Zuordnung mit KI-Urteil, unverifizierte anzeigen, Verifizierungsrate (Standard 300, 10 bis 3600). | R/routes/settings/EmailMusterSection.tsx; T/email-muster.ts:46-78 | geprüft (Feature-Gating `kontakte` für den Abschnitt unklar) | email-adressen-ableiten |
| E-Mail-Vorschau je Firma (Trockenlauf) | Muster und Kandidaten ohne Netzverkehr, nichts gespeichert. | T/email-muster.ts:80-92 | geprüft | email-adressen-ableiten |
| Ergebnisarten verifiziert / unbestätigt (Catch-all) / offen / abgelehnt | Nur „verifiziert“ als grünes Abzeichen; „oder …“-Schreibweisen bei Annahmen. | packages/email-muster/src/ableitung.ts:58,179; CompanyDetail.tsx:373-419 | geprüft | email-status-verstehen |
| Status-Matrix Spalte „E-Mail“ (Stufe neu starten) | Ergebnis je Firma; gehört eher Ast firmen/Vorgänge. | EmailMusterSection.tsx:45 | geprüft, keine eigene Karte | – |
| Bekannte Adresse setzen | Ersetzt abgeleitete Adressen, wird Beleg fürs Muster; nur per Chat. | T/companies.ts:1397-1420 | geprüft | email-adresse-korrigieren |
| Funktionsadressen prüfen (rechnung@ …) | Bis 10 Lokalteile, SMTP ohne Versand, nichts gespeichert. | T/email-muster.ts:94-113 | geprüft | funktionsadresse-pruefen |
| Buying Center anlegen (Entwurf aus Register + Kontakten, Fokuskunde) | Vier Dimensionen nach Sieck, Vorschläge statt Fakten; zweites BC mit Anlass möglich. | T/buying-center.ts:100-148; prompts.ts:1074-1083 | geprüft | buying-center-anlegen |
| Buying Center pflegen (setzen, Person aufnehmen, Kante, Vorschläge, verknüpfen) | Sachliche Gründe, Beziehungen als Pfeile, freie Mitglieder später verknüpfen. | T/buying-center.ts:187-290, 420-455 | geprüft | buying-center-pflegen |
| Buying-Center-Karte (Seitenleiste, Übernehmen/Verwerfen, Interaktionen CRM, Legende, Recherche starten, Auto-Modus) | Bedienung in der Karte; Interaktionen nur mit CRM-Verknüpfung (HubSpot). | R/components/BuyingCenterKarte.tsx:195, 224-237, 606-660, 724 | geprüft | buying-center-pflegen |
| Buying Center abschließen/archivieren | Nimmt den Fokus, Daten bleiben. | T/buying-center.ts:292-326 | geprüft, keine eigene Karte | – |
| Buying-Center-Mitglieder auf Watchlist | Checkliste und Aufnahme mit Rückfrage. | T/buying-center.ts:328-418 | geprüft, Ast linkedin | – |
| Buying Center freigeben / geteilte ansehen (Firmen → Geteilte Buying Center) | Nur Ansehen, gehört dem Ersteller, Navigation nur bei Freigaben. | T/buying-center.ts:457-545; R/routes/BuyingCenterGeteilt.tsx; AppShell.tsx:722 | geprüft | buying-center-teilen |
| Reiter „Buying Center“ nur mit eigenem aktivem BC | Kollegen-BCs erscheinen dort nicht. | CompanyDetail.tsx:614-624, 660 | geprüft | buying-center-teilen |
| Nähe & Vorrang (Einstellungen → Meldungen) | Schalter (sofern nicht verbindlich), Signale ansehen, alles löschen; 400 Tage; standardmäßig an. | R/routes/settings/RelevanzSection.tsx; MeldungenTab.tsx:14; M/relevanz/index.ts:7,68 | geprüft | naehe-vorrang |
| Wärmeanzeige (kalt/lauwarm/warm/heiß) in Firmenansicht und Buying Center | Gründe im Tooltip, erst ab Nähe 2 sichtbar. | R/routes/waermeanzeige.tsx:40-110; CompanyDetail.tsx:748 | geprüft | naehe-vorrang |
| Relevanz per Chat (Stand, Vorschau, vergessen, ein/aus) | Einzelne Firma/Person vergessen, Arbeitsvorschau des Hintergrunds. | T/relevanz.ts:45-230 | geprüft | naehe-vorrang |
| „Gerade Thema“ (Firmen → Gerade Thema) | Anzahl warmer Mitglieder je Firma, ab 2 Mitgliedern je Firma, Organisation ab 3; ohne Namen. | R/routes/Thema.tsx; T/relevanz.ts:233-266; AppShell.tsx:721 | geprüft | gerade-thema |
| Personenseite (Verflechtungen) | Rollen, frühere Rollen, Beteiligungen, nur Jahrgang; Feature `verflechtungen`. | R/routes/PersonDetail.tsx; T/companies.ts:241 | geprüft | person-verflechtungen |
| Organisationsschalter Kontakt-Recherche / Buying Center / Relevanz / Verflechtungen | Ausblenden statt ausgrauen. | M/../shared/types.ts:66-74 | geprüft | in den Karten erwähnt |

#### radar

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| ICP im Chat beschreiben | Speichert nur Gesagtes, Patch einzelner Felder. | T/icp.ts:58-130; prompts.ts:658-664 | geprüft | icp-festlegen, icp-anpassen |
| ICP-Seite: drei Wege (Websites, Dokument, von Hand mit neun Fragen) | Formular mit Angebot, Nutzen, Orte/Umkreis, Branchen, Größe, Merkmale, Ausschlüsse, Kunden, Zusammenfassung. | R/routes/IcpAssistant.tsx:396-420, 540-600 | geprüft | icp-festlegen |
| ICP aus Websites (eigene + bis 5 Kunden) | Entwurf mit Radius-Vorschlag, 1 bis 3 Minuten, Kundendaten lokal. | T/icp.ts:189-215; IcpAssistant.tsx:404-450 | geprüft | icp-aus-website |
| ICP aus Dokument (PDF/Word/Text/Markdown) | Verdichtung in Felder, fehlende Felder benannt, Speichern erst nach OK. | T/icp.ts:135-185; IcpAssistant.tsx:304-360, 523-525 | geprüft | icp-aus-dokument |
| ICP-Pflichtfelder für den Radar | Ort, Branche, Beschreibung (20 Zeichen) oder Angebot. | M/agent/icp-store.ts:148-157 | geprüft | icp-festlegen, radar-startet-nicht |
| ICP-Grenzen (5 Orte, 12 Branchen, Radius 200) | Laut Werkzeugbeschreibung. | T/icp.ts:75-77 | geprüft (nur Werkzeugtext, Normalisierung nicht nachgelesen) | icp-anpassen |
| Auto-Hinweis nach dem Speichern „Automatik aktivieren (täglich)“ | Ein Klick schaltet Automatik ein. | IcpAssistant.tsx:604-624 | geprüft | radar-automatik |
| Radar-Scan (Ort, Radius bis 100, Branchen, Länder DE/AT/CH/UK/NO/FI) | OSM + Google, 30 bis 90 s, nur unbekannte Firmen. | T/discovery.ts:101-200 | geprüft | radar-scan |
| geo_places_nearby (Nachbarorte im Umkreis) | Nur deutsche Orte; Hilfsfunktion, keine eigene Karte. | T/geo.ts:37-60 | geprüft, keine Karte | – |
| Mini-Profile (Startseite + bis 4 Unterseiten, 6-Monats-Sperre, Bot-Schutz nicht umgehen) | Geteilt für alle Nutzer, Neuerstellung frühestens nach 6 Monaten. | M/discovery/profiler.ts:1-40 | geprüft | radar-kandidaten-verstehen |
| ICP-Match (Score 0 bis 100, „Warum passt sie?“, heiß ab 70) | Rangfolge der Kandidaten. | DiscoveryRadar.tsx:540-640; M/discovery/radar-alerts.ts:21 | geprüft | radar-kandidaten-verstehen |
| Importieren / Ignorieren (Sammelleiste) | Import = Vorgang mit voller Verarbeitung, Ort Pflicht; Ignorieren dauerhaft, nur für mich; Grund fließt in Match. | T/discovery.ts:362-420; G/routes/v1/discovery.ts:684; G/lib/discovery.ts:740-760 | geprüft | radar-uebernehmen-verwerfen |
| „6-Monats-Sperre bei verworfenen“ (laut Auftrag) | Code: 6 Monate gilt für die Mini-Profil-Neuerstellung, Verworfene sind dauerhaft ausgeblendet. | profiler.ts:10,39; G/lib/discovery.ts:775 | veraltet (Auftrag/Notiz weicht ab) | radar-uebernehmen-verwerfen, radar-kandidaten-verstehen |
| Automatik (aus bei Start; täglich, wöchentlich, 4x täglich bezahlt) | Selbstständiger Lauf, Orte rotieren, Meldung bei heißen Treffern einmal je Firma. | M/discovery/radar-supervisor.ts:67-71, 206-224, 276-278; radar-alerts.ts | geprüft | radar-automatik |
| „Jetzt komplett laufen lassen“, „Letzter Lauf“, „Details zum letzten Lauf“ | Sofortlauf, Erklärung warum wenig neu kommt. | DiscoveryRadar.tsx:372-416 | geprüft | radar-automatik, radar-startet-nicht |
| Sofortige Mini-Profil-Verarbeitung | Backlog schnell, mehr KI-Aufrufe, Chat hat Vorrang. | DiscoveryRadar.tsx:319-333; T/discovery.ts:427-433 | geprüft | radar-automatik |
| Deckel „Offene Kandidaten höchstens“ (Standard 300, 0 unbegrenzt) | Kein Scan bei vollem Deckel. | DiscoveryRadar.tsx:334-350; T/discovery.ts:163-169 | geprüft | radar-startet-nicht |
| Aktivitätsanzeige / radar_activity | Live-Phase, Schritt, Fehler. | R/components/RadarActivityIndicator.tsx; T/discovery.ts:497-512 | geprüft | radar-startet-nicht |
| Free-Plan: 2 sichtbare Treffer, 1 Scan/Woche, 25 km, 1 Gebiet, keine Automatik, 3 Meldungen/Woche | Verdeckte Namen auch im Chat. | DiscoveryRadar.tsx:32, 526-536; T/discovery.ts:30-57; G/lib/discovery.ts:123-131; radar-alerts.ts:40-43 | geprüft (Texte widersprüchlich: Starter vs. Pro, siehe fragen.md) | radar-verdeckt, radar-startet-nicht |
| Mit Organisation teilen / „Von der Organisation geteilt“ (Importieren, Ignorieren, Ausblenden) | Empfehlung an alle Mitglieder, unabhängig vom ICP. | DiscoveryRadar.tsx:462-512; T/organisation.ts:404-445 | geprüft | radar-teilen |
| ICP-Bestandsabgleich (Rangliste, top 15 bis 30, Einschränkung per Name/Ort) | Synchron, Vorfilter + KI-Urteil. | T/icp-abgleich.ts:59-80; prompts.ts:605-615 | geprüft | icp-bestandsabgleich |
| Abgleich gegen Angebot/Ausschreibung (Freitext) | Zusätzliche Bewertung gegen den Text. | T/icp-abgleich.ts:71; prompts.ts:605-612 | geprüft | ausschreibung-abgleich |
| Alte Bewertung/Best-Match (company-evaluation) | Abgeschaltet. | prompts.ts:615 | geprüft, keine Karte | – |

#### recherche

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Einstellungen → Recherche (Tab) | Fokus-Themen, Beobachtungen, Link-Überwachung, E-Mail-Adressen, Stammdaten mitpflegen. | R/routes/settings/RechercheTab.tsx; Settings.tsx:213-217 | geprüft | mehrere |
| Fokus-Themen anlegen/ändern/löschen, Begriffe ergänzen lassen, max. 5 aktiv | Wörtliches Zitat + Quelle je Fund; Vorschläge aus ICP. | R/routes/settings/ThemenSection.tsx; T/themen.ts:25-125 | geprüft | fokus-themen-anlegen |
| Reiter „Mein Fokus“ (Gefunden/Unklar/Nicht gefunden) | Befund je Thema mit Zitat, Datum, Quelle; Prüfung mit nächstem Website-Lauf. | CompanyDetail.tsx:987-1040, 106 | geprüft (Bedeutung „Unklar“ nicht belegt) | fokus-themen-ergebnisse |
| „Gezielte Recherche“ in der Übersicht (Expansion, Stellen, Fokus prüfen, Verlauf inkl. Kollegen) | Ohne Kosten, etwa eine Minute; Fokus auf eigenem Modell. | R/components/RechercheLauf.tsx:78-135; CompanyDetail.tsx:1380 | geprüft | stellenanzeigen-firma, recherche-ausschreibungen, fokus-themen-ergebnisse |
| research_run per Chat (jobs, expansion, themen) | Mit Rückfrage; Ergebnisse in der Firmenansicht. | T/research-lauf.ts | geprüft | stellenanzeigen-firma, recherche-ausschreibungen |
| Stufe Deep Research | Im Chat nicht mehr wählbar. | T/research-lauf.ts:1-5 | geprüft, keine Karte | – |
| Reiter „Stellenanzeigen“ (inkl. Arbeitgeberleistungen) / „Expansion & Ausschreibungen“ | Nur mit Daten sichtbar. | CompanyDetail.tsx:100-101, 641-646, 1078-1110 | geprüft | stellenanzeigen-firma, recherche-ausschreibungen |
| Bestandssuche (Meine Firmen, Quellen stelle/karriere/thema/kunde/profil/abschluss, Standard 5, max 100) | Tabelle mit Beleg und Quelle, Einordnung der Belege. | T/companies.ts:981-1030; prompts.ts:617-656 | geprüft | bestand-suchen |
| Bestandssuche außerhalb (Pool, max 5, ohne Belege) | Nur auf ausdrücklichen Wunsch, Aufnahme kostet. | T/companies.ts:986; prompts.ts:640-656 | geprüft | bestand-suchen-ausserhalb |
| Systeme laut Datenschutzerklärung (company_tech_stack) | Gehört eher Ast firmen. | T/companies.ts:575-600 | geprüft, keine Karte | – |
| Webseite lesen (bis 20.000 Zeichen, JS-Seiten, keine Logins/Downloads/privaten Netze, robots.txt) | Antwort aus einer beliebigen Seite. | T/seite-lesen.ts:55-70 | geprüft | seite-lesen |
| Beobachtungen (Watches) anlegen per Chat oder Formular | Regel, Takt, Firmen, Fundstellen-Arten; Treffer in Meldungen. | T/watches.ts:73-180; Settings.tsx:4150-4500; prompts.ts:559-573 | geprüft | beobachtung-anlegen |
| Beobachtungen verwalten (Pausieren/Aktivieren/Löschen, max 20 aktiv) | Löschen entfernt Treffer. | Settings.tsx:4180-4320; shared/types.ts:1810 | geprüft | beobachtungen-verwalten |
| Fundstellen-Art „Evaluations-Flag“ | Bewertung ist abgeklemmt, Auswahl wohl wirkungslos. | Settings.tsx:4345-4356 | unklar | – (Befund) |
| Link-Überwachung anlegen (5 min bis wöchentlich, Anweisung, LinkedIn mit Anmeldung, 5 aktiv) | Änderungen als Meldung + Benachrichtigung. | R/routes/settings/LinkMonitorSection.tsx; T/link-monitor.ts:72-210; prompts.ts:575-603 | geprüft | link-ueberwachung-anlegen |
| Link-Überwachung verwalten (Jetzt prüfen, Pause, Fortsetzen, Bearbeiten, Löschen) | Durchlauf bis 3 Minuten. | LinkMonitorSection.tsx:200-260; T/link-monitor.ts:212-340 | geprüft | link-ueberwachung-verwalten |
| Bot-Schutz abwarten (25 s), nie lösen; Screenshot je Lauf (10 je Überwachung) im Verlauf | Nachprüfbar, ob die Seite geladen hat. | M/link-monitor/interstitial.ts:116-170, 384-402; screenshots.ts:1-25; R/routes/settings/VerlaufTab.tsx:498-515 | geprüft | link-ueberwachung-bot-schutz |
| Cookie-Banner werden automatisch weggeklickt | Auch „alle akzeptieren“-Knöpfe in der Liste. | M/link-monitor/interstitial.ts:1, 182-220 | unklar (Datenschutzwahl, siehe fragen.md) | – |
| Stammdaten mitpflegen (aus standardmäßig, 60/h, Akku-Pause standardmäßig, Nur Handelsregister, Beitrag) | Rechner hilft beim gemeinsamen Registerbestand. | R/routes/settings/MithelfenSection.tsx; M/register-delta/supervisor.ts:70; T/register-delta.ts:31-60 | geprüft | stammdaten-mithelfen |
| Mithelfen per Organisation abschaltbar | Hinweistext im Abschnitt, Untermenüpunkt ausgeblendet. | Settings.tsx:182; MithelfenSection.tsx:62 | geprüft | stammdaten-mithelfen |
| Register-Live-Suche, Browser-Status (register-delta-Werkzeuge) | Gehört Ast firmen/app. | T/register-delta.ts:86-130 | geprüft, keine Karte | – |
| Abgrenzung Beobachtung vs. Link-Überwachung | Interne Daten vs. echte URL. | prompts.ts:576-578 | geprüft | beobachtung-anlegen, seite-lesen |

#### betreiber, keine Karte

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Radar-Kontingent-Override (DiscoveryQuotaOverride) | Betreiber-Notausgang für Scan-Limits. | G/lib/discovery.ts:106-108, 300-304 | betreiber | – |
| Neuberechnung frischer Schritte erzwingen | Laut retry_stage dem Betreiber vorbehalten. | T/imports.ts:1302-1320 | betreiber | – |

### Inventar Äste verbindungen, mail, telegram (Helfer D, Stand 2026-11-07)

Pfade relativ zu `services/desktop/src/` (r = renderer/src, m = main), sonst Repo-Name vorangestellt.

#### Ast verbindungen

### Einstellungen → Verbindungen (Tab)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Tab „Verbindungen“, Reihenfolge CRM, LinkedIn, LinkedIn-Kalibrierung, E-Mail, Telegram, Notizen, Weitere Dienste | Ein Ort für alle Anbindungen; Abschnitte verschwinden, wenn die Organisation sie abschaltet | r/routes/settings/VerbindungenTab.tsx:12-36; r/routes/Settings.tsx:218-226 | geprüft | verbindungen-ueberblick, verbindung-abschnitt-fehlt |
| Org-Ausblendung je Abschnitt (linkedin.beobachter, mail, telegram, mcp.dienste) | Abgeschaltetes fehlt komplett inkl. Untermenü-Sprungmarke | VerbindungenTab.tsx:14-18; Settings.tsx:176-186 (ANCHOR_FEATURE) | geprüft | verbindung-abschnitt-fehlt |
| CRM-Abschnitt „CRM“ (`#crm-connections`) | Karten je CRM mit Status „verbunden/nicht verbunden“, Konto, letzte Aktualisierung, letzter Fehler | r/routes/Settings.tsx:924-1050 | geprüft | crm-verbinden (vorh.), hubspot-verbinden, close-verbinden |
| HubSpot verbinden (Anmeldung im Browser, auch per Chat „Verbinde mein HubSpot-Konto“) | Lese-/Schreibrechte Kontakte, Firmen, Deals; kein Schlüssel nötig | Settings.tsx:908-913, 944; m/agent/tools/crm.ts:149-215 | geprüft | hubspot-verbinden |
| HubSpot lesen (Firmen/Kontakte/Deals suchen, Zuständige, Verknüpfungen, verknüpfte Datensätze, Notizen, Aufgaben) | Fragen wie „welche Deals hat Firma X“ in einem Aufruf | crm.ts:384, 838-1032, 1536-1605; m/agent/prompts.ts:164-180 | geprüft | hubspot-nutzen |
| HubSpot anlegen/ändern (Firma, Kontakt, Deal, Notiz, Aktivität email/call/meeting/note, Aufgabe, Aufgabe erledigen, Firmenfelder, Verknüpfen/Lösen) | Mit Bestätigung vor jeder Änderung; kein Löschen-Werkzeug vorhanden | crm.ts:543, 1032-1605, 2454-2769 | geprüft | hubspot-nutzen |
| AVA-Firma nach HubSpot übernehmen (Voll-Sync inkl. Kontakte, eine Sammelbestätigung) | Ein Schritt statt Feld für Feld | crm.ts:2087-2100; prompts.ts:436-442 | geprüft | hubspot-firma-uebernehmen |
| HubSpot anreichern aus AVA / „jetzt aus dem CRM neu laden“ | Aktualisiert CRM-Daten verknüpfter Firmen | crm.ts:327, 2910 | geprüft | hubspot-nutzen (indirekt) |
| Firma manuell mit CRM-Datensatz verknüpfen | AVA-Firma ↔ HubSpot/Close-Eintrag | crm.ts:436 | geprüft | hubspot-nutzen, close-verbinden |
| Import aus CRM (HubSpot Firmen, Close Leads, bis 5.000) | Firmenliste aus dem CRM befüllen | m/agent/tools/imports.ts:508-560; m/crm/fetch-companies.ts:65 | geprüft (Beschreibung veraltet, s. Befunde) | crm-firmen-uebernehmen, firmen-importieren (vorh.) |
| Bleibt beim CRM-Import die Verknüpfung CRM-Eintrag ↔ Firma automatisch bestehen? | nicht belegt, deshalb nicht behauptet | imports.ts (nicht gefunden) | unklar | – |
| Warnband „HubSpot-Verbindung gestört“ mit „Neu verbinden“ | Zeigt kaputte Verbindung app-weit | r/components/AppShell.tsx:260-271 | geprüft | hubspot-verbindung-gestoert |
| CRM trennen („Verbindung trennen“), Verknüpfungen bleiben | Zugang weg, Links bleiben | Settings.tsx:1010-1016; crm.ts:218-240 | geprüft | verbindung-trennen |
| Close als CRM (Schlüssel auf der CRM-Karte, Leads importieren, verknüpfen) | Strukturelle Close-Anbindung | Settings.tsx:892-899, 1040-1050; crm.ts:191-198; docs/PLAN_CLOSE_MCP.md C1 | geprüft | close-verbinden |
| Close-Anmeldung per OAuth | gibt es noch nicht | docs/PLAN_CLOSE_MCP.md C6 „offen“ | geprüft | close-verbinden |
| Salesforce, Microsoft Dynamics 365 | sichtbar, Knopf „Demnächst verfügbar“ deaktiviert, auch Chat lehnt ab | Settings.tsx:900-922, 1018-1022; crm.ts:183-189; imports.ts:514 | geprüft | salesforce-dynamics |
| Dynamics-Org-URL-Feld | nur sichtbar, wenn Dynamics freigeschaltet wäre | Settings.tsx:1052-1061 | geprüft | – |
| LinkedIn-Abschnitt + Kalibrierung | anderer Helfer (linkedin) | Settings.tsx:1136, 3014 | – (Querverweis) | – |
| Notizen (`#wissensquellen-section`): Notion | Integration anlegen, Zugangscode (ntn_/secret_), Seiten/Datenbanken in Notion freigeben | r/routes/settings/WissensquellenTab.tsx:57-63, 180-268, 274-279 | geprüft | notion-verbinden |
| Notion nutzen (suchen, Datenbanken, Abfragen, Seite lesen/anlegen/ändern, archivieren mit 30 Tagen Papierkorb) | Notion-CRM pflegen per Satz | m/agent/tools/notion.ts:120-430; prompts.ts:395-412 | geprüft | notion-nutzen |
| Notizen: Obsidian (Local REST API, Base-URL 127.0.0.1:27123, Schlüssel) | Lesen, suchen, Tags, anlegen, ergänzen, ersetzen, Frontmatter, löschen | WissensquellenTab.tsx:281-400; m/agent/tools/obsidian.ts:21-535; m/knowledge/obsidian-adapter.ts:689 | geprüft | obsidian-verbinden |
| Schlüsselbund nicht verfügbar → Warnung | Zugangscodes nicht sicher speicherbar | WissensquellenTab.tsx:64-70; TelegramSection.tsx:122-127 | geprüft | – |
| Notizen-Text „Termine als Erinnerung übernehmen“ | nur Kombination Notion/Obsidian lesen + Erinnerung, kein eigener Ablauf | WissensquellenTab.tsx:49, 60 | unklar | – |
| Weitere Dienste (`#weitere-dienste-section`), Org-Schalter `mcp.dienste` (Standard an) | Fremde Dienste und Agenten verbinden | r/routes/settings/DiensteSection.tsx:118-222; ava-admin src/lib/fachlich.ts:65 | geprüft | dienst-verbinden (vorh.), eigenen-dienst-verbinden |
| Vorlage Close (Adresse mcp.close.com, Kopfzeilen Close-API-Key + Close-Scope vorbelegt write_safe) | Kontakte, Aktivitäten, Chancen, Aufgaben; Löschen erst mit destruktivem Bereich | DiensteSection.tsx:14-25 | geprüft | close-verbinden, close-nutzen |
| Vorlage CompLeadly (mcp.complead.ly/user/mcp, Zugangscode aus „Eigene KI verbinden“) | LinkedIn-Sequenzen über CompLeadly-Konto | DiensteSection.tsx:26-33 | geprüft | compleadly-verbinden |
| Vorbelegung aus dem Chat (`?vorlage=` / `?name=`) | AVA öffnet Formular fertig | DiensteSection.tsx:59-70; m/agent/tools/app-oeffnen.ts:41, 88-92 | geprüft | compleadly-verbinden, close-verbinden |
| Art des Dienstes: Werkzeugdienst / Agent (A2A) | Einzelfunktionen oder Aufträge in Textform | DiensteSection.tsx:147-153 | geprüft | eigenen-dienst-verbinden, agent-verbinden |
| Zugang: Zugangscode (min. 8 Zeichen) / Eigene Kopfzeilen (bis 4) / Ohne Zugang; kein OAuth | Anmeldefenster-Dienste gehen nicht | DiensteSection.tsx:105-107, 162-209 | geprüft | eigenen-dienst-verbinden |
| Dienstkarte: Status („n Werkzeuge“ / „Agent erreichbar“ / „nicht verbunden“), „Neu verbinden“, „Entfernen“, Fehlerzeile | Zustand je Dienst | DiensteSection.tsx:282-324 | geprüft | dienst-zugang-abgelaufen, verbindung-trennen |
| Zugang ändern an bestehender Karte | gibt es nicht; entfernen und neu verbinden | DiensteSection.tsx:282-324; m/mcp-client/index.ts:230 | geprüft | dienst-zugang-abgelaufen, close-nutzen |
| Warnband für Dienste mit Fehler, „Zugang erneuern“ (401/403/abgelaufen) bzw. „Neu verbinden“ | Abgelaufene Zugänge sichtbar | AppShell.tsx:276-292; m/mcp-client/index.ts:206-232; m/mcp-client/client.ts:130-131 | geprüft | dienst-zugang-abgelaufen |
| Rückfrage bei schreibenden Funktionen („Ausführen“/„Abbrechen“, Agent „Senden“), Klasse aus Annotationen oder Namen | Nichts ändert sich im Dienst ohne Zustimmung | m/mcp-client/werkzeuge.ts:28-37, 79-92, 127-138 | geprüft | dienst-bestaetigen |
| A2A-Agent: Auftrag wartet bis 2 Min, danach Stand abrufbar | Agent kennt den Chat nicht | werkzeuge.ts:110-160; prompts.ts:244-248 | geprüft | agent-verbinden |
| Rückkanal je Dienst (Adresse anlegen, Kopieren, Stand „n Ereignisse“) | Ereignisse aus dem Dienst empfangen | DiensteSection.tsx:226-279 | geprüft | compleadly-rueckmeldungen |
| CompLeadly-Webhooks „ab Premium“ | Hinweis aus der Oberfläche | DiensteSection.tsx:272-274 | geprüft (Angabe über Fremddienst) | compleadly-rueckmeldungen |
| Ereignis-Wächter alle 3 Min, Benachrichtigung, Typen (Kontaktanfrage gesendet/angenommen, Nachricht gesendet, Lead hat geantwortet, InMail, Profil besucht, Lead exportiert) | Meldet sich selbst | m/dienst-ereignisse-waechter.ts:11-22 | geprüft | compleadly-rueckmeldungen |
| Ereignisse im Chat lesen | „Was hat CompLeadly gemeldet?“ | m/agent/tools/dienste.ts:50-62 | geprüft | compleadly-rueckmeldungen |
| Zuordnung Ereignis → Person über LinkedIn-Adresse; Workflow-Auslöser „dienst.ereignis“ | Ereignis an Firma/Person | docs/PLAN_CLOSE_MCP.md C4; m/workflows/catalog.ts:68 | geprüft | compleadly-rueckmeldungen |
| Workflow-Vorlagen „LinkedIn-Ansprache über CompLeadly“, „CompLeadly-Rückmeldung als Notiz in Close“ | Fertige Abläufe | m/workflows/templates.ts:180-250 | geprüft | compleadly-nutzen, compleadly-rueckmeldungen |
| „Technische Details“ (aufklappbar) | Protokolle, Ablage im Schlüsselbund | DiensteSection.tsx:216-226 | geprüft | – |
| Org-Schalter aus → alle Dienste getrennt | | m/mcp-client/index.ts:46-50 | geprüft | verbindung-abschnitt-fehlt |
| Konkrete Funktionen von CompLeadly/Close (Namen, Felder) | kommen vom Dienst, im Code nicht festgelegt | prompts.ts:236-243; PLAN_CLOSE_MCP.md C5 („echte CompLeadly-Namen erst mit Zugang“) | unklar | compleadly-nutzen, close-nutzen (nur allgemein) |
| Kanal ohne Oberfläche (Telegram, Hintergrund): app_oeffnen liefert Hinweis | Weg wird in Worten genannt | app-oeffnen.ts:68-71 | geprüft | telegram-was-geht-nicht |

### Einstellungen → Konto (Teil Verbindungen nach außen)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| „Verbundene Apps“ (`#verbindungen`): Liste der freigegebenen Apps, „Trennen“ | Claude/ChatGPT/Claude Code einsehen und widerrufen | r/routes/settings/VerbindungenSection.tsx:20-85; KontoTab.tsx:17 | geprüft | ava-in-claude-chatgpt, verbindung-trennen |
| Hinweis Org-Freischaltung MCP fehlt | Bestehende Verbindungen bekommen keine Funktionen | VerbindungenSection.tsx:46-51 | geprüft | ava-claude-findet-nichts |
| mcp.ava.bi, Anmeldung mit AVA-Konto, Claude.ai Connectors, Claude Code | Wie man verbindet | VerbindungenSection.tsx:42-44; docs/PLAN_MCP_OEFFNUNG.md:279-285 | geprüft (Claude), unklar (genauer ChatGPT-Weg) | ava-in-claude-chatgpt |
| Org-Schalter mcp (Std. aus), mcp.lesen, mcp.auftraege, mcp.kopf, mcp.kontakte (Std. aus), mcp.a2a (Std. aus), mcp.copilot (Std. aus) | Admin steuert, was externe Apps dürfen | ava-admin src/lib/fachlich.ts:59-66; db-gateway src/routes/mcp.ts:15-17, 455-475 | geprüft | ava-claude-findet-nichts, ava-in-copilot, ava-fuer-fremde-agenten |
| Funktionsmenge über MCP (firma_suchen, firma_lesen, protokoll_ablegen, firma_kontakte, meine_firmen, meldungen, import_anlegen, recherche_anstossen, neu_verarbeiten, auftrag_status, auftraege, ava_kontext, Kopf-Werkzeuge) | Lesen + Aufträge | db-gateway src/routes/mcp.ts:60-210 | geprüft | ava-in-claude-chatgpt |
| Aufträge über MCP werden abgerechnet | wie jede Verarbeitung | ava-admin fachlich.ts:61 | geprüft | ava-claude-findet-nichts |
| „Deine AVAs“: Gerät, Telegram-Bot, Radar, Modell, MCP-Ziel; Schalter „Dieses Gerät darf Anfragen aus Claude und ChatGPT beantworten“; Umzug | Welche AVA antwortet | r/routes/settings/InstanzenSection.tsx:105-185; m/agent/tools/instanzen.ts:21-78 | geprüft (Umzug: Helfer konto) | ava-claude-findet-nichts, telegram-mehrere-avas |
| Microsoft Copilot über Copilot Studio (MCP/A2A), Werkzeugmenge Copilot, Agenten-Zugang in der Konsole | Copilot nutzt AVA, AVA schreibt nichts in Microsoft-Systeme | docs/WEBSITE_PROMPT_COPILOT_2026-10-23.md:94-108; ava-admin src/app/(konsole)/agenten/page.tsx; mcp.ts:463 | geprüft im Code, Live-Test offen | ava-in-copilot |
| A2A-Fassade (AVA als Agent für Copilot Studio, Azure AI Foundry, n8n) | Fremde Agenten geben AVA Aufträge | db-gateway src/routes/a2a.ts; ava-admin fachlich.ts:64; PLAN_MCP_OEFFNUNG.md §14/15 | geprüft im Code, Live-Test offen | ava-fuer-fremde-agenten |
| Anmeldung mit Microsoft-Konto (Entra) | in Vorbereitung | WEBSITE_PROMPT_COPILOT:102-103 | geprüft (nicht live) | ava-in-copilot |
| Konsole „Agenten-Zugang“ (Client-ID/Geheimnis anlegen) | Admin-Funktion der Organisation | ava-admin agenten/page.tsx; PLAN_MCP_OEFFNUNG.md §15 | geprüft | ava-in-copilot (nur Verweis) |

#### Ast mail

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Abschnitt „E-Mail“ (`#mail-section`) mit Untertext | Postfach für AVA + Entwürfe | VerbindungenTab.tsx:23-30 | geprüft | mail-postfach-einrichten |
| „Postfach für AVA“ (`#mail-account-section`), Org-Schalter mail | IMAP/SMTP-Konto, Passwort verschlüsselt | r/routes/settings/MailAccountSection.tsx:188-400 | geprüft | mail-postfach-einrichten |
| Felder: Mail-Adresse, Anzeigename, IMAP Server/Port 993/Verschlüsselt/Benutzer/App-Passwort, SMTP Server/Port 465/… | | MailAccountSection.tsx:46-61, 207-339 | geprüft | mail-postfach-einrichten |
| „Verbindung testen“, „Speichern“, Bearbeiten, Löschen, Status-Pille, ungelesen, „Versand deaktiviert“, letzter Fehler | | MailAccountSection.tsx:383-452 | geprüft | mail-postfach-einrichten |
| Schalter „AVA darf Mails verschicken“ (Std. aus) | Ohne ihn kein Versand | MailAccountSection.tsx:344-356 | geprüft | mail-postfach-einrichten, mail-senden-antworten |
| Schalter „Vertrauenswürdigen Absendern automatisch antworten“ (Std. aus, nur mit Versand) | Höchstens 5 Antworten je Faden, mit Pause | MailAccountSection.tsx:362-376 | geprüft | mail-auto-antwort |
| „Vertrauenswürdige Absender“ (Adresse oder *@domain, Label) | Nur diese bekommen autonome Antworten | MailAccountSection.tsx:520-570; m/agent/tools/mail.ts:589 | geprüft | mail-auto-antwort |
| Microsoft 365 / Outlook.com per Passwort | geht nicht (IMAP-Fehlertext) | m/mail/imap-fehler.ts:15 | geprüft | mail-postfach-einrichten |
| Gründe „AVA reagiert nicht“: Bearbeitung aus, Senden aus, Absender nicht trusted (Allowlist/SPF/DKIM/>20 Mails je Stunde), Spam, Injection, Ping-Pong Re:, Thread-Kontingent 5/5 Min, archiviert, nie angekommen | Diagnose im Chat | m/mail/agent-bridge.ts:125-176; mail.ts:740-800 | geprüft | mail-reagiert-nicht |
| Abrufintervall 1-120 Min (Std. 15), IDLE-Push; Triage-Kontext 0-50 Nachrichten (Std. 10), 200-5000 Zeichen (Std. 1200) | Nur per Chat einstellbar, kein Regler in der Oberfläche | mail.ts:652-735; MailAccountSection.tsx (Feld fehlt) | geprüft | mail-abruf-und-verlauf |
| Mail-Funktionen im Chat: Posteingang listen, Mail lesen, senden, antworten, weiterleiten (Chat-Dateien, Originalanhänge), gelesen, archivieren | Sicherheitsgate Allowlist + Rückfrage | mail.ts:98-590 | geprüft | mail-senden-antworten |
| Seite Posteingang (Menü Meldungen → „Mail-Triage“, `/inbox`), Org-Schalter mail | Filter Ungelesen/Alle/Trusted/Bekannt/Unbekannt/Archiviert, Einstufung, Zusammenfassung | r/routes/TriageInbox.tsx:24-34, 100-180, 220-240; AppShell.tsx:730 | geprüft | mail-posteingang |
| Mail-Detail: „Im Chat öffnen“ (mit /mail-triage), „Absender als trusted“, „Archivieren“, Anhänge | | TriageInbox.tsx:290-340, 395 | geprüft | mail-posteingang |
| Pille „Auto-Antwort aktiv/aus“ (Link zu Einstellungen) | | TriageInbox.tsx:454-485 | geprüft (Tooltip veraltet) | mail-auto-antwort |
| Ohne Konto: Hinweis + Link „Mail-Konto in Einstellungen hinzufügen“ | | TriageInbox.tsx:100-113 | geprüft | – |
| „Entwürfe“ (`#mail-entwurf-section`), immer sichtbar, „Öffnen in“: Automatisch (empfohlen), Mail-Programm, Outlook-Entwurf (.eml), Entwürfe-Ordner (nur wenn eingerichtet), Gmail, Outlook im Web, Outlook.com | Wo der Knopf öffnet | r/routes/settings/MailEntwurfSection.tsx:20-50; shared/mail-entwurf.ts:20-29 | geprüft | mail-entwurf-oeffnen |
| Einstellung des Öffnen-Wegs per Chat | | m/agent/tools/settings.ts:435; m/suggestions/faehigkeiten.ts:58 | geprüft | mail-entwurf-oeffnen |
| Entwurfskarte im Chat: „E-Mail-Entwurf“, Hauptknopf (In … öffnen / In meine Entwürfe legen), „Kopieren“, „Anders öffnen“, Hinweise ohne Programm, Anhänge fehlen, Lesemodus | | r/components/MailEntwurfKarte.tsx:60-186 | geprüft | mail-entwurf-oeffnen |
| Entwurfskarte in der PWA (mailto/Webmail, Anhänge nur .eml/Entwürfe) | | ava-app src/components/chat/mail-entwurf.tsx | geprüft | mail-entwurf-oeffnen (gilt_fuer app) |
| „Entwurfs-Postfach“: Anbieter IONOS, STRATO, GMX, WEB.DE, Telekom, Gmail, iCloud, Microsoft (gesperrt), Andere; nur Schreiben in Entwürfe | Entwürfe überall sichtbar | MailEntwurfSection.tsx:58-200; m/mail-entwurf/postfach.ts:16-26 | geprüft | mail-entwurfs-postfach |
| Entwürfe direkt in den Ordner legen per Chat (mehrere auf einmal) | | m/agent/tools/mail-entwurf.ts:25; prompts.ts:332-336 | geprüft | mail-entwurfs-postfach |
| „Feste Anhänge“: bis 10 Dateien, je 10 MB, Beschreibung, „An jede Outreach-Mail“, Entfernen | Firmenprofil & Co. automatisch anhängen | MailEntwurfSection.tsx:202-277; prompts.ts:856-862 | geprüft | mail-feste-anhaenge |
| „Wiederkehrende Aufgaben“ (Erweitert, `#scheduler-section`, Org-Schalter mail): Liste, Pausieren/Fortsetzen/Löschen, „+ Neue Mail-Aufgabe anlegen“ | Wiederkehrende Mails | r/routes/settings/SchedulerSection.tsx:36-60, 148-160, 244-260; ErweitertTab.tsx:21 | geprüft | mail-wiederkehrend |
| Grenzen Mail-Schleife: min. 1 Min, max. 7 Tage (Std. 24 h), max. 1000 Läufe, max. 10 aktive, Empfänger trusted, Versand an | | m/scheduler/store.ts:23-27; m/agent/tools/scheduler.ts:91-130 | geprüft | mail-wiederkehrend |
| Erinnerungen (schedule_reminder) | gehört zu meldungen/chat | scheduler.ts:264 | – (anderer Ast) | – |
| Mail-Postfach auf der Server-Instanz (Einrichtungsseite) | Einrichtung auch ohne Desktop | README.md:64, 88 | unklar (nicht im Desktop-Code geprüft) | – |
| Mail-Ereignis als Workflow-Auslöser (mail.inbound) | | m/workflows/catalog.ts:68 | geprüft | – (Ast workflows) |

#### Ast telegram

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Abschnitt „Telegram“ (`#telegram-section`), Org-Schalter telegram | Meldungen aufs Handy, läuft direkt aus der AVA | r/routes/settings/TelegramSection.tsx:112-120 | geprüft | telegram-einrichten |
| Einrichtung: @BotFather /newbot, Zugangscode einfügen, „Verbinden“, Bot erkannt → /start → „Chat verknüpfen“, „Testnachricht senden“, „Trennen“ (mit Bestätigung) | Chat-ID wird ausgelesen | TelegramSection.tsx:50-100, 129-222 | geprüft | telegram-einrichten, telegram-antwortet-nicht, verbindung-trennen |
| Status-Pillen (@bot, Chat verknüpft/fehlt noch, n in Warteschlange) und Zustandszeile (zuletzt zugestellt, zurückgehalten, letzter Fehler) | Fehlersuche | TelegramSection.tsx:157-190 | geprüft | telegram-antwortet-nicht |
| „Meldungen an Telegram senden“ (Std. aus) | | TelegramSection.tsx:225-238; m/telegram/store.ts:30 | geprüft | telegram-meldungen |
| „Ab welcher Wichtigkeit?“ Alle / Ab wichtig (Std.) / Nur dringend | | TelegramSection.tsx:18-22, 240-256; store.ts:34 | geprüft | telegram-meldungen |
| „Ruhezeiten auch für Telegram beachten“ (Std. an); dringend immer | | TelegramSection.tsx:331-342; m/telegram/channel.ts:155-163 | geprüft | telegram-meldungen |
| Bündelung ab 3 Meldungen in 8 s, Outbox max. 50, 4 Versuche | | channel.ts:19-28 | geprüft | telegram-meldungen |
| „Auf meine Nachrichten antworten (Gegenrichtung)“ (Std. aus), nur verknüpfter Chat | Telegram als Chat | TelegramSection.tsx:258-279; m/telegram/inbound.ts:1-22, 199-211 | geprüft | telegram-chatten |
| Faden: neu nach 6 h Ruhe oder 60 Nachrichten; Rückstau wird abgearbeitet, Mindestabstand 1,5 s | | inbound.ts:46-70 | geprüft | telegram-chatten |
| „Rückfragen aufs Handy erlauben“ (Std. aus), Antwort per Nummer/Text, „abbrechen“, 3 Min Zeitlimit | Bestätigungen vom Handy | TelegramSection.tsx:281-321; inbound.ts:72-75, 820-880 | geprüft | telegram-rueckfragen |
| Ohne Rückfragen: Aktionen mit Bestätigung gehen nicht („am Rechner erledigen“) | Schutz gegen untergeschobene Anweisungen | inbound.ts:12-17, 369-377 | geprüft | telegram-rueckfragen, dienst-bestaetigen |
| Modus-Schalter am Chat-Eingabefeld gilt auch für Telegram | | TelegramSection.tsx:322-328 | geprüft (Oberflächentext) | telegram-rueckfragen |
| Sprachnachrichten: lokale Spracherkennung (Whisper), „Verstanden: …“ wird zurückgeschickt | | inbound.ts:590-640; m/core/bootstrap.ts:2182-2192 | geprüft | telegram-sprachnachrichten |
| Bilder: sammeln, bis 5 Min auf Erklärung warten, Bildunterschrift löst sofort aus | | inbound.ts:57-63, 643-680 | geprüft | telegram-bilder |
| Bildverständnis je Modell (DeepSeek, Qwen ohne Bilder) | | r/routes/Settings.tsx:103-111 | geprüft | telegram-bilder |
| Antwort als Sprachnachricht: je Nachricht/„immer“, freie Formulierungen per Modell, Schalter „Standardmäßig als Sprachnachricht antworten“, OpenAI (eigener Schlüssel oder Organisation), wenige Cent, Rückfall auf Text | | TelegramSection.tsx:293-311; m/telegram/sprachantwort.ts:1-30; inbound.ts:496-503; m/agent/tools/telegram.ts:165-196 | geprüft | telegram-sprachantwort |
| Befehle /start, /neu, /reset, /freigaben, /ja, /nein, „abbrechen“ | | inbound.ts:215-230, 262-296, 873 | geprüft | telegram-befehle, telegram-freigaben |
| Workflow-Freigaben per Telegram (bis 10 offen, Begründung optional) | | inbound.ts:262-296 | geprüft | telegram-freigaben |
| Nachricht an Telegram aus dem Chat senden („schick mir das auf Telegram“) | | m/agent/tools/telegram.ts:219-252 | geprüft | telegram-kurzprofile |
| Workflow-Vorlagen „Firmen-Kurzprofil per Telegram“, „Neuer heißer Radar-Treffer: Kurzprofil per Telegram“ (+ Prime-Workflow Radar) | | m/workflows/templates.ts:40-150 | geprüft | telegram-kurzprofile |
| Telegram-Funktionen im Chat: Einrichtung erklären, Zugangscode speichern, Chat verknüpfen, an/aus, Antwortmodus, Status, Senden, Trennen | Self-Service im Chat | m/agent/tools/telegram.ts:36-262 | geprüft (Zugangscode im Chat widerspricht Regel, s. Befunde) | telegram-meldungen, verbindung-trennen |
| Telegram je AVA-Instanz: ein Abholer je Bot (409), Anzeige in „Deine AVAs“, Umzug lässt Bot je Gerät | | inbound.ts:243-256; InstanzenSection.tsx:32-40, 78-91, 176-180; instanzen.ts:21-48 | geprüft | telegram-mehrere-avas |
| Was auf Telegram nicht geht: Seiten öffnen, Zugangsdaten, Bestätigungen ohne Rückfragen-Schalter | | app-oeffnen.ts:68-71; inbound.ts:369-377 | geprüft | telegram-was-geht-nicht |
| Markdown wird für Telegram entfernt | | m/telegram/text.ts; inbound.ts:355-368 | geprüft | telegram-chatten |
| Telegram-Bot auf der Server-Instanz | übernimmt nach „Server vor Rechner“ | InstanzenSection.tsx:107-108 | geprüft | telegram-mehrere-avas |

### Inventar: Äste `linkedin` und `meldungen`

Pfade relativ zu `services/desktop/src/` (sonst angegeben). Stand: Repo-Lesestand 2026-11-07.

#### Ast linkedin

### Navigation, Seite, Gating

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Navigationspunkt „Signale“ | Einstieg in den LinkedIn-Bereich; sichtbar, wenn Beobachter, Watchlist oder Radar freigegeben sind (Leads zählen nicht mit, siehe Befund). | renderer/src/components/AppShell.tsx:682-733 | geprüft | linkedin-bereich-fehlt |
| Route /linkedin (Seitentitel „LinkedIn“) | Vier Reiter, gesperrte Reiter erscheinen gar nicht; letzter Reiter wird gemerkt. | renderer/src/routes/LinkedIn.tsx:350-395; renderer/src/main.tsx:79 | geprüft | linkedin-bereich-fehlt |
| Org-Module linkedin.beobachter / .watchlist / .radar / .leads, bildanalyse | Organisation kann jedes Modul einzeln abschalten; Abschalten stoppt Dienste sofort. | shared/types.ts:61-64; core/bootstrap.ts:3005-3008; renderer/src/routes/Settings.tsx:176-178,1137; ava-admin src/lib/fachlich.ts:44-47 | geprüft | linkedin-bereich-fehlt, linkedin-bildanalyse |
| Läuft nicht auf Server-Instanz | Beobachter braucht Fenster (BrowserWindow) und läuft nur in der Desktop-App; Konsole sagt „Läuft nur in der Desktop-App“. | src/server/stubs/electron.ts:3-40; ava-admin src/lib/fachlich.ts:44 | geprüft | linkedin-bereich-fehlt, linkedin-verbinden |
| Watchlist/Personen-Radar auf Server-Instanz | Unklar, ob Apify-basierte Funktionen dort laufen (kein Fenster nötig). | core/bootstrap.ts:2900,2961 | unklar | (keine) |
| Plan Free: Watchlist gesperrt | maxEintraege 0 → Sperrbanner „ab Plan Pro“. | main/linkedin/watchlist/store.ts:38-50; renderer/src/components/WatchlistPanel.tsx:96-104 | geprüft | linkedin-bereich-fehlt, linkedin-kosten-limit |
| Plan Free: beobachtete Posts / Leads | Website-Text sagt „Im Plan Free keine Beobachtung“; im Desktop-Code keine Free-Sperre für Personen-Radar gefunden. | docs/WEBSITE_PROMPT_PRICING_2026-11-02.md:177 | unklar | (keine Aussage) |
| Hinweis-Banner „LinkedIn-Beobachter aktiv …“ | Oben in der App: aktiv/nicht verbunden, ausblendbar. | renderer/src/components/LinkedInActiveBanner.tsx:60-142 | geprüft | linkedin-sitzung-erneuern |
| Warnung beim Öffnen von LinkedIn-Links | Dialog „LinkedIn-Link öffnen“, Hinweis auf moderaten Takt, für Sitzung abschaltbar. | renderer/src/routes/LinkedIn.tsx:223-258 | geprüft | linkedin-konto-risiko |

### Einstellungen → Verbindungen → LinkedIn (LinkedIn-Beobachter, BETA)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Hinweistext (ToS, DSGVO, Daten lokal) | Offene Risikoaufklärung; Link „Datenschutz-Hinweise“ führt ins Leere (Befund). | renderer/src/routes/Settings.tsx:1400-1411 | geprüft | linkedin-konto-risiko |
| Schalter „LinkedIn-Beobachter aktivieren“ + Einwilligungsdialog | Hartes Opt-in mit Häkchen; per Chat nicht delegierbar. | Settings.tsx:1415-1438; components/LinkedInConsentModal.tsx:60-143; agent/tools/linkedin.ts:8-12 | geprüft | linkedin-verbinden |
| „Einwilligung widerrufen“ | Schaltet aus und löscht gespeicherte Anmeldung. | Settings.tsx:1424-1436; main/linkedin/index.ts:158-164 | geprüft | linkedin-daten-loeschen |
| Verbindung: „Mit LinkedIn verbinden“ / „Verbindung erneuern“ / „Verbindung trennen“ | Echte LinkedIn-Anmeldeseite im Fenster, Passwort nie sichtbar, Sitzung verschlüsselt im Schlüsselbund. | Settings.tsx:1441-1510; main/linkedin/session.ts:32-41 | geprüft | linkedin-verbinden, linkedin-sitzung-erneuern |
| Bildanalyse Aus / Nur lokal (Standard) / Lokal + Cloud | Cloud mit eigener Bestätigung, zurücknehmbar; fehlt bei Org-Sperre „bildanalyse“. | Settings.tsx:1512-1600; main/linkedin/store.ts (DEFAULT imageAnalysis local) | geprüft | linkedin-bildanalyse |
| Durchläufe: „Automatisch im Hintergrund durchlaufen“, „Intervall (Stunden)“ 1-24 | Standard aus, Intervall 4 h. | Settings.tsx:1609-1640; main/linkedin/store.ts DEFAULT_LINKEDIN_SETTINGS | geprüft | linkedin-durchlaeufe |
| „Jetzt durchlaufen“ / Abbrechen | Sofortlauf; abgelaufene Sitzung öffnet Anmeldefenster automatisch. | Settings.tsx:1347-1385,1641-1665 | geprüft | linkedin-durchlaeufe, linkedin-sitzung-erneuern |
| „Vorsichtsmodus“ | Längere Pausen, langsameres Scrollen, weniger Beiträge (intern aggressiveMode=true). | Settings.tsx:1662-1678; main/linkedin/scraper.ts:1021-1170 | geprüft | linkedin-konto-risiko |
| „Letzte Läufe“ mit „Ordner öffnen“ | Bildschirmfotos je Lauf, letzte 10 Läufe. | Settings.tsx:1680-1740 | geprüft | linkedin-keine-signale |
| „Erfasste Daten“ inkl. „Auswertung jetzt ausführen“ | Zähler Beiträge/Personen/Medien, Auswertungsstand, „übersprungen (ohne KI-Modell)“. | Settings.tsx:1744-1875 | geprüft | linkedin-keine-signale, linkedin-durchlaeufe |
| Notschalter „LinkedIn-Daten und -Einstellungen jetzt löschen“ | Löscht ganzen linkedin-Ordner (Sitzung, Beiträge, Signale, Einstellungen), mit Bestätigung. | Settings.tsx:1268-1284,1877-1893; main/linkedin/store.ts:126-135 | geprüft | linkedin-daten-loeschen |
| Einstellungen → Verbindungen → LinkedIn-Kalibrierung | Notiz aus 👍/👎, bearbeitbar (800 Zeichen), „Jetzt aus Feedback lernen“, „Zurücksetzen“. | Settings.tsx:3002-3110 | geprüft | linkedin-kalibrierung |

### Reiter „Signale“ (Feed-Beobachter)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| „Beobachter aktivieren“ / „Deaktivieren“ direkt auf der Seite | An/Aus ohne Umweg; Aktivieren über Einwilligungsdialog. | routes/LinkedIn.tsx:300-312,397-455 | geprüft | linkedin-verbinden, linkedin-daten-loeschen |
| Filter Art / Mindeststärke / Zeitraum / Nur bekannte Firmen / Verworfene anzeigen | Gezielt sichten, 14/30/90 Tage, max 50 Signale. | routes/LinkedIn.tsx:470-540 | geprüft | linkedin-signale-ansehen |
| Signalarten | Personalwechsel, Firmen-Event, Werksbesuch, Produkt-News, Partnerschaft, Veranstaltung, Stellenanzeige, Auszeichnung, Pressemeldung. | routes/LinkedIn.tsx:30-42 | geprüft | linkedin-signale-ansehen |
| Verwerfen / Zurückholen, 👍/👎 mit Begründung, „Beitrag öffnen“ | Rückmeldung fließt in Kalibrierung. | routes/LinkedIn.tsx:320-333,840,1003-1093 | geprüft | linkedin-signale-ansehen, linkedin-kalibrierung |
| Signale ab Stärke 4 mit erkannter Firma → Meldungs-Bewertung | Auch nicht gematchte Firmen (ohne Firmenseite). | main/linkedin/db.ts:2131-2211; core/bootstrap.ts:1155-1161; routes/Alerts.tsx:19-30 | geprüft | linkedin-meldungen |
| Chat: Status, Verbinden, Trennen, Scan/Auswertung abbrechen, Beobachter an/aus, Notschalter | Selbstbedienung im Chat; Verbinden nur nach Einwilligung, An nur wenn Einwilligung schon vorliegt. | agent/tools/linkedin.ts:46-190; agent/tools/linkedin-selfservice.ts:252-315 | geprüft | linkedin-verbinden, linkedin-durchlaeufe, linkedin-daten-loeschen |
| Transparenz: AVA schreibt/liked/vernetzt nicht | Kein Sendepfad im LinkedIn-Code; Produktgrenze laut Compliance-Text. | main/linkedin/* (kein Sendecode); docs/WEBSITE_PROMPT_COMPLIANCE.md:70-75 | geprüft | linkedin-schreibt-nicht |
| „Zweitkonto“-Hinweis | Laut Compliance-Doku auf der Website; in der App kein solcher Hinweis. | docs/WEBSITE_PROMPT_COMPLIANCE.md:72-73 | unklar | (keine) |

### Reiter „Personen-Watchlist“

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Personen hinzufügen (Profil-Adresse, Name, Fokus), Entfernen | Öffentliche Reaktionen/Kommentare beobachten. | components/WatchlistPanel.tsx:127-240 | geprüft | linkedin-personen-watchlist |
| Fokus | Jeden Lauf geprüft, Meldung mindestens „Achtung“; Plätze je Plan begrenzt (derzeit bezahlte Pläne ohne Deckel). | WatchlistPanel.tsx:143; main/linkedin/watchlist/supervisor.ts:540-546; watchlist/store.ts:38-50 | geprüft | linkedin-personen-watchlist |
| Automatik „Regelmäßig prüfen“ täglich/wöchentlich, „Items je Person“ 1-100 | Kostensteuerung; Einschalten fragt ggf. Monatslimit ab. | WatchlistPanel.tsx:228-270 | geprüft | linkedin-personen-watchlist, linkedin-kosten-limit |
| Erweitert: Bestands-Rotation, Kontakt-Suchfenster, Actor-Kennungen | Experten-Schalter für Kosten/Umfang. | WatchlistPanel.tsx:276-342 | geprüft | (keine eigene Karte, zu technisch) |
| Erstlauf = nur Stand merken | Keine Meldungen über alte Aktivität beim ersten Lauf. | watchlist/supervisor.ts:14-17 | geprüft | linkedin-personen-watchlist |
| Sichtungen verfallen nach 90 Tagen, lokal | Datenschutzhinweis im Panel. | WatchlistPanel.tsx:344-348 | geprüft | linkedin-personen-watchlist |
| Chat: watchlist add/list/fokus/remove/check_now/config | Komplett per Chat bedienbar. | agent/tools/watchlist.ts:30-290 | geprüft | linkedin-personen-watchlist |
| Limit erreicht → Meldung „Beobachtete Personen pausiert“ | Einmal je Monat, Automatik bleibt an. | watchlist/supervisor.ts:203-223 | geprüft | linkedin-kosten-limit |

### Reiter „Beobachtete Posts“ (Personen-Radar)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Post-Adressen (eine je Zeile, max 25) | Reagierende Personen → Firma → Lead. | components/PersonenRadarPanel.tsx:73-100; agent/tools/linkedin-leads.ts:112-140 | geprüft | linkedin-beobachtete-posts |
| Automatik wöchentlich/täglich, „Auflösungen je Lauf“ 1-50, „Jetzt prüfen“ | Teuerster Schritt ist die Zuordnung (~1 Cent/Person laut Tooltip). | PersonenRadarPanel.tsx:102-160 | geprüft | linkedin-beobachtete-posts |
| „Ungeklärt“ (verfällt nach 14 Tagen), Freigabe für erneuten Versuch per Chat | AVA rät nie; erneuter Versuch kostet. | PersonenRadarPanel.tsx:166-182; personen-radar/store.ts:189; agent/tools/linkedin-selfservice.ts:205-240 | geprüft | linkedin-beobachtete-posts |
| Wohin Treffer gehen | In den Reiter „Leads“; Firma geht als versteckter Radar-Kandidat für das Mini-Profil, Radar-Liste blendet sie aus. Seiten-Untertitel sagt anderes (Befund). | personen-radar/supervisor.ts:261-263; PersonenRadarPanel.tsx:68-72; routes/LinkedIn.tsx:363 | veraltet (Untertitel und Werkzeugbeschreibung personen_radar_status) | linkedin-beobachtete-posts |

### Reiter „Leads“

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Filter Offen/Ungeklärt/Übernommen/Ignoriert/Alle, nach Post | Leads je Post gruppiert. | components/LinkedInLeadsPanel.tsx:125-140 | geprüft | linkedin-leads |
| „Als Kontakt übernehmen“ | Firma in den Bestand + Verarbeitung + Person als Kontakt mit Anlass; Rückfrage im Chat. | LinkedInLeadsPanel.tsx:88-98,210; main/linkedin/leads-uebernahme.ts:95-111; agent/tools/linkedin-leads.ts:73-96 | geprüft | linkedin-leads |
| „Sitz der Firma (Ort)“ / „Mit Ort übernehmen“ | Wenn Ort nicht ermittelbar. | LinkedInLeadsPanel.tsx:204-208 | geprüft | linkedin-lead-kontakt-fehlt |
| „Kontakt nachholen“ | Wiederholt die Kontaktanlage nach Fehler (Patrick-Befund). Kein Chat-Gegenstück. | LinkedInLeadsPanel.tsx:252-256; leads-uebernahme.ts:114-121 | geprüft | linkedin-lead-kontakt-fehlt |
| „Ansprache vorschlagen“ | Öffnet Chat mit vorbereitetem Auftrag; Senden macht der Nutzer selbst. | LinkedInLeadsPanel.tsx:100-114 | geprüft | linkedin-leads, linkedin-schreibt-nicht |
| „Ignorieren“ mit Grund, „Zurück zu offen“ | Kommentartext wird beim Ignorieren gelöscht. | LinkedInLeadsPanel.tsx:10,214-250; agent/tools/linkedin-leads.ts:98-110 | geprüft | linkedin-leads |
| Leads gehören dem Nutzer, Kollegen-Übernahme sichtbar | Standard nur eigene Leads; „kollegeUebernommen“ am Lead. | db-gateway/src/lib/linkedin-leads.ts:104-117,163-183; LinkedInLeadsPanel.tsx:143 | geprüft (Bestätigungstexte veraltet, Befund) | linkedin-leads |
| Aufbewahrung offener Leads 90 Tage | Übernommene/ignorierte bleiben als Protokoll. | db-gateway/src/lib/linkedin-leads.ts:6-13 | geprüft | linkedin-leads |
| Sammelmeldung „N neue LinkedIn-Leads“ | Eine Meldung je Lauf. | personen-radar/supervisor.ts:311-321 | geprüft | linkedin-meldungen |
| Mail-Entwurf aus Lead (Patrick-Wunsch „Ansprache vorbereiten“ in einem Schritt) | Kein Ein-Klick-Weg; Entwurf nur über Chat. | Notiz project_linkedin_leads_plan.md; agent/tools/mail-entwurf.ts:25 | unklar | linkedin-schreibt-nicht (nur Hinweis) |

### Kosten, Limits, Sonstiges

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Monatslimit-Dialog beim ersten Einschalten | Nur wenn Abrechnung nach Verbrauch aktiv (sonst 404 → sofort weiter). | components/LinkedinLimitDialog.tsx:1-70 | geprüft | linkedin-kosten-limit |
| Chat: Monatslimit setzen/Stand (nur Owner/Admin) | Verbrauch je Funktion, Preise je 1.000. | agent/tools/abrechnung.ts:165-205 | geprüft | linkedin-kosten-limit |
| Pause bei erreichtem Limit bis Monatsanfang | Laut Gateway-Meldung. | db-gateway/src/lib/linkedin-verbrauch.ts:88 | geprüft | linkedin-kosten-limit |
| Apify über AVA (zentral) | Kein eigener Schlüssel nötig; Werkzeugtexte sagen noch „BYOK, Nutzer zahlt“. | PersonenRadarPanel.tsx:66-70; WatchlistPanel.tsx:104; agent/tools/watchlist.ts:213 | veraltet (Werkzeugtexte) | linkedin-kosten-limit |
| LinkedIn-Profile der Ansprechpartner (lokale Profilprüfung) | Bei Kontakt-Auffrischung ohne Anmeldung, Arbeitgeberwechsel als Meldung, Statistik unter Erweitert. | routes/settings/ProfilPruefungSection.tsx:1-40; routes/settings/ErweitertTab.tsx:27-36 | geprüft | linkedin-profil-pruefung |
| Daten bleiben lokal | Beiträge/Signale im linkedin-Ordner des Rechners; Leads liegen dagegen im Cloud-Substrat. | main/linkedin/db.ts:48; db-gateway/src/lib/linkedin-leads.ts | geprüft | linkedin-konto-risiko |
| Worker-Modus hält LinkedIn-Zeitplan an | Keine Hintergrundkosten im Worker-Modus. | core/bootstrap.ts:4625-4633 | geprüft | (keine) |

#### Ast meldungen

### Seite „Meldungen“ (/alerts)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Navigation „Meldungen“ → „Aktive Meldungen“ (+ „Mail-Triage“) | Einstieg. | components/AppShell.tsx:724-731 | geprüft | meldungen-ansehen |
| Glocke oben mit Zähler und Popover | Ungelesene auf einen Blick. | components/AlertBell.tsx:89; AppShell.tsx:744 | geprüft | meldungen-ansehen |
| Liste nach Tagen, Filter „Alle“/„Ungelesen“, Punkt Info/Achtung/Dringend | Kein Filter nach Art in der App (nur per Chat). | routes/Alerts.tsx:50-135 | geprüft | meldungen-ansehen |
| Aufklappen = gelesen; Erklärung, „Quellen“, „Beitrag öffnen“, „Im Firmenkontext öffnen“, „Verwerfen“ | Fundstellen-Link je Meldung. | routes/Alerts.tsx:140-240 | geprüft | meldungen-ansehen, meldungen-quelle, meldungen-aufraeumen |
| „Alle als gelesen markieren“, „Jetzt auslösen“ | Zähler leeren, Lauf starten. | routes/Alerts.tsx:107-119 | geprüft | meldungen-aufraeumen, meldungen-haeufigkeit |
| Leerer Zustand „Nichts Neues … alle 15 Minuten“ | Erwartung setzen. | routes/Alerts.tsx:123-133 | geprüft | meldungen-haeufigkeit |
| Seitenkopf „Heartbeat“ / „Heartbeat-Sweep“ | Interner Begriff in der Oberfläche (Befund). | routes/Alerts.tsx:82-88 | geprüft | (keine) |
| Meldungsarten (Etiketten) | Publikation, Finanzkennzahl, Profiländerung, Bewertungs-Flag, LinkedIn-Signal, Erinnerung, Link-Änderung, Radar-Treffer, Workflow, Vorgang abgeschlossen, Firmenstatus, Kontakt-Wechsel, Neue Kunden, Stellenanzeigen, Mein Fokus. | routes/Alerts.tsx:32-48 | geprüft | meldungsarten |
| AVA-App: Seite Meldungen, „Alle gelesen“ | Meldungen im Browser/Handy. | ava-app src/app/(app)/meldungen/page.tsx:43-58 | geprüft | meldungen-ansehen |

### Einstellungen → Meldungen

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Abschnitt „Meldungen & Ruhezeiten“ (alerts-section) | Zentrale Einstellungen. | routes/Settings.tsx:3754-3758; settings/MeldungenTab.tsx | geprüft | meldungen-haeufigkeit |
| „Wie oft prüft AVA?“ (alerts-cadence) 5/15/30/60/Aus | Standard 15, erster Lauf 10 s nach Start, ±20 % Streuung. | Settings.tsx:3650-3656,3760-3779; agent/alert-prefs-store.ts:35; agent/heartbeat.ts:125-140 | geprüft | meldungen-haeufigkeit |
| „Benachrichtigungen auf diesem Rechner“ | Standard aus; ausgegraut, wenn OS nicht unterstützt. | Settings.tsx:3781-3794; alert-prefs-store.ts:37; notifications.ts:85-100 | geprüft | meldungen-benachrichtigung-rechner |
| „Benachrichtigen ab“ (alerts-severity) Alle/Ab wichtig/Nur dringend | Standard „Ab wichtig“; nur aktiv mit Rechner-Benachrichtigung; gilt auch für AVA-App-Push. | Settings.tsx:3658-3662,3814-3834; push/web-push-kanal.ts:93-97 | geprüft | meldungen-benachrichtigung-rechner, meldungen-kanaele |
| „Fehlgeschlagene Schritte automatisch erneut versuchen“ | Alle 10 Min., max. 5 Versuche/24 h, Standard an; kein Chat-Schalter. | Settings.tsx:3796-3812; alert-prefs-store.ts:47 | geprüft | fehlgeschlagene-schritte-wiederholen |
| „Ruhezeiten“: Von/bis, „Wochenenden ganztägig stumm“ | Standard 19-7 Uhr + Wochenende; über Mitternacht möglich. | Settings.tsx:3836-3899; alert-prefs-store.ts:38-44 | geprüft | meldungen-ruhezeiten |
| Dringend umgeht Ruhezeit (Rechner, App-Push, Telegram) | Insolvenz/Löschung gehen nie unter. | notifications.ts:150-160; push/web-push-kanal.ts:93-97; telegram/channel.ts:155-163 | geprüft | meldungen-ruhezeiten, meldung-firmenstatus |
| „Jetzt prüfen“ + „Letzte Prüfläufe“ | Je Lauf Entscheidungen mit Grund; nur aktuelle Sitzung, max 10 Läufe. | Settings.tsx:3901-4053; shared/meldungs-pruefung-text.ts | geprüft | meldungen-keine-fundstellen, meldungen-wie-ava-entscheidet |
| Abschnitt „Nähe & Vorrang“ | Nur Querverweis (anderer Helfer); falls freigeschaltet. | settings/MeldungenTab.tsx:9-16 | geprüft | meldungen-tageszusammenfassung |
| Abschnitt „Vorschläge im Chat“: „Auf der Startseite“, „Im Gespräch nach einer Antwort“ | Standard an; Org kann abschalten (feste Liste ohne KI). | settings/VorschlaegeSection.tsx:15-35; main/suggestions/settings.ts:2 | geprüft | vorschlaege-im-chat |
| „Arbeitsschritte und Verbrauch anzeigen“ | Bereits vergebene Karte. | settings/VorschlaegeSection.tsx:36-46 | geprüft | arbeitsschritte-anzeigen (vorhanden) |
| Vorschlag wegklicken (X) | Bleibt ausgeschlossen. | components/chat/VorschlagChips.tsx:6-30; routes/Chat.tsx:1484-1488 | geprüft | vorschlaege-im-chat |
| Telegram-Zustellung (Meldungen an Telegram senden, Schwelle, Ruhezeiten) | Eigene Schwelle (Standard ab wichtig), Sammelnachricht. | settings/TelegramSection.tsx:17-21,180-260; telegram/store.ts:34-35 | geprüft | meldungen-kanaele (Einrichtung: Helfer telegram) |
| AVA-App: „Mehr“ → „Mitteilungen“ → „Mitteilungen einschalten“ | iPhone nur als installierte App. | ava-app src/app/(app)/mehr/page.tsx:32; src/components/app/push.tsx:57-91 | geprüft | meldungen-kanaele |

### Wie Meldungen entstehen (Hintergrund)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Meldungs-Prüfung über ganze Firmenliste, ruhende Firmen ausgenommen | Alle aktiven Firmen, nicht nur die neuesten Vorgänge. | agent/real-candidate-source.ts:1-30,180-200 | geprüft | meldungen-kommen-keine, meldungsarten |
| Erst-Crawl ist keine Neuheit; Zeitbezug 180 Tage; Fenster beim ersten Lauf 30 Tage | Keine Meldungsflut nach Import; späte Wechsel fallen weg. | db-gateway/src/routes/v1/alerts-neuheiten.ts:21-56 | geprüft | meldungen-wie-ava-entscheidet, meldungen-kommen-keine |
| Bewertung mit KI-Modell + Profil + ICP, Regeln (4 Jahre Abschlüsse, 12 Monate Presse, keine PR) | Nutzerspezifische Auswahl. | agent/alert-judge.ts:150-300 | geprüft | meldungen-wie-ava-entscheidet |
| Max 20 Bewertungen je Lauf, Rückstand, Urteilsgedächtnis | Nichts geht verloren, nichts doppelt. | agent/heartbeat.ts:85-95,330-470 | geprüft | meldungen-keine-fundstellen |
| Kein Modell bereit → Lauf bewertet nicht, Funde warten | Erklärt „warten auf den nächsten Lauf“. | heartbeat.ts:385-395; alert-judge.ts:60-70 | geprüft | meldungen-kommen-keine |
| Hochstufen bei Nähe, Tageszusammenfassung (nur LinkedIn-Feed-Signale, info, Rang < 6) | Weniger Rauschen, nichts verworfen. | relevanz/alarmweg.ts:40-120; relevanz/sammlung.ts:87-150 | geprüft | meldungen-tageszusammenfassung, linkedin-meldungen |
| Fokuskunde (Buying Center) nie leiser als Achtung | Wichtige Firmen immer sofort. | relevanz/alarmweg.ts:94-101 | geprüft | (keine eigene Karte; Helfer firmen/kontakte) |
| Firmenstatus-Wächter alle 6 h (Insolvenz, Löschung, Liquidation) | Unabhängig von „Wie oft prüft AVA?“, kein manueller Auslöser. | status-watcher.ts:13-125,180-210; firmen-status.ts:76-95 | geprüft | meldung-firmenstatus |
| Gesellschafterwechsel (nur mit Org-Modul verflechtungen) | Neue Gesellschafterliste, erste Liste kein Wechsel. | status-watcher.ts:111-125,135-165 | geprüft | meldung-firmenstatus |
| Radar-Treffer (Score ≥ Schwelle, Achtung, einmal je Firma) | Kommen aus dem Radar (anderer Helfer). | discovery/radar-alerts.ts:160-190 | geprüft | meldungsarten |
| Link-Änderung, Beobachtungen (Watches), Workflows, Importe, Erinnerungen, Kontingent | Weitere Quellen für Meldungen. | link-monitor/supervisor.ts:477; agent/watch-executor.ts:152; transaction-watcher.ts:156; billing/kontingent-waechter.ts:32 | geprüft | meldungsarten |
| Quellen an jeder Meldung (bis 10 Links) | Nachvollziehbarkeit; Register ohne Link. | heartbeat.ts:150-168; routes/Alerts.tsx:190-209 | geprüft | meldungen-quelle |
| Chat: Meldungen lesen (Filter Art/Zeitraum), verwerfen, alle verwerfen, gelesen, endgültig löschen, jetzt prüfen, Einstellungen lesen/setzen | Vollständige Selbstbedienung (außer automatisch wiederholen). | agent/tools/alerts.ts:40-300; agent/prompts.ts:502-519 | geprüft | meldungen-aufraeumen, meldungen-haeufigkeit, meldungen-benachrichtigung-rechner, meldungen-ruhezeiten |
| Meldungsarten einzeln abschalten | Gibt es nicht. | agent/alert-prefs-store.ts:35-48 (keine Felder) | geprüft | meldungen-zu-viele |
| Falschmeldung Rollenwechsel | Varianten-/Zeitlogik im Gateway; Nutzerweg: Verwerfen + Problem melden. | Notiz project_firmenstatus_alerts.md; alert-judge.ts:185-195 | geprüft (Nutzerweg) | meldungen-falschmeldung |
| Worker-Modus hält Meldungs-Prüfung an | Keine Meldungen im Worker-Modus. | core/bootstrap.ts:4622 | geprüft | (keine; Helfer erste-schritte/app?) |

### Inventar Äste `ki` und `chat` (Stand 2026-11-07)

Pfade relativ zu `services/desktop/src/` (r = renderer/src, m = main), sofern nicht anders angegeben.

#### Ast `ki`: Einstellungen → KI & Kosten

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Tab „KI & Kosten“ (Abschnitte Anbieter & Modell, Modelle auf diesem Rechner, Lokale KI, Verbrauch, Mit AVA sprechen, Spracherkennung) | Ein Ort für Modell, Kosten und Sprache. | r/routes/Settings.tsx:204, r/routes/settings/KiTab.tsx | geprüft | ki-modell-waehlen |
| Karte „Aktives Modell / Abrechnung über / Hintergrund über / Firmenverarbeitung über / Status“ | Zeigt, welches Modell läuft, über welchen Zugang abgerechnet wird und ob es bereit ist. | r/routes/Settings.tsx:2131-2170 | geprüft | ki-anbieter-wechseln, ki-modell-antwortet-nicht |
| „Firmenverarbeitung über AVAs Modell, im Plan enthalten, kein Schlüssel nötig“ | Aufbereitung der Firmen braucht keinen eigenen Schlüssel. | r/routes/Settings.tsx:2156; core/bootstrap.ts:555 (POOL_PRODUCER) | geprüft | ki-modell-waehlen |
| Anbieter-Auswahl (Ollama, OpenAI, Anthropic, Google, Mistral, DeepSeek, xAI, Qwen), ohne Schlüssel ausgegraut | Wechsel des Chat-Anbieters. | r/routes/Settings.tsx:69, 2200-2235 | geprüft | ki-anbieter-wechseln |
| Modell-Auswahl mit ★ (Empfehlung je Anbieter), Kontext, Kostenklasse, „vision“ | Empfohlenes Modell je Anbieter erkennbar; Stufe S/A/B/C wird NICHT angezeigt. | r/routes/Settings.tsx:1929; packages/ai-provider/src/catalog.ts:329,637,751,899,1002,1015,1037 | geprüft | ki-modell-waehlen |
| Empfehlungen je Anbieter: GPT-6 Luna (A), Claude Sonnet 5.5 (S), Gemini 3.8 Flash (A), Mistral Large 4 (A), DeepSeek V4 Flash (B), Grok 4.6 (S), Qwen3.8 Max (S) | Orientierung beim Wählen. | packages/ai-provider/src/catalog.ts (recommended: true) | geprüft | ki-modell-waehlen, ki-qualitaetsstufen |
| Lokale Modelle ohne Empfehlung | Onboarding zwingt aktive Wahl. | packages/ai-provider/src/catalog.ts:123 | geprüft | ki-lokales-modell |
| Qualitätsstufen S/A/B/C | Bestimmen Überschreiben und Freischaltungen. | docs/MODEL_TIERS.md; catalog.ts tier | veraltet (Doku: gemma4:31b und llama3.3:70b Stufe A bzw. fehlend, Code: tier 4; Doku nennt gemma4:e4b „current default“, Code: kein lokaler Default; qwen3:*-Modelle fehlen in der Doku) | ki-qualitaetsstufen |
| Workflows per Chat anlegen/ändern nur mit Stufe S | Schwächere Modelle blockiert, Editor bleibt frei. | m/workflows/modellstufe.ts:9-33 | geprüft | ki-qualitaetsstufen |
| Verflechtungen: Hintergrund-Modell Bild + ab Stufe A | Sonst Hinweis „Firmen-Verflechtungen sind mit diesem Modell blockiert“. Org-Feature. | r/routes/Settings.tsx:2143-2147, 2312-2322 | geprüft | ki-qualitaetsstufen, ki-hintergrund-modell |
| „Modell für Hintergrund-Verarbeitung“ | Günstigeres Modell für Radar, Workflows, Firma finden, ICP-Assistent. | r/routes/Settings.tsx:2277; m/agent/providers/manager.ts:787; m/discovery/*.ts | geprüft (Hilfetext darunter veraltet, s. fragen.md) | ki-hintergrund-modell |
| Hinweis „Die Hintergrund-Verarbeitung läuft auf … einem starken Modell“ | Warnt bei Stufe S / Kostenklasse high, wegklickbar je Modell. | r/components/ProducerModelBanner.tsx:68-110 | geprüft (Text nennt Jahresabschlüsse, die laufen aber über AVAs Modell) | ki-hintergrund-modell |
| Klappe „API-Schlüssel“, Karte je Anbieter, „Speichern“, „entfernen“, „Wo bekomme ich einen Schlüssel?“ | Eigener Schlüssel, im Schlüsselbund abgelegt, Link zur Schlüsselseite. | r/routes/Settings.tsx:2361, 2838-3010, 128 (Links) | geprüft | ki-schluessel-hinterlegen |
| Anbieter-Texte (OpenAI: Sprachmodus + Websuche; Anthropic: Claude-Abo reicht nicht; DeepSeek/Qwen keine Bilder) | Was ein Schlüssel freischaltet. | r/routes/Settings.tsx:90-112 | geprüft | ki-schluessel-hinterlegen |
| Schlüsselbund nicht verfügbar → unverschlüsselt | Hinweis im Entwicklungsfall. | r/routes/Settings.tsx:2362-2368 | geprüft | keine |
| Anthropic Tier-1-Hinweis | Minutenlimit 30.000, Tier 2 ab 5 USD. | r/components/AnthropicTierBanner.tsx; m/agent/providers/ai-sdk-provider.ts:1050 | geprüft | ki-limit-und-guthaben |
| Chat-Funktionen Schlüssel/Anbieter (settings_get_provider, settings_set_provider, settings_set_api_key, settings_clear_api_key) | AVA kann Anbieter/Modell umstellen, aber nur für ollama/openai/anthropic/google/mistral; Anthropic-Schlüssel nicht per Chat. | m/agent/tools/settings.ts:33-46, 54, 140-225 | geprüft (DeepSeek/xAI/Qwen fehlen; Beschreibung verweist auf entferntes Claude-Abo) | ki-anbieter-wechseln |
| Schlüsselquelle eigen/Organisation (Radio + settings_set_key_source) | Wahl zwischen Org-Schlüssel und eigenem. | r/routes/Settings.tsx:2925-2945; m/agent/tools/settings.ts:302 | geprüft | ki-organisation-vorgaben |
| Organisationsvorgabe (providerLock, Chat-/Hintergrund-Modell der Org) | Auswahl, Schlüssel, Ollama-Verwaltung ausgeblendet. | r/routes/Settings.tsx:2174-2192, 188 | geprüft | ki-organisation-vorgaben |
| Org-Budget aufgebraucht (Tages-/Monatsbudget, Chat/Hintergrund getrennt) | Banner + Chat-Meldung, Admin in admin.ava.bi → Limits & Verbrauch. | m/agent/providers/ai-sdk-provider.ts:20-48; r/components/OrgQuotaBanner.tsx | geprüft | ki-organisation-budget |
| ChatGPT-Abo-Karte („Continue with ChatGPT“, Hinweis 30 %, Modell für AVA, Trennen, Verbrauch bei ChatGPT ansehen) | Abo statt Schlüssel für Chat, Radar, Alarme, Recherche, Workflows. | r/routes/Settings.tsx:2423-2608 | geprüft | ki-chatgpt-abo-verbinden |
| ChatGPT-Abo „ohne Plan-Freigabe“ (Team/Business/Free) | Nur Plus/Pro teilen das Abo. | r/routes/Settings.tsx:2546-2556 | geprüft | ki-chatgpt-abo-probleme |
| ChatGPT-Abo nicht für Sprachmodus, Deep Research | Dafür Schlüssel nötig. | r/routes/Settings.tsx:2530; m/agent/tools/settings.ts:330 | geprüft | ki-chatgpt-abo-verbinden |
| ChatGPT-Abo Org-Freigabe (chatgptPlanErlaubt) | Ohne Freigabe Karte weg. | shared/types.ts:189; r/routes/Settings.tsx:2109 | geprüft | ki-organisation-vorgaben |
| Abo-Fehlertexte (Limit, nicht berechtigt, abgelaufen) | Klare Meldung statt API-Fehler. | m/agent/providers/openai-subscription-model.ts:88-104; ai-sdk-provider.ts:1003 | geprüft (Text nennt „Einstellungen → Modelle“) | ki-chatgpt-abo-probleme |
| settings_chatgpt_plan (Stand, Modelle, Modell wählen) | AVA kann Abo-Modell im Chat wechseln, Anmeldung nicht. | m/agent/tools/settings.ts:330-367 | geprüft | ki-chatgpt-abo-verbinden |
| Azure OpenAI (Haken, Endpunkt, Modell → Name bei Azure, Prüfen) + settings_openai_azure | Eigene Azure-Ressource; Sprachmodus geht dann nicht. | r/routes/settings/AzureOpenAIKarte.tsx:66-130; m/agent/tools/settings.ts:370; core/bootstrap.ts:4118 | geprüft | ki-azure-openai |
| docs/AZURE_OPENAI.md Klickpfad „Einstellungen → Modelle → OpenAI“ | Pfad heißt heute KI & Kosten → Anbieter & Modell → API-Schlüssel → OpenAI. | docs/AZURE_OPENAI.md:9 | veraltet (Tab-Name) | ki-azure-openai |
| Lokale Modelle auf der Festplatte: reparieren, löschen, „Laufzeit neu starten“, Pflichtmodell embeddinggemma | Selbsthilfe bei Abstürzen und Speicherplatz. | r/routes/Settings.tsx:2612-2775 | geprüft | ki-lokale-ki-reparieren |
| „Modell herunterladen“ (Ollama-Download im Hintergrund, Fortschritt unten rechts) | Lokales Modell holen. | r/routes/Settings.tsx:2777-2836 | geprüft | ki-lokales-modell |
| Lokale KI (Version läuft / vorgesehen, Neu installieren) | Ollama-Version auf geprüftem Stand. | r/components/OllamaVersionSection.tsx:70-131 | geprüft | ki-lokale-ki-reparieren |
| ollama_status / ollama_pull_model / ollama_restart / ollama_delete_model | AVA verwaltet lokale KI per Chat. | m/agent/tools/ollama.ts:27-160 | geprüft | ki-lokales-modell, ki-lokale-ki-reparieren |
| RAM-Angaben lokaler Modelle (8B ab 16 GB … 70B ab 48 GB) | Orientierung, keine automatische Prüfung. | r/routes/FirstRunWizard.tsx:541-594; catalog.ts Labels | geprüft | ki-lokales-modell |
| „Hardware-Prüfung“ lokaler Modelle | Im Code nicht gefunden (nur Labels). | README.md:62 | unklar / veraltet | keine (fragen.md) |
| Verbrauch (7/30/90 Tage, Anfragen, gelesen, geschrieben, wiederverwendet, Diagramm, Modelle im Zeitraum, löschen) | Eigener Überblick, ohne Euro-Beträge. | r/routes/settings/VerbrauchTab.tsx:25-160, 340-480 | geprüft | ki-verbrauch-ansehen |
| Tages-Obergrenze (Textbausteine, Standard keine, Limit entfernen, Banner „Limit anpassen“) + settings_set_daily_token_limit | Kostenbremse für KI-Nutzung. | r/routes/settings/VerbrauchTab.tsx:168-290; r/components/DailyTokenLimitBanner.tsx; m/agent/tools/settings.ts:254 | geprüft (Umfang Chat vs. Hintergrund widersprüchlich, s. fragen.md) | ki-tageslimit |
| Ausgabenlimit Plan (Firmen) | Abrechnung, anderer Helfer. | m/agent/tools/abrechnung.ts:104-140 | geprüft | keine (Querverweis in ki-tageslimit) |
| Fehlertexte Anbieter (Minutenlimit, überlastet, Authentifizierung, Guthaben, Modell nicht verfügbar) | Verständliche Meldung statt Rohfehler. | m/agent/providers/ai-sdk-provider.ts:960-1112 | geprüft | ki-limit-und-guthaben, ki-modell-antwortet-nicht |
| Eingabefeld „Warte auf das lokale Modell…“ wenn nicht bereit | Chat gesperrt, bis Modell bereit. | r/routes/Chat.tsx:1802-1809 | geprüft | ki-modell-antwortet-nicht |
| Mit AVA sprechen (Sprachmodus aktivieren, Aktivierungswort, Signalton, Kosten 0,20 bis 0,40 €/Min.) | Sprechen statt tippen, OpenAI-Schlüssel nötig, Org-Feature „sprachmodus“. | r/routes/settings/SprachmodusSection.tsx:9-53; r/routes/Settings.tsx:184 | geprüft (Kosten s. fragen.md) | ki-sprachmodus |
| sprachmodus_konfigurieren (Stimme marin/coral/sage/shimmer, Ruhe 5 bis 120 s, Standard 20) | AVA stellt Sprachmodus im Chat ein, mit Bestätigung. | m/agent/tools/sprachmodus.ts:17-50; m/sprache/store.ts:12-20 | geprüft | ki-sprachmodus-einstellen |
| Stimme in der Oberfläche fest „Marin“ | Einstellungen zeigen keine Wahl, Chat kann sie ändern. | r/routes/settings/SprachmodusSection.tsx:47 | unklar (s. fragen.md) | ki-sprachmodus-einstellen |
| Sprachmodus-Seite /sprache (Kugel, Leertaste, Mikrofon stumm, Bild/Dokument anhängen, Beenden) | Gesprächsoberfläche. | r/routes/Sprachmodus.tsx:520-681 | geprüft | ki-sprachmodus |
| Wellen-Knopf „Mit AVA sprechen“ im Chat nur bei aktiv + Schlüssel + Org-Freigabe | Einstieg in den Sprachmodus. | r/routes/Chat.tsx:2166-2184 | geprüft | ki-sprachmodus, ki-sprachmodus-fehler |
| Sprachmodus nicht mit Azure; Schlüsselprüfung mit Hinweis | Grund wird angezeigt. | core/bootstrap.ts:4112-4130 | geprüft | ki-sprachmodus-fehler, ki-azure-openai |
| Sprachmodus-Fehler (Mikrofon, Netz/WebRTC, Schlüssel, Kontingent) | Selbsthilfe mit Knöpfen „Erneut verbinden“, „Mikrofon-Einstellungen öffnen“. | r/lib/realtime.ts:19-29; r/routes/Sprachmodus.tsx | geprüft | ki-sprachmodus-fehler |
| Spracherkennung (lokales Whisper: herunterladen, entfernen, Status) + voice_* | Diktat und „Hey AVA“ lokal. | r/routes/Settings.tsx:3396-3496; m/agent/tools/voice.ts:34-160 | geprüft | ki-diktat |
| Diktat-Knopf im Chat (gesperrt ohne Modell, Cmd/Ctrl+D beenden, Esc abbrechen) | Spracheingabe ins Eingabefeld. | r/routes/Chat.tsx:2186-2218, 1550-1580 | geprüft | ki-diktat |
| Diktat über OpenAI ohne Whisper (SpracheStand.diktat) | Im Desktop-Chat nicht genutzt (Knopf prüft nur Whisper). | core/bootstrap.ts:4133-4149 | unklar (vermutlich App/PWA) | keine |
| Websuche im Chat mit OpenAI-Schlüssel | Laut Anbietertext. | r/routes/Settings.tsx:91-93 | geprüft (nur Text) | ki-schluessel-hinterlegen |
| Deep Research / Recherche-Modell der Org | Recherche-Helfer. | shared/types.ts:198 | geprüft | keine (anderer Ast) |
| Betreiber-Spur (Firmenverarbeitung über Betreiber-Modell) | Technik hinter „AVAs Modell“. | m/producer-supervisor.ts:740-790 | betreiber, keine Karte | keine |

#### Ast `chat`

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Chat-Seite, Eingabefeld „Frag AVA…“, Enter/Umschalt+Enter, „Stoppen“ | Grundbedienung. | r/routes/Chat.tsx:1764-1840 | geprüft | chat-grundlagen |
| Firmenlinks in Antworten (company:-Links) | Klick führt zur Firmenseite. | m/agent/prompts.ts:107-125 | geprüft | chat-grundlagen |
| Slash-Palette (Skills, Befehle) | Gespeicherte Routinen per „/“. | r/components/chat/SlashPalette.tsx:1-10 | geprüft | chat-grundlagen (nur Querverweis, Skills = Helfer workflows) |
| Autonomie-Modus Manuell / Halb-auto / Voll-auto (Standard Manuell, Löschen fragt immer, gilt für Telegram und Mail) | Steuert Rückfragen. Keine Chat-Funktion zum Umstellen. | r/routes/Chat.tsx:1700-1722; m/agent/autonomy-store.ts:1-58 | geprüft | chat-autonomie-modus, chat-rueckfragen |
| Anhängen (Plus), Drag & Drop, jede Datei bis 25 MB | Dateien ins Gespräch. | r/lib/attachment.ts:83-104; r/routes/Chat.tsx:1043-1110 | geprüft (Knopf-Tooltip sagt nur „Tabelle anhängen“) | chat-dateien-lesen |
| PDF/Word/Text seitenweise lesen, suchen (datei_info, datei_lesen, datei_suchen; 12.000 Zeichen je Lesen, 20 Fundstellen) | Gezieltes Lesen statt Volltext. | m/agent/tools/dateien.ts:43-130 | geprüft | chat-dateien-lesen |
| Dateien 7 Tage auf Platte, je Unterhaltung | Handles überleben Neustart. | m/agent/attachment-store.ts:46-47 | geprüft | chat-dateien-lesen |
| Scan-PDF-Dialog (5/10/20/Alle Seiten, Kosten) | Gescannte PDFs per Bildmodell. | r/routes/Chat.tsx:1608-1662 | geprüft | chat-scan-pdf |
| Excel/CSV als Import-Quelle | Firmenliste füllen. | r/lib/attachment.ts; Karte firmen-importieren | geprüft | Querverweis firmen-importieren |
| Bilder einfügen (Paste, max. 5 MB, Warnung ohne Bildmodell) | Screenshots/Fotos lesen lassen. | r/routes/Chat.tsx:1045-1070, 1665-1673 | geprüft | chat-bilder |
| Diagramme (```chart: bar, hbar, line, area, pie, scatter; Fallback „konnte nicht angezeigt werden“) | Zahlen als Grafik in der Antwort. | r/lib/chart-spec.ts:68; r/components/ChartBlock.tsx | geprüft | chat-diagramme |
| Buying-Center-Karte und Mail-Entwurf-Karte im Verlauf | Karten in der Antwort. | r/routes/Chat.tsx:3400-3445, 3689 | geprüft | chat-diagramme |
| Langzeitgedächtnis (remember, recall_memory, forget_memory; Einträge in jedem Zug im Prompt) | Merken über Gespräche hinweg. | m/agent/tools/memory.ts:23-130; core/bootstrap.ts:2036-2040 | geprüft | chat-gedaechtnis |
| Einstellungen → Konto → Langzeitgedächtnis | Einträge ansehen/löschen (Helfer konto). | r/routes/Settings.tsx:4528-4615 | geprüft | Querverweis in chat-gedaechtnis |
| Seitenleiste Konversationen, Ein-/Ausblenden Cmd/Ctrl+Shift+S, „Neue Konversation“, „In allen Chats suchen“ Cmd/Ctrl+K, „Konversation löschen“ | Frühere Gespräche finden und löschen. | r/routes/Chat.tsx:3040-3140, 635-645; r/components/ChatSearchModal.tsx | geprüft | chat-verlauf, chat-lange-gespraeche |
| chat_history_list / _load / _delete | AVA findet, liest und löscht frühere Gespräche. | m/agent/tools/chat-history.ts:44-190 | geprüft | chat-verlauf |
| Transkripte lokal als Datei | Gespräche liegen auf dem Rechner. | m/agent/memory.ts:134 | geprüft | chat-verlauf |
| Kontext-Kürzung (Werkzeugergebnisse altern nach 2 bzw. 4 Zügen, Obergrenze 40.000 Zeichen) | Lange Gespräche bleiben bezahlbar; Text selbst wird voll mitgeschickt. | m/agent/kontext-kuerzung.ts:1-20 | geprüft | chat-lange-gespraeche |
| Warnung bei vollem Kontextfenster | Keine gefunden. | – | unklar (s. fragen.md) | keine |
| Hintergrundaufgaben: Karte im Verlauf (nicht mehr Leiste über dem Eingabefeld), „x von y Firmen fertig“, bis 5 Firmen Schritte inline, „Vorgang öffnen“, × = nicht mehr verfolgen, 60 Min. Stillstand → Abbruch, Systembenachrichtigung | AVA meldet sich bei Abschluss selbst. | r/components/AufgabenLeiste.tsx:67-118; m/aufgaben/aufgaben.ts:89-95,160,318; docs/PLAN_HINTERGRUNDAUFGABEN.md Stufe 3 | geprüft (Auftrag/Plan-Kopf „Leiste über dem Eingabefeld“ veraltet) | chat-hintergrundaufgaben |
| aufgabe_beobachten / aufgaben_liste | „Sag Bescheid, wenn fertig“. | m/agent/tools/aufgaben.ts:11-45 | geprüft | chat-hintergrundaufgaben |
| Rückfragen ask_user_choice (bis 12 Optionen, „Sonstiges …“) / ask_user_text, Bestätigungsdialoge | Mehrdeutiges klären, Änderungen bestätigen. | m/agent/tools/ui.ts:13-160; r/routes/Chat.tsx:2490-2545 | geprüft | chat-rueckfragen |
| app_oeffnen (benannte Ziele) / navigate | AVA öffnet Seiten selbst; nur Desktop. | m/agent/tools/app-oeffnen.ts:16-105; m/agent/tools/ui.ts:81 | geprüft | chat-seiten-oeffnen |
| „Denkt nach“ / „Nachgedacht“, Schalter Arbeitsschritte und Verbrauch | Anzeige im Chat. | r/routes/settings/VorschlaegeSection.tsx:36-46 | geprüft | arbeitsschritte-anzeigen (vorhanden, vergeben) |
| Vorschlags-Chips (Startseite / im Gespräch, × ausblenden, „Feste Vorschläge“) | Nächste Schritte per Klick. | r/components/chat/VorschlagChips.tsx; r/routes/settings/VorschlaegeSection.tsx:15-35 | geprüft | vorschlaege-im-chat (Einstellung = Helfer meldungen) |
| Profil (Bio ≤ 600 Zeichen, Rolle, Branchen, Regionen, Schwerpunktthemen, Ton neutral/knapp/ausführlich) + profile_get/_set/_propose_update/_clear | Antworten passend zur Person. | r/routes/Settings.tsx:3243-3330; m/agent/tools/profile.ts:50-250; shared/types.ts:1680-1684 | geprüft | profil-pflegen |
| Du-Form zum Nutzer, Du/Sie-Rückfrage für Texte an Dritte, Sprache Deutsch/Englisch | Passende Anrede in Mails. | m/agent/prompts.ts:85-95 | geprüft | chat-texte-an-dritte |
| Faktenregel (nichts erfinden, Fehlendes nachholen, falsche Prämisse prüfen) | Verlässliche Antworten. | m/agent/prompts.ts:97-105; m/agent/soul.ts:76-110 | geprüft | chat-keine-erfundenen-fakten |
| Chat in Telegram / AVA-App | Andere Helfer. | – | geprüft | keine (Helfer telegram, app) |

### Inventar: Äste workflows, app, hilfe

Stand 2026-11-07, Lesestand main, ava-app main (c0ae476).
Pfade relativ zu `services/desktop/src/` (Desktop), `ava-app/src/` (PWA) bzw. Repo-Wurzel.

#### Ast workflows

### Workflows (Seite Vorgänge → Workflows)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Navigation Vorgänge → Workflows | Seite nur sichtbar, wenn Org-Funktion `workflows` erlaubt | renderer/src/components/AppShell.tsx:706; renderer/src/main.tsx:88-90 (FeatureGate) | geprüft | workflow-aus-chat-speichern |
| Org-Schalter Workflows | Organisation kann Workflows abschalten (Seite, Werkzeuge weg) | shared/types.ts:70; main/suggestions/faehigkeiten.ts:47 | geprüft | workflow-aus-chat-speichern |
| Seitentext / „Im Chat bauen“, „Alle Läufe“, „Aktualisieren“ | Einstieg; AVA baut im Chat, Seite zum Ansehen/Starten/Freigeben | renderer/src/routes/Workflows.tsx:223-237 | geprüft | workflow-aus-chat-speichern |
| Aus Gespräch speichern („speicher das als Workflow“) | Schritte des Gesprächs werden zum Entwurf, Speichern nur nach Bestätigung | main/agent/tools/workflows.ts:523 (from_conversation), :151-294 (save, confirmAction) | geprüft | workflow-aus-chat-speichern |
| Neuer Workflow: Trigger manuell, Schreib-Schritte nicht freigegeben | Nichts läuft ungewollt automatisch | tools/workflows.ts:158 (Beschreibung), Workflows.tsx:202,337 (Hinweistexte) | geprüft | workflow-aus-chat-speichern, workflow-vorlagen |
| Modellstufe S für Anlegen/Ändern per Chat | Mit schwächerem Modell blockiert; Starten/Freigaben/Vorlagen gehen immer | main/workflows/modellstufe.ts:20-33; tools/workflows.ts:82-87, 230, 330 | geprüft | workflow-anlegen-blockiert, workflow-aendern-pausieren |
| Plan-Grenze | Free: 1 Workflow, Starter/Pro/Enterprise unbegrenzt | shared/workflow-types.ts:283-288; main/workflows/index.ts:181-188 | geprüft (Plan-Namen im Umbau, siehe fragen.md) | workflow-anlegen-blockiert |
| Blockierte Workflows (Hinweis auf Karte) | Schritt nutzt abgeschaltete Funktion oder kein Hintergrund-Modell → Starten gesperrt | main/workflows/index.ts:168-177; Workflows.tsx:399-405 | geprüft | workflow-anlegen-blockiert |
| Workflow-Karte: aktiv-Schalter | Pausiert = läuft nur manuell | Workflows.tsx:375-378 | geprüft | workflow-aendern-pausieren |
| Karte: Trockenlauf / Jetzt ausführen / Öffnen / Löschen | Starten und Verwalten je Workflow | Workflows.tsx:396-420 | geprüft | workflow-testen, workflow-aendern-pausieren |
| Firmenauswahl beim Start (eine/mehrere) | Jeder Lauf eine Firma; mehrere = Stapel | Workflows.tsx:58-63, 240-252 | geprüft | workflow-mehrere-firmen |
| Stapel: bis 3 parallel, max 200 | Mehrere Firmen auf einmal | tools/workflows.ts:396-430 (firmen[]) | geprüft | workflow-mehrere-firmen |
| Platzhalter in Alltagssprache mit Fallback | Kein Feldnamen-Wissen nötig | tools/workflows.ts:163 (Beschreibung); WorkflowEditor.tsx:462 („Befüllte Platzhalter“) | geprüft | workflow-mehrere-firmen |
| Warten-Schritt / Abhängigkeiten festlegen | Workflow wartet, bis Firma fertig verarbeitet ist (Endzustand, nicht Erfolg) | WorkflowEditor.tsx:1064-1100; templates.ts:80,99 | geprüft | workflow-mehrere-firmen (nur kurz) |
| Unter-Workflow / Prime-Workflow | Übergeordneter Workflow startet je Firma einen Unter-Workflow | templates.ts:64-85 | geprüft | workflow-mehrere-firmen |
| Trigger Zeitplan (Uhrzeit+Wochentage oder Intervall) | Regelmäßige Läufe | WorkflowEditor.tsx:1203-1244 | geprüft | workflow-zeitplan |
| Hinweis „Läuft nur, wenn AVA zur Zeit des Triggers geöffnet ist; versäumte Läufe werden nicht nachgeholt“ | Ehrliche Grenze | WorkflowEditor.tsx:1244 | geprüft | workflow-zeitplan, workflow-ohne-laufende-app |
| Firmenquelle (feste Liste, Radar heiß ab Score, Vorgang, alle meine Firmen) | Je Firma ein Lauf | WorkflowEditor.tsx:1273-1306 | geprüft | workflow-zeitplan |
| Zeitplan-Idempotenz | Firmen im selben Zeitfenster werden übersprungen | main/workflows/index.ts:682 | geprüft | workflow-zeitplan |
| „Nächster Lauf“ auf Karte | Sichtbarkeit des Zeitplans | Workflows.tsx:381 | geprüft | workflow-zeitplan |
| Trigger Ereignis (Radar heiß, Mail eingehend, Neue Meldung, Import abgeschlossen, LinkedIn neuer Lead, Verbundener Dienst) | Workflow startet von selbst; ein Ereignis = ein Lauf | WorkflowEditor.tsx:1249-1256; tools/workflows.ts:181-188; core/bootstrap.ts:2433-2438, 2786-2788, 2928, 1699 | geprüft | workflow-ereignis-ausloeser |
| Trigger „per Chat“ | Workflow wird im Chat gestartet | WorkflowEditor.tsx:1205 | geprüft (Bedeutung nur aus Code abgeleitet) | – |
| Firmenbezug (je Lauf eine Firma / ohne Firma) | Workflows ohne Firmenbezug, z. B. nur Radar starten | WorkflowEditor.tsx:1265-1268 | geprüft | workflow-mehrere-firmen (indirekt) |
| Freigabe am Schritt („confirmed“) + Freigabe-Schritt (human) | Schreibende Schritte nur nach Freigabe; Mails immer | WorkflowEditor.tsx:1041; tools/workflows.ts:157 | geprüft | workflow-freigaben |
| Offene Freigaben auf der Seite (Freigeben/Ablehnen), 48 h Verfall | Entscheidung in der App | Workflows.tsx:258-289; main/workflows/runner.ts:46, 1065 | geprüft | workflow-freigaben |
| Freigaben per Telegram (/freigaben, /ja, /nein) | Unterwegs entscheiden | main/telegram/inbound.ts:226-296 | geprüft | workflow-freigaben |
| Freigaben als Meldung | Hinweis in Meldungen | main/workflows/index.ts:40 (notify art freigabe) | geprüft | workflow-freigaben |
| Mail-Tagesobergrenze (Standard 20, 0 = keine) | Schutz vor Massenmails | shared/workflow-types.ts:290-298; WorkflowEditor.tsx:1326-1327 | geprüft | workflow-freigaben, workflow-aendern-pausieren |
| Meldung je beendetem Lauf (notifyOnFinish, Standard an) | Ergebnis kommt als Meldung | shared/workflow-types.ts:297; tools/workflows.ts:193 | geprüft | workflow-laeufe-pruefen |
| Vorlagen (7 Stück) | Startpunkte, „Nicht verfügbar“ bei fehlender Verbindung | main/workflows/templates.ts:38-250; Workflows.tsx:326-360 | geprüft | workflow-vorlagen |
| Website-Prompt nennt 4 Vorlagen | Inzwischen 7 | docs/WEBSITE_PROMPT_WORKFLOWS_2026-09-09.md (Abschnitt Vorlagen) | veraltet (Website: 4, Code: 7) | workflow-vorlagen |
| Trockenlauf | Schreib-Schritte nur Vorschau | tools/workflows.ts:396-400; Workflows.tsx:409 | geprüft | workflow-testen |
| „Bis hierhin testen“, „Ausgabe pinnen“, „Pin entfernen“ | Teil-Tests, gespeicherte Ausgaben | WorkflowEditor.tsx:1148-1182 | geprüft | workflow-testen |
| Grobe Kostenübersicht je Lauf | Kosten vor dem Start einschätzen | WorkflowEditor.tsx:507-522, 819 | geprüft | workflow-testen |
| Editor: Diagramm, Schritt-Reiter (Name, Typ, Modus, Bei Fehler, Freigabe, Deaktiviert), Hinzufügen-Reiter | Kleinkorrekturen | WorkflowEditor.tsx:963-1046, 1359 | geprüft | workflow-aendern-pausieren |
| Rückgängig/Wiederholen, Speichern, „Im Chat ändern“, Umbenennen per Klick | Bearbeiten | WorkflowEditor.tsx:808-860 | geprüft | workflow-aendern-pausieren |
| Fehler-Workflow | Läuft bei Fehler mit Fehler-Item | WorkflowEditor.tsx:1315-1317 | geprüft | workflow-aendern-pausieren |
| Erweitert: Parameter als JSON | Für Fortgeschrittene | WorkflowEditor.tsx:1126 | geprüft | – |
| Läufe-Seite (Alle Läufe, Filter Status/Workflow/Zeitraum) | Historie | renderer/src/routes/WorkflowRuns.tsx:68-148 | geprüft | workflow-laeufe-pruefen |
| Editor-Lauf: Lauf abbrechen, Lauf wiederholen, historischer Stand | Nachvollziehen und wiederholen | WorkflowEditor.tsx:865-920 | geprüft | workflow-laeufe-pruefen |
| Teilen mit Organisation / Übernehmen / Zurückziehen | Kopie der Definition, Zugänge nie mit | Workflows.tsx:290-325, 410-414; tools/workflows.ts:546-604 | geprüft | workflow-teilen |
| Workflows ohne laufende App | Läuft nur mit laufender AVA; Mac: Fenster zu = läuft weiter, Windows: beendet | main/index.ts:482-484; docs/PLAN_WORKFLOWS_OHNE_APP.md §1 | geprüft | workflow-ohne-laufende-app |
| Plan „Desktop-Bereitschaft C1–C5“ (Autostart, Tray) | Nicht umgesetzt | docs/PLAN_WORKFLOWS_OHNE_APP.md; Notiz project_workflows_plan | unklar (offen, wartet auf Entscheidung) | – |
| Workflows auf der Server-Instanz | Nur per Chat anlegen, Freigaben über Telegram | core/bootstrap.ts:3090-3110 (gemeinsamer Kern); Notiz reference_fly_headless_ava | unklar (nur Notiz, nicht live geprüft) | workflow-ohne-laufende-app, ava-server-instanz |
| Modellstufe-Meldung nennt Beispielmodelle „GPT-5.6 Sol/Terra, GPT-5.5“ | Katalog ist inzwischen bei GPT-6.x | main/workflows/modellstufe.ts:30 | veraltet (Beispiele) | – |

### Skills (Einstellungen → Erweitert → Skills)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Abschnitt Skills mit Einleitung | Eigene Anleitungen, automatisch oder per /name | renderer/src/routes/SettingsSkills.tsx:360-364 | geprüft | skill-anlegen |
| Neues Skill (Editor: Name, Beschreibung, Sprache, Bereich, Erlaubte Tools, Flags, Argumente, Body) | Skill selbst anlegen | SettingsSkills.tsx:368-374; components/skills/SkillEditor.tsx | geprüft | skill-anlegen |
| Skill im Chat anlegen | Mit Ja/Nein-Bestätigung, danach sofort freigegeben | main/agent/tools/skills.ts:194-330 (askChoice, trust) | geprüft | skill-anlegen |
| Slash-Aufruf, Palette beim Schrägstrich | Gezielt aufrufen | renderer/src/routes/Chat.tsx:68-70, 284-286 | geprüft | skill-anlegen |
| Mitgelieferte Skills (8) | Sofort nutzbar, automatisch freigegeben | resources/skills/*/SKILL.md; main/skills/index.ts:94-222 | geprüft | skill-anlegen |
| Je Skill Aktiv/Deaktiviert | Einzeln ausschalten | SettingsSkills.tsx:670, 748 | geprüft | skill-anlegen |
| Vertrauensmodell (Vertrauen prüfen / Erneut prüfen / Vertrauen + aktivieren / Ablehnen) | Kein unbemerkt erweiterter Skill | SettingsSkills.tsx:679-684; components/skills/SkillTrustDialog.tsx:53-179; docs/SKILLS.md | geprüft | skill-freigeben-importieren |
| Importieren (.zip, SKILL.md, Ziehen), „Importieren + vertrauen“ / „Nur importieren“ | Skills weitergeben | SettingsSkills.tsx:376-381, 477-478; SkillImportDialog.tsx:15-37 | geprüft | skill-freigeben-importieren |
| Alle exportieren, SKILL.md einfügen, Aktualisieren, Skills-Ordner öffnen | Verwaltung | SettingsSkills.tsx:383-411 | geprüft | skill-freigeben-importieren |
| Erlaubte Funktionen als harte Liste, leer = reine Textvorlage | Sicherheit | docs/SKILLS.md (Tool-Allowlist) | geprüft (Doku, Code main/skills/allowlist.ts) | skill-anlegen |
| Voraussetzung fehlt (Gating crm/ollama/tier) | Skill wird übersprungen | SettingsSkills.tsx:732; docs/SKILLS.md | geprüft | – |
| Workspace-Skills (`.ava/skills` im Projekt) | Entwickler-Funktion, aus der UI nicht löschbar | docs/SKILLS.md; SettingsSkills.tsx:126, 700 | unklar (für Endnutzer relevant?) | – |
| Skills beim Umzug | gehen mit | main/agent/tools/umzug.ts:21-22 | geprüft | skill-freigeben-importieren |

### Erinnerungen und wiederkehrende Aufgaben

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Erinnerung im Chat (einmalig, wiederkehrend, max 1 Jahr) | Meldung + Desktop-Mitteilung zur fälligen Zeit | main/agent/tools/scheduler.ts:264-420; core/bootstrap.ts:2675-2690 | geprüft | erinnerung-anlegen |
| Fällige Erinnerung bei geschlossener App | Kommt beim nächsten Start, einmalige bis 1 Tag nach Fälligkeit | scheduler/supervisor.ts:191-216; tools/scheduler.ts:393-396 | geprüft | erinnerung-anlegen |
| Geplantes auflisten / stoppen im Chat | Überblick | tools/scheduler.ts:52-90 | geprüft | wiederkehrende-aufgaben-verwalten |
| Abschnitt Wiederkehrende Aufgaben (Liste, Pausieren, Fortsetzen, Stoppen, Auto-Stop, Runs) | Verwaltung in der App | renderer/src/routes/settings/SchedulerSection.tsx:33-130 | geprüft | wiederkehrende-aufgaben-verwalten |
| Abschnitt nur mit Org-Funktion Mail | Ohne Mail kein Abschnitt, auch keine Erinnerungsliste | settings/ErweitertTab.tsx:17-22; routes/Settings.tsx:180 | geprüft (siehe Befund) | wiederkehrende-aufgaben-verwalten |
| Grenzen: 10 aktive Aufgaben, 5 Fehler in Folge → pausiert | Schutz | scheduler/store.ts:23-26; scheduler/supervisor.ts:15-18 | geprüft | wiederkehrende-aufgaben-verwalten |
| Neue Mail-Aufgabe (Formular, Empfänger nur vertrauenswürdige Absender, max 168 h) | Wiederkehrende Mails | SchedulerSection.tsx:244-337; tools/scheduler.ts:91 | geprüft | Querverweis Ast mail (keine eigene Karte) |
| Unterschied Skill / Workflow / Erinnerung | Orientierung | Zusammenschau oben | geprüft | skill-workflow-erinnerung-unterschied |

#### Ast app

### AVA-App (app.ava.bi, PWA)

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Bereiche Chat, Firmen, Meldungen, Leads, Mehr | Überblick | ava-app components/app/navigation.tsx:1-5 | geprüft | ava-app-im-browser |
| Anmeldung mit demselben Konto | Kein eigenes Konto nötig | ava-app lib/oidc.ts; PLAN_APP_PWA (Keycloak-Client ava-web) | geprüft | ava-app-im-browser |
| Installieren (iPhone Safari Teilen → Zum Home-Bildschirm; Knopf „AVA als App installieren“; Browser-Menü) | Wie eine App starten | ava-app components/app/installieren.tsx | geprüft | ava-app-installieren |
| Hell/Dunkel, Abmelden unter Mehr → App | Komfort | ava-app app/(app)/mehr/page.tsx | geprüft | ava-app-installieren |
| Mitteilungen (Mehr → Mitteilungen), iPhone nur installiert, Geräte-Einstellungen | Push aufs Handy | ava-app components/app/push.tsx; main/push/web-push-kanal.ts:1-30 | geprüft | ava-app-mitteilungen |
| Push folgt Meldungs-Einstellungen (Dringlichkeit) | Gleiche Regeln wie Desktop | main/push/web-push-kanal.ts:30 (RANG), core/bootstrap.ts:1069-1070 | geprüft | ava-app-mitteilungen |
| „Deine AVA ist offline (zuletzt …)“, „Keine AVA mit deinem Konto verbunden“ | Chat braucht laufende AVA | ava-app components/app/ava-stand.tsx:82, 101; db-gateway routes/app.ts:124 | geprüft | ava-app-offline |
| „Keine Internetverbindung“ | Gerät offline | ava-app components/app/offline.tsx | geprüft | ava-app-offline |
| Warteschlange 3 Nachrichten / 10 Minuten, „AVA ist beschäftigt“ | Ein Durchlauf gleichzeitig | core/relais/app-kanal.ts:112-113, 397-405 | geprüft | ava-app-offline |
| „AVA ist noch nicht bereit (kein KI-Modell eingerichtet)“ | Modell fehlt | core/relais/app-kanal.ts:397 | geprüft | – (ava-antwortet-nicht deckt Modellprüfung) |
| Sicherheitsnetz gegen ewiges „Denkt nach“ (Stand alle 15 s) | Antwort wird nachgeladen | ava-app components/chat/use-gespraech.ts; Notiz project_app_pwa | geprüft | ava-app-offline |
| Gleiche Gespräche wie Desktop | Nahtlos weiterarbeiten | core/relais/app-kanal.ts:274-280; docs/PLAN_APP_PWA.md:23 | geprüft | ava-app-chat-funktionen |
| Anhänge (Datei oder Foto), Diktat (Whisper oder OpenAI, mit Sperrgrund), Mit AVA sprechen | Chat unterwegs | ava-app components/chat/eingabe.tsx:189-230; components/sprache/sprachblase.tsx:22-35 | geprüft | ava-app-chat-funktionen |
| Rückfragen, Mail-Entwurf (Mail-Programm, Outlook, Entwürfe-Postfach), Diagramme, Buying Center | Wie am Desktop | ava-app components/chat/rueckfrage.tsx, mail-entwurf.tsx, components/visual/* | geprüft | ava-app-chat-funktionen |
| Aufgabenkarten im Gespräch | Fortschritt von Importen | ava-app components/chat/aufgaben.tsx; app/(app)/chat/[id]/page.tsx:118 | geprüft | ava-app-chat-funktionen |
| Firmen: Meine Firmen / Alle Firmen, Länderfilter, Firmenansicht mit Bereichen | Firmen unterwegs | ava-app app/(app)/firmen/page.tsx:22-53; components/firmen/bereiche.tsx | geprüft | ava-app-firmen-leads |
| Ruhende Firma aktivieren (sofort / Monatswechsel) | Kontingent | ava-app app/(app)/firmen/[id]/page.tsx:138-150 | geprüft (Abrechnungs-Ast) | ava-app-firmen-leads |
| „Mit AVA besprechen“ aus Firmenansicht | Frage vorbelegt | ava-app app/(app)/firmen/[id]/page.tsx:237; chat/[id]/page.tsx:38 | geprüft | ava-app-chat-funktionen |
| Leads: übernehmen, Ansprache vorschlagen, ignorieren mit Grund, Kollegen-Leads | LinkedIn-Leads unterwegs | ava-app app/(app)/leads/page.tsx; lib/leads.ts:65-124 | geprüft | ava-app-firmen-leads |
| Firmen und Leads gehen ohne laufende AVA (direkt über das Konto) | Weniger Abhängigkeit | ava-app lib/leads.ts (gw), firmen/page.tsx (gw) vs meldungen/page.tsx (appAnfrage) | geprüft | ava-app-im-browser, ava-app-firmen-leads |
| Meldungen in der App | Meldungen lesen, verwerfen | ava-app app/(app)/meldungen/page.tsx | geprüft (Inhalte Ast meldungen) | ava-app-im-browser |
| Mehr → Deine AVA → Wo stelle ich was ein? (Desktop, Server-Link 15 Min, Konsole) | Einstellungen finden | ava-app components/app/einstellungen-orte.tsx; server/main.ts:390-398 | geprüft | ava-app-einstellungen |
| Plan-Karte unter Mehr | Plan und Kontingent | ava-app components/app/plan-karte.tsx | geprüft (Ast abrechnung) | – |
| Instanz-Umschalter, Server vor Desktop, Wahl je Gerät | Richtige AVA antwortet | ava-app components/app/ava-stand.tsx (rang, InstanzWechsel) | geprüft | ava-app-welche-ava |
| Problem melden in der PWA | Gibt es nicht | ava-app (keine Fundstelle); Notiz project_problem_melden „PWA nur Mail-Link“ | unklar | – |
| Workflows/Freigaben in der PWA | Keine eigene Ansicht | ava-app (keine Fundstelle) | unklar | – |

### Deine AVAs / Instanzen / Umzug / Server

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Einstellungen → Konto → Deine AVAs (Tabelle Gerät, Telegram, Radar, Modell, MCP) | Überblick über alle AVAs | renderer/src/routes/settings/InstanzenSection.tsx:100-160; routes/Settings.tsx:201 | geprüft | ava-instanzen-ueberblick |
| Hinweis doppelter Telegram-Bot | Ein Bot je Instanz | InstanzenSection.tsx:31-40; tools/instanzen.ts:35-45 | geprüft | ava-instanzen-ueberblick |
| Schalter „Dieses Gerät darf Anfragen aus Claude und ChatGPT beantworten“ | Steuerung, wer MCP-Anfragen beantwortet | InstanzenSection.tsx:163-168 | geprüft | ava-instanzen-ueberblick |
| Name der Instanz ändern | nur per Chat (UI hat kein Feld) | tools/instanzen.ts:53-78 | geprüft | ava-instanzen-ueberblick |
| Umzug Hierher holen / Dorthin senden | Kompletten Stand übertragen, Ziel wird überschrieben, Sicherung bleibt | InstanzenSection.tsx:68-90, 145-152, 176-180; tools/umzug.ts:18-40 | geprüft | ava-umzug |
| Nicht übertragen beim Umzug | Anmeldung, Telegram-Bot, Abo-Anmeldungen, LinkedIn-Beobachter, Browser-Sitzungen | tools/umzug.ts:23-26 | geprüft | ava-umzug |
| Server-Instanz (ohne Oberfläche, an ein Konto gebunden) | Rund um die Uhr | README.md:86-89 | geprüft | ava-server-instanz |
| Einrichtungsseite Server (Anmeldung, Modellzugang Schlüssel/ChatGPT-Abo, Telegram, E-Mail, Deine AVAs) | Einstellungen am Server | server/main.ts:346-351 | geprüft | ava-server-instanz, ava-app-einstellungen |
| 15-Minuten-Link aus der App | Zugang zur Einrichtungsseite | ava-app components/app/einstellungen-orte.tsx; server/main.ts:390-398 | geprüft | ava-server-instanz |
| LinkedIn-Beobachter nie auf Server | Grenze | README.md:88 | geprüft | ava-server-instanz |
| Kunden-Instanzen „in Erprobung“, wie bekommt ein Kunde eine? | Verfügbarkeit | README.md:89 | unklar (Bestellweg fehlt) | ava-server-instanz |
| Server-Image, Fly-Apps, Rollout, instanzen-aktualisieren, Admin-Konsole Knopf | Betrieb | README.md:134; Notiz reference_fly_headless_ava | betreiber, keine Karte | – |

#### Ast hilfe

| Eintrag | Was der Nutzer davon hat / Grenzen (1 Satz) | Quelle (Datei:Zeile, kurz) | Status | Karte(n) |
|---|---|---|---|---|
| Problem melden: Knopf unten links im Chat, Abschnitt in Erweitert | Meldung an das Team | renderer/src/routes/Chat.tsx:1924-1932, 3145-3153; components/ProblemSection.tsx | geprüft | problem-melden |
| Dialog: Kategorien, Titel, Beschreibung, bis 3 Dateien je 5 MB, Bildschirmfoto, Gesprächsauszug, „Als E-Mail vorbereiten“ | Was mitgeht | components/ProblemMeldenDialog.tsx:34, 160-215; shared/problem.ts:3-9 | geprüft | problem-melden |
| Automatisch: Protokolle, Versionen, Plan/Kontingent, Hintergrundaufgaben, maskiert; Löschung 90 Tage nach Abschluss | Datenschutz-Transparenz | ProblemMeldenDialog.tsx:188 | geprüft | problem-melden |
| Antworten unter „Meine Meldungen“ + als Meldung | Austausch in AVA | ProblemMeldenDialog.tsx:136-149, 218-300 | geprüft | problem-melden |
| Problem melden per Chat | Mit Bestätigung | main/agent/tools/problem.ts:12-66 | geprüft (siehe Befund Gesprächsauszug) | problem-melden |
| Gateway-Seite Problemmeldungen deployt? | Ohne Deploy nur Mail-Rückfall | Notiz project_problem_melden (Gateway NICHT deployt, Stand 2026-11-02) | unklar | problem-melden |
| Triage-Center Konsole /betreiber/meldungen | Betreiber-Bearbeitung | Notiz project_problem_melden | betreiber, keine Karte | – |
| Updates: Abschnitt (Installiert, Neue Version, Fortschritt, Jetzt nach Updates suchen, Neu starten und installieren) | Aktualisieren | routes/Settings.tsx:505-592 | geprüft | updates |
| Updates: Text „alle vier Stunden … bestätigst jeden Download … keine stillen Updates“ | Widerspricht Code: 15 Min, Auto-Download, Installation beim Beenden | routes/Settings.tsx:515-518 vs main/updater.ts:58, 129-139 | veraltet (Text falsch) | updates |
| Update-Banner „Neu starten, um zu aktualisieren“ + OS-Mitteilung | Hinweis | components/UpdateBanner.tsx:134; main/updater.ts:157-175 | geprüft | updates |
| Updates per Chat (Status, Prüfen, Laden, Installieren) | Self-Service | main/agent/tools/updater.ts:26-175 | geprüft (Installieren ohne Rückfrage, siehe Befund) | updates |
| Speicherplatz (Kategorien, Nicht benötigte Modelle entfernen, Einzel-Löschen, Ordner öffnen) | Platz schaffen | components/StorageSection.tsx:26-29, 60-160 | geprüft | speicherplatz |
| Diagnose (Protokolldatei, Im Finder anzeigen, Log-Ordner öffnen) | Logs finden | components/DiagnoseSection.tsx:26-60; main/ipc/system.ts:62 | geprüft | diagnose-protokoll |
| Hinweise für den Support (Selbstkorrekturen, JSON exportieren, Alle löschen) | Umwege nach Fehlern | settings/VerlaufTab.tsx:565-640; tools/self-correction.ts:28 | geprüft | diagnose-protokoll |
| Dienste auf diesem Rechner: Datenbank, Verarbeitung je Bereich (Zustände, wartend, Fehlerhinweis) | Lokale Verarbeitung prüfen | settings/ErweitertTab.tsx:27-37; routes/Settings.tsx:600-830 | geprüft | dienste-auf-diesem-rechner |
| Verarbeitung per Chat prüfen (Status, Logs) | AVA diagnostiziert | tools/producers.ts:25-60 | geprüft | dienste-auf-diesem-rechner |
| Zeile register-delta (Stammdaten mitpflegen) in Verarbeitung | Mithelfen-Stand | routes/Settings.tsx:690-740 | geprüft (anderer Ast) | – |
| Browser im Hintergrund (Chrome for Testing, 160 MB, eigener Chrome unberührt) | Transparenz | settings/BrowserSection.tsx; tools/register-delta.ts:86-95; main/chrome-for-testing.ts | geprüft | hintergrund-browser |
| Hintergrund-Browser unsichtbar (headless) | Kein Fenster | structured-content/src/infrastructure/di.ts:182; website/.../browser-fetch.ts:84 (Hauptrepo) | geprüft | hintergrund-browser |
| Downloads gesperrt außer Register, nur loopback | Sicherheit | docs/SICHERHEIT_HINTERGRUND_BROWSER.md | geprüft (Doku) | hintergrund-browser, installation-windows-mac |
| Aufräumen verwaister Browser beim Start | Keine Chrome-Waisen | core/bootstrap.ts:2358; Notiz project_chrome_waisen | geprüft | hintergrund-browser, ava-beenden-schliessen |
| LinkedIn-Profile der Ansprechpartner (lokale Prüfung) | Statistik je 30 Tage | settings/ProfilPruefungSection.tsx | geprüft (Ast kontakte/linkedin) | – |
| Erreichbarkeit der Quellen: Banner mit „Erneut prüfen“, Ausblenden; Status-Seite | Register-Störung verstehen | components/AppShell.tsx:520-600; routes/Whoami.tsx:139; tools/reachability.ts:43-120 | geprüft | quelle-nicht-erreichbar |
| Verhalten bei Ausfall (eine Quelle: Ausweichen; beide: strukturierte Inhalte pausiert) | Andere Schritte laufen weiter | core/bootstrap.ts:353-368, 886-901 | geprüft | quelle-nicht-erreichbar |
| Verarbeitung pausieren (Knopf auf Vorgänge und Meine Firmen, bleibt über Neustart) | Rechner entlasten | main/processing-control.ts:1-40; components/ProcessingToggle.tsx; routes/Transactions.tsx:69; routes/AllCompanies.tsx:364 | geprüft | verarbeitung-pausieren, verarbeitung-haengt |
| Akku: nur „Stammdaten mitpflegen“ pausiert im Akkubetrieb | Akku schonen | settings/MithelfenSection.tsx:75; main/register-delta/supervisor.ts:120, 148 | geprüft | verarbeitung-pausieren |
| Worker-Modus (nur Register-Jobs) | Rechner als Register-Helfer | tools/register-delta.ts:51-55; Notiz project_worker_modus | geprüft (Ast stammdaten/verwaltung), keine Karte | – |
| Hängende Schritte nach Neustart fortsetzen | Nichts geht verloren | main/producer-resume.ts:1-20 | geprüft | verarbeitung-haengt, ava-beenden-schliessen |
| Schritte neu anstoßen per Chat | AVA repariert selbst | faehigkeiten.ts:21 (retry_stage, firma_neu_verarbeiten); Notiz feedback_verarbeitung_unsichtbar | geprüft | verarbeitung-haengt |
| Persist-Ausfall (Nutzersymptom: Firmen hängen trotz laufender Dienste) | Betreiber prüft /health/persist | Notiz project_persist_bus_ausfall | betreiber, keine Karte (Nutzer: verarbeitung-haengt → Problem melden) | verarbeitung-haengt |
| Chat: Stoppen-Knopf, „Denkt nach“-Wächter 90 s | AVA hängt | routes/Chat.tsx:1822-1830, 1244-1256 | geprüft | ava-antwortet-nicht |
| Tageslimit-Sperre vor jedem Durchlauf | Ursache für Stillstand | main/agent/orchestrator.ts:168-174, 256 | geprüft | ava-antwortet-nicht |
| Fenster schließen: macOS läuft weiter, Windows beendet; „Wird beendet …“ | Beenden verstehen | main/index.ts:482-510; components/BeendenOverlay.tsx | geprüft | ava-beenden-schliessen, workflow-ohne-laufende-app |
| Wachhund beim Beenden | Hängende Teile werden beendet | main/watchdog.ts; Notiz project_chrome_waisen | geprüft | ava-beenden-schliessen |
| App startet nicht (Startfehler-Anzeige) | Kein eigener Fehlerbildschirm gefunden | (keine Fundstelle) | unklar | installation-windows-mac (nur Kontakt) |
| Zurücksetzen (Danger Zone, ZURÜCKSETZEN tippen, KI-Modelle bleiben) | Neu anfangen | components/DangerZoneSection.tsx:34-110 | geprüft | zuruecksetzen |
| Verlauf (Zeitraum, Suche, Kategorie, Schwere, Ältere laden, JSON exportieren, Verlauf leeren) | Nachvollziehen | settings/VerlaufTab.tsx:25-68, 209-221, 255-261, 375-400 | geprüft | verlauf-ansehen |
| Status-Seite (Tenant, Konto, Berechtigungen, Konten auf diesem Gerät, Erreichbarkeit) | Kontoüberblick | routes/Whoami.tsx:35-140 | geprüft (Konto-Ast) | quelle-nicht-erreichbar |
| Code-Signierung Windows (eproX GmbH), macOS signiert + notarisiert | Vertrauen bei Installation | README.md:134; docs/WINDOWS_CODESIGNING.md:1-6, 92; electron-builder.yml:127-160 | geprüft | installation-windows-mac |
| Wahrheitspflicht, Vollzugs-Prüfung | AVA behauptet nichts ohne Wirkung | docs/ZUVERLAESSIGKEIT.md §3 | geprüft (intern, keine Karte) | – |
