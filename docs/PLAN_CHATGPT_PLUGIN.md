# Plan: AVA im ChatGPT-Plugin-Verzeichnis (chatgpt.com/plugins)

Stand 2026-11-20 · Anlass: Frage von Joyce, ob und wie AVA unter chatgpt.com/plugins gelistet
werden kann; Anstoß war das Notion-Plugin mit eigener Oberfläche im Chat.

## 0. Ergebnis in drei Sätzen

AVA spricht schon heute mit ChatGPT (MCP unter mcp.ava.bi, OAuth über Keycloak, Entwicklermodus
oder Admin-Connector), ist aber nicht für die öffentliche Listung vorbereitet. Es fehlen
hauptsächlich eine feste, sauber gekennzeichnete Werkzeugmenge, schlanke Antworten ohne
überflüssige Personendaten, ein Demo-Konto für die Prüfer und die Formalien bei OpenAI
(Verifizierung, Domain, Datenschutz). Eigene Oberflächen im Chat (MCP Apps, wie bei Notion) sind
optional und kommen als eigene Stufe nach der Grundlistung.

## 1. Befund

### 1.1 Was OpenAI verlangt (Doku, Stand November 2026)

- **Verzeichnis:** seit 9. Juli 2026 ersetzt das Plugin-Verzeichnis das App-Verzeichnis. Ein
  Plugin ist ein ZIP mit Manifest (`plugin.json`), optional Skills (`skills/*/SKILL.md`) und
  höchstens **einem** öffentlichen MCP-Server (`mcp.json`).
- **Konto:** Organisation als Firma verifiziert (eproX GmbH), Rolle „Apps Management Write“,
  Projekt mit **globaler** Datenresidenz (EU-Residenz darf keine MCP-Plugins einreichen),
  Domain-Bestätigung per Klartext-Token auf dem MCP-Host oder einer Elterndomain.
- **Server:** öffentlich per HTTPS, kein Test- oder Platzhalter-Endpunkt; der Ursprung
  (Schema, Host, Port) darf sich nach der Einreichung nie ändern, der Pfad schon.
- **Auth:** OAuth 2.1 mit PKCE `S256`; ChatGPT schickt `resource` mit, der Server soll Tokens
  ohne passende Zielgruppe (`aud`) abweisen. CIMD bevorzugt, DCR erlaubt. mTLS nur optional.
  Kein API-Key- oder Bearer-Header-Verfahren.
- **Annotationen:** `readOnlyHint`, `destructiveHint`, `openWorldHint` an jedem Werkzeug,
  passend zum echten Verhalten; Abweichung ist ein häufiger Ablehnungsgrund.
- **Daten:** nur zurückgeben, was die Anfrage braucht; keine internen IDs, Zeitstempel,
  Protokolle; Personendaten nur, wenn verlangt; nie Tokens oder Schlüssel. Die
  Datenschutzerklärung muss jede Art personenbezogener Daten nennen, die zurückkommt.
- **Prüfung:** Demo-Konto ohne MFA, Mail-Code oder Magic Link, mit Beispieldaten; fünf positive
  und drei negative Testfälle mit erwarteter Antwort; Demo-Video; Name und Kurzbeschreibung je
  höchstens 30 Zeichen, Langtext bis 4.000; Logo; HTTPS-Adressen für Website, Support,
  Datenschutz, AGB; Länder-Freigabeliste.
- **Betrieb:** OpenAI scannt die Werkzeuge täglich; neue oder geänderte Werkzeuge gehen erst
  nach bestandener Prüfung live; bricht ein Deploy die gelistete Schnittstelle, zurückrollen.
  Instabile oder inaktive Plugins werden entfernt.
- **Oberflächen (MCP Apps):** Ressourcen `ui://…` mit Typ `text/html;profile=mcp-app`, am
  Werkzeug `_meta.ui.resourceUri`; Darstellung inline, Vollbild oder Bild-im-Bild; Brücke über
  `ui/*`-Nachrichten (Werkzeug aufrufen, Folgenachricht, Modell-Kontext); Sandbox-iframe,
  erlaubte Fremdadressen einzeln unter `_meta.ui.csp`. Offener Standard, läuft auch außerhalb
  von ChatGPT.

### 1.2 Was AVA schon hat

- `services/db-gateway/src/routes/mcp.ts`: 13 Gateway-Werkzeuge (`ava_kontext`, `firma_suchen`,
  `firma_lesen`, `firma_kontakte`, `meine_firmen`, `meldungen`, `firmen_ereignisse`,
  `protokoll_ablegen`, `import_anlegen`, `recherche_anstossen`, `neu_verarbeiten`,
  `auftrag_status`, `auftraege`) plus die Werkzeuge der laufenden AVA über das Kopf-Relais.
- `routes/mcp-oauth.ts`: Resource- und AS-Metadata (RFC 9728/8414), DCR mit Redirect-Liste
  (enthält `chatgpt.com`), PKCE `S256`, öffentlicher Client.
- Org-Schalter `mcp` (Standard aus), `mcp.lesen`, `mcp.auftraege`, `mcp.kontakte` (Standard
  aus), `mcp.kopf`, `mcp.copilot` (feste kleine Menge für Copilot, Vorbild für diesen Plan).
- Server-Anweisungen und `ava_kontext` erklären dem Modell AVA.

### 1.3 Lücken

1. **Werkzeugliste schwankt.** Sie hängt von Org-Schaltern und davon ab, ob die Desktop-AVA des
   Nutzers gerade läuft (Relais). Die Prüfung vergleicht täglich mit der eingereichten Liste.
2. **`destructiveHint` fehlt.** Nach MCP-Standard gilt ein Werkzeug mit `readOnlyHint: false`
   ohne Angabe als zerstörerisch (`annotationen()` in mcp.ts).
3. **`openWorldHint` ist überall `false`**, obwohl `recherche_anstossen` ins offene Web geht.
4. **Antworten sind nicht auf Datensparsamkeit geprüft.** Nur `content` als Text, kein
   `structuredContent`; Felder wie `transactionId`, Zeitstempel, Quellen-IDs ungesichtet.
5. **Zielgruppe des Tokens** wird nicht ausdrücklich gegen `resource` geprüft.
6. **Rechnerseitige Arbeit:** Import-Verarbeitung und Recherche laufen erst, wenn AVA beim
   Nutzer läuft (Rechen-Lokalität). Prüfer haben keine AVA; Testfälle dürfen davon nicht
   abhängen.
7. **Formalien fehlen:** OpenAI-Verifizierung, Demo-Tenant, Texte, Datenschutz-Abschnitt.

## 2. Zielbild

- Im Verzeichnis steht **„AVA“** (Kategorie Vertrieb/Produktivität) für DE, AT, CH. Wer ein
  AVA-Konto hat, verbindet es mit einem Klick und fragt in ChatGPT nach seinen Firmen,
  Meldungen und Personalwechseln, legt Notizen ab und stößt Importe an.
- Das Plugin bringt zwei **Skills** mit, die AVAs Arbeitsweise in ChatGPT tragen:
  Erstansprache (gleiche Regeln wie im Desktop) und Personalwechsel.
- Zweite Stufe: **eigene Oberflächen** im Chat – Firmensteckbrief, Mail-Entwurf zum
  Bearbeiten und Öffnen, Zeitachse mit Personalwechseln; später Power Map im Vollbild.
- Für Nutzer ohne Konto: klarer Hinweis „AVA-Konto nötig“ mit Weg zu ava.bi.

## 3. Technik

### 3.1 Eigener Pfad mit fester Werkzeugmenge

- `https://mcp.ava.bi/chatgpt` (Host bleibt für immer; nur der Pfad gehört dem Plugin).
  Resource-Metadata je Pfad (`/.well-known/oauth-protected-resource/chatgpt`).
- Werkzeugmenge `plugin` analog `mcp.copilot`, **ohne Kopf-Relais**, unabhängig von
  `mcp.kopf`: `ava_kontext`, `firma_suchen`, `firma_lesen`, `meine_firmen`, `meldungen`,
  `firmen_ereignisse`, `protokoll_ablegen`, `import_anlegen`, `neu_verarbeiten`,
  `auftrag_status`, `auftraege`; `firma_kontakte` nur bei `mcp.kontakte`. Ohne
  `recherche_anstossen` (braucht die laufende App, Deep Research einen eigenen Schlüssel).
  `neu_verarbeiten` bleibt drin, weil `firma_lesen` bei unvollständiger Aufbereitung darauf
  verweist (Verarbeitung unsichtbar).
- Werkzeugbeschreibungen der Plugin-Menge auf Englisch (Prüfer, Scan), Antworten weiter in
  der Sprache des Nutzers.
- Schnappschuss-Test: `scripts/check-plugin-werkzeuge.mjs` vergleicht Namen, Schemas und
  Annotationen mit `plugin/werkzeuge.snapshot.json`; Abweichung = bewusste neue Version mit
  Release-Notiz, sonst Build-Fehler. So bricht kein Gateway-Deploy die gelistete Schnittstelle.

### 3.2 Annotationen (gilt auch für `/mcp`)

| Werkzeug | readOnly | destructive | openWorld | Begründung |
|---|---|---|---|---|
| Lesende (`ava_kontext`, `firma_*`, `meine_firmen`, `meldungen`, `firmen_ereignisse`, `auftrag_status`, `auftraege`) | ja | – | nein | nur eigenes Konto |
| `protokoll_ablegen` | nein | nein | nein | Notiz, in AVA löschbar |
| `import_anlegen` | nein | nein | **ja** | zählt gegen Kontingent, aber umkehrbar (Firma entfernen); Aufbereitung ruft Websites und Register ab |
| `neu_verarbeiten` | nein | nein | **ja** | ruft Website und Register ab |
| `recherche_anstossen` (nur `/mcp`) | nein | nein | **ja** | Web-Recherche |

### 3.3 Schlanke Antworten

- Je Werkzeug eine Feldliste „bleibt / fällt weg“ in `lib/mcp-antwort.ts`; keine
  `transactionId` außer in `import_anlegen`/`auftrag_status` (für den Folgeaufruf nötig),
  keine Rohzeitstempel (Datum genügt), keine Quellen-IDs, keine Actor-/Tenant-IDs.
- `companyId` bleibt (Register-Kennung, für Folgeaufrufe nötig; Begründung im Formular).
- Personendaten (Namen, Mails, Profile) nur aus `firma_kontakte` und `firmen_ereignisse`,
  beide beschreiben „nur auf ausdrückliche Frage“.
- Zusätzlich `structuredContent` (für die Oberflächen in C6), Text bleibt für Clients ohne.

### 3.4 OAuth

- `aud`-Prüfung: Token muss die Resource des Pfads tragen (Keycloak-Mapper „audience“ aus
  `resource`, oder Client-Scope je Resource); `/mcp` bleibt rückwärtskompatibel.
- RFC 9207 (`iss` in der Antwort) prüfen: dann nutzt ChatGPT die feste Rücksprungadresse
  `https://chatgpt.com/connector_platform_oauth_redirect`.
- CIMD (`client_id_metadata_document_supported`) optional nach der Grundlistung.
- Domain-Token als Route `GET /<challenge-pfad>` mit Fly-Secret, nur Klartext.

### 3.5 Oberflächen (MCP Apps)

- Kleines Paket `packages/ava-mcp-ui` (Vite + React, gleiche Gestaltung wie app.ava.bi,
  hell/dunkel nach Host), Ausgabe je Oberfläche eine HTML-Datei mit eingebettetem JS/CSS.
  Das Gateway liefert sie als Ressource `ui://ava/<name>-v<n>.html` (Versionsnummer im Namen,
  damit gecachte Fassungen nicht brechen).
- Eigene Render-Werkzeuge mit `_meta.ui.resourceUri` (Daten-Werkzeuge bleiben ohne):
  `firma_anzeigen` (Steckbrief inline), `mail_entwurf_anzeigen` (bearbeiten, „In Mail öffnen“
  per `mailto:`, Vollbild möglich), `personalwechsel_anzeigen` (Liste/Karussell).
- CSP leer bis auf ava.bi für Logos; keine Fremdskripte, keine verschachtelten Frames.
- Gleiche Oberflächen laufen in Claude und anderen MCP-Apps-Clients über `/mcp`.

## 4. Stufen

| Stufe | Inhalt | Wer / Aufwand |
|---|---|---|
| **C0** | OpenAI-Organisation als eproX GmbH verifizieren, Rolle vergeben, Projekt mit globaler Residenz; Datenschutz und AGB um ChatGPT-Abschnitt ergänzen (rechtliche Prüfung); Support-Seite per HTTPS | Joyce, extern; Wartezeit |
| **C1** | Pfad `/chatgpt`, Werkzeugmenge `plugin`, Annotationen für alle Werkzeuge, englische Beschreibungen, Schnappschuss-Test | 1 Tag |
| **C2** | Antworten entschlacken (Feldlisten, `structuredContent`), Tests je Werkzeug | 1–2 Tage |
| **C3** | OAuth: `aud`-Prüfung, RFC 9207, Domain-Token; kompletter Durchlauf im ChatGPT-Entwicklermodus gegen `/chatgpt` | 0,5–1 Tag |
| **C4** | Demo-Tenant (10 verarbeitete Beispielfirmen aus öffentlichen Registerdaten, Demo-Nutzer ohne MFA und ohne Pflichtaktionen, Schalter an); 5+3 Testfälle; Plugin-ZIP mit `plugin.json`, `mcp.json`, Logo, zwei Skills; Texte; Demo-Video | 1 Tag + Video |
| **C5** | Einreichen, Rückmeldungen einarbeiten, freigeben; Lösungskarte „AVA in ChatGPT nutzen“ | Wartezeit + 0,5 Tag |
| **C6** | Oberflächen: `ava-mcp-ui`, drei Render-Werkzeuge, CSP, Prüfung in ChatGPT und Claude, neue Plugin-Version | 3–5 Tage |
| **C7** | (später) Power Map im Vollbild, Zeitachse interaktiv, CIMD | offen |

Reihenfolge: C0 sofort anstoßen (Wartezeiten), parallel C1 → C2 → C3 → C4 → C5; C6 nach
erfolgreicher Grundlistung als neue Version. Abnahme C5: Plugin im Verzeichnis sichtbar,
alle acht Testfälle bestehen im Demo-Konto. Abnahme C6: drei Oberflächen laden ohne Fehler in
ChatGPT (Web und Desktop) und Claude, hell und dunkel.

## 5. Entscheidungen (Empfehlung zuerst)

1. **Eigener Pfad `/chatgpt` mit fester Menge.** Hält die gelistete Schnittstelle stabil und
   lässt `/mcp` (Claude, Copilot, Entwicklermodus) frei weiterentwickeln. Alternative: `/mcp`
   mit Client-Erkennung (eine Adresse, aber jede Änderung dort wird prüfpflichtig).
2. **Ohne Kopf-Relais.** Prüfer haben keine laufende AVA, die Liste muss fest sein.
   Alternative: Relais-Werkzeuge mitlisten (mehr Können, sicher abgelehnt oder instabil).
3. **Org-Hauptschalter `mcp` bleibt Pflicht**, mit klarer Meldung, wer ihn wo einschaltet.
   Passt zur Enterprise-Freigabe. Alternative: für das Plugin standardmäßig an (weniger
   Reibung, aber Org-Admins verlieren die Vorab-Kontrolle).
4. **Nur für AVA-Kunden**, Verweis auf ava.bi zur Registrierung. Alternative: Testzugang direkt
   aus ChatGPT heraus (braucht die Start-Analyse aus dem Onboarding-Plan, viel größer).
5. **Länder DE, AT, CH.** Alternative: zusätzlich UK (Daten vorhanden, aber Texte und Support
   nur deutsch).
6. **Englische Werkzeugbeschreibungen** in der Plugin-Menge. Alternative: deutsch wie heute
   (Risiko bei Prüfung und Scan).
7. **Zwei Skills im Paket** (Erstansprache, Personalwechsel). Alternative: nur MCP (ChatGPT
   schreibt dann generisch, genau Patricks altes Problem).
8. **Oberflächen erst nach der Grundlistung**, beginnend mit Steckbrief und Mail-Entwurf.
   Alternative: gleich mit einreichen (eindrucksvoller, aber mehr Ablehnungsgründe auf einmal).

## 6. Risiken

- **Datenschutz:** Kontaktdaten fließen an OpenAI, sobald ein Nutzer verbindet; mit Listung
  bewirbt eproX diesen Weg aktiv. Rechtliche Prüfung in C0, `mcp.kontakte` bleibt aus, bis die
  Org es einschaltet.
- **Ablehnung wegen Personendaten oder Annotationen:** durch C2 und Tabelle 3.2 abgefedert;
  Einspruch per Antwort-Mail möglich.
- **Verfügbarkeit:** Gateway-Ausfälle (z. B. Datenbank-Engpässe) können zur Entfernung führen.
  Health-Check auf `/chatgpt` in die bestehende Überwachung.
- **Prüfpflichtige Deploys:** jede Änderung an der Plugin-Menge wartet auf OpenAI. Der
  Schnappschuss-Test macht das sichtbar, bevor es live geht.
- **Enttäuschte Nutzer ohne Desktop:** Importe laufen erst mit AVA auf dem Rechner. Die
  Antwort von `import_anlegen` sagt das klar, Listungstext ebenso.
- **Schnell wechselnde Doku:** Plugins gibt es erst seit Juli 2026; vor C1 und vor C5 die
  Anforderungen erneut gegen developers.openai.com prüfen.

## 7. Stand

- 2026-11-20: Entwurf, wartet auf Abnahme.
- 2026-11-20: Abgenommen („Ja, so umsetzen“). C1–C4 gebaut, **nicht deployt**:
  * `lib/mcp-plugin.ts`: feste Menge (12 Werkzeuge, englisch, `title`), `ANNOTATIONEN` für alle
    Werkzeuge (auch `/mcp`: `destructiveHint` jetzt ausdrücklich, Import/Neuverarbeitung/
    Recherche `openWorldHint: true`), Sperr-Hinweise statt wechselnder Liste, schlanke Antworten
    (`saeubern`, Kontakte als Personenliste statt Rohfakten, Meine Firmen kompakt) plus
    `structuredContent`.
  * `routes/mcp.ts`: `POST /chatgpt` (mcp.ava.bi) und `/mcp/chatgpt` (Fly), ohne Kopf-Relais;
    `ava_kontext` im Plugin ohne eigene Mail-Adresse und vom Kopf nur Profil, ICP, Gemerktes,
    Skills.
  * C3: `pluginAuth` prüft `aud` = Plugin-Resource; Registrierung unter `/chatgpt/oauth/register`
    legt in Keycloak einen Audience-Mapper an. Domain-Token über `OPENAI_DOMAIN_CHALLENGE_PFAD`/
    `_TOKEN`. **Abweichung:** RFC 9207 geht nicht, weil der Issuer der Metadata das Gateway ist
    und Keycloak sein eigenes `iss` zurückgibt; ChatGPT nutzt dann die Rücksprungadresse mit
    Callback-ID (von `^https://chatgpt.com/` gedeckt).
  * C4: Paket `services/db-gateway/plugin-chatgpt/` (plugin.json, mcp.json, Logo, Skills
    erste-schritte/erstansprache/personalwechsel), `EINREICHUNG.md` (Demo-Konto, 5+3 Testfälle,
    Video-Ablauf, Begründungen, Datenschutz-Entwurf), `npm run plugin:zip`,
    `npm run test:mcp-plugin` (Schnappschuss `werkzeuge.snapshot.json`).
  * Offen: Gateway-Deploy, Demo-Tenant in Prod, Durchlauf im ChatGPT-Entwicklermodus (dabei
    `aud`-Prüfung mit echtem Keycloak-Token), C0 bei Joyce, Demo-Video, Einreichung.
