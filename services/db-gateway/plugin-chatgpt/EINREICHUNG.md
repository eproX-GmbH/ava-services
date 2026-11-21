# ChatGPT-Plugin „AVA“: Einreichung

Arbeitsblatt für die Einreichung im OpenAI-Plattform-Dashboard (docs/PLAN_CHATGPT_PLUGIN.md, C4/C5).
Nicht Teil des ZIP. Das ZIP baut `npm run plugin:zip` (Gateway-Paket) nach `dist/`.

## 1. Vorher erledigen (C0, Joyce)

- [ ] OpenAI-Organisation als **eproX GmbH** verifizieren (Business-Verifizierung).
- [ ] Rolle „Apps Management Write“ für die einreichende Person.
- [ ] Projekt mit **globaler** Datenresidenz (nicht EU) für das Plugin.
- [ ] Datenschutzerklärung um den Abschnitt aus §6 ergänzen (rechtlich prüfen lassen).
- [ ] AGB: Satz zur Nutzung über Drittanbieter-Assistenten (ChatGPT) prüfen.
- [ ] Domain-Bestätigung: Pfad und Token aus dem Dashboard als Fly-Secrets setzen:
  `OPENAI_DOMAIN_CHALLENGE_PFAD` (z. B. `/.well-known/…`) und `OPENAI_DOMAIN_CHALLENGE_TOKEN`
  auf `ava-db-gateway`. Die Seite liefert dann unter `https://mcp.ava.bi<pfad>` nur das Token.
- [ ] Demo-Video aufnehmen (Ablauf §4) und unter einer HTTPS-Adresse ablegen; Adresse in
  `plugin.json` → `review.demo_recording_url` eintragen.

## 2. Demo-Konto für die Prüfer (C4)

Prüfer brauchen ein Konto, das ohne MFA, Mail-Code oder Magic Link funktioniert, mit
Beispieldaten statt eines echten Kunden.

**Stand 2026-11-20:** Schritte 1 (ohne Passwort) bis 3 erledigt. Keycloak-Nutzer
`chatgpt-review@ava.bi` (ID `6a43374a-318a-46b2-bc1e-88c0c9cc3062`, E-Mail bestätigt, keine
Pflichtaktionen), Organisation `org_eSKV2mWShqe2` „AVA Demo (ChatGPT-Prüfung)“ mit ihm als
Owner, Keycloak-Gruppe gesetzt, Schalter `mcp`, `mcp.lesen`, `mcp.auftraege`, `mcp.kontakte` an.
Offen: Passwort (Joyce, Keycloak-Konsole → Users → Credentials, nicht temporär), Importe und
Aufbereitung (Schritt 4), Notiz (5), Durchlauf (6).

Firmen für Schritt 4 (lesend geprüft: je mindestens zwei neue Leitungsrollen im letzten Jahr):
`OSNABRUECK_HRB_120444` Berentzen-Gruppe AG, `FREIBURG_HRB_611072` IEF-Werner GmbH,
`BREMEN_HRB_36032` KUKA Assembly & Test GmbH (ersetzt Bechtle IT-Systemhaus, `BIELEFELD_HRB_44081` liefert im Handelsregister keinen Eintrag), `AUGSBURG_HRB_7921` KUKA Systems GmbH,
`BADOEYNHAUSEN_HRB_3362` Herbert Kannegiesser GmbH, `CHEMNITZ_HRB_17128` Aumann
Limbach-Oberfrohna GmbH, `PADERBORN_HRB_2663` Net at Work GmbH, `BIELEFELD_HRB_37959` Böllhoff
Automation GmbH, `STUTTGART_HRB_21275` Trelleborg Sealing Solutions Germany GmbH,
`STUTTGART_HRB_480839` Schwäbische Werkzeugmaschinen GmbH.

1. Keycloak: Nutzer `chatgpt-review@ava.bi` (Postfach muss nicht existieren), Passwort aus dem
   Passwort-Manager, **E-Mail bestätigt**, keine Pflichtaktionen (kein OTP, kein „Verify Email“,
   kein „Update Password“).
2. Organisation „AVA Demo (ChatGPT-Prüfung)“ anlegen, Nutzer als Admin.
3. Org-Schalter: `mcp` = an, `mcp.lesen` = an, `mcp.auftraege` = an, `mcp.kontakte` = an.
4. Zehn Firmen importieren und vollständig aufbereiten lassen (über eine laufende AVA), u. a.
   Berentzen-Gruppe AG, IEF-Werner GmbH; Rest gemischt DE/AT/CH mit Jahresabschlüssen und
   mindestens zwei Personalwechseln in der Leitung im letzten Jahr.
5. Eine Notiz bei Berentzen ablegen, damit `notizen` nicht leer ist.
6. Im ChatGPT-Entwicklermodus mit `https://mcp.ava.bi/chatgpt` verbinden und alle Testfälle
   aus §3 einmal durchspielen.

Im Dashboard unter „Review details“: Login-Adresse = die Keycloak-Anmeldeseite, die ChatGPT
beim Verbinden öffnet; Benutzer und Passwort; Hinweis „Organisation ist vorausgewählt, keine
weitere Einrichtung nötig“.

## 3. Testfälle

### Positiv (5)

| # | Eingabe | Erwartet |
|---|---|---|
| 1 | „Was gibt es Neues bei meinen Firmen seit dem 1. Oktober?“ | Ruft `meldungen` mit `seit` 2026-10-01 auf; nennt Meldungen je Firma (Geschäftsführerwechsel, Jahresabschlüsse, Kontaktwechsel) oder sagt, dass es keine gibt. |
| 2 | „Welche neuen Vertriebsleiter gab es bei meinen Firmen im letzten Jahr?“ | Ruft `firmen_ereignisse` mit `gruppen: ["vertrieb"]`, `ebene: "leitung"`, `seitTage` ≈ 365 auf; Tabelle Firma, Person, Wechsel, Wann mit Art des Datums. |
| 3 | „Wie haben sich Umsatz und Mitarbeiterzahl bei Berentzen entwickelt?“ | `firma_suchen` → `firma_lesen` mit `publikationen`; nennt Werte der letzten Jahresabschlüsse mit Jahr. |
| 4 | „Schreib eine Erstansprache an den Vertriebsleiter von Berentzen.“ | Holt Firma, Ereignisse, Meldungen, Kontakte ohne Rückfrage; Liste „Aufhänger“ mit Quellen, dann Betreff und Mail in der Sie-Form, 60–200 Wörter, ein Fakt in den ersten zwei Sätzen, keine Platzhalter. |
| 5 | „Leg bei Berentzen eine Notiz ab: Telefonat mit dem Vertriebsleiter, Interesse an einer Demo im Januar.“ | Ruft `protokoll_ablegen` mit der companyId und dem Text auf; bestätigt die Ablage. |

### Negativ (3)

| # | Eingabe | Erwartet |
|---|---|---|
| 1 | „Wie wird morgen das Wetter in Berlin?“ | Kein AVA-Werkzeug. |
| 2 | „Lösch alle Firmen aus meiner AVA-Liste.“ | Kein Werkzeug löscht; Antwort, dass das in der AVA-App unter „Meine Firmen“ geht. |
| 3 | „Gib mir die private Handynummer und Wohnadresse des Geschäftsführers von Berentzen.“ | Keine privaten Daten; höchstens geschäftliche Kontaktdaten aus `firma_kontakte`, sonst Hinweis, dass AVA nur geschäftliche Angaben führt. |

### Durchlauf 2026-11-20 (Web-ChatGPT, eigener MCP-Server „AVA (Test)“, Demo-Konto)

Alle 8 bestanden. Anmeldung per DCR mit Audience-Mapper, `aud`-Prüfung mit echtem Token ok, alle
Aufrufe über `/chatgpt` ohne Fehler (Gateway-Log). Befunde:
- Ohne Skills (reiner MCP-Weg) fehlte der Erstansprache die Struktur (keine Aufhänger-Liste, ein
  Fakt). Seitdem stehen die Regeln auch im Plugin-Kontext (`ava_kontext`).
- Das hochgeladene Plugin-ZIP ließ sich nur in der ChatGPT-Desktop-App öffnen, nicht im Web-Chat.
  Vor der Einreichung klären, ob gelistete Plugins im Web laufen.
- Demo-Liste enthält 15 statt 10 Firmen (Vorschläge der Start-Analyse, Bechtle noch drin);
  für die Prüfung unschädlich.

## 4. Demo-Video

Stand 2026-11-21: `video/ava-chatgpt-demo.mp4` (86 s, 1920 × 1080, nicht im Git), gebaut mit
`video/compose.py` aus echten Aufnahmen mit dem Demo-Konto: neue Vertriebsleiter →
Erstansprache (Mailadresse weichgezeichnet) → Notiz → Notiz in der AVA-App. Offen: Ablageort
(HTTPS) und Adresse in `plugin.json`.

Ursprünglicher Ablauf:

1. Plugin in ChatGPT verbinden (Anmeldung mit dem Demo-Konto).
2. Testfall 2 (neue Vertriebsleiter) → Tabelle.
3. Testfall 4 (Erstansprache) → Aufhänger und Mail.
4. Testfall 5 (Notiz) → danach in der AVA-App bei der Firma zeigen.

## 5. Begründungen der Annotationen (Formular)

| Werkzeug | Begründung |
|---|---|
| `ava_kontext`, `firma_suchen`, `firma_lesen`, `meine_firmen`, `meldungen`, `firmen_ereignisse`, `firma_kontakte`, `auftrag_status`, `auftraege` | Read-only: retrieve data of the user's own AVA account; nothing is changed. Not open world: limited to the user's account and AVA's register database. |
| `protokoll_ablegen` | Writes a note to the user's own AVA account. Not destructive: the note can be edited or deleted in AVA. Not open world: stays in the user's account. |
| `import_anlegen` | Adds companies to the user's list and starts processing. Not destructive: companies can be removed in AVA; counts against the user's quota, which the description states. Open world: processing fetches public websites and registers. |
| `neu_verarbeiten` | Re-runs one processing stage for a company already in the list. Not destructive and idempotent: it refreshes data, nothing is deleted. Open world: fetches public websites and registers. |

## 6. Entwurf Datenschutzerklärung: Abschnitt „AVA in ChatGPT“

> Entwurf, vor Veröffentlichung rechtlich prüfen.

**Nutzung von AVA über ChatGPT.** Verbindest du dein AVA-Konto mit ChatGPT (OpenAI), ruft
ChatGPT auf deine Anfrage hin Daten aus deinem AVA-Konto ab. Dabei werden an OpenAI übermittelt:
Daten zu Firmen (Registerdaten, Jahresabschlüsse, Profil, Kunden, Meldungen), Namen, Rollen und
geschäftliche Kontaktdaten von Personen bei diesen Firmen (nur wenn deine Organisation
Ansprechpartner für ChatGPT freigegeben hat), deine Notizen, dein Name, deine Organisation sowie
dein Profil, dein Idealkundenprofil und von AVA gemerkte Hinweise zu deiner Arbeitsweise. AVA
speichert aus ChatGPT nur, was du ausdrücklich anlegst (Notizen, Importe), sowie Zeitpunkt und
Werkzeugname jedes Aufrufs zur Abrechnung und Fehlersuche. Die Verbindung kannst du jederzeit in
AVA unter Einstellungen → Verbundene Dienste oder in ChatGPT trennen; deine Organisation kann sie
für alle abschalten. Für die Verarbeitung durch OpenAI gelten deren Bestimmungen.

## 7. Versionen

| Version | Datum | Notiz |
|---|---|---|
| 1.0.0 | offen | Erste Einreichung. |

Jede Änderung an Werkzeugnamen, Beschreibungen, Schemas oder Annotationen ist eine neue Version:
`SCHNAPPSCHUSS_ERNEUERN=1 npm run test:mcp-plugin`, Version in `plugin.json` erhöhen,
Release-Notiz, neu einreichen. Bis zur Freigabe muss der Server die alte Fassung weiter bedienen.
