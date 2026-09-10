# Plan: Abgeleitete E-Mail-Adressen für Kontakte (Muster + Verifizierung)

Stand 2026-09-10 (überarbeitet: Verarbeitung lokal auf dem Nutzergerät). Idee des Operators: Ist von einer Firma eine persönliche
E-Mail-Adresse bekannt (john.doe@example.com), lässt sich das Adressmuster
der Firma ableiten und für die übrigen Kontakte anwenden (jane.doe@…).
Weil das geraten ist, wird jede abgeleitete Adresse verifiziert. Nur
abgeleitet UND verifiziert wird gespeichert und angezeigt, klar
gekennzeichnet. Alles andere bleibt unsichtbar.

## 1. Datenlage (Produktion, 2026-09-10)

| | Anzahl |
|---|---|
| Personen im Kontaktbestand | 723 |
| davon mit E-Mail | 145 |
| Firmen mit mindestens einer Personen-E-Mail | 31 |
| Firmen, in denen weitere Personen ohne E-Mail sind (Musterkandidaten) | 23 |

Befund aus den Stichproben: Ein Teil der „Personen-E-Mails“ sind
Funktionsadressen (hello@, ir@, hr@), die der Extraktor einer Person
zugeordnet hat. Die Mustererkennung muss solche Adressen ausschließen,
sonst wird ein falsches Muster gelernt.

## 2. Ablauf je Firma (Domain)

### 2.1 Muster erkennen

1. Belege sammeln: aktive E-Mail-Fakten von Personen der Firma, deren
   Domain zur Firmen-Website passt. Funktionsadressen ausschließen (info,
   kontakt, hello, office, mail, hr, ir, presse, vertrieb, sales, support,
   service, buchhaltung, bewerbung, jobs, karriere, marketing, team, admin,
   postmaster, noreply, kein Personenname enthalten).
2. Name normalisieren: Kleinschreibung, Umlaute (ä→ae, ö→oe, ü→ue, ß→ss)
   UND Variante mit Diakritika-Entfernung (ä→a), Bindestriche und
   Leerzeichen in Doppelnamen, Adelsprädikate und Partikel („von“, „van“,
   „de“) optional, akademische Titel bereits durch die Sanitization
   entfernt. Vorname = erstes Token, Nachname = letztes Token; bei
   mehreren Vornamen zusätzlich Variante „alle Vornamen“.
3. Musterkatalog (Reihenfolge nach Verbreitung im DACH-B2B):
   `vorname.nachname`, `v.nachname`, `vnachname`, `vorname`, `nachname`,
   `vorname_nachname`, `vornamenachname`, `nachname.vorname`,
   `v-nachname`, `vorname-nachname`, `nachname.v`, `nachnamev`.
4. Bewertung: Jeder Beleg wird gegen alle Muster geprüft. Ein Muster gilt
   als erkannt, wenn es alle Belege erklärt. Konfidenz: 1 Beleg 0,6 ·
   2 konsistente Belege 0,85 · ab 3 0,95. Widersprüchliche Belege ohne
   gemeinsames Muster: kein Muster, Firma wird protokolliert.
5. Ergebnis je Domain speichern: `EmailPattern { domain, muster,
   konfidenz, belege[], erkanntAm, catchAll?, letzterLauf }`.

### 2.2 Kandidaten erzeugen

Für jede Person der Firma ohne aktive E-Mail: Adresse nach dem erkannten
Muster bilden. Nur das beste Muster, keine Alternativen. Personen ohne
klaren Vor- und Nachnamen werden übersprungen.

### 2.3 Verifizieren

Stufe 1, ohne Netzverkehr zum Zielserver:
- Syntax gültig, Domain hat MX-Einträge (sonst A-Record-Fallback laut RFC).

Stufe 2, SMTP-Prüfung ohne Zustellung:
- Verbindung zum MX mit höchster Priorität, Port 25, STARTTLS wenn
  angeboten, `EHLO verify.<betreiber-domain>`, `MAIL FROM:<>` oder
  `postmaster@<betreiber-domain>`, `RCPT TO:<kandidat>`, danach `QUIT`.
  Es wird nie `DATA` gesendet.
- Antwort 250 = existiert, 550/551/553 = existiert nicht, 4xx = später
  erneut (Greylisting, Wiederholung nach 15 Minuten, maximal 3 Versuche
  über 24 Stunden).
- Catch-all-Erkennung je Domain, einmal pro Lauf: `RCPT TO` an eine
  zufällige, sicher nicht existierende Adresse. Antwortet der Server 250,
  ist die Domain Catch-all. Dann ist keine Adresse verifizierbar, es wird
  nichts gespeichert, die Domain wird 90 Tage nicht erneut geprüft.
- Bekannte Grenzen (Quellen unten): Yahoo/AOL antworten auch für
  deaktivierte Konten mit 250, im B2B-Kontext irrelevant. Teile von
  Microsoft 365 haben die Prüfung gehärtet und antworten uneinheitlich,
  dort gilt „unbekannt“ und es wird nichts gespeichert. Google antwortet
  zuverlässig.
- Drosselung: je Domain maximal eine Verbindung und höchstens fünf
  `RCPT TO` pro Lauf, mindestens zwei Sekunden Abstand, global maximal
  300 Prüfungen pro Tag. Absender-Domain mit gültigem SPF, rDNS/PTR des
  Prüf-Hosts stimmt mit dem EHLO-Namen überein.

### 2.4 Speichern und Anzeigen

- Verifiziert: neuer Fakt `email` an der Person mit `source =
  "pattern:smtp"`, Konfidenz aus Muster × Verifizierung, dazu eine
  Observation mit Evidenz „abgeleitet aus Muster vorname.nachname (Beleg:
  john.doe@example.com), SMTP 250 am 2026-09-10 von mx1.example.com“.
- Nicht verifiziert oder unbekannt: kein Fakt. Der Kandidat bleibt nur in
  der internen Job-Tabelle für den Wiederholungszeitplan.
- Anzeige: Badge „abgeleitet · verifiziert am 10.09.2026“ an der Adresse,
  Tooltip mit Beleg und Muster. Chat-Tools (`company_contacts`,
  `person_herkunft`) liefern `quelle: "abgeleitet+verifiziert"`.
- Herkunftsbericht (Art. 15) und Art.-14-Hinweis nennen die Ableitung
  ausdrücklich: „Adresse nach dem Adressmuster der Firma gebildet und
  technisch auf Existenz geprüft, keine E-Mail zugestellt.“
- Löschen/Tombstone der Person entfernt auch abgeleitete Adressen;
  die Aufbewahrungsfrist der Personen gilt unverändert.

## 3. Wo der Job läuft: lokal auf dem Gerät des Nutzers

Vorgabe (Operator 2026-09-10, Compute-Lokalität): Mustererkennung,
Kandidatenbildung und SMTP-Prüfung laufen auf dem Rechner des Nutzers,
nur für die Firmen des Nutzers, und nur wenn Kapazität frei ist. Der
Server bekommt keine Aufgabe, er speichert lediglich Ergebnisse, wie
heute bei den Kontakten („einer verarbeitet, alle profitieren“).

### 3.1 Lokaler Hintergrund-Job („im Hinterkopf“)

- Neuer Supervisor im Desktop-Hauptprozess, Muster wie
  `freshness-scheduler.ts` und der Radar-Sofortmodus: Tick alle 15
  Minuten, Single-Flight, pausiert bei aktivem Chat-Turn, bei laufenden
  Producern mit hoher Last und im Akkubetrieb unter 30 Prozent.
- Je Tick genau EINE Firma aus dem Bestand des Nutzers: Auswahl nach
  „Beschäftigungen vorhanden, mindestens eine Person ohne E-Mail, Domain
  seit 30 Tagen nicht geprüft“, zufällig gemischt, damit nicht alle Nutzer
  dieselbe Domain zur selben Zeit prüfen.
- Ablauf je Firma: Muster ableiten (2.1) aus den Kontakten, die der
  Nutzer ohnehin sieht (`company_contacts`), Kandidaten bilden (2.2),
  Catch-all-Test, dann höchstens fünf `RCPT TO`-Prüfungen, Ergebnisse
  ans Gateway melden (3.3). Danach Tick beendet.
- Tages-Deckel je Gerät 50 Prüfungen, Abstand zwischen `RCPT TO`
  mindestens zwei Sekunden, eine Verbindung je Domain.
- Ein-/Ausschalter in den Einstellungen unter Kontakte, Standard an,
  plus Chat-Tool (`email_muster_config`) nach dem Self-Service-Prinzip.
  Statusanzeige: „zuletzt geprüft: Firma X, 2 Adressen verifiziert“.

### 3.2 Port 25 vom Nutzergerät: die eigentliche Hürde

Viele Privat- und Firmennetze blockieren ausgehenden Port 25 (Telekom,
Vodafone-Kabel, viele Gäste-WLANs, Firmen-Firewalls). Dynamische IPs
haben schlechte Reputation, einige Mailserver lehnen sie pauschal ab
oder greylisten.

- Beim Start des Jobs ein Erreichbarkeitstest: TCP-Verbindung zu zwei
  bekannten MX-Hosts (z. B. dem MX der Betreiber-Domain und einem großen
  Anbieter) mit fünf Sekunden Timeout, `EHLO`, `QUIT`. Schlägt er fehl,
  ist der Job auf diesem Netz still gestellt und die Einstellungen zeigen
  „SMTP-Prüfung in diesem Netz nicht möglich (Port 25 gesperrt)“. Der Test
  wird bei Netzwechsel wiederholt.
- `EHLO` mit dem Hostnamen des Geräts ist unglaubwürdig; verwendet wird
  ein neutraler Name (`ava-check.local`), `MAIL FROM:<>`. Antworten mit
  4xx zählen als „unbekannt“, keine Wiederholungsschleife auf dem Gerät.
- Ergebnisqualität von Heimnetzen ist schlechter als von einem
  dedizierten Host. Das ist der Preis der Lokalität: Adressen, die von zu
  Hause nicht verifizierbar sind, werden schlicht nicht angezeigt.
- Optional und getrennt zu entscheiden: ein externer Verifizierungsdienst
  als Fallback vom Gerät aus (Anfrage direkt vom Nutzer an den Dienst,
  Schlüssel der Organisation wie bei Apify). Personenbezogene Kandidaten
  gehen dann an Dritte; Auftragsverarbeitung nötig.

### 3.3 Was der Server macht

Nur speichern und teilen, keine Verarbeitung:
- `EmailPattern` je Domain (Muster, Konfidenz, Belege, Catch-all-Datum,
  geprüft von actorId), damit andere Nutzer derselben Firma das Muster
  nicht neu ableiten und Catch-all-Domains überspringen.
- Neue Route `POST /v1/companies/:id/contacts/derived-email`: nimmt je
  Person die verifizierte Adresse samt Evidenz entgegen, prüft Plausibilität
  (Domain passt zur Firma, Person gehört zur Firma, Muster stimmt), legt
  Fakt und Observation an (`source = "pattern:smtp"`, actorId, tenantId).
- Bestehende Retention, Tombstones und Herkunftsbericht greifen
  unverändert.

## 4. Datenschutz

- Rechtsgrundlage berechtigtes Interesse (B2B-Kontaktaufnahme), wie beim
  übrigen Kontaktbestand. Abgeleitete Adressen sind personenbezogene
  Daten; deshalb werden nur verifizierte gespeichert und nur mit klarer
  Herkunft.
- Keine Zustellung, kein `DATA`, kein Inhalt. Die Prüfung ist ein
  Verbindungsaufbau zum Mailserver der Firma, kein Versand.
- Informationspflicht: Der bestehende Art.-14-Prozess (PersonNotice,
  „als informiert markieren“) gilt auch hier, der Hinweistext bekommt
  einen Absatz zur Ableitung.
- Opt-out je Organisation: Schalter „Abgeleitete E-Mail-Adressen nutzen“
  (Standard an), damit Kunden mit strengerer Auslegung abschalten können.

## 5. Umsetzungsphasen

| Phase | Inhalt | Aufwand |
|---|---|---|
| M1 Mustererkennung (Desktop, electron-frei) | `src/main/contacts/email-muster/pattern.ts`: Funktionsadressen-Filter, Namensnormalisierung, Musterkatalog, Bewertung; Tests; Trockenlauf-Tool im Chat („welche Adressen könnte AVA für Firma X ableiten“) ohne Netzverkehr | 1,5 Tage |
| M2 SMTP-Prüfung lokal | `smtp-verify.ts`: MX-Auflösung, Handshake bis `RCPT TO`, STARTTLS, Catch-all-Test, Drosselung, Erreichbarkeitstest Port 25, Fehlerklassen (existiert / existiert nicht / unbekannt / catch-all / gesperrt) | 2 Tage |
| M3 Gateway speichern | Tabelle `EmailPattern`, Route `derived-email` mit Plausibilitätsprüfung, Fakt + Observation mit Evidenz, Herkunftsbericht und Art.-14-Text ergänzt | 1,5 Tage |
| M4 Hintergrund-Supervisor + UI | Tick-Logik mit Vorrang für Chat/Last/Akku, Firmenauswahl, Tages-Deckel, Einstellungen-Schalter + Chat-Tool, Badge „abgeleitet · verifiziert“ im Firmendetail, Statuszeile, Meldung bei neuen Adressen | 2 Tage |

Gesamt etwa 7 Tage. M1 und M2 sind ohne Server-Änderung testbar; M2 lässt
sich mit dem eigenen Netz sofort auf Port-25-Erreichbarkeit prüfen.

## 6. Risiken

- Catch-all ist bei kleinen Hosting-Paketen im DACH-Raum verbreitet; dort
  ist nichts verifizierbar. Realistische Abdeckung 40 bis 60 Prozent der
  Musterkandidaten.
- Server, die erst annehmen und später abweisen („accept-then-bounce“),
  erzeugen falsch positive Treffer. Ein späterer Bounce beim echten
  Versand über AVA sollte den Fakt deaktivieren.
- Port 25 ist in vielen Nutzernetzen gesperrt; dort liefert der Job
  nichts. Der Erreichbarkeitstest macht das sichtbar statt still zu
  scheitern.
- Dynamische Heim-IPs werden von manchen Mailservern abgelehnt oder
  gegreylistet; die Drosselung (5 je Domain, 50 je Tag) hält das Gerät
  von Blocklisten fern.
- Musterfehler bei Namensbesonderheiten (Doppelnamen, Umlaute, Spitznamen
  wie „Alex“). Die Verifizierung fängt das ab, kostet aber Prüfungen.

## 2.5 Beständigkeit (Operator 2026-09-10)

- Eine verifizierte Adresse wird nie erneut geprüft. Der Job betrachtet nur
  Personen OHNE aktive E-Mail; vorhandene Fakten bleiben unangetastet.
- Erneut geprüft wird eine Domain nur, wenn die Frist abgelaufen ist (30
  Tage, Catch-all 90 Tage) ODER neue Belege aufgetaucht sind. Widerspricht
  ein neuer Beleg dem gespeicherten Muster, wird das Muster neu abgeleitet;
  das alte bleibt als „vorher“ im Server-Datensatz (Formatwechsel der
  Firma). Bereits verifizierte Adressen des alten Formats bleiben gültig,
  sie existieren ja nachweislich.
- Wortlaut bei gesperrtem Port 25: „Mail-Prüfung in diesem Netz nicht
  möglich“. Kein externer Fallback-Dienst.

## 7. Entscheidungen (2026-09-10, umgesetzt in v0.1.627)

1. Kein externer Verifizierungsdienst. Geht es im Netz nicht, geht es nicht.
2. Ein Beleg reicht (Konfidenz 0,6, sichtbar im Server-Datensatz).
3. Tick alle 15 Minuten, eine Firma je Tick, 50 Prüfungen je Gerät und Tag.
4. Schalter je Nutzer (Einstellungen → Automatisierungen → E-Mail-Ableitung,
   Chat-Tool `email_muster_config`), Standard an.
5. Muster und Catch-all-Befunde werden wie Kontakte geteilt (`EmailPattern`).

Umsetzung: Desktop `src/main/contacts/email-muster/` (pattern.ts,
smtp-verify.ts, supervisor.ts), Chat-Tools `email_muster_status/_config/
_vorschau/_jetzt`, Badge „abgeleitet · verifiziert“ im Firmendetail,
Tests `npm run test:email-muster`. Gateway: Routen `/v1/email-patterns/:domain`
(GET/PUT) und `POST /v1/companies/:id/contacts/derived-email`, Art.-14-Text.

## 7a. Nachvollziehbarkeit (v0.1.629)

Jede Adressprüfung landet lokal im Verlauf (`email-muster.json`, max. 500 Einträge,
jüngste zuerst): Zeitpunkt, Firma, Person, Adresse, Muster, Ergebnis
(verifiziert / abgelehnt / unklar / Catch-all / Netz gesperrt), ob am Server
gespeichert, SMTP-Antwort, ggf. Speicherfehler. Sichtbar an drei Stellen:

- Einstellungen → Automatisierungen → E-Mail-Ableitung: Tabelle mit Filter-Chips
  (Alle / Gespeichert / je Ergebnis), Link zur Firma, aufklappbare Domain-Liste
  mit Muster, Belegen, letzter und frühester nächster Prüfung.
- Chat: `email_muster_verlauf` (Filter `nur`, `companyId`, `limit`); `email_muster_status`
  nennt die letzten zehn Prüfungen.
- Kontaktkarte: Badge „abgeleitet · verifiziert TT.MM.JJ“ mit Prüfdatum, Tooltip
  zeigt Muster, Beleg, MX und SMTP-Antwort aus dem Herkunftstext der Beobachtung.

## 8. Ursprünglich offene Entscheidungen (historisch)

1. Externer Verifizierungsdienst als optionaler Fallback vom Gerät aus
   (Org-Schlüssel wie bei Apify), wenn Port 25 gesperrt ist: ja/nein?
2. Mindestbelege für ein Muster: ein Beleg (mehr Abdeckung) oder zwei
   (weniger Fehlversuche)? Empfehlung: ein Beleg, Konfidenz sichtbar.
3. Tick alle 15 Minuten, eine Firma je Tick, Tages-Deckel 50 je Gerät?
4. Schalter je Nutzer mit Standard „an“, zusätzlich Org-Vorgabe zum
   Abschalten?
5. Sollen Muster und Catch-all-Befunde organisationsübergreifend geteilt
   werden (wie Kontakte) oder nur innerhalb der Organisation?

## Quellen

- SMTP-Prüfung, Catch-all, Greylisting und Anbieter-Eigenheiten:
  https://www.emailverify.io/blog/smtp-verification/ ·
  https://bulkemailchecker.com/blog/how-smtp-verification-works/ ·
  https://bulkemailchecker.com/blog/email-greylisting-verification-unknown-results/ ·
  https://mailtester.com/blog/telnet-style-smtp-check-for-email-verification/ ·
  RFC 6647 (Greylisting): https://datatracker.ietf.org/doc/html/rfc6647
- Mustererkennung, Musterkatalog, Catch-all-Handling:
  https://github.com/apifyforge/email-pattern-finder ·
  https://howtofindanyonesemail.com/blog/email-address-formats/
- Fly.io und ausgehender Port 25:
  https://community.fly.io/t/outbound-port-25-direct-to-mx-smtp-blocked-by-default-on-new-accounts/28537
