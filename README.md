# AVA

[![Latest Release](https://img.shields.io/github/v/release/eproX-GmbH/ava-releases?label=release&color=00c0a7)](https://github.com/eproX-GmbH/ava-releases/releases/latest)
[![Service Health](https://img.shields.io/website?url=https%3A%2F%2Fava-db-gateway.fly.dev%2Fhealth&label=db-gateway&up_message=operational&down_message=offline)](https://ava-db-gateway.fly.dev/health)
[![Master-Data](https://img.shields.io/website?url=https%3A%2F%2Fava-master-data.fly.dev%2Fhealth&label=master-data&up_message=operational&down_message=offline)](https://ava-master-data.fly.dev/health)

> Sales Intelligence als Desktop-App oder als eigener AVA-Server: Firmen aus Deutschland, Österreich, der Schweiz und dem Vereinigten Königreich recherchieren, beobachten und ins eigene CRM bringen. Chat, Radar und Workflows laufen mit dem Modell des Nutzers (lokal, eigener Schlüssel oder ChatGPT-Abo); Browser-Automatisierung und Extraktion laufen immer in seiner AVA.

AVA verdichtet öffentliche Unternehmensdaten zu einem vollständigen Firmenbild: amtliches Register, Jahresabschlüsse und Bekanntmachungen, Firmenwebsite, Stellenanzeigen, Ansprechpartner mit Herkunftsnachweis und ein Abgleich mit dem eigenen Idealkundenprofil. Danach beobachtet AVA die Firmen weiter und meldet, was sich ändert: Insolvenzen, Löschungen, Geschäftsführer- und Personalwechsel, neue Jahresabschlüsse, neue Stellen, Website-Änderungen, eigene Fokus-Themen, LinkedIn-Signale.

Bedient wird AVA über einen Chat-Agenten mit rund 320 Werkzeugen, über die Firmenansichten in der Desktop-App, über die AVA-App im Browser und auf dem Handy ([app.ava.bi](https://app.ava.bi)), über Telegram, aus Claude und ChatGPT per MCP und über gespeicherte Workflows. Browser-Automatisierung, Web-Abrufe und Extraktion laufen **in der AVA des Nutzers**: auf seinem Rechner oder auf seinem AVA-Server. Chat, Radar und Workflows rechnen mit seinem Modell, die Firmenaufbereitung mit einem Modell des Betreibers über den Gateway (siehe Architektur). Die Cloud ist Substrat: Anmeldung, Stammdaten, Verarbeitungsstand, geteilte Korpora, Abrechnung, Vermittlung zwischen App, MCP und der AVA des Nutzers.

## Inhalt

- [Was AVA heute kann](#was-ava-heute-kann)
- [Architektur](#architektur)
- [Cloud-Komponenten und Betrieb](#cloud-komponenten-und-betrieb)
- [Sicherheit und Datenschutz](#sicherheit-und-datenschutz)
- [Installation](#installation)
- [Repository-Layout](#repository-layout)
- [Entwicklung](#entwicklung)
- [Dokumentation](#dokumentation)

## Was AVA heute kann

### Firmen aufnehmen und recherchieren

- **Import** per Excel/CSV, einzeln per Name und Ort, per Firmen-ID, aus HubSpot oder Close oder über den Firmen-Radar; eingefügte Firmen-IDs werden direkt importiert. Jede Firma wird öffentlichen Quellen zugeordnet (Suche über den Stammdaten-Index, Zuordnung in Stufen über den Kernnamen statt über den ersten unscharfen Treffer). Firmen ohne Registereintrag kommen über ihre eigene Website in den Bestand (Google Places, Website-Prüfung, KI-Urteil); ohne Website nie.
- **Fünf Producer** je Firma, die sich gegenseitig anstoßen, dazu als nachgelagerte Stufe die E-Mail-Ableitung (`packages/company-email`, siehe E-Mail-Muster). Status pro Firma und Stufe live als Matrix, mit Pause, Löschen, Wiederholen je Stufe, Logs und Screenshots je Lauf.

| Producer | Quelle | Ergebnis |
|---|---|---|
| `structured-content` | Handelsregister (Registerportal), Firmenbuch (AT), Zefix (CH) und Companies House (UK) über master-data | Stammdaten, Sitz, Geschäftsführung bzw. Officers; für deutsche HRB-Firmen zusätzlich die Gesellschafterliste (siehe Verflechtungen) |
| `company-publication` | Unternehmensregister / Bundesanzeiger | Jahresabschlüsse und Konzernabschlüsse (Kennzahlen nur der Muttergesellschaft, Töchter und Geschäftsführung in den Verflechtungen), Lagebericht, Bekanntmachungen; Kennzahlen per Lazy-RAG auf Abruf statt Voranalyse |
| `website` | Websuche + Firmenwebsite | Beste Treffer-Website, Inhalte über Seiten- und Blockauswahl (Website-Walker) statt Seitendump, Stellenanzeigen mit Arbeitgeberleistungen, Karriereseite, Expansions- und Ausschreibungsmeldungen, Fokus-Themen des Nutzers mit Zitat und Quelle, eingesetzte Systeme aus der Datenschutzerklärung |
| `company-profile` | Website | Firmenprofil (Angebot, Branche, Größe, Standorte) |
| `company-contact` | Website, Impressum | Ansprechpartner und Kontaktwege mit Beleg, Herkunftsnachweis und Art.-14-Hinweis |

- **Länder:** Deutschland (Handelsregister, Insolvenzbekanntmachungen), Österreich (Firmenbuch über JustizOnline, Ediktsdatei), Schweiz (kantonale Handelsregister über Zefix, Handelsamtsblatt SHAB; Jahresabschlüsse nicht öffentlich) und Vereinigtes Königreich (Companies House, Gazette). Seit November 2026 liegen zusätzlich Stammdaten aus Finnland (Kaupparekisteri über die offenen Daten des PRH, vollständig geladen, ohne Personen) und Norwegen (Enhetsregisteret der Brønnøysundregistrene, Erstabzug zum größten Teil geladen) vor. Länderfilter in Firmensuche und „Meine Firmen“, Landeschip und amtliche Kennung je Firma; der Firmen-Radar kennt alle sechs Länder. Stand: Seit dem 09.11.2026 sind die Register-Worker aller Länder außer Deutschland bewusst angehalten, bis die Datenbank aufgerüstet ist. Die laufende Nachführung (Neueintragungen, Änderungen, Löschungen) gilt bis dahin nur für Deutschland, der norwegische Erstabzug ruht. Schweden und Dänemark sind geplant, nicht gebaut.
- **Stammdaten aktuell halten (Register-Delta):** Neueintragungen, Änderungen und Löschungen kommen laufend aus den Registern (derzeit nur für Deutschland, siehe Länder). Die Arbeit teilen sich Betreiber-Worker in der Cloud und die AVAs der Nutzer („Stammdaten mitpflegen“: bei bezahltem Sitz standardmäßig an und mit einem Klick abschaltbar, im Free-Plan Opt-in; höchstens 60 Abfragen je Stunde, nur im Netzbetrieb, keine Downloads; der eigene Beitrag steht in den Einstellungen). Geänderte Registerblätter markieren die betroffene Firma als veraltet; der frühere Registerstand bleibt als Verlauf erhalten.
- **Insolvenzen und Firmenstatus:** gezielte Prüfung je Pool-Firma alle 30 Tage; Insolvenz, Löschung, Löschungsankündigung und Liquidation erscheinen als Chip in den Tabellen, als Warnung in jedem Chat-Werkzeug und als Meldung des Firmenstatus-Wächters.
- **Firmen-Verflechtungen (Deutschland):** Gesellschafterlisten werden über den Registerordner geladen, per KI gelesen (zwei unabhängige Lesungen, harter Qualitätsfilter, Bild-Modell ab Stufe A Pflicht) und zu Beteiligungen, Personen und gemeinsamen Adressen verdichtet. Firmen-Gesellschafter werden rekursiv nachgezogen (Besuchsliste, Notbremse Tiefe 6 / 200 Firmen, abschaltbar). Reiter „Verflechtungen“ mit Netzgrafik, Gesellschaftertabelle und Personenseite; Meldung „Gesellschafterwechsel“. Als Org-Feature abschaltbar. Stand: umgesetzt, Ende-zu-Ende-Erprobung läuft.
- **Neue Firmen finden (Firmen-Radar):** Scan in einer Region in Deutschland, Österreich, der Schweiz, dem Vereinigten Königreich, Norwegen oder Finnland aus öffentlichen Firmeneinträgen, KI-geplanter Web-Recherche und unverarbeitetem Registerbestand; Mini-Profile, Score gegen das Idealkundenprofil, Importieren oder Ignorieren je Zeile, Import erst nach Entscheidung des Nutzers. Automatik täglich oder wöchentlich als Opt-in. Solange eine übernommene Firma noch nicht verarbeitet ist, zeigt ihre Firmenseite das Kurzprofil aus dem Radar (nur bei sicherer Zuordnung). Im Free-Plan zeigt der Radar zwei Treffer vollständig, Mini-Profile sind dort je Woche begrenzt.
- **Kunden und Referenzen:** Kunden, Referenzen, Zertifikate und Technologiepartner, die eine Firma auf ihrer Website nennt, per KI erkannt (ohne Heuristik), mit dem Firmenbestand abgeglichen (sicher/unsicher), als eigener Reiter, im Chat abrufbar und umgekehrt suchbar („wer nennt Firma X als Kunden?“); Meldung bei neuem Kunden.
- **Idealkundenprofil (ICP):** aus der eigenen Website und bis zu fünf Kunden-Websites abgeleitet oder als Fragebogen; liegt in der AVA des Nutzers. Der frühere Bewertungs-Producer ist abgeklemmt; an seine Stelle tritt der ICP-Bestandsabgleich im Chat (lokal, synchron, Vorfilter plus Radar-Urteil), der auch offene Stellen und Arbeitgeberleistungen berücksichtigt.
- **Bestandssuche:** Fragen über den ganzen eigenen Bestand („Welche meiner Firmen bieten betriebliche Altersvorsorge, nutzen SAP, suchen Vertriebler?“) beantwortet AVA über eine Volltext- und Vektorsuche in den Belegen aller eigenen Firmen (Stellenanzeigen, Karriereseite, Fokus-Themen, Referenzen, Profil, Jahresabschlüsse), mit Zitat und Quelle. Die Vektoren rechnet das Gerät des Nutzers. Außerhalb des eigenen Bestands sucht AVA nur auf ausdrückliche Nachfrage und nennt dann höchstens fünf Kandidaten mit Name und Ort.
- **Stellenanzeigen, Expansion und Ausschreibungen als Signal:** je Anzeige die genannten Arbeitgeberleistungen und Anforderungen, je Firma die Karriereseite (auch Konzern-Portale); Expansions- und Ausschreibungsmeldungen mit Art, Datum, Wert, Quelle und Belegen als eigener Reiter. Beide Recherchen laufen ohne Nutzereinstellung immer in der Standard-Stufe über das Modell des Betreibers. Meldung bei neuen Stellen, Felder im ICP-Abgleich.
- **Fokus-Themen:** Jeder Nutzer legt eigene Themen fest (bis zu fünf aktiv, etwa „betriebliche Altersvorsorge“), nach denen AVA auf jeder Firmenwebsite und in deren Stellenanzeigen sucht. Befund je Firma mit Status, Zitat und Quelle im Reiter „Mein Fokus“, Filter in „Meine Firmen“, Meldung beim ersten Fund. Die Befunde gehören dem Nutzer, der das Thema angelegt hat.

### Beobachten und melden

- **Heartbeat und Meldungen:** neue Veröffentlichungen, Profil- und Stammdatenänderungen, neue und gewechselte Ansprechpartner, Firmenstatus, Gesellschafterwechsel, neue Kunden, neue Stellenanzeigen, gefundene Fokus-Themen; eine KI-Bewertung mit dem Nutzerprofil entscheidet, was meldenswert ist. Rollenwechsel werden gegen Register und frühere Beobachtungen geprüft, damit Umformulierungen auf der Website keine Meldung auslösen; ob ein Ansprechpartner noch bei der Firma arbeitet, prüft AVA zusätzlich am öffentlichen LinkedIn-Profil im lokalen Hintergrund-Browser, ohne Anmeldung. Jede Meldung nennt ihre Fundstelle (Seite mit neuem und früherem Stand, Anzeige, Referenzseite). Glocke in der App, OS-Benachrichtigung, Telegram, Push in der AVA-App und auf Wunsch eine Neuigkeiten-Mail (Sammelmail nach Bestätigung per Double-Opt-in; läuft die eigene AVA einen Tag lang nicht, verschickt sie der Server morgens regelbasiert). Ruhezeiten, dringende Meldungen umgehen sie.
- **Firmenhistorie (Zeitachse):** Personal- und Stammdatenwechsel je Firma als Verlauf: wer in welche Rolle kam, wechselte oder ging, bereinigt um Umformulierungen und Erstbefunde, dazu Register-, Profil- und Insolvenzereignisse. Reiter „Zeitachse“ und „Wechsel in der Leitung“ in der Firmenansicht, Hinweis auf auffällige Fluktuation in der Leitung, im Chat und per MCP abfragbar („Welche neuen Vertriebsleiter gab es zuletzt?“). Fluktuation fließt in Relevanz und Meldungsbewertung ein.
- **Auffrischung:** die aktiven Firmen des Bestands werden nach Relevanz in festen Abständen neu verarbeitet (Website, Profil und Kontakte alle 14 Tage, Register und Veröffentlichungen alle 30 Tage), mit Pause nach Fehlversuchen. Takt und Kosten liegen beim Betreiber; eine Nutzereinstellung dafür gibt es nicht mehr, Priorisieren und „jetzt auffrischen“ bleiben.
- **Beobachtungsregeln (Watches)** mit eigener Bewertungsvorschrift in Nutzersprache.
- **Website-Überwachung** beliebiger URLs mit KI-Zusammenfassung der Änderung und Beweis-Screenshot; Bot-Schutz wird abgewartet, nie umgangen.
- **LinkedIn (Opt-in, eigenes Konto):** Feed-Beobachter für Signale zu Firmen im Bestand, Personen-Watchlist, beobachtete Posts (Reaktionen und Kommentare werden zur Firma aufgelöst und zu Leads; beim ersten Mal lädt AVA alle Kommentare eines Posts, danach nur neue). Die LinkedIn-Beobachtung wird nach Verbrauch abgerechnet, mit einem Limit, das der Kunde selbst setzt; im Free-Plan gibt es sie nicht. Bildanalyse per Vision-Modell.
- **Safe Browsing** vor Website-Abrufen.

### Kontakte und Kommunikation

- **Ansprechpartner** mit Beleg, Herkunft und Löschfunktion; Datenschutzhinweise (Art. 14) als Text exportierbar. Kontaktangaben bleiben bei der Firma, bei der sie gefunden wurden: Arbeitet eine Person für mehrere Firmen, erscheinen E-Mail, Telefon und Position nur dort. Doppelte Personen lassen sich zusammenführen (Protokoll, Rücknahme).
- **LinkedIn-Leads:** Wer auf einen beobachteten Post reagiert oder kommentiert, erscheint als warmer Lead mit Anlass, Kommentar und Mini-Profil der Firma, getrennt vom Firmen-Radar und ohne ICP-Tor. Übernahme legt Firma und Kontakt in einem Schritt an (Sitz notfalls aus dem Impressum oder vom Nutzer); die Registerfirma wird in Stufen zugeordnet, nie nur über den Ort, und jeder Lead zeigt, wie sicher Firma und Ort erkannt sind. Leads gehören dem Nutzer, dessen AVA den Post beobachtet; Kollegen sehen, wer eine Person schon übernommen hat. In Desktop, AVA-App und Chat.
- **E-Mail-Muster:** Adressen nach dem Muster der Firma ableiten und gegen den Mail-Server prüfen (Hintergrund mit Vorrang für Chat, Last und Akku; verifizierte Adressen werden nie erneut geprüft, Bounces und Antworten fließen zurück). Firmenadressen mit Namen werden Personen zugeordnet; bei unklarem Muster entscheidet ein KI-Urteil. Abgeleitet wird nur mit der Domain der eigenen Firma (Website oder Firmenadresse), nie mit der Adresse einer anderen Firma derselben Person. Sperrantworten des Mail-Servers gelten nie als „existiert nicht“; weitere Schreibweisen stehen als Alternative an der Person, eine bekannte Adresse lässt sich im Chat setzen. Jede Adresse trägt einen Status in vier Stufen (bestätigt, wahrscheinlich, ungeprüft, abgelehnt), nach dem sich auch der Empfänger im Mail-Entwurf richtet. Funktionsadressen werden nie als Personenadresse abgeleitet, Namen mit fremden Buchstaben werden umschrieben.
- **Buying Center:** Power Map je Firma nach dem Schema des strategischen Key-Account-Plans (Rolle, Einstellung, Kontaktintensität, Einfluss), Beziehungen zwischen Personen, Vorschläge von AVA aus Website und Kontaktdaten zur Freigabe, Verlauf. Gehört nur dem Ersteller; im Chat und im Sprachmodus als Karte.
- **Erstansprache:** Auf „Schreib eine Erstansprache an …“ sammelt AVA in einem Durchgang, was sie zur Firma weiß (Profil, Kennzahlen, Stellen, Personalwechsel, Meldungen, Buying Center, eigenes Angebot aus dem ICP), wählt den Empfänger nach Rolle und nennt belegte Aufhänger mit Quelle. Den Entwurf prüft AVA ohne KI gegen feste Regeln (belegte Fakten, Bezug im Einstieg, Länge je Kanal, Floskeln, Platzhalter). Grundsätzliche Stilkorrekturen merkt sie sich für die nächsten Entwürfe.
- **Mail-Entwürfe:** Formuliert AVA eine Mail zum Selbstversenden (z. B. Erstansprache mit Ansprechpartner und Anlass), öffnet ein Knopf sie fertig im Mail-Programm: Outlook als Entwurf mit Anhängen, andere Programme per `mailto:`, ohne Mail-Programm Gmail oder Outlook im Web. Optional legt AVA Entwürfe mit Anhängen direkt in den Entwürfe-Ordner des eigenen Postfachs (IMAP, nur Schreiben). Feste Anhänge wie ein Firmenprofil werden einmal hinterlegt. Stand: umgesetzt, Erprobung läuft.
- **Mail-Postfach** anbinden (IMAP): lesen, antworten, weiterleiten (auch mit im Chat hochgeladenen Dateien), archivieren, Triage mit Kontext je Firma; Einrichtung auch auf einer Server-Instanz, Abrufintervall und Triage-Kontext per Chat einstellbar.
- **Telegram:** Meldungen, Kurzprofile und Freigaben aufs Handy, vollwertiger Chat mit Sprachnachrichten und Bildern; Antworten wahlweise als Text oder Sprachnachricht, Telegram je AVA-Instanz.

### Arbeiten mit AVA

- **Chat-Agent** mit rund 320 Werkzeugen in 49 Fähigkeitsgruppen, Tool-Suche, Gedächtnis über Gespräche, Nutzerprofil, Vorschlags-Chips für die nächsten Schritte (einzeln wegklickbar). Generative Oberflächen direkt in der Antwort: Kennzahlen, Diagramme, Ranglisten, Tabellen und Firmenkarten aus einem festen Katalog von Bausteinen, dazu Buying-Center-Karten. Rund 300 eingebaute Lösungskarten beantworten Fragen zur Bedienung, mit Knöpfen, die an die richtige Stelle der App führen; der Chat zeigt standardmäßig nur „Denkt nach“, die Arbeitsschritte sind zuschaltbar. Dateien (Excel, CSV, PDF, Word, Bilder) bekommen ein Handle und werden bei Bedarf gelesen statt vollständig in den Prompt gelegt. Lange Aufgaben wie Importe laufen als Hintergrundaufgabe weiter; AVA meldet sich, wenn sie fertig sind.
- **Erlaubnisse:** Schreibende Aktionen fragen nach; jede Rückfrage bietet „Nur dieses Mal“ oder „Immer erlauben“. Erteilte Erlaubnisse stehen in einer Übersicht und lassen sich dort oder im Chat zurücknehmen. Mails an nicht vertraute Empfänger fragen jedes Mal; für Aktionen aus eingehenden Mails und für MCP-Zugriffe gibt es keine dauerhafte Erlaubnis.
- **Einrichtung und Start-Analyse:** Bei der Registrierung liest eine Start-Analyse die Website zur eigenen Mail-Domain und leitet daraus einen Steckbrief der eigenen Firma und einen ICP-Vorschlag ab (mit bis zu fünf Referenzkunden von dieser Website); die App übernimmt ihn genau einmal und beginnt den ersten Chat damit. Ein Start-Workflow übernimmt die zehn passendsten Radar-Firmen als Startpaket, das nicht aufs Kontingent zählt. Die Analyse läuft auf dem Server mit dem Modell des Betreibers und liest nur öffentliche Websites.
- **Sprachmodus:** Gespräch mit AVA per Stimme (OpenAI GPT Live mit eigenem oder Organisationsschlüssel, Realtime als Rückfall), Aufträge laufen über denselben Agenten mit allen Werkzeugen, Diagramme und Buying Center erscheinen unter der Sprachkugel. Diktat und Aktivierungswort über lokales Whisper.
- **AVA-App im Browser und auf dem Handy ([app.ava.bi](https://app.ava.bi)):** installierbar als Web-App. Chat mit der eigenen AVA samt Rückfragen, Dateien, Fotos, Diktat, Sprachmodus und generativen Oberflächen; Firmensuche und Firmenliste mit Sortierung und Filtern; Firmenansicht mit Übersicht, Kontakten, Zeitachse, Verflechtungen, Buying Center, Referenzen, Stellen, Expansion und Fokus-Themen; LinkedIn-Leads, Meldungen mit Push, Plan und Kontingent, AVA-Server buchen und verwalten (Mehr → Deine AVA), Link zu den Einstellungen der laufenden AVA. Die App spricht über den Gateway mit der laufenden AVA des Nutzers (Desktop oder Server). Stand: umgesetzt, Erprobung läuft.
- **Claude, ChatGPT und andere Agenten per MCP und A2A ([mcp.ava.bi](https://mcp.ava.bi)):** Anmeldung per OAuth mit dem AVA-Konto. Das Gateway stellt 13 Werkzeuge bereit: Firmen suchen und lesen (`firma_suchen`, `firma_lesen`, `firma_kontakte`, `meine_firmen`), Meldungen und Personalwechsel (`meldungen`, `firmen_ereignisse`), Aufträge (`import_anlegen`, `recherche_anstossen`, `neu_verarbeiten`, `auftrag_status`, `auftraege`), Notizen ablegen (`protokoll_ablegen`) und den Kontext laden (`ava_kontext`: Rolle, Regeln, Profil, ICP, Gedächtnis, Abläufe). Läuft die AVA des Nutzers, reicht sie zusätzlich eigene Werkzeuge durch, darunter `ava_fragen` (AVAs eigenen Agenten beauftragen). Org-Schalter je Bereich (Lesen, Aufträge, Kontakte, Werkzeuge der laufenden AVA), dazu eine kleinere feste Werkzeugmenge für Microsoft Copilot und ein A2A-Zugang für laufende Agenten (Agentenkarte, Aufgaben mit Zustand und Push). Stand: Claude und ChatGPT binden AVA als eigenen Connector an; das ChatGPT-Plugin (eigener Pfad mit fester Menge von zwölf Werkzeugen) ist seit dem 21.11.2026 bei OpenAI eingereicht und in Prüfung, nicht veröffentlicht. A2A und die Werkzeugmenge für Copilot sind gebaut, der Live-Test mit Copilot Studio steht aus.
- **Workflows:** Abläufe aus dem Gespräch speichern, als Diagramm kontrollieren, per Zeitplan oder Ereignis ausführen (neuer Radar-Treffer, eingehende Mail, Import fertig, Ereignis eines verbundenen Dienstes). Beim Anlegen entscheidet der Nutzer einmal: „läuft selbstständig“ (alle Schritte ohne Rückfrage) oder mit Freigabe je Schritt und Lauf; Freigaben in App, Meldungen oder Telegram, auch als „Immer freigeben“. Vorlagen können Werkzeuge verbundener Dienste einbinden; Laufhistorie und Audit.
- **Skills:** wiederverwendbare Routinen per Slash-Befehl, mit Trust-Modell.
- **Integrationen:** HubSpot (lesen, anlegen, verknüpfen), Close CRM (Verbindung per Schlüssel, Import der Leads, Firmenverknüpfung, „Im CRM öffnen“), Notion, Obsidian. Weitere Dienste lassen sich als MCP-Server oder A2A-Agent anbinden (Einstellungen → Verbindungen, Vorlagen für Close und CompLeadly): Ihre Werkzeuge stehen im Chat und in Workflows bereit, schreibende nur nach Bestätigung; Zugangsdaten werden über eine sichere Zugangskarte eingegeben und erreichen das Modell nicht. Ein Rückkanal je Dienst (Empfangsadresse im Gateway) ordnet eingehende Ereignisse Personen und Firmen zu und kann Workflows auslösen. Teilen von Recherchen, Radar-Firmen und Workflows mit der Organisation. Stand der weiteren Dienste: umgesetzt, Erprobung läuft; Close bisher nur per Schlüssel, die Anmeldung per OAuth ist offen.
- **KI-Modelle:** lokal (Ollama in einer fest geprüften Version, kuratierte Modelle mit Hardware-Prüfung) oder mit eigenem Schlüssel bei OpenAI (auch über Azure OpenAI mit eigenem Endpunkt und Deployments), Anthropic, Google, Mistral, DeepSeek, xAI, Qwen; ChatGPT-Abo (Plus/Pro) per „Sign in with ChatGPT“ für Chat, Hintergrund-KI und Workflows nutzbar (nicht für den Sprachmodus). Jedes Modell hat eine Qualitätsstufe (S/A/B/C, `docs/MODEL_TIERS.md`), die entscheidet, ob ein Ergebnis bestehende Daten überschreiben darf und welche Funktionen es freischaltet. Getrenntes, günstigeres Modell für die Hintergrund-KI, Token-Limit je Tag, Verbrauchsübersicht. Die Firmenverarbeitung selbst (Producer-Stufen, Auffrischung, Recherche zu Stellen und Expansion) ruft unabhängig davon ein fest vorgegebenes Modell des Betreibers über den Gateway auf; Chat, Radar, ICP und Workflows bleiben beim Modell des Nutzers.
- **Problem melden:** Knopf im Chat und Chat-Werkzeug. Die Meldung geht mit Kategorie, Dateien und einem maskierten Geräte-Snapshot an das AVA-Team; Rückfragen und Antworten erscheinen in der App.

### Organisationen

- Organisationen sind Pflicht bei der Einrichtung (anlegen oder beitreten). Wer sich mit einer Firmenadresse registriert, deren Domain schon zu einer Organisation gehört, wird ihr als offene Beitrittsanfrage zugeordnet (je Organisation abschaltbar). Leere Organisationen werden nur stillgelegt. Mitglieder, Beitrittsanfragen, Vorgaben je Organisation: Anbieter-Sperre, vorgegebene Modelle, Organisationsschlüssel über den Gateway-Proxy (auch Azure OpenAI), Limits, abschaltbare Module (LinkedIn, LinkedIn-Leads, Bildanalyse, Kontakt-Recherche, Mail, Telegram, Workflows, Vorschläge, Stammdaten mitpflegen, Verflechtungen, MCP-Zugang mit seinen Werkzeugbereichen und A2A, weitere Dienste). Abgeschaltetes verschwindet vollständig aus der App.
- **Web-Konsole [admin.ava.bi](https://admin.ava.bi)** für Organisations-Admins, ohne App-Installation: Mitglieder und Einladungen, Funktionen und Vorgaben, Schlüssel, Limits und Verbrauch (Kennzahlen, Verlauf je Tag nach Bereich oder Mitglied, Kosten je Mitglied, Quelle und Modell, CSV-Export), Abrechnung mit Sitzen je Plan (kaufen, zuweisen, zum Zyklusende reduzieren), Kontingent und LinkedIn-Limit je Mitglied, AVA-Server je Mitglied buchen und abbestellen (mit Stand in Nutzersprache), Agenten-Zugang (Verbindungsdaten für A2A-Clients wie Copilot Studio), Instanzen der Mitglieder. Die Organisationsverwaltung liegt nur noch dort.
- Abrechnung: Pläne Free, Pro, Max und Ultra als Sitze je Organisation (ein Abo und eine Rechnung über Stripe; Sitze mischen, zuweisen, zum Zyklusende reduzieren). Jeder bezahlte Sitz enthält ein monatliches Firmen-Kontingent in Höhe des Sitzpreises; jede aktive Firma im Bestand des Nutzers zählt je Monat mit ihrer Stufe (nach Größe) dagegen. „Meine Firmen“ ist nicht begrenzt: Nur aktive Firmen zählen, ruhende zeigen den Steckbrief und lassen sich aktivieren oder zum Monatswechsel tauschen. Free: 25 Firmen ohne Zeitlimit, höchstens drei Free-Plätze je Organisation, ohne LinkedIn-Mitarbeiterabruf und ohne LinkedIn-Beobachtung. Über das Kontingent hinaus nur im Plan Ultra und nur nach Freigabe; LinkedIn-Beobachtung nach Verbrauch mit selbst gesetztem Limit. AVA-Server als Zusatz je Nutzer zu einem bezahlten Sitz. Enterprise-Vertrag mit Fixpreis und eigenen Grenzen; echte Anbieterkosten (OpenAI, Apify, Websuche) je Mitglied und Tag. Preise: [ava.bi](https://ava.bi).
- Betreiber (Keycloak-Rolle, nie Organisationsrolle): Kundensicht mit Plan und Limits, Stammdaten-Pflege, Vorabanalyse einer CRM-Liste (Abgleich, Website, Mini-Profil, ICP-Urteil, AVA-ready-Export), aktive Nutzer mit echter Nutzung, App-Version und Kosten je Nutzer samt Zugangs-Schalter, Triage-Center für Problemmeldungen, Staging (Konten je Kanal, Release-Kandidaten, Freigabe für die Produktion).
- Mehrere Konten auf einem Gerät (Account-Spaces), mehrere AVAs je Konto (Desktop und Server, Umzug zwischen beiden), Audit-Protokoll für sicherheits- und kostenrelevante Aktionen. Das eigene Konto lässt sich in den Einstellungen löschen (anonymisiert, unumkehrbar) oder, wenn man allein in der Organisation ist, deaktivieren; in Enterprise-Organisationen nur über das AVA-Team.

### AVA-Server (AVA als Server-Instanz)

- Dieselbe AVA ohne Oberfläche als Container (`services/desktop/src/server`, Docker, Fly in Frankfurt): eine eigene Instanz je Nutzer, an sein Konto gebunden (nur dieses Konto kann sich anmelden), in einem eigenen privaten Netz. Embeddings liefert Ollama als zweiter Container in derselben Maschine. Bedient über die AVA-App, Telegram und MCP; als Modell dient ein eigener Schlüssel, das ChatGPT-Abo oder der Organisationsschlüssel. Der LinkedIn-Beobachter läuft nie auf dem Server. Umzug zwischen Desktop und Server in beide Richtungen.
- **Selbst buchbar seit dem 22.11.2026:** als Zusatz zu einem bezahlten Sitz, direkt nach der Registrierung auf ava.bi, in der AVA-App (Mehr → Deine AVA) oder durch Admins je Mitglied in der Web-Konsole; Mitglieder können den Server anfragen. Nach bezahlter Rechnung legt ein Soll-Ist-Abgleicher im Gateway die Instanz ohne Zutun des Betreibers an (Tabelle `CloudInstanz`, Fly-Maschinen-API, Apps `ava-u-…` in einer eigenen Fly-Organisation); der Nutzer bestätigt mit einem Klick, dass diese AVA für ihn arbeiten darf. Nur der Abgleicher startet Maschinen. Bei offener Zahlung läuft der Server noch sieben Tage und wird dann pausiert, nach einer Abbestellung zum Ende des Abrechnungszeitraums; die Daten bleiben danach 30 Tage und werden frühestens sieben Tage nach einer Ankündigung per Mail gelöscht. Statuskarte in App, Desktop und Konsole, Mails bei Zustandswechseln, tägliche Sicherung des verschlüsselten Datenträgers (fünf Tage). Stand: freigeschaltet; der Durchlauf von der Registrierung bis zum laufenden Server ist mit Testzahlung bestanden, die Erprobung im Echtbetrieb läuft.
- **Updates in Wellen:** Jedes Release legt das Server-Image in `ava-server-image` und in der Registry der Kunden-Organisation (`ava-kunden-image`) ab. Freigegebene Versionen rollen nachts aus: zuerst die Server des Betreibers, nach 24 Stunden zehn Prozent der Kunden, nach weiteren 24 Stunden alle. Antwortet eine Instanz nach dem Update nicht gesund, geht sie von selbst auf die alte Version zurück; häufen sich die Fehler, hält die Welle an. In der AVA-App gibt es zusätzlich „Jetzt aktualisieren“.
- Die früher von Hand angelegten Instanzen unter `<name>.ava.bi` (Apps `ava-i-…`, geteilter oder eigener Embeddings-Beiwagen) gibt es seit dem 23.11.2026 nicht mehr. `scripts/instanz-*.mjs` und der Router dafür sind Altbestand für Sonderfälle wie Enterprise.

## Architektur

```
┌───────────────────────────────────────────────┐   ┌─────────────────────────────────┐
│ AVA des Nutzers                               │   │ Cloud-Substrat (Fly.io, EU)     │
│  Desktop-App (macOS arm64/x64, Windows x64)   │   │                                 │
│  oder AVA-Server (Container auf Fly, ohne UI) │   │ db-gateway (+ Staging-Gateway)  │
│                                               │   │  Auth (Keycloak OIDC), Policy   │
│  Chat-Agent · Firmen · Radar · Workflows      │   │  Persist-Bus mit Tier-Gate      │
│  Meldungen · Mail · Telegram · Sprachmodus    │WS │  Kopf-Relais: App, MCP und A2A  │
│                                               │◄──┤  (mcp.ava.bi), Staging-Weiche   │
│  Producer-Subprozesse (lokal)                 │   │  Register-Delta-Queue, Cron     │
│  Register-Delta-Worker (Mitpflegen)           │AMQP  Betreiber-Modell, Proxies,     │
│  LLM lokal (Ollama) oder eigener Schlüssel    │◄──┤  Abrechnung, Server-Abgleich    │
│  Whisper-Sidecar, Hintergrund-Browser         │   │                                 │
└───────────────────────────────────────────────┘   │ master-data                     │
                                                    │  Stammdaten DE/AT/CH/UK/NO/FI,  │
                                                    │  Elastic, Personen,             │
                                                    │  Beteiligungen, Adressen,       │
┌───────────────────────────────────────────────┐   │  Insolvenz-Ereignisse           │
│ Web (Vercel, EU)                              │   │                                 │
│  app.ava.bi    AVA-App (PWA, Next.js-BFF)     │──►│ ava-register-worker (Fly)       │
│  admin.ava.bi  Web-Konsole für Org-Admins     │   │ ava-pgbouncer                   │
└───────────────────────────────────────────────┘   └─────────────────────────────────┘
```

**Compute-Lokalität ist Invariante** (`docs/DECISIONS.md`): Browser-Automatisierung, Web-Abrufe und Extraktion für die Recherche laufen in der AVA des Nutzers, auf seinem Rechner oder auf seinem AVA-Server; Chat, Radar, ICP und Workflows nutzen sein eigenes Modell. Cloud-seitig laufen das Substrat, die Register-Delta-Worker des Betreibers (nur öffentliche Register, kein LLM) und die Dienste, die einen Betreiber-Schlüssel brauchen: Websuche, CRM-OAuth-Austausch, der optionale Organisationsschlüssel-Proxy und die Betreiber-Spur, über die die Producer-Stufen der Firmenverarbeitung ein fest vorgegebenes Modell des Betreibers aufrufen. Zwei Aufgaben rechnet der Server selbst, beide nur auf öffentlichen Websites: die Start-Analyse bei der Registrierung und die Vorabanalyse des Betreibers. Die Neuigkeiten-Mail vom Server ist regelbasiert und braucht kein Modell.

**Kopf-Relais:** Die laufende AVA verbindet sich ausgehend per WebSocket mit dem Gateway und meldet ihre Werkzeuge an. Darüber erreichen die AVA-App (Anfragen, Antwort-Strom per SSE mit Wiederaufsetzen) und MCP-Clients die AVA des Nutzers, ohne dass sie von außen erreichbar sein muss. Hat ein Nutzer mehrere AVAs (Desktop und Server), wählt der Gateway eine passende Instanz; persönlicher Kontext wie Profil und Gedächtnis wird dabei aus der Instanz geholt, die ihn hat. Konten im Kanal „staging“ leitet das Produktions-Gateway samt Relais-Verbindung an das Staging-Gateway weiter, damit App, Desktop, Server und MCP-Clients eines Kontos immer beim selben Gateway-Prozess landen.

**Persist-Bus mit Tier-Gate:** Producer schreiben nicht direkt in die Datenbank, sondern schicken Ereignisse an den Gateway. Der prüft Mandant, Modul-Freigabe der Organisation und die Qualitätsstufe des Modells und verwirft Rückschritte („einer verarbeitet, alle profitieren“, aber nie mit schlechteren Daten).

## Cloud-Komponenten und Betrieb

| Komponente | Rolle | Betrieb |
|---|---|---|
| `ava-db-gateway` | Auth-Gate, Policy, Persist-Bus, Kopf-Relais, MCP und A2A, Register-Queue, Verflechtungen, Proxies und Betreiber-Modell, Abrechnung, Abgleicher für Kunden-Server, Dienstmails, Staging-Weiche und Update-Feed je Kanal | Fly, [Health](https://ava-db-gateway.fly.dev/health) (nennt den Commit des laufenden Stands) |
| `ava-db-gateway-staging` | Dasselbe Gateway mit dem Code des jüngsten Release-Kandidaten, auf denselben Datenbanken und demselben Keycloak; bedient nur Konten im Kanal „staging“, startet keine globalen Jobs (nur den Abgleich für Staging-Server), Zahlungen im Stripe-Testmodus | Fly, im privaten Netz hinter dem Produktions-Gateway |
| `ava-master-data` | Stammdaten-Index DE/AT/CH/UK/NO/FI, Fuzzy-Suche (Elasticsearch), Personen, Beteiligungen, Adressen | Fly, [Health](https://ava-master-data.fly.dev/health) |
| `ava-register-worker` | Betreiber-Worker für Register-Delta, je Land eine Maschine: DE mit Browser, AT, UK, CH, NO und FI ohne | Fly, sechs Prozessgruppen; seit dem 09.11.2026 läuft nur DE, die übrigen sind bis zum Datenbank-Upgrade gestoppt |
| `ava-pgbouncer` | Verbindungstrichter vor der geteilten Postgres (100 Verbindungen für alle Dienste) | Fly |
| AVA-Server der Kunden | AVA ohne Oberfläche je Nutzer (Apps `ava-u-…`, je Instanz ein eigenes privates Netz, AVA und Ollama als zwei Container in einer Maschine); angelegt, gestoppt, aktualisiert und gelöscht vom Abgleicher im Gateway; Images je Release in `ava-server-image` und `ava-kunden-image` | Fly, eigene Organisation nur für Kunden-Instanzen |
| AVA-App, Web-Konsole | `app.ava.bi`, `admin.ava.bi`: Next.js mit Anmeldung über Keycloak (BFF, Sitzung als verschlüsseltes httpOnly-Cookie), eigene private Repos | Vercel, Frankfurt; dazu je ein Staging-Projekt (Zweig `staging`), auch für die Website |
| Keycloak | Anmeldung, Organisationen, Rollen | Fly |
| Postgres, Elasticsearch, CloudAMQP, Stripe, Mailgun (EU) | Daten, Suche, Ereignisse, Abrechnung, Dienstmails | managed |

Jeder Tag `v0.1.X` ist zuerst ein **Release-Kandidat** und erreicht nur Konten im Kanal „staging“, die der Betreiber in der Konsole einträgt. GitHub Actions baut dafür die Desktop-App als Vorabversion (macOS arm64 und x64, signiert und notarisiert; Windows x64 mit Azure Artifact Signing, `docs/WINDOWS_CODESIGNING.md`) und das Server-Image und rollt das Gateway nach `ava-db-gateway-staging` aus (`.github/workflows/desktop-release.yml`, `server-image.yml`, `staging-gateway.yml`). Staging arbeitet auf den Produktionsdaten; ein Kandidat darf das Datenbankschema deshalb nur additiv ändern, was `services/db-gateway/scripts/migration-pruefen.mjs` vor jedem Staging-Deploy erzwingt. App, Konsole und Website gehen zuerst auf den Zweig `staging` (eigene Vercel-Projekte).

Für die Produktion gibt der Betreiber einen Kandidaten per Knopf in der Web-Konsole frei. Das startet `.github/workflows/freigabe.yml`: Die Vorabversion wird ohne Neubau zur aktuellen Desktop-Version (OTA über den integrierten Updater), derselbe Commit geht nach `ava-db-gateway`, die Web-Repos spulen `main` auf den getesteten Stand vor, und die Kunden-Server ziehen in Wellen nach. Vorher prüfen das Gateway und `scripts/freigabe-pruefen.mjs`, dass die Freigabe keinen neueren Gateway-Code der Produktion zurücknimmt; sonst wird nichts ausgeliefert. Gateway-Code kommt nur auf diesem Weg in die Produktion, nie per Direkt-Deploy. master-data wird weiterhin von Hand per `fly deploy --remote-only` ausgerollt und braucht den npm-Token als Build-Secret.

## Sicherheit und Datenschutz

- Schlüssel und Tokens liegen im Schlüsselbund des Betriebssystems; eigene KI-Schlüssel überschreiten nie die Grenze zur Oberfläche und werden nicht über den Chat gesetzt.
- Hintergrund-Browser sind gehärtet: keine Downloads außer den amtlichen Registerdateien (XML, Gesellschafterlisten als PDF/TIFF, geprüft an den Magic Bytes, nach dem Lesen gelöscht), keine Web-Berechtigungen, Producer nur auf Loopback (`docs/SICHERHEIT_HINTERGRUND_BROWSER.md`).
- Personendaten: Ansprechpartner mit Herkunftsnachweis, Art.-14-Hinweis und Löschfunktion; Aufbewahrungsfristen per Cron; Geburtsdaten aus Gesellschafterlisten nur als Jahr nach außen, intern mit Hash für eine spätere Entfernung. Kontaktangaben sind firmengebunden; abgeleitete Adressen mit fremder Domain lehnt der Gateway ab.
- AVA-Server: Kontobindung (nur das gebundene Konto kann sich anmelden), Geheimnisse mit eigenem Schlüssel verschlüsselt, Einrichtungs- und Statusseite nur mit Setup-Token. Jede Kunden-Instanz liegt in einem eigenen privaten Netz und erreicht keine andere; das Fly-Token für die Kunden-Organisation liegt nur im Gateway, nie in einer Kunden-Maschine. Angelegt wird erst nach bezahlter Rechnung, und nur der Abgleicher startet Maschinen: Kein Aufruf von außen weckt eine gestoppte Instanz. Datenträger verschlüsselt, tägliche Sicherung, Löschung erst nach Frist und Ankündigung.
- MCP und A2A: Anmeldung per OAuth über Keycloak, Opt-in auf zwei Ebenen (Organisation und Nutzer). Jedes Werkzeug ist als lesend, schreibend oder überschreibend gekennzeichnet; Organisationen schalten Bereiche (Lesen, Aufträge, Kontakte, Werkzeuge der laufenden AVA, A2A) einzeln ab. Der Plugin-Pfad für ChatGPT hat eine feste Werkzeugmenge, nimmt nur Tokens an, die für ihn ausgestellt sind, und antwortet ohne interne Kennungen.
- Web-Konsole und AVA-App: Zugriffstoken bleiben serverseitig im BFF, Weiterleitung an den Gateway nur über eine Freigabeliste mit Ursprungsprüfung.
- Verbundene Dienste (AVA als MCP- oder A2A-Client): Zugangsdaten liegen verschlüsselt in der AVA, werden über eine Zugangskarte oder in den Einstellungen eingegeben und erreichen das Modell nicht. Schreibende Werkzeuge fremder Dienste laufen durch dieselbe Bestätigung wie eigene; Organisationen können fremde Dienste sperren.
- Erlaubnisse: „Immer erlauben“ gilt je Werkzeug, ist jederzeit widerrufbar und für Aktionen aus eingehenden Mails oder über MCP ausgeschlossen.
- Konto löschen anonymisiert das Konto unumkehrbar, löscht die eigenen Daten (Verhaltensprofil, Firmenliste, Leads, Buying Center, Fokus-Themen, Protokoll der KI-Anfragen) und beendet das Abo zum Periodenende; die Organisation bleibt bestehen.
- Problemmeldungen: Der Geräte-Snapshot wird vor dem Senden maskiert; Anhänge werden 90 Tage nach Abschluss einer Meldung gelöscht.
- Staging arbeitet auf den Produktionsdaten: Kandidaten-Code erreicht nur Konten, die der Betreiber einträgt, ändert das Datenbankschema nur additiv und startet keine globalen Jobs. Testzahlungen gelten nur für Organisationen von Testkonten (vom Betreiber eingetragen oder über ein von ihm gepflegtes Muster von Test-Adressen entstanden); eine Organisation mit Stripe-Kunde oder Abo wird nie auf den Testmodus gestellt.
- Entwurfs-Postfach: AVA schreibt nur in den Entwürfe-Ordner und liest keine Mails; das Passwort liegt verschlüsselt in der AVA und wird nur in den Einstellungen eingegeben.
- Alle Ausgaben von Modellen und externen Quellen werden vor der Übernahme gegen Schemata geprüft (Yup, im Gateway auch Zod). „Lieber keine Daten als falsche Daten“ ist Regel, nicht Ausnahme.
- Compliance- und Enterprise-Stand mit offenen Punkten: `docs/PLAN_ENTERPRISE_FREIGABE.md`. Die Rechtstexte zum AVA-Server (AGB, Datenschutz, Vertrag zur Auftragsverarbeitung) stehen auf ava.bi.

## Installation

Vorgefertigte Builds: [Releases](https://github.com/eproX-GmbH/ava-releases/releases) oder über [ava.bi](https://ava.bi).

1. Installationspaket der Plattform laden (macOS `.dmg`, Windows `.exe`).
2. Installieren und starten, mit Konto anmelden oder registrieren.
3. Beim ersten Start KI wählen (lokales Modell laden, eigenen Schlüssel hinterlegen oder ChatGPT-Abo verbinden) und eine Organisation anlegen oder einer beitreten. Der Einrichtungsassistent führt durch.
4. Updates kommen danach automatisch (OTA).

Ohne Installation: Nach der Registrierung auf [ava.bi](https://ava.bi) lässt sich stattdessen ein AVA-Server buchen. Bedient wird er über [app.ava.bi](https://app.ava.bi), Telegram und MCP; die Desktop-App kann später dazukommen (Umzug in beide Richtungen).

## Repository-Layout

```
ava-services/
├── .github/workflows/       # desktop-release, server-image, staging-gateway (Kandidat), freigabe (Produktion)
├── services/
│   ├── desktop/             # AVA: Electron-App (Main/Preload/Renderer), Kern (src/core), Server-Einstieg (src/server), Chat-Agent, Tools, Lösungskarten (src/main/wissen)
│   └── db-gateway/          # Cloud-Gateway: Auth, Policy, Persist-Bus, Kopf-Relais, MCP und A2A, App-Kanal, Register-Queue, Abrechnung, Kunden-Server (src/lib/cloud), Staging-Weiche, ChatGPT-Plugin-Paket (plugin-chatgpt/)
├── master-data/             # Stammdaten DE/AT/CH/UK/NO/FI, Fuzzy-Suche, Personen/Beteiligungen/Adressen (Submodul)
├── structured-content/      # Producer: Register, Officers, Gesellschafterlisten (Submodul)
├── company-publication/     # Producer: Jahresabschlüsse, Bekanntmachungen (Submodul)
├── website/                 # Producer: Websuche, Website, Stellen, Expansion, Fokus-Themen, Tech-Stack (Submodul)
├── company-profile/         # Producer: Firmenprofil (Submodul)
├── company-contact/         # Producer: Ansprechpartner (Submodul)
├── company-evaluation/      # Producer: KI-Bewertung (Submodul, abgeklemmt seit v0.1.829)
├── packages/
│   ├── ai-provider/         # Ein Interface für alle LLM-Anbieter, Katalog mit Qualitätsstufen
│   ├── company-email/       # Producer: E-Mail-Adressen ableiten und am Mail-Server prüfen
│   ├── email-muster/        # Adressmuster und SMTP-Prüfung, gemeinsamer Kern für Producer und Desktop
│   ├── website-walker/      # Seiten- und Blockauswahl für Website, Profil und Kontakte (kanonische Quelle, in die Producer kopiert)
│   ├── events/              # CloudEvents-Builder + AMQP-Client
│   └── register-delta/      # Register-Worker (Desktop „Mithelfen“ und Fly): DE, AT, UK, CH, NO, FI
├── infra/                   # Fly-Konfigurationen (Keycloak, pgbouncer, Router), Keycloak-Skripte, Docker-Compose für die Entwicklung
├── scripts/                 # vendor-sync, walker-sync, Drift-Prüfung, Freigabe-Prüfung; Altbestand: instanz-*.mjs für von Hand angelegte Server
└── docs/                    # Entscheidungen, Pläne, Tools-Referenz, Sicherheit
```

AVA-App (`app.ava.bi`) und Web-Konsole (`admin.ava.bi`) liegen in eigenen, privaten Repositories, die Website (`ava.bi`) ebenfalls in einem eigenen.

## Entwicklung

```bash
git clone --recurse-submodules https://github.com/eproX-GmbH/ava-services.git
cd ava-services && pnpm install          # Workspace: desktop, gateway, packages, Producer
cd services/desktop
pnpm dev                                  # App mit Hot-Reload
npm run build:typecheck                   # Typecheck, regeneriert docs/TOOLS.md, prüft deutsche UI-Texte
npm run test:suggestions                  # Vorschlags-Chips
npm run test:email-muster                 # E-Mail-Muster
npm run test:mail-entwurf                 # Mail-Entwürfe, Entwurfs-Postfach, feste Anhänge
npm run build:server                      # AVA als Server-Instanz (out/server)
npm run test:wissen                       # Lösungskarten: Format und Suche gegen den Prüfsatz
npm run start:lokal                       # Arbeitsstand als lokaler Build gegen die Produktivsysteme
cd ../db-gateway
npm run test:cloud                        # Kunden-Server: Abgleicher, Zahlungsfristen, Update-Wellen
npm run test:staging                      # Kanal je Konto, Weiche, Wächter
npm run test:mcp-plugin                   # ChatGPT-Plugin: Werkzeugliste gegen den Schnappschuss
```

Release: Version in `services/desktop/package.json` erhöhen, committen, Tag `v0.1.X` pushen. Der Tag erzeugt einen Kandidaten (Desktop-Vorabversion, Server-Image, Staging-Gateway); in die Produktion kommt er erst mit der Freigabe in der Konsole, siehe [Cloud-Komponenten und Betrieb](#cloud-komponenten-und-betrieb). Datenbank-Migrationen in einem Kandidaten nur additiv.

Regeln, die im Code durchgesetzt werden: deutsche UI-Texte in Du-Form (`lint:german`), keine unterstrichenen Buttons, jede neue Einstellung bekommt auch ein Chat-Werkzeug mit Bestätigung, externe und Modell-Daten werden mit Yup geprüft, jedes Katalogmodell braucht eine Qualitätsstufe, Fachjargon in Oberflächentexten fällt im Typecheck auf (`lint:jargon`), und jede nutzersichtbare Änderung zieht ihre Lösungskarten samt Prüfsatz und vorberechneten Vektoren nach.

### Vendor-Sync für `@ava/ai-provider`

Die Producer-Submodule tragen eine eingebaute Kopie von `@ava/ai-provider` unter `<producer>/vendor/ai-provider/`. Nach jeder Änderung am Paket:

```bash
pnpm vendor:sync          # baut, kopiert in alle Producer, committet und pusht dort
pnpm vendor:check         # nur prüfen
```

Ein Pre-Push-Hook blockt Pushes mit Drift. Submodul-Pointer danach im Hauptrepo committen.

Der Website-Walker (`packages/website-walker`) wird auf demselben Weg in die Producer `website`, `company-contact` und `company-profile` kopiert: `pnpm walker:sync`; `pnpm vendor:check` vergleicht auch diese Dateien.

## Dokumentation

Einstieg über [`docs/README.md`](./docs/README.md). Wichtigste Dokumente:

- [`DECISIONS.md`](./docs/DECISIONS.md): Architekturentscheidungen D1 bis D14 (Compute-Lokalität, Substrat-Umfang, Tiefe vor Breite)
- [`MODEL_TIERS.md`](./docs/MODEL_TIERS.md): Qualitätsstufen der Modelle und die Gates, die davon abhängen
- [`TOOLS.md`](./docs/TOOLS.md): automatisch erzeugte Referenz aller Chat-Werkzeuge
- [`SICHERHEIT_HINTERGRUND_BROWSER.md`](./docs/SICHERHEIT_HINTERGRUND_BROWSER.md): Härtung der Hintergrund-Browser, Download-Regeln
- [`AZURE_OPENAI.md`](./docs/AZURE_OPENAI.md): Azure OpenAI als Variante von OpenAI
- Feature-Pläne mit Stand: [`PLAN_CLOUD_SELBSTBEDIENUNG.md`](./docs/PLAN_CLOUD_SELBSTBEDIENUNG.md) (AVA-Server zum Selbstbuchen), [`PLAN_STAGING.md`](./docs/PLAN_STAGING.md) (Release-Kandidaten, Freigabe), [`PLAN_PRICING_TIERS.md`](./docs/PLAN_PRICING_TIERS.md) (Pläne, Sitze, Kontingent), [`PLAN_AVA_CLOUD.md`](./docs/PLAN_AVA_CLOUD.md) (Server-Instanzen, Kopf-Relais), [`PLAN_MCP_OEFFNUNG.md`](./docs/PLAN_MCP_OEFFNUNG.md), [`PLAN_APP_PWA.md`](./docs/PLAN_APP_PWA.md), [`PLAN_ADMIN_WEB.md`](./docs/PLAN_ADMIN_WEB.md), [`PLAN_MAIL_ENTWURF.md`](./docs/PLAN_MAIL_ENTWURF.md), [`PLAN_BUYING_CENTER.md`](./docs/PLAN_BUYING_CENTER.md), [`PLAN_KUNDEN.md`](./docs/PLAN_KUNDEN.md), [`PLAN_SPRACHMODUS.md`](./docs/PLAN_SPRACHMODUS.md), [`PLAN_KONZERNABSCHLUSS.md`](./docs/PLAN_KONZERNABSCHLUSS.md), [`PLAN_STAMMDATEN_DELTA.md`](./docs/PLAN_STAMMDATEN_DELTA.md), [`PLAN_INSOLVENZEN.md`](./docs/PLAN_INSOLVENZEN.md), [`PLAN_OESTERREICH.md`](./docs/PLAN_OESTERREICH.md), [`PLAN_UK.md`](./docs/PLAN_UK.md), [`PLAN_VERFLECHTUNGEN.md`](./docs/PLAN_VERFLECHTUNGEN.md), [`PLAN_WORKFLOWS.md`](./docs/PLAN_WORKFLOWS.md), [`PLAN_FIRMEN_DISCOVERY.md`](./docs/PLAN_FIRMEN_DISCOVERY.md), [`PLAN_EMAIL_MUSTER.md`](./docs/PLAN_EMAIL_MUSTER.md), [`PLAN_ABRECHNUNG_SEATS.md`](./docs/PLAN_ABRECHNUNG_SEATS.md), [`PLAN_ENTERPRISE_FREIGABE.md`](./docs/PLAN_ENTERPRISE_FREIGABE.md), [`PLAN_LINKEDIN_LEADS.md`](./docs/PLAN_LINKEDIN_LEADS.md), [`PLAN_STELLEN_SIGNALE.md`](./docs/PLAN_STELLEN_SIGNALE.md), [`PLAN_ABRECHNUNG_ZUGANG.md`](./docs/PLAN_ABRECHNUNG_ZUGANG.md), [`PLAN_VORABANALYSE.md`](./docs/PLAN_VORABANALYSE.md), [`PLAN_FIRMEN_OHNE_REGISTER.md`](./docs/PLAN_FIRMEN_OHNE_REGISTER.md), [`PLAN_CHATGPT_PLUGIN.md`](./docs/PLAN_CHATGPT_PLUGIN.md), [`PLAN_COPILOT_MCP.md`](./docs/PLAN_COPILOT_MCP.md), [`PLAN_CLOSE_MCP.md`](./docs/PLAN_CLOSE_MCP.md), [`PLAN_FIRMEN_HISTORIE.md`](./docs/PLAN_FIRMEN_HISTORIE.md), [`PLAN_ERSTANSPRACHE.md`](./docs/PLAN_ERSTANSPRACHE.md), [`PLAN_THEMEN.md`](./docs/PLAN_THEMEN.md), [`PLAN_BESTANDSSUCHE.md`](./docs/PLAN_BESTANDSSUCHE.md), [`PLAN_GENERATIVE_UI.md`](./docs/PLAN_GENERATIVE_UI.md), [`PLAN_ERLAUBNISSE.md`](./docs/PLAN_ERLAUBNISSE.md), [`PLAN_LOESUNGSKARTEN.md`](./docs/PLAN_LOESUNGSKARTEN.md), [`PLAN_ONBOARDING.md`](./docs/PLAN_ONBOARDING.md), [`PLAN_KONTO_LOESCHEN.md`](./docs/PLAN_KONTO_LOESCHEN.md), [`PLAN_PROBLEM_MELDEN.md`](./docs/PLAN_PROBLEM_MELDEN.md), [`PLAN_WEBSITE_WALKER.md`](./docs/PLAN_WEBSITE_WALKER.md), [`PLAN_RECHERCHE_PERSIST.md`](./docs/PLAN_RECHERCHE_PERSIST.md), [`PLAN_LINKEDIN_PROFIL_LOKAL.md`](./docs/PLAN_LINKEDIN_PROFIL_LOKAL.md), [`PLAN_SCHWEIZ.md`](./docs/PLAN_SCHWEIZ.md), [`PLAN_SKANDINAVIEN.md`](./docs/PLAN_SKANDINAVIEN.md), [`PLAN_EUROPA_REGISTER.md`](./docs/PLAN_EUROPA_REGISTER.md), [`PLAN_BURGGRABEN.md`](./docs/PLAN_BURGGRABEN.md), [`PLAN_APP_UI.md`](./docs/PLAN_APP_UI.md), [`PLAN_NUTZER_EINSICHT.md`](./docs/PLAN_NUTZER_EINSICHT.md), [`PLAN_EINSTELLUNGEN_UI.md`](./docs/PLAN_EINSTELLUNGEN_UI.md); noch nicht gebaut: [`PLAN_MICROSOFT.md`](./docs/PLAN_MICROSOFT.md), [`PLAN_LEADS_ZUORDNUNG_MAIL_LERNEN.md`](./docs/PLAN_LEADS_ZUORDNUNG_MAIL_LERNEN.md)

## Lizenz

AVA steht unter der [AVA Source-Available License](./LICENSE) der eproX GmbH. Das ist **keine Open-Source-Lizenz** im Sinne der OSI, sondern eine Source-Available-Lizenz. Kurz zusammengefasst (rechtlich maßgeblich ist allein der Text in `LICENSE`):

- **Erlaubt:** Quellcode lesen, lokal bauen und ausführen, ändern, unentgeltlich forken; Server-Komponenten lokal zum Entwickeln und Testen betreiben; Nutzung im Rahmen des Free-Plans oder eines Bezahlplans laut [AGB](https://www.ava.bi/agb).
- **Nicht erlaubt:** die App über den Free-Plan hinaus selbst betreiben (eigene Gateway-/Worker-Instanz produktiv, fremdes Backend, Umgehen von Plan-/Kontingent-Prüfungen); geschäftliche Nutzung über den Free-Plan hinaus ohne Bezahlplan; kommerzielle Weiterverbreitung (Verkauf, Hosting für Dritte, Einbau in kostenpflichtige Produkte).
- **Beiträge:** Issues und Pull Requests sind ausdrücklich willkommen. Mit dem Einreichen räumst du eproX die in Abschnitt 4 der Lizenz beschriebenen Rechte an deinem Beitrag ein.

Drittkomponenten behalten ihre jeweiligen Lizenzen. Fragen zu Bezahlplänen und kommerzieller Lizenzierung: [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de).

---

_Fragen, Feedback, Bugs:_ [info@eprox-gmbh.de](mailto:info@eprox-gmbh.de)
