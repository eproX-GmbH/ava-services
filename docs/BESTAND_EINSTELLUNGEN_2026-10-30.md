# Settings-UI (/settings): Bestandsaufnahme der Texte und Struktur

**Abkürzungen für Pfade** (Basis `/Users/mac/Desktop/Repos/ava-services/services/desktop/src/renderer/src/`):
- `S:` = `routes/Settings.tsx` (5673 Zeilen)
- `s/X:` = `routes/settings/X.tsx`
- `c/X:` = `components/X.tsx`
- `SK:` = `routes/SettingsSkills.tsx`
- `CSS:` = `styles.css`

Texte sind wörtlich übernommen. Zeilenumbrüche aus dem JSX sind zu Leerzeichen zusammengezogen, dynamische Teile stehen als `{…}`.

---

## 0. Rahmen: Kopfzeile und Tab-Liste

**SettingsHeader** (`S:536-560`), auf jedem Tab sichtbar:
- Eyebrow: „Konfiguration“
- Titel: „Einstellungen“
- Lede: „Anbieter, Modelle, Integrationen und Datenpflege: alles, was die Pipeline und der Agent zur Laufzeit erwarten.“
- Versionszeile: „AVA v{version}{ · channel}{ · dev}“ (`S:553-555`)

**SETTINGS_TABS** (`S:160-170`), Reihenfolge:

| Nr. | id | Label | Datei |
|---|---|---|---|
| 1 | konto | Konto | `s/KontoTab` |
| 2 | modelle | Modelle | `s/ModelleTab` |
| 3 | verbrauch | Verbrauch | `s/VerbrauchTab` |
| 4 | datenquellen | Datenquellen | `s/DatenquellenTab` |
| 5 | automatisierungen | Automatisierungen | `s/AutomatisierungenTab` |
| 6 | wissensquellen | Wissensquellen | `s/WissensquellenTab` |
| 7 | skills | Skills | `s/SkillsTab` → `SK` |
| 8 | verlauf | Verlauf | `s/VerlaufTab` |
| 9 | system | System | `s/SystemTab` |

---

## 1. Tabs und Abschnitte: Überschriften und Intro-Texte (Kern)

### Tab 1: Konto (`s/KontoTab:17-37`). 8 Abschnitte, davon 1 bedingt und 1 leer

**1.1 PlanSection.** `#plan-section`, Klasse `ct-card`, nicht `provider-section`.
- Ausgeblendet bei Tarif `enterprise` (`S:5349`).
- Zwei Varianten:
  - Organisation zahlt (Seat): `S:5357-5422`
  - Einzeltarif: `S:5429-5660`
- H3: „Plan & Abrechnung“ (`S:5363` / `S:5432`)
- Intro Seat: „Dein Zugang wird über die Sammelabrechnung deiner Organisation bezahlt.“ (`S:5364`)
- Intro Einzeltarif: „Aktueller Tarif und Verbrauch im Abrechnungszyklus.“ (`S:5433`)

**1.2 ProfileSection.** Section ohne id. Die Sprungmarken liegen auf den Eingabefeldern (`profile-bio`, `profile-role`, …). Klassen `provider-section alerts-prefs`.
- H3: „Profil“ (`S:3281`)
- Intro: „Wird in jeden Agenten-Turn als Lese-Kontext eingewoben. Der Agent passt Antworten daran an. Felder optional; was du ausfüllst, beeinflusst Tonfall, Filter und Priorisierung.“ (`S:3282-3286`)

**1.3 LinkedInCalibrationNote.** `#signal-kalibrierung`. Nur wenn die Funktion `linkedin.beobachter` für die Organisation freigegeben ist (`s/KontoTab:23`).
- H3: „Signal-Kalibrierung“ (`S:3115`)
- Intro: „Was AVA aus deinem 👍/👎-Feedback (auf der LinkedIn-Seite) über deine Signalstärke-Vorlieben gelernt hat. Es fließt automatisch in die Bewertung neuer Signale ein — und damit auch in die Benachrichtigungen. Du kannst es ansehen, anpassen oder zurücksetzen.“ (`S:3116-3121`)

**1.4 GeneralMemorySection.** `#general-memory`.
- H3: „Langzeitgedächtnis“ (`S:5026`)
- Intro: „Fakten, die der Agent über Konversationen hinweg gespeichert hat (Präferenzen, laufende Aufgaben, Dinge, an die er sich erinnern soll). Er ruft sie über `recall_memory` ab, wenn eine Frage auf früheren Kontext hindeutet. Einträge, die der Agent nicht mehr kennen soll, kannst du entfernen.“ (`S:5027-5033`)

**1.5 KonsoleSection.** `#organisation` (`s/KonsoleSection:17-30`).
- H3: „Organisation“
- Intro (dynamisch): „{Du bist {Owner|Admin|Mitglied} in {Name|einer Organisation}. | Du arbeitest in deinem persönlichen Bereich. }Mitglieder, Vorgaben, Organisationsschlüssel, Limits und Abrechnung verwaltest du in der AVA Konsole im Browser; dort legst du auch eine Organisation an oder trittst einer bei.“ (`:20-24`)
- Rollenlabels `ROLLEN` (`:10`): „Owner“, „Admin“, „Mitglied“

**1.6 InstanzenSection.** `#instanzen` (`s/InstanzenSection:92-173`).
- H3: „Deine AVAs“
- Intro: „AVA kann auf diesem Rechner und auf einem Server laufen. Hier siehst du, welche Instanz gerade läuft, welcher Telegram-Bot wo hängt (je Bot nur eine Instanz), wo das Firmen-Radar arbeitet und welche Instanz die Aufrufe aus Claude oder ChatGPT beantwortet (Server vor Desktop).“ (`:94-98`)
- Fußtext: „Umzug: Überträgt alles, was AVA lokal hält, auf die andere Instanz und überschreibt dort den Stand. So wechselst du jederzeit zwischen Desktop- und Serverbetrieb. Anmeldung, Telegram-Bot und Abo-Anmeldungen bleiben je Instanz.“ (`:169-172`)

**1.7 VerbindungenSection.** `#verbindungen` (`s/VerbindungenSection:38-86`).
- H3: „Verbundene Dienste“
- Intro: „Claude, ChatGPT oder Claude Code können AVA über MCP nutzen: Firmen lesen, Meldungen abrufen, Importe und Recherchen anstoßen. Du verbindest sie dort mit der Adresse `https://mcp.ava.bi` und meldest dich mit deinem AVA-Konto an. Jeder Dienst sieht nur deine eigenen Daten; die Verarbeitung läuft weiter auf diesem Rechner.“ (`:40-45`)

**1.8 „Erscheinung“.** `#erscheinung` (`s/KontoTab:28-35`).
- Leere `<section class="provider-section">` ohne Überschrift und ohne Text, als Stub für „Phase U2“.
- Sichtbar ist nur eine Trennlinie (border-top).

### Tab 2: Modelle (`s/ModelleTab:14-22`). 4 Abschnitte

**2.1 ProviderSection.** `#provider-section` (`S:2010-2444`). Sehr lang, mit verschachtelten Teilen.
- H3: „Modelle“ (`S:2142`). Während des Ladens bzw. bei Fehler heißt sie „Agent-Anbieter“ (`S:2051`, `S:2059`).
- Kein Intro-Text unter der H3.

Unterteile in Reihenfolge:

a) **ChatGPT-Abo-Karte** `#chatgpt-abo`, nur wenn `chatgptPlan.erlaubt` (`S:2151`). H4: „ChatGPT-Abo“ (`S:2565`). Intro (`S:2566-2573`):
> „Melde dich mit deinem persönlichen ChatGPT-Konto an. **Eligible AI requests in this app use your ChatGPT plan.** Chat, Radar, Alarme, Recherche und Workflows laufen dann über dein Plus- oder Pro-Kontingent, mit einem Modell deiner Wahl. Die Firmenverarbeitung (Profile, Kontakte, Jahresabschlüsse) läuft über AVAs eigenes Modell und braucht keinen Zugang von dir. Nicht über das Abo laufen Sprachmodus und Deep Research; dafür braucht es einen API-Schlüssel oder den Schlüssel deiner Organisation. Nutzung und Limits verwaltest du in ChatGPT → Settings → Usage.“

b) **Karte „Aktive Konfiguration“** (`S:2168-2214`), ohne Überschrift. Zeilen-Labels:
- „Chat-Modell“ / „Aktives Modell“
- „Chat über“ / „Abrechnung über“
- „Hintergrund über“
- „Firmenverarbeitung über“
- „Status“

c) **Karte „Organisationsvorgabe“**, nur bei `providerLock` (`S:2216-2231`):
> „Anbieter, Schlüssel und Modell legt deine Organisation fest. {Chat: `model`.} {Hintergrund: `model`.} Aufrufe laufen über den Schlüssel der Organisation. {Dein persönliches ChatGPT-Abo ist freigegeben und hat im Chat und in der Hintergrund-KI Vorrang; die Firmenverarbeitung läuft über AVAs Modell.}“

d) **„Anbieter & Modell wählen“**, H4, nur ohne Anbieter-Sperre (`S:2236`). Erklärtext (`S:2366-2374`):
> „Die Hintergrund-Verarbeitung (Jahresabschlüsse, Firmenprofile, Publikationen) schickt **tausende Textblöcke pro Firma** an das Modell — ein einzelner Jahresabschluss kann über 1.000 Abschnitte haben. Hier lohnt sich ein **günstiges, schnelles Modell**: Es geht um einfaches Heraussuchen von Kennzahlen, nicht um komplexes Denken. Im Chat kannst du trotzdem das starke Modell behalten. Ohne eigene Wahl wird das oben gewählte Modell verwendet.“

e) **Warnung Verflechtungen**, nur bei Funktion `verflechtungen` und zu schwachem Modell (`S:2354-2364`):
> „**Firmen-Verflechtungen sind mit diesem Modell blockiert.** {Label hat Stufe C/B/A/S{ und versteht keine Bilder}. | Kein Modell für die Hintergrund-Verarbeitung gewählt.} Gesellschafterlisten sind gescannte Dokumente; schwächere Modelle lesen Namen falsch, deshalb lädt AVA sie erst ab einem Bild-Modell der Stufe A (zum Beispiel GPT-5.6 Luna, Claude Sonnet, Gemini Flash). Wähle oben ein solches Modell für die Hintergrund-Verarbeitung, dann läuft die Auswertung automatisch mit.“

f) **Klappbereich** (`<details>`): „API-Schlüssel (OpenAI, Anthropic, Google, Mistral, …) — nötig für die Hintergrund-Verarbeitung“ (`S:2403`). Darin 7 ApiKeyCards. Unter OpenAI zusätzlich die AzureOpenAIKarte, unter Anthropic der AnthropicTierBanner.

g) **Klappbereich**: „Lokal installierte Modelle (Ollama)“ (`S:2438`). Darin InstalledModelsSection, H4 `#installed-models` „Lokale Modelle auf der Festplatte“ (`S:2676` / `S:2731`).

**2.2 ResearchFeaturesSection.** `#research-features` (`s/ResearchFeaturesSection:100-187`).
- Überschrift als **H2** (alle anderen Abschnitte nutzen H3): „Erweiterte Recherche-Funktionen“ (`:94`, `:102`)
- Intro (`:103-111`): „Aktiviert zusätzliche LLM-gestützte Anreicherung pro Firma. Standard ist kostengünstig (~0,02–0,15 € je Firma), Deep Research dagegen gründlicher, aber spürbar teurer.“, danach je nach Fall einer von drei Sätzen:
  - „Deine Organisation erlaubt nur ihren eigenen OpenAI-Schlüssel; der Verbrauch wird der Organisation zugerechnet.“
  - „Beide laufen auf deine Rechnung über deine eigenen Schlüssel (Standard auch über dein ChatGPT-Abo). Den OpenAI-Schlüssel deiner Organisation kannst du ausdrücklich wählen; dann trägt die Organisation die Kosten. AVA fakturiert nichts darüber.“
  - „Beide laufen auf deine Rechnung über Schlüssel, die du beim jeweiligen Anbieter selbst hinterlegst (Standard auch über dein ChatGPT-Abo) — AVA fakturiert nichts darüber.“
- Warnzeile (`:114-117`): „⚠ Verschlüsselter Schlüssel-Speicher ist auf diesem System nicht verfügbar. Schlüssel werden mit Basic-Cipher gesichert (auf macOS / Windows entspricht das normalerweise dem Default; nur bei minimal-installierten Linux-Systemen ein Hinweis).“
- Hinweisbox, wenn beide Funktionen aus sind (`:134-137`): „Beide Funktionen sind aktuell **deaktiviert** — dann liefern „Stellenanzeigen" und „Deep Research" pro Firma keine Ergebnisse. Stell sie unten auf **Standard**{ (mit deinem hinterlegten Schlüssel)}, um sie zu nutzen.“
- Karten (`:28-37`):
  - „Ausschreibungen, Expansion & Beschaffung“: „Findet öffentliche Tender, Expansionsankündigungen und Beschaffungsmeldungen zu einer Firma.“
  - „Stellenanzeigen“: „Findet aktuelle Job-Angebote auf Karriereseite, LinkedIn, StepStone, Indeed etc.“

**2.3 SprachmodusSection.** `#sprachmodus-section` (`s/SprachmodusSection:20-53`). Nur bei Funktion `sprachmodus` und wenn der Status geladen ist; sonst rendert der Abschnitt `null`.
- H3: „Sprachmodus“
- Intro (`:22-25`): „Mit AVA sprechen: Speech-to-Speech über OpenAI Realtime. AVA hört zu, antwortet mit ihrer Stimme und hat dieselben Werkzeuge wie im Chat. Gesprächsminuten kosten mehr als Chat (grob 0,20–0,40 € je Minute); nach {n} Sekunden Stille geht AVA in den Ruhezustand, dann läuft nichts weiter.“

**2.4 VoiceSection.** `#voice-settings` (`S:3440-3538`).
- H3: „Sprachmodell“ (`S:3479`)
- Intro: „Lokale Spracherkennung über Whisper. Modell wird auf der Festplatte gespeichert; Audio verlässt das Gerät nicht.“ (`S:3480-3483`)

### Tab 3: Verbrauch (`s/VerbrauchTab`). 1 Abschnitt, Klasse `verbrauch-tab` (nicht `provider-section`)

- H3: „Token-Verbrauch“ (`:49`)
- Intro (`:50-54`): „Lokale Aufzeichnung jeder LLM-Anfrage. Daten verlassen deine Maschine nicht. Aktuell werden nur Chat-Anfragen erfasst — Hintergrund-Aufgaben der Producer folgen im nächsten Update.“
- Unterblock `#verbrauch-limit`, H4 „Tägliches Token-Limit“ (`:207`). Text (`:208-213`): „Gemeinsame Obergrenze für Chat und Agent pro Tag (zählt Input + Output + Cache, UTC-Tag). Standard: kein Limit. Die laufende Anfrage wird immer fertig — ist das Tageskontingent danach erreicht, pausiert AVA neue Anfragen, bis du das Limit erhöhst oder entfernst.“
- Tabelle H4: „Modelle im Zeitraum“ (`:446`)

### Tab 4: Datenquellen (`s/DatenquellenTab:13-28`). 5 Abschnitte, davon 2 bedingt

**4.1 LinkedInSection.** `#linkedin-section`. Nur bei Funktion `linkedin.beobachter` (`S:1176-1949`).
- H3: „LinkedIn-Beobachter“ plus Pill „BETA“ (`S:1436-1439`)
- Intro (`S:1440-1448`): „Diese Funktion liest im Hintergrund deinen LinkedIn-Feed, um Vertriebssignale zu erkennen. Ihre Aktivierung verstößt gegen die LinkedIn-Nutzungsbedingungen — LinkedIn kann dein Konto deshalb sperren oder einschränken. Du bist als Verantwortliche/r für die DSGVO-konforme Verarbeitung der dabei beobachteten personenbezogenen Daten zuständig. Alle Daten bleiben ausschließlich auf diesem Gerät. [Datenschutz-Hinweise]“
- Fieldsets (Legenden):
  - „Verbindung“
  - „Bildanalyse“ (`#linkedin-image-analysis`, nur bei Funktion `bildanalyse`)
  - „Scan-Plan“
  - „Letzte Läufe“
  - „Erfasste Daten“
- H4: „Alle Daten löschen“
- Einwilligungsdialog: `c/LinkedInConsentModal:71-119` (Texte siehe Abschnitt 2)

**4.2 CrmSection.** `#crm-connections` (`S:979-1015`).
- H3: „CRM-Verbindungen“
- Intro (`S:997-1003`): „Verknüpfe dein CRM mit AVA. Die OAuth-Tokens bleiben verschlüsselt in deinem Betriebssystem-Schlüsselbund, niemals in der Cloud. Du kannst Verbindungen auch direkt im Chat herstellen, z. B. „Verbinde mein HubSpot-Konto“. Salesforce und Microsoft Dynamics sind verdrahtet und folgen in den nächsten Wochen.“

**4.3 MailAccountSection.** `#mail-account-section`. Nur bei Funktion `mail` (`s/MailAccountSection:184-407`).
- H3: „Mail-Konto“
- Intro (`:186-190`): „AVAs dediziertes IMAP/SMTP-Postfach. Eingehende Mails werden klassifiziert (Triage-Inbox) und nur Absender in der Allowlist dürfen autonome Aktionen auslösen.“
- Unterblock H4: „Allowlist — vertrauenswürdige Absender“ (`:525`). Text (`:526-529`): „Nur Mails von Absendern in dieser Liste darf AVA autonom beantworten. Pattern: `max@kunde.de` oder Domain-Wildcard `*@kunde.de`.“

**4.4 MailEntwurfSection.** `#mail-entwurf-section`, immer sichtbar (`s/MailEntwurfSection:24-57`). Rendert `null`, solange nicht geladen.
- H3: „Mail-Entwürfe“
- Intro (`:26-28`): „Unter jeder Mail, die AVA für dich formuliert, steht ein Knopf, der den Entwurf fertig öffnet: mit Empfänger, Betreff, Text und Anhängen.“
- Erklärtext (`:48-52`): „{Standard-Mailprogramm: X. | Kein Standard-Mailprogramm gefunden. }Automatisch heißt: Outlook bekommt einen fertigen Entwurf mit Anhängen; mit Anhängen und eingerichtetem Entwurfs-Postfach landet der Entwurf dort; sonst öffnet sich das Mail-Programm (ohne Anhänge) oder, ohne Mail-Programm, Gmail bzw. Outlook im Web.“
- H4 „Entwurfs-Postfach“ (`:92`): „Optional: AVA legt Entwürfe mit Anhängen direkt in den Entwürfe-Ordner deines Postfachs. Dort findest du sie in jedem Mail-Programm, im Webmail und auf dem Handy. AVA schreibt nur in diesen Ordner und liest keine Mails. Das Passwort liegt verschlüsselt auf diesem Gerät.“ (`:93-96`)
- H4 „Feste Anhänge“ (`:220`): „Dateien, die du immer wieder mitschickst (Firmenprofil, Referenzen, Preisliste). AVA hängt sie passend an Entwürfe; die mit „An jede Outreach-Mail“ immer. Bis zu 10 Dateien, je höchstens 10 MB. Eine Datei mit gleichem Namen ersetzt die alte Fassung.“ (`:221-224`)

**4.5 ThemenSection.** `#themen-section` (`s/ThemenSection:46-101`). Rendert `null`, solange nicht geladen.
- H3: „Fokus-Themen“
- Intro (`:48-52`): „Was dich persönlich an einer Firma interessiert und wonach AVA auf der Website jeder Firma zusätzlich sucht, zum Beispiel „Betriebliche Altersvorsorge“, „ISO 27001“ oder „Photovoltaik“. Je Thema wählt AVA passende Seiten, sucht nach den Begriffen und prüft die Fundstellen. Ein Fund trägt immer ein wörtliches Zitat und die Seite als Quelle. Bis zu 5 Themen gleichzeitig aktiv. Im Chat: „Leg ein Fokus-Thema an“.“

### Tab 5: Automatisierungen (`s/AutomatisierungenTab:23-43`). 11 Abschnitte, davon 4 bedingt

**5.1 WatchesSection.** `#watches-section` (`S:4438-4534`).
- H3: „Watches“
- Intro (`S:4502-4508`): „Wiederkehrende Beobachtungen, die der Heartbeat im Hintergrund gegen frische Kandidaten prüft. Treffer landen automatisch in [Meldungen]. Du kannst Watches hier anlegen oder im Chat („Beobachte wöchentlich Geschäftsführungs- wechsel bei meinen wichtigsten Firmen").“
  - Im Text steht ein Trennstrich mit Leerzeichen: „Geschäftsführungs- wechsel“.
- Zähler: „{n} von {m} aktiv · maximal {cap}.“ (`S:4510`)

**5.2 LinkMonitorSection.** `#link-monitor-section` (`s/LinkMonitorSection:40-88`).
- H3: „Link-Überwachung“
- Intro (`:42-51`): „AVA öffnet einen Link regelmäßig in einem Hintergrund-Browser und meldet dir, wenn sich etwas ändert (neue Produkte, Preise, Stellen, Profil-/Unternehmensseiten — LinkedIn-Links nutzen automatisch deine Anmeldung). Frequenz min. alle 5 Minuten, max. wöchentlich. **{n} aktiv / max {cap}**. Überzählige werden pausiert angelegt.“
- Tipp (`:52-57`): „Tipp: Sehr kurze Intervalle lösen bei vielen Shops den Bot-Schutz aus (z. B. Cloudflare-Sicherheitsprüfung) — die Seite lädt dann gar nicht erst. Für Verfügbarkeits- und Preisprüfungen sind 30–60 Minuten meist die verlässlichere Wahl.“

**5.3 SchedulerSection.** `#scheduler-section`. Nur bei Funktion `mail` (`s/SchedulerSection:33-74`).
- H3: „Wiederkehrende Aufgaben“
- Intro (`:38-47`): „AVA kann wiederkehrende Aktionen für dich ausführen (z. B. „alle 5 Minuten eine Test-Mail senden"). Aktuell unterstützt: Mail-Loops. Empfänger müssen in der Mail-Allowlist stehen. **{n} aktive(r) Job(s) / max 10**.“

**5.4 FreshnessSection** (`S:4228-4432`).
- H3: „Aktualisierung“. Das Sub-Menü nennt den Abschnitt „Datenrefresh“.
- Intro (`S:4282-4286`): „Hintergrund-Loop, der Pipeline-Stages je Firma erneut anstößt, wenn sie ihre Cadence überschritten haben. Stille Disk-Arbeit; echte Änderungen erscheinen über den Heartbeat als Meldung.“

**5.5 EmailMusterSection.** `#email-muster-section` (`s/EmailMusterSection:32-76`).
- H3: „E-Mail-Ableitung“
- Intro (`:34-41`): „Direkt nach dem Kontaktlauf einer Firma leitet AVA aus bekannten persönlichen Adressen das Adressmuster ab und bildet Adressen für alle Kontakte ohne E-Mail. Firmenadressen mit Namen (etwa pdettlev@…) werden der passenden Person zugeordnet und zählen als Beleg. Jede gebildete Adresse wird einzeln per Mail-Server-Anfrage auf Existenz geprüft, ohne eine E-Mail zu senden: „abgeleitet · verifiziert“. Nimmt ein Mailserver jede Adresse an (Catch-all), heißt sie „abgeleitet · unbestätigt“. Ist die Prüfung in diesem Netz nicht möglich oder bleibt sie ohne Antwort, wird die Adresse trotzdem gespeichert, als „abgeleitet · unverifiziert“ mit Verweis auf die Baseline-Adresse. Eine eingehende Antwort bestätigt sie, eine Unzustellbarkeitsmeldung entfernt sie wieder. Das Ergebnis je Firma steht in der Status-Matrix (Spalte „E-Mail“); dort lässt sich die Stufe jederzeit neu starten.“

**5.6 VorschlaegeSection.** `#vorschlaege-section` (`s/VorschlaegeSection:12-33`). Rendert `null`, solange nicht geladen.
- H3: „Vorschläge im Chat“
- Intro (`:14-18`): „AVA schlägt dir passende nächste Schritte vor: auf der leeren Chat-Seite und unter der Willkommensnachricht, sowie nach einer Antwort, wenn sich aus dem Gespräch ein Schritt anbietet. Die Vorschläge entstehen mit dem Hintergrund-Modell aus dem, was du bereits eingerichtet hast; Erledigtes wird nicht vorgeschlagen.“
- Bedingter Satz: „Deine Organisation hat Vorschläge abgeschaltet. Es erscheint nur eine feste Liste ohne KI-Aufruf.“ (`:19`)

**5.7 MithelfenSection.** `#mithelfen-section` (`s/MithelfenSection:59-155`).
- Wird immer gerendert. Bei abgeschalteter Organisationsfunktion verschwindet nur der Sub-Menü-Eintrag (`S:189`).
- H3: „Stammdaten mitpflegen“
- Intro (`:61-65`): „Die Firmenstammdaten stammen aus dem Handelsregister. Neue Eintragungen, Löschungen und Änderungen holt AVA laufend nach. Wenn du mithilfst, fragt dein Rechner im Hintergrund das Registerportal ab: höchstens 60 Abfragen je Stunde, mit einem unsichtbaren Chrome-Fenster, nur handelsregister.de, keine Downloads. Die Ergebnisse landen im geteilten Bestand aller Nutzer.“
- H4: „Was dieser Rechner beigetragen hat“ (`:114`)

**5.8 BrowserSection.** `#browser-section` (`s/BrowserSection:13-30`). Rendert `null`, wenn kein Status vorliegt oder der Zustand „aus“ ist.
- H3: „Browser der Hintergrundverarbeitung“
- Intro (`:15-18`): „Für Handelsregister, Webseiten und Publikationen steuert AVA einen Browser im Hintergrund. Dafür bringt AVA eine eigene Fassung mit (Chrome for Testing von Google, rund 160 MB, wird einmal geladen). Dein eigener Chrome bleibt davon vollständig unberührt: Er wird nie gestartet, nie beendet und teilt weder Profil noch Anmeldungen mit AVA.“

**5.9 AlertsSection.** Section ohne id. Die Sprungmarke `alerts-cadence` liegt auf dem Select (`S:3700-3948`).
- H3: „Meldungen“. Das Sub-Menü nennt den Abschnitt „Alerts / Heartbeat“.
- Intro (`S:3789-3794`): „Der Heartbeat sucht im Hintergrund nach alarmwürdigen Vorgängen und legt Meldungen ab. Eine vollständige Liste findest du unter *Meldungen* in der Navigation; rechts oben in der Leiste zeigt die Glocke ungelesene Einträge an.“
- Unterblock H4: „Letzte Heartbeats“ (`S:4008`)

**5.10 RelevanzSection.** `#relevanz-section`. Nur bei Funktion `relevanz` (`s/RelevanzSection:84-170`).
- H3: „Relevanz“
- Intro (`:86-92`): „AVA merkt sich, mit welchen Firmen und Personen du arbeitest — welche du ansiehst, im Chat behandelst, übernimmst oder ins CRM holst. Daraus entsteht je Eintrag eine Nähe von 1 bis 10. Sie steuert, was AVA im Hintergrund genauer beobachtet und welche Meldungen dich sofort erreichen statt in der Tageszusammenfassung zu landen.“
- Zweiter Absatz (`:93-99`): „Die Signale liegen in deinem AVA-Konto, getrennt von allen anderen. Niemand sonst kann sie sehen, auch nicht die Verwaltung deiner Organisation. Es gibt keine Auswertung über Mitglieder hinweg. Was älter als 400 Tage ist, wird gelöscht. Warnungen zum Firmenstatus — Insolvenz, Löschung — erreichen dich immer, unabhängig von der Nähe.“

**5.11 TelegramSection.** `#telegram-section`. Nur bei Funktion `telegram` (`s/TelegramSection:114-345`).
- H3: „Telegram“
- Intro (`:116-120`): „Bekomme deine Meldungen zusätzlich als Telegram-Nachricht — auch dann, wenn die Desktop-Benachrichtigungen aus sind. Läuft direkt von deinem Rechner zu Telegram.“

### Tab 6: Wissensquellen (`s/WissensquellenTab:53-86`). 1 Abschnitt

- H3: „Wissensquellen“
- Intro (`:56-62`): „Verbinde AVA mit deinem Notion-Workspace oder Obsidian-Vault. AVA kann darin lesen, suchen und schreiben — z. B. neue CRM-Einträge anlegen, Notizen erweitern oder Termine als Erinnerung übernehmen. Tokens bleiben verschlüsselt im OS-Schlüsselbund.“
- Karten (`:271-282`):
  - „Notion“: „Lese und schreibe in deinen Notion-Workspace — Datenbanken, Seiten, CRM-Einträge. Anmeldung via Integration-Token.“
  - „Obsidian“: „Verbinde dein Vault über das offizielle Local-REST-API-Plugin. AVA liest, sucht und schreibt Markdown-Notizen.“

### Tab 7: Skills (`SK:356-619`). 1 Abschnitt `#skills-list`

- H3: „Skills“
- Intro (`SK:358-364`): „Vom Nutzer hinterlegte Markdown-Skills, die der Chat-Agent automatisch aktivieren kann. Auto-Aktivierung basiert auf der Beschreibung; alternativ explizit per `/skill-name`. Neue oder geänderte Skills müssen einmal freigegeben werden, bevor der Agent sie aufruft.“
- Zusätzlich Dialoge: SkillBodyModal, SkillTrustDialog, SkillImportDialog, SkillEditor. Deren Texte sind hier nicht erfasst; die Dialoge liegen in eigenen Komponenten.

### Tab 8: Verlauf (`s/VerlaufTab:73-80`). 2 Abschnitte, davon 1 bedingt

**8.1 SelfCorrectionsSection.** `#self-corrections`. Nur wenn mindestens 1 Eintrag existiert (`:564`).
- H3: „Selbstkorrekturen (Tool-Workarounds)“ (`:616`)
- Intro (`:617-623`): „AVA meldet hier, wenn sie nach einem Tool-Fehler einen Workaround gefunden hat. Pattern, die hier oft auftauchen, gehören als Code-Fix in den Tool/Skill — eine wiederkehrende Meldung ist ein Hinweis für mich als Entwickler. Alles bleibt lokal. Aktuell: **{n}** Meldung(en).“

**8.2 AuditTrailSection.** `#audit-trail`.
- H3: „Verlauf“ (`:253`)
- Intro (`:254-259`): „Chronologische Aufzeichnung aller Vorgänge in AVA — Producer-Läufe, LinkedIn-Signale, Hintergrund-Heartbeat, Authentifizierungs-Events, CRM-Aktionen. Alles bleibt auf deinem Rechner; keine Daten gehen in die Cloud.“

### Tab 9: System (`s/SystemTab:14-25`). 7 Abschnitte

**9.1 UpdaterSection.** `#updates` (`S:576-654`).
- H3: „Updates“
- Intro: „AVA prüft beim Start und alle vier Stunden auf neue Versionen. Du bestätigst jeden Download und jeden Neustart selbst. Es gibt keine stillen Updates.“ (`S:578-582`)

**9.2 OllamaVersionSection.** `#ollama-version` (`c/OllamaVersionSection:82-158`).
- H3: „Ollama-Laufzeit“
- Intro: „AVA bündelt eine lokale Ollama-Instanz für die Modell-Ausführung. Wir verfolgen die neueste stabile Version von GitHub und installieren sie bei Bedarf nach — ohne dass du AVA neu installieren musst.“ (`:84-88`)

**9.3 StorageSection.** `#storage` (`c/StorageSection:126-275`).
- H3: „Speicherplatz“
- Intro: „Aufschlüsselung des Plattenverbrauchs. Der größte Posten sind meist veraltete Sprachmodelle, die von früheren AVA-Versionen übrig sind — die kannst du hier gefahrlos entfernen.“ (`:128-132`)

**9.4 PostgresSection.** `#local-services` (`S:686-723`).
- H3: „Lokale Datenbank“
- Intro: „AVA bündelt eine eingebettete PostgreSQL-Instanz für die lokal laufenden Producer-Dienste. Die Datenbank läuft nur auf `127.0.0.1` und ist von außen nicht erreichbar.“ (`S:688-692`)

**9.5 ProducersSection.** `#local-producers` (`S:835-930`).
- H3: „Lokale Producer-Dienste“
- Intro: „Tenant-private Dienste laufen als Node-Subprozesse direkt auf deinem Rechner. Sie nutzen die lokale Datenbank weiter oben und sprechen über AMQP mit dem Cloud-Gateway.“ (`S:837-841`)
- Darin zusätzlich die Statuszeile MithelfenZeile (`S:743-801`)

**9.6 DiagnoseSection.** `#diagnose` (`c/DiagnoseSection:33-73`).
- H3: „Diagnose“
- Intro: „AVA schreibt seit v0.1.338 ein dauerhaftes Protokoll mit. Wenn die App nach dem Öffnen des MacBooks nicht mehr reagiert, lässt sich der Hänger danach hier nachvollziehen — die Datei beim Melden eines Problems bitte mitschicken.“ (`:35-40`)

**9.7 DangerZoneSection.** `#danger-zone`, Klassen `provider-section danger-zone` (`c/DangerZoneSection:50-132`).
- H3: „Zurücksetzen“
- Intro (`:52-58`): „Setzt AVA auf den Ausgangszustand zurück und löscht **alle lokal gespeicherten Daten** — Chats, Profil, Verbrauchsstatistiken, Meldungen, Erinnerungen, Automatisierungen sowie alle verbundenen Integrationen (HubSpot, LinkedIn, E-Mail) samt deren Zugängen.“
- Zusatz (`:59-62`): „**Erhalten bleiben** deine KI-Modelle: gewählte Provider + API-Keys/Anmeldungen und bereits heruntergeladene lokale Modelle.“

---

## 2. Bedienelemente je Abschnitt: Labels, Buttons, Tooltips, Status, Warnungen

### Konto

**PlanSection**
- Seat-Variante:
  - Badge „{Tier}-Seat“, „bezahlt von {…|deiner Organisation}“, „· ab {Datum} {Tier}“, „· Sammelabrechnung endet am {Datum}“ (`S:5368-5373`)
  - Fehlertext suspended: „Die Sammelabrechnung deiner Organisation ist wegen einer offenen Zahlung pausiert. Importe und Radar-Scans laufen erst wieder, wenn der Owner die Zahlung klärt.“ (`S:5378`)
  - past_due: „Bei der Organisation ist eine Zahlung offen. Der Owner wurde informiert; bis zur Klärung läuft alles weiter.“ (`S:5384`)
  - „{used} von {limit} verbraucht“, „Erneuert sich am {Datum}“
  - „Notbremse der Organisation ({n} Seat(s)); das eigentliche Limit ist das Ausgabenlimit oben.“ (`S:5400-5401`)
  - Eigenes Abo: „Dein eigenes {Tier}-Abo läuft noch.“ plus „Es endet am … und wird nicht erneuert, weil dein Zugang jetzt über die Organisation läuft.“ bzw. „Es läuft weiter, obwohl dein Zugang über die Organisation bezahlt wird.“, dann „Über [Abonnement verwalten] kannst du das ändern.“ (`S:5407-5415`)
- ZugangStand (`S:5226-5306`):
  - „Firmen im Bestand in dieser Periode: {n} ({x klein, y mittel, z groß, w noch ohne Stufe})“
  - „Bestand in diesem Monat: {€}{ zugeordnet, voraussichtlich {€} mit den offenen}{ · davon {€} im Plan enthalten} · kommt mit der nächsten Rechnung“
  - „Monatslimit für die Hintergrundverarbeitung laut Vertrag: {€} · belegt {€}{ · erreicht, neue Firmen ab dem nächsten Monat}“
  - Feld „Ausgabenlimit je Monat“, Platzhalter „kein Limit“, Einheit „€“, Button „Speichern“ / „Speichert…“
  - „setzt der Owner oder Admin deiner Organisation“
  - Fehler „Bitte einen Betrag in Euro eingeben (leer = kein Limit).“
  - Warnung „Dein Ausgabenlimit ist erreicht. Neue Firmen warten, bis du es erhöhst oder der Monat wechselt.“
- Einzeltarif:
  - „Lädt…“
  - „Verbrauch konnte nicht geladen werden.“ plus Button „Erneut versuchen“
  - Badge Tarif plus „aktiver Tarif“, Badge „Kündigung vorgemerkt“
  - suspended: „Dein Abo ist wegen einer offenen Zahlung pausiert: Importe und Radar-Scans laufen erst wieder, wenn die Zahlung im Kunden-Portal geklärt ist.“
  - past_due: „**Zahlung fehlgeschlagen.** Stripe versucht es erneut; bitte Zahlungsmittel im Kunden-Portal prüfen, sonst wird der Zugang nach 14 Tagen pausiert.“
  - „**Kündigung zum {Datum} vorgemerkt.** Bis dahin nutzt du {Tier} weiter; danach wechselt dein Konto auf Free. Über [Abonnement verwalten] kannst du die Kündigung jederzeit zurücknehmen.“
  - Fortschrittstext: „Lebenszeit-Kontingent (Free-Tier)“ / „Verbrauch im aktuellen Zyklus“
- Plankarten (`S:5173-5218`):
  - **Free**: „0 €“, „25 Firmen, lebenslang“. Features: „Aufbereitung mit AVAs Modell, kein Schlüssel nötig“, „Kontakte von der Firmen-Website“, „Lokal auf deinem Gerät“, „Community-Support“
  - **Pro**: „49 €“ „/Monat je Nutzer“, „dazu je Firma in deinem Bestand und Monat 0,50 € (klein), 1,00 € (mittel) oder 1,50 € (groß)“. Features: „Jede Firma in Meine Firmen zählt je Monat, einmal je Organisation“, „Aufbereitung, Auffrischung, Alarme und Wächter enthalten“, „Stufe nach dem Lauf: LinkedIn-Profil ja/nein, ab 50 Personen groß“, „Eigenes Ausgabenlimit je Monat“, „LinkedIn-Kontakte inklusive“, „Aufbereitung mit AVAs Modell, kein Schlüssel nötig“, „Vorrang-Support“, „Monatliche Abrechnung“
  - **Enterprise**: „Auf Anfrage“, „Konditionen nach Vereinbarung, kein Deckel“. Features: „Eigene Cloud-Instanz möglich“, „Custom-Integrationen“, „SLA + dedizierter Support“, „Individuelle Vertragsgestaltung“
  - Badges „Empfohlen“, „Aktueller Tarif“
  - Buttons „Aktiv“, „Anfrage senden“, „Upgraden“ / „Wird geöffnet…“, „Wechsel im Portal“ (Tooltip „Wechsel zu einem niedrigeren Tarif erfolgt über das Kunden-Portal.“)
  - „Abonnement verwalten“ (Tooltip „Stripe-Kundenportal öffnen (Rechnungen, Zahlungsmethoden, Tarif-Wechsel, Kündigung)“)
  - Fußtext „Kündigung jederzeit über das Kunden-Portal möglich. Enterprise- Wechsel laufen direkt über uns.“ (`S:5651-5654`)
  - Fehler „Konnte Kontakt-Seite nicht öffnen. Versuch's bitte direkt im Browser: …“ (`S:5343`)

**ProfileSection** (`S:3288-3427`)
- Felder mit Platzhaltern:
  - „Bio (max. {N} Zeichen)“, Platzhalter „z. B. „Ich arbeite im B2B-Vertrieb für Maschinenbau-Mittelstand in Bayern; Schwerpunkt Geschäftsführer-Wechsel und neue Produktlinien.“, Zähler „{n} / {N}“
  - „Rolle“ („z. B. „Vertriebsleiter DACH“)
  - „Branchen (Komma-getrennt)“ („z. B. „Maschinenbau, Logistik“)
  - „Regionen“ („z. B. „Bayern, DACH“)
  - „Schwerpunktthemen“ („z. B. „Geschäftsführer-Wechsel, Expansion, Übernahmen“)
  - „Bevorzugter Ton“ mit den Optionen „keine Vorgabe“, „Neutral“, „Knapp“, „Ausführlich“
  - „Relevant auf LinkedIn (zusätzliche Signal-Kriterien)“, Platzhalter „z. B. „Wettbewerbsaktivität von Firma X/Y; jemand aus meiner Branche berichtet von Werksbesuchen oder Investitionen; neue Förderprogramme im Maschinenbau.“
  - Hinweis: „Erhöht die Signalstärke neuer LinkedIn-Beiträge, die dazu passen, und zeigt den Treffer als Chip an. Wirkt ab dem nächsten Scan. {n} / 600“
- Buttons „Profil speichern“ / „Speichert…“, „Profil zurücksetzen“
- „Zuletzt aktualisiert {Datum}“
- Bestätigung: „Profil wirklich zurücksetzen? Bio + Rolle + alle Listen werden geleert.“
- Abschnittsweite Ladeanzeige (im Abschnitt selbst): „Lädt…“

**LinkedInCalibrationNote** (`S:3123-3180`)
- Textarea-Platzhalter: „Noch nichts gelernt. Bewerte ein paar Signale auf der LinkedIn-Seite mit 👍 / 👎 — AVA destilliert daraus automatisch eine kompakte Kalibrierung, die hier erscheint.“
- Status: „{n} / 800 Zeichen · {n} offene Bewertung(en) · zuletzt gelernt {Datum}“
- Buttons:
  - „Kalibrierung speichern“ (Tooltip „Deine Änderungen an der Kalibrierungs-Notiz übernehmen“)
  - „Jetzt aus Feedback lernen“ (Tooltip „Offene 👍/👎-Bewertungen jetzt sofort einarbeiten (statt auf den Hintergrund-Lauf zu warten)“)
  - „Zurücksetzen“ (Tooltip „Gelernte Kalibrierung leeren“)
- Bestätigung: „Gelernte Kalibrierung wirklich zurücksetzen?“

**GeneralMemorySection**
- Leerzustand: „Noch kein Langzeitgedächtnis vorhanden. Der Agent legt Einträge an, wenn du ihn um etwas zu merken bittest oder eine stabile Präferenz erkennt.“ (`S:5041-5044`)
- Button „vergessen“ / „Vergisst…“ (Tooltip „Diesen Eintrag vergessen, der Agent ruft ihn nicht mehr ab“)
- Bestätigung: „Diesen Eintrag vergessen? „…" Der Agent ruft ihn in zukünftigen Sitzungen nicht mehr ab.“
- Zeitangaben „gerade eben / vor X Min. / vor X Std. / vor X Tagen“

**KonsoleSection**: Button „AVA Konsole öffnen“ (`s/KonsoleSection:27`)

**InstanzenSection**
- Tabellenköpfe: „Instanz | Telegram | Radar | Modell | MCP“
- Pill „diese“
- Zellen:
  - „Server“/„Desktop“, „v{version} · verbunden seit …“ / „offline seit …“
  - Telegram: „nicht eingerichtet“, „{bot} — auch an einer anderen Instanz, eigenen Bot anlegen“, „{bot} — wird von einer anderen Stelle abgeholt“, „{bot}, Chat noch nicht verknüpft“, „{bot}, Zustellung an/aus“
  - Radar: „aus“ / „an, alle {n} h“
  - Modell: „kein Idealkundenprofil“
  - MCP: „beantwortet/aus/bereit“
- Buttons „Hierher holen“ (Tooltip „Kompletten Stand dieser Instanz hierher übertragen“), „Dorthin senden“ (Tooltip „Kompletten Stand von hier dorthin übertragen“)
- Checkbox „Diese Instanz ({name}) darf MCP-Aufrufe aus Claude und ChatGPT beantworten“
- Bestätigungsdialoge (`:77-78`): „Den kompletten Stand von „X“ hierher holen? Diese AVA wird dabei vollständig überschrieben (Gedächtnis, Chats, Profil, ICP, Radar, Workflows, Mail-Speicher, Schlüssel …) und startet neu. Dein bisheriger Stand bleibt als Sicherung erhalten. Anmeldung, Telegram-Bot und Abo-Anmeldungen bleiben, wie sie sind.“ und die Gegenrichtung entsprechend
- Status:
  - „Lädt…“
  - „Liste nicht abrufbar: …“
  - „Gerade ist keine Instanz mit dem Gateway verbunden.“
  - „Umzug von/an X: {meldung} (n MB)“
  - „Umzug nicht gestartet.“

**VerbindungenSection**
- Hinweis bei gesperrter Organisationsfunktion: „Deine Organisation hat den MCP-Zugang nicht freigeschaltet (AVA Konsole admin.ava.bi → Funktionen & Vorgaben). Bestehende Verbindungen erhalten dann keine Werkzeuge.“ (`:48-49`)
- Fehler: „Die Verwaltung der Verbindungen ist auf diesem Gateway nicht eingerichtet.“
- Leerzustand: „Noch kein Dienst verbunden.“
- Tabelle „Dienst | Verbunden seit | Zuletzt genutzt“, Pill „MCP“, darunter die rohe clientId
- Button „Trennen“

### Modelle

**ProviderSection**
- Kanal-Badges (`S:2114-2123`):
  - „Lokal (Ollama) — kostenlos“
  - „Schlüssel der Organisation (…xxxx)“
  - „ChatGPT-Abo“
  - „OpenAI API-Schlüssel“
  - „{Anbieter} API-Schlüssel“
- Weitere Badges:
  - „ChatGPT-Abo (Sprachmodus und Deep Research brauchen weiter einen Schlüssel)“ (`S:2132`)
  - „AVAs Modell“ plus „im Plan enthalten, kein Schlüssel nötig“ (`S:2200`)
  - Status „bereit“/„nicht bereit“
- Chat-Modell über Abo: „{Modell} · ChatGPT-Abo“ oder „Standard des Kontos“
- Selects:
  - „Anbieter“ (Optionen = PROVIDER_LABEL `S:73-82`: „Ollama (lokal)“, „OpenAI“, „Anthropic“, „Google“, „Mistral“, „DeepSeek“, „xAI (Grok)“, „Qwen“; Zusätze „ (kein Abo verknüpft)“ bei Anthropic, „ (kein Schlüssel/Abo)“ bei OpenAI, „ (kein Schlüssel)“ sonst, `S:2260-2265`)
  - „Modell“ bzw. „Chat-Modell“ mit „Wählst du oben in der ChatGPT-Abo-Karte aus den für dein Konto freigegebenen Modellen.“
  - „Modell für Hintergrund-Verarbeitung“ (Option „Wie oben (Standard)“ bzw. „Standard ({…|Modell des Schlüssels})“)
- Optionstexte (`S:1971-1977`): „{Label} ★ · {200k ctx} · {costClass} · vision“
- Ollama-Gruppen (`S:1956-1969`): „Google · Gemma“, „Alibaba · Qwen“, „Meta · Llama“, „Mistral“, „Microsoft · Phi“, „DeepSeek“, „IBM · Granite“, „Cohere“, „Nomic“, „Sonstige“
- Info-Zeile: „{Label} · Kontext {200k ctx}{ · X GB auf der Festplatte}“ (`S:2379-2383`)
- OllamaDownloadAffordance (`S:2829-2852`):
  - „Auf der Festplatte ✓“
  - „Lädt… der Fortschritt ist im Dock unten rechts sichtbar.“
  - „Dieses Modell ist noch nicht auf der Festplatte. Der Download läuft im Hintergrund; du kannst die App weiter nutzen.“
  - Button „Modell herunterladen“
- Warnung Schlüsselbund (`S:2406-2408`): „⚠ OS-Schlüsselbund nicht verfügbar: Schlüssel werden unverschlüsselt im Benutzerdatenordner gespeichert. Cloud-Anbieter funktionieren weiterhin, dieser Modus eignet sich aber nur für Entwicklungs­zwecke.“
- Ladeanzeige „Lädt…“, Fehler „Konnte nicht geladen werden“

**ChatGPT-Abo-Karte** (`S:2465-2650`)
- Buttons: „Continue with ChatGPT“ (Tooltip identisch), „Connecting…“, „Reconnect with ChatGPT“, „Manage usage“, „Trennen“, „Abbrechen“
- Status: „Status: Verbunden · {email} · aktiv“, Badge „ohne Plan-Freigabe“
- Erklärung bei fehlender Freigabe (`S:2589-2595`): „Die Anmeldung ist gültig, aber ChatGPT hat die Plan-Nutzung für AVA nicht freigegeben. Das passiert bei Team-, Business- und Free-Konten (nur Plus und Pro können ihr Abo teilen) oder wenn du die Freigabe im Anmeldefenster abgelehnt hast. Bis dahin nutzt AVA weiter deinen Schlüssel beziehungsweise den deiner Organisation. Freigabe prüfen unter ChatGPT → Settings → Usage, dann „Reconnect with ChatGPT“.“
- Select „Modell für AVA“: „Modelle werden geladen…“, Zusatz „ (Standard des Kontos)“. Hinweis: „Für dein Konto freigegebene Modelle, in der Reihenfolge von OpenAI. Gilt für Chat, Radar, Alarme, Recherche und Workflows.“
- Vorab-Hinweis (`S:2628-2633`): „**Bevor du dich anmeldest:** AVA nutzt dein ChatGPT-Abo nicht nur im Chat, sondern auch für die Hintergrund-KI (Radar, Alarme, Vorschläge, Recherche, Workflows). Die Firmenverarbeitung läuft über AVAs Modell. Das verbraucht dein wöchentliches Kontingent, das du mit allen verbundenen Apps teilst. Setze deshalb in ChatGPT → Settings → Usage ein Limit für AVA, zum Beispiel 30 Prozent. Du kannst die Verbindung dort jederzeit trennen.“
- „Alternativ kannst du unten einen OpenAI-API-Schlüssel hinterlegen.“
- Rückmeldungen:
  - „Mit ChatGPT verbunden ({email}). Aufrufe laufen über dein Abo.“
  - „Angemeldet, aber ohne Freigabe für die Plan-Nutzung. Erlaube AVA in ChatGPT → Settings → Usage, dein Abo zu nutzen, und verbinde erneut.“
  - „ChatGPT-Verbindung getrennt. In ChatGPT → Settings → Usage kannst du AVA zusätzlich entfernen.“

**ApiKeyCard** (`S:2875-3020`)
- Badges „Organisation …xxxx“ / „gespeichert“
- Radios „Schlüssel der Organisation (…xxxx)“ / „Eigener Schlüssel / Abo“
- Organisationstext: „Aufrufe laufen über das AVA-Gateway mit dem Schlüssel deiner Organisation; der Schlüssel selbst bleibt dort. Das Gateway sieht dabei die Prompts (Frankfurt, EU), speichert sie aber nur, wenn deine Organisation Prompt-Audit eingeschaltet hat. Verbrauch wird der Organisation zugerechnet.“
- Gesperrt: „Von der Organisation vorgegeben; eigene Schlüssel sind gesperrt.“
- Platzhalter „•••• gespeichert, neuen Schlüssel einfügen, um zu ersetzen“ / „API-Schlüssel“
- Buttons „Speichern“/„Speichert…“, „entfernen“/„Entfernt…“ (Tooltip „Gespeicherten Schlüssel für diesen Anbieter entfernen“)
- Link „Wo bekomme ich einen Schlüssel? →“
- Beschreibung je Anbieter = PROVIDER_FEATURES (`S:94-123`), wörtlich:
  - openai: „Schaltet im website-Producer Deep Research (o4-mini-deep-research) sowie Google-Maps-Entity-Resolution + Quellen-Discovery (gpt-6-luna) frei. Ohne Schlüssel bootet der Producer trotzdem, aber diese spezifischen Calls werden zur Laufzeit übersprungen.“
  - anthropic: „Wird als Chat-LLM und in allen LLM-getriebenen Producer-Stages (Profile, Contact, Evaluation, Publications) verwendet. Anmeldung ausschließlich per API-Schlüssel — die Anmeldung über ein Claude-Pro/Max-Abo wird nicht mehr unterstützt.“
  - google: „Wird als Chat-LLM und in allen LLM-getriebenen Producer-Stages verwendet (z. B. Gemini 3.8 Flash für anspruchsvolle Recherche).“
  - mistral: „… (z. B. Mistral Large 4 für deutschsprachige Inhalte).“
  - deepseek: „… verwendet. Mit Abstand der günstigste Anbieter (V4 Flash), 1 Mio. Kontext — interessant für die Hintergrund-Verarbeitung. Kein Bild-Verständnis.“
  - xai: „… (Grok 4.6: 500k Kontext, Bild-Verständnis).“
  - qwen: „… (Qwen3.8 Max, 1 Mio. Kontext). Läuft über Alibabas internationalen Model-Studio-Endpunkt. Kein Bild-Verständnis.“

**AzureOpenAIKarte** (`s/AzureOpenAIKarte:65-131`)
- Checkbox „Über Azure OpenAI (eigene Azure-Ressource)“
- Text: „Der Schlüssel oben ist dann der Schlüssel deiner Azure-OpenAI-Ressource. Trage die Deployments ein, unter denen die Modelle dort laufen; ohne Eintrag nutzt AVA ein gleichnamiges Deployment. Der Sprachmodus braucht weiterhin einen Schlüssel direkt bei OpenAI.“
- Feld „Endpunkt“ (Platzhalter „https://firma.openai.azure.com“)
- „Modell → Deployment“, „Alle übrigen Modelle“, Platzhalter „Modell, z. B. gpt-5-mini“, „Deployment (optional)“, „Deployment-Name“
- „entfernen“ (Tooltip „Zuordnung entfernen“), „+ Zuordnung“
- Buttons „Azure speichern“/„Speichert…“, „Verbindung prüfen“/„Prüft…“
- Rückmeldung „Verbindung zu Azure OpenAI steht.“

**AnthropicTierBanner** (`c/AnthropicTierBanner:43-65`), nur bei Tier 1
- „⚠️ Anthropic-Account auf Tier 1 ({n} Token/Min)“
- „Tier 1 ist Anthropics Standard für neue API-Konten und wird bei längeren Recherchen schnell knapp. AVA versucht trotzdem, dein Token-Budget durch Prompt-Caching zu schonen — bei mehreren Hintergrund-Aufgaben gleichzeitig kann es aber weiterhin zu Wartemeldungen kommen.“
- „**Tier 2 verdoppelt das Limit** und schaltet sich automatisch frei, sobald 5 USD über die API verbraucht oder vorab aufgeladen wurden — kein Antrag, kein Warten.“
- Link „Anthropic-Console öffnen → Limits prüfen“

**InstalledModelsSection** (`S:2654-2810`)
- „Noch keine lokalen Modelle installiert.“
- Buttons „Lokale Laufzeit neu starten“ / „Laufzeit neu starten“ / „Startet neu…“. Tooltip: „Stoppt und startet den eingebundenen Ollama-Prozess neu. Hilfreich, wenn der Chat nach einem Modellabsturz mit „Internal Server Error" hängt.“
- Kopfzeile „({n} · X GB)“
- „Pflichtmodell“ (Tooltip „Pflichtmodell — wird vom Bewertungs-Service für die globale Vektorsuche genutzt und kann nicht entfernt werden.“)
- „reparieren“/„Repariert…“ (Tooltip „Löschen + erneut herunterladen. Behebt korrupte Layer aus einem unterbrochenen Download. Hilfreich, wenn ein Modell die lokale Laufzeit immer wieder zum Absturz bringt.“)
- „löschen“/„Löscht…“ (Tooltip „Modell von der Festplatte entfernen, um Speicherplatz freizugeben“)
- Bestätigungen (`S:2712`, `S:2789`): „„X" reparieren? Das Modell wird von der Festplatte gelöscht und erneut heruntergeladen. Hilfreich, wenn das Modell die lokale Laufzeit immer wieder zum Absturz bringt.“ und „„X" von der Festplatte löschen? Du kannst es später von dieser Seite oder im Chat erneut herunterladen.“

**ResearchFeaturesSection**
- Pro Karte:
  - „Modus“ mit Radios „Aus“, „Standard“, „Deep Research“
  - „Anbieter“ (Select „OpenAI“/„Anthropic“, oder Text „OpenAI (Organisation)“)
  - „Modell: {…}“ mit den Werten aus MODEL_LABEL (`:55-66`): „gpt-6-luna + web_search“, „o4-mini-deep-research-2025-06-26 + web_search“, „claude-sonnet-5-5 + web_search“, „claude-opus-5 + web_search + adaptives Denken“
  - „Schlüssel“-Select: „— kein {provider}-Schlüssel hinterlegt —“, „Schlüssel der Organisation (Kosten trägt die Organisation)“, „Allgemeine Modell-Konfiguration“
  - Buttons „+ neuer Schlüssel“ (Tooltip „Eigenen Key für dieses Feature anlegen“) und „Test“/„Testet…“/„✓ {n}ms“/„✗ Fehler“ (Tooltip „Probe-Call gegen den Anbieter, um zu prüfen ob der Schlüssel funktioniert.“)
- Hinweise zur Mehrfachnutzung eines Schlüssels (`:439-442`): „Dieser Schlüssel wird auch von „Allgemeine Modell-Konfiguration" verwaltet — Änderungen dort wirken sich hier aus.“ / „Dieser Schlüssel wird auch von „…" verwendet.“
- Kostenzeile (`:312-318`): „Geschätzte Kosten: **{X} je Firma** (wird über das AVA-Gateway deiner Organisation zugerechnet).“ bzw. „(wird direkt deinem OpenAI/Anthropic-Konto belastet).“. Werte: OpenAI ~0,02 € / 1–5 €, Anthropic ~0,10 € / 0,25–0,80 € (`:50-53`)
- Kostendialog (`:484-503`): H3 „Achtung: hohe API-Kosten“, „Deep Research ist ein aufwendiger, mehrstufiger Recherche-Prozess. Bei {Anbieter} können pro analysierter Firma **{Spanne}** an API-Gebühren anfallen.“ / „Diese Kosten werden direkt deinem {Anbieter}-Konto belastet, nicht von AVA übernommen. Für {Feature}: einmal ausgelöst pro Firma, im Hintergrund.“ Buttons „Abbrechen“, „Ich verstehe, aktivieren“
- Alert „Kein {provider}-Schlüssel hinterlegt. Bitte erst einen Schlüssel anlegen.“ (`:167`)
- Schlüssel-Dialog (`:560-603`): H3 „Neuen {Anbieter}-Schlüssel hinterlegen“
  - Hinweis OpenAI: „OpenAI-Keys beginnen mit „sk-“
  - Hinweis Anthropic: „Nur API-Keys (sk-ant-api03-…). OAuth-Subscription-Tokens sind aus rechtlichen Gründen nicht erlaubt — siehe Anthropic ToS.“
  - Felder „Bezeichnung“ (Platzhalter „z.B. Mein Production-Key“), „Schlüssel“ (Platzhalter „sk-…“)
  - Buttons „Abbrechen“, „Speichern“

**SprachmodusSection**
- Status:
  - „{stand.hinweis}“, sonst „Dafür fehlt ein OpenAI-Schlüssel: [in der Modell-Konfiguration hinterlegen].“
- Checkboxen:
  - „Sprachmodus aktivieren (läuft über den Schlüssel der Organisation | über deinen OpenAI-Schlüssel)“
  - „Aktivierungswort „Hey AVA“ im Ruhezustand ( (braucht das lokale Sprachmodell, siehe unten))“
  - „Signalton beim Aktivieren“
- „Stimme: Marin. Ruhezustand nach {n} Sekunden Stille.“

**VoiceSection** (`S:3485-3663`)
- Status-Chips: „lädt…“, „Binary fehlt“, „Modell fehlt“, „Lädt herunter…“, „Bereit“, „Fehler“
- „{X MB} · gespeichert unter `{Pfad}`“
- Buttons „Sprachmodell herunterladen“, „Sprachmodell entfernen“, „Abbrechen“
- Bestätigung „Sprachmodell wirklich entfernen?“
- Installer:
  - „Whisper-Binary fehlt. Erwarteter Pfad: `…`.“
  - „Versucht erst eine vorhandene Installation auf dem System zu finden, danach `brew install whisper-cpp` (nur macOS). Du musst nichts manuell installieren.“
  - Button „Auto-Installation starten“/„Installiert…“
- Fortschritt „läuft… / {n} % · X / Y · X/s“

### Verbrauch
- Zeitraum-Pills: „7 Tage“, „30 Tage“, „90 Tage“
- Kennzahlen: „Anfragen“, „Input-Tokens“, „Output-Tokens“, „Cache-Read“ (Hinweis „Vom Anbieter gecachte Prompt-Tokens (verguenstigt)“, Umlaut fehlt, `:100`)
- Diagramm: „Tokens pro Tag (gestapelt nach Modell)“, Achsen „Tag“/„Tokens“
- Leerzustände:
  - „Erst ein Tag mit Daten erfasst — das Diagramm braucht mindestens zwei Tage, um eine Entwicklung zu zeigen. Sobald morgen die ersten Anfragen laufen, erscheint hier der Verlauf. Die Summe oben zählt schon mit.“
  - „Noch keine Daten im gewählten Zeitraum. Schreib ein paar Nachrichten im Chat — die Aufzeichnung läuft automatisch.“
- Tabelle „Modell | Anfragen | Input | Output | Cache-Read | Tokens gesamt“
- Button „Verbrauchsdaten löschen“/„Lösche…“, Bestätigung „Alle Verbrauchsdaten lokal löschen? Die Producer/CRM/Audit-Daten bleiben unberührt.“, Ergebnis „{n} Einträge entfernt.“
- Tageslimit:
  - Platzhalter „kein Limit“, Einheit „Tokens / Tag“
  - Buttons „Speichern“, „Limit entfernen“
  - Fehler „Bitte eine ganze positive Zahl eingeben (oder Feld leeren für „kein Limit").“
  - „Aktuell kein Limit aktiv.“ / „Heute verbraucht: X von Y Tokens{ — Limit erreicht, Anfragen pausiert.}“
- Fehler „Konnte Verbrauchsdaten nicht laden: …“

### Datenquellen

**LinkedInSection**
- Hauptschalter:
  - Checkbox „LinkedIn-Beobachter aktivieren“, „Einwilligung erteilt am {Datum} · [Einwilligung widerrufen]“
  - Status-Pills „Nicht verbunden“ / „Verbunden“
- Verbindung:
  - „Melde dich bei LinkedIn an, damit AVA deinen Feed lesen kann. AVA öffnet dazu ein Fenster mit der echten LinkedIn-Login-Seite — Passwort und 2FA-Code gibst du dort direkt ein. AVA sieht dein Passwort nie.“
  - Buttons „Mit LinkedIn verbinden“ / „Anmeldefenster offen…“
  - „Verbunden seit {Datum}{ · memberUrn}. Cookies sind verschlüsselt im Schlüsselbund deines Betriebssystems abgelegt.“
  - Buttons „Verbindung erneuern“ (Tooltip „Erneut über das Login-Fenster verbinden, ohne die aktuelle Sitzung vorher zu löschen“), „Verbindung trennen“
  - „Bei nächster Hintergrund-Aufgabe meldet AVA sich mit den gespeicherten Cookies an. LinkedIn fordert gelegentlich eine erneute Anmeldung; klick dann auf „Verbindung erneuern", das Login-Fenster öffnet sich wieder.“
  - Fehler: „Anmeldung abgebrochen.“, „Anmeldung fehlgeschlagen — keine Sitzungs-Cookies erkannt.“, „Zeitüberschreitung. Bitte erneut versuchen.“, „Anmeldung fehlgeschlagen.“
- Bildanalyse:
  - Radios „Aus“, „Nur lokales Modell (Standard)“, „Lokal + Cloud-Anbieter erlauben“
  - Bestätigung: „Cloud-Bildanalyse einschalten? Bilder werden an deinen konfigurierten LLM-Provider gesendet — sie verlassen damit dieses Gerät.“ Buttons „Ja, Cloud-Bildanalyse aktivieren“, „Abbrechen“
  - Link „Cloud-Bildanalyse zurücknehmen“
- Scan-Plan:
  - „Automatische Hintergrund-Scans“, „Intervall (Stunden)“
  - Button „Jetzt scannen“ / „Scan läuft… (Abbrechen)“ (Tooltips „Erst mit LinkedIn verbinden.“, „Aktuellen Scan abbrechen.“, „Feed jetzt scannen.“)
  - „Noch kein Scan ausgeführt.“
  - Zusammenfassung „Letzter Scan vor X · Sitzung abgelaufen./Netzwerkfehler./abgebrochen./Fehler (…). / {n} Beiträge gesehen, {n} neu, {n} Interaktionen, {n} Medien.“
  - Fehler „LinkedIn-Sitzung abgelaufen. Anmeldefenster wird geöffnet …“, „Scan fehlgeschlagen.“, „Netzwerkfehler. Später erneut versuchen.“
  - Checkbox „Vorsichtsmodus für Hintergrund-Scans“ (Tooltip „Längere Pausen zwischen Scrolls, mehrstufige Navigation über die Startseite, weniger Beiträge pro Lauf. Reduziert das Risiko, dass LinkedIn den Zugriff drosselt — verlangsamt aber jeden Hintergrund-Scan spürbar.“). Text: „Längere Pausen, langsameres Scrollen, weniger Beiträge pro Lauf. Wahrscheinlichkeit reduziert, dass LinkedIn den Zugriff drosselt. Verlangsamt aber spürbar.“
- Letzte Läufe:
  - „Jeder Scan legt einen Ordner mit Screenshots und einer run.json ab. Praktisch, wenn ein Lauf 0 Beiträge gesehen hat. Es werden die letzten 10 Läufe behalten, ältere werden automatisch gelöscht.“
  - „Noch keine Läufe.“
  - Status je Lauf: „0 Beiträge / n Beiträge / Login nötig / Netzwerkfehler / abgebrochen / Fehler / läuft / unbekannt“
  - Button „Ordner öffnen“
- Erfasste Daten:
  - „Insgesamt erfasst: n Beiträge · n Personen · n Interaktionen · n Medien (X MB)“
  - „Auswertung: n fertig · n ausstehend · n fehlerhaft · n übersprungen (kein LLM)“
  - „Bildanalyse: n analysiert · … übersprungen — Bildanalyse ist auf lokal beschränkt. Wechsle das Modell auf einen lokalen Anbieter, oder [erlaube Cloud-Analyse].“ bzw. „Aktuelles Modell kennt keine Bildanalyse. Wechsle z. B. auf gpt-4o-mini, claude-haiku-4-5 oder lokal gemma4:e4b. [Provider wählen]“
  - „Verknüpfungen: n Beiträge · n Treffer · n mehrdeutig · n ohne Treffer · n bekannte Firmen“
  - Button „Auswertung jetzt ausführen“ / „Werte aus… (Abbrechen)“ (Tooltips „Beobachter aktivieren.“, „Auswertung abbrechen.“, „Auswertung jetzt ausführen.“)
  - „Letzter Auswertungs-Lauf vor n Min“
  - „Letzter Fehler: … [Provider in Status wählen]“ (`S:1908`)
- Löschbereich:
  - „Löscht den gesamten `linkedin/`-Ordner dieser Installation: Cookies, gespeicherte Beiträge, abgeleitete Signale und die Einstellungen oben. Der Beobachter wird damit deaktiviert.“
  - Button „LinkedIn-Daten und -Einstellungen jetzt löschen“
  - Bestätigung „Wirklich? Cookies, gespeicherte Beiträge und Signale werden gelöscht. Diese Aktion ist nicht rückgängig zu machen.“
- Einwilligungsdialog (`c/LinkedInConsentModal:71-137`):
  - H3 „LinkedIn-Beobachter aktivieren“, „Bevor du diese Funktion einschaltest, lies bitte folgende Hinweise:“
  - 4 Punkte: „Risiko für dein LinkedIn-Konto. …“, „Daten bleiben lokal. …“, „DSGVO-Verantwortung. … Rechtsgrundlage prüfen (i. d. R. berechtigtes Interesse), DSGVO-Folgenabschätzung empfohlen, Auskunfts- und Löschpflichten beachten.“, „Jederzeit abschaltbar. …“
  - Checkbox „Ich habe gelesen und verstanden. Ich bin verantwortlich für die DSGVO-konforme Verarbeitung und nehme das Risiko für mein LinkedIn-Konto in Kauf.“
  - Buttons „Abbrechen“, „Aktivieren“/„Aktiviere…“

**CrmSection / CrmCard** (`S:947-1122`)
- „Lade…“
- Status „verbunden“/„nicht verbunden“
- Buttons „Verbinden“/„Verbinde…“, „Verbindung trennen“/„Trenne…“, „Demnächst verfügbar“
- „Konto: …“, „Zuletzt aktualisiert: …“
- Hilfetexte:
  - Salesforce: „OAuth-Integration ist verdrahtet, wird in den nächsten Wochen freigeschaltet. Wenn du Salesforce einsetzt, gib uns gerne kurz Bescheid, dann priorisieren wir dich für die Beta-Phase.“
  - HubSpot: „Verbindung über OAuth. Es werden CRM-Lese- und Schreibrechte für Kontakte, Firmen und Deals angefragt.“
  - Dynamics: „Microsoft-Identity-Integration ist verdrahtet, wird in den nächsten Wochen freigeschaltet. …“
- Platzhalter „contoso.crm4.dynamics.com“

**MailAccountSection**
- Formularfelder:
  - „Mail-Adresse“ (Platzhalter „ava@firma.de“), „Anzeigename“ („AVA“)
  - Legende „IMAP (Eingang)“: „Host“ („imap.firma.de“), „Port“, „TLS“, „Benutzer (Default: Mail-Adresse)“, „App-Passwort“ („(unverändert lassen)“)
  - Legende „SMTP (Ausgang)“: wie IMAP, dazu „App-Passwort (leer = wie IMAP)“
- Checkboxen:
  - „**AVA darf Mails verschicken** (Kill-Switch). Wenn deaktiviert, lehnt AVA jeden Versand ab — auch an Allowlist-Adressen.“
  - „**Auto-Triage für trusted Mails** (vollautonom). Bei eingehenden Mails von Allowlist-Sendern startet AVA automatisch eine Chat-Session und antwortet OHNE Rückfrage. Limits: max 5 Auto-Replies pro Thread, Cooldown 5min. Nicht-Allowlist-Mails bleiben unverändert manuell. Setzt aktivierten Versand voraus.“
- Buttons „Verbindung testen“, „Speichern“, „Abbrechen“
- Rückmeldungen „IMAP ✓/✗ · SMTP ✓/✗“, „Fehler: …“
- Zusammenfassung:
  - „IMAP host:port · SMTP host:port“, „Status: {verbinde…|verbunden|IDLE (Push)|Polling|getrennt|Fehler}“, „· n ungelesen“, „Versand deaktiviert“, „Letzter Fehler: …“
  - Buttons „Bearbeiten“, „Löschen“
  - Bestätigung „Mail-Konto wirklich löschen? Verbindungen werden getrennt, gespeicherte Mails bleiben für den Verlauf erhalten.“
- Allowlist:
  - Platzhalter „max@kunde.de oder *@kunde.de“, „Label, z. B. Max Mustermann“
  - Button „Hinzufügen“
  - Leerzustand „Noch keine Einträge — AVA agiert auf keine Mail autonom.“
  - Herkunft „AVA“/„manuell“, Button „Entfernen“
  - Bestätigung „Diesen Allowlist-Eintrag entfernen?“

**MailEntwurfSection**
- Select „Öffnen in“: „Automatisch (empfohlen)“ sowie aus `shared/mail-entwurf.ts:21-29` „Mail-Programm“, „Outlook-Entwurf (.eml)“, „Entwürfe-Ordner im eigenen Postfach“, „Gmail“, „Outlook im Web (Microsoft 365)“, „Outlook.com“
- Entwurfs-Postfach:
  - Pill „verbunden“, „{host} · Ordner „Entwürfe“ · geprüft {Datum}“
  - Buttons „Ändern“, „Entfernen“
  - Felder „Anbieter“, „E-Mail-Adresse“, „Anzeigename“ („Vorname Nachname“), „Benutzername (meist die Adresse)“, „Passwort (leer lassen = unverändert)“ / „Passwort bzw. App-Passwort“, bei „andere“ zusätzlich „IMAP-Server“, „Port“, „TLS“
  - Buttons „Verbinden und speichern“/„Verbinde …“, „Abbrechen“
  - Rückmeldung „Verbunden. Entwürfe landen ab jetzt bei Bedarf im Entwürfe-Ordner.“
- Feste Anhänge:
  - Platzhalter „Wofür? z. B. „Firmenprofil für Erstkontakt“
  - Checkbox „An jede Outreach-Mail“
  - Buttons „Entfernen“, „Datei hinzufügen“

**ThemenSection**
- Leerzustand: „Noch keine Themen. AVA prüft dann nur Stellenanzeigen und Arbeitgeberleistungen.“
- Checkbox „aktiv“ (Tooltip „Höchstens 5 aktive Themen“)
- „Wozu: …“, Chips (Tooltips „von AVA ergänzt“/„von dir“), „noch keine Begriffe“
- Buttons:
  - „Bearbeiten“
  - „Begriffe ergänzen lassen“/„Ergänzt…“ (Tooltip „Synonyme, Schreibweisen und englische Entsprechungen mit dem Hintergrund-Modell ergänzen“)
  - „Löschen“, „+ Thema anlegen“
- Formular:
  - „Name“ (Platzhalter „Betriebliche Altersvorsorge“)
  - „Was ist gemeint?“ („Die Firma bietet ihren Beschäftigten eine betriebliche Altersvorsorge an“)
  - „Wozu brauchst du das?“ („Wir beraten zu bAV; Firmen mit bestehendem Angebot sind Wechselkandidaten“)
  - „Eigene Suchbegriffe (durch Komma getrennt)“ („Altersvorsorge, bAV, Pensionskasse“)
  - Buttons „Speichern“, „Abbrechen“

### Automatisierungen

**WatchesSection**
- „Lädt…“, Leerzustand „Noch keine Watches registriert.“
- Zeile:
  - „Rubrik: …“
  - „täglich/wöchentlich/monatlich · n Firma(n) · Topics: … · noch kein Treffer / n Treffer (zuletzt …) · zuletzt geprüft …“
  - Buttons „Pausieren“/„Aktivieren“, „Löschen“
  - Bestätigung „Diesen Watch wirklich löschen? Treffer-Historie geht verloren.“
- Anlegen:
  - Button „+ Neuen Watch anlegen“ (Tooltip „Maximalanzahl Watches erreicht“)
  - Formular H4 „Neuen Watch anlegen“, Text „Der Heartbeat-Loop prüft alle Kandidaten gegen deine Rubric. Bei Treffer landet eine Meldung in [Meldungen].“
  - Felder:
    - „Worüber willst du benachrichtigt werden? (frei formuliert)“ („z. B. wenn bei meinen Firmen Geschäftsführer wechseln“)
    - „Rubric (1-Satz-Kriterium für den LLM-Judge — konkret und beobachtbar)“ („z. B. Wechsel auf C-Level (Geschäftsführung, Vorstand)“)
    - „Cadence“ (täglich/wöchentlich/monatlich)
    - „Topics (optional — nur diese Kandidaten-Arten prüfen)“ mit „Publikationen“, „Finanz-Delta“, „Profil-Änderung“, „Evaluations-Flag“
    - „Company-IDs (optional, Komma-getrennt — nur diese Firmen beobachten)“ (Platzhalter „<companyId-1>, <companyId-2>“), Hinweis „IDs aus „Meine Firmen" kopieren (oder via Chat „Beobachte ACME …" anlegen, dann erkennt AVA die Firma automatisch).“
  - Buttons „Watch starten“, „Abbrechen“, Fehler „Fehler: …“

**LinkMonitorSection**
- „Lädt…“, „Noch keine Links in Überwachung.“
- Zeile:
  - Pills „aktiv/pausiert/Fehler“, „prüft gerade…“, „LinkedIn“
  - „{Intervall} · zuletzt geprüft … · {keine Änderung | Änderung erkannt | Timeout (Teilergebnis) | Fehler}“
  - „Achten auf: …“, „Letzte Änderung (…): …“
- Buttons:
  - „Jetzt prüfen“/„Prüft…“ (Tooltips „Ein Durchlauf läuft gerade — das kann bis zu 3 Minuten dauern.“ / „Sofort einen Durchlauf starten“)
  - „Pause“/„Fortsetzen“, „Bearbeiten“, „Löschen“
  - „+ Link zur Überwachung hinzufügen“
- Alerts:
  - „Prüfung konnte nicht gestartet werden.“
  - „Die Prüfung ist fehlgeschlagen. Details stehen im Verlauf (Einstellungen → Verlauf).“
  - „Prüfung fehlgeschlagen: …“
- Bestätigung „Überwachung für „X" wirklich löschen? Verlauf geht verloren.“
- Formular:
  - H4 „Neuen Link überwachen“ / „Überwachung bearbeiten“
  - „Link (URL)“ („https://example.com/produkte“)
  - „Worauf achten? (optional)“ („z. B. Pagination durchgehen, auf neue Produkte achten“)
  - „Frequenz“: „Alle 5 Minuten“, „Alle 15 Minuten“, „Stündlich“, „Täglich“, „Wöchentlich“, „Benutzerdefiniert (Minuten)“; dazu „Minuten (5–10080)“
  - Buttons „Überwachung starten“/„Speichern“, „Abbrechen“

**SchedulerSection**
- „Lädt…“, „Noch keine Jobs angelegt.“
- Zeile:
  - Pills „aktiv/pausiert/abgelaufen/fertig/abgebrochen“
  - „alle n min · x/y Runs · nächster Run: … · Auto-Stop …“, „→ an (CC: …) · Betreff: …“, „Firma: …“, „Letzter Fehler: …“
  - Buttons „Pause“, „Fortsetzen“, „Stoppen“
  - Bestätigung „Job "X" wirklich stoppen? Kann nicht rückgängig gemacht werden — du müsstest ihn neu anlegen.“
- Button „+ Neuen Mail-Loop anlegen“
- Formular H4 „Neuen Mail-Loop anlegen“, Text „Min Intervall 1 min · Max 7 Tage Laufzeit · Empfänger müssen in der Mail-Allowlist stehen.“
  - „Label (kurz, was der Job tut)“ („z. B. Stündlicher Status-Ping“)
  - „An (Komma-getrennt, müssen in der Mail-Allowlist stehen)“ (Platzhalter **„joyce@quikk.de“**, eine persönliche Adresse fest im Code, `:270`)
  - „CC (optional, Komma-getrennt)“, „Betreff“, „Inhalt“, „Intervall (Minuten)“, „Auto-Stop (Stunden, max 168)“, „Erste Mail sofort“
  - Buttons „Job starten“, „Abbrechen“

**FreshnessSection**
- Checkbox „Auto-Aktualisierung aktivieren“
- Legende „Cadence pro Schritt (Tage)“ mit Zeilen und Hinweisen (`S:4199-4225`), jeweils plus „0 = aus“:
  - „Kontakte“: „Personalwechsel; wöchentlich ist sinnvoll.“
  - „Profil“: „Stammdaten-Drift, Adressen, Geschäftsführung.“
  - „Website-Crawl“: „Webseite-Änderungen; ~wöchentlich.“
  - „Strukturierte Inhalte“: „Aggregierte Sicht; monatlich genügt.“
  - „Publikationen“: „Jahresabschlüsse; monatlich (Producer-Sperre 30 Tage).“
- Legende „Drosselung“: „Max. Aufrufe pro Stunde (Schritt)“, „Max. Aufrufe pro Stunde (gesamt)“, „Pro Tick maximal“
- „Priorisierte Firmen“ (rohe IDs, Button „×“ mit Tooltip „Entfernen“)
- Button „Jetzt scannen“/„Scan läuft…“
- Verlauf:
  - Leer: „Noch kein Aktualisierungs-Lauf in dieser Sitzung. Klick „Jetzt scannen“ um die Warteschlange zu sehen.“
  - H4 „Letzte Aktualisierungs-Läufe“
  - Zeilen „n Zellen geprüft · n veraltet · n neu gestartet“ / „übersprungen (…)“
  - Details „Übersprungen: …“, „Keine veralteten Zellen. Alles innerhalb der konfigurierten Cadence.“, „neu gestartet“/„übersprungen“, „{stage} · Xd / Yd Cadence · Score 0.00 · pinned“ (Tooltip „Firmendetail öffnen“)

**EmailMusterSection**
- Checkboxen:
  - „E-Mail-Ableitung aktiv“
  - „Firmenadressen Personen zuordnen (mit KI-Urteil)“
  - „Unverifizierte Ableitungen anzeigen“
- „Verifizierungsrate“ (Tooltip „Mail-Server-Anfragen (RCPT TO) je Stunde von diesem Rechner, gleichmäßig über die Stunde verteilt (bei 300 alle 12 Sekunden eine Anfrage). Höher = schneller, aber mehr Last auf fremden Mailservern.“), Zusatz „Anfragen je Stunde, gleichmäßig verteilt (Standard {n})“

**VorschlaegeSection**: Checkboxen „Auf der Startseite“, „Im Gespräch nach einer Antwort“

**MithelfenSection**
- Checkboxen:
  - „Mithelfen: Register-Jobs auf diesem Rechner abarbeiten“
  - „Nur im Netzbetrieb, im Akkubetrieb pausieren“
  - „Worker-Modus: nur Handelsregister verarbeiten, alles andere ruhen lassen“
- Text zum Worker-Modus (`:88-90`): „Im Worker-Modus arbeitet AVA ausschließlich Handelsregister-Jobs ab: Registerblätter, strukturierter Registerinhalt und später Gesellschafterlisten. Herzschlag, Vorgänge, Producer, Abläufe, Mail und Radar ruhen so lange. Du kannst die App normal bedienen, und gespeicherte Daten bleiben sichtbar. Schalte den Modus aus, damit AVA wieder alles verarbeitet.“
- Status:
  - „Arbeitet: {Art}“ / „Wartet auf Jobs.“ / Pausengründe (`:5-12`): „Ausgeschaltet.“, „Deine Organisation hat das Mithelfen abgeschaltet.“, „Du bist nicht angemeldet.“, „Pausiert im Akkubetrieb.“, „Der Worker ist in dieser Installation nicht enthalten.“, „Das Registerportal hat die Abfragen vorübergehend gesperrt, es geht automatisch weiter.“
  - dahinter „Erledigt seit Start: n. Abfragen in der letzten Stunde: n von 60. Letzter Fehler: …“
- „Geteilte Queue: n offene Jobs, n heute erledigt, n Rechner in der letzten Stunde aktiv.“
- „Seit {Datum}: n Jobs, n Abfragen, n Registerblätter gelesen, n Firmen neu, n geändert.“
- Tabelle „Zeit | Art | Was | Abfragen | Treffer | Neu | Geändert“
- Buttons „Weniger anzeigen“ / „Alle n anzeigen“
- Arten (ART_TEXT `:14-34`): „Neue Firmen (Nummernfront)“, „Registerbekanntmachungen“, „Auffrischung bekannter Firmen“, „Insolvenzprüfung“, „Neue Firmen Österreich (Firmenbuch)“, „… Österreich (Firmenbuch-Detail)“, „… (Ediktsdatei)“, „Monatsabzug Vereinigtes Königreich (Companies House)“, „… (Firmenseite)“, „… (Companies House, Gazette)“, „Erstabzug Schweiz (Handelsregister)“, „Tagesmeldungen Schweiz (Handelsamtsblatt)“, „… (Handelsregister-Detail)“, „Erstabzug Norwegen (Enhetsregisteret)“, „Tagesänderungen Norwegen (Enhetsregisteret)“, „Auffrischung Norwegen (Einheit und Rollen)“, „Erstabzug Finnland (Kaupparekisteri)“, „Neue Firmen Finnland (Kaupparekisteri)“, „Auffrischung Finnland (Firma)“

**BrowserSection**: Statuszeilen „Eigener Browser bereit (Fassung {v}).“, „Wird geladen … n %“, „Noch nicht geladen. AVA nutzt so lange den Browser, der auf diesem Rechner installiert ist.“, „Konnte nicht geladen werden: … AVA nutzt so lange …“ (`:23-27`)

**AlertsSection**
- „Heartbeat-Frequenz“: „Alle 5 Minuten“, „Alle 15 Minuten“, „Alle 30 Minuten“, „Stündlich“, „Aus (manuell auslösen)“
- Checkboxen:
  - „System-Benachrichtigungen aktivieren“ (bei fehlender Berechtigung erscheint `permission.reason`)
  - „Fehlgeschlagene Schritte automatisch erneut versuchen“ mit Erklärung „Wenn aktiv, prüft der Heartbeat alle 10 Minuten die Matrix und startet rote Zellen neu. Nach fünf Versuchen über 24 Stunden hinweg wird die Zelle aufgegeben (manueller Retry bleibt möglich).“
- „Schweregrad-Schwelle für Push“: „Alle (Info und höher)“, „Ab Achtung“, „Nur Dringend“
- Legende „Ruhezeiten“: „Während dieses Zeitfensters keine Push-Meldungen“, „Von“, „bis“, „Wochenenden ganztägig stumm“
- Button „Jetzt Heartbeat auslösen“/„Heartbeat läuft…“
- Verlauf:
  - „Lade Heartbeat-Status…“, „Heartbeat ist pausiert (Cadence = 0).“, „Sweep läuft alle n min · Sweep läuft gerade… · nächster planmäßig HH:MM (in n min | gleich) · letzter Sweep HH:MM“
  - „Noch kein Sweep in dieser Sitzung abgeschlossen. Die Liste füllt sich, sobald der erste Sweep durchgelaufen ist.“
  - Tick-Zusammenfassung „n Kandidat(en) geprüft · n neue Meldung(en) · n Duplikat(e)“ / „übersprungen (…)“
  - Details „Tick übersprungen: ….“, „Keine neuen Kandidaten in diesem Sweep. Der Heartbeat fragt die Quellen seit dem letzten Lauf ab. Wenn nichts hereingekommen ist, gibt es nichts zu bewerten.“
  - Ergebnis-Labels „gemeldet ({severity})“, „Duplikat“, „nicht alarmwürdig“, „Fehler“, „gesammelt“. Die Severity erscheint roh als `info|warn|urgent` (`S:4075`).

**RelevanzSection**
- Checkbox „Relevanz erfassen“, oder bei Organisationsvorgabe: „Deine Organisation hat diese Einstellung verbindlich gesetzt: Die Erfassung ist ein-/ausgeschaltet.“
- Meldungen „Erfassung eingeschaltet.“, „Erfassung ausgeschaltet. Bereits Gesammeltes bleibt, bis du es löschst.“, „Alle Signale gelöscht.“, „Löschen fehlgeschlagen.“
- Buttons „Erfasste Signale ansehen/ausblenden“, „Alles löschen“. Für „Alles löschen“ gibt es keine Bestätigung.
- Tabelle „Wann | Was | Wozu“, „Wird geladen …“, „Bisher wurde nichts erfasst.“, „Die 200 jüngsten von n Einträgen.“
- Signalarten (`:26-45`): „Firma angesehen“, „länger in der Firmenansicht“, „Firmenlink im Chat geöffnet“, „im Chat behandelt“, „in Meine Firmen übernommen“, „Import gestartet“, „in einem Workflow verwendet“, „auf die Watchlist gesetzt“, „mit dem CRM verknüpft“, „Meldung geöffnet“, „Meldung wiederholt weggewischt“, „Profil geöffnet“, „DSGVO-Hinweis kopiert“, „ins CRM übernommen“, „Mailentwurf begonnen“, „über die Kontaktsuche gefunden“, „auf die Personen-Watchlist gesetzt“
- Spalte „Wozu“ zeigt „Person/Firma {rohe ID}“

**TelegramSection**
- „Lädt…“
- Schlüsselbund fehlt: „Der System-Schlüsselbund ist nicht verfügbar — der Bot-Token kann nicht sicher gespeichert werden.“
- Schritte: „Öffne in Telegram **@BotFather** und schicke `/newbot`.“, „Namen vergeben — BotFather antwortet mit einem Token.“, „Token hier einfügen:“ (Platzhalter „123456789:ABCdef...“), Button „Verbinden“/„Prüft…“
- Pills „@bot“/„Bot verbunden“, „Chat verknüpft“/„Chat fehlt noch“, „n in Warteschlange“
- Zustand:
  - „Zuletzt zugestellt …: … .“ / „Seit dem App-Start noch nichts zugestellt.“
  - „Zuletzt zurückgehalten … (Grund): ….“, „Letzter Fehler: ….“
  - „Dringende Meldungen (Insolvenz, Löschung) gehen immer raus, auch in Ruhezeiten.“
- „Schicke deinem Bot in Telegram eine Nachricht (z. B. `/start`) und klicke dann auf „Chat verknüpfen“ — AVA liest die Chat-ID automatisch aus.“
- Buttons „Chat verknüpfen“/„Chat neu verknüpfen“, „Testnachricht senden“, „Trennen“
- Checkbox „Meldungen an Telegram senden ( (erst Chat verknüpfen))“
- Select „Ab welcher Wichtigkeit?“: „Alle Meldungen“, „Ab „wichtig““, „Nur dringende“
- Checkbox „Auf meine Nachrichten antworten (Gegenrichtung)“ mit Text „AVA liest Nachrichten aus **diesem** Chat und antwortet darauf — wie bei der Mail-Bearbeitung. Nachrichten aus anderen Chats werden verworfen.{ Aktionen, die am Rechner eine Rückfrage brauchen (z. B. etwas im CRM löschen), sind über Telegram bewusst nicht möglich.}“
- Checkbox „Rückfragen aufs Handy erlauben“
- Checkbox „Standardmäßig als Sprachnachricht antworten“ mit Text „AVA antwortet dann mit ihrer Stimme (OpenAI, braucht einen OpenAI-Schlüssel; wenige Cent je Antwort). In Telegram steuerst du es je Nachricht: „gerne per Sprachnachricht“ oder „gerne per Textnachricht“; mit „immer“ stellst du den Standard um.“
- Rückfragen-Text: „Braucht eine Aktion eine Bestätigung oder Auswahl, stellt AVA die Rückfrage direkt in diesem Chat (Antwort per Nummer oder Text, „abbrechen" bricht ab). Kommt innerhalb von 3 Minuten keine Antwort, wird die Aktion abgebrochen. Damit sind auch Aktionen mit Bestätigungspflicht — etwa CRM-Löschungen — vom Handy aus möglich.“
- „Wieviel AVA ohne Rückfrage erledigen darf, steuerst du zentral über den Modus-Schalter am Chat-Eingabefeld — er gilt auch hier.“
- Checkbox „Ruhezeiten auch für Telegram beachten“
- Meldungen:
  - „Bot @x erkannt. Schicke ihm jetzt in Telegram „/start“ und klicke dann auf „Chat verknüpfen“.“
  - „Chat verknüpft: …“
  - „Testnachricht gesendet — schau in deinen Telegram-Chat.“
  - „Verbindung getrennt.“
  - Fehler „Verbindung fehlgeschlagen.“, „Chat konnte nicht ermittelt werden.“, „Testnachricht fehlgeschlagen.“
- Bestätigung „Telegram-Verbindung trennen? Der Bot-Token wird gelöscht.“

### Wissensquellen
- Badges „verbunden“, „noch nicht verbunden“, „demnächst“
- „Workspace: …“, „Verbunden seit …“, „Folgt in einer kommenden Version.“
- Buttons „Verbinden“/„Verbinde…“, „Trennen“, „Abbrechen“
- Warnung: „⚠ OS-Schlüsselbund nicht verfügbar — Wissensquellen-Tokens können nicht sicher gespeichert werden. Bitte libsecret/Schlüsselbund-Dienst aktivieren und neu starten.“
- Notion-Schritte (`:210-238`), Platzhalter „ntn_… oder secret_…“, Fehler „Bitte Token eingeben.“
- Obsidian-Schritte (`:336-353`), Felder „Base-URL“, „API-Key“ (Platzhalter „aus Plugin-Settings kopieren“), Fehler „API-Key fehlt.“, „Base-URL muss mit http:// oder https:// beginnen.“

### Skills (`SK`)
- Buttons oben: „Neues Skill“, „Importieren“, „Alle exportieren“, „SKILL.md einfügen“/„Einfügen abbrechen“, „Aktualisieren“/„Lädt neu…“, „Skills-Ordner öffnen“
- Hinweisleiste: „**Vertrauensänderungen:** n Skill(s) wurde(n) seit der letzten Freigabe geändert.“, Button „Alle prüfen“
- Einfügen: „SKILL.md-Inhalt einfügen:“, Buttons „Aus Text importieren“, „Abbrechen“
- Ablagefläche: „Datei hier loslassen, um zu importieren“ / „Skill-Paket (.zip) oder einzelne SKILL.md hierher ziehen“
- Leerzustand: „Noch keine Skills installiert. Lege eines per *Neues Skill* an, nutze *Importieren* für ein Skill-Paket oder ziehe ein .zip/SKILL.md direkt hierher.“, Buttons „Neues Skill anlegen“, „Pfad öffnen“
- Karte:
  - Pills Scope („Outreach“, „Qualifying“, „Wettbewerb“, „Datenextraktion“, „Intern“) und Quelle („Nutzer“, „Workspace“)
  - Pills „Vertrauen erforderlich“, „Geändert seit letzter Freigabe“, Schalter „Aktiv“
  - Vertrauenstexte: „Dieses Skill wurde seit der letzten Freigabe geändert. Bitte erneut prüfen, bevor der Agent es benutzt.“ / „Dieses Skill ist noch nicht freigegeben. Der Agent benutzt es erst nach deiner Bestätigung.“, Buttons „Erneut prüfen“/„Vertrauen prüfen“
  - Buttons „Anzeigen“, „Bearbeiten“, „Datei öffnen“, „Exportieren“, „Löschen“ (Tooltip „Workspace-Skills werden im Projekt-Repo verwaltet.“)
  - Status: „Voraussetzung fehlt: …“, „Inaktiv bis zur Freigabe“, „Deaktiviert“, „Nur explizit (/name)“, „Aktiv“
- Modal: „Schließen“, „Skill nicht gefunden. Wurde die Datei gerade gelöscht?“
- Meldungen:
  - „Workspace-Skills werden im Projekt-Repo verwaltet und können hier nicht gelöscht werden.“
  - „Skill 'x' wirklich endgültig löschen? Die Datei … wird entfernt.“
  - „Keine gültigen Skills im Paket gefunden.“, „SKILL.md-Body ist leer.“
  - „n Skill(s) nach … exportiert.“
  - „Du hast das Skill umbenannt. Die alte Datei 'x' bleibt auf der Platte. Jetzt löschen?“

### Verlauf
- Selbstkorrekturen:
  - „Top-Tools mit Workaround:“
  - Buttons „Als JSON kopieren“, „Alle löschen“, „Eintrag löschen“
  - „Workaround:“, „Fix-Vorschlag:“, „Original-Fehler“, „Conversation:“
  - Alerts „In die Zwischenablage kopiert.“, „Konnte nicht kopieren — bitte Console-Log nutzen.“
  - Bestätigung „Alle n Selbstkorrektur-Meldungen löschen? Damit gehen die Hinweise auf Tool-Probleme verloren — sicher?“
- Audit-Trail:
  - Filter „Zeitraum“ („Letzte Stunde“, „Heute (24h)“, „7 Tage“, „30 Tage“, „Gesamt“)
  - „Suche“ („Aktion oder Beschreibung …“)
  - „Kategorie“ („Alle“; „Producer“, „LinkedIn“, „CRM“, „Authentifizierung“, „Import“, „Beobachter“, „Hintergrund-Jobs“, „Kosten“, „App-Update“, „Chat-Agent“)
  - „Schwere“ („Info“, „Warnung“, „Fehler“), Tooltips „Alle abwählen/auswählen“
  - „Live-Updates“
  - Buttons „JSON exportieren“, „Verlauf leeren“, „Ältere laden“/„Lädt …“
  - Leerzustand: „Noch keine Events im gewählten Zeitraum. Sobald AVA Producer startet, Heartbeats laufen oder du Aktionen ausführst, taucht hier ein chronologischer Eintrag auf.“
  - „n sichtbar · n gesamt im Filter“
  - Details „Aktion“ (roher Code), „Akteur“ (roher Typ), „Subjekt“, „Seitenansicht“ (Screenshot, alt-Text „Screenshot der überwachten Seite“, Tooltip „In voller Größe öffnen“), „Metadaten“ (rohes JSON)
  - Bestätigung „Den gesamten Audit-Trail unwiderruflich löschen? Diese Aktion betrifft nur deine lokale Datenbank — keine Cloud-Daten.“

### System
- **Updater**:
  - „Installiert: AVA v{x}“, „Neue Version verfügbar: v{y}“, „Lade herunter: n % (x MB/s)“, „Technische Details“
  - Buttons „Jetzt nach Updates suchen“, „v{y} herunterladen“, „Neu starten und v{y} installieren“, „Update wird installiert… Anwendung startet gleich neu“
  - Fehlertexte aus `lib/updater-error.ts:41-126`:
    - „Ein neues Update wird gerade vorbereitet. Versuch es in ein paar Minuten erneut — der Build-Server ist noch nicht fertig.“
    - „Der erwartete Release-Artefakt ist noch nicht verfügbar. …“
    - „Konnte den Update-Server nicht erreichen (DNS-Auflösung fehlgeschlagen). …“
    - „Netzwerkproblem beim Update-Server. …“
    - „Der Update-Server hat zu lange gebraucht. …“
    - „Update wurde heruntergeladen, aber die Signatur stimmt nicht. Lade die App bitte manuell neu von GitHub Releases.“
    - „Auf der Festplatte ist nicht genug Platz für das Update. …“
    - „Update-Prüfung fehlgeschlagen: …“
- **Ollama**:
  - „Installiert:“ plus Badge „aktuell“, „Neueste verfügbare Version:“ („(GitHub nicht erreichbar)“), „Mindestversion:“ (Tooltip „AVAs Mindestversion. Floor schützt vor seltsamen Upstream-Antworten.“)
  - „Prüfe Update…“, „Lade Ollama x herunter… n %“, „Installiere Ollama x…“, „Update fehlgeschlagen: …“/„Unbekannter Fehler“
  - Buttons „Auf x aktualisieren“/„Aktualisieren“, „Erneut prüfen“ (Tooltip „Auch wenn keine neuere Version verfügbar scheint, einen Update-Lauf erzwingen.“)
- **Speicher**:
  - „Gesamt (von AVA verwaltet):“, „Nicht benötigte Modelle:“
  - Button „Nicht benötigte Modelle entfernen (X freigeben)“/„Wird bereinigt…“
  - Reiter „Sprachmodelle“, „Spracherkennung“, „Programm & Cache“, „Deine Daten“
  - „Ordner öffnen“, „Nichts vorhanden.“, „Wird geladen…“, „Leeren“/„Löschen“, „Aktualisieren“
  - Bestätigungen „„x" leeren (X freigeben)?“, „„x" endgültig löschen (X freigeben)?“, „n nicht benötigte Modell(e) entfernen und X freigeben? Das aktive und die erforderlichen Modelle bleiben erhalten.“
- **Postgres**:
  - „Status:“ mit den Zuständen „noch nicht gestartet“, „wird initialisiert (einmalig, ~5 s)…“, „startet…“, „bereit“, „Fehler“, „fährt herunter…“
  - „Version: PostgreSQL x“, „Endpoint:“, „Datenverzeichnis:“, „Fehler:“
- **Producer**:
  - „Keine Producer konfiguriert.“
  - Zeile „{name}: {Status} · Port n · PID n · Queue: n (+n in flight)“
  - Status zusätzlich „Datenbank-Migrationen…“, „nicht installiert“
  - „Original-Fehlermeldung“, „⚠ {featureWarning}“
  - Fehlerkategorien aus `lib/producer-error.ts:54-143`, z. B. „Verbindung zum Cloud-Broker (AMQP) verloren — Producer wartet auf erneute Verbindung.“, Hinweis „Bei Anthropic: Pro/Max-Abo prüfen oder Tier hochstufen. Bei OpenAI: Guthaben aufladen.“
  - MithelfenZeile: „register-delta (Stammdaten mitpflegen): {aus (Automatisierungen → Stammdaten mitpflegen) | … | arbeitet | bereit, wartet auf Jobs} · Job {Art} · Abfragen letzte Stunde: n/60 · erledigt: n“
- **Diagnose**:
  - „Protokolldatei:“ / „wird ermittelt …“
  - Buttons „Im Finder anzeigen“, „Log-Ordner öffnen“
- **Zurücksetzen**:
  - Button „Alles zurücksetzen (außer KI-Modelle)“
  - Dialog H4 „Wirklich alles zurücksetzen?“: „Diese Aktion kann **nicht rückgängig** gemacht werden. Alle Chats, dein Profil, sämtliche Verbräuche und alle Integrationen (inkl. HubSpot/LinkedIn/E-Mail-Zugänge) werden endgültig gelöscht.“ / „Deine KI-Modelle (Provider, API-Keys/Anmeldungen, heruntergeladene Modelle) bleiben erhalten. AVA startet danach neu.“
  - „Zum Bestätigen **ZURÜCKSETZEN** eingeben:“
  - Buttons „Abbrechen“, „Endgültig zurücksetzen & neu starten“/„Wird zurückgesetzt…“
  - Fehler „Zurücksetzen fehlgeschlagen: …“

---

## 3. Fachjargon und entwicklerseitige Texte (Fundstellen für Vertriebsnutzer)

### Allgemein, Kopf, System
- `S:548-549` „Pipeline“, „Agent“, „zur Laufzeit“
- Versionsnummern im UI:
  - `S:553-555` „AVA v{version} · {channel} · dev“
  - `S:586`, `S:591`, `S:640`, `S:645` „v{…}“
  - `c/DiagnoseSection:36` „seit v0.1.338“
  - `s/InstanzenSection:128` „v{version}“
  - `s/BrowserSection:23` „(Fassung {version})“
  - `S:702` „PostgreSQL {version}“
  - `c/OllamaVersionSection:92-108` Versionsnummern
  - `s/ResearchFeaturesSection:59` Modellname mit Datum „o4-mini-deep-research-2025-06-26“
- `S:621` „Technische Details“
- `S:687-692` „eingebettete PostgreSQL-Instanz“, „Producer-Dienste“, „127.0.0.1“
- `S:707` „Endpoint:“, `S:713` „Datenverzeichnis“
- `S:809` „Datenbank-Migrationen…“
- `S:836-841` „Lokale Producer-Dienste“, „Tenant-private Dienste“, „Node-Subprozesse“, „AMQP“, „Cloud-Gateway“
- `S:862-877` „Port“, „PID“, „Queue“, „in flight“
- `S:782` „register-delta“, „Job“
- `S:762-777` und `s/MithelfenSection:15-33`: „Nummernfront“, „Companies House“, „Gazette“, „Enhetsregisteret“, „Kaupparekisteri“, „Erstabzug“, „Monatsabzug“
- `lib/producer-error.ts:55-135`: „Credentials“, „Producer-Binary“, „Subprozess“, „Cloud-Broker (AMQP)“, „persistieren“, „API-Quota oder Rate-Limit“, „Producer-Sweep“, „System → Logs“, „Pro/Max-Abo“ (veraltet)
- `lib/updater-error.ts:42-115`: „Build-Server“, „Release-Artefakt“, „DNS-Auflösung“, „Signatur“, „GitHub Releases“
- `c/OllamaVersionSection:83-108`: „Ollama-Laufzeit“, „Ollama-Instanz“, „GitHub“, „Floor“, „Upstream-Antworten“, `:152` „Update-Lauf erzwingen“
- `c/StorageSection:35` „Programm & Cache“
- `c/DiagnoseSection:36-40,60,70` „Protokoll“, „MacBooks“, „Im Finder anzeigen“ (nur macOS), „Log-Ordner“
- `c/DangerZoneSection:60`, `:92` „Provider + API-Keys/Anmeldungen“

### Modelle
- `S:73-82` „Ollama (lokal)“, „xAI (Grok)“, „Qwen“
- `S:94-123` (PROVIDER_FEATURES, komplett technisch): „website-Producer“, „Deep Research (o4-mini-deep-research)“, „Google-Maps-Entity-Resolution“, „Quellen-Discovery (gpt-6-luna)“, „bootet“, „Calls“, „Chat-LLM“, „LLM-getriebenen Producer-Stages (Profile, Contact, Evaluation, Publications)“, „Claude-Pro/Max-Abo“, „Gemini 3.8 Flash“, „Mistral Large 4“, „V4 Flash“, „1 Mio. Kontext“, „Grok 4.6: 500k Kontext“, „Qwen3.8 Max“, „Model-Studio-Endpunkt“
- `S:1971-1977` Optionstext „★ · 200k ctx · {costClass} · vision“ mit „ctx“, „vision“ und roher Kostenklasse auf Englisch
- `S:2051` „Agent-Anbieter“, `S:2116` „Lokal (Ollama)“, `S:2122` „OpenAI API-Schlüssel“, `S:2132` „Deep Research“
- `S:2222-2223` rohe Modell-IDs in `<code>`
- `S:2319` „Hintergrund-Verarbeitung“
- `S:2358-2361` „Stufe C/B/A/S“ (Modell-Tier ohne Erklärung), „GPT-5.6 Luna“
- `S:2379-2383` „Kontext 200k ctx“
- `S:2403` „API-Schlüssel“, `S:2406-2408` „OS-Schlüsselbund“, „Benutzerdatenordner“, „Entwicklungszwecke“
- `S:2438` „(Ollama)“
- `S:2556-2640` englische UI-Texte: „Eligible AI requests in this app use your ChatGPT plan.“, „Continue with ChatGPT“, „Reconnect with ChatGPT“, „Manage usage“, „Connecting…“, „ChatGPT → Settings → Usage“, „Plan-Freigabe“, „Plus- oder Pro-Kontingent“. Laut Kommentar `S:2461-2463` schreiben die OpenAI-Richtlinien Teile davon vor.
- `S:2683`, `S:2741` „Ollama-Prozess“, „Internal Server Error“
- `S:2685`, `S:2743` „Laufzeit“
- `S:2766` „Bewertungs-Service“, „globale Vektorsuche“
- `S:2779` „korrupte Layer“
- `S:2834` „Dock unten rechts“
- `S:2944-2946` „AVA-Gateway“, „Prompts“, „Prompt-Audit“
- `c/AnthropicTierBanner:44-64` „Tier 1/Tier 2“, „Token/Min“, „Token-Budget“, „Prompt-Caching“, „5 USD über die API“, „Anthropic-Console“
- `s/AzureOpenAIKarte:76-117` „Azure-Ressource“, „Deployments“, „Endpunkt“, „Modell → Deployment“, „Deployment-Name“
- `s/ResearchFeaturesSection`:
  - `:31` „Tender“, `:36` „Job-Angebote“
  - `:58-65` „gpt-6-luna + web_search“, „o4-mini-deep-research-2025-06-26 + web_search“, „claude-sonnet-5-5 + web_search“, „claude-opus-5 + web_search + adaptives Denken“
  - `:104` „LLM-gestützte Anreicherung“, `:110-111` „fakturiert“, `:115-117` „Basic-Cipher“, „Default“, „Linux“
  - `:316` „AVA-Gateway“, `:352` „Allgemeine Modell-Konfiguration“
  - `:381` „kein {openai}-Schlüssel“ (rohe Anbieter-ID), ebenso `:167`
  - `:395` „Key“, „Feature“, `:405` „Probe-Call“, `:410` „✓ {n}ms“
  - `:484-488` „API-Kosten“, „API-Gebühren“
  - `:533-534` „sk-“, „sk-ant-api03-“, „OAuth-Subscription-Tokens“, „Anthropic ToS“
  - `:572` „Production-Key“
- `s/SprachmodusSection:23` „Speech-to-Speech über OpenAI Realtime“, `:30` „Modell-Konfiguration“
- `S:3481` „Whisper“, `S:3577` „Whisper-Binary“, „Erwarteter Pfad“, `S:3582` „brew install whisper-cpp“, `S:3592` „Auto-Installation“, `S:3615` „Binary fehlt“, `S:3510` Dateipfad

### Konto
- `S:3283` „Agenten-Turn als Lese-Kontext eingewoben“, `S:3290` „Bio“, `S:3383` „Signal-Kriterien“, `S:3396` „Chip“, „Scan“
- `S:3115-3130` „Signal-Kalibrierung“, „Signalstärke-Vorlieben“, „destilliert“
- `S:5030` „`recall_memory`“, „Agent“
- `S:5156-5161` englische Tarifnamen „Free/Starter/Pro/Enterprise“
- `S:5212-5215` „Cloud-Instanz“, „Custom-Integrationen“, „SLA“
- `S:5368` „-Seat“, `S:5400` „Seat(s)“, „Notbremse“
- `S:5378`, `S:5469` „Radar-Scans“
- `S:5475`, `S:5644` „Stripe“, „Stripe-Kundenportal“
- `S:5546` „Free-Tier“
- `S:5196` „Stufe nach dem Lauf“, `S:5254` „noch ohne Stufe“
- `S:5295`, `s/KonsoleSection:10` „Owner“, „Admin“
- `s/KonsoleSection:23` „Organisationsschlüssel“
- `s/InstanzenSection:93-170`: „Instanz“, „Gateway“, „MCP“, „MCP-Aufrufe“, „(Server vor Desktop)“, **„ICP“** im Bestätigungstext (`:77`, ohne Erklärung), „Umzug“
- `s/VerbindungenSection:41-71` „MCP“, „https://mcp.ava.bi“, „admin.ava.bi“, „Gateway“, rohe clientId

### Datenquellen
- LinkedIn:
  - `S:1438` „BETA“
  - `S:1491` „2FA“
  - `S:1515` rohe „memberUrn“, „Cookies“
  - `S:1336` „Sitzungs-Cookies“
  - `S:1587`, `S:1594` „Cloud-Anbieter“, „LLM-Provider“
  - `S:1649`, `S:1658` „Scan-Plan“, „Hintergrund-Scans“
  - `S:1703` „Scrolls“
  - `S:1726` „run.json“, „Screenshots“
  - `S:1802` „(kein LLM)“
  - `S:1834` „gpt-4o-mini, claude-haiku-4-5 oder lokal gemma4:e4b“
  - `S:1836` „Provider wählen“, `S:1908` „Provider in Status wählen“
  - `S:1923` „`linkedin/`-Ordner“
- CRM:
  - `S:959-1002` „OAuth-Integration ist verdrahtet“, „Beta-Phase“, „OAuth“, „Deals“, „Microsoft-Identity-Integration“, „OAuth-Tokens“, „verdrahtet“
  - `S:1112` „contoso.crm4.dynamics.com“
- `s/MailAccountSection`:
  - `:187-189` „IMAP/SMTP-Postfach“, „Triage-Inbox“, „Allowlist“
  - `:227`, `:285` „IMAP“, „SMTP“
  - `:230-314` „Host“, „Port“, „TLS“, „Default“
  - `:270` „App-Passwort“
  - `:351-352` „Kill-Switch“
  - `:370-375` „Auto-Triage für trusted Mails“, „Chat-Session“, „Auto-Replies pro Thread, Cooldown 5min“, „Nicht-Allowlist-Mails“
  - `:475-477` „IDLE (Push)“, „Polling“
  - `:525-528` „Allowlist“, „Pattern“, „Domain-Wildcard“
  - `:540` „Label“
- `s/MailEntwurfSection`: `:171-180` „IMAP-Server“, „Port“, „TLS“; `:222`, `:254` „Outreach-Mail“; `shared/mail-entwurf.ts:24` „(.eml)“
- `s/ThemenSection:122`, `:126` **„bAV“** ohne Erklärung (in Platzhaltern); `:81` „Hintergrund-Modell“

### Automatisierungen
- Watches:
  - `S:4491`, `S:4501`, `S:4692`, `S:4781` „Watch(es)“
  - `S:4503`, `S:4702` „Heartbeat“, „Heartbeat-Loop“, „Kandidaten“
  - `S:4566` „Rubrik“
  - `S:4702`, `S:4717` „Rubric“, „LLM-Judge“, „C-Level“
  - `S:4579`, `S:4742` „Topics“
  - `S:4729` „Cadence“
  - `S:4628-4631` „Finanz-Delta“, „Evaluations-Flag“
  - `S:4766-4774` „Company-IDs“, „<companyId-1>“, „IDs … kopieren“
- Link-Überwachung (`s/LinkMonitorSection`): `:43` „Hintergrund-Browser“, `:53-54` „Bot-Schutz“, „Cloudflare-Sicherheitsprüfung“, `:265` „Timeout“, `:344` „URL“, `:359` „Pagination“
- Wiederkehrende Aufgaben (`s/SchedulerSection`): `:39-44` „Mail-Loops“, „Mail-Allowlist“, „Job(s)“; `:119-123` „Runs“, „nächster Run“, „Auto-Stop“; `:253` „Label“; `:260` „Status-Ping“; `:346` „Job starten“
- Aktualisierung:
  - `S:4283-4285` „Hintergrund-Loop“, „Pipeline-Stages“, „Cadence“, „Stille Disk-Arbeit“, „Heartbeat“
  - `S:4300` „Cadence pro Schritt“
  - `S:4202-4224` „Stammdaten-Drift“, „Website-Crawl“, „Aggregierte Sicht“, „Producer-Sperre“
  - `S:4332-4379` „Drosselung“, „Pro Tick maximal“
  - `S:4406` rohe Firmen-IDs
  - `S:4857` „Warteschlange“
  - `S:4918` „Zellen“, „Cadence“
  - `S:4953-4955` rohe englische Stage-IDs („companyContact“ usw.), „d“, „Score“, „pinned“
  - `S:4969` „Zellen geprüft“
- E-Mail-Ableitung (`s/EmailMusterSection`): `:35-40` „Kontaktlauf“, „Adressmuster“, „Mail-Server-Anfrage“, „Catch-all“, „Baseline-Adresse“, „Status-Matrix“, „Stufe“; `:49` „KI-Urteil“; `:57` **„RCPT TO“**, „Mailservern“; `:58` „Verifizierungsrate“
- `s/VorschlaegeSection:16`, `:19` „Hintergrund-Modell“, „KI-Aufruf“
- Stammdaten mitpflegen (`s/MithelfenSection`): `:10`, `:83` „Worker“, „Worker-Modus“; `:63-64` „Registerportal“, „Chrome-Fenster“; `:71` „Register-Jobs“; `:88-90` „Registerblätter“, „Herzschlag, Vorgänge, Producer, Abläufe“; `:101-109` „Jobs“, „Geteilte Queue“
- `s/BrowserSection:16` „Chrome for Testing“, „Fassung“
- Meldungen:
  - `S:3790-3798` „Heartbeat“, „Heartbeat-Frequenz“
  - `S:3844-3846` „Matrix“, „rote Zellen“, „Retry“
  - `S:3852` „Schweregrad-Schwelle für Push“, `S:3884` „Push-Meldungen“
  - `S:3939`, `S:4008` „Heartbeat(s)“
  - `S:3999-4149` „Sweep“, „Tick“, „Kandidaten“, „Cadence = 0“
  - `S:4075` rohe Severity „(urgent|warn|info)“
- Relevanz (`s/RelevanzSection`): `:39` „DSGVO-Hinweis“; `:34`, `:44` „Watchlist“; `:156` rohe Ziel-IDs
- Telegram (`s/TelegramSection`): `:133-136` „@BotFather“, „/newbot“, „Token“; `:87` „Bot-Token“; `:192` „Chat-ID“; `:263` „(Gegenrichtung)“

### Wissensquellen, Skills, Verlauf, Verbrauch
- Wissensquellen (`s/WissensquellenTab`):
  - `:57-61` „Workspace“, „Vault“, „Tokens“, „OS-Schlüsselbund“
  - `:65-67` „libsecret“
  - `:226-238` „Internal integration“, „Read / Update / Insert content“, „Internal Integration Token“, „Connections“
  - `:275` „Integration-Token“
  - `:280` „Local-REST-API-Plugin“, „Markdown-Notizen“
  - `:337-353` „Community plugins“, „Restricted mode“, „Local REST API“, „coddingtonbear“, „HTTP (27123)“, „HTTPS (27124)“, „selbst-signiertes Zertifikat“, „127.0.0.1“
  - `:356`, `:367` „Base-URL“, „API-Key“
- Skills:
  - Tab-Label „Skills“ (`S:167`)
  - `SK:357-363` „Markdown-Skills“, „Chat-Agent“, „Auto-Aktivierung“, „/skill-name“
  - `SK:23-32` „Outreach“, „Qualifying“, „Workspace“
  - `SK:395`, `SK:457` „SKILL.md“, `SK:463` YAML-Platzhalter
  - `SK:511` „.zip“, `SK:642` „Pfad“, `SK:745` „Projekt-Repo“
- Verlauf:
  - `s/VerlaufTab:616-623` (ausdrücklich an Entwickler gerichtet): „Tool-Workarounds“, „Tool-Fehler“, „Pattern“, „Code-Fix in den Tool/Skill“, „Hinweis für mich als Entwickler“
  - `:628` „Top-Tools“, `:639`, `:382` „JSON“, `:670` „Fix-Vorschlag“, `:683` „Conversation:“, `:586` „Console-Log“
  - `:210` „Audit-Trail“
  - `:253-258` „Producer-Läufe“, „Heartbeat“, „Authentifizierungs-Events“
  - `:370` „Live-Updates“, `:399` „Events“
  - `:480-523` rohe Werte bei „Aktion“, „Akteur“, „Subjekt“, „Metadaten“ (JSON)
  - `:44` „Producer“
- Verbrauch (`s/VerbrauchTab`):
  - `:49` „Token-Verbrauch“
  - `:51-53` „LLM-Anfrage“, „Producer“
  - `:90-100` „Input-Tokens“, „Output-Tokens“, „Cache-Read“, „gecachte Prompt-Tokens“
  - `:207-210` „Token-Limit“, „Input + Output + Cache, UTC-Tag“
  - `:237`, `:372`, `:451-455` „Tokens“, „Input“, „Output“
  - `:136` „Producer/CRM/Audit-Daten“

### Unerklärte Abkürzungen (Auswahl)
- ICP (`s/InstanzenSection:77`)
- CRM (überall)
- bAV (`s/ThemenSection:122`, `:126`)
- DSGVO
- MCP
- SLA (`S:5214`)
- 2FA (`S:1491`)
- TLS, IMAP, SMTP
- AMQP
- PID
- UTC
- RCPT TO
- C-Level
- DACH (nur Platzhalter)

SERP kommt in den Settings nicht vor.

### Inhaltliche Widersprüche und veraltete Texte (keine Funktionsänderung, nur Text)
- **Schlüsselpflicht widersprüchlich.**
  - `S:2403` sagt „API-Schlüssel … — nötig für die Hintergrund-Verarbeitung“.
  - `S:2200` sagt „Firmenverarbeitung über AVAs Modell … kein Schlüssel nötig“, ebenso die Plankarten `S:5181`/`S:5199`.
- **Anthropic-Zusatz veraltet.** `S:2262` hängt „(kein Abo verknüpft)“ an Anthropic. Anthropic läuft inzwischen nur per API-Schlüssel (`S:103-104`, Kommentar `S:2505`).
- **Veralteter Hinweis.** `lib/producer-error.ts:56`, `:135` erwähnen „Pro-Abo“ bzw. „Pro/Max-Abo“ für Anthropic.
- **Fehlleitender Link.** `S:1908` „Provider in Status wählen“ führt nach `/whoami`. Die Anbieterwahl liegt aber unter Einstellungen → Modelle. Der Kommentar `S:1903-1906` behauptet fälschlich, `provider-section` existiere nicht.
- **Hash-Links.** `S:1836` `<a href="#provider-section">` und `S:1824` `href="#linkedin-image-analysis"` sind rohe Hash-Links. Der Datenschutz-Link `S:1447` nutzt dagegen das Muster `#/datenschutz/...`.
- **Rechtschreibung.** `s/VerbrauchTab:100` „verguenstigt“.
- **Persönliche Adresse im Platzhalter.** `s/SchedulerSection:270` „joyce@quikk.de“.
- **Absehbar veraltet.** `s/VerbrauchTab:52-53` „Hintergrund-Aufgaben der Producer folgen im nächsten Update.“
- **Uneinheitliche Wichtigkeitsstufen.**
  - Meldungen (`S:3695-3697`): „Alle (Info und höher) / Ab Achtung / Nur Dringend“
  - Telegram (`s/TelegramSection:17-19`): „Alle Meldungen / Ab „wichtig“ / Nur dringende“
  - Heartbeat-Liste: roh „urgent/warn/info“
- **Uneinheitliche Ladeanzeigen.** „Lädt…“, „Lade…“ (`S:1005`, `S:1282`), „Wird geladen …“ (Relevanz), „Wird geladen…“ (Storage), „lädt…“ (Voice-Chip).
- **Uneinheitliche Button-Schreibweise.**
  - Klein: „löschen“, „entfernen“, „reparieren“, „vergessen“
  - Groß: „Löschen“, „Entfernen“
  - „Pause“ vs. „Pausieren“
  - „Trennen“ vs. „Verbindung trennen“

---

## 4. Strukturnotizen

### Sidebar und Sub-Navigation
- Tabs sind `NavLink`s auf `/settings/{id}` (`S:405-413`, `S:443-529`).
- Beim Hover öffnet nach 100 ms ein Flyout mit den `SETTINGS_TAB_SUB_ITEMS` (`S:194-244`); es schließt nach 180 ms.
- Die Unterpunkte sind `Link`s auf `/settings/{tab}#{anchor}`.
- Das Flyout gibt es **nur per Maus-Hover**, nicht per Tastatur oder Touch.
- Tabs ohne Unterpunkte (Verbrauch, Wissensquellen, Skills) zeigen keinen Chevron „›“.
- Unterpunkte werden ausgefiltert:
  - nach Organisationsfunktion über `ANCHOR_FEATURE` (`S:183-190`): linkedin, bildanalyse, mail, scheduler, telegram, mithelfen
  - bei Anbieter-Sperre über `ANCHOR_HIDDEN_UNDER_LOCK = installed-models` (`S:192`, Filter `S:393-398`)
- Der Hash-Sprung versucht bis zu 3 s lang, das Ziel zu finden (`S:364-383`).
- Alte Links `/settings#x` werden über `SETTINGS_ANCHOR_TO_TAB` (`S:246-286`) auf den richtigen Tab umgeleitet.
- Der zuletzt gewählte Tab steht in localStorage `ava.settings.tab` (`S:288`).
- Unter 900 px wird die Sidebar zu einer horizontalen Tab-Leiste (`CSS:2385-2403`).

### SettingsSearch
- Reiner Stub (`s/SettingsSearch:15-23`): ein leeres `<div class="settings-shell__search" aria-hidden>`.
- Per CSS `display:none` versteckt (`CSS:2348-2350`).
- Der Kommentar verspricht die Anbindung „in v0.1.140“.

### Abschnitte je Tab
| Tab | Abschnitte | Sub-Menü-Einträge |
|---|---|---|
| Konto | 8 (1 bedingt, 1 leer) | 9 |
| Modelle | 4 (ProviderSection allein sehr lang, mit 2 Klappbereichen und 7 Schlüsselkarten) | 6 |
| Verbrauch | 1 | 0 |
| Datenquellen | 5 (2 bedingt) | 5 |
| Automatisierungen | 11 (4 bedingt, längster Tab) | 9 |
| Wissensquellen | 1 | 0 |
| Skills | 1 | 0 |
| Verlauf | 2 (1 bedingt) | 1 |
| System | 7 | 3 |

Insgesamt rund 40 Abschnitte.

### Sub-Menü passt nicht zu den gerenderten Abschnitten
**Tote oder falsche Sprungziele**
- `publication-analysis` („Publikations-Analyse“, `S:212`): Es gibt nirgends ein Element mit dieser id.
- `ollama-version` („Ollama-Version“) steht unter Modelle (`S:215`, `S:270`). Der Abschnitt wird aber im **System**-Tab gerendert (`s/SystemTab:18`, `c/OllamaVersionSection:82`).
- `installed-models` liegt im zugeklappten `<details>` (`S:2437-2440`). Ein Sprung dorthin landet in einem verborgenen Bereich.
- `freshness-section` hat die id nur im Ladezustand (`S:4243`). Die geladene Section (`S:4280`) hat keine id, der Sprung geht ins Leere.
- Nur das Eingabefeld trägt die Sprungmarke, die Section selbst hat keine id:
  - `alerts-cadence` (`S:3797-3801`)
  - `profile-*` (`S:3289ff`), also 6 Unterpunkte, die alle in denselben Profil-Abschnitt zeigen
- `erscheinung` zeigt auf eine leere Section.

**Gerenderte Abschnitte ohne Sub-Menü-Eintrag**
- Konto: Organisation, Deine AVAs, Verbundene Dienste, Signal-Kalibrierung
- Modelle: Sprachmodus
- Datenquellen: Mail-Entwürfe
- Automatisierungen: Vorschläge im Chat, Browser der Hintergrundverarbeitung
- Verlauf: Selbstkorrekturen
- System: Ollama-Laufzeit, Speicherplatz, Diagnose, Zurücksetzen

**Bezeichnungen im Sub-Menü weichen von den Überschriften ab**
| Sub-Menü | Überschrift im Abschnitt |
|---|---|
| „Plan & Verbrauch“ | „Plan & Abrechnung“ |
| „Agent-Anbieter & Schlüssel“ | „Modelle“ |
| „Research-Features“ | „Erweiterte Recherche-Funktionen“ |
| „Voice / Whisper“ | „Sprachmodell“ |
| „Datenrefresh“ | „Aktualisierung“ |
| „Alerts / Heartbeat“ | „Meldungen“ |
| „Audit-Trail“ | „Verlauf“ |
| „App-Updates“ | „Updates“ |
| „Lokale Dienste“ | „Lokale Datenbank“ |
| „Lokale Producer“ | „Lokale Producer-Dienste“ |
| „LinkedIn“ | „LinkedIn-Beobachter“ |

**Weitere Abweichungen**
- In Automatisierungen weicht die Reihenfolge im Sub-Menü von der Render-Reihenfolge ab, weil Vorschläge und Browser fehlen.
- `SETTINGS_ANCHOR_TO_TAB` kennt `themen-section` nicht, ebenso wenig mail-entwurf, organisation, instanzen, verbindungen, storage, diagnose und self-corrections.

### Überschneidungen und Dopplungen
- **Schlüssel an mehreren Stellen:**
  - Modelle → API-Schlüssel (7 Karten, Organisations- oder eigener Schlüssel)
  - Azure-Unterkarte
  - Research-Features mit eigenem Schlüsselspeicher („+ neuer Schlüssel“, „Allgemeine Modell-Konfiguration“, Organisationsschlüssel)
  - Sprachmodus und Telegram-Sprachantwort brauchen den OpenAI-Schlüssel
  - KonsoleSection verweist auf Organisationsschlüssel
  - Wissensquellen (Tokens)
  - Telegram (Bot-Token)
  - Mail (App-Passwörter, zweimal)
- **LinkedIn in drei Abschnitten über zwei Tabs:**
  - Datenquellen → LinkedIn-Beobachter
  - Konto → Signal-Kalibrierung
  - Konto → Profil → „Relevant auf LinkedIn“
  - Dazu nutzt die Link-Überwachung die LinkedIn-Anmeldung.
- **Mail in vier Abschnitten über zwei Tabs:**
  - Mail-Konto (IMAP/SMTP, Datenquellen)
  - Mail-Entwürfe mit eigenem Entwurfs-Postfach (IMAP, Datenquellen)
  - Wiederkehrende Aufgaben = Mail-Loops (Automatisierungen)
  - E-Mail-Ableitung (Automatisierungen)
- **Verbrauch und Abrechnung:**
  - Konto → Plan & Abrechnung (Bestand, Ausgabenlimit, Kontingent)
  - Tab Verbrauch (Tokens, Tageslimit)
  - Zwei verschiedene „Limits“ in zwei Tabs, das Sub-Menü nennt Konto-Inhalt „Plan & Verbrauch“.
- **Lokale Modelle und Ollama an drei Stellen:**
  - Modelle → „Lokal installierte Modelle (Ollama)“ (löschen/reparieren)
  - System → Ollama-Laufzeit
  - System → Speicherplatz → „Sprachmodelle“ (ebenfalls löschen)
- **Sprache:** „Sprachmodus“ und „Sprachmodell“ (Whisper) stehen direkt untereinander im Modelle-Tab; dazu Speicherplatz-Reiter „Spracherkennung“.
- **Meldungen:**
  - Alerts (Ruhezeiten, Push-Schwelle)
  - Telegram (eigene Schwelle, Ruhezeiten übernehmen)
  - Watches und Relevanz (Tageszusammenfassung)
- **Hintergrund-Browser:** Browser-Abschnitt, Mithelfen („unsichtbares Chrome-Fenster“) und Link-Überwachung („Hintergrund-Browser“).
- **„Jetzt scannen“** gibt es doppelt: LinkedIn (`S:1689`) und Aktualisierung (`S:4423`).
- **Mithelfen-Status** erscheint doppelt: Automatisierungen und System → MithelfenZeile (`S:743-801`).
- **MCP/Claude/ChatGPT** zweimal im Konto-Tab: Deine AVAs (MCP-Schalter) und Verbundene Dienste.
- **„Verlauf“** ist Tab-Name, Überschrift des Audit-Abschnitts und Ziel in der Link-Überwachungs-Meldung (`s/LinkMonitorSection:116`).

### Uneinheitliche Muster
- **Überschriftenebene:**
  - ResearchFeatures nutzt `<h2>` (`s/ResearchFeaturesSection:94`, `:102`), alle anderen `<h3>`.
  - Die Seitenüberschrift ist ebenfalls h2.
  - Verlauf-Abschnitte packen die h3 in ein `<header>`.
- **Klassen:**
  - nur `provider-section`: Updates, Postgres, Producer, CRM, LinkedIn, Provider, Voice, Memory, Konsole, Instanzen, Verbindungen, MailEntwurf, Storage, Diagnose, Ollama, Wissensquellen, Skills, Audit
  - `provider-section alerts-prefs`: Profil, Alerts, Freshness, Watches, Mail-Konto, Scheduler, LinkMonitor, Telegram, Themen, Mithelfen, Vorschläge, Browser, Relevanz, Sprachmodus, EmailMuster
  - `ct-card` (Karte mit Schatten): PlanSection
  - `verbrauch-tab` ohne `provider-section`, also ohne Trennlinie
  - `provider-section danger-zone`: Zurücksetzen
- **Intro-Klasse:** teils `muted`, teils `muted small` (z. B. Updates, Postgres, Producer, CRM, LinkedIn, Memory, Research, Ollama, Storage, Diagnose, Skills, Verlauf = small).
- **Ladezustand:**
  - Manche Abschnitte rendern `null` und verschwinden bzw. tauchen verzögert auf: Themen, Vorschläge, Mithelfen, MailEntwurf, Relevanz, Browser, Sprachmodus, SelfCorrections.
  - Andere zeigen eine Section mit „Lädt…“, teils mit, teils ohne id.
- **Abschalten:**
  - Kommentar `s/AutomatisierungenTab:27`: „Abgeschaltet heisst verschwunden, nicht ausgegraut.“
  - MithelfenSection und VorschlaegeSection zeigen bei Organisationssperre aber deaktivierte Checkboxen plus Hinweis.
  - Mail-Konto, Telegram und LinkedIn verschwinden ganz.
- **Inline-Styles statt Klassen:** ResearchFeatures-Modals (`:462-506`, `:537-606`), Skills-Banner mit festen Hex-Farben (`SK:417-426`, `SK:715-719`), Plan-Fortschrittsbalken (`S:5395-5398`, `S:5517-5543`), Storage-Liste.
- **Bestätigungen:** überwiegend `window.confirm`/`alert`. Eigene Dialoge haben nur DangerZone, ResearchFeatures (Kosten, Schlüssel), LinkedIn-Einwilligung und Skills.
- **Tabellen:** `kunden-tabelle` (Instanzen, Verbindungen), `wf-runs__tablewrap` (Mithelfen), `relevanz-signale__tabelle`, `verbrauch-tab__table`.
- **ChatGPT-Abo-Karte im Raster** `subscription-hero-grid` mit 2 Spalten (`CSS:2417-2422`), enthält aber nur noch **eine** Karte. Die Karte nimmt daher nur die halbe Breite ein; der Kommentar spricht noch von „ChatGPT-/Claude-Abo“.

### Leere oder Stub-Abschnitte
- „Erscheinung“ (`s/KontoTab:28-35`): leer, nur Trennlinie sichtbar.
- SettingsSearch: versteckt.
- Wissensquellen: der Zweig „demnächst“/„Folgt in einer kommenden Version.“ (`:114`, `:153-157`) ist tot, weil beide Anbieter unterstützt sind (`:285`).
- CRM: Salesforce und Dynamics zeigen nur „Demnächst verfügbar“.
- Verbrauch erfasst laut eigenem Text nur Chat.
- Der Kommentar `S:1127-1129` nennt „Jetzt scannen“ einen Platzhalter. Das ist veraltet, der Button funktioniert.

---

## 5. CSS-Klassen (`styles.css`)

| Klasse | Zeile | Aussehen |
|---|---|---|
| `.settings-shell` | `CSS:2329` | Grid 200px + 1fr, gap 1.5rem |
| `.settings-shell__sidebar` | `CSS:2335` | sticky, z-index 100 |
| `.settings-shell__nav` | `CSS:2351` | Box mit 1px Rahmen, 12px Radius |
| `.settings-shell__tab` | `CSS:2360` | 14px/500, linker 3px-Akzentrand wenn aktiv |
| Mobile | `CSS:2385` | horizontale Leiste mit Unterstrich |
| `.settings-shell__search` | `CSS:2348` | `display:none` |
| `.settings-shell__sub-popover` | `CSS:7206` | absolut rechts neben dem Tab, harter weißer Hintergrund `#ffffff` (Dark-Mode-Override ab `CSS:7244`), Schatten, min. 220px; Items 0.88rem, Hover türkis getönt (`CSS:7230-7239`) |
| `.provider-section` | `CSS:2406-2412` | kein Kasten, nur `margin-top:2rem; padding-top:1rem; border-top:1px solid`; h3 ohne oberen Abstand, h4 mit 0.5rem unten. Kommentar: ursprünglich für die Whoami-Seite. |
| `.alerts-prefs` | — | **keine eigene Regel**, nur Marker. Es gibt nur BEM-Kinder: `__row` 12px Abstand (`CSS:3014`), `__row--spalte` (`CSS:3016`), `__label` 12px gedämpft (`CSS:3052`), `__check` inline-flex mit Akzent-Checkbox (`CSS:3057-3070`), `__quiet` umrandeter Kasten 12/14px mit Legende in Versalien 12px (`CSS:3071-3082`), `__quiet-row` (`CSS:3083`), `__actions` Flex mit 16px oben (`CSS:3095`) |
| `.research-feature-card` | `CSS:2726-2788` | Karte, 1px Rahmen, 8px Radius, 14/16px, Titel 14px/600, Untertitel 12.5px gedämpft, Kostenzeile mit gestrichelter Trennlinie |
| `.provider-key-card` | `CSS:2622` | gleiche Kartenoptik, Spalten-Flex mit gap 10px; auch für Wissensquellen genutzt |
| `.ct-card` | `CSS:4574` | eigener Hintergrund, Rahmen, großer Radius, padding 1.5rem, weicher Schatten; nur PlanSection |
| `.active-config-card` | `CSS:2446` | 4px Akzent links (bei Warnung orange), Raster 160px Label / Wert, max. 720px |
| `.subscription-hero-grid` / `-card` | `CSS:2417` / `CSS:2426` | 2 Spalten; Karte mit 1.5px Türkis-Rahmen und Tönung |
| `.settings-collapse` | `CSS:2475` | umrandeter `<details>`-Kasten, Summary 13.5px/600 |
| `.crm-card` | `CSS:2522` | Karte 1.25/1.5rem, 12px Radius, Schatten |
| `.plan-card` | `CSS:5519` | Karte 12px Radius |
| `.linkedin-fieldset` | `CSS:5410` | umrandeter Kasten 8px Radius, Legende 13px/600, deaktiviert mit Deckkraft .55 |
| `.scheduler-form` | `CSS:7139` | umrandeter Kasten 14/16px, Labels gestapelt 0.85rem gedämpft |
| `.mail-form fieldset` | `CSS:6901` | umrandet, Legende 0.85rem/600 (`CSS:6907`) |
| `.heartbeat-history` | `CSS:3109` | Trennlinie oben, 18px |
| `.verbrauch-tab` | `CSS:6367` | Spalten-Flex gap 1.25rem |
| `.verbrauch-tab__limit` | `CSS:6372` | getönter, umrandeter Kasten mit 10px Radius |
| `.audit-layout` | `CSS:6150` | Raster 220px Filter + 1fr |
| `.danger-zone` | `CSS:7690-7691` | roter 1px Rahmen, rote h3; wegen `provider-section` zusätzlich die obere Trennlinie |
| `.watches-list__row` | `CSS:3027` | umrandete Zeilen-Karten, pausiert mit Deckkraft .55 |

---

## 6. Dateien je Bereich (Texte oben vollständig erfasst)

| Bereich | Datei |
|---|---|
| Research-Features | `s/ResearchFeaturesSection.tsx` |
| Mail-Konto | `s/MailAccountSection.tsx` |
| LinkedIn | `S` (LinkedInSection `:1176-1949`), `c/LinkedInConsentModal.tsx` |
| CRM | `S` (`:947-1122`) |
| Fokus-Themen | `s/ThemenSection.tsx` |
| Vorschläge | `s/VorschlaegeSection.tsx` |
| Stammdaten mitpflegen | `s/MithelfenSection.tsx`, zusätzlich `S:743-801` |
| Aktualisierung (Freshness) | `S:4194-4432`, `S:4808-4992` |
| Watches | `S:4434-4796` |
| Wiederkehrende Aufgaben (Scheduler) | `s/SchedulerSection.tsx` |
| Skills | `routes/SettingsSkills.tsx`; Editor-, Trust- und Import-Dialoge nicht im Detail erfasst |
| Verlauf | `s/VerlaufTab.tsx` |
| System | `s/SystemTab.tsx` + `S` (Updater, Postgres, Producer) + `c/OllamaVersionSection.tsx`, `c/StorageSection.tsx`, `c/DiagnoseSection.tsx`, `c/DangerZoneSection.tsx` |
| Konto | `s/KontoTab.tsx` + `S` (Plan, Profil, Kalibrierung, Memory) + `s/KonsoleSection.tsx`, `s/InstanzenSection.tsx`, `s/VerbindungenSection.tsx` |
| Modelle | `s/ModelleTab.tsx` + `S` (Provider, ChatGPT-Abo, ApiKeyCard, InstalledModels, Voice) + `s/AzureOpenAIKarte.tsx`, `c/AnthropicTierBanner.tsx`, `s/SprachmodusSection.tsx` |
| Verbrauch | `s/VerbrauchTab.tsx` |
| Weitere | `s/LinkMonitorSection.tsx`, `s/TelegramSection.tsx`, `s/EmailMusterSection.tsx`, `s/RelevanzSection.tsx`, `s/BrowserSection.tsx`, `s/MailEntwurfSection.tsx` (+ `shared/mail-entwurf.ts:21-29`), `s/WissensquellenTab.tsx`, `s/DatenquellenTab.tsx`, `s/AutomatisierungenTab.tsx`, `s/SettingsSearch.tsx` |
| Fehlertexte | `lib/updater-error.ts`, `lib/producer-error.ts` |

Nicht im Detail gelesen: die Dialog-Komponenten von SettingsSkills (SkillEditor, SkillTrustDialog, SkillImportDialog). Ihre Texte gehören für eine vollständige Textrunde noch dazu.
