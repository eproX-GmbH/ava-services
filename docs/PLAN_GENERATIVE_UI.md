# Plan: Generative UI im Chat (json-render)

Stand 2026-11-09, Anstoß Joyce: „Generative UI – das brauchen wir unbedingt im Chat!“
Quelle: Vercel-Changelog „json-render and Chat SDK agents“, https://json-render.dev

## 1. Ziel

AVA antwortet im Chat nicht nur mit Text, Tabellen und Diagrammen, sondern mit
**bedienbaren Oberflächen**, die das Modell aus einem festen Baukasten zusammensetzt:
Firmenkarten, Kennzahl-Kacheln, Vergleiche, Listen mit Knöpfen, kleine Formulare.
Beispiele:

- „Zeig mir die drei heißesten Radar-Treffer“ → drei Firmenkarten mit Score, Grund,
  Knöpfen „Importieren“ / „Ignorieren“ / „Öffnen“.
- „Wie steht Müller GmbH finanziell da?“ → Kennzahl-Kacheln (Umsatz, Ergebnis,
  Mitarbeiter, Veränderung) plus Diagramm plus Knopf „Abschluss öffnen“.
- „Leg mir einen Workflow an“ → Formular mit Auswahlfeldern statt zehn Rückfragen.
- „Wer ist im Buying Center?“ → Personenkarten mit Rolle, Kontaktknopf, Notiz.

## 2. Was json-render ist

- **Prinzip:** Ein Katalog legt fest, welche Komponenten es gibt (Name, Props als
  zod-Schema, ob Kinder erlaubt sind) und welche Aktionen. `catalog.prompt()` erzeugt
  daraus den Systemprompt-Teil. Das Modell schreibt ein JSON-Spec
  (`{ root, elements: { id: { type, props, children } } }`), das gegen den Katalog
  geprüft und mit eigenen React-Komponenten gerendert wird. Nichts außerhalb des
  Katalogs kann erscheinen.
- **Zustand und Bindung:** `$state`, `$bindState` (Zwei-Wege-Bindung für Eingaben),
  `$item`/`$index` für Wiederholungen, Sichtbarkeitsbedingungen, Prüfregeln.
- **Aktionen:** Komponenten lösen benannte Ereignisse aus (`emit("press")`); die App
  liefert die Handler. Das Modell kann also nur auslösen, was wir anbieten.
- **Streaming:** Das Spec rendert schrittweise, während es ankommt.
- **Pakete:** `@json-render/core` (Katalog, Schema, Prompt), `@json-render/react`
  (Renderer, Provider, Hooks wie `useUIStream`, `useJsonRenderMessage`),
  `@json-render/chat` (Chat-SDK-Karten für Slack/Teams). Version 0.22.0
  (04.11.2026), Lizenz Apache-2.0. Noch 0.x: API kann sich ändern.
- **Modellunabhängig:** reines JSON nach Prompt, funktioniert mit OpenAI, Anthropic,
  Mistral, ChatGPT-Abo und Azure. Mit kleinen lokalen Modellen (qwen3:8b) ist die
  Spec-Qualität fraglich → dort ausschalten oder nur Minimalkatalog.

## 3. Ist-Stand in AVA

- Der Chat kennt schon eigene „Mini-Generative-UI“-Blöcke als Codezäune im Text:
  ` ```chart ` (Diagramme, Schema + harte Regeln in `prompts.ts`), ` ```buying-center `,
  ` ```mail-entwurf ` (mit Knopf), Kartenknöpfe der Lösungskarten. Platzhalter beim
  Streamen („Mail-Entwurf wird geschrieben…“) gibt es bereits (`Chat.tsx`,
  `chartFenceStateFuer`). Generative UI ist die Verallgemeinerung davon.
- **Desktop:** React **18.3**, zod **3.25** → `@json-render/react` verlangt React
  **^19.2.3**, `@json-render/core` zod **^4**. Das ist der technische Knackpunkt.
- **PWA (ava-app):** React 19.3 → direkt einsetzbar.
- **Telegram, MCP/A2A, Mail:** können keine Oberfläche zeigen → brauchen Text-Rückfall.
- Agent-Tools mit Schreibwirkung laufen über `confirmAction`; daran darf Generative
  UI nichts vorbeischleusen.

## 4. Konzept für AVA

1. **Format:** ein neuer Codezaun ` ```ui ` mit dem json-render-Spec, eingebettet in
   die normale Antwort (Text davor/danach bleibt). Gleiches Muster wie ` ```chart `,
   damit Verlauf, Speicherung (`memory.ts`), Kopieren und Telegram-Rückfall wie
   gewohnt funktionieren.
2. **AVA-Katalog** (eigene Komponenten im AVA-Design, nicht die 41 Standardteile):
   - `Firmenkarte` (nur `companyId`; Name, Ort, Status, Kennzahlen lädt die Karte
     **selbst** aus dem Gateway → keine erfundenen Zahlen), `Firmenliste`
   - `Kennzahl` (Wert + Veränderung; Werte nur aus Tool-Ergebnissen, Regel wie bei
     Diagrammen), `Diagramm` (bestehendes Chart-Schema wiederverwenden)
   - `Personenkarte` (über `personId`), `Meldung`/`Zeitleiste`
   - `Tabelle`, `Hinweis`, `Abschnitt`/`Raster` (Layout)
   - `Auswahl`, `Eingabe`, `Schalter`, `Formular` (für Rückfragen und Einstellungen)
   - `Knopf` mit festen Aktionen (unten)
3. **Aktionen (abschließende Liste, alles andere wird abgelehnt):**
   - `oeffnen` (App-Seite, z. B. Firma, Radar, Einstellungen)
   - `auftrag` (schickt einen Text als Nutzernachricht an AVA)
   - `werkzeug` (ruft ein Agent-Werkzeug mit Parametern auf; Schreib-Werkzeuge gehen
     **immer** durch `confirmAction`, wie im Chat)
   - `link` (öffnet eine https-Adresse extern, nur mit sichtbarer Zieladresse)
4. **Prüfung:** Spec gegen Katalog validieren (zod). Ungültig → Text-Rückfall plus
   ein unsichtbarer Korrekturversuch ans Modell (Fehlerliste zurück, einmal).
5. **Kanäle:** Desktop und PWA rendern; Telegram, MCP/A2A und Mails bekommen eine
   aus dem Spec erzeugte Textfassung (Titel, Werte, Links), nie rohes JSON.
6. **Gemeinsames Paket:** Katalog + Text-Rückfall in `packages/generative-ui` (zod 4,
   ohne React), Komponenten je Oberfläche (Desktop, PWA). Konsole braucht es nicht.

## 5. Technische Entscheidung (React 18 im Desktop)

- **A (Empfehlung): Desktop auf React 19 heben** und `@json-render/react` direkt
  nutzen. Aufwand für das Upgrade: Abhängigkeiten prüfen (react-query 5, react-router
  6, recharts u. a. sind React-19-fähig), Typen, StrictMode-Effekte, ein Testlauf
  aller Hauptseiten. Vorteil: Streaming, Bindung, Sichtbarkeit, Prüfregeln fertig;
  PWA und Desktop teilen dieselbe Logik.
- **B: Eigener Renderer** für das json-render-Spec-Format, Katalog trotzdem mit
  `@json-render/core` (Prompt + Validierung). Kein React-Upgrade, aber Bindung,
  Sichtbarkeit und Streaming selbst bauen; später schwer nachzuziehen.
- zod: der Katalog nutzt zod 4 im eigenen Paket; der übrige Desktop-Code bleibt bei
  zod 3 (Agent-Tools nutzen ohnehin yup).

## 6. Stufen

- **G0 Spike (1–2 Tage):** Zweig mit React 19 im Desktop, json-render minimal,
  ein ` ```ui `-Block mit Firmenkarte + Knopf im echten Chat; Messung mit
  GPT-6.1 Sol, Sonnet 5.5, ChatGPT-Abo, qwen3:8b.
- **G1 Katalog + Komponenten** (8–10 Teile aus §4.2) im AVA-Design, hell/dunkel,
  schmale Fenster; visuell im Browser-Fenster prüfen (echte styles.css, hell/dunkel).
- **G2 Prompt + Streaming:** Katalog-Prompt nur, wenn die Antwort davon profitiert
  (Werkzeug-Ergebnisse vorhanden), sonst nicht mitschicken (Kontext sparen);
  Platzhalter beim Schreiben; Verlauf speichern.
- **G3 Aktionen** inkl. `confirmAction`-Pfad und Protokoll.
- **G4 PWA** (gleicher Katalog, eigene Komponenten).
- **G5 Text-Rückfall** für Telegram, MCP/A2A, Mail.
- **G6 Lösungskarten + Prüfsatz**, Hinweise im Systemprompt, Schalter in den
  Einstellungen und Organisations-Vorgabe (Funktionen-Liste).

Grobe Schätzung: G0 1–2 Tage, G1–G3 4–6 Tage, G4–G6 3–4 Tage.

## 7. Offene Entscheidungen (Joyce)

1. Variante A (React 19 im Desktop) oder B (eigener Renderer)?
2. Erste Anwendungsfälle: welche drei zuerst? Vorschlag: Firmenkarten (Radar,
   Bestand), Finanz-Kennzahlen, Rückfrage-Formulare.
3. Lokale Modelle: Generative UI dort aus, oder Minimalkatalog?
4. Darf ein Knopf Schreib-Werkzeuge auslösen (immer mit Bestätigung), oder anfangs
   nur `oeffnen`/`auftrag`?
5. Soll die Organisation Generative UI abschalten können (Funktionen-Vorgabe)?
