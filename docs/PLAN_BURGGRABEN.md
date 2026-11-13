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
| 4 | **Mitpflegen Standard bei bezahlten Sitzen** mit sichtbarem Gegenwert, Opt-out bleibt, 60/h bleibt. | **gebaut 2026-11-13** (G1; AGB-Satz offen, siehe 5.3) |
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

## 5. Vorschlag zu Punkt 3 und 4 (2026-11-13, zur Entscheidung)

### 5.1 Ausgangslage im Code

- Zugangspreis je Bestandsfirma und Monat: 0,50 / 1,00 / 1,50 € (klein / mittel / groß,
  `lib/stufen.ts`, Env `STUFE_PREIS_*_CENTS`). Kontingent je Sitz: Pro 49 €, Max 149 €,
  Ultra 299 € (`docs/PLAN_PRICING_TIERS.md`).
- Direktkosten je Stufe (`lib/kalkulation.ts`, `direktJeStufe()`):

  | Stufe | einmalig (Erstverarbeitung) | laufend je Monat (Auffrischung) | je Bestandsfirma und Monat |
  |---|---|---|---|
  | klein | 0,13 € | 0,10 € | 0,11 € |
  | mittel | 0,62 € | 0,26 € | 0,31 € |
  | groß | 0,79 € | 0,30 € | 0,37 € |

- Entscheidend für den Pool: **Auffrischung läuft je Firma, nicht je Konto.** Liegt eine
  Firma in zwei Abrechnungskonten, zahlt der Betreiber die Auffrischung einmal. Die zweite
  Aufnahme kostet ihn praktisch nichts; genau das ist der Deckungsbeitrag des Pools
  (PLAN_ABRECHNUNG_ZUGANG §2).
- Heute bekommt der Pool-Treffer denselben Preis wie die Frischaufnahme. Der Nutzer sieht
  vor dem Import nur „bekannte Stufe → Stufenpreis, sonst 1,00 €“ (`kontingent.ts`,
  `kostenSchaetzung`), nicht, dass die Firma schon da ist.
- Mithelfen (Register-Jobs auf dem Rechner des Nutzers): Opt-in, Standard aus
  (`register-delta/supervisor.ts`: `aktiv: raw.aktiv === true`), im Akkubetrieb pausiert
  (Standard an), 60 Abfragen je Stunde, keine Downloads, Organisation kann sperren.
  Bedarf nach S10 ≈ 1.130–1.300 Abfragen je Tag, Fly-Worker allein ≈ 1.065: ohne
  Mithelfer verhungern die kleinen Fronten (PLAN_STAMMDATEN_DELTA 8c).

### 5.2 Punkt 3: Pool-Preis

**Regel (Vorschlag):** Eine Bestandsfirma ist im Abrechnungsmonat ein *Pool-Treffer*, wenn
sie in mindestens **zwei bezahlten Abrechnungskonten** liegt (Organisation = ein Konto,
Free zählt nicht). Dann gilt für **alle** diese Konten der Pool-Preis, nicht nur für das
später hinzugekommene. Symmetrisch, kein Streit um die Reihenfolge, und die Botschaft
stimmt: „Je mehr AVA-Nutzer eine Firma beobachten, desto günstiger für alle.“

| Variante | Pool-Preis klein / mittel / groß | Botschaft | Marge auf laufende Kosten* |
|---|---|---|---|
| **A: halber Preis** (Empfehlung) | 0,25 / 0,50 / 0,75 € | „Schon da = halber Preis“ | 62 / 49 / 60 %, real ≈ 100 % (Auffrischung einmal je Firma) |
| B: ein Preis | 0,50 € für alle Stufen | „Schon da = 50 Cent“ | 81 / 49 / 40 % |
| C: ein Drittel weniger | 0,35 / 0,65 / 1,00 € | schwer zu erklären | 73 / 61 / 70 % |

\* gerechnet, als trüge jedes Konto die Auffrischung allein; tatsächlich trägt sie nur eines.

Wirkung bei Variante A: Ein Pro-Sitz trägt heute 32–98 Firmen, mit reinen Pool-Treffern bis
196. Umsatz je Firma bleibt bei zwei Konten gleich (2 × 0,50 = 1,00), ab drei steigt er.

**Umsetzung (≈ 1 Tag, Gateway + Desktop):**

1. `UsageEntry.pfad` (`frisch` | `pool`), Migration additiv.
2. `bestandVerbuchen` (Billing-Cron): nach dem Verbuchen aller Konten einer Periode ein
   zweiter Durchlauf: Firmen mit ≥ 2 bezahlten Konten → `pfad = 'pool'`, `preisCents` =
   Pool-Preis (`STUFE_POOLPREIS_*_CENTS`, Standard Hälfte). Kontingent-Prüfung summiert
   `preisCents` und profitiert ohne weitere Änderung.
3. Vorabschätzung (`kostenSchaetzung`): Firma mit `UsageEntry` eines anderen bezahlten
   Kontos in dieser oder der Vorperiode → Pool-Preis, Rückgabe trägt `pfad`.
4. Sichtbar: Aufnahme-Dialog „3 von 5 sind schon in AVA (halber Preis)“, Pille in „Meine
   Firmen“, `abrechnung_status` nennt Pool-Treffer und Ersparnis, Lösungskarte „Was kostet
   eine Firma“ ergänzen, Preisseite der Website eine Zeile.
5. Betreiber-Sicht `/v1/betreiber/kosten`: Anteil Pool-Treffer je Monat (Kennzahl für den
   Netzwerkeffekt).

**Entscheidung Joyce:** Variante (A/B/C) und ob Enterprise-Fixpreis-Kunden mitzählen
(Vorschlag: ja als Konto, aber ohne Preiswirkung, da Fixpreis).

### 5.3 Punkt 4: Mithelfen als Standard bei bezahlten Sitzen

**Regel (Vorschlag):**

- Standard **an** für Nutzer mit Pro-, Max-, Ultra- oder Enterprise-Sitz; Free bleibt
  Opt-in (nimmt wenig, soll nicht nur geben).
- Unverändert: 60 Abfragen je Stunde, keine Downloads, nur Netzbetrieb (Akku pausiert),
  Organisationssperre, Opt-out mit einem Klick in Einstellungen → Recherche und per Chat
  („Mithelfen aus“). Ein ausdrückliches Aus bleibt dauerhaft gespeichert und wird nie
  durch den Standard überschrieben.
- Transparenz beim ersten Start nach dem Update: ein einmaliger, nicht blockierender
  Hinweis im Chat („AVA fragt das Handelsregister jetzt im Hintergrund mit ab, höchstens 60
  Mal je Stunde, nur am Netz. Ausschalten: Einstellungen → Recherche.“). Gleicher Text in
  der Lösungskarte `stammdaten-mithelfen`.
- AGB/Datenschutz prüfen: eine Zeile zur Nutzung der Rechnerressourcen und zur Abfrage
  öffentlicher Register von der IP des Nutzers (keine Personendaten, öffentliches Portal).
  Wenn die AGB das nicht hergeben, Standard-an erst mit der nächsten AGB-Fassung
  (`project_agb_aenderungen_mail`).

**Sichtbarer Gegenwert, zwei Stufen:**

| Stufe | Was der Nutzer sieht | Kosten Betreiber |
|---|---|---|
| **G1 Transparenz** (Empfehlung zuerst) | „Dein Rechner hat diesen Monat 1.240 Register-Abfragen beigetragen, daraus 37 Änderungen für alle Nutzer.“ in Einstellungen, in `abrechnung_status` und einmal je Monat als Zeile in der Neuigkeiten-Mail | 0 |
| G2 Kontingent-Bonus (später, falls die Opt-out-Quote hoch ist) | +5 % Monatskontingent (Pro ≈ 2,45 €, etwa fünf kleine Firmen), wenn der Rechner im Monat ≥ 500 Abfragen beigetragen hat | ≈ 0 (Pool-Daten) |

**Umsetzung G1 (≈ ½ Tag, Desktop + Gateway):**

1. `supervisor.ts`: Standard aus Sitz ableiten (`raw.aktiv ?? sitzBezahlt`), explizites
   `false` bleibt. Sitz kennt der Desktop über `abrechnung_status`-Daten.
2. Gateway `RegisterWorker` je Desktop-Helfer zählt schon `jobsErledigt` und `abfragen`;
   neue Leseroute `GET /v1/stammdaten/mein-beitrag` (Abfragen und erzeugte
   Änderungsereignisse im Monat) für Einstellungen, Chat-Tool und Mail.
3. Einmaliger Hinweis beim Umstieg (Marke in den Desktop-Einstellungen).
4. Betreiber-Übersicht: Zahl aktiver Desktop-Helfer je Tag, Opt-out-Quote (aus dem
   gespeicherten `false` je Nutzer, als anonymer Zähler gemeldet).

**Entscheidung Joyce (2026-11-13):** Punkt 3 zurückgestellt, Punkt 4 bauen.

**Gebaut 2026-11-13 (G1):**

- Desktop `register-delta/settings-store.ts`: `aktiv` ohne Nutzerentscheidung = Standard des
  Sitzes (bezahlt = an, Free/unbekannt = aus; Sitz aus `/v1/usage` `kontingent.plan`, sonst
  `tier`, Cache in bootstrap neben dem Tier-Cache, Abgleich sobald der Sitz bekannt ist).
  Gespeichertes `aktiv` gilt dauerhaft. Status trägt `quelle` (standard | nutzer) und
  `standardAktiv`.
- Einmaliger Hinweis als Meldung (`sourceRef mithelfen:standard`, Dedupe im AlertsStore),
  wenn das Mithelfen durch den Standard läuft.
- Gateway `GET /v1/stammdaten/mein-beitrag` (Jobs, Abfragen, Registerblätter, neue und
  geänderte Firmen je laufendem und vorigem Monat aus `RegisterJob` der eigenen Desktop-
  Worker) → Einstellungen („Dein Beitrag“), Chat-Werkzeug `register_delta_status`
  (`beitrag`), Neuigkeiten-Mail einmal im Monat (Vormonat, Marke `beitragGemeldet`,
  Vorlage `beitragSatz`).
- Gateway `POST /v1/stammdaten/mithelfen-stand`: Desktop meldet an/aus und Quelle je
  Gerät (Spalten `einstellung*` an `RegisterWorker`, Migration `20261113_mithelfen_stand`);
  Betreiber-Übersicht `helfer.einstellung` (gemeldet, an, aus, standardAn, nutzerAn,
  nutzerAus) und `helfer.heute`; Helferliste trägt `einstellung`. Die Seite in der
  Admin-Konsole (Repo ava-admin) zeigt die neuen Felder noch nicht.
- Lösungskarte `stammdaten-mithelfen` aktualisiert, Prüfsatz +2, Vektoren neu.
- Tests: `pnpm -F @ava/desktop test:mithelfen`, `pnpm -F @ava/db-gateway test:burggraben`.

**Offen:**

- AGB: § 2 Abs. 2 und § 15 Abs. 3 decken „Hintergrunddienste auf dem Rechner des Kunden“,
  nennen aber nicht die Register-Abfragen für den gemeinsamen Bestand. Vorschlag für einen
  Satz in § 15 Abs. 3 (Repo ava-website, `app/agb/page.tsx`): „Dazu gehört bei bezahlten
  Plätzen, sofern der Nutzer es nicht in den Einstellungen abschaltet, die Abfrage
  öffentlicher Handelsregister für den gemeinsamen Datenbestand aller Kunden, höchstens 60
  Abfragen je Stunde, ohne Downloads und ohne Übermittlung von Kundendaten.“
- G2 (Kontingent-Bonus) nur, falls die Opt-out-Quote in der Betreiber-Übersicht hoch ist.
- Desktop-Release und Gateway-Deploy (Migration additiv) stehen aus.
