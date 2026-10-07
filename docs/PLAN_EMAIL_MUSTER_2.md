# Plan: E-Mail-Ableitung, Stufe 2 — Zuordnung, LLM-Judge, vollständige Anwendung (2026-10-07)

Baut auf docs/PLAN_EMAIL_MUSTER.md auf (M1–M4 live seit v0.1.627, Catch-all
„unbestätigt“ seit v0.1.631). Anlass: Patricks Befund, dass ein erkanntes
Adressformat nicht auf alle Kontakte angewendet wird.

## 1. Was heute passiert und wo es hakt

Heute (lokaler Hintergrund-Job, alle 15 Minuten eine Firma):

1. Belege = **E-Mail-Fakten an Personen** der Firma, Funktionsadressen per
   fester Liste ausgeschlossen (info, rechnung, hr, …).
2. Muster aus einem festen Katalog (14 Formen), ein Beleg reicht.
3. Kandidaten für Personen ohne E-Mail, höchstens **5 je Durchgang**,
   50 Prüfungen je Gerät und Tag, SMTP-Prüfung.
4. Gespeichert wird nur **verifiziert** (SMTP 250) oder **unbestätigt**
   (Catch-all). Abgelehnt oder unklar: nichts, kein Hinweis in der App.
5. Die Domain wird danach **30 Tage nicht erneut angefasst**, es sei denn,
   neue Belege tauchen auf oder es ist ein Catch-all mit offenen Personen.

Lücken, die Patricks Beispiel (info@, rechnung@, pdettlev@) treffen:

- **A. Zuordnung fehlt.** Steht pdettlev@ als Adresse der *Firma* im Bestand
  (der Extraktor fand sie im Impressum, nicht an einer Personenkarte), ist
  sie kein Beleg. Ohne Beleg kein Muster, nichts passiert. Die Zuordnung
  „pdettlev@ gehört zu Patrick Dettlev“ macht heute niemand.
- **B. Funktionsadressen nur per Liste.** „buchhaltung-nord@“, „pd@“,
  „team-sued@“ und alles Ungewöhnliche entscheidet eine Liste statt ein
  Urteil. Unbekannte Funktionsadressen können ein falsches Muster
  liefern, unbekannte Namensformen werden verworfen.
- **C. Nicht alle Kontakte.** Nach 5 Kandidaten ist Schluss, die Domain
  ruht 30 Tage. Bei 12 Personen ohne Adresse sieht der Nutzer 5 und wartet
  einen Monat auf die nächsten 5.
- **D. Unsichtbare Ergebnisse.** Abgelehnte und unklare Kandidaten
  (Port 25 gesperrt, Greylisting, Microsoft-365-Härtung) tauchen nirgends
  auf. Der Nutzer kann nicht unterscheiden zwischen „nicht abgeleitet“ und
  „abgeleitet, aber nicht prüfbar“.
- **E. Baseline nur im Text.** Welche Adresse das Muster belegt hat, steht
  nur im Evidenztext der Beobachtung, nicht als eigenes Feld.

## 2. Zielbild (Vorgabe 2026-10-07)

1. Firmenweite Adressen werden Personen zugeordnet, wenn Vor- oder
   Nachname im Lokalteil erkennbar ist (pdettlev@, patrick@, dettlev@,
   p.dettlev@). Funktionsadressen (info@, rechnung@) bleiben bei der Firma.
   Die Entscheidung trifft ein LLM-Judge, nicht eine Liste.
2. Aus der zugeordneten Adresse wird das Muster abgeleitet und **sofort auf
   alle** Personen der Firma ohne Adresse angewendet, auch bei Doppelnamen
   (Joyce Marvin Rafflenbeul → jrafflenbeul@).
3. Jede abgeleitete Adresse trägt die Kennzeichnung „abgeleitet“ und die
   **Baseline** (pdettlev@), aus der sie gebildet wurde.
4. Abgeleitete Adressen werden verifiziert; der Stand (verifiziert,
   unbestätigt, ungeprüft, abgelehnt) ist in der App sichtbar.
5. **Entscheidung 2026-10-07:** ALLE Personen bekommen eine abgeleitete
   Adresse angezeigt, auch wenn die Prüfung nicht möglich war, dann klar
   als „abgeleitet · unverifiziert“ mit Verweis auf die Baseline-Adresse.

## 3. Umsetzung

### E1 Zuordnung firmenweiter Adressen zu Personen (LLM-Judge)

- Eingabe je Firma: alle aktiven E-Mail-Fakten der Firma (entityType
  COMPANY) und der Personen plus die Personenliste (Name, Position).
- Stufe 1 deterministisch: Lokalteil enthält Vor- oder Nachname einer
  genau einen Person (Normalform wie in `nameVarianten`) → Treffer.
- Stufe 2 LLM-Judge für den Rest (ein Aufruf je Firma, `generateObject`
  + yup, Kanal background, Quelle „email-zuordnung“): je Adresse
  `{ email, art: "person" | "funktion" | "unklar", personId?, begruendung }`.
  Regeln im Prompt: Nur zuordnen, wenn Vor- oder Nachname erkennbar; bei
  zwei Personen mit gleichem Nachnamen „unklar“; Rollenadressen
  (rechnung, buchhaltung, team, standort) sind „funktion“, auch wenn ein
  Wort wie ein Name aussieht („martin@“ bei einer Firma „Martin GmbH“).
- Ergebnis „person“: Beobachtung + Fakt `email` an der Person mit
  `source = "zuordnung:firma"` und Evidenz „Firmenadresse pdettlev@ nach
  Namensabgleich Patrick Dettlev zugeordnet (Impressum)“. Die Adresse
  gilt als **gefunden** (nicht abgeleitet) und geht in die Verifizierung.
- Läuft im bestehenden Supervisor vor der Mustererkennung; die Zuordnungen
  sind damit sofort Belege.

### E2 LLM-Judge für Muster und Baseline

- Deterministischer Katalog bleibt erste Wahl (billig, nachvollziehbar).
- Der Judge kommt in drei Fällen: kein Katalogmuster erklärt die Belege;
  ein Beleg passt zu mehreren Mustern (z. B. „anna@“); Belege
  widersprechen sich. Ausgabe: `{ muster: <Katalog-Id> | <Vorlage mit
  {v}{vorname}{n}{nachname}>, baseline: <email>, konfidenz, begruendung }`.
  Vorlagen außerhalb des Katalogs werden nur angenommen, wenn sie alle
  Belege reproduzieren (Prüfung im Code, keine Halluzination).
- Baseline = der Beleg, aus dem das Muster stammt, ab jetzt ein eigenes
  Feld (E5).

### E3 Vollständige Anwendung

- Je Firma wird weitergearbeitet, bis **alle** Personen ohne Adresse einen
  Kandidaten haben: Deckel je Durchgang 10 statt 5, die Domain gilt als
  „offen“, solange Personen ohne Adresse übrig sind; die 30-Tage-Ruhe
  greift erst, wenn nichts mehr offen ist.
- Tages-Deckel bleibt 50 je Gerät (Reputation), Abstand 2 Sekunden.
  Reicht er nicht, geht es am nächsten Tag weiter, der Stand zeigt
  „12 von 20 abgeleitet, Rest morgen“.
- Doppelnamen: Vorname = erstes Token, Nachname = letztes Token, wie heute;
  der Judge in E2 kann abweichend „vornamen alle“ wählen, wenn die Belege
  das zeigen.

### E4 Sichtbarkeit aller Zustände

- Neue Art `offen` in `derived-email`: abgeleitet, aber nicht prüfbar
  (Port 25 gesperrt, 4xx, Microsoft-365-Härtung). Gespeichert als Fakt mit
  `source = "pattern:offen"`, Konfidenz 0,4, Badge „abgeleitet ·
  ungeprüft“. Der Job prüft offene Adressen erneut, sobald Port 25
  erreichbar ist oder 24 Stunden vergangen sind, höchstens dreimal; dann
  bleibt „ungeprüft“ stehen.
- Abgelehnt (SMTP 550): kein Fakt, aber Eintrag im Verlauf je Person
  („pdettlev-Muster ergibt hjohnsen@, Server lehnt ab“), sichtbar im
  Tooltip der Personenkarte unter „Datenschutz & Herkunft“.
- Badges: gefunden · verifiziert, zugeordnet · verifiziert (E1),
  abgeleitet · verifiziert, abgeleitet · unbestätigt (Catch-all),
  abgeleitet · ungeprüft, dazu immer der Prüfzeitpunkt.
- Chat-Werkzeuge (`company_contacts`, `person_herkunft`) liefern den Stand
  als `quelle` und `baseline`.

### E5 Baseline als Feld

- `derived-email`-Payload und Beobachtung bekommen `baseline` (Adresse)
  und `musterQuelle` („katalog“ | „judge“). Herkunftstext: „abgeleitet aus
  pdettlev@eprox-gmbh.de (Muster vnachname), verifiziert am …“.
- `EmailPattern.belege` behält alle Belege; `baseline` ist der erste.

### E6 Einstellungen und Chat

- Bestehender Schalter „E-Mail-Ableitung“ bleibt; neu darunter „Firmen-
  adressen Personen zuordnen (LLM)“ (Standard an) und „Ungeprüfte
  Ableitungen anzeigen“ (Standard an). Chat-Tool `email_muster_config`
  um beide Schalter erweitert (Self-Service-Regel).
- Statuszeile: „Letzter Lauf: eproX GmbH — 1 zugeordnet, 2 abgeleitet
  (1 verifiziert, 1 ungeprüft), Baseline pdettlev@“.

### E7 Tests

- Unit: Zuordnung (pdettlev/patrick/dettlev/p.dettlev → Patrick; martin@
  bei „Martin GmbH“ → funktion; zwei Müllers → unklar), Judge-Ausgabe-
  Validierung (Vorlage muss Belege reproduzieren), Vollständigkeit über
  mehrere Ticks, Baseline-Feld, Badges.
- Manuell mit Patricks Firmen nach Freigabe von Port 25 in seinem Netz.

Aufwand: E1–E2 zwei Tage, E3–E5 ein Tag, E6–E7 ein Tag.

## 4. Stand der Umsetzung (v0.1.771, 2026-10-07)

Umgesetzt, Gateway deployt:

- **E1** `contacts/email-muster/zuordnung.ts`: deterministisch (Lokalteil =
  Name, Initial + Name, Name enthalten; genau eine Person) und KI-Urteil
  über den Hintergrund-Kanal (Quelle `email-zuordnung`, Deps `urteil`).
  Zwei Kandidaten → nie zuordnen; Urteil ohne Namensanklang wird verworfen.
  Gespeichert als `zuordnung:<art>` (smtp 0,95 / catchall 0,8 / offen 0,7).
- **E2** `beurteileMuster`: nur wenn der Katalog kein Muster findet oder ein
  einzelner Beleg mehrere zulässt; Vorlagen `{v}{nachname}` erlaubt, nur
  gültig wenn alle Belege reproduziert werden; Muster am Server mit
  `stats.quelle = judge`.
- **E3** 10 Kandidaten je Durchgang, Domain bleibt „offen“ (kein Warten auf
  die 30-Tage-Frist), bis alle Personen versorgt sind. Offene Adressen werden
  höchstens 3-mal im Abstand von 24 h nachgeprüft (`cfg.offen`).
- **E4** Arten `offen` (Konfidenz 0,4) und `abgelehnt` (0,2) am Gateway;
  Badge „abgeleitet · unverifiziert · aus <Baseline>“ bzw. „vom Server
  abgelehnt“; eine offene/abgelehnte Adresse darf durch eine bessere
  Prüfung ersetzt werden (409 nur bei gefundener/verifizierter Adresse).
  Ohne Port 25 läuft der Job jetzt trotzdem und speichert als `offen`.
- **E5** Baseline im Herkunftstext („Abgeleitet aus pdettlev@… nach
  Adressmuster vnachname“), im Verlauf (`baseline`) und in der Vorschau.
- **E6** Schalter `zuordnungAktiv` und `ungeprueftAnzeigen` (beide Standard
  an) in Einstellungen → E-Mail-Ableitung und im Tool `email_muster_config`.
- **E7** `npm run test:email-zuordnung` (Zuordnung, Judge-Reproduktion,
  Vorlagen); bestehende Muster-Tests unverändert grün.

Beantwortete Rückfragen: 2 ja (Standard an, abschaltbar), 3 ja
(Hintergrund-Kanal), 4 ja (nur eindeutig). Offen: 1 (Port-25-Stand bei
Patrick, nebenbei klären; mit E4 sichtbar, da Adressen jetzt auch ohne
Prüfung erscheinen).
