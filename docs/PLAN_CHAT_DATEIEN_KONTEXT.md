# Plan: Dateien im Chat, Mail-Anhänge, Werkzeug-Kontext (2026-09-30)

Anlass: Test „Rechnung an Betzemeier“ (Chatverlauf vom 30.09.2026). Sachlich
brauchbar, aber praktisch gescheitert: Mail ohne Anhang, PDF nur als
Volltext im Kontext, 100.000 Tokens je Zug, Bevormundung beim Testfall.
Dazu die Frage, was die Anthropic-Anleitung „Writing tools for agents“ und
Googles AIP-157 (Partial responses) für uns bringen.

Gliederung: **D** Dateien im Chat, **M** Mail-Anhänge, **K** Werkzeug-Kontext
und Tokens, **V** Verhalten des Agenten. Reihenfolge der Umsetzung am Ende.

---

## Ist-Stand (geprüft im Code, v0.1.737)

| Bereich | Heute |
| --- | --- |
| Chat-Uploads | Nur .xlsx/.xls/.csv/.tsv/.pdf (`renderer/src/lib/attachment.ts`). Tabellen: Kopfzeile + 5 Beispielzeilen in den Prompt, Bytes im `AttachmentStore` (RAM, 30 Min, Handle `att-<uuid>`). PDF: **kompletter Text** in den Prompt (`__pdf_text__`), Bytes ebenfalls im Store. |
| Handle | Marker `[attachment: <Datei>, id: att-…, name: "…"]` im Nutzertext. Einziger Konsument: `import_excel`. |
| Mail senden | `mail_send`/`mail_reply`/`mail_forward` kennen keine Anhänge. Der SMTP-Client darunter kann sie längst (`smtp-client.ts`, `attachments[]`). Eingehende Anhänge werden gelesen (`mail/attachments.ts`), ausgehende nie geschrieben. |
| Verlauf | Jeder Zug sendet **alle** Nachrichten der Unterhaltung inklusive aller Werkzeugergebnisse 1:1 (`orchestrator.ts` Z. 1173, `ai-sdk-provider.ts` Z. 718). Keine Kürzung, keine Alterung, keine Zusammenfassung. |
| Werkzeugergebnisse | `JSON.stringify(result)` ohne Obergrenze. Fehler = Top-Level-`error`-String. |
| Werkzeuge | 271 registriert, seit v0.1.240 lazy geladen (Kern + `tool_search`/`tool_load`). Viele Werkzeuge geben die Gateway-Antwort roh weiter. |
| Prompt | Du-Form-Regel, „Handeln statt Nachfragen“, Prüfliste vor `ask_user_*`. Keine Regel zu Test- vs. Ernstfall, keine zu Pflichtangaben für Außentexte, keine zur Anrede Dritter. |

Messwerte aus dem Test: 97.366 und 104.626 Tokens für Züge mit
Drei-Satz-Antworten. Vergleich Kontakte-Werkzeug (v0.1.737): 788 KB → 8 KB
durch Projektion an der Quelle.

---

## D — Dateien im Chat: Handle statt Volltext

### D1 Einheitliches Datei-Handle für alle Uploads

Jeder Upload wird gestaged wie heute Tabellen: Bytes im Store, Handle
`att-…`. **Kein Volltext mehr im Prompt.** Der Marker trägt nur Metadaten:

```
[datei: haemovision-09-2026.pdf, id: att-3f9c…, typ: pdf, seiten: 24, groesse: 1,8 MB]
```

Zusätzlich eine **Kurzansicht** (deterministisch, ohne KI): bei PDF die
ersten 600 Zeichen der ersten Seite plus Gliederung, wenn das PDF eine hat;
bei Tabellen wie heute Kopfzeile + 5 Zeilen; bei Text/Markdown die ersten
600 Zeichen. Damit erkennt das Modell, worum es geht, ohne die Datei zu
lesen.

Store-Änderungen: Typen erweitern (pdf, txt, md, docx, Bilder, „sonstige“ =
nur Bytes), TTL von 30 Min auf **Dauer der Unterhaltung + 24 h**, Ablage
auf Platte statt RAM (userData/anhaenge/<convId>/), damit ein Neustart die
Handles nicht entwertet. Die Kurzansicht wird einmal beim Staging berechnet
und mitgespeichert.

### D2 Bedarfsgesteuertes Lesen (drei Werkzeuge)

Ergebnis der Recherche (Quellen unten): Das robuste, anbieterneutrale und
kostenfreie Muster ist **Handle + Lese-Werkzeuge mit Bereichsangabe**, so
wie Claude Code selbst Dateien liest (Read mit offset/limit, Grep). Alles
andere (Gist-Memory, Einbettungen, native Dateieingabe der Anbieter) ist
entweder teurer oder erst bei sehr großen Dokumenten sinnvoll.

| Werkzeug | Zweck | Antwort |
| --- | --- | --- |
| `datei_info(id)` | Metadaten + Gliederung/Seitenüberschriften + Kurzansicht | ≤ 1.500 Zeichen |
| `datei_lesen(id, seiten?: "3-5", zeichen?: {von, bis}, max?: 12000)` | Ausschnitt lesen | ≤ 12.000 Zeichen, Hinweis „gekürzt, weiter ab Seite/Position …“ |
| `datei_suchen(id, begriff | regex, umfeld?: 200)` | Fundstellen mit Seite + Umfeld | ≤ 20 Treffer |

Regel im Prompt: „Lies eine Datei nur, wenn die Aufgabe ihren Inhalt
braucht. Zum Weiterreichen (Mail, Import) reicht das Handle. Nutze erst
`datei_suchen`, dann `datei_lesen` für den Treffer.“

Text-Extraktion einmalig beim Staging (pdf-parse je Seite, docx über
mammoth, Bilder ohne Text; OCR bewusst nicht). Ergebnis als Seitenliste im
Store, damit `seiten` und `datei_suchen` ohne erneutes Parsen arbeiten.

**Stufen darüber, nur bei Bedarf (nicht in diesem Plan):**
- Gist-Memory: je Seite eine Kurzfassung mit dem lokalen Ollama-Modell,
  dann gezielt nachlesen. Kostet lokale Rechenzeit je Upload, lohnt ab
  ~50 Seiten.
- Lokale Einbettungen (Ollama embeddinggemma liegt im Bundle) für
  semantische Suche in großen Dokumenten.
- Native Dateieingabe der Anbieter (OpenAI `input_file`, Anthropic
  `document`): bequem, aber jede Seite geht als Text **und** Bild in jeden
  Zug. Nur für „lies das ganze Dokument bildlich“ sinnvoll, nie Standard.

### D3 Benannte Auswahl

Mehrere Uploads bekommen im Marker eine laufende Nummer und den
Dateinamen. Werkzeuge nehmen `dateien: string[]`, wobei jedes Element ein
Handle, ein Dateiname oder ein eindeutiger Namensteil sein darf. Der
Store löst auf (`aufloesen(convId, angabe)`), bei Mehrdeutigkeit kommt ein
Fehler mit den Kandidaten zurück (Muster „Fehler, die den nächsten Schritt
zeigen“). So kann der Nutzer „nur die drei Rechnungen, nicht die zwei
Bilder“ sagen und das Modell reicht die richtigen Handles weiter.

Ein Chip je Datei in der Nachricht (heute schon für Tabellen), Klick
öffnet die Datei. Uploads einer Unterhaltung erscheinen in einer kleinen
Leiste „Dateien in diesem Gespräch“, damit der Nutzer sieht, was das Modell
kennt.

---

## M — Mail-Anhänge

### M1 `mail_send`, `mail_reply`, `mail_forward` bekommen `anhaenge: string[]`

Handles oder Namen (D3). Das Werkzeug lädt die Bytes aus dem Store und
gibt sie dem SMTP-Client, der das schon kann. Grenzen: 20 MB je Mail
gesamt (SMTP-übliche Grenze), Fehler mit Dateiname und Größe, wenn
überschritten.

Sicherheitsgate bleibt: Allowlist-Empfänger autonom, sonst
`ask_user_choice`; in der Rückfrage stehen Empfänger, Betreff **und die
Anhangsnamen mit Größe**. Ausgehende Anhänge werden nie an Adressen aus
beobachteten Inhalten gesendet (bestehende Regel).

### M2 Weiterleitung mit Original-Anhängen

`mail_forward` bekommt zusätzlich `originalAnhaenge: true` und hängt die
Anhänge der weitergeleiteten Mail aus dem IMAP-Puffer an. Heute gehen sie
verloren.

### M3 Sent-Spiegelung

Die Roh-Mail mit Anhang wird wie bisher in „Gesendet“ gespiegelt
(`appendToSent`), nichts Neues nötig, nur prüfen, dass die Größe nicht am
IMAP-Limit scheitert.

---

## K — Werkzeug-Kontext und Tokens

Bewertung der beiden Quellen, bezogen auf unseren Stand:

**Anthropic, „Writing tools for agents“.** Von den sechs Empfehlungen haben
wir eine (lazy laden per `tool_search`/`tool_load`). Es fehlen: Obergrenze
für Werkzeugergebnisse (Claude Code: 25.000 Tokens), `response_format`
kompakt/detailliert (im Beispiel 72 statt 206 Tokens), sprechende Namen
statt IDs in Antworten, handlungsleitende Fehlermeldungen, und
Zusammenlegen ähnlicher Werkzeuge (wir haben 271). Der größte Hebel für uns
ist die Obergrenze plus Projektion, weil unsere Werkzeuge Gateway-Antworten
roh durchreichen.

**Google AIP-157.** Zwei Mechanismen: Feldmasken (feinkörnig, „welche
Felder“) und `view`-Enum (BASIC/FULL, Listen standardmäßig BASIC). Für ein
Sprachmodell ist die Feldmaske ungeeignet, es müsste unsere Feldnamen
kennen. Das `view`-Muster ist genau das, was Anthropic `response_format`
nennt, und AIP-157 gibt die Konvention dazu: **Listen und Standardaufrufe
kompakt, voll nur ausdrücklich; Felder dürfen einer Ansicht hinzukommen,
nie entfallen.** Wir übernehmen das als Regel für alle Werkzeuge. Umsetzung
zunächst in der Werkzeugschicht des Desktops (Projektion wie bei
`company_contacts`), nicht als Gateway-API; das Gateway kann `?view=`
später für Bandbreite nachziehen.

### K1 Obergrenze je Werkzeugergebnis

In `orchestrator.ts` nach `JSON.stringify(result)`: über 40.000 Zeichen
wird gekürzt, mit angehängtem Hinweis
`{"gekuerzt": true, "originalZeichen": N, "hinweis": "Ergebnis gekürzt. Frag gezielter (Filter, Seite, ansicht: 'kompakt')."}`.
Das ist die Notbremse; sie greift auch bei Werkzeugen, die K2 noch nicht
haben. Protokoll zeigt „gekürzt“ als Marker.

### K2 `ansicht: "kompakt" | "voll"` als Konvention

Neuer optionaler Parameter in `defineTool` (Standard kompakt), mit Helfer
`projektion(result, ansicht)`. Reihenfolge nach Größe der Antworten in
Prod-Prompts (PromptAudit-Auswertung als erster Schritt): erwartet
`company_structured_content`, `company_publications`, `company_website`,
`company_keywords`, `company_search`, `mail_get_message`,
`company_profile`. `company_contacts` ist das Muster (v0.1.737,
`mitBelegen` wird zu `ansicht: "voll"` umbenannt, alter Name bleibt als
Alias).

Kompakt heißt: Namen statt IDs, wo eine ID nötig ist beides („Strategic IT
GmbH (cmj49…)“), keine Belegketten, keine Zeitstempel je Feld, Listen auf
20–60 Einträge mit `anzahlGesamt` und Hinweis.

### K3 Werkzeugergebnisse altern

Beim Aufbau der Provider-Nachrichten: Werkzeugergebnisse, die älter als
**zwei Nutzerzüge** sind, werden durch
`{"ersetzt": "Ergebnis von <tool> (N Zeichen), nicht mehr im Kontext. Bei Bedarf erneut aufrufen."}`
ersetzt. Die gespeicherte Unterhaltung bleibt vollständig (Protokoll,
Replay), nur die Sendung an das Modell wird gekürzt. Das ist die
anbieterneutrale Variante von Anthropics `clear_tool_uses` (Beta, bricht
den Prompt-Cache) und wirkt bei OpenAI, Gemini, Ollama gleich. Ausnahme:
Ergebnisse von `datei_lesen` und Nutzer-Uploads altern nach vier Zügen.

Erwartung für den Testfall: statt 100.000 rund 15.000 Tokens je Folgezug.

### K4 Fehlermeldungen, die den nächsten Schritt nennen

Durchsicht der `error`-Strings der 30 meistgenutzten Werkzeuge: statt
„not found“ → „Firma cmj4… nicht in deinem Pool. Nutze company_search mit
dem Namen.“ Kein Stacktrace ins Modell.

### K5 Werkzeuge zusammenlegen (Vorschlag, eigener Plan)

271 Werkzeuge sind zu viele für `tool_search`-Treffsicherheit. Kandidaten:
die sieben `company_*`-Leser hinter ein `company_get(companyId, bereiche:
[...], ansicht)`, die Mail-Leser hinter `mail_get`. Nicht in diesem Plan,
aber K2 bereitet es vor.

---

## V — Verhalten des Agenten

### V1 Test- oder Ernstfall

Neue Prompt-Regel: „Sagt der Nutzer, dass es ein Test, ein Ausprobieren
oder eine Demo ist, dann: Pflichtangaben, die du nicht kennst, mit
erkennbaren Platzhaltern füllen (`[Rechnungsnummer]`, `TEST-2026-001`),
und das im Text als Test kennzeichnen. Weise Uploads nicht zurück, weil
ihr Inhalt nicht zum Anlass passt. Frage nur, wenn eine Angabe die Handlung
unumkehrbar falsch macht (falscher Empfänger, Betrag an Dritte).“ Ohne
Testsignal gilt V2.

Das Signal erkennt das Modell, nicht eine Heuristik (gleiche Linie wie
Telegram-Antwortform). Der Turn-Kontext bekommt kein Flag; die Regel
reicht.

### V2 Pflichtangaben für Außentexte erfragen

Regel: „Für Texte, die den Nutzer verlassen (Mail, Angebot, Rechnung),
gibt es Angaben, die du nicht wissen kannst: Rechnungsnummer, Betrag,
Fälligkeit, Bestellnummer, Ansprechpartner. Frage sie in **einer**
`ask_user_text`-Runde gebündelt ab, statt einen Upload zu verlangen.“
Ergänzt die Prüfliste vor `ask_user_*` um den Fall „nicht aus Daten
ableitbar“.

### V3 Anrede Dritter

Regel: „Die Du-Form gilt für den Nutzer. Für Texte an Dritte (Kunden,
Ämter) frag einmal je Empfänger nach Du oder Sie, wenn es keinen Hinweis im
Verlauf oder im CRM-Eintrag gibt; merke dir die Antwort in der
Unterhaltung.“ Später: Feld `anrede` am CRM-Kontakt.

### V4 Kein Werkzeug für reine Textaufgaben

Regel: „Überschriften, Vorlagen, Formulierungen: direkt schreiben, kein
Werkzeugaufruf, außer die Aufgabe braucht Daten aus dem Pool.“ Prüfung mit
den Turn-Urteil-Tests (Vorschläge-Kanal) auf zwei Beispielsätze.

### V5 E-Mail-Muster anbieten

Wenn nach einer Adresse gefragt wird, die nicht vorliegt (Rechnung,
Buchhaltung, Bewerbung), schlägt das Modell die Musterprüfung vor:
`email_pattern_check(companyId, lokalteile: ["rechnung", "buchhaltung",
"invoice"])`. Prüfen, ob das bestehende Muster-Werkzeug freie Lokalteile
erlaubt; sonst Parameter ergänzen. Verifizierte Adressen nie erneut prüfen
(bestehende Regel).

### V6 Werkzeugfehler im Protokoll sichtbar

Die Zeile „15 Schritte, 6 Werkzeuge, 1 Fehler“ zeigt beim Aufklappen den
Fehlertext des Werkzeugs (Vorschau `error: …` gibt es schon) und, wenn der
Fehler den Zug nicht beeinflusst hat, den Zusatz „vom Modell umgangen“. Im
Hauptprozess-Log eine Zeile `[agent] tool_error convo=… tool=… msg=…`,
damit Fehler auch ohne Renderer nachvollziehbar sind.

---

## Reihenfolge und Aufwand

| Schritt | Inhalt | Aufwand | Release |
| --- | --- | --- | --- |
| 1 | K1 Obergrenze + K3 Alterung + V6 Log-Zeile | 1 Tag | sofort, größter Kosteneffekt |
| 2 | V1, V2, V3, V4 Prompt-Regeln + Turn-Urteil-Tests | 0,5 Tag | mit 1 |
| 3 | D1 Handle für alle Typen, Ablage auf Platte, Kurzansicht | 1,5 Tage | |
| 4 | M1 Anhänge in mail_send/reply, D3 Auflösung nach Name, Rückfrage mit Anhangsliste | 1 Tag | Testfall erfüllt |
| 5 | D2 datei_info/lesen/suchen + Prompt-Regel | 1,5 Tage | |
| 6 | K2 `ansicht` für die sieben größten Werkzeuge (PromptAudit-Messung vorab) | 2 Tage | |
| 7 | M2 Weiterleitung mit Original-Anhängen, V5 Musterprüfung, K4 Fehlertexte | 1,5 Tage | |

Messung vor/nach: Tokens je Zug in der Verbrauchszeile (seit v0.1.736) und
`LlmUsage.inputTokens` je Unterhaltung im Gateway. Ziel: Folgezüge im
Testszenario unter 20.000 Tokens.

## Offene Entscheidungen

1. Ablage der Uploads auf Platte (userData) oder weiter RAM mit langem TTL?
   Vorschlag Platte, sonst gehen Handles beim Neustart verloren.
2. K3 Alterung nach zwei oder drei Nutzerzügen? Vorschlag zwei, bei
   Beschwerden hochsetzen.
3. K5 Zusammenlegen der Werkzeuge: eigener Plan oder Teil von K2?

## Quellen

- Anthropic, Writing tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- Google AIP-157 Partial responses: https://google.aip.dev/157
- Anthropic Context editing (clear_tool_uses, Beta): https://platform.claude.com/docs/en/build-with-claude/context-editing
- OpenAI File inputs / PDF (Text + Seitenbilder je Zug): https://developers.openai.com/api/docs/guides/pdf-files
- Gist Memory (Seiten-Kurzfassungen, gezieltes Nachlesen): https://inference-docs.cerebras.ai/cookbook/agents/gist-memory
- Document Agent (search / read sections / read pages / navigate tree): https://docs.trynia.ai/document-agent.md
