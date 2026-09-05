# Prompt für den Website-Agenten (ava.bi): Compliance, Datenflüsse, Enterprise

Stand 2026-09-03. Quelle: docs/PLAN_COMPLIANCE_ENTERPRISE.md. Die Prompt
unten ist zum Kopieren gedacht. Sie unterscheidet strikt zwischen dem,
was heute live ist, und dem, was geplant ist. Geplantes darf auf der
Website nie als vorhanden erscheinen.

---

Du überarbeitest die Website ava.bi. AVA ist eine Desktop-App der eproX GmbH
(Herford) für B2B-Vertriebsrecherche im DACH-Raum. Deine Aufgabe: alle
Aussagen zu Datenschutz, Datenflüssen, LinkedIn, KI-Modellen, Betrieb und
Enterprise so präzisieren, dass sie einer kritischen Prüfung durch einen
Datenschutzbeauftragten oder IT-Leiter standhalten. Nichts weglassen, was
für die Kaufentscheidung relevant ist, nichts versprechen, was nicht live
ist. Ton: sachlich, selbstbewusst, Du-Form, keine Geviertstriche, keine
Marketing-Superlative. Ehrlichkeit ist hier das Verkaufsargument.

## 1. Den Claim „lokal" präzisieren

Streiche jede Formulierung wie „verlässt deinen Rechner nie" oder „alles
bleibt lokal". Ersetze sie durch die Unterscheidung in drei Datenklassen
und baue eine Tabelle „Was verlässt deinen Rechner?" ein:

- **Bleibt immer auf deinem Rechner:** Chats mit dem Agenten, sein
  Gedächtnis, dein Profil, deine ICP-Definition, alle API-Schlüssel und
  Abo-Tokens, deine Logins (LinkedIn, Mail, Telegram), Mail-Inhalte,
  Telegram-Nachrichten, Beobachtungs-Signale zu Personen auf deiner
  Watchlist. Diese Daten liegen verschlüsselt je Konto auf dem Gerät.
- **Geht an das AVA-Substrat (Frankfurt, EU):** welche Firmen du
  recherchierst (als Verarbeitungsaufträge), Firmenfakten aus öffentlichen
  Quellen (Handelsregister, Bundesanzeiger, Firmenwebsite, Suchergebnisse)
  und Kontaktpersonen an diesen Firmen aus öffentlichen Quellen (Name,
  Funktion, Profil-Link, geschäftliche Kontaktdaten), jeweils mit
  Quellenbeleg und Zeitstempel. Dieser Bestand ist geteilt: Was ein
  Nutzer aus öffentlichen Quellen erhoben hat, muss der nächste nicht
  erneut erheben.
- **Geht an das AVA-Substrat zur Kontingent-Zählung:** Firmen-Kennung und
  Zeitpunkt je verarbeiteter Firma. Keine Inhalte, kein Nutzungs-Tracking,
  keine Analyse-Bibliotheken in der App.

Formuliere den neuen Kernsatz so: „Deine eigenen Daten verlassen deinen
Rechner nie. Öffentliche Firmen- und Kontaktinformationen landen mit
Quellenbeleg in einem geteilten Bestand, den du auf Wunsch selbst
betreiben kannst."

## 2. Die Vergleichstabelle bereinigen

Entferne Bewertungen wie „teilweise DSGVO-konform" für Wettbewerber und
„voll konform" für AVA. Stattdessen sachliche Merkmale: Verarbeitungsort,
Quellenbeleg je Datenpunkt, Modellwahl (lokal, Cloud, eigener Server),
Betrieb in eigener Infrastruktur möglich, Preismodell. Ergänze den
ehrlichen Hinweis: Der Kunde bleibt Verantwortlicher im Sinne der DSGVO;
AVA liefert Provenienz, Löschmechanismen und Vorlagen, nimmt ihm die
Rechtsgrundlage aber nicht ab.

## 3. Kontaktdaten und Provenienz

Beschreibe, was heute live ist: Jede Beobachtung trägt Quelle, Beleg-URL,
Belegausschnitt, Zeitpunkt und die eingesetzte Modellstufe. Kontaktdaten
zeigen in der App einen Quellen-Link. Beschäftigungen verfallen
automatisch, wenn sie 120 Tage von keinem Lauf mehr bestätigt wurden.

Kennzeichne als **in Arbeit**: Herkunftsnachweis je Person auf Knopfdruck
(Antwort auf Auskunftsersuchen), Löschung einer Person im gesamten
Bestand mit Sperre gegen Wiedererfassung, Hinweistext-Vorlage für die
Informationspflicht nach Art. 14, automatische Tilgung von Personen 180
Tage nach der letzten Beobachtung.

## 4. LinkedIn: transparent, abschaltbar, ohne Automatisierung

Behalte die heutige Offenheit (eigener Login, Restrisiko der Erkennung,
Hinweis auf ein Zweitkonto), ergänze aber drei Dinge:
- AVA liest, AVA handelt nicht: kein automatisches Liken, Kommentieren
  oder Anschreiben. Das ist eine Produktgrenze.
- Der Einsatz mit einem Firmen-Login liegt in der Verantwortung des
  Arbeitgebers; die App verlangt vor der ersten Nutzung ein
  ausdrückliches Einverständnis, das mit Zeitstempel gespeichert wird.
- Das LinkedIn-Modul ist heute je Konto abschaltbar. **In Arbeit:**
  Abschaltung je Modul (Beobachter, Watchlist, Personen-Radar,
  Bildanalyse) zentral für den gesamten Mandanten.

Die Bildanalyse von Beiträgen läuft standardmäßig nur mit einem lokalen
Modell auf dem Rechner; ein Cloud-Modell erfordert ein ausdrückliches
Opt-in mit dem Hinweis, dass Bilder dann den Rechner verlassen. Das ist
live und darf so stehen.

Kennzeichne als **in Arbeit**: eine mitgelieferte Vorlage für die
Datenschutz-Folgenabschätzung zum LinkedIn-Modul.

## 5. KI-Modelle: Datenfluss je Anbieter benennen

Erkläre die drei Wege ohne Beschönigung: lokal (Ollama auf dem Rechner),
Cloud-Anbieter mit eigenem Schlüssel oder Abo (OpenAI, Anthropic, Google,
Mistral, DeepSeek, xAI, Qwen), eigener Modell-Server. Sage klar: Bei
einem Cloud-Anbieter gehen Website-Texte, Registerauszüge und, falls das
LinkedIn-Modul aktiv ist, Beitragstexte an dessen API; der Kunde schließt
dafür den Vertrag mit dem Anbieter. Nenne die Qualitätsstufen ehrlich:
lokale Modelle reichen für Registerauszüge, für Lageberichte und
Bewertungen empfehlen wir Cloud- oder Server-Modelle. Kennzeichne als
**in Arbeit**: Festlegung je Mandant, welche Datenklassen an welche
Modellklasse dürfen (zum Beispiel Personendaten nur lokal oder EU).

Ergänze einen Absatz **„Zentrale Schlüssel für Teams"** (live): Eine
Organisation kann Schlüssel für KI-Anbieter und Apify zentral hinterlegen.
Diese Schlüssel liegen verschlüsselt im AVA-Gateway und sind für niemanden
auslesbar, auch nicht für die Mitglieder; die App ruft die Anbieter dann
über das Gateway auf, das den Schlüssel einsetzt. Sage ohne Beschönigung,
was das bedeutet: Bei diesem Weg laufen Prompts und Antworten durch das
AVA-Gateway (Frankfurt, EU). Gespeichert werden nur Zähler (Tokens,
Modell, geschätzte Kosten je Mitglied), keine Inhalte, es sei denn, die
Organisation schaltet ein Prompt-Audit bewusst ein; das ist für alle
Mitglieder sichtbar. Wer einen eigenen Schlüssel oder ein Abo hinterlegt,
bleibt komplett lokal, wie bisher. Beides ist je Anbieter umschaltbar,
sofern die Organisation das Überschreiben erlaubt.

## 6. Betrieb: als Service oder in eigener Infrastruktur

Formuliere eine neue Sektion „Betriebsmodelle":
- **Als Service:** Substrat bei AVA (Frankfurt, EU-Rechenzentrum), App
  auf den Rechnern der Nutzer, Rechenarbeit auf den Nutzer-Rechnern.
- **In eigener Infrastruktur (auf Anfrage):** Das gesamte Substrat
  (Datenbank, Nachrichtenbus, Identitätsdienst, Gateway) läuft per Docker
  auf einem eigenen Server, on-premise oder bei einem EU-Hoster, optional
  mit einem eigenen Modell-Server für alle Nutzer. Dann verlässt nichts
  die Organisation. Kennzeichne diese Option als „auf Anfrage, gemeinsam
  mit uns eingerichtet", nicht als Selbstbedienung.

## 7. Zusammenarbeit und Enterprise

Beschreibe, was live ist (Stand 2026-09-05):
- **Organisationen:** Ein Nutzer legt eine Organisation an und wird
  Admin. Weitere Mitglieder kommen nur per Einladungslink dazu; der Admin
  gibt jede Beitrittsanfrage frei. Rollen: Owner, Admin, Mitglied.
- **Kontowechsel** auf einem Gerät mit strikt getrennten lokalen Daten
  (Chats, Schlüssel, Logins je Konto; nur lokale Modelle werden geteilt).
- **Vorgaben für alle Mitglieder:** Module lassen sich für die
  Organisation abschalten (LinkedIn-Beobachter, Personen-Watchlist,
  Personen-Radar, Bildanalyse, Kontakt-Recherche, Mail, Telegram). Aus
  heißt: verschwindet aus der App, Hintergrunddienste stoppen, und die
  Kontakt-Recherche wird zusätzlich serverseitig abgewiesen.
- **Zentrale Schlüssel ohne Auslesbarkeit** (siehe Abschnitt 5), auf
  Wunsch mit Sperre lokaler Überschreibung und festen Modellvorgaben für
  Chat und Hintergrundverarbeitung.
- **Limits und Verbrauch:** Monatsbudget der Organisation oder
  Tagesbudget je Mitglied für Aufrufe über die zentralen Schlüssel, wahlweise
  harter Stopp oder nur Hinweis; Verbrauchsübersicht je Mitglied. Sage
  ehrlich: Eigene Schlüssel der Mitglieder sind nicht messbar und bleiben
  unlimitiert. Beträge sind Schätzungen in US-Dollar aus der Preistabelle.
- **Geteiltes Firmenwissen:** Öffentliche Firmen- und Kontaktinformationen
  liegen mit Quellenbeleg in einem gemeinsamen Bestand.

Kennzeichne als **in Arbeit**: Recherchen (Transaktionen) mit der
Organisation teilen und Firmen daraus übernehmen, Radar-Firmen an Kollegen
weitergeben, ein Server-Worker, der Beobachtung und Radar für die
Organisation übernimmt, damit nichts vom aufgeklappten Laptop abhängt,
sowie eine Anbindung an Microsoft Dynamics 365 Sales. Ebenfalls in
Arbeit: Festlegung je Organisation, welche Datenklassen an welche
Modellklasse dürfen.

Enterprise-Plan: keine Feature-Liste, keinen Preis. Aussage: „Individuelle
Konnektoren zu ERP-, CRM- und Datensystemen sind umsetzbar, Umfang und
Preis nach Absprache." Sage auch, was AVA nicht ist: kein Ersatz für
Governance-Werkzeuge wie Purview oder für einen M365-Copilot. AVA liefert
Recherche und Anlass-Erkennung, die Governance kommt aus dem Stack des
Kunden.

## 8. Verteilung und IT-Freigabe

Nenne offen: Verteilung heute über signierte Pakete von GitHub Releases;
die App steuert für das LinkedIn-Modul ein eigenes, sichtbares Fenster
der App selbst, keinen fremden Browser-Prozess. Kennzeichne als **in
Arbeit**: Pakete für Intune und Jamf, Konfiguration der Server-Adresse
über ein Profil ohne Neuinstallation.

## 9. Arbeitsregeln für dich

- Jede Aussage muss einer der drei Kategorien zugeordnet sein: live, in
  Arbeit, auf Anfrage. Nutze diese Wörter, keine Umschreibungen.
- Wo du eine Zahl oder ein Datum nicht sicher weißt, lass es weg und
  markiere die Stelle für Rückfrage.
- Keine Vergleiche, die Wettbewerber rechtlich bewerten.
- Prüfe am Ende jede Seite auf die Wörter „nie", „immer", „voll" und
  „garantiert" und ersetze sie, wo sie nicht wörtlich zutreffen.
