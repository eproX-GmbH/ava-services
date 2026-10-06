# Auffrischung der Firmenliste (Heartbeat), Stand 2026-10-04

Anlass: Ein Nutzer vermisste Neuverarbeitungen seiner Firmen. Befund an
seinen Daten: Der Frische-Planer (`main/agent/freshness-scheduler.ts`) las
seine Kandidaten nur aus den 25 neuesten Transaktionen. Bei 70 Transaktionen
sah er 11 von 43 Firmen; bei den übrigen 32 waren Website, Profil, Kontakte
und Bewertung ausnahmslos überfällig.

## Umsetzung (v0.1.748)

- **Kandidaten aus der ganzen Firmenliste:** `GET /v1/companies/matrix`
  seitenweise (200 je Seite, bis 10.000 Firmen). Angehaltene (`held`) und im
  Register geschlossene Firmen sind ausgenommen. Für den Retry genügt jede
  Transaktion der Firma.
- **Priorität:** Überfälligkeit in Takten × Relevanzfaktor × Merkliste ×
  frisches Interesse. Relevanzfaktor aus dem Rang (0–10): ab 9 ×3, ab 7 ×2,
  ab 4 ×1,5, sonst ×1. Die Überfälligkeit wächst täglich, deshalb kommen auch
  kalte Firmen sicher an die Reihe; heiße nur früher. Nie gelaufene Stufen
  zählen wie drei Takte überfällig, damit nicht laufbare Zellen nicht die
  Spitze blockieren.
- **Fehlversuch:** Schlägt ein Retry fehl (z. B. Profil ohne Website), ruht
  die Zelle 24 Stunden.
- **Takte (Standard):** Website, Profil, Kontakte 7 Tage; Bewertung 14;
  Registerauszug 30; Jahresabschluss **30** (vorher 75, passend zur
  30-Tage-Sperre der Producer). Gespeicherte 75 werden auf 30 umgestellt,
  eigene Werte bleiben.
- **Drossel unverändert:** 3 Neuanstöße je Stufe und 10 insgesamt pro Stunde,
  5 je Takt (30 Minuten).

## Bewertung (v0.1.751)

Die Bewertung wird in Firmenmatrix und Pipeline aus den Vorstufen abgeleitet
und läuft mit, sobald eine Vorstufe neu läuft. Ein eigener Anstoß setzt nur
„läuft“, das nie abgeschlossen wird (Zeitwächter → failed, 29 Fälle an einem
Tag bei einem Nutzer). Deshalb: Planer und Aufräumer stoßen die Bewertung
nie einzeln an, Takt-Standard 0 (gespeicherte 14 werden migriert), kein
Eintrag mehr in den Einstellungen.

## Alarme über alle Firmen (v0.1.752, 2026-10-05)

Befund (Patrick, 43 Firmen): Die Auffrischung lief seit v0.1.748 über die
ganze Firmenliste, der **Herzschlag für Alarme** aber noch über die 20
jüngsten Transaktionen. Patricks jüngste 20 Transaktionen (Verflechtungen,
Einzelrecherchen) deckten 7 seiner 43 Firmen; für 36 Firmen konnte es nie
eine Meldung geben. Außerdem kannte der Herzschlag nur zwei Quellen
(Geschäftsführer-Wechsel, Publikationen); Stellenwechsel wurden nie bewertet.

- **Kandidatenquelle** (`real-candidate-source.ts`): Firmenliste aus
  `/v1/companies/matrix` (seitenweise, Namen gleich mit), dann
  `POST /v1/alerts/neuheiten` in Bündeln zu 300 Firmen. Ein Aufruf je Bündel
  statt drei je Firma.
- **Gateway `POST /v1/alerts/neuheiten`** (`routes/v1/alerts-neuheiten.ts`):
  `{ companyIds, since }` → alle Neuheiten seit `since` (gedeckelt auf 30 Tage):
  `profile-change` (ProfileChangeEvent, jetzt auch Name, Rechtsform, Anschrift,
  Stammkapital, Gegenstand: der structured-content-Persist diffte bisher nur
  Geschäftsführer), `publication` (nach Eingang), `contact-change`
  (SignalEvent der Kontakt-DB: Stellenwechsel, Arbeitgeberwechsel, geänderte
  Firmen-Telefon/-E-Mail) und `new-contacts` (neue Beschäftigungen je Firma zu
  EINEM Eintrag gebündelt, sonst flutet ein Re-Crawl den Judge).
- **Grundregel: Ein Erst-Crawl führt nie zu einer Neuheit**, egal welche
  Daten er bringt. Jede Quelle prüft, ob die Firma vor `since` dort schon
  Bestand hatte (Publikationen, Ansprechpartner); Registerereignisse
  entstehen im Persist ohnehin nur mit Bestand.
- **Neue Alert-Art `contact-change`** („Kontakt-Wechsel“).
- **Judge** (`alert-judge.ts`): Leitfrage „Was könnte DIESEN Nutzer
  interessieren, und ist jetzt der Moment?“ Nutzerprofil vollständig (Bio,
  Rolle, Branchen, Regionen, Themen, eigene Signal-Interessen, ICP) plus
  Beziehung zur Firma (Relevanz-Rang, Fokuskunde) aus dem Herzschlag. Regeln
  für Kontakt-Wechsel (Weggang Entscheider = warn, neuer Entscheider = info/warn,
  GF-Ebene = urgent; Sachbearbeitung nicht) und Stammdaten (Umfirmierung/
  Rechtsform = warn, Umzug = info). Nicht alarmwürdig: Telefon/E-Mail der
  Zentrale, Titel-Umformulierungen ohne Funktionswechsel.
- Bewertung bleibt lokal (Compute-Lokalität); das Gateway sammelt nur.

### Zeitbezug (v0.1.753, 2026-10-05)

Befund: „Nils Frohloff übernimmt Geschäftsführung bei Strategic IT“, obwohl er
seit 2006 Gründer und Geschäftsführer ist. Die Meldung kam aus einem
Titel-Wechsel „Gründer“ → „Geschäftsführer“ (verschiedene Website-Seiten
nennen ihn verschieden); `startDate` 2009 lag in der Datenbank.

- **Regel:** Eine Meldung muss in zeitlichem Zusammenhang stehen. Ist der
  Beginn einer Position belegt (seit/startDate, aus Website „seit …“ oder
  LinkedIn-Erfahrung über Apify) und älter als 180 Tage, oder ist das
  Fenster, in dem der Wechsel passiert sein kann, breiter als 180 Tage,
  erscheint nichts. Das greift im Gateway vor dem Judge (kein LLM-Aufruf).
- **Fenster:** Kontakt-Wechsel = letzte Beobachtung des alten Werts bis
  Beobachtung des neuen; Registerwechsel = letzte Bestätigung des alten
  Registerstands (`ProfileChangeEvent.bestandVon`, neue Spalte) bis Persist.
- **Schreibweisen:** Umformulierungen derselben Rolle (nur Buchstaben
  verglichen) und Hin-und-her zwischen zwei Schreibweisen derselben Person
  sind keine Wechsel.
- **Judge:** Regel (c) „Zeitlicher Zusammenhang“; jeder Kandidat nennt
  „belegt seit …“ oder „zwischen A und B“.
- **Nachgeschärft 2026-10-06** (Befund: fünf Meldungen zu Personen, die seit
  Jahrzehnten im Amt sind): Eine Kontakt-Meldung braucht einen POSITIVEN
  Beleg für Aktualität. Titelwechsel: belegter Beginn im Fenster, oder ein
  echter Übergang auf der Website (alter Wert zuletzt gesehen, BEVOR der neue
  erstmals auftauchte, beides im Fenster). Stehen beide Werte nebeneinander
  (verschiedene Seiten derselben Website), ist es kein Wechsel. Neue
  Ansprechpartner: nur mit belegtem, aktuellem Beginn; „erstmals gesehen“
  heißt nur, dass AVA die Person jetzt gefunden hat. Registerwechsel ohne
  bekanntes Fenster (Altbestand ohne `bestandVon`) werden nicht gemeldet.
- **Positionen je Firma (Desktop):** Die Kontakte-Route liefert für eine
  Person auch Fakten anderer Firmen (für Name und Profil). Position,
  Abteilung und Beginn werden seit v0.1.753 nur aus Fakten DIESER Firma
  genommen (`nurRollenDieserFirma`), sonst stand bei Joyce an der Strategic
  IT die Position ihrer eigenen Firma QUIKK.

Offen: Sichtbarkeit der laufenden Auffrischung in Liste/Detail/Chat
(„zuletzt geprüft“, Tagesbericht), Insolvenz/Status laufen weiter über den
Status-Wächter.

## Grenzen

- Im Worker-Modus ruht die Auffrischung bewusst; auf einem reinen
  Worker-Rechner werden eigene Firmen erst wieder aufgefrischt, wenn AVA
  normal läuft.
- Ohne Relevanz-Erfassung (Opt-out) zählt nur die Überfälligkeit.
