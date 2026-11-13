# Plan: Burggraben — Abstand zu Wettbewerbern und Frontier-Modellen ausbauen

Stand 2026-11-12. Anlass: Challenge-Gespräch mit Joyce („Burggraben tiefer buddeln“).

## 1. These

- Der Chat-Agent (Werkzeuge, Sprachmodus, Telegram, generative UI) ist kein Graben. Claude,
  ChatGPT und Copilot bauen das mit mehr Budget selbst. Jede Stunde in der Breite des Agenten
  konkurriert mit den Labs auf deren Heimspielfeld.
- Der Graben ist der **Firmengraph mit Zeitachse**: Register-Delta täglich, Insolvenzen,
  Gesellschafterlisten, Jahresabschlüsse, Kundenreferenzen, Stellen. Ein Modell kann
  nachschauen, was eine Firma heute ist; es kann nicht wissen, was sich in den letzten 18
  Monaten geändert hat, wenn niemand es damals beobachtet hat. Beobachtungen lassen sich
  nicht nachträglich scrapen.
- Dazu **Compliance** (lokale Verarbeitung, eigenes Modell, Herkunft je Fakt, Art. 14, Audit,
  EU) und **Push statt Pull**: Wer dem Nutzer morgens schreibt, besitzt die Beziehung, nicht
  wer als Werkzeug in Claude hängt.
- Ehrliche Schwachstelle: Die Datenbank kippt bei CREATE INDEX, Skandinavien ruht deshalb,
  Meldungen liefen bisher nur mit laufender Desktop-App.

## 2. Befund im Code (2026-11-12)

- Registerdaten (`StructuredContent`, `ManagingDirector`) werden per Replace-All
  überschrieben; nur Diffs einzelner Felder landen in `ProfileChangeEvent`
  (Geschäftsführung, Name, Rechtsform, Adresse, Kapital, Gegenstand). Keine Historie für
  Gründungsjahr, Registerdaten, Officers; kein vollständiger alter Stand.
- Kontakte haben einen echten Beobachtungs-Ledger (`Observation`, `SignalEvent`).
- Mail-Infrastruktur (Mailgun, Double-Opt-in, Vorlage `neuigkeitenMail`) steht; ausgelöst
  wurde die Neuigkeiten-Mail nur vom Desktop-Heartbeat.
- Pool-Treffer kosten dasselbe wie Frischverarbeitung (Frisch-Pfad = Stufe des Pool-Datensatzes).
- „Stammdaten mitpflegen“ ist Opt-in ohne sichtbaren Gegenwert.

## 3. Action Points und Stand

| Nr. | Punkt | Stand |
|---|---|---|
| 1 | **Register-Snapshots statt Replace-All.** Tabelle `RegisterSnapshot` (Gateway-DB): vor jedem Überschreiben bleibt der ganze alte Stand mit `felder` (was abweicht), `bestandVon`, `ersetztAm`. Route `GET /v1/companies/:id/register-verlauf`, MCP-Bereich `verlauf` in `firma_lesen`. | **gebaut 2026-11-12** (`lib/register-verlauf.ts`, Persist-Hook in `schreibeStructuredContent`, Migration `20261112_register_verlauf`) |
| 2 | **Neuigkeiten-Mail serverseitig.** Stündlicher Gateway-Takt, 06–10 Uhr Berlin, regelbasiert ohne KI-Urteil; nur wenn die AVA des Nutzers seit 24 h still ist (`NutzerAktivitaet.appZuletztAt`) und seit 20 h keine Neuigkeiten-Mail ging. Quellen wie Heartbeat (`sammleNeuheiten`), ohne new-contacts. | **gebaut 2026-11-12** (`lib/neuigkeiten-cron.ts`, `NEUIGKEITEN_CRON_DISABLED=1`), KI-Urteil über Betreiber-Spur offen |
| 3 | **Pool-Preisstufe.** Eigene, günstigere Stufe für Pool-Treffer in `lib/stufen.ts`, vor dem Import sichtbar („3 von 5 sind schon da“). | offen (Preisentscheidung Joyce) |
| 4 | **Mitpflegen Standard bei bezahlten Sitzen** mit sichtbarem Gegenwert, Opt-out bleibt, 60/h bleibt. | offen (Policy-Entscheidung) |
| 5 | **D14 in DECISIONS.md:** neue Chat-Werkzeuge nur, wenn sie Ledger, Pool, Push, Vertriebsgedächtnis oder Connector-Reichweite dienen. | **geschrieben 2026-11-12** |
| 6 | **Zeitachse je Firma**: gemeinsame Ereignissicht (Register-Snapshots, ProfileChangeEvent, SignalEvent, Insolvenz, Publikationen, Kunden, Stellen) als Bereich `zeitachse` und Reiter in der Firmenansicht. | offen |
| 7 | **Onboarding-Kette schließen** (Double-Opt-in über Willkommensmail, Start-Workflow Top 10). | offen, siehe docs/PLAN_ONBOARDING.md |
| 8 | **Alles exportieren** (Firmen, Notizen, Protokolle, Buying Center, Relevanz) als Chat-Werkzeug und in den Einstellungen; Art. 20. | offen |
| 9 | **Connector-Verzeichnisse** (ChatGPT Apps SDK, Claude), Copilot-Studio-Live-Test. | offen |
| 10 | **Pool vorwärmen je Vertriebsstoß** über die Vorabanalyse, in kleinen Paketen. | offen (Betrieb) |
| 11 | **Qualitäts-Benchmark** gegen North Data / Dealfront (200 Firmen), Ergebnis auf die Website. | offen |
| 12 | **DB-Upgrade terminieren** (Index-Aufbau, Skandinavien), siehe docs/PLAN_PGBOUNCER.md. | offen |

## 4. Entwurfsentscheidungen zu 1 und 2

- Snapshot nur bei Abweichung irgendeines Felds (normalisiert: Leerraum, Groß/Klein, Zahl,
  Datum; Geschäftsführung als Namensmenge). Ein Lauf ohne Geschäftsführer lässt die alte
  Liste stehen (Data-loss guard), der Vergleich nimmt dann die alte Liste als neuen Stand.
  Leerer neuer Wert zählt als Änderung: der alte Stand bleibt so erhalten.
- Schreiben best-effort nach dem COMMIT, wie `ProfileChangeEvent`. Nie löschen.
- Server-Mail nie parallel zur App: Läuft die AVA (letzte Anfrage von Desktop/Server unter
  24 h), bleibt der Desktop-Takt mit Urteil zuständig. Browser- und MCP-Anfragen zählen nicht
  als „AVA läuft“ (`istAppGeraet`).
- Kein KI-Urteil im Cron: Register-, Publikations- und Kontaktereignisse sind regelbasiert
  meldenswert; neue Ansprechpartner (Bündel) nicht. Doppelte Zeilen je Firma, Art und Titel
  werden verworfen, höchstens zwölf je Mail (Deckel der Vorlage).
- Bekannte Lücke: Kommt die App nach einer Server-Mail zurück, kann der Desktop-Takt
  einzelne Meldungen aus demselben Fenster noch einmal mailen (seine Marke `neuigkeitenBis`
  kennt die Server-Mail nicht). Die 20-Stunden-Sperre über `MailVersand` begrenzt das auf
  eine Mail.
- Prüfung: `pnpm -F @ava/db-gateway test:burggraben` (Felder-Diff, Cron-Entscheidung,
  Neuheiten → Meldungen).
