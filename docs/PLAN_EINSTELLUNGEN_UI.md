# Plan: Einstellungen neu ordnen — Anordnung, Texte, Oberfläche

Stand 2026-10-30. Anlass: Joyce, „die Einstellungen sind unübersichtlich und nicht
intuitiv, die Beschreibungen oft technisch; wir arbeiten mit Vertrieblern“. Nur
Oberfläche und Texte, keine Funktionsänderung. Grundlage ist eine vollständige
Bestandsaufnahme aller 9 Tabs, rund 40 Abschnitte und ihrer Texte (2026-10-30).

## 1. Befund

**Umfang und Verteilung.** 9 Tabs, rund 40 Abschnitte. „Automatisierungen“ hat 11
Abschnitte und ist der längste Tab, „Verbrauch“, „Wissensquellen“ und „Skills“ haben
je einen. „Modelle“ besteht fast nur aus einem sehr langen Abschnitt mit zwei
Klappbereichen und sieben Schlüsselkarten.

**Die Kopfzeile setzt den falschen Ton.** Sie lautet „Anbieter, Modelle, Integrationen
und Datenpflege: alles, was die Pipeline und der Agent zur Laufzeit erwarten.“ Das ist
der Satz eines Entwicklers an einen Entwickler.

**Jargon in fast jedem Abschnitt.** Beispiele, die ein Vertriebler nicht kennt oder nicht
braucht: Pipeline, Producer, Heartbeat, Sweep, Tick, Cadence, Rubric, LLM-Judge,
Token, Cache-Read, Tier 1/2, Stufe C/B/A/S, API, Endpoint, Port, PID, Queue, AMQP,
IMAP/SMTP/TLS, Allowlist, Kill-Switch, Auto-Triage, RCPT TO, Catch-all, OAuth,
MCP, Instanz, Gateway, Deployment, Whisper-Binary, Ollama-Laufzeit, Vektorsuche,
Prompt-Caching. Dazu rohe Modell-IDs (`o4-mini-deep-research-2025-06-26`), rohe
Firmen-IDs, rohe Stage-IDs (`companyContact`), rohe Schweregrade (`urgent|warn|info`),
englische Knöpfe („Continue with ChatGPT“, „Manage usage“), Versionsnummern mitten im
Text („seit v0.1.338“) und ein Abschnitt, der sich ausdrücklich an „mich als
Entwickler“ richtet (Selbstkorrekturen). Unerklärte Abkürzungen: ICP, CRM, bAV, DSGVO,
MCP, SLA, 2FA, UTC, C-Level, DACH.

**Dopplungen über Tabs hinweg.** Schlüssel an sieben Stellen (Modelle, Azure,
Recherche mit eigenem Speicher, Sprachmodus, Telegram, Wissensquellen, Mail). LinkedIn
in drei Abschnitten über zwei Tabs. Mail in vier Abschnitten über zwei Tabs. Lokale
Modelle und Ollama an drei Stellen. Zwei verschiedene „Limits“ in zwei Tabs. „Jetzt
scannen“ zweimal mit verschiedener Bedeutung. Mithelfen-Status doppelt.

**Navigation stimmt nicht mit dem Inhalt überein.** Das Untermenü gibt es nur per
Maus-Hover, nicht per Tastatur oder Touch. Vier Sprungziele sind tot oder falsch
(„Publikations-Analyse“ existiert nicht, „Ollama-Version“ steht unter Modelle, liegt
aber in System, „Aktualisierung“ hat die Sprungmarke nur im Ladezustand, „Lokale
Modelle“ springt in einen zugeklappten Bereich). Elf Untermenü-Namen weichen von den
Überschriften ab („Alerts / Heartbeat“ vs. „Meldungen“, „Datenrefresh“ vs.
„Aktualisierung“, „Audit-Trail“ vs. „Verlauf“). Zwölf gerenderte Abschnitte haben
keinen Untermenü-Eintrag. Die Einstellungs-Suche ist ein versteckter Stub.

**Uneinheitliche Oberfläche.** Zwei Überschriftenebenen für dasselbe (H2 bei
Recherche, H3 sonst). Fünf verschiedene Abschnittsklassen (`provider-section` ohne
Kasten, `alerts-prefs`, `ct-card` mit Schatten, `verbrauch-tab`, `danger-zone`).
Acht Abschnitte erscheinen verzögert, weil sie bis zum Laden `null` rendern. Fünf
Schreibweisen für „lädt“. Knöpfe mal klein („löschen“), mal groß („Löschen“), „Pause“
neben „Pausieren“, „Trennen“ neben „Verbindung trennen“. Drei verschiedene
Wichtigkeitsskalen (Meldungen: Info/Achtung/Dringend, Telegram: alle/wichtig/dringend,
Verlauf: roh englisch). Bestätigungen überwiegend als Browser-`confirm`. Inline-Styles
mit festen Farben in Skills, Recherche-Dialogen und Plan-Balken. Ein leerer Abschnitt
„Erscheinung“, der nur als Trennlinie sichtbar ist.

**Inhaltlich widersprüchlich oder veraltet.** „API-Schlüssel nötig für die
Hintergrund-Verarbeitung“ neben „Firmenverarbeitung über AVAs Modell, kein Schlüssel
nötig“. „(kein Abo verknüpft)“ bei Anthropic, obwohl es dort kein Abo mehr gibt.
„Hintergrund-Aufgaben folgen im nächsten Update“ im Verbrauch. Eine persönliche
Mailadresse als Platzhalter. „verguenstigt“ ohne Umlaut.

## 2. Grundsätze für die Neufassung

1. **Nutzen zuerst, Technik zuletzt.** Jeder Abschnitt beginnt mit einem Satz, was er
   dem Nutzer bringt. Wie es technisch läuft, steht höchstens in einem eingeklappten
   „Technische Details“.
2. **Vertriebssprache.** Keine Entwicklerbegriffe im sichtbaren Text. Das Glossar in
   §5 legt je Begriff den Ersatz fest. Abkürzungen werden beim ersten Vorkommen je
   Abschnitt ausgeschrieben.
3. **Ein Begriff, ein Name.** Überschrift, Untermenü, Verweise aus anderen Seiten und
   Chat-Texte nennen einen Abschnitt immer gleich.
4. **Eine Skala.** Wichtigkeit heißt überall „Alle / Ab wichtig / Nur dringend“.
5. **Ein Muster.** Jeder Abschnitt ist dieselbe Karte: Titel, ein Nutzensatz, Status
   rechts oben, Inhalt, Aktionen, optional „Technische Details“. Ladezustand als
   Platzhalter in der Karte, nie ein verschwindender Abschnitt.
6. **Knöpfe als Verben mit Objekt**, groß geschrieben, einheitlich: „Verbinden“,
   „Trennen“, „Speichern“, „Löschen“, „Pausieren“, „Fortsetzen“, „Jetzt prüfen“.
   Zerstörende Aktionen rot und mit eigenem Dialog, nicht mit `window.confirm`.
7. **Keine Versionsnummern, Pfade, IDs oder Modell-IDs im Fließtext.** Versionen nur
   im Tab „Erweitert“ unter Updates; IDs nur unter „Technische Details“.
8. **Keine Zahlen im Nutzensatz**, außer sie ändern eine Entscheidung (Kosten je
   Firma, Obergrenzen).

## 3. Neue Anordnung: sechs Tabs

| Tab | Frage des Nutzers | Abschnitte (Reihenfolge) | heute |
|---|---|---|---|
| **Konto** | Wer bin ich, was zahle ich? | Profil · Plan & Abrechnung (mit Ausgabenlimit und Tages-Obergrenze für KI) · Organisation · Meine Geräte und verbundene Apps (Deine AVAs + Claude/ChatGPT-Zugang) | Konto, Teile von Verbrauch |
| **KI & Kosten** | Welches Modell arbeitet für mich, was kostet es? | So arbeitet AVA gerade (Karte) · ChatGPT-Abo · Anbieter & Modell · Schlüssel (eingeklappt) · Modelle auf diesem Rechner (eingeklappt, mit Ollama-Stand und Speicher für Modelle) · Verbrauch (Diagramm, Tabelle) · Mit AVA sprechen (Sprachmodus + Spracherkennung zusammen) | Modelle, Verbrauch, Teile von System |
| **Recherche** | Wonach sucht AVA bei meinen Firmen? | Fokus-Themen · Stellen, Ausschreibungen & Expansion (heute „Erweiterte Recherche-Funktionen“) · Beobachtungen (Watches) · Link-Überwachung · Auffrischung (Freshness, vereinfacht) · E-Mail-Adressen ableiten · Stammdaten mitpflegen | Datenquellen, Automatisierungen, Modelle |
| **Verbindungen** | Welche Werkzeuge hängen an AVA? | CRM · LinkedIn · E-Mail (Konto + Entwürfe + feste Anhänge in einem Abschnitt) · Telegram (Verbindung) · Notizen (Notion, Obsidian) | Datenquellen, Wissensquellen, Automatisierungen |
| **Meldungen** | Was meldet AVA mir, wann und wo? | Meldungen & Ruhezeiten (heute „Meldungen“) · Zustellung aufs Handy (Telegram-Teil: Schwelle, Rückfragen, Sprachantwort) · Nähe & Vorrang (Relevanz) · Vorschläge im Chat | Automatisierungen |
| **Erweitert** | Für Fortgeschrittene und den Support | Fähigkeiten (Skills) · Wiederkehrende Aufgaben · Verlauf · Updates · Speicherplatz · Diagnose · Dienste auf diesem Rechner (Datenbank + Producer + Browser in einer Karte) · Zurücksetzen | Skills, Verlauf, System, Automatisierungen |

Entfallen: „Erscheinung“ (leer), „Selbstkorrekturen“ als eigener Abschnitt (wandert in
den Verlauf als Filter „Hinweise für den Support“), die Einstellungs-Suche als
versteckter Stub (wird entweder gebaut oder gelöscht, Vorschlag: löschen).

Untermenü: je Tab genau die gerenderten Abschnitte, Name = Überschrift, erreichbar per
Tastatur und Touch (Klick auf den Tab klappt die Liste auf, kein Hover-Flyout). Jeder
Abschnitt trägt seine Sprungmarke auf der Karte, nicht auf einem Eingabefeld. Alte
Anker leiten weiter.

## 4. Die Karte als einziges Muster

Eine Komponente `EinstellungsKarte` ersetzt `provider-section`, `alerts-prefs`,
`ct-card`, `verbrauch-tab` und `danger-zone`:

```
┌─ Titel ───────────────────────────────── [Status-Chip] ─┐
│ Ein Nutzensatz in Du-Form.                               │
│ Inhalt (Felder, Listen, Diagramm)                        │
│ [Primäre Aktion] [Sekundär]              Hinweis rechts  │
│ ▸ Technische Details                                     │
└──────────────────────────────────────────────────────────┘
```

- **Status-Chip** oben rechts: „Verbunden“, „Aus“, „Läuft“, „Fehlt noch“, „Von der
  Organisation festgelegt“. Dasselbe Chip-Set überall.
- **Nutzensatz**: ein Satz, kein Absatz. Mehr Erklärung gehört in einen Hilfetext
  hinter einem „Mehr“-Link, nicht in die Karte.
- **Ladezustand**: die Karte steht sofort mit Titel und Nutzensatz, der Inhalt ist ein
  grauer Platzhalter. Nichts rendert `null`.
- **Abgeschaltet durch die Organisation**: Karte bleibt sichtbar mit Chip „Von der
  Organisation festgelegt“ und ausgegrauten Reglern, wenn die Funktion grundsätzlich
  da ist; Karte verschwindet, wenn die Organisation das Modul komplett sperrt (wie
  heute bei Mail, Telegram, LinkedIn). Das ist die bestehende Regel, nur konsequent.
- **Technische Details** (`<details>`): Pfade, Ports, IDs, Modell-IDs, Versionen,
  Protokollnamen. Standard zu.
- **Dialoge**: eine `Bestaetigung`-Komponente (Titel, Text, roter oder normaler
  Knopf) ersetzt `window.confirm` und `alert` in allen Abschnitten.
- **Leerzustände** nennen immer den nächsten Schritt mit Knopf oder Chat-Satz
  („Noch keine Beobachtung. Sag AVA im Chat: ‚Beobachte wöchentlich …‘“).
- Inline-Styles und feste Hex-Farben wandern in Klassen mit Theme-Tokens.

Mobil (unter 900 px): Tabs als horizontale Leiste wie heute, Karten einspaltig,
Tabellen mit horizontalem Scrollen in der Karte.

## 5. Glossar: so heißt es künftig

| Heute im Text | Künftig sichtbar | Bleibt nur unter Technische Details |
|---|---|---|
| Pipeline, Producer, Stage, Zelle | Verarbeitung, Verarbeitungsschritt | Producer-Name, Stage-ID |
| Heartbeat, Sweep, Tick, Loop | Prüflauf, „AVA prüft alle 15 Minuten“ | — |
| Cadence | Rhythmus, „alle 7 Tage“ | — |
| Watch, Rubric, LLM-Judge, Topics, Kandidaten | Beobachtung, Kriterium, Was wird geprüft, Fundstellen | — |
| Token, Input/Output, Cache-Read | KI-Verbrauch, gelesener/geschriebener Text, Wiederverwendung | Token-Zahlen in der Tabelle |
| Tier 1/2, Stufe C/B/A/S | Modellklasse: einfach / gut / stark / sehr stark; Anbieter-Limit | Tier-Name |
| API-Schlüssel, Key | Schlüssel (des Anbieters) | sk-… Präfixe |
| Endpoint, Port, PID, Queue, in flight | — (nur Status „läuft“ / „gestoppt“) | alle |
| AMQP, Gateway, Cloud-Broker | AVA-Server | Protokoll |
| IMAP, SMTP, TLS, Host, Port | Posteingang, Postausgang, Server, verschlüsselt | Feldnamen beim Einrichten |
| Allowlist, Kill-Switch, Auto-Triage, trusted | Vertrauenswürdige Absender, Versand erlauben, automatisch antworten | — |
| RCPT TO, Catch-all, Baseline-Adresse | Mail-Server fragt nach, Server nimmt alles an, Vergleichsadresse | — |
| OAuth, Token (Notion, Telegram) | Anmeldung, Zugangscode | — |
| MCP, Instanz | Zugang für Claude und ChatGPT, Gerät (dieser Rechner / Server) | MCP |
| Ollama-Laufzeit, Whisper-Binary, Deployment | lokale KI, Spracherkennung, Zuordnung | Programmname |
| Vektorsuche, Prompt-Caching, Entity-Resolution | — | alle |
| ICP | Idealkundenprofil (ICP) | — |
| CRM | CRM (einmal ausgeschrieben: Kundenverwaltung wie HubSpot) | — |
| Scan (LinkedIn, Freshness) | Durchlauf, Auffrischung | — |
| Free/Starter/Pro/Enterprise, Seat | Tarifnamen bleiben, „Seat“ → Nutzerplatz | — |
| Skill | Fähigkeit (Skills) | Dateiname SKILL.md |
| Audit-Trail, Events | Verlauf, Einträge | — |
| Push | Benachrichtigung | — |

Wichtigkeit überall: **Alle · Ab wichtig · Nur dringend**.

## 6. Textbeispiele (vorher → nachher)

**Kopfzeile.** „Anbieter, Modelle, Integrationen und Datenpflege: alles, was die
Pipeline und der Agent zur Laufzeit erwarten.“ → „Hier stellst du ein, wie AVA für
dich arbeitet: dein Konto, die KI dahinter, wonach sie sucht, was sie meldet und womit
sie verbunden ist.“

**Profil.** „Wird in jeden Agenten-Turn als Lese-Kontext eingewoben. Der Agent passt
Antworten daran an.“ → „Wer du bist und was dich interessiert. AVA richtet Antworten,
Filter und Meldungen danach aus.“

**Auffrischung.** „Hintergrund-Loop, der Pipeline-Stages je Firma erneut anstößt, wenn
sie ihre Cadence überschritten haben. Stille Disk-Arbeit; echte Änderungen erscheinen
über den Heartbeat als Meldung.“ → „AVA liest deine Firmen regelmäßig neu ein, damit
Kontakte, Website und Abschlüsse aktuell bleiben. Was sich wirklich geändert hat,
bekommst du als Meldung.“ Die Tabelle „Rhythmus je Bereich“ nennt Kontakte, Profil,
Website, Register, Abschlüsse mit „alle n Tage“; die Drosselung wandert unter
Technische Details.

**Beobachtungen.** „Wiederkehrende Beobachtungen, die der Heartbeat im Hintergrund
gegen frische Kandidaten prüft.“ → „Sag AVA, worauf sie bei deinen Firmen achten soll,
etwa auf einen Wechsel in der Geschäftsführung. Treffer landen in den Meldungen.“
Formularfelder: „Worauf soll AVA achten?“, „Woran erkennt sie einen Treffer?“ (statt
„Rubric für den LLM-Judge“), „Wie oft?“, „Nur diese Firmen“ (Firmensuche statt
Company-IDs).

**E-Mail-Konto.** „AVAs dediziertes IMAP/SMTP-Postfach. Eingehende Mails werden
klassifiziert (Triage-Inbox) und nur Absender in der Allowlist dürfen autonome Aktionen
auslösen.“ → „Ein eigenes Postfach für AVA. Sie liest eingehende Mails, sortiert sie
vor und antwortet nur Absendern, denen du vertraust.“ Die Checkbox „Auto-Triage für
trusted Mails (vollautonom) … Limits: max 5 Auto-Replies pro Thread, Cooldown 5min“ →
„Vertrauenswürdigen Absendern automatisch antworten“, darunter ein Satz „Höchstens
fünf Antworten je Gesprächsfaden, mit Pause dazwischen.“

**E-Mail-Adressen ableiten.** Der heutige Absatz hat 90 Wörter und vier Fachbegriffe.
→ „Fehlt einem Kontakt die Mailadresse, leitet AVA sie aus dem Muster der Firma ab,
etwa vorname.nachname@firma.de, und fragt beim Mail-Server nach, ob es sie gibt. Ohne
eine Mail zu senden.“ Die drei Stufen „verifiziert / unbestätigt / unverifiziert“
bekommen je einen halben Satz unter „Mehr“.

**Stellen, Ausschreibungen & Expansion.** „Aktiviert zusätzliche LLM-gestützte
Anreicherung pro Firma.“ → „AVA sucht im Web nach offenen Stellen und nach
Expansions- und Ausschreibungsmeldungen deiner Firmen. Standard kostet wenige Cent je
Firma, Deep Research ist gründlicher und kostet bis zu 5 Euro je Firma.“ Modellnamen
mit Datum verschwinden aus der Karte.

**Schlüsselkarte OpenAI.** „Schaltet im website-Producer Deep Research
(o4-mini-deep-research) sowie Google-Maps-Entity-Resolution + Quellen-Discovery
(gpt-6-luna) frei. Ohne Schlüssel bootet der Producer trotzdem …“ → „Mit einem
OpenAI-Schlüssel kann AVA Deep Research, den Sprachmodus und die Websuche nutzen.
Ohne Schlüssel läuft alles andere weiter.“

**Dienste auf diesem Rechner** (heute drei Abschnitte). → Eine Karte: „AVA verarbeitet
deine Firmen auf diesem Rechner. Hier siehst du, ob alles läuft.“ Darunter je Dienst
ein Status-Chip („läuft“, „startet“, „Fehler“) mit Klartext-Fehler; Ports, PIDs,
Warteschlangen und Datenbank-Pfade unter Technische Details.

**Verlauf.** „Chronologische Aufzeichnung aller Vorgänge in AVA — Producer-Läufe,
LinkedIn-Signale, Hintergrund-Heartbeat, Authentifizierungs-Events, CRM-Aktionen.“ →
„Was AVA wann getan hat: Verarbeitungen, Meldungen, Anmeldungen, CRM-Aktionen. Bleibt
auf deinem Rechner.“ Kategorien in Nutzersprache, rohe Aktionscodes und JSON unter
Technische Details.

**Telegram.** Einrichtung als drei nummerierte Schritte mit Screenshots statt
„@BotFather“ und „/newbot“ im Fließtext (die Begriffe bleiben als Zitat in den
Schritten, weil Telegram sie so nennt).

**ChatGPT-Abo.** Englische Pflichtsätze von OpenAI bleiben als Zitat in
Anführungszeichen; alle übrigen Knöpfe deutsch („Mit ChatGPT anmelden“, „Verbrauch bei
ChatGPT ansehen“). Vorab prüfen, ob die OpenAI-Richtlinie den englischen Knopftext
verlangt; wenn ja, bleibt nur der Knopf englisch.

## 7. Stufen

| Stufe | Inhalt | Aufwand |
|---|---|---|
| E0 | Plan, Freigabe der Tab-Struktur und des Glossars | — |
| E1 | Rahmen: sechs Tabs, `EinstellungsKarte`, `Bestaetigung`, Status-Chips, Untermenü per Klick mit korrekten Sprungzielen, Weiterleitung alter Anker, Suche-Stub entfernen, „Erscheinung“ entfernen | 1 Tag |
| E2 | Umzug der Abschnitte in die neuen Tabs ohne Textänderung; Zusammenlegen E-Mail (Konto + Entwürfe + Anhänge), Dienste auf diesem Rechner (Datenbank + Producer + Browser), Mit AVA sprechen (Sprachmodus + Spracherkennung), Modelle auf diesem Rechner (lokale Modelle + Ollama-Stand); Verbrauch und Tages-Obergrenze unter KI & Kosten bzw. Konto | 1 Tag |
| E3 | Texte Welle 1: Kopfzeile, alle Überschriften und Nutzensätze (rund 40), Untermenü = Überschrift, Wichtigkeitsskala, Knopf-Schreibweise, Ladezustände | 1 Tag |
| E4 | Texte Welle 2: Formularfelder, Hilfetexte, Fehlertexte (`updater-error`, `producer-error`), Dialoge, Leerzustände; Jargon in „Technische Details“ verschieben; Modell-IDs, Pfade, IDs raus aus dem Fließtext; Platzhalter mit persönlicher Adresse ersetzen | 1,5 Tage |
| E5 | Oberfläche: Inline-Styles in Klassen, Karten einheitlich, Tabellen in Karten, Dark Mode je Karte prüfen (Prüfung nach dem Muster aus docs: echte styles.css in statischer Seite messen), Mobil-Ansicht | 1 Tag |
| E6 | Schutz: `check-german.mjs` um eine Jargon-Liste aus §5 erweitern (Begriffe, die in sichtbaren Texten unter `routes/settings` und `Settings.tsx` nicht vorkommen dürfen, außer innerhalb `<details>`), damit der Zustand hält | 0,5 Tage |

Reihenfolge E1, E2, E3 in einem Release (der Nutzer sieht die neue Ordnung mit
sauberen Überschriften), dann E4, E5, E6. Gesamt rund sechs Tage.

## 8. Offene Entscheidungen (Joyce)

1. Sechs Tabs wie in §3, oder lieber fünf (Meldungen in Recherche)? Vorschlag: sechs,
   weil „Was meldet AVA mir?“ eine eigene Frage ist.
2. „Verbrauch“ als eigener Abschnitt unter KI & Kosten (Vorschlag) oder weiter als
   Tab?
3. Skills: Name „Fähigkeiten“ (Vorschlag) oder „Skills“ beibehalten, weil der Chat
   `/skill` sagt?
4. Englische ChatGPT-Knöpfe: nur das behalten, was OpenAI vorschreibt (Vorschlag).
5. Einstellungs-Suche: löschen (Vorschlag) oder bauen?
