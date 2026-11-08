# Plan: Konto löschen und deaktivieren

Stand 2026-11-08. Anlass: Joyce möchte neben „App zurücksetzen“ (wirkt nur auf diesem
Rechner) eine Möglichkeit, das ganze Konto zu löschen. Die Funktion liegt dezent ganz unten in
den Einstellungen, als kleiner Link und nicht als roter Knopf, und läuft immer über einen
Bestätigungsdialog.

Ein Entwurf des Gateway-Teils liegt außerhalb des Repos (Scratchpad) und ist weder committet
noch ausgerollt. Gebaut wird erst nach Abnahme dieses Plans.

## 1. Entscheidungen (Joyce 2026-11-08)

| # | Regel |
|---|---|
| R1 | **Löschen = anonymisieren und unumkehrbar.** In Keycloak werden E-Mail und Benutzername zu `<keycloakUserId>@<gleiche Domain>`, Vor- und Nachname zu `*****` (immer genau fünf Sterne). Das Konto wird deaktiviert und dauerhaft als gelöscht markiert. |
| R2 | **Die Organisation wird nie gelöscht.** Es bleibt immer mindestens ein Owner. |
| R3 | **Einziger Owner mit weiteren Mitgliedern:** erst die Inhaberschaft übertragen (in der AVA Konsole, Mitglieder → Rolle „Owner“), dann löschen. |
| R4 | **Allein in der Organisation** (einziges Mitglied): kein Löschen, aber **Konto deaktivieren**. In Keycloak ist das Konto dann aus, alle Sitzungen enden. Es wird nichts anonymisiert, weil die Organisation für Rechnungen einen Ansprechpartner braucht. Nur das AVA-Team kann das Konto wieder einschalten. |
| R5 | **Enterprise** (Abrechnungsmodus oder Stufe `enterprise`, auch für alle Mitglieder solcher Organisationen): Löschen und Deaktivieren sind nie selbst möglich, sondern immer über das AVA-Team, weil zum Beispiel ein eigener Server auf Fly dranhängen kann. |
| R6 | **Abo:** Ein bezahltes Abo des Kontos (persönlich, oder bei R4 das der Organisation) endet zum Ende der laufenden Zahlungsperiode (`cancel_at_period_end`). Es gibt keine Erstattung; die restlichen Tage sind bezahlt. Der Dialog sagt das vorher, mit Datum. |
| R7 | **Kontowechsler** (oben rechts): Beim Öffnen wird geprüft, ob die aufgeführten Konten noch bestehen. Gelöschte und deaktivierte Konten verschwinden. |
| R8 | **Kein Chat-Werkzeug:** Löschen und Deaktivieren gibt es nur über die Oberfläche. Das ist eine Ausnahme von „Self-Service im Chat“, wie bei Schlüsseln und Einwilligungen. |

## 2. Ablauf im Dialog (Entscheidungsbaum)

Der Dialog fragt zuerst `GET /v1/konto/loeschen` (Prüfung, ohne Wirkung) und zeigt dann genau
einen der folgenden Fälle:

1. **Enterprise:** „Dein Konto gehört zu einem Enterprise-Vertrag. Löschen oder Deaktivieren
   läuft über das AVA-Team.“ Darunter ein Knopf **„Problem melden“** (vorbefüllt, Kategorie
   Konto) und ein Link zu support@ava.bi. Es gibt keinen Löschknopf.
2. **Einziger Owner mit weiteren Mitgliedern:** „Du bist der einzige Owner von <Org>. Ernenne
   in der AVA Konsole unter Mitglieder zuerst eine weitere Person zum Owner, dann kannst du
   dein Konto löschen.“ Daneben ein Knopf zur Konsole.
3. **Allein in der Organisation:**
   - „Du bist die einzige Person in <Org>. Ein Konto, an dem eine Organisation hängt, kann
     nicht gelöscht werden; wende dich dafür an das AVA-Team.“
   - Darunter das Angebot **„Konto deaktivieren“**: Du kannst dich dann nicht mehr anmelden,
     deine Daten bleiben gespeichert, und das AVA-Team kann das Konto wieder einschalten.
   - Abo-Hinweis (R6).
   - Zur Bestätigung **DEAKTIVIEREN** eintippen.
4. **Sonst (Löschen möglich):** eine Liste, was passiert:
   - Name und E-Mail werden unkenntlich.
   - Deine eigenen Daten werden gelöscht.
   - Was du in der Organisation geteilt hast, bleibt ohne deinen Namen.
   - Rechnungen bleiben aus gesetzlichen Gründen aufbewahrt.
   - Abo-Hinweis (R6).
   - Dieser Rechner wird bereinigt.
   - Nicht rückgängig zu machen.

   Zur Bestätigung **LÖSCHEN** eintippen.

Nach dem Löschen oder Deaktivieren meldet sich die App ab, löscht den lokalen Bereich dieses
Kontos und startet neu. Gibt es auf dem Rechner weitere Konten, kommt der Kontowechsler, sonst
die Anmeldung.

## 3. Was mit den Daten passiert

Der Ablauf liegt allein im Gateway (`POST /v1/konto/loeschen`). Desktop, Web-App und später die
Konsole rufen nur diese eine Stelle auf. Die Reihenfolge:

1. **Marke setzen** (`KontoStatus`, art `geloescht`): Ab diesem Moment weist die
   Anmeldeprüfung jedes noch gültige Token des Kontos ab (`401 konto_geloescht`).
2. **Organisation verlassen** über die vorhandene Austrittslogik (`removeMember`):
   - Der Sitz wird frei, die Mitgliedschaft geschlossen und ein Abrechnungsereignis geschrieben.
   - Die Relevanz-Daten in dieser Organisation werden gelöscht.
3. **Abo zum Periodenende** beenden (R6).
4. **Eigene Daten löschen.** Fehlt eine Tabelle, wird sie übersprungen.

   | Tabelle | Bedeutung |
   |---|---|
   | RelevanzSignal, RelevanzWert, RelevanzSperre | Verhaltensprofil |
   | FokusKunde, FirmenZustand | eigene Firmenliste |
   | CompanyResearchLauf | eigene Recherche-Läufe |
   | BuyingCenter (+ Mitglied/Angabe/Kante/Freigabe/Lauf) | gehört nur dem Ersteller |
   | LinkedInLead, DiscoveryScan, DiscoveryDecision | eigene Leads und Radar-Entscheidungen |
   | CompanyTombstone, HiddenTransaction | eigene Ausblendungen |
   | SuchBlock (nur Zeilen mit actorId) | eigene Themen-Befunde |
   | A2aTask, WebhookEmpfaenger, DienstEreignis, OrgShareSeen | eigene Dienste und Verbindungen |
   | StartAuftrag, MailEinstellung, MailVersand, NutzerAktivitaet | Onboarding und Aktivität |
   | PromptAudit | Inhalte eigener KI-Anfragen |
   | CompanyThema (Producer-Datenbank, actorId) | eigene Fokus-Themen-Befunde |
   | MCP-Einwilligungen und dynamische Clients | über `widerrufeEinwilligung` |

5. **Anonymisieren, was bleiben muss.** Name wird zu `*****`, E-Mail zu `<sub>@<Domain>`:

   | Tabelle | Warum es bleibt |
   |---|---|
   | TenantMember, TenantJoinRequest, TenantMembership | Mitgliedschafts-Historie der Organisation |
   | SeatInvoiceSeat | Nachvollziehbarkeit der Sitz-Rechnungen |
   | ProblemMeldung, ProblemNachricht | Support-Verlauf; nur der Name wird ersetzt |
   | Tenant (persönlich, name = E-Mail) | technische Hülle des Kontos |

6. **Nicht angefasst, nur unter der pseudonymen ID:**
   - LlmUsage, UsageEntry, BillingEvent, Sitz, PlanZeitraum, TenantBilling, AuditLog und
     ProxyAudit (Abrechnung und Sicherheit).
   - Geteilte Inhalte (CompanyNotiz, OrgShare, TenantWorkflow, Angaben in fremden Buying
     Centern, Verflechtungs-Kontext). Sie gehören der Organisation; als Autor steht nur noch
     die ID da.
7. **master-data:** In der Nutzer-Zeile werden E-Mail und Benutzername zur anonymen Adresse.
   Das macht das Gateway direkt über seinen master-data-Zugang; es braucht keine neue Route.
   Ob der Zugang Schreibrecht hat, wird beim Bau geprüft; sonst kommt eine interne Route.
   Import-Vorgänge bleiben unter der pseudonymen ID.
8. **Keycloak zuletzt** (`kontoInKeycloakAnonymisieren`):
   - E-Mail, Benutzername, Namen, `enabled: false` und Attribut `ava_geloescht`.
   - Austritt aus allen `tenant:*`-Gruppen, dann alle Sitzungen beenden.
   - Lässt der Realm keinen Wechsel des Benutzernamens zu, bleibt der alte Benutzername. Das
     wird beim Bau geprüft: Realm-Einstellung `editUsernameAllowed` bzw.
     `registrationEmailAsUsername`.
9. Teilfehler landen an der Marke (`KontoStatus.fehler`) und im Protokoll. Die Marke bleibt in
   jedem Fall gesetzt; Nacharbeiten macht das AVA-Team.

**Deaktivieren (R4)** setzt nur die Marke (art `deaktiviert`), beendet das Abo der Organisation
zum Periodenende und schaltet das Konto in Keycloak aus (Attribut `ava_deaktiviert`, Sitzungen
beenden). Daten, Organisation und Mitgliedschaft bleiben unverändert. Zum Wiedereinschalten
löscht das AVA-Team die Marke und schaltet das Konto in Keycloak ein; das kommt später als
Werkzeug in die Konsole.

**Rechtlicher Rahmen:**
- Rechnungen und Buchungsbelege bewahren wir 10 Jahre auf (HGB §257, AO §147). Die DSGVO
  erlaubt das (Art. 17 Abs. 3 b). Rechnungen mit Name und Anschrift führt Stripe als Teil der
  Buchhaltung; dort wird nichts gelöscht.
- In AVA bleibt dafür nur die pseudonyme ID.
- Daten Dritter (Firmen, Register, Kontakte) sind keine Daten des Kontos und bleiben.

## 4. Orte in den Apps

| Ort | Was |
|---|---|
| Desktop: Einstellungen → Konto, ganz unten | kleiner, grauer Link „Konto löschen…“ (kein roter Knopf), öffnet den Dialog aus §2 |
| Web-App: app.ava.bi → Mehr → Konto, unter „Abmelden“ | derselbe Link und Dialog, dieselben Gateway-Routen; die Web-App braucht dafür zwei Proxy-Freigaben |
| AVA Konsole | vorerst nicht; die Konsole bekommt später für das AVA-Team „Konto deaktivieren/wieder einschalten“ und die Löschung im Auftrag (Enterprise) |
| Chat | nein (R8); fragt jemand danach, erklärt eine Lösungskarte den Weg |

## 5. Desktop: lokaler Bereich und Kontowechsler

- **Aktives Konto bereinigen:** `removeAccount` löscht heute nur nicht-aktive Konten. Nach dem
  Löschen setzt die App deshalb eine Marke im Basisordner (Muster wie bei „App
  zurücksetzen“), meldet sich ab und startet neu. Beim Start, bevor die Speicher geöffnet
  werden, wird der Bereich des Kontos gelöscht und es verschwindet aus `accounts.json`.
- **Kontowechsler (R7):** Beim Öffnen fragt die App `POST /v1/konten/status` mit den IDs der
  gelisteten Konten (höchstens 50). Gelöschte und deaktivierte Konten werden lokal entfernt,
  ihr Bereich gleich mit, sofern es nicht das aktive Konto ist. Ohne Netz bleibt die Liste
  unverändert.
- **Anmeldung mit einem gelöschten oder deaktivierten Konto:** Keycloak lehnt ab
  („Account disabled“). Die Anmeldemaske zeigt: „Dieses Konto ist gelöscht oder deaktiviert.
  Bei Fragen hilft das AVA-Team.“
- **Neu registrieren:** Nach dem Löschen ist die E-Mail-Adresse wieder frei, ein neues Konto
  ist möglich. Bei einem deaktivierten Konto bleibt sie belegt; die Registrierung meldet
  „bereits registriert“ und verweist auf das AVA-Team.

## 6. Stufen

| Stufe | Inhalt | Aufwand |
|---|---|---|
| KL1 | Gateway: Migration `KontoStatus`, `lib/konto-loeschen.ts` (Prüfung, Löschen, Deaktivieren, Abo zum Periodenende, Enterprise-Sperre), Keycloak-Funktionen, Routen, Anmeldeprüfung | 1–1,5 Tage |
| KL2 | Tests gegen eine Testdatenbank und einen Keycloak-Ersatz; alle Fälle aus §2; Teilfehler; zweimal aufrufen | ½ Tag |
| KL3 | Desktop: Link und Dialog, Bereinigung des aktiven Kontos beim Neustart, Kontowechsler-Abgleich, Anmeldemeldung, Lösungskarte „konto-loeschen“ und Prüfsatz | 1 Tag |
| KL4 | Web-App: Link und Dialog, Proxy-Freigaben | ½ Tag |
| KL5 | Konsole (AVA-Team): deaktivierte Konten sehen und wieder einschalten, Löschen im Auftrag | später |

Ausrollen: erst das Gateway (Migration, die Routen sind ohne Desktop unschädlich), dann Desktop
und Web-App.

## 7. Offene Punkte

1. **Abo bei R4:** Das Abo der Organisation endet zum Periodenende, wenn sich ihr einziges
   Mitglied deaktiviert. Abgeleitet aus R6, bitte bestätigen.
2. **Problem melden** als Kontaktweg zum AVA-Team im Dialog, plus support@ava.bi. Passt das?
3. **Prompt-Protokoll (PromptAudit):** Löschen statt aufbewahren? Es enthält Inhalte der
   KI-Anfragen. Vorschlag: löschen; abgerechnet wird über LlmUsage.
4. **Fly-Instanz eines Nicht-Enterprise-Kontos** (Cloud-AVA): gibt es so etwas, das beim
   Löschen mit abgebaut werden muss? Bisher ist das nur Enterprise, R5 deckt es ab.
