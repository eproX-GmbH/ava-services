# Plan: Lead-Zuordnung mit Ort und Lernen aus unzustellbaren Mails

Stand 2026-11-16 · Anlass: drei Sprachnachrichten von Patrick (16.11., 13:54 / 14:14 / 14:31)
während er einen Ablauf für LinkedIn-Leads aus beobachteten Posts baut.

## 0. Ergebnis in drei Sätzen

Patricks Ablauf soll Leads ohne Rückfrage übernehmen und anschreiben. Dafür braucht er (L) einen
Lead-Status „Firma und Ort bestätigt“, nach dem Werkzeuge und Abläufe filtern können, und eine
Übernahme, die im Ablauf unklare Fälle überspringt statt nachzufragen. Kommt eine Mail an eine
abgeleitete Adresse zurück, soll AVA (M) daraus für die ganze Domain lernen und das nächste
Adressmuster nehmen, ohne eine einzelne gegangene Person mit einem falschen Muster zu verwechseln.

Die erste Nachricht (abwegige Firmenvorschläge) ist erledigt: master-data v134 vom 16.11.
(Suche und Import-Zuordnung über den Kernnamen, `6871072`).

## 1. Befund

### 1.1 Was „Firma bestätigt“ heute heißt

- Post-Leads entstehen im Personen-Radar (`services/desktop/src/main/linkedin/personen-radar/supervisor.ts`)
  mit `firmaName`, `firmaDomain` und `konfidenz` (0,9 hart / 0,6 mittel), aber ohne Register-Firma.
- Die Lead-Liste im Gateway (`services/db-gateway/src/lib/linkedin-leads.ts`) holt Ort, Mini-Profil
  und `masterCompanyId` per Join aus `DiscoveredCompany` über die **Domain**.
- Der Desktop zeigt „Firma bestätigt“, sobald `companyId` oder `masterCompanyId` gesetzt ist
  (`LinkedInLeadsPanel.tsx`, `erkennungsStand`). Ob die Register-Firma über Name **und** Ort oder nur
  über die Website gefunden wurde, steht nirgends. Der Ort des Leads wird dabei nicht gegengeprüft.
- Die Übernahme (`linkedin/leads-uebernahme.ts`) ordnet selbst in Stufen zu: exakter Name am Ort →
  gleicher Kernname am Ort → ähnlicher Name am Ort → Website-Firma. Eindeutige Fälle laufen ohne Frage
  durch. Bei mehreren Kandidaten oder fehlendem Ort fragt `linkedin_lead_uebernehmen` im Chat per
  Auswahl nach; ohne Nutzer kommt `auswahlNoetig` zurück. Genau diese Rückfrage stört Patricks Ablauf.

### 1.2 Was bei unzustellbaren Mails heute passiert

- Erkennung gibt es: `contacts/email-muster/rueckmeldung.ts` prüft jede eingehende Mail in einem
  **in AVA verbundenen** Postfach (Absender `mailer-daemon`/`postmaster`, Betreff „Undeliverable“,
  „Unzustellbar“ …) und meldet die Adressen an `POST /v1/email-patterns/feedback`.
- Das Gateway deaktiviert daraufhin nur **diese eine** abgeleitete Adresse (Quelle `pattern:*` oder
  `zuordnung:*`). Das Muster der Domain (`EmailPattern`) bleibt unverändert, Kollegen an derselben
  Domain behalten ihre gleich gebauten Adressen, und es wird kein anderes Muster versucht.
- In den letzten 30 Tagen hat dieser Weg **keine einzige** Adresse deaktiviert (Abfrage 16.11.,
  `Fact.deactivatedReason = 'bounce'`). Wahrscheinliche Gründe: Patrick verschickt aus einem Postfach,
  das nicht in AVA verbunden ist; die Meldung trägt die Adresse nur im Anhang
  `message/delivery-status` und nicht im Text; oder die Adresse stammt aus einer anderen Quelle.
- Patricks „40 %“ ist die Kennzeichnung „wahrscheinlich“: die Adresse ist aus dem Muster abgeleitet,
  aber nicht per Antwort oder Server bestätigt.

## 2. Zielbild

### 2.1 Leads (L)

- Jeder Lead trägt, **wie** seine Firma feststeht: `name_ort` (exakter Name am Ort), `kernname_ort`
  (Name ohne Rechtsform am Ort), `aehnlich_ort` (Tippfehler-nah am Ort), `website` (nur über die
  Website-Firma), `manuell` (vom Nutzer gewählt) oder leer.
- Anzeige: **„Firma und Ort bestätigt“** für `name_ort`, `kernname_ort` und `manuell`; „Firma über
  Website erkannt“ für `website`; „Firma ähnlich, bitte prüfen“ für `aehnlich_ort`; sonst wie heute.
- Die Zuordnung wird **vorab** gerechnet, sobald Firmenname und Ort bekannt sind (Mini-Profil oder
  Impressum), nicht erst bei der Übernahme. Der Rechenweg ist derselbe wie in der Übernahme, nur ohne Import.
- Werkzeuge und Abläufe:
  - `linkedin_leads` bekommt den Filter `nurBestaetigt` (Firma und Ort bestätigt).
  - `linkedin_lead_uebernehmen` bekommt `ohneRueckfrage`: Bei Mehrdeutigkeit wird der Lead
    „ungeklärt“ mit Grund und Kandidaten, statt zu fragen. Im Ablauf ist das der Standard, im Chat
    bleibt die Auswahl.
  - Das Ereignis `linkedin.lead` trägt die Zuordnung mit, damit ein Ablauf direkt verzweigen kann.
- Patricks Ablauf wird dann: neuer Lead → nur „Firma und Ort bestätigt“ → übernehmen ohne Rückfrage
  → Ansprechpartner/Mail. Alles andere sammelt sich als „ungeklärt“ für eine gelegentliche Durchsicht.

### 2.2 Mail-Lernen (M)

- **Unterscheiden statt pauschal verwerfen.** Eine Unzustellbarkeit heißt entweder „Muster falsch“
  oder „Person nicht mehr da“. Regel:
  - Hat die Domain **belegte** Adressen im selben Muster (echte, gefundene Adressen anderer Personen),
    ist das Muster richtig und die Person vermutlich gegangen: nur diese Adresse abschalten, Person mit
    Hinweis „Adresse kam zurück, vermutlich nicht mehr im Unternehmen“ markieren.
  - Ist das Muster **nur abgeleitet** (Baseline ohne Belege) oder kommen **zwei verschiedene Personen**
    derselben Domain zurück, gilt das Muster als widerlegt.
- **Widerlegtes Muster:** `EmailPattern` merkt sich die Widerlegung (Muster, Adresse, Datum). Alle
  übrigen abgeleiteten Adressen dieser Domain im widerlegten Muster gehen auf „abgelehnt“. Die Ableitung
  nimmt das nächstbeste Muster (`vorname@`, `v.nachname@`, `nachname@` …) unter Ausschluss der
  widerlegten und prüft es per Server, wo das Netz es erlaubt; sonst „ungeprüft · nächstes Muster“.
- **Erkennung robuster:** Empfänger auch aus dem Anhang `message/delivery-status` (`Final-Recipient`)
  lesen, deutsche Exchange-Meldungen und Gmail-Varianten abdecken.
- **Selbst melden im Chat:** „Diese Mail kam zurück“ mit eingefügter oder weitergeleiteter
  Unzustellbarkeitsmeldung reicht. AVA zieht die Adresse heraus und lernt wie oben (Regel
  „Self-Service im Chat“). Damit hilft das auch, wenn das Versandpostfach nicht verbunden ist.
- Patricks Sonderfall (richtiges Muster, aber Zahl in der Adresse) bleibt bewusst außen vor: Dafür
  gibt es keine Regel, die mehr trifft als verfehlt.

## 3. Technik

- **Gateway:** `LinkedInLead` + Spalten `"zuordnung" TEXT`, `"registerId" TEXT`, `"zuordnungOrt" TEXT`,
  `"zuordnungAt" TIMESTAMPTZ` (lazy `ALTER TABLE … IF NOT EXISTS` wie bisher). Route zum Setzen
  (`PUT /v1/linkedin/leads/{id}/zuordnung`), Listenfilter `nurBestaetigt`. `masterCompanyId` aus
  `DiscoveredCompany` bleibt als Website-Weg erhalten.
- **Desktop:** Vorab-Zuordnung als reine Funktion aus `leads-uebernahme.ts` herauslösen
  (`zuordnungBestimmen(lead)` → Stufe + Kandidat, ohne Import), aufrufen nach dem Ablegen eines Leads
  und nach dem Mini-Profil. Panel-Text und Filter-Chip. Werkzeug-Parameter wie in 2.1.
- **App (app.ava.bi):** Leads-Ansicht zeigt dieselbe Stufe und denselben Filter.
- **E-Mail-Muster:** `EmailPattern` + `"widerlegt" JSONB`, Rückmelderoute um die Unterscheidung in 2.2
  erweitern (Belege zählen, zweite Person zählen). Neu ableiten über `packages/email-muster` mit
  Ausschlussliste. Erkennung in `rueckmeldung.ts` um `message/delivery-status`. Chat-Werkzeug
  `mail_ruecklaeufer_melden` (Bestätigung per `confirmAction` vor dem Abschalten).
- **Lösungskarten:** Karten zu „Firma bestätigt“ und „E-Mail-Adresse kam zurück“ mit Prüfsatz und
  vorberechneten Vektoren im selben Commit.

## 4. Stufen

| Stufe | Inhalt | Aufwand |
|---|---|---|
| **M0** | Diagnose mit Patrick: welches Postfach versendet, ist es verbunden, liegt die zurückgekommene Mail dort; die eine Meldung von heute gegen `bounceAdressen` testen | 1 Std |
| **L1** | Gateway-Spalten, Setz-Route, Listenfilter | 2 Std |
| **L2** | Desktop: Vorab-Zuordnung, Panel-Text und Filter, Werkzeuge `nurBestaetigt`/`ohneRueckfrage`, Ereignis mit Zuordnung, Lösungskarte | 3 Std |
| **L3** | App: Stufe und Filter in der Leads-Ansicht | 1 Std |
| **M1** | Erkennung robuster, Chat-Werkzeug zum Selbstmelden | 2 Std |
| **M2** | Unterscheidung gegangen/Muster falsch, Widerlegung an der Domain, Kollegen-Adressen abstufen | 3 Std |
| **M3** | Nächstes Muster ableiten und prüfen, Anzeige an der Kontaktkarte, Lösungskarte | 3 Std |

Reihenfolge: M0 sofort (klärt, warum heute nichts greift), dann L1–L3 (Patricks Ablauf ist
blockiert), danach M1–M3. Desktop wie immer lokal gegen Prod prüfen, dann taggen; Gateway deployen.

## 5. Entscheidungen (Empfehlung zuerst)

1. **„Firma und Ort bestätigt“ umfasst exakten Namen und Kernnamen am Ort sowie manuelle Wahl**, nicht
   den ähnlichen Namen und nicht den reinen Website-Weg. Alternative: auch `aehnlich_ort` zulassen
   (mehr Automatik, mehr Fehlzuordnungen).
2. **Ort aus Impressum oder Mini-Profil**, nicht aus dem LinkedIn-Profil der Person (das ist oft der
   Wohnort oder eine Region).
3. **Im Ablauf überspringen, im Chat fragen.** Alternative: auch im Chat überspringen und nur die
   Liste der ungeklärten zeigen.
4. **Eine Unzustellbarkeit widerlegt ein belegtes Muster nicht**, erst die zweite Person derselben
   Domain. Ein nur abgeleitetes Muster fällt schon bei der ersten.
5. **Kollegen-Adressen im widerlegten Muster werden „abgelehnt“**, nicht gelöscht, und bleiben mit
   Datum sichtbar.

## 6. Risiken

- Firmen mit mehreren Standorten: Der Lead nennt eine Niederlassung, das Register den Sitz. Dann
  greift „Firma und Ort bestätigt“ nicht, der Lead landet bei „ungeklärt“. Das ist gewollt, sollte aber
  im Hinweis stehen („Ort passt nicht zum Registersitz“).
- Abwesenheitsnotizen und Spamfilter-Meldungen sehen aus wie Unzustellbarkeit. Nur harte Fehler
  (5xx, „user unknown“, „Empfänger unbekannt“) zählen; 4xx und Abwesenheit nie.
- Gemeinsame Domains (Konzern mit mehreren Firmen auf einer Domain): Die Widerlegung gilt für die
  Domain, nicht für die Firma. Das ist richtig, weil das Mailsystem dasselbe ist.

## 7. Stand

- 2026-11-16: Befund und Plan geschrieben (Sprachnachrichten lokal transkribiert, Code und Prod-Daten
  nur lesend geprüft). Wartet auf Abnahme.
