# Microsoft-Kunden: Anmeldung, Organisation, Azure OpenAI und Outlook-Entwürfe

Stand: 2026-11-11 · Status: Entscheidungen 1–3, 5–7 und 10 abgenommen (Joyce, 2026-11-11), 8 und 9 erklärt
und offen; nichts gebaut. Ersetzt den Entwurf
`PLAN_MICROSOFT_POSTFACH.md` (PM-2026-0047, Entwürfe in Outlook) und baut auf der Entra-Kopplung aus
`PLAN_COPILOT_MCP.md` (C2) auf.

## 1. Ziel

Eine Firma mit Microsoft 365 nutzt AVA so, wie sie andere Business-Software nutzt:

1. **Anmelden mit „Mit Microsoft anmelden“** in der Desktop-App, in der Web-App (app.ava.bi) und in der
   Konsole (admin.ava.bi). Kein eigenes AVA-Passwort.
2. **Organisation automatisch.** Wer sich mit einem Firmenkonto anmeldet, landet in der AVA-Organisation
   seiner Firma. Keine Auswahl, kein Wechsel, kein Verlassen.
3. **Chat läuft sofort über Azure OpenAI / Foundry der Firma.** Kein Schlüssel, keine Anbieterwahl, kein
   Einrichtungsassistent mit Modellauswahl. Hintergrundverarbeitung bleibt wie heute (Betreiber-Spur).
4. **Mail-Entwürfe landen im Outlook-Ordner „Entwürfe“**, mit Anhängen. AVA verschickt nichts.

## 2. Ausgangslage (Code-Stand 2026-11-11)

### 2.1 Anmeldung und Keycloak

- Keycloak **20.0.3** (`infra/keycloak/Dockerfile`), Realm `ava`, Konfiguration nur per Skript
  (`infra/scripts/keycloak-config.mjs`, `keycloak-web-client.mjs`). Version 20 ist seit Langem ohne
  Sicherheitsupdates.
- Desktop: Code-Flow mit PKCE, Anmeldung im **eingebetteten Electron-Fenster** (seit v0.1.539), Systembrowser
  nur als Rückfall (`main/auth.ts`). Kein `kc_idp_hint`. Anmeldeseite mit „Anmelden“ und „Konto erstellen“.
- Web-App und Konsole: `/auth/login?idp=…` reicht `kc_idp_hint` durch, sonst Keycloak-Standardseite.
- **Entra-Kopplung C2 (gebaut, nie live getestet):** je AVA-Organisation ein Identitätsanbieter
  `entra-<tenantId>` mit **Entra-App des Kunden** (Client-ID/Geheimnis in der Konsole, Seite „Anmeldung“),
  versteckt auf der Anmeldeseite, Mapper `tid` → Keycloak-Gruppe `tenant:<id>` → Claim `tenant_id`.
  Tabelle `TenantSso`. Das ist das Gegenteil eines allgemeinen Microsoft-Knopfs: Jede Firma müsste selbst
  eine App registrieren.

### 2.2 Organisationszuordnung

- Das Gateway nimmt die Organisation aus dem Claim `tenant_id` und prüft **nur, ob es eine Organisation
  ist, nicht ob der Nutzer Mitglied ist** (`middleware/auth.ts`). Ohne Claim entscheidet die Mitgliedschaft.
- Mitglied wird man über Anlegen, Einladung, Beitrittsanfrage oder Domain-Vorschlag (O11, braucht
  Freigabe). Sitzprüfung nur bei der Freigabe einer Anfrage.
- Befunde zu C2, die mit dem neuen Weg behoben werden müssen:
  - Ein entfernter Nutzer kommt beim nächsten Microsoft-Login über den Gruppen-Mapper wieder hinein.
  - Über den Mapper angelegte Mitglieder umgehen Sitzprüfung und Mitgliederlimit.
  - `TenantSso.entraTenantId` ist nicht eindeutig.
  - Deaktivieren schaltet den Identitätsanbieter nicht ab.
  - Konten werden per E-Mail verknüpft (`trustEmail`), Gäste im Kunden-Verzeichnis tragen dessen `tid`.

### 2.3 Azure OpenAI

- Organisation hinterlegt in der Konsole Endpunkt, Schlüssel und Modell→Deployment-Zuordnung
  (`TenantProvider`, `lib/azure-openai.ts`); erlaubt sind `*.openai.azure.com`,
  `*.cognitiveservices.azure.com`, `*.services.ai.azure.com`, immer die v1-API.
- Der Chat der Mitglieder läuft über den Gateway-Proxy zu Azure. Automatisch nur mit
  **Anbieter-Sperre plus Chat-Modell**; ohne das startet ein neues Mitglied auf Ollama und muss im
  Assistenten „Organisationsschlüssel verwenden“ wählen. Der Assistent erscheint immer.
- Nicht unterstützt: Anmeldung an Azure ohne Schlüssel (Entra), Foundry-Modelle außerhalb von OpenAI,
  Sprachmodus auf Azure, Diktat/Transkription über Deployment-Zuordnung, Test der Verbindung beim
  Speichern.
- Fehler: Bei einer Änderung der Vorgaben setzt `core/bootstrap.ts` (setOrgContext) das Azure-Kennzeichen
  bis zum nächsten Abruf zurück; Sprachmodus und Diktat wirken dann kurz verfügbar.

### 2.4 Mail-Entwürfe

- Entwurfs-Postfach per IMAP (`main/mail-entwurf/postfach.ts`); Microsoft 365 ist gesperrt, weil
  Exchange Online keine Passwort-Anmeldung mehr erlaubt. Rückfall: Outlook-Entwurf als .eml-Datei.

## 3. Grundentscheidung: eine zentrale AVA-App bei Microsoft

Statt einer Entra-App je Kunde registriert eproX **eine mehrinstanzfähige Entra-App „AVA“**
(Konten in beliebigen Organisationsverzeichnissen, optional plus private Microsoft-Konten). So
funktioniert „Mit Microsoft anmelden“ bei Slack, Notion oder Miro.

- Eine Registrierung, zwei Plattformen:
  - **Web** (vertraulich, mit Geheimnis): Umleitung zum Keycloak-Broker
    `https://<keycloak>/realms/ava/broker/microsoft/endpoint`. Dient der Anmeldung.
  - **Mobil/Desktop** (öffentlich, PKCE): Umleitung `http://localhost` für den Graph-Zugriff der
    Desktop-App (Entwürfe).
- Berechtigungen getrennt angefordert:
  - Anmeldung: `openid profile email offline_access User.Read`.
  - Entwürfe (erst wenn genutzt): `Mail.ReadWrite`.
- **Herausgeber-Verifizierung** (Microsoft Partner Center) ist Pflicht, sonst blockieren viele
  Firmen-Tenants die Zustimmung. Das dauert erfahrungsgemäß einige Tage.
- **Administratorzustimmung:** In den meisten Firmen dürfen Mitarbeiter Apps nicht selbst freigeben. Die
  IT gibt AVA einmal für die ganze Firma frei (Link aus der Konsole), wahlweise inklusive
  `Mail.ReadWrite`. Danach sieht kein Mitarbeiter einen Zustimmungsdialog.
- Die C2-Kopplung je Organisation wird abgelöst. Sie war nie live; bestehende Einträge werden entfernt.

## 4. Anmeldung und Organisation

### 4.1 Keycloak

- Ein sichtbarer Identitätsanbieter `microsoft` gegen `https://login.microsoftonline.com/organizations/v2.0`
  (bzw. `/common`, falls private Konten erlaubt werden). Ohne festen Aussteller-Check, weil jeder Tenant
  seinen eigenen `iss` hat; Signaturprüfung über die gemeinsamen Microsoft-Schlüssel.
- Mapper:
  - `tid` → Nutzerattribut `entra_tid`
  - `oid` → `entra_oid`
  - `xms_edov` (E-Mail-Domain vom Tenant bestätigt) → `entra_edov`

  Alle drei gehen als Claims in die Tokens von `ava-desktop` **und** `ava-web`.
- Keine Gruppen-Zuordnung mehr in Keycloak. Die Organisation entscheidet allein das Gateway (§4.2).
- Eigener Erstanmelde-Ablauf ohne die Seite „Kontoinformationen prüfen“:
  - Bestehendes AVA-Konto mit derselben E-Mail wird nur verknüpft, wenn Microsoft die Domain bestätigt
    (`xms_edov`).
  - Sonst wird ein neues Konto angelegt.
- Anmeldeseite (eigenes Theme): Knopf „Mit Microsoft anmelden“ über dem Passwortfeld.

### 4.2 Gateway: Organisation aus dem Microsoft-Tenant

- Neue Tabelle `TenantMicrosoft`:
  - `tenantId`
  - `entraTenantId` (**eindeutig**)
  - `anzeigename`
  - `domains[]`
  - `adminZustimmungAm`
  - `mailZustimmungAm`
  - `angelegtVon`
- Bei jeder Anmeldung mit `entra_tid` (`ensureTenantForAuth`):
  1. **Firma bekannt und freigegeben:** Mitgliedschaft in dieser Organisation sicherstellen. Eine
     frühere persönliche Zuordnung wird ersetzt.
  2. **Firma unbekannt:** Es entsteht **keine** Organisation. Stattdessen legt das Gateway eine
     Freischaltungsanfrage an das AVA-Team an (§4.5). Der Nutzer sieht „Deine Firma ist noch nicht für
     AVA freigeschaltet. Wir haben das AVA-Team informiert und melden uns.“ Der Firmenname kommt aus
     Microsoft Graph `/organization` (reicht mit `User.Read`), ersatzweise die Domain.
  3. **Sitz:** Ein freier Sitz wird zugewiesen. Ist keiner frei, entsteht eine Sitz-Anfrage an das
     AVA-Team (§4.5). Der Nutzer sieht „Für dich ist noch kein Platz frei. Wir haben das AVA-Team
     informiert.“ Es wird nie automatisch ein Sitz dazugebucht; die Sitzzahl legt eproX mit dem Kunden fest.
  4. **Vom Admin entfernt:** Der Nutzer bleibt draußen. Die Mitgliedschaft wird als „entfernt“
     markiert, statt ihn in eine persönliche Organisation zu schieben.
- **Mitgliedschaft wird maßgeblich:** Die Anmeldeprüfung akzeptiert einen Organisations-Claim nur noch,
  wenn der Nutzer dort Mitglied ist (behebt die C2-Lücke).
- Gäste (`#EXT#`-Konten im Verzeichnis eines anderen Tenants) bekommen keine automatische Zuordnung.
- `Tenant.verwaltung = 'microsoft'` markiert solche Organisationen. Folgen:
  - Kein Anlegen, Beitreten, Verlassen oder Wechseln.
  - Keine Einladungen per Link.
  - Domain-Beitritt entfällt, die Zuordnung ist automatisch.
- **Passwort-Anmeldung sperren** (Entscheidung 4): Ein Token ohne `entra_tid`, dessen E-Mail-Domain zu
  einer Microsoft-Organisation gehört, wird mit „Bitte mit Microsoft anmelden“ abgewiesen. Registrierung
  mit solchen Adressen ebenfalls.

### 4.3 Desktop-App

- Anmeldeseite mit „Mit Microsoft anmelden“ (`kc_idp_hint=microsoft`).
  - Dieser Weg öffnet den **Systembrowser** statt des eingebetteten Fensters.
  - Grund: Windows-SSO, Gerätekonformität und bedingter Zugriff der Firmen-IT greifen nur dort.
- Assistent und Oberfläche für Microsoft-Organisationen:
  - kein Organisationsschritt
  - kein „Organisation wechseln/anlegen/verlassen“
  - Kontowechsler ohne Organisationsaktionen
  - Werkzeuge `organisation`/`account` lehnen solche Aktionen mit Erklärung ab
- Abmelden und Sperre wirken wie bei allen Konten (seit v0.1.965 ruhen auch Telegram und Mail).

### 4.4 Web-App und Konsole

- Eigene Startseite mit zwei Knöpfen: „Mit Microsoft anmelden“ und „Mit E-Mail anmelden“.
- Konsole für Microsoft-Organisationen:
  - Seite „Microsoft“ statt „Anmeldung“: verbundener Tenant, Domains, Status der
    Administratorzustimmung mit Link für die IT, Zustimmung für Entwürfe, Sitze.
  - Anlegen, Beitreten und Verlassen sind ausgeblendet.
- Rollen: Den ersten Besitzer bestimmt das AVA-Team bei der Freischaltung (§4.5). Weitere Admins
  ernennt der Besitzer in der Konsole. Entra-Gruppen als Rollenquelle erst später (Entscheidung 9).

### 4.5 Freischaltung durch das AVA-Team

Neue Microsoft-Firmen und zusätzliche Sitze gibt nur eproX frei, weil Firmen und Sitzzahl mit dem Kunden
vereinbart werden.

- Tabelle `MicrosoftAnfrage`:
  - `art`: `firma` oder `sitz`
  - `entraTenantId`, `firmenname`, `domain`
  - `actorId` und E-Mail der anfragenden Person
  - `anzahl`: wie viele Personen derselben Firma warten
  - `status`: offen, erledigt, abgelehnt
  - `erstesAt`, `letztesAt`
- Benachrichtigung an das AVA-Team bei jeder neuen Anfrage (Telegram-Kanal der Problem-Meldungen, Mail an
  info@eprox-gmbh.de).
- Betreiber-Konsole, Seite „Microsoft-Anfragen“:
  - **Firma freischalten:** Organisation anlegen (Name vorbelegt), Sitzzahl und Plan setzen, ersten
    Besitzer bestimmen (vorbelegt: die anfragende Person). Die wartenden Personen bekommen beim nächsten
    Anmelden ihren Zugang, bis die Sitze voll sind.
  - **Sitze erhöhen:** führt zur Kundenseite (Sitzzahl, Plan); danach werden Wartende in der Reihenfolge
    ihrer Anfrage zugeordnet.
  - **Ablehnen** mit kurzem Grund, den die anfragende Person beim nächsten Anmelden sieht.
- Der Kunden-Admin sieht in seiner Konsole, wer auf einen Platz wartet, kann aber nichts dazubuchen; er
  kann beim AVA-Team mehr Sitze anfragen.
- Private Microsoft-Konten (Entscheidung 3) sind ganz normale Einzelkonten und brauchen keine Freischaltung.

### 4.6 Abmelden in der Firma (Offboarding)

- Wird ein Mitarbeiter in Entra deaktiviert, kann er sich nicht mehr neu anmelden. Laufende Sitzungen
  leben aber bis zu 30 Tage.
- Vorschlag:
  - Für Microsoft-Konten die Offline-Sitzung auf 7 Tage ohne Nutzung begrenzen.
  - Admins können in der Konsole sofort sperren (Zugangs-Schalter, gebaut 2026-11-11).
  - SCIM für automatische Abmeldung später.

## 5. Azure OpenAI ohne Reibung

- Für Microsoft-Organisationen gilt standardmäßig: **Anbieter-Sperre an und Chat-Modell Pflicht**,
  sobald Azure eingerichtet ist. Die Desktop-App wählt dann den Organisationszugang automatisch.
- Assistent:
  - Ist die Sperre aktiv, entfällt der Anbieter-Schritt.
  - EmbeddingGemma (lokal, für die Suche) lädt still im Hintergrund statt als Pflichtschritt.
- Konsole:
  - Knopf „Verbindung testen“: Liste der Deployments, ein kurzer Chat-Aufruf je zugeordnetem Modell.
  - Klare Fehlermeldung bei fehlendem Deployment.
  - Zuordnung für Transkription (Diktat in der App) und Sprachausgabe (Telegram).
- Gateway:
  - Deployment-Zuordnung auch für Multipart-Anfragen (Transkription).
  - Tests für den Azure-Weg.
- Fehler beheben: Azure-Kennzeichen bei Vorgaben-Änderung erhalten.
- Später (Entscheidung 10):
  - Sprachmodus auf Azure (Realtime-Deployments)
  - Foundry-Modelle außerhalb von OpenAI
  - Anmeldung an Azure per Entra statt Schlüssel
- Hinweis für Verträge: Die Hintergrundverarbeitung (Profile, Recherche, Websuche) läuft weiter über die
  Betreiber-Spur bei OpenAI, nicht über das Azure der Kundin. Das gehört in AVV und Datenschutzerklärung
  und wird bei Enterprise-Kunden gefragt werden.

## 6. Outlook-Entwürfe über Microsoft Graph

Übernommen aus dem Entwurf zum Entwurfs-Postfach. Entscheidung dort: Graph statt IMAP mit OAuth, weil IMAP
in Firmen-Tenants oft abgeschaltet ist.

- Desktop: eigenes Modul `main/mail-entwurf/microsoft.ts`, PKCE über den Systembrowser mit derselben
  AVA-App (öffentliche Plattform).
  - Bei Microsoft-angemeldeten Nutzern mit `login_hint` und meist ohne Rückfrage, wenn die IT schon
    zugestimmt hat.
  - Refresh-Token verschlüsselt über `credentials()`.
- `entwurfAblegen()` bekommt die Postfach-Art `microsoft`:
  - Graph `POST /me/messages` mit Empfängern, Betreff, HTML und Anhängen.
  - Bis 3 MB je Anhang direkt, darüber per Upload-Sitzung.
  - Rückgabe wie heute „in Entwürfe abgelegt“.
- Fehlerbilder in Nutzersprache: Zustimmung fehlt, IT muss freigeben, Anmeldung abgelaufen, Postfach voll.
- Für Microsoft-Organisationen ist „Entwürfe in Outlook“ voreingestellt, sobald die IT `Mail.ReadWrite`
  freigegeben hat. Für alle anderen gibt es den Knopf „Mit Microsoft verbinden“ unter
  Einstellungen → Mail → Entwurfs-Postfach.
- Server-Instanzen: Gerätecode-Ablauf (Code plus Link `microsoft.com/devicelogin`).
- Chat-Werkzeug: Postfach verbinden und trennen (Self-Service), das Verbinden selbst immer über die
  Microsoft-Seite.
- `Mail.ReadWrite` erlaubt technisch auch das Lesen des Postfachs. AVA nutzt nur das Anlegen von
  Entwürfen; das steht im Dialog und in der Datenschutzerklärung.

## 7. Stufen

| Stufe | Inhalt | Aufwand |
|---|---|---|
| MS0 | eproX: Entra-App „AVA“ (mehrinstanzfähig), Geheimnis für Keycloak, Herausgeber-Verifizierung; Rollen `manage/view-identity-providers` für `ava-registrar` | kein Code, Wartezeit Verifizierung |
| MS1 | Gateway: `TenantMicrosoft`, `MicrosoftAnfrage`, Zuordnung beim Login, Mitgliedschaft maßgeblich, entfernte Mitglieder, Sitz und Warteliste, Benachrichtigung ans AVA-Team, `verwaltung = microsoft`, Passwort-Sperre für Microsoft-Domains, Tests | 2 Tage |
| MSK | Keycloak-Upgrade 20 → 26 (Entscheidung 5): Datenbank-Migration, Theme, Hostname-Konfiguration, Test aller Anmeldewege (Desktop, Web-App, Konsole, Registrierung, Gerätecode) vor dem Umschalten | 2 Tage |
| MS2 | Keycloak: Anbieter `microsoft`, Mapper, Erstanmelde-Ablauf, Theme-Knopf, Sitzungsdauer; C2-Einträge entfernen | 1 Tag |
| MS3 | Desktop: Microsoft-Knopf mit Systembrowser, Assistent/Oberfläche ohne Organisationsaktionen, Azure-Kennzeichen-Fehler | 1,5 Tage |
| MS4 | Web-App und Konsole: Startseite mit beiden Knöpfen, Warteseite „noch nicht freigeschaltet / kein Platz frei“, Konsolen-Seite „Microsoft“ mit Zustimmungslinks und Warteliste, Betreiber-Seite „Microsoft-Anfragen“, ausgeblendete Organisationsaktionen | 1,5 Tage |
| MS5 | Azure: Sperre als Standard, Assistent ohne Anbieterschritt, Verbindungstest, Transkriptions-Zuordnung, Tests | 1 Tag |
| MS6 | Outlook-Entwürfe über Graph (Desktop, Fehlerbilder, Einstellungen, Chat-Werkzeug, Gerätecode für Server) | 2,5 Tage |
| MS7 | Lösungskarten, Prüfsatz, Vektoren, Datenschutzerklärung, lokaler Test gegen Prod, Live-Test mit dem eproX-Tenant (Patrick) | 1 Tag |

Summe etwa 12,5 Tage Entwicklung, dazu die Wartezeit für die Verifizierung (MS0). MS1 bis MS5 sind
unabhängig von MS6. Die Entwürfe können auch zuerst kommen, wenn PM-2026-0047 drängt.

Das Keycloak-Upgrade (MSK) kommt vor MS2.

## 8. Entscheidungen

Abgenommen (Joyce, 2026-11-11):

1. **Neue Firma:** Freischaltung nur durch das AVA-Team (eproX), §4.5. Keine automatische Organisation.
2. **Kein Sitz frei:** Anfrage an das AVA-Team, nie automatisch dazubuchen; die Sitzzahl wird mit dem
   Kunden vereinbart, §4.5.
3. **Private Microsoft-Konten:** ganz normale Einzelkonten.
4. **Passwort-Anmeldung** für Mitarbeiter von Microsoft-Organisationen gesperrt.
5. **Keycloak-Upgrade** auf 26 als eigene Stufe vor MS2.
6. **`Mail.ReadWrite`** als zweiter, optionaler Link in der Administratorzustimmung.
7. **Eine App** für Anmeldung und Entwürfe.
10. **Sprachmodus auf Azure und Foundry-Modelle außerhalb von OpenAI:** später.

Offen:

8. **Herausgeber-Verifizierung (MS0):** eproX muss bei Microsoft einmal nachweisen, wer hinter der App
   „AVA“ steht. Dafür braucht es ein Konto im Microsoft-Partnerprogramm (AI Cloud Partner Program) für
   die eproX GmbH, angelegt mit einer @eprox-gmbh.de-Adresse. Microsoft prüft Firmendaten und Domain
   (einige Tage), danach wird die Partner-ID in der App-Registrierung eingetragen. Ohne Verifizierung
   steht im Microsoft-Dialog „nicht verifiziert“, und viele Firmen-Tenants lassen die Zustimmung nicht zu.
   Zu klären: Wer macht das (Admin-Zugang zum eproX-Tenant nötig)?
9. **Entra-Gruppen als Rollen:** Statt Admins in der AVA-Konsole zu ernennen, legt die IT des Kunden in
   Microsoft eine Gruppe an (etwa „AVA-Admins“); wer drin ist, ist automatisch Admin in AVA, wer
   entfernt wird, verliert die Rolle. Vorschlag: später. Wer AVA überhaupt nutzen darf, kann die IT schon
   heute ohne unseren Code begrenzen (Entra: „Benutzerzuweisung erforderlich“ an der Unternehmens-App).
