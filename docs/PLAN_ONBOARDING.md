# Plan: Onboarding — AVA nimmt neue Nutzer an die Hand

Stand 2026-11-08. Anlass: Sprachnachricht Joyce vom 2026-11-06 (6:41 Min., lokal
transkribiert) nach den Erfahrungen mit Alessandro (Close + CompLeadly) und Strategic IT.

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
- Über die Konsole kann man sich auch auf der Keycloak-Seite registrieren; diese Nutzer
  laufen nie über `/v1/auth/register`, wohl aber über `/whoami`.
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
- Liegt nur lokal (`userData/agent/icp.json`, `agent/icp-store.ts`), wird nie
  synchronisiert. Der Radar braucht Orte, Branchen und Beschreibung oder Angebot
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
2. **Stilles Speichern des ICP.** Der ICP-Plan verbietet das. Vorschlag: still
   *analysieren*, aber mit einem Klick *bestätigen* lassen. Das ist genauso schnell und
   bleibt ehrlich.
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
| E1 | Start-Analyse auf dem Server als neue Betreiber-Ausnahme (je Domain einmal, Deckel je Tag)? | Ja, als D14 in DECISIONS |
| E2 | ICP still speichern oder mit einem Klick bestätigen? | Ein Klick „Passt so“; der Radar startet direkt danach |
| E3 | Top 10 automatisch übernehmen (Abweichung von A10) oder ein Klick „Alle 10 übernehmen“? | Ein Klick; bei Bedarf später automatisch |
| E4 | Zählt die Startliste aufs Kontingent? | Nein, „Startpaket“ (10 Firmen, Kennzeichen an der Aktivierung) |
| E5 | Versanddienst für Mails an Nutzer | Microsoft 365 der eproX über Graph (kein neuer Anbieter, Absender z. B. ava@ava.bi) oder ein EU-Transaktionsdienst; beides geht |
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

### O1 — Start-Analyse aus der E-Mail-Domain (Server, ≈2–3 Tage)
- Auslöser: nach erfolgreichem `POST /v1/auth/register` (fire-and-forget), als Rückfall
  beim ersten Anlegen des Mitglieds in `ensureTenantForAuth` (erfasst auch
  Keycloak-Registrierungen).
- Domain aus der Adresse. Ausgeschlossen wird über eine neue gemeinsame Freemail-Liste:
  gmail, googlemail, outlook, hotmail, live, msn, yahoo, icloud, me, aol, gmx, web.de,
  t-online, freenet, arcor, posteo, mailbox.org, proton/protonmail, online.de, 1und1
  und weitere, plus die Baukasten-Regel. Dazu ein Website-Gate: Domain erreichbar, keine
  geparkte Seite (`firmen-web/domain-gate` wiederverwenden).
- Tabelle `StartAnalyse` je Domain (öffentliche Daten, 90 Tage zwischengespeichert,
  mehrere Nutzer derselben Firma teilen sie). Sie enthält:
  - den ICP-Vorschlag aus `icpAusWebsite` mit Referenzen;
  - die eigene Firma im Bestand über die Domain: Register-Treffer oder `WEB_`-Firma, für
    den Steckbrief;
  - den Status (läuft / fertig / keine Website / Freemail).
- Ablauf im Gateway nach dem Muster des Vorabanalyse-Läufers: DB-Polling mit SKIP LOCKED,
  damit es bei mehreren Maschinen nicht doppelt läuft. Kein `setInterval` ohne Sperre.
- Grenzen: eine Analyse je Domain, Deckel je Tag (Umgebungsvariable), Ratenlimit je IP
  über die bestehende Register-Bremse.
- Route `GET /v1/onboarding/start-analyse` für die App. Bei Freemail-Nutzern oder
  abweichender Website zusätzlich `POST /v1/onboarding/start-analyse { website }`, mit
  Deckel je Nutzer.
- Optionales Feld „Firmenwebsite“ in `SignUpForm.tsx` (E7), geht an die Registrierung mit.
- Der bestätigte und bearbeitete ICP bleibt wie bisher nur lokal. Auf dem Server liegt nur
  der Vorschlag aus öffentlichen Daten. Das gehört in die Datenschutzerklärung.

### O2 — Erster Chat mit fertigem Ergebnis (Desktop, ≈2–3 Tage)
- Nach dem Assistenten holt die App die Start-Analyse und eröffnet den ersten Chat selbst
  (fester Text plus Daten, keine KI nötig):
  „Ich habe mir **eprox.de** angesehen: Ihr bietet …. Deine idealen Kunden sind ….
  Referenzen, die ich gefunden habe: …“ Darunter die ICP-Karte mit den Knöpfen
  **Passt so**, **Anpassen** (ICP-Assistent, vorbefüllt) und **Später**.
- Gleich daneben der Steckbrief der eigenen Firma („So sieht AVA dein Unternehmen“).
- Gibt es keine Analyse (Freemail, keine Website): Der Chat fragt in einem Satz nach der
  Website und startet O1 per POST. Als Rückfall kann der Nutzer sein Angebot in eigenen
  Worten beschreiben oder diktieren, daraus wird `icp_aus_dokument`.
- „Passt so“ speichert lokal (`icp_set`, quelle „assistent“), samt Kundenbeispielen.
- Ist die Analyse noch nicht fertig, wenn der Chat aufgeht: kurzer Fortschritt, dann
  nachladen. Nie leere Startseite.

### O3 — Erster Radar-Lauf automatisch (Desktop, ≈1–2 Tage)
- Direkt nach „Passt so“ startet der Rückstands-Lauf (Pro-Parameter, nicht aufs
  Kontingent). Der Fortschritt steht im Chat.
- Ergebnis im Chat: die zehn besten Treffer mit Ort, Branche und einem Satz, warum sie
  passen, plus die Knöpfe **Alle 10 übernehmen** und **Auswählen** (E3), über die
  L4-Knöpfe und `discovery_decide`.
- Risiko: KI-Urteil über 120 Kandidaten auf einem lokalen Kleinmodell dauert. Für das
  Onboarding auf 40 Kandidaten begrenzen und den Rest im Hintergrund nachziehen. Erst
  messen, dann festlegen.

### O4 — Startpaket (Gateway/Abrechnung, ≈1 Tag)
- Die übernommenen Startfirmen bekommen ein Kennzeichen `startpaket`; sie zählen nicht
  auf Free-Aktivierungen und Monatskontingent (E4), höchstens 10 je Organisation, einmal.
- Vorher prüfen, ob P10 („aktiv/ruhend“) in Gateway und master-data deployt ist.

### O5 — Meldungen per E-Mail (Server und Desktop, ≈3–4 Tage)
- Versand im Gateway (`lib/mail-versand.ts`, Anbieter nach E5), Absender auf ava.bi mit
  SPF/DKIM.
- Mails:
  1. **Willkommen**: was AVA über die Firma weiß (ICP-Kurzfassung) und Double-Opt-in-Knopf
     (E6).
  2. **Radar-Fund**: die besten Treffer mit Begründung, gleich nach O3.
  3. **Tagesübersicht**: neue Meldungen, höchstens 1 je Tag; Fundstellen immer
     verlinkt.
- Desktop: neuer Kanal „E-Mail“ im `NotificationManager` →
  `POST /v1/benachrichtigungen/mail`. Der Server sendet nur an die eigene, bestätigte
  Adresse des Kontos und nimmt keine freien Empfänger an.
- Einstellung in „Meldungen“ (an/aus, Tagesübersicht/sofort) **und** ein Chat-Werkzeug
  (Regel „Self-Service im Chat“). Abmeldelink in jeder Mail.
- Ehrlich dazuschreiben: Meldungen kommen, solange AVA läuft.

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

### O8 — Begleitetes Onboarding durch das Team (kein Code, ≈½ Tag)
- Leitfaden für einen 30-Minuten-Termin bei Schlüsselkunden. Er folgt den Schritten aus
  O6, der Kunde diktiert seinen Ablauf selbst, am Ende steht ein laufender Workflow.
- Auswahl, wen wir anrufen, über die Konsolenliste aus O0.

## 6. Reihenfolge

1. Zuerst **O1 + O2 + O3**: der Wow-Moment für alle neuen Nutzer, ≈1 Woche.
2. Parallel **O8** für Alessandro: der Mensch hilft sofort, und dabei sammeln wir, was O6
   und O7 brauchen.
3. Danach **O0 + O6 + O7**.
4. **O5** zuletzt, wenn E5/E6 entschieden sind: neuer Anbieter, Double-Opt-in und
   Datenschutzerklärung brauchen Vorlauf.
5. **O4** mit O3, sobald E3/E4 entschieden sind.

Gesamt grob 3–4 Wochen.

## 7. Risiken

- **Falsches ICP aus dünnen Websites.** Gegenmittel: Bestätigung mit einem Klick, im Text
  offen sagen, worauf es beruht („aus 5 Seiten von eprox.de“), Lücken benennen statt
  raten.
- **Missbrauch durch fremde Adressen.** Analysiert wird nur Öffentliches, mit Deckel je
  Domain und je Tag. Mails gibt es nur nach Double-Opt-in.
- **Lokale Modelle sind langsam** (O3): erst messen, den Onboarding-Lauf kleiner fahren.
- **Workflows laufen nur bei geöffneter App:** immer dazusagen, später `headless-ava`
  anbieten.
