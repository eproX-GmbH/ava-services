# Plan: AVA führt statt zu programmieren — Lösungskarten, Ton, sichere Zugänge

Stand 2026-11-07. Anlass: Feedback Patrick (Sprachnachrichten 2026-11-07) nach dem Versuch,
CompLeadly im Chat zu verbinden. AVA antwortete dreimal sinngemäß „Ich habe kein Werkzeug
dafür, geh in die Einstellungen“. Joyce teilt die Kritik und gibt die Richtung vor:
Wissen nicht in den Systemprompt kippen, sondern als kurze Lösungskarten ablegen und bei
Bedarf suchen; Zugangsdaten sicher im Chat erfassen; Anmeldung so allgemein wie möglich.

## 1. Befund

**Was Patrick bemängelt** (Kern seiner beiden Sprachnachrichten):

- AVA wirkt „programmatisch“: Sie will genaue Anweisungen Schritt für Schritt, statt zu
  erkennen, was gemeint ist, Möglichkeiten anzubieten und einen nächsten Schritt zu
  empfehlen. Nutzer kommen von ChatGPT und erwarten dieses Führen.
- AVA redet über Werkzeuge, Tools und Trefferzahlen („ich habe dafür kein Werkzeug“).
  Den Nutzer interessiert, was AVA für ihn tun kann, nicht womit.
- Die Anzeige im Chat ist technisch („2 Schritte ausgeführt, 1 Werkzeug verwendet“,
  „28 Tools, 10.000 Treffer“). Für uns hilfreich, für Nutzer Rauschen. ChatGPT zeigt
  „Denkt nach“.
- Ausdrücklich NICHT gewollt: dass AVA dafür beschönigt oder halluziniert. Ehrlich
  bleiben, nur anders verpacken.
- Vision Joyce: AVA nur über den Chat bedienen. Heute ist man dabei „verloren“.

**Technischer Stand:**

- Grundsockel je Antwort laut Screenshots ~103.000 bis 107.000 Tokens, auch bei
  Einzeilern. `prompts.ts` hat 78 KB, `soul.ts` 8 KB, dazu die immer geladenen
  Kern-Werkzeuge mit Schemas und der Gesprächsverlauf. Genaue Aufteilung unbekannt.
- Werkzeugsuche: `tool_search` (Stichwortwertung Name/Kategorie/Kurztext/Beschreibung,
  `agent/tools/meta.ts`) plus `tool_load`. Daneben `skill_search`. Es gibt also schon
  zwei getrennte Suchen.
- Lokale Vektoren über Ollama (embeddinggemma) sind auf dem Gerät vorhanden und werden
  in der Bestandssuche schon zum Nachsortieren genutzt.
- MCP-Dienste (`main/mcp-client/`): Zugang heute nur über Kopfzeilen/Token, die der
  Nutzer in Einstellungen → Verbindungen → Weitere Dienste einträgt. OAuth mit
  dynamischer Registrierung ist als C6 im Close-Plan vermerkt, nicht gebaut.
- HubSpot und LinkedIn haben eine eigens gebaute Anmeldung im Fenster. Das ist der
  Vergleich, den Patrick zieht.
- AVA kann aus dem Chat keine Einstellungsseite öffnen (Antwort im Screenshot: „kein
  Werkzeug zur App-Navigation“), obwohl der Vorschlagschip „Öffnen“ das kann.

## 2. Entscheidungen

1. **Lösungskarten statt Prompt-Wissen.** Eine Karte = ein Problem + Lösung, kurz
   (Richtwert 80–300 Tokens). Eine Karte ist genau ein Suchtreffer und wird bei Treffer
   vollständig geladen. Kein Zerlegen in kleinere Stücke.
2. **Eine Suche für alles.** Werkzeuge, Skills und Karten kommen aus einer gemeinsamen
   Suche, die Treffer sind nach Art getrennt („Wissen“, „Fähigkeiten“). Grund: Das
   Modell nutzt heute schon `tool_search` zuverlässig als ersten Griff; jede zusätzliche
   Suche ist eine Entscheidung mehr, die es falsch treffen kann, und `skill_search`
   wird kaum genutzt. Der Prompt erklärt die Suche in einem Satz als „Wie geht das /
   kann ich das?“. Die alten Namen bleiben als Aliase.
   (Joyce: eigene Wissenssuche mit Prompt-Hinweis wäre auch okay; Entscheidung bei mir.)
3. **Karten können handeln.** Eine Karte darf Aktionen tragen (Einstellungsseite für
   genau diesen Dienst öffnen, Zugangskarte anzeigen, Vorlage anlegen). AVA sagt nie
   wieder „ich kann die Seite nicht öffnen“.
4. **Wissen zuerst sauber erfassen.** Bevor Karten entstehen, gibt es einen eigenen
   Schritt (eigene Session), der das gesamte nötige Wissen über AVA inventarisiert.
   Die Karten werden daraus erzeugt, nicht nebenbei geschrieben.
5. **Zugangsdaten nie im Chat-Text.** Eine Zugangskarte im Chat nimmt Werte entgegen,
   die direkt in den verschlüsselten Speicher gehen. Das Modell sieht nur das Ergebnis.
6. **Anmeldung allgemein, wo der Standard es hergibt.** MCP schreibt OAuth mit
   Selbstbeschreibung vor (Protected Resource Metadata, Authorization Server Metadata,
   dynamische Client-Registrierung). Server, die das umsetzen, bekommen ein
   Anmeldefenster ohne Vorarbeit von uns. Alle anderen nutzen die Zugangskarte.
7. **Ehrlichkeit bleibt.** Der neue Ton ändert die Verpackung, nicht die Wahrheit. AVA
   behauptet nichts, was sie nicht tun kann; sie sagt stattdessen, was geht und was der
   nächste Schritt ist.

## 3. Schritte

### L0 Messung: woraus bestehen die 105.000 Tokens? (0,5 Tag)

- Je Turn protokollieren: Systemprompt-Abschnitte, Soul, Kern-Werkzeug-Schemas,
  geladene Werkzeuge, Verlauf, Werkzeugergebnisse. Ausgabe als Tabelle im Debug-Log.
- Ergebnis: Liste der größten Brocken mit Ziel je Brocken (bleibt / wird Karte / wird
  gekürzt). Grundlage für L5.

### L1 Ton und Anzeige (1 Tag, sofort spürbar)

- Prompt-Regel „Sprache des Nutzers“: nie über Werkzeuge, Tools, Treffer, Schemas
  reden. Sagen, was AVA tun kann. Bei offenen Anfragen zwei bis drei Wege anbieten und
  einen empfehlen. Bei Unmöglichem: kurz sagen, was stattdessen geht, plus Knopf.
- Chat-Anzeige: Standard nur „Denkt nach…“ mit lebendem Zwischenstand in Alltagssprache
  („Schaue in deine Firmenliste“). Einzelheiten aufklappbar; Schalter „Arbeitsschritte
  anzeigen“ in den Einstellungen und als Agent-Werkzeug (Self-Service-Regel), für
  Betreiber standardmäßig an.
- Werkzeugfehler, die heute als Rohtext durchschlagen, in Nutzersprache übersetzen.
- Neues Kern-Werkzeug `app_oeffnen` (Bereich + optional Dienst/Firma), damit AVA die
  passende Seite selbst öffnen kann. Gleiche Ziele wie die Vorschlagschips.

### L2 Wissenserfassung (eigene Session, umfangreich: 3–5 Tage)

Ziel: ein vollständiges, geprüftes Wissensinventar von AVA aus Nutzersicht, aus dem
die Karten erzeugt werden. Läuft als eigener Arbeitsgang, nicht nebenbei.

Quellen, systematisch abzuarbeiten:

1. Einstellungen und Oberfläche: jede Seite, jeder Schalter, jede Verbindung (Desktop,
   Konsole, PWA, Telegram).
2. Werkzeugkatalog: alle registrierten Werkzeuge mit Kategorie, gruppiert nach den
   34 Fähigkeitsgruppen der Chat-Vorschläge. Daraus „Was kann AVA“-Karten.
3. `prompts.ts` und `soul.ts`: jeder Abschnitt wird klassifiziert in Verhaltensregel
   (bleibt im Prompt) oder Wissen (wird Karte).
4. README „Was AVA heute kann“ und die Do-not-claim-Listen der Website-Prompts.
5. Pläne in `docs/PLAN_*.md`: nur der nutzersichtbare Teil (was geht, Grenzen, Kosten).
   Keine Plan-Verweise in die Karten.
6. Supportfälle: Problem-melden-Einträge, Rückmeldungen von Patrick und Alessandro,
   wiederkehrende Fragen aus Chatverläufen (anonymisiert, nur Muster).
7. Integrationen: HubSpot, Close, Salesforce, Dynamics, Notion, Mail, Telegram,
   CompLeadly, MCP/A2A, Copilot, ChatGPT-Abo, Azure, eigene Schlüssel.
8. Abrechnung, Stufen, Limits, Datenschutz, Datenhaltung lokal vs. Cloud.

Ergebnis:

- `docs/wissen/INVENTAR.md`: Themenbaum mit allen Einträgen, je Eintrag Quelle und
  Status (geprüft / unklar / veraltet). Unklares wird Joyce gesammelt vorgelegt.
- Erste Fassung der Karten (Richtwert 150–300) im Format aus L3, plus ein Prüfsatz von
  ~60 realistischen Nutzerfragen mit erwarteter Karte (für L8).
- Abnahme durch Joyce in Blöcken (je Themenast), bevor Karten ausgeliefert werden.

### L3 Kartenformat, Ablage, Suche (2 Tage)

Format (Markdown mit Kopf), Ablage `services/desktop/resources/wissen/<ast>/<id>.md`,
wird mit der App ausgeliefert:

```markdown
---
id: dienst-verbinden
titel: Einen externen Dienst mit AVA verbinden
fragen:
  - verbinde dich mit CompLeadly
  - wie schließe ich ein Tool an
  - MCP Server hinzufügen
schlagworte: [dienst, verbindung, mcp, compleadly, close, token]
aktionen:
  - { art: app_oeffnen, ziel: einstellungen/dienste, label: "Dienst verbinden" }
  - { art: zugang_anfordern, label: "Zugang eingeben" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Lösung in 3–8 Sätzen, in Nutzersprache, mit dem, was AVA selbst tun kann.
```

- Index beim Start: Volltext mit BM25 über Titel (stark gewichtet), Fragen, Schlagworte,
  Lösungstext. Vektoren über Titel + Fragen lokal mit embeddinggemma, einmal je
  Kartenstand berechnet und zwischengespeichert. Ohne Ollama nur BM25.
- Gemeinsame Suche `suchen` (Entscheidung 2): liefert getrennt Wissen (Top 3 Karten,
  vollständig) und Fähigkeiten (Top-Werkzeuge/Skills wie heute). `tool_search` und
  `skill_search` bleiben als Aliase.
- Gültigkeit je Kanal (`gilt_fuer`): Karten für die Desktop-Einstellungen erscheinen in
  Telegram mit dem Hinweis auf die Desktop-App.

### L4 Aktionen auf Karten (1 Tag)

- Karten-Aktionen werden als Knöpfe unter der Antwort gezeigt (gleiche Komponente wie
  „Nächster Schritt“). Arten: `app_oeffnen`, `zugang_anfordern`, `vorlage_anlegen`,
  `chat_vorschlag`.
- Das Modell kann eine Aktion auch selbst auslösen, wenn der Nutzer es verlangt hat
  („verbinde dich mit CompLeadly“ öffnet direkt die Zugangskarte für CompLeadly).

### L5 Prompt-Diät (1–2 Tage, nach L2/L3)

- Alle in L0 als Wissen markierten Prompt-Abschnitte werden zu Karten und verlassen den
  Prompt. Im Prompt bleiben Rolle, Ton, Sicherheitsregeln, Ausgabeformate, die
  Such-Regel.
- Ziel: Grundsockel deutlich unter die Hälfte (konkrete Zahl nach L0 festlegen).
- Prüfung mit dem Satz aus L2: Trefferquote darf nicht sinken.

### L6 Sichere Zugangskarte (2 Tage)

- Werkzeug `zugang_anfordern(dienst, art?)` zeigt im Chat eine Eingabekarte. Arten:
  API-Schlüssel / Bearer-Token, frei benannter Header (Name + Wert), Benutzername +
  Passwort (Basic), OAuth 2.0 Client Credentials (Client-ID, Client-Secret, Scopes,
  Token-Adresse), OAuth 2.0 mit Anmeldung im Fenster (→ L7).
- Für vorbereitete Dienste (Close, CompLeadly) ist die Art vorbelegt; sonst fragt die
  Karte zuerst die Adresse und erkennt per Abfrage, was der Server verlangt.
- Werte gehen per IPC direkt in den verschlüsselten Speicher (wie heute die Dienste in
  den Einstellungen), nie in Verlauf, Log, Gateway oder Modell. Das Modell erhält nur
  „verbunden, N Funktionen verfügbar“ oder eine verständliche Fehlermeldung.
- Fehlt eine Angabe oder ist der Zugang falsch, bleibt die Karte offen mit Hinweis.
- Telegram/PWA: keine Eingabe dort, Verweis auf die Desktop-App (Karte `gilt_fuer`).

### L7 Allgemeine Anmeldung per OAuth (2–3 Tage, ersetzt C6 aus dem Close-Plan)

- MCP-Client nutzt die OAuth-Unterstützung des SDK: Server-Metadaten abfragen,
  Anmeldedienst ermitteln, dynamisch registrieren, Anmeldung im Systembrowser mit
  Rücksprung über `ava://` (wie die vorhandenen Anmeldungen), Token und Refresh im
  verschlüsselten Speicher, Erneuerung automatisch.
- Ohne dynamische Registrierung: Zugangskarte fragt Client-ID/Secret ab.
- Abgelaufene Zugänge laufen über die vorhandene Ablauf-Anzeige; AVA bietet „neu
  anmelden“ als Knopf an.
- Test mit Close (unterstützt dynamische Registrierung) und einem zweiten öffentlichen
  MCP-Server.

### L8 Prüfung und Pflege (laufend)

- Prüfsatz aus L2 als Skript: Frage → erwartete Karte unter den Top 3. Läuft im Build
  wie `test-suggestions.mjs`; Mindestquote 90 %.
- Jede neue Funktion braucht eine Karte (Ergänzung der Self-Service-Regel). Der Build
  warnt, wenn ein neues Werkzeug keiner Karte oder Fähigkeitsgruppe zugeordnet ist.
- Später optional: Karten zentral aus dem Gateway nachladen, um ohne Release zu
  korrigieren.

## 4. Reihenfolge und Aufwand

| Schritt | Inhalt | Aufwand | Abhängig von |
|---|---|---|---|
| L0 | Token-Messung | 0,5 Tag | – |
| L1 | Ton, Anzeige, `app_oeffnen` | 1 Tag | – |
| L2 | Wissenserfassung (eigene Session) | 3–5 Tage | – |
| L3 | Format, Index, gemeinsame Suche | 2 Tage | Format kann parallel zu L2 |
| L4 | Aktionen auf Karten | 1 Tag | L1, L3 |
| L5 | Prompt-Diät | 1–2 Tage | L0, L2, L3 |
| L6 | Zugangskarte | 2 Tage | – |
| L7 | OAuth allgemein | 2–3 Tage | L6 |
| L8 | Prüfsatz, Pflege | laufend | L2 |

L0 und L1 bringen Patrick sofort etwas. L2 ist der größte Brocken und läuft als eigene
Session; L3 kann parallel das Format festzurren, damit L2 direkt im Zielformat schreibt.

## 5. Offene Fragen

1. Schalter „Arbeitsschritte anzeigen“: für Betreiber an, für alle anderen aus — oder
   für alle aus?
2. Sprache der Karten: nur Deutsch, oder Englisch gleich mitpflegen?
3. Sollen Nutzer oder Organisationen eigene Karten anlegen können (eigenes Firmenwissen,
   Abläufe)? Würde das Format tragen, ist aber eigener Umfang.
4. Darf L2 anonymisierte Muster aus echten Chatverläufen nutzen, oder nur Supportfälle
   und Feedback?
