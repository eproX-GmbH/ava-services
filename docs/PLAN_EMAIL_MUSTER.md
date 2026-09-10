# Plan: Abgeleitete E-Mail-Adressen für Kontakte (Muster + Verifizierung)

Stand 2026-09-10. Idee des Operators: Ist von einer Firma eine persönliche
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

## 3. Wo der Job läuft

Der Kontaktbestand ist zentral im Gateway (Entscheidung „einer
verarbeitet, alle profitieren“). Mustererkennung und Kandidaten sind reine
Datenbankarbeit im Gateway. Die SMTP-Prüfung braucht ausgehenden Port 25
und eine saubere Absender-Reputation:

- **Fly.io** blockiert ausgehenden Port 25 standardmäßig, Freischaltung
  auf Anfrage. Fly-IPs sind geteilt, Reputation nicht steuerbar. Machbar,
  aber riskant für Blocklisten.
- **Kleiner dedizierter Prüf-Host** (z. B. Hetzner, eine feste IPv4 mit
  rDNS, SPF-Eintrag für die Prüf-Domain) mit einem schlanken Dienst, der
  vom Gateway Prüfaufträge holt und Ergebnisse zurückmeldet. Empfehlung.
- **Externer Verifizierungsdienst** (ZeroBounce, NeverBounce, Hunter u. a.):
  je Prüfung 0,5 bis 1 Cent, Auftragsverarbeitung nötig, personenbezogene
  Kandidaten gehen an Dritte. Nur als optionale Ergänzung.

Job-Steuerung als Gateway-Cron (Muster `billing-cron.ts`): wöchentlicher
Lauf über alle Firmen mit Beschäftigungen, Priorität nach „Personen ohne
E-Mail bei bekanntem Muster“, Wiederholung je Domain frühestens nach 30
Tagen, Catch-all-Domains nach 90 Tagen, Metriken (Muster erkannt,
Kandidaten, verifiziert, abgelehnt, unbekannt, Catch-all) im Audit.

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
| M1 Mustererkennung | `lib/email-pattern.ts` im Gateway: Funktionsadressen-Filter, Namensnormalisierung, Musterkatalog, Bewertung, Tabelle `EmailPattern`; Trockenlauf-Report über den Bestand (wie viele Domains mit Muster, Kandidaten) ohne Netzverkehr | 2 Tage |
| M2 Prüf-Host | Schlanker Verifier-Dienst (Node, `smtp`-Handshake selbst implementiert, kein Versand), Auftrags-Queue im Gateway (`EmailVerifyJob`), Catch-all, Greylisting-Wiederholung, Drosselung, Ergebnis-Rückmeldung | 3 Tage |
| M3 Persist + Anzeige | Fakt/Observation mit Quelle und Evidenz, Badge und Tooltip im Firmendetail, Chat-Tools, Herkunftsbericht und Art.-14-Text, Löschen | 1,5 Tage |
| M4 Cron + Steuerung | Wöchentlicher Lauf, Prioritäten, Wiederholungsfristen, Metriken, Org-Schalter, Meldung „X Adressen abgeleitet“ | 1 Tag |

Gesamt etwa 7 bis 8 Tage. M1 lässt sich sofort starten und liefert den
Trockenlauf-Report als Entscheidungsgrundlage für M2.

## 6. Risiken

- Catch-all ist bei kleinen Hosting-Paketen im DACH-Raum verbreitet; dort
  ist nichts verifizierbar. Realistische Abdeckung 40 bis 60 Prozent der
  Musterkandidaten.
- Server, die erst annehmen und später abweisen („accept-then-bounce“),
  erzeugen falsch positive Treffer. Ein späterer Bounce beim echten
  Versand über AVA sollte den Fakt deaktivieren.
- Reputation des Prüf-Hosts: zu viele Prüfungen führen auf Blocklisten.
  Deshalb die Drosselung und ein eigener Host.
- Musterfehler bei Namensbesonderheiten (Doppelnamen, Umlaute, Spitznamen
  wie „Alex“). Die Verifizierung fängt das ab, kostet aber Prüfungen.

## 7. Offene Entscheidungen

1. Prüf-Host: eigener kleiner Server (Empfehlung) oder Fly mit
   freigeschaltetem Port 25?
2. Externer Verifizierungsdienst als Fallback für „unbekannt“: ja/nein?
3. Mindestbelege für ein Muster: ein Beleg (mehr Abdeckung) oder zwei
   (weniger Fehlversuche)? Empfehlung: ein Beleg, aber Konfidenz sichtbar.
4. Laufrhythmus wöchentlich, Tages-Deckel 300 Prüfungen?
5. Org-Schalter mit Standard „an“?

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
