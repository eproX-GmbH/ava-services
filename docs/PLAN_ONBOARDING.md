# Plan: Onboarding — AVA nimmt neue Nutzer an die Hand

Stand 2026-11-08. Anlass: Sprachnachricht Joyce vom 2026-11-06 (6:41 Min., lokal
transkribiert) nach den Erfahrungen mit Alessandro (Close + CompLeadly) und Strategic IT.
Ergänzt am selben Tag nach Joyces Rückmeldung: Plan passt; Start-Analyse sofort beim
Registrieren mit Wiederholungen, ICP genau **einmal** in die App, Referenzkunden mit
eigenem Kurzprofil (ohne deren Referenzen), Workflow-Bausteine vollständig (O9).

## 1. Was Joyce will (Kern der Sprachnachricht)

1. **Kunden wie Alessandro an die Hand nehmen.** Nicht „hier ist Close, hier ist
   CompLeadly, mach mal“, sondern gemeinsam seinen Ablauf durchgehen: Er spricht ein, wie
   es laufen soll (CompLeadly holt einen Lead, AVA recherchiert, Ergebnis zurück ins CRM),
   AVA macht daraus einen Workflow und erklärt, was wann läuft („alle 24 Stunden“).
   Sonst verlieren wir solche Kunden schnell wieder.
2. **Selbstläufer brauchen einen „Wow“-Effekt wie bei Lovable.** Heute: App auf, „und
   dann? Nix.“ Ziel: etwas eingeben und sofort sichtbar das bekommen, was man will.
3. **Arbeit beginnt schon bei der Registrierung.** Aus der Domain der E-Mail-Adresse im
   Hintergrund, ohne zu fragen, die Website analysieren und ein ICP ableiten, inklusive
   Kundenreferenzen von der Website. Freemail (Gmail usw.) nicht verarbeiten, dort führt
   AVA Schritt für Schritt durch („du musst noch dein ICP festlegen“).
4. **Erste Ergebnisse von selbst.** Firmenradar in begrenztem Rahmen laufen lassen, die
   zehn besten Treffer in „Meine Firmen“ übernehmen, damit überhaupt etwas da ist, und dem
   Nutzer zeitnah Meldungen per E-Mail schicken („AVA hat mir geschrieben …“).

## 2. Befund (Ist-Stand im Code)

**Registrierung**
- Die Desktop-App registriert selbst: `SignUpForm.tsx` fragt nur Vorname, Nachname,
  E-Mail, Passwort, AGB; kein Firmen- oder Website-Feld. Route `POST /v1/auth/register`
  (`db-gateway/src/routes/v1/auth.ts:48`) legt nur den Keycloak-Nutzer an und startet
  nichts. Tenant und Mitglied entstehen erst beim ersten `/v1/whoami`
  (`lib/tenants.ts:141-218`), die Organisation im Einrichtungsassistenten
  (`createOrganisation`, `lib/tenants.ts:292-330`).
- **Die Website registriert an uns vorbei:** `ava-website/app/api/register/route.ts`
  (Vercel) legt den Nutzer direkt per Keycloak-Admin-API an und holt Tokens. Gateway und
  `/v1/auth/register` sehen davon nichts, der Nutzer hat AVA dann oft noch gar nicht
  installiert. Über die Konsole kann man sich zusätzlich auf der Keycloak-Seite
  registrieren; beide Wege erreichen das Gateway erst mit dem ersten `/whoami`.
- Das Gateway läuft auf **einer** Fly-Maschine (`ava-db-gateway`, Stand 2026-11-08).
- E-Mail-Adressen sind **unbestätigt** (`keycloak-admin.ts:149-163` setzt
  `emailVerified: true`).
- Eine Freemail-Liste gibt es nicht; nur die Baukasten-Regel
  (`lib/web-firma.ts:13`, `firmen-web/domain-gate.ts:66`, ohne gmail/outlook/yahoo).

**Erster Start**
- Reihenfolge: Anmeldung → Einrichtungsassistent (Organisation, KI-Anbieter, Modelle,
  `FirstRunWizard.tsx`) → Chat-Startseite („Womit fangen wir heute an?“, Vorschlagschips,
  `IcpProposalCard`). Der feste Willkommenstext (`agent/welcome.ts`) kommt nur auf „Hi“
  oder „Was kannst du?“.
- **Kein gespeicherter Einrichtungsstand, keine Checkliste, kein geführter Ablauf.** Der
  „Nutzerstand“ der Vorschläge wird jedes Mal neu berechnet und kennt Close und CompLeadly
  nicht (`suggestions/nutzerstand.ts:111-118`).

**ICP**
- Liegt nur lokal (`userData/agent/icp.json`, `agent/icp-store.ts`) auf dem Rechner, auf
  dem AVA läuft. Bei einer gebuchten AVA in der Cloud (`headless-ava`, Fly) ist das deren
  Volume, also ebenfalls „lokal“ in dieser Instanz. Er wird nie synchronisiert; das
  Gateway liest ihn nur live über das Relais (`mcp-kontext.ts:145`). Der Radar braucht Orte, Branchen und Beschreibung oder Angebot
  (`fehlendeFelder`, `icp-store.ts:148-157`).
- „ICP aus meiner Website“ geht lokal nur halb: `runIcpAnalysis` liest bei der eigenen
  Website keine Referenzen, und die Beschreibung bleibt leer
  (`discovery/icp-assistant.ts:381, 473-475`).
- **Auf dem Server gibt es das schon fertig:** `icpAusWebsite()` aus der Vorabanalyse
  (`db-gateway/src/lib/vorabanalyse/icp.ts:134`) liest Startseite plus Unterseiten, holt
  Referenzkunden als `kundenBeispiele` (bis 20) und schreibt die Beschreibung in Du-Form.
  Sie läuft über die Betreiber-Spur (`betreiber-llm.ts`, Betreiber zahlt) und ist heute nur
  für Betreiber erreichbar.
- Der Plan ICP-Assistent schreibt vor: kein stilles Speichern, der Nutzer prüft
  (`PLAN_ICP_ASSISTENT.md:85-88`).

**Radar**
- Läuft lokal auf dem Modell des Nutzers (Vorauswahl über Vektoren, danach KI-Urteil über
  bis zu 120 Kandidaten). Die Automatik ist ein Opt-in und für Free gesperrt.
- **Der erste Lauf (Rückstand) läuft für jeden Plan mit Pro-Parametern und zählt nicht
  aufs Kontingent** (`db-gateway/src/lib/discovery.ts:160-163`). Das passt genau zum
  Onboarding.
- Übernahme in „Meine Firmen“ nur auf ausdrückliche Entscheidung: **Regel A10**
  (`PLAN_FIRMEN_DISCOVERY.md:134-137`, `discovery/decide.ts:11`). Automatisches Übernehmen
  widerspricht dieser ratifizierten Regel.

**Kosten**
- Free: 25 Aktivierungen auf Lebenszeit; zehn Startfirmen wären 40 % davon. Pro und höher:
  die Firmen zählen aufs Monatskontingent.
- „Aktiv/ruhend“ (P10) ist gebaut; ob es in Gateway und master-data deployt ist, ist nicht
  geprüft.

**E-Mail an Nutzer**
- **Kein Dienst verschickt heute E-Mails an Nutzer.** Meldungen gehen nur an das
  Betriebssystem, Telegram und die AVA-App (Web-Push). In den Meldungseinstellungen gibt es
  keine E-Mail. E-Mail geht nur über einen Workflow mit `mail_send` aus dem eigenen
  Postfach des Nutzers.
- Meldungen entstehen lokal (Heartbeat → `POST /v1/alerts/neuheiten`), also nur, solange
  die App läuft.

**Workflows und Alessandros Ablauf**
- AVA kann aus einer Beschreibung einen Workflow bauen (`workflow_save`, mit Entwurf und
  Rückfrage), Zeitplan per `intervalMinutes`/`at`, Ereignis `dienst.ereignis` für
  CompLeadly-Rückmeldungen. Es gibt Vorlagen („LinkedIn-Ansprache über CompLeadly“,
  „CompLeadly-Rückmeldung als Notiz in Close“).
- **Es fehlen für „CompLeadly findet Lead → AVA recherchiert → in Close anlegen“:**
  - Ein Ereignis für einen *unbekannten* Lead hat keine Firma (die Zuordnung klappt nur
    bei Firmen im Bestand). Es gibt keine Vorlage, die die Firma importiert und
    recherchiert.
  - Es gibt keine Rolle „Lead/Kontakt in Close anlegen“, nur Notiz und Aufgabe.
  - Die Werkzeugnamen von CompLeadly sind ungeprüft, und Webhooks gibt es nur im
    Premium-Tarif.
  - Rückmeldungen erscheinen als stille Systemmitteilung, nicht als Meldung, also nicht
    auf Telegram oder dem Handy.
- Eine Erklärung „was läuft wann“ in Alltagssprache fehlt; es gibt nur „Nächster Lauf“ in
  der Workflow-Liste. Workflows laufen nur, solange die App läuft.
- Diktat im Chat geht auch für längere Beschreibungen (lokales Whisper, Text landet im
  Eingabefeld).

**Wissen**
- Die L2-Karten auf dem Branch `claude/wonderful-bell-d6f985` decken Erste Schritte,
  ICP aus Website, Close, CompLeadly und Workflow-Zeitplan schon als Text ab. Sie sind
  Inhalt für den Begleiter (O6), nicht der Begleiter selbst.

## 3. Einschätzung (Feedback an Joyce)

**Stark und sofort umsetzbar:**
- **Website-Analyse aus der E-Mail-Domain.** Das Werkzeug existiert schon auf dem Server
  (`icpAusWebsite`) und liest sogar die Referenzkunden. Die Referenzen sind Gold: Der Radar
  gewichtet die Ähnlichkeit zu Kundenbeispielen mit 40 % (`matcher.ts:339`). Mit echten
  Referenzen werden die ersten Treffer deutlich besser als mit einem leeren Profil.
- **Der erste Radar-Lauf ist schon heute kostenlos und groß.** Er muss nur automatisch
  direkt nach dem ICP starten statt auf einen Knopf zu warten.
- **Die Zeit im Einrichtungsassistenten nutzen.** Während der Nutzer Organisation und
  KI-Anbieter wählt und Modelle lädt (Minuten), ist die Analyse auf dem Server längst
  fertig. Der erste Chat kann mit „Ich habe mir eprox.de angesehen …“ beginnen. Das ist
  der Lovable-Moment: Der Nutzer hat nichts eingegeben und sieht sich selbst.

**Wo die Idee mit bestehenden Regeln kollidiert (Entscheidungen in §4):**
1. **Rechnen beim Nutzer.** Eine Analyse auf dem Server vor dem ersten Start ist eine neue
   Betreiber-Ausnahme. Sie ist begrenzt, betrifft nur öffentliche Daten und kostet etwa
   einen KI-Aufruf je neuer Domain. Trotzdem gehört sie ausdrücklich in DECISIONS.
2. **Stilles Speichern des ICP.** Der ICP-Plan verbietet das. Entschieden (Joyce
   2026-11-08): Beim ersten Anmelden wird der Vorschlag **einmalig** übernommen, der erste
   Chat lädt zum Prüfen ein. Er überschreibt nie einen vorhandenen ICP (Sperren in O2).
3. **Zehn Firmen automatisch übernehmen.** Das widerspricht Regel A10 und kostet bei Free
   40 % des Lebenskontingents. Vorschlag: Die zehn Besten stehen fertig im ersten Chat,
   mit einem Knopf „Alle 10 übernehmen“ (ein Klick statt zehn), und zählen als Startpaket
   nicht aufs Kontingent.
4. **E-Mails.** Dafür gibt es noch gar nichts: keinen Versanddienst, keinen
   Meldungskanal, keine Einstellung. Weil die Adressen unbestätigt sind, könnte sonst
   jeder mit einer fremden Adresse Mails an Dritte auslösen. Deshalb Double-Opt-in: Die
   Willkommensmail enthält den Knopf „Meldungen per E-Mail erhalten“.
5. **Erwartung an die erste Meldung.** Ein „Geschäftsführerwechsel hier und dort“ kommt
   erst, wenn sich bei den Firmen im Bestand etwas ändert, also nach Tagen, nicht
   Minuten. Die erste Mail sollte daher der **Radar-Fund** sein („Diese 10 Firmen passen
   zu deinem Angebot, die drei besten …, weil …“). Echte Neuigkeiten folgen als
   Tagesübersicht.
6. **Meldungen entstehen auf dem Rechner des Nutzers.** Mails kommen also nur, solange
   AVA läuft (oder über den Betreiber-Server `headless-ava`). Das ist unproblematisch,
   gehört aber in die Erklärung an den Nutzer.

**Zusätzliche Ideen für den Wow-Effekt (billig, weil vorhanden):**
- **„So sieht AVA dein Unternehmen“:** den Steckbrief der eigenen Firma (Register,
  Geschäftsführung, Größe, Website) als erstes Ergebnis zeigen. Das ist sofort spürbar und
  zeigt die Datentiefe am Beispiel, das der Nutzer am besten beurteilen kann.
- Startchips aus ICP und Referenzen: „Finde Firmen wie <Referenzkunde>“, „Bereite mein
  Gespräch mit <Top-Treffer> vor“.
- Fortschritt im Chat statt Ladekreis: „Ich lese gerade 1.200 Firmen in deiner Region
  …“.

## 4. Offene Entscheidungen (Joyce)

| # | Frage | Empfehlung |
|---|---|---|
| E1 | Start-Analyse auf dem Server als neue Betreiber-Ausnahme (je Domain einmal, Deckel je Tag)? | **Entschieden (Joyce 2026-11-08): ja**, sofort beim Registrieren, auf vorhandener Fly-Instanz (Gateway); D14 in DECISIONS |
| E2 | ICP still speichern oder mit einem Klick bestätigen? | **Entschieden (Joyce 2026-11-08):** wird beim ersten Anmelden einmalig in die App übertragen und gespeichert; der erste Chat zeigt ihn und lädt zum Prüfen ein. Ersetzt für diesen einen Fall die Regel „kein stilles Speichern“ aus dem ICP-Plan |
| E3 | Top 10 automatisch übernehmen (Abweichung von A10) oder ein Klick „Alle 10 übernehmen“? | **Entschieden (Joyce 2026-11-08):** automatisch über einen beim ersten Start angelegten, sichtbaren und löschbaren Workflow „Start: Top-10-Firmen übernehmen“ (einmalig nach dem ersten Radar-Lauf). Ersetzt für diesen Fall A10 |
| E4 | Zählt die Startliste aufs Kontingent? | Nein, „Startpaket“ (10 Firmen, Kennzeichen an der Aktivierung) |
| E5 | Versanddienst für Mails an Nutzer | **Richtung entschieden (Joyce 2026-11-08):** serverseitig über ein Mail-Abo des Betreibers, nicht über die App und nicht über Nutzerkontingente. Welches Abo: offen (Rückfrage an Joyce) |
| E6 | Double-Opt-in für Meldungsmails? | Ja, über die Willkommensmail |
| E7 | Freemail-Nutzer: Website im Chat erfragen oder optionales Feld „Firmenwebsite“ in der Registrierung? | Beides: optionales Feld, sonst fragt der Chat |
| E8 | Gilt O1 auch für Nutzer, die einer bestehenden Organisation beitreten? | Ja, die Analyse ist je Domain zwischengespeichert, also ohne Zusatzkosten |

## 5. Stufen

### O0 — Einrichtungsstand und Messung (≈1 Tag)
- Gateway-Tabelle `OnboardingStand` je actorId: erledigte Schritte mit Zeitstempel
  (registriert, Analyse fertig, ICP bestätigt, Radar fertig, Startliste übernommen,
  Verbindung, Workflow, erste Mail). Nur Merkmale, keine Inhalte.
- Desktop meldet Schritte (`POST /v1/onboarding/schritt`); die Checkliste in O6 liest
  denselben Stand.
- Konsole (ava-admin): Liste „Neue Nutzer“ mit Trichter und „hängt seit X Tagen bei
  Schritt Y“. So sieht das Team, wen es aktiv anrufen sollte (Alessandro-Fälle), ohne
  sich um alle kümmern zu müssen.
- Kennzahl: Zeit bis zum ersten sichtbaren Ergebnis (Ziel unter 5 Minuten nach dem
  Assistenten).

### O1 — Start-Analyse sofort beim Registrieren (Gateway, ≈3–4 Tage)
**Auslöser: alle Registrierungswege laufen im Gateway zusammen.**
- Desktop: nach erfolgreichem `POST /v1/auth/register` einen Auftrag anlegen und sofort
  zurückkehren; die Registrierung wartet nie auf die Analyse.
- Website: `ava-website/app/api/register` ruft künftig das Gateway
  (`POST /v1/auth/register`) statt Keycloak direkt. Dann gibt es eine Stelle für
  Anlegen, Ratenlimit und Auftrag. Die TODO-Ratenbremse der Website entfällt damit. Push
  der Website macht Joyce.
- Rückfall für alle anderen Wege (Keycloak-Seite der Konsole): Beim ersten Anlegen des
  Mitglieds in `ensureTenantForAuth` einen Auftrag anlegen, falls es noch keinen gibt.
- Kein neuer Fly-Server: Die Arbeit ist leicht (Seitenabrufe und wenige KI-Aufrufe) und
  läuft im Gateway nach dem Muster des Vorabanalyse-Läufers. Ein eigener Server erst, wenn
  die Last das zeigt.

**Auftrag und Wiederholungen.**
- Tabelle `StartAuftrag` (actorId eindeutig, E-Mail-Domain, status, versuch,
  `naechsterVersuchAm`, letzterFehler). Der Läufer holt fällige Aufträge per
  `FOR UPDATE SKIP LOCKED`. Das hält auch Neustarts und eine zweite Maschine aus, weil
  die Wartezeiten in der Datenbank stehen und nicht im Speicher.
- Wiederholungen je Teilschritt (Seite laden, Websuche, KI): **sofort, nach 10 Sekunden,
  nach 2 Minuten, nach 10 Minuten**, danach `fehlgeschlagen`.
  - Wiederholt wird bei Netzfehlern, Zeitüberschreitung, 403, 404 (oft nur
    Bot-Abwehr/kurzzeitig), 408, 429 und 5xx.
  - Vor dem nächsten Versuch die Varianten durchprobieren: `https://domain`,
    `https://www.domain`, `http://`, anderer User-Agent.
  - Nicht wiederholt wird bei endgültigen Befunden: Freemail, Domain ohne DNS, geparkte
    Seite, zu wenig Text.
- Fehlgeschlagen heißt nicht verloren: Der erste Chat fragt dann nach der Website (O2),
  die Konsole zeigt den Fall (O0).

**Ablauf je Auftrag.**
1. **Domain prüfen:** Freemail-Liste (neu, gemeinsam für Gateway und App: gmail,
   googlemail, outlook, hotmail, live, msn, yahoo, icloud, me, aol, gmx, web.de,
   t-online, freenet, arcor, posteo, mailbox.org, proton/protonmail, online.de, 1und1
   und weitere) plus die Baukasten-Regel. Freemail: Status `freemail`, fertig, keine
   Verarbeitung.
2. **Eigene Website lesen und ICP ableiten:** `icpAusWebsite()` mit Referenzkunden.
3. **Eigenes Firmenprofil:** die Firma des Nutzers im Bestand finden (Register über Name
   und Ort aus dem Impressum, sonst `WEB_<DOMAIN>`-Firma nach dem Muster von
   `firma_finden`) und mit Kurzprofil festhalten. Das ist der Steckbrief „So sieht AVA
   dein Unternehmen“.
4. **Referenzkunden, bis zu 5:**
   - Steht ein Link auf der Website, die Domain daraus nehmen. Sonst Namen und Ort per
     Betreiber-Websuche suchen und mit dem Website-Urteil der Vorabanalyse prüfen
     (Schwelle wie dort). Bleibt es unsicher, weglassen statt raten.
   - Je gefundener Website ein **Kurzprofil**: Name, Branche, Größenindiz, Standort,
     Leistungen, nach dem Muster von `analyzeCustomerSite`
     (`discovery/icp-assistant.ts:204`), auf den Server portiert.
   - **Keine Referenzen der Referenzen.** Die Kurzprofil-Funktion hat schon im Schema
     kein Referenzfeld, und der Ablauf kennt nur Tiefe 1: Referenzen werden ausschließlich
     aus der Website des Nutzers gelesen, nie aus einer Kunden-Website. Ein Test sichert
     das ab.
5. **Synthese:** ICP aus eigener Website plus Kurzprofilen der Referenzen, nach dem Muster
   von `synthesizeIcp` (`icp-assistant.ts:238`). Die Kundenbeispiele tragen die
   gefundenen Domains, damit der Radar die Ähnlichkeit zu echten Kunden nutzen kann.
6. Ergebnis in `StartAnalyse` je Domain (90 Tage zwischengespeichert, Kollegen derselben
   Firma teilen sie) und am Auftrag des Nutzers als Vorschlag zum einmaligen Abholen (O2).

**Grenzen.**
- Eine Analyse je Domain, Deckel je Tag (Umgebungsvariable), Kosten je Auftrag
  mitschreiben (`LlmUsage`, quelle `start-analyse`).
- Optionales Feld „Firmenwebsite“ in der Registrierung (Desktop und Website, E7). Es geht
  vor der E-Mail-Domain und wird auch bei Freemail-Adressen verarbeitet.
- Auf dem Server liegen nur Daten aus öffentlichen Websites, keine Eingaben des Nutzers.
  Das gehört in die Datenschutzerklärung.

### O2 — Einmalige Übernahme in die App und erster Chat (Desktop + Gateway, ≈2–3 Tage)
**Die Übernahme passiert genau einmal je Konto, nie wieder.** Abmelden und wieder
anmelden, App neu installieren, „Zurücksetzen“ oder ein zweiter Rechner dürfen einen
erarbeiteten ICP nie überschreiben. Drei Sperren:
1. **Server, atomar:**
   - `POST /v1/onboarding/start-icp/abholen` setzt
     `UPDATE … SET abgeholtAm = now(), abgeholtVon = <Instanz> WHERE actorId = … AND abgeholtAm IS NULL RETURNING vorschlag`.
   - Nur der allererste Aufruf bekommt den Vorschlag. Jeder spätere bekommt
     „schon übernommen“, auch von anderen Geräten und nach Neuinstallation.
2. **Lokal leer:** Die App holt nur ab, wenn lokal noch kein ICP existiert (keine
   `icp.json` oder alle Felder leer). Hat der Nutzer schon einen ICP, meldet die App
   `POST …/verwerfen`. Damit ist der Vorschlag auch serverseitig verbraucht und kommt nie
   mehr.
3. **Lokale Marke:** Nach dem ersten Prüfen setzt die App `startIcpGeprueft` in ihren
   Einstellungen und fragt nie wieder, selbst wenn der Server einmal falsch antworten
   sollte.

Danach speichert die App den ICP mit `quelle: "start-analyse"`. Der Server löscht den
Vorschlag am Auftrag nach dem Abholen; der Domain-Zwischenspeicher bleibt. Ist die Analyse
beim ersten Anmelden noch nicht fertig, fragt die App bei jedem Start erneut, aber nur bis
zum ersten Abholen oder Verwerfen. Tests decken genau diese Fälle ab: Abmelden/Anmelden,
zweites Gerät, Zurücksetzen, ICP schon vorhanden, Analyse noch läuft, Analyse
fehlgeschlagen.

**Erster Chat.**
- Eröffnet die App selbst, als fester Text mit den Daten, ohne KI:
  „Ich habe mir **eprox.de** angesehen: Ihr bietet …. Deine idealen Kunden sind ….
  Referenzen, die ich gefunden habe: … Ich habe das als dein Idealkundenprofil
  angelegt.“
- Darunter die Knöpfe **Passt so** (startet den Radar), **Anpassen** (öffnet den
  ICP-Assistenten, vorbefüllt) und **Später**.
- Daneben der Steckbrief der eigenen Firma („So sieht AVA dein Unternehmen“).
- Ohne Analyse (Freemail, keine Website, fehlgeschlagen) fragt der Chat in einem Satz
  nach der Website und startet O1 per `POST /v1/onboarding/start-analyse { website }`,
  mit Deckel je Nutzer. Rückfall: Angebot in eigenen Worten beschreiben oder diktieren,
  daraus wird `icp_aus_dokument`.

### O3 — Erster Radar-Lauf und Start-Workflow (Desktop, ≈2 Tage)
- Direkt nach der Übernahme des ICP (O2) startet der Rückstands-Lauf (Pro-Parameter, nicht
  aufs Kontingent). Der Fortschritt steht im Chat.
- **Start-Workflow (E3, Joyce 2026-11-08):** Beim ersten Start legt die App einmalig den
  Workflow „Start: Top-10-Firmen übernehmen“ an. Er ist sichtbar und löschbar und läuft
  einmal nach dem ersten Radar-Lauf: Treffer ab Mindestscore, die besten 10 →
  `discovery_decide` (übernehmen) → Mail „Deine Top 10“ (O5) → Hinweis im Chat.
  - Dafür braucht es einen neuen Auslöser „erster Radar-Lauf fertig“ (oder `radar.newHot`
    mit Kennzeichen Erstlauf) und eine Lauf-Grenze „nur einmal“.
  - Die lokale Marke `startWorkflowAngelegt` verhindert, dass er nach dem Löschen
    wiederkommt.
- Veränderungen zu diesen Firmen meldet danach das normale Meldungswesen; dafür ist kein
  eigener Workflow nötig.
- Ergebnis im Chat: die zehn übernommenen Firmen mit Ort, Branche und einem Satz, warum sie
  passen.
- Risiko: KI-Urteil über 120 Kandidaten auf einem lokalen Kleinmodell dauert. Für das
  Onboarding auf 40 Kandidaten begrenzen und den Rest im Hintergrund nachziehen. Erst
  messen, dann festlegen.

### O4 — Startpaket (Gateway/Abrechnung, ≈1 Tag)
- Die übernommenen Startfirmen bekommen ein Kennzeichen `startpaket`; sie zählen nicht
  auf Free-Aktivierungen und Monatskontingent (E4), höchstens 10 je Organisation, einmal.
- Vorher prüfen, ob P10 („aktiv/ruhend“) in Gateway und master-data deployt ist.

### O5 — E-Mails vom Server (Gateway, ≈3–4 Tage)
Joyce 2026-11-08: Das ist Betreiber-Sache, um Nutzer abzuholen, nicht etwas, das der Nutzer
einrichtet. Die App hat keinen Mailserver, und der Nutzer hinterlegt nach der Registrierung
kein Postfach. Also verschickt der Server.

- **Versand:** Gateway (`lib/mail-versand.ts`) über das Mail-Abo des Betreibers (Zugang als
  Fly-Secret), Absender auf ava.bi mit SPF/DKIM.
- **Empfänger:** immer die Registrierungsadresse des Kontos, die der Server kennt. Freie
  Empfänger gibt es nicht.
- **Vorlage:** schickes HTML in den Markenfarben (#F2F7F6 / #00C0A7 / #0A1F2A), getestet
  für Outlook und Gmail, mit Textfassung. Fundstellen sind immer verlinkt, und jede Mail
  hat einen Abmeldelink.
- **Mails:**
  1. **Willkommen** direkt nach der Start-Analyse, rein serverseitig, also auch für
     Website-Registrierungen ohne installierte App: „So sieht AVA eproX“, ICP-Kurzfassung,
     Referenzen, Download-Knopf, Knopf „Neuigkeiten per E-Mail erhalten“ (Double-Opt-in,
     E6).
  2. **„Deine Top 10“** nach dem ersten Radar-Lauf. Die App meldet nur die Liste (Name,
     Ort, Grund) an `POST /v1/onboarding/mail/top10`, der Server schickt die Mail.
  3. **Neuigkeiten-Übersicht** höchstens 1 je Tag zu Meldungen über die Firmen in „Meine
     Firmen“. Neuer Kanal „E-Mail“ im `NotificationManager` →
     `POST /v1/benachrichtigungen/mail`.
- Mails 2 und 3 entstehen, solange AVA irgendwo läuft (Desktop oder `headless-ava`), weil
  Radar und Meldungen dort gerechnet werden.
- Einstellung in „Meldungen“ (an/aus) **und** ein Chat-Werkzeug (Regel „Self-Service im
  Chat“).

### O6 — Einrichtungs-Begleiter im Chat (Desktop, ≈3–4 Tage)
- Gespeicherte Checkliste (Stand aus O0), sichtbar als schmale Leiste „Einrichtung 3 von
  6“ über dem Eingabefeld. Ein Klick fragt AVA nach dem nächsten Schritt.
- Schritte:
  1. ICP
  2. Erste Firmen
  3. CRM verbinden (Close, HubSpot)
  4. Ansprache-Werkzeug (CompLeadly)
  5. Postfach oder Telegram
  6. **„Erzähl mir, wie dein Vertrieb läuft“**: Diktat, daraus ein Workflow-Entwurf mit
     Zeitplan.
- Close und CompLeadly kommen in den Nutzerstand der Vorschläge.
- Neues Werkzeug `workflow_erklaeren`: übersetzt einen Workflow in Alltagssprache, etwa
  „Jeden Morgen um 8 Uhr schaue ich bei CompLeadly nach neuen Leads, recherchiere die
  Firma, lege sie in Close an und schreibe dir, wenn etwas Wichtiges dabei ist. Das läuft,
  solange AVA geöffnet ist.“ AVA nutzt es nach jedem `workflow_save` von selbst.
- Inhalt aus den L2-Karten (Erste Schritte, ICP, Close, CompLeadly, Workflows). Die
  Abläufe der Schritte als eigene Karten mit Aktionen.

### O7 — Alessandros Ablauf schließen (Desktop, ≈3–5 Tage)
- CompLeadly-Ereignis für eine unbekannte Firma: Firma über Domain oder Name importieren
  (`import_companies`) und den Workflow danach mit der neuen companyId fortsetzen.
- Werkzeug-Rolle „Lead/Kontakt anlegen“ für Close (und HubSpot); Vorlage „Neuer Lead aus
  CompLeadly → recherchieren → in Close anlegen → Meldung“.
- Dienst-Ereignisse als echte Meldung, damit sie auf Telegram, dem Handy und per Mail
  ankommen.
- Mit Alessandros echtem Zugang prüfen: CompLeadly-Werkzeugnamen und ob Webhooks
  (Premium) gehen. Ohne Webhook stündlich abfragen.

### O10 — Radar-Kurzprofil als Ersatz auf der Firmenseite (Gateway, Desktop, Web-App, ≈2 Tage)
Joyce 2026-11-08: Solange die echte Verarbeitung (Profil-, Website-Producer) für eine Firma
noch nichts geliefert hat, zeigt die Firmenseite in der Desktop-App und in der Web-App
an dieser Stelle das Mini-Profil und die Website aus dem Firmen-Radar. Das Ergebnis der
echten Verarbeitung hat immer Vorrang und ersetzt den Ersatz, sobald es da ist.
- **Nur bei sicherer Zuordnung:** Der Ersatz erscheint ausschließlich, wenn der
  Radar-Kandidat eindeutig dieser Firma (companyId aus dem Register) zugeordnet ist, so wie
  der Radar die Zuordnung heute schon als geklärt hervorhebt. Gleiche Namen sind häufig;
  ein reiner Namenstreffer genügt nie. Ohne sichere Zuordnung bleibt die Seite wie heute.
- Kennzeichnung auf der Seite: „Kurzprofil aus dem Firmen-Radar, die vollständige
  Auswertung läuft“.
- Eine Stelle im Gateway liefert den Ersatz, damit Desktop und Web-App gleich arbeiten.

**Mails (Joyce 2026-11-08):** Links in Mails gehen nur auf eine konkrete Firma in der
Web-App (`app.ava.bi/firmen/<companyId>`), keine allgemeinen „In AVA ansehen“-Knöpfe.
Die Mail „Deine Top 10“ geht erst raus, wenn die Firmen verarbeitet sind (oder nach 24 h).

### O9 — Workflow-Bausteine vollständig (Desktop, ≈2–3 Tage)
Joyce: Alles, was man für echte Abläufe braucht, muss da sein, auch „es gibt keinen Lead“.

**Vorhanden** (`workflows/runner.ts:783-962`, `store.ts`):

| Baustein | Stand |
|---|---|
| Wenn/Sonst | `if` (Ja- und Nein-Ausgang) |
| Mehrfachverzweigung | `switch` mit Standard-Ausgang |
| Filter | `filter` |
| Schleife | `loop` in Paketen (`batchSize`), dazu `subworkflow` je Firma |
| Zusammenführen | `merge` |
| Warten | `wait`: Minuten bis 7 Tage oder bis ein Import fertig ist |
| Abbrechen | `stop` |
| Freigabe durch den Menschen | `human` |
| KI-Schritt | `ai` |
| Werkzeuge, auch MCP-Dienste | `tool` |
| Felder umbauen | `transform` |
| Fehler | je Node `onError` (stop, continue, errorOutput = eigener Fehler-Ausgang), Wiederholungen `maxTries` bis 5 mit `waitBetweenTriesSec` bis 600 |
| Auslöser | manuell, Chat, Zeitplan (`intervalMinutes`, Uhrzeit `at`, Wochentage), Ereignisse (`alert.created`, `radar.newHot`, `mail.inbound`, `import.finished`, `linkedin.lead`, `dienst.ereignis`) |

**Lücken, die O9 schließt:**
1. **Takt:** Minimum bleibt 15 Minuten (Joyce 2026-11-08, reicht aus). Klartext-Vorgaben
   „alle 15 Minuten / stündlich / alle 24 Stunden / werktags um 8“ als feste Abbildung im
   Werkzeugtext, damit das Modell nicht rät; bei kurzen Abständen im Entwurf erst prüfen,
   ob es Neues gibt (`if`), dann rechnen.
2. **Kein Zweig für „nichts gefunden“.** Liefert ein Schritt keine Einträge, laufen alle
   folgenden Nodes nicht (wie in n8n). Ein `if` sieht den Fall gar nicht, weil es keine
   Einträge zum Prüfen gibt. Neu:
   - Option `wennLeer` an jedem Node mit den Werten `nichts` (wie heute), `leerer Eintrag`
     und `eigener Ausgang`. Damit gibt es Zweige wie „kein neuer Lead → nur
     Tagesnotiz“ oder „Lead da → recherchieren“.
   - Dazu im Ausdrucksumfang `$items.length`, damit `if` auf Anzahlen prüfen kann.
3. **Ereignis ohne Firma** (CompLeadly-Lead einer unbekannten Firma): siehe O7. Das
   Ereignis bleibt ein Eintrag mit den Lead-Daten statt stillschweigend zu entfallen.
4. **Modell kennt die Bausteine:** Die `workflow_save`-Beschreibung nennt `wennLeer`,
   den Fehler-Ausgang und die Zeitplan-Abbildung. `workflow_erklaeren` (O6) sagt auch,
   was im Leer- und Fehlerfall passiert.
5. **Abnahme an echten Abläufen:** je ein Test-Workflow für
   - „CompLeadly-Lead → Firma importieren → recherchieren → in Close anlegen“,
   - denselben Ablauf ohne neuen Lead,
   - „Fehler bei Close → Meldung statt Abbruch“,
   - „alle 5 Minuten Posteingang prüfen“.
   Jeweils als Probelauf (`dryRun`) und einmal echt.

### O8 — Begleitetes Onboarding durch das Team (kein Code, ≈½ Tag)
- Leitfaden für einen 30-Minuten-Termin bei Schlüsselkunden. Er folgt den Schritten aus
  O6, der Kunde diktiert seinen Ablauf selbst, am Ende steht ein laufender Workflow.
- Auswahl, wen wir anrufen, über die Konsolenliste aus O0.

## 6. Reihenfolge

1. Zuerst **O1 + O2 + O3**: der Wow-Moment für alle neuen Nutzer, ≈1 Woche.
2. Parallel **O8** für Alessandro: der Mensch hilft sofort, und dabei sammeln wir, was O6
   und O7 brauchen.
3. Danach **O9 + O0 + O6 + O7** (O9 zuerst, weil O7 und der Begleiter darauf bauen).
4. **O5** zuletzt, wenn E5/E6 entschieden sind: neuer Anbieter, Double-Opt-in und
   Datenschutzerklärung brauchen Vorlauf.
5. **O4** mit O3, sobald E3/E4 entschieden sind.

Gesamt grob 4–5 Wochen.

## 7. Risiken

- **Falsches ICP aus dünnen Websites.** Gegenmittel: Bestätigung mit einem Klick, im Text
  offen sagen, worauf es beruht („aus 5 Seiten von eprox.de“), Lücken benennen statt
  raten.
- **Missbrauch durch fremde Adressen.** Analysiert wird nur Öffentliches, mit Deckel je
  Domain und je Tag. Mails gibt es nur nach Double-Opt-in.
- **Lokale Modelle sind langsam** (O3): erst messen, den Onboarding-Lauf kleiner fahren.
- **Workflows laufen nur bei geöffneter App:** immer dazusagen, später `headless-ava`
  anbieten.
- **ICP überschrieben:** die größte Sorge (Joyce). Gegenmittel sind die drei Sperren aus O2
  und Tests für jeden Wiedereinstieg. Es gibt keinen Weg, die Start-Analyse später
  erneut in die App zu schreiben; ein neuer Vorschlag ginge nur über den ICP-Assistenten
  und dessen Bestätigung.
- **Fremde Websites blocken Abrufe (403):** Wiederholungen mit Varianten; bleibt es dabei,
  fragt der Chat statt zu raten.
