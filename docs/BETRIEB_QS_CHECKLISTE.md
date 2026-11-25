# Betrieb: Checkliste für die Qualitätssicherung

Wozu: Fehler, die still im Hintergrund immer wieder auftreten (Worker scheitert, Schleife im
Retry, Cron sendet nichts), sollen auffallen, bevor Nutzer sie merken. Anlass war der
Health-Check vom 25.11.2026: Der deutsche Register-Worker lief seit dem Vorabend ohne einen
einzigen erfolgreichen Job, ohne dass es jemand bemerkte.

Regeln für jede Prüfung:

- **Nur lesen.** Datenbank nur in `BEGIN READ ONLY`, keine schweren Abfragen ohne Zeitfilter auf
  großen Tabellen (geteilte MPG, max. 100 Verbindungen). Jede Reparatur (Neustart, Deploy,
  Daten ändern) erst nach Okay.
- **Befund mit Beleg:** Zahl, Zeitraum, Fundstelle (Log-Zeile, Abfrage).
- **Ziel ist Automatik:** Was hier zweimal von Hand geprüft wurde, wird ein Betreiber-Alarm
  (Telegram/Mail über `betreiberMelden`), siehe Abschnitt „Automatisieren“.

Zugriff (wie bisher): `fly ssh console -a ava-db-gateway` mit kleinem Node-Skript (base64,
`BEGIN READ ONLY`, danach Datei löschen); Logs über `fly logs -a <app> --no-tail` (nur die
letzten rund 100 Zeilen).

## Täglich (5 Minuten, Kandidat für Automatik)

| # | Prüfung | Gut | Alarm |
|---|---|---|---|
| T1 | **Register-Worker DE**: `RegisterJob` erledigt/fehlgeschlagen je Stunde, letzte 12 h | jede Stunde Erfolge, Fehler selten | 2 h ohne Erfolg, oder Fehlerquote > 20 % |
| T2 | **Worker-Maschine**: `fly ssh console -a ava-register-worker -C "free -m; ps -eo comm \| sort \| uniq -c"` | verfügbarer Speicher > 300 MB, höchstens 1 chromedriver | < 100 MB frei, mehrere chromedriver (Browser-Leck) |
| T3 | **Gateway-Log**: Warnungen/Fehler gruppiert (`"level":40/50`) | keine Wiederholung derselben Meldung | dieselbe Meldung für dieselbe Firma mehrfach je Stunde (Schleife) |
| T4 | **Persist-Bus**: `curl https://ava-db-gateway.fly.dev/health/persist` | `ok: true`, alle Bindungen aktiv | `ok: false`, Bindung inaktiv, `letzterFehler` gesetzt |
| T5 | **Betreiber-Alarme** (Telegram/Mail) gelesen und erledigt | keine offenen | Alarm älter als 1 Tag unbeantwortet |
| T6 | **Problem-Meldungen** der Nutzer (Konsole, Betreiber → Meldungen) | keine im Status „neu“ älter als 2 Tage | Meldungen „neu“ älter als 2 Tage |

## Wöchentlich (30 Minuten)

| # | Prüfung | Gut | Alarm |
|---|---|---|---|
| W1 | **Job-Warteschlange**: offene Jobs je Art (`front`, `refresh`, `insolvenz`, `bekanntmachungen`), Jobs „läuft“ auf gestoppten Workern | Rückstand sinkt oder bleibt stabil | Rückstand wächst Woche für Woche; „läuft“ ohne laufenden Worker |
| W2 | **Meldungen für Nutzer entstehen**: `ProfileChangeEvent` und `RegisterSnapshot` je Tag | jeden Tag Einträge, solange Register-Jobs Änderungen melden | Register-Jobs melden `geaendert`, aber 2 Tage keine Ereignisse |
| W3 | **Neuigkeiten-Mail**: Log-Zeile `[neuigkeiten-cron] Takt` (konten, ohneFirmen, nichtsNeues, gesendet), `MailVersand` je Art/Status | Takt jede Stunde, Mails an Konten mit Firmen | kein Takt; `ohneFirmen` bei Konten, die Firmen haben; Status `fehler` |
| W4 | **Retry-Schleifen**: Gateway-Log `retry dispatch failed`, `[stuck-reaper]` | Einzelfälle | dieselben Firmen immer wieder (Stufe ohne Aussicht wird endlos neu versucht) |
| W5 | **Fly-Maschinen**: `fly machines list -a <app>` für Gateway, master-data, Register-Worker, Keycloak, pgbouncer | `started`, keine `crash`-Ereignisse | Neustarts/Abstürze, Maschine mit Laufzeit > 14 Tage und wachsendem Speicher |
| W6 | **Datenbank**: Verbindungen je Dienst (`pg_stat_activity`) gegen `max_connections` | deutlich unter 100 | > 80 Verbindungen, ein Dienst ohne Pool-Grenze |
| W7 | **Releases**: offene Kandidaten, Freigabe-Schutz, Web-Repos `main` gegen `staging` | Kandidat freigegeben oder bewusst offen; `main` Vorfahre von `staging` | Kandidat älter als eine Woche; Prod-`/health` ohne `commit` |
| W8 | **AVA-Server (Cloud)**: Betreiber-Alarme des Abgleichs, Prüflauf Server-Posten gegen Stripe | keine Abweichung | „läuft ohne Abrechnung“ oder „wird zu hoch abgerechnet“ |

## Monatlich

| # | Prüfung | Gut | Alarm |
|---|---|---|---|
| M1 | **Datenqualität**: Stichprobe Zeitachse/Meldungen auf Schein-Änderungen (Schreibweisen, Zahlenformate, Rollen-Varianten) | keine | wiederkehrende Muster |
| M2 | **Kosten**: GitHub-Actions-Minuten (macOS zählt 10-fach), Apify, OpenAI, Valueserp, Fly | im Rahmen | Budget-Stopp, Sprung ohne Grund |
| M3 | **Sicherheit**: Dependabot-Warnungen (`critical`/`high`), abgelaufene Tokens (Apify, Stripe-Webhook) | keine kritischen offen | kritische Warnung älter als einen Monat |
| M4 | **Zertifikate und Verträge**: Apple-Notarisierung (Lizenzvertrag), Windows-Signatur, Domains | gültig | Ablauf in < 30 Tagen |
| M5 | **Elastic-Sammelabgleich** am 10.: Lauf im master-data-Log | gelaufen | fehlt |
| M6 | **Sicherung**: MPG-Backups vorhanden, einmal im Quartal Wiederherstellung testen | Backup jünger als 1 Tag | kein aktuelles Backup |

## Bekannte Ursachen und erste Hilfe

- **Register-Worker: „session not created: DevToolsActivePort file doesn't exist“** heißt fast
  immer: Speicher voll durch liegen gebliebene Browser-Sitzungen (Befund 12.10. und 25.11.2026).
  Sofort: Maschine neu starten (nach Okay). Dauerhaft: Sitzungen nach jedem Job hart beenden;
  der Aufräumer `packages/register-delta/src/waisen.ts` greift nur, wenn der Besitzerprozess tot
  ist, nicht bei Lecks im laufenden Worker.
- **Persist-Bus `ok: false`**: Konsument nach AMQP-Neuverbindung weg (Vorfall Sept./Okt. 2026),
  Gateway neu starten nach Okay. Das Staging-Gateway hat absichtlich keine Bindungen.
- **Neuigkeiten-Mail sendet nichts**: erst `ohneFirmen` und Zustimmung (`MailEinstellung`)
  prüfen, dann Mailgun.

## Automatisieren (nächster Schritt)

Ein täglicher Prüflauf im Prod-Gateway, der T1, T3 (Wiederholungen), T4, T6, W1–W4 als Zahlen
erhebt und bei Grenzwert-Verletzung `betreiberMelden` aufruft (je Befund höchstens einmal am
Tag), dazu ein wöchentlicher Bericht mit allen Werten. Vorbild ist der stündliche Prüflauf der
Server-Abrechnung (`cloudPostenPruefenUndMelden`).
