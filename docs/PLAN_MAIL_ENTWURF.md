# Mail-Entwürfe im eigenen Mail-Programm öffnen

Stand: 2026-10-10 · Entscheidung Operator: Stufe 1 und 2 umsetzen, automatische Wahl des Weges.

## 1. Ziel

Formuliert AVA eine Mail, die der Nutzer selbst verschickt (Outreach, Antwort, Angebotsbegleitung), steht unter dem
Entwurf ein Knopf. Er öffnet die Mail fertig im Mail-Programm des Nutzers: Empfänger, Betreff, Text und, wo möglich,
Anhänge. Der Nutzer drückt nur noch auf Senden. Ohne Mail-Programm öffnet sich Webmail im Browser.

## 2. Ausgangslage (2026-10-10)

- Entwürfe sind Markdown im Chat (Skill `outreach-draft-de`: **Empfänger**, **Betreff**, **Mail**), ohne Felder.
- AVAs Mail-Anbindung (IMAP/SMTP) ist AVAs eigenes Postfach, nicht das des Nutzers; Entwürfe legt sie nirgends an.
- `mailto:` wird im Chat (Desktop und App) als toter Text dargestellt; der Renderer-Weg `shell:openExternal` lässt
  nur http(s) zu.
- Anhänge kennt AVA als Chat-Uploads im `AttachmentStore` (Handles `att-…`, 7 Tage).

## 3. Die Wege und ihre Grenzen

| Weg | Felder | Anhänge | Verhalten |
|---|---|---|---|
| `mailto:` (RFC 6068) | an, cc, Betreff, Text (nur Klartext) | nein | jedes Mail-Programm, Handy; Signatur setzt das Programm |
| Webmail-Link | an, cc, Betreff, Text | nein | Gmail, Outlook im Web (Microsoft 365 und outlook.com); IONOS ohne dokumentierten Link |
| `.eml` mit `X-Unsent: 1` | alles | ja | Outlook öffnet einen bearbeitbaren Entwurf; Apple Mail und Thunderbird zeigen eine empfangene Mail („Erneut senden“ bzw. „Als neu bearbeiten“) |
| Entwurf im Postfach (IMAP APPEND, Ordner „Entwürfe“) | alles | ja | überall sichtbar; braucht Zugang zum Postfach des Nutzers (Stufe 3) |

## 4. Entscheidungen

- **E1 Format:** Der Entwurf ist ein eigener Block im Antworttext, wie Diagramme:
  ````
  ```mail-entwurf
  { "an": ["anna.muster@firma.de"], "cc": [], "betreff": "…", "text": "Sehr geehrte Frau Muster,\n\n…", "anhaenge": ["att-…"] }
  ```
  ````
  `text` ist Klartext mit Anrede und Grußformel (kein Markdown). `an` darf leer sein, wenn keine Adresse bekannt ist.
  `anhaenge` nennt nur Chat-Uploads (Handle), die der Nutzer mitschicken will. Geprüft wird mit yup
  (`shared/mail-entwurf.ts`), im Renderer und noch einmal im Hauptprozess.
- **E2 Automatische Wahl (Desktop):** AVA fragt das Standardprogramm für Mail-Links ab
  (`app.getApplicationInfoForProtocol("mailto:")`).
  - Outlook → immer `.eml` (mit Anhängen, als Entwurf geöffnet; macOS `open -a`, Windows `outlook.exe /eml`).
  - anderes Programm → `mailto:`; hat der Entwurf Anhänge, zusätzlich „Mit Anhängen als Datei öffnen“ und
    „Anhänge im Ordner zeigen“ (zum Hineinziehen).
  - kein Programm → Auswahl Gmail / Outlook im Web.
- **E3 Einstellung** „Mail-Entwürfe öffnen in“: automatisch (Standard) · Mail-Programm · Outlook-Datei (.eml) · Gmail ·
  Outlook im Web · outlook.com. Desktop: `userData/mail-entwurf.json`, im Chat über `settings_mail_entwurf`.
  App: je Gerät im Browser gemerkt.
- **E4 App (app.ava.bi):** Der Browser kennt das Standardprogramm nicht. Standard ist `mailto:` (öffnet am Handy die
  Mail-App), dazu Gmail, Outlook im Web und „Als Outlook-Entwurf (.eml)“. Die `.eml` baut die AVA
  (App-Anfrage `mail_eml`, mit Anhängen bis 4,5 MB wegen der Relais-Grenze) und die App lädt sie herunter.
- **E5 Andere Kanäle:** Telegram bekommt den Entwurf als lesbaren Text (An, Betreff, Text). Der Sprachmodus liest
  keinen Block vor, sondern sagt, an wen der Entwurf geht.

## 5. Stufen

- **Stufe 1 (umgesetzt v0.1.805):** Block + Karte (Desktop und App), `mailto:`, Webmail, Kopieren, Einstellung,
  Werkzeug, Prompt und Skill, Telegram/Sprache.
- **Stufe 2 (umgesetzt v0.1.805):** `.eml` mit Anhängen, automatische Wahl bei Outlook, „Anhänge im Ordner zeigen“,
  App-Anfrage `mail_eml`.
- **Stufe 3 (offen):** Entwurf direkt im Postfach des Nutzers: zweite Postfach-Verbindung „nur für Entwürfe“ (IMAP
  APPEND mit `\Draft` in den Entwürfe-Ordner; IONOS, GMX, Strato, Gmail mit App-Passwort), später Anmeldung über
  Microsoft (Graph) und Google (Gmail-API) für Microsoft 365 und Google Workspace.

## 6. Zu testen (echte Programme)

- Outlook classic (Windows) und Outlook für Mac: `.eml` mit `X-Unsent` öffnet als Entwurf, Anhänge dabei, Signatur?
- Neues Outlook für Windows: Wird `mailto:` an „Outlook (new)“ gemeldet, und wertet es `X-Unsent` aus? Sonst auf
  `mailto:` zurückfallen (Einstellung).
- Apple Mail, Thunderbird: `mailto:` mit Umlauten und langen Texten.
- iPhone/Android aus der App: `mailto:` öffnet die Standard-Mail-App.

## 7. Offen

- Feste Anhänge (Firmenprofil-PDF, Referenzen) einmal in AVA hinterlegen, statt sie je Chat hochzuladen.
- Stufe 3.
