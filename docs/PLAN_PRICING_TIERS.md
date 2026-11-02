# Pricing-Pläne je Nutzer mit Kontingent (2026-11-01)

Entscheidung (Joyce, Patrick, Henning, 2026-11-01, Klarstellungen Joyce am selben Abend):
AVA wird wie Claude Team und ChatGPT Business in **Sitzen je Organisation** verkauft
(Nachtrag 2026-11-01 spät, nach Recherche der Vorbilder): die Organisation kauft Sitze der
Pläne Pro, Max und Ultra in einem Abo mit einem Zyklus und weist sie ihren Mitgliedern zu.
Jeder Sitz hat ein **Monatskontingent in Euro**, das durch die Firmen im Bestand des
jeweiligen Nutzers verbraucht wird; Mitglieder ohne Sitz sind Free (höchstens drei je
Organisation). Intern bleibt die Stufenlogik 0,50 / 1,00 / 1,50 € je Firma und Monat; die
Apify-Kontakte des Kontakt-Producers stecken in diesem Preis. Wer an sein Kontingent stößt,
wechselt in den nächsthöheren Plan; nur oberhalb von Ultra gibt es Pay-as-you-go nach
ausdrücklicher Zustimmung, die sich mit dem Monat zurücksetzt. Die **LinkedIn-Beobachtung**
(beobachtete Posts, Personen-Beobachtung, Leads, alles was über Apify außerhalb der
Firmenverarbeitung läuft) ist davon getrennt und reines Pay-as-you-go: Apify-Kosten plus
300 % Aufschlag mit einem Limit, das der Kunde selbst setzt. Enterprise-Verträge rechnen wir
wie bisher selbst und manuell ab.

Vorgänger: docs/PLAN_ABRECHNUNG_ZUGANG.md (Z1–Z12, Bestandsmodell), docs/PLAN_ABRECHNUNG_SEATS.md
(Seats, Sammelabrechnung → wird für Nicht-Enterprise stillgelegt), docs/KALKULATION_VERARBEITUNGSKOSTEN.md.
Übernommen werden Bestandsmodell je Firma und Monat, Stufenermittlung, Betreiber-Spur, Stripe-
Anbindung und die Betreiber-Sicht je Kunde.

## 1. Das Modell

### 1.1 Pläne (Sitze) je Nutzer

| Plan | Preis / Monat je Nutzer | Kontingent / Monat | Beispiel (nur klein / nur groß) | Apify-Kontakte in der Firmenverarbeitung | LinkedIn-Beobachtung |
|---|---|---|---|---|---|
| Free | 0 € | 25 Firmen lebenslang | 25 | ja (neu) | nein |
| Pro | 49 € | 49 € | 98 / 32 | ja | nach Verbrauch, eigenes Limit |
| Max | 149 € | 149 € | 298 / 99 | ja | nach Verbrauch, eigenes Limit |
| Ultra | 299 € | 299 € + Pay-as-you-go nach Freigabe | 598 / 199 (+ offen) | ja | nach Verbrauch, eigenes Limit |
| Enterprise | Vertrag | Vertrag, optional Firmen-Limit durch Betreiber | n. V. | ja | Vertrag, optional Limit durch Betreiber |

- Eine Organisation kauft Sitze je Plan und mischt beliebig (3 × Pro, 2 × Ultra). Sitze sind
  vom Menschen getrennt: Owner/Admin weisen sie zu und setzen Mitglieder jederzeit um
  (Umbuchung, kein Neukauf, solange ein Sitz des Zieltyps frei ist). Wer keinen Sitz hat, ist
  Free.
- **Höchstens 3 Free-Nutzer je Organisation**, unabhängig von der Zahl bezahlter Nutzer. Sind
  drei Free-Plätze belegt, kann die Organisation erst wieder Mitglieder einladen oder
  aufnehmen, wenn ein Free-Nutzer einen bezahlten Plan bekommt oder die Einladung gleich mit
  einem bezahlten Plan ausgesprochen wird. Die UI zeigt das vor dem Einladen an.
- Der Kunde bringt sein eigenes Modell für Chat, Radar, Recherche und Workflows mit; es gibt
  keine Situation, in der AVA „nicht mehr antwortet“. Begrenzt ist nur der Zugang zu Firmen.
- **Enterprise-Organisationen**: alle Mitglieder tragen den Plan „Enterprise“, es gibt dort
  kein Pro/Max/Ultra. Der Betreiber legt fest, wie viele Mitglieder beitreten dürfen
  (`maxMitglieder`), optional ein Firmen-Limit (Bestand der Organisation) und ein
  LinkedIn-Limit in Euro. Ohne gesetzte Limits gibt es keine Grenzen. Abrechnung manuell
  außerhalb von Stripe (Export wie heute), Bestand und Kosten je Organisation jederzeit in der
  Betreiber-Sicht einsehbar.

### 1.2 Wer zahlt, in welchem Zyklus (Sitz-Modell wie Claude Team / ChatGPT Business)

- **Ein Stripe-Abo je Organisation** mit bis zu drei Positionen (Anzahl Pro-, Max-, Ultra-
  Sitze), **ein Zyklus, eine Rechnung**, Zahlungsmittel der Organisation. Enterprise bleibt
  außerhalb von Stripe (manuell).
- **Sitz dazukaufen wirkt sofort und anteilig** (Stripe erhöht die Menge mit Proration, wie
  bei den Vorbildern: verbleibende Tage / Zyklustage × Sitzpreis). **Sitz reduzieren wirkt zum
  Zyklusende** (vorgemerkt, widerrufbar, keine Erstattung). Sitztyp wechseln = Menge beim
  einen Typ hoch, beim anderen zum Zyklusende runter; nach oben sofort anteilig.
- **Kontingent und Bestand je Nutzer** (nicht gepoolt, wie bei den Vorbildern), im
  **Kalendermonat** (bestehende Periodik, `bestandVerbuchen`), **tagesanteilig** nach dem Sitz,
  den der Nutzer an jedem Tag hatte: Summe über die Tage von `Kontingent(Sitz am Tag) / Tage
  im Monat`. Deckt Zuweisung mitten im Monat, Upgrade, Downgrade und Entzug mit einer Regel ab
  und verhindert den Missbrauch „am 28. upgraden, volles Kontingent, am 1. zurück“.
- **Bestand je Nutzer**: Firmen aus den eigenen Vorgängen des Nutzers (master-data
  `companies-by-users` liefert das je Nutzer), einmal je Nutzer und Monat. Dieselbe Firma bei
  zwei Mitgliedern verbraucht bei beiden Kontingent („jeder zahlt für seinen Zugang“). Dieser
  Satz steht in App und Preisseite. Enterprise: Bestand je Organisation wie heute (Z11).
- **Free**: 25 Firmen lebenslang je **Nutzer** (Konto = Nutzer, Periode `lifetime` wie heute).
  Eine zweite Organisation setzt das nicht zurück; der Free-Deckel je Organisation (3) begrenzt
  zusätzlich die Zahl kostenloser Mitglieder.

### 1.3 Kontingent-Mechanik

- **Bestandswert** B = Summe der Stufenpreise aller Firmen im Monatsbestand des Nutzers
  (Z11: aufgenommen oder am Monatsende noch da, Entfernen wirkt ab Folgemonat). Firmen ohne
  Stufe zählen vorläufig 1,00 €.
- **Neuverarbeitung** durch den Kunden (ganze Firma, erzwungen) = weitere Zeile zum
  Stufenpreis (`NeuverarbeitungEntry`), auch wenn die Firma im Monat schon im Bestand ist.
- **Vorabprüfung** an jedem Aufnahmeweg (Import aus Liste, per ID, Radar-Übernahme, Leads-
  Übernahme, MCP `import_anlegen`, Workflow-Knoten) und bei Neuverarbeitung:
  `B + Kosten der neuen Firmen ≤ Kontingent des Monats`. Schätzung neuer Firmen: Stufe des
  Pool-Datensatzes, wenn die Firma schon im Pool ist, sonst 1,00 €. Reicht es nicht:
  `402 kontingent_erschoepft` mit `fehltCents`, `passenNoch`, `naechsterPlan`, `paygMoeglich`,
  `kannSelbstWechseln` (Owner/Admin ja, Mitglied nein).
- **Nichts wird gelöscht.** Ein Bestand über dem Kontingent (nach Downgrade) blockiert nur
  neue Aufnahmen und Neuverarbeitungen.
- **Nachträgliche Stufen-Erhöhung** (Firma erst nach Aufnahme als groß erkannt) wird nie
  nachberechnet; sie wirkt im Folgemonat (Vorgabe Joyce).
- **Monatsabschluss**: Bestand verbuchen wie heute; Ultra mit Freigabe → Rechnungsposten je
  Stufe für den Teil über dem Kontingent; LinkedIn → ein Rechnungsposten je Nutzer.

### 1.4 Sitze kaufen, zuweisen, wechseln, Beitritt

- **Kaufen und zuweisen** (Owner/Admin, Konsole `/mitglieder`): „Sitz hinzufügen“ wählt den
  Plan, Stripe erhöht die Menge anteilig, der Sitz ist sofort frei oder wird direkt einem
  Mitglied zugewiesen. Freie Sitze bleiben bezahlt, bis sie zum Zyklusende reduziert werden.
- **Mitglied umsetzen**: auf einen freien Sitz anderen Typs sofort; ist keiner frei, kauft der
  Owner im selben Schritt einen dazu (anteilig). Herabstufen gibt den teureren Sitz frei; die
  Reduktion der Menge ist ein eigener, vorgemerkter Schritt zum Zyklusende.
- **Eigener Plan**: Owner/Admin wechseln sich selbst über denselben Weg; Mitglieder sehen ihren
  Plan in der App und können einen Wechsel **anfragen** (Meldung an Owner/Admin). Ein-Personen-
  Organisationen sind damit Self-Service.
- **Beitritt per Link** (bestehender Weg `POST /v1/tenants/join` → Anfrage → Admin-Freigabe):
  beim Freigeben wählt Owner/Admin den Sitz (freier bezahlter Sitz, neuer Sitz anteilig, oder
  Free, falls einer der drei Plätze frei ist). Ohne verfügbaren Platz bleibt die Anfrage offen,
  die Person ist **wartend** und kann AVA nicht nutzen (wie „Request to join“ bei OpenAI).
  Direkte Einladung per E-Mail trägt den Sitz gleich mit.
- **Mitglied entfernen**: Sitz wird frei (bezahlt bis Zyklusende, danach reduzierbar); der
  Nutzer behält seine 25 Free-Firmen am eigenen Konto.
- **Zahlungsausfall**: wie heute je Organisation (`past_due` → Karenz → `suspended`).

### 1.5 Pay-as-you-go oberhalb von Ultra

- Nur für Ultra-Sitze. Freigabe durch Owner/Admin (für sich oder ein Mitglied), gespeichert als
  `paygFreigabePeriode = 'YYYY-MM'` + optional `paygLimitCents`; gilt nur für den laufenden
  Monat, am 1. wieder aus. Bestätigungsdialog mit Stufenpreisen; Chat-Werkzeug mit
  `confirmAction`; im `402`-Dialog direkt anbietbar (nur wenn `kannSelbstWechseln`).
- Rechnungsposten je Stufe auf der Organisationsrechnung, mit Nutzername im Postentext,
  Idempotenz `ava-payg-<org>-<nutzer>-<periode>-<stufe>`.

### 1.6 LinkedIn-Beobachtung nach Verbrauch

Betroffen: Watchlist (Profil-Reaktionen/-Kommentare), Beobachtete Posts / Personen-Radar,
LinkedIn-Leads, künftige Beobachtungsfunktionen über Apify. **Nicht** betroffen: der
Mitarbeiter-Abruf des Kontakt-Producers (im Stufenpreis enthalten). Trennung über den
Kontext des Proxy-Aufrufs (`kontext = firmenverarbeitung | linkedin`, aus Header; Producer
setzen ihn im Supervisor, Desktop-Scheduler setzen `linkedin`).

- **Preis** = echte Apify-Kosten des Laufs × 4, in Cent. Echte Kosten kommen verzögert
  (`apifyLaufNachtragen`), deshalb Schätzung beim Aufruf aus einer **Actor-Preistabelle**
  (Startgebühr + Preis je Item × `maxItems`), Abgleich im Cron. LlmUsage bekommt `preisCents`
  und `kontext`.
- **Limit je Nutzer** `linkedinLimitCents`, gesetzt nur von Owner/Admin (für sich und
  Mitglieder; Pflicht beim ersten Einschalten einer Beobachtungsfunktion), weil die Kosten auf
  dem Zahlungsmittel der Organisation landen. Rechnungsposten je Nutzer auf der
  Organisationsrechnung. Vorabprüfung im Apify-Proxy
  für `kontext = linkedin`, sonst `402 linkedin_limit_erreicht`; Scheduler pausieren mit
  Chat-Meldung bis Monatsanfang oder Limit-Erhöhung.
- **Enterprise**: Limit je Organisation durch den Betreiber (optional), Kosten je
  Organisation in der Betreiber-Sicht, Abrechnung manuell.
- **Free**: keine Beobachtungsfunktionen (bestehende Gates). Apify-Kontakte in der
  Firmenverarbeitung sind für Free neu erlaubt (`apify_nicht_im_free_plan` entfällt).
- **Kommunikation**: nie „Apify“ oder „300 %“; Preistabelle für Kunden als „ab X € je 1.000
  beobachtete Reaktionen / je aufgelöstes Profil“, gepflegt in der Konsole.

### 1.7 Neuverarbeitung: Kunde vs. Betreiber

| Wer | Darf | Weg |
|---|---|---|
| Kunde (jede Rolle) | ganze Firma neu verarbeiten, verbraucht einen Stufenpreis seines Kontingents | `POST /v1/imports/by-ids {erzwingen:true}`, Knopf „Firma komplett neu verarbeiten“, Chat `firma_neu_verarbeiten`, MCP `neu_verarbeiten` (wird Ganzfirma) |
| Kunde | einzelne Stufe nicht mehr | Schritt-Formular weg, `retry_stage` für Kunden weg, Retry-Endpunkt ohne Betreiber-Rolle → 403 |
| Betreiber (`istBetreiber`, Keycloak-Realm-Rolle `admin`) | einzelne Stufe und ganze Firma ohne Kontingentverbrauch | Retry-Endpunkt, Schritt-Formular, Chat `retry_stage` |

### 1.8 Enterprise

Bleibt: `mode = enterprise`, Fixpreis als Information (`enterprisePreisCents`), Rechnung
manuell (`enterprise_export`, CSV). Neu: Betreiber setzt in der Konsole Enterprise an/aus,
`maxMitglieder`, optional `firmenLimit` (Anzahl Firmen im Bestand) und `linkedinLimitCents`
je Organisation; Beitritt über `maxMitglieder` hinaus wird abgelehnt (Einladung und
Beitrittslink). Angebots-PDF behält Laufzeit und Jahresnachlass nur für Enterprise. Keine
Betreiber-Limits = keine Grenzen (heutige `isUnlimited`-Logik bleibt, aber gesetzte Limits
greifen auch bei Enterprise, Fix des Kurzschlusses in internal-quota.ts:70).

## 2. Ist-Zustand, auf dem aufgesetzt wird

- Gateway: `TenantBilling.tier` String (free/starter/pro/enterprise), ein Konto je Tenant
  (Nutzer oder Organisation), `resolveBillingAccountId` wählt die Organisation nur im Seats-/
  Enterprise-Modus, sonst den Nutzer; Stripe-Preise per Env, Checkout nur `pro`, In-Place-
  Wechsel mit Proration vorhanden, Webhook Preis → Tier, Cron stündlich (`bestandVerbuchen`
  je Konto und Kalendermonat, `zugangUeberschreitungEinzelabo`, `closeCompletedPeriods`,
  `reconcileWithStripe`). `assertQuotaAvailable` hat keine Aufrufer; wirksam ist
  `/internal/quota/try-reserve` mit `ausgabenlimit`/`betreiberlimit`; Enterprise umgeht dort
  das Betreiber-Limit. Mitgliederverwaltung (Einladung, Beitritt, Rollen) in lib/tenants.ts.
- Apify: zentraler Token, Proxy ohne Metering-Deckel (`meter=false`), LlmUsage `kind=apify`,
  echte Kosten je Lauf im Nachlauf; `/v1/usage` zeigt dem Kunden keine Apify-Kosten; Apify
  zählt versehentlich ins LLM-Orga-Budget (`checkQuota` ohne kind-Filter).
- Desktop: Plan-Karten Free/Pro/Enterprise (`PLAN_CARDS`, Settings.tsx:4675), Checkout nur
  → pro, `ZugangStand` mit Ausgabenlimit-Feld, Organisationsverwaltung nur noch in der
  Konsole (v0.1.798). `RetryStageForm` erzwingt immer, hinter `useIstAdmin`; „Firma komplett
  neu verarbeiten“ für alle sichtbar, 403 für Mitglieder; Texte „Starter-Plan“ in
  DiscoveryRadar.tsx:533, WatchlistPanel.tsx:100; keine Stufen-Pille in Meine Firmen.
- Konsole: `/mitglieder` (Mitglieder, Einladungen, Rollen), `/abrechnung` (Seats, Tier,
  feste Preistexte, widersprüchlich), `/verarbeitungskosten` (Rechner mit Seats/Instanzen,
  Angebot-PDF), `/betreiber` (Kunden, Spuren, Kosten, Enterprise-Empfehlung, Limit-Formular,
  kein Plan-Wechsel). Proxy-Allowlist in app/api/gw/[...pfad]/route.ts.
- PWA: keine Abrechnungsseite; Typen vorhanden; Allowlist ohne usage/billing.

## 3. Arbeitspakete

### P0 Kostenbremse vorab — umgesetzt 2026-11-02 (v0.1.903)

- Takte (Entscheidung Joyce/Patrick/Henning): Kontakte, Profil, Website alle **14 Tage**
  (vorher 7), Strukturierte Inhalte und Publikationen 30 Tage (`freshness-prefs-store.ts`).
- Mitarbeiter-Abruf nur für Neues: Der Kontakt-Producer holt beim Auffrischen zuerst den
  Stand vom Gateway (`GET /v1/companies/{id}/contacts/apify-stand`: bekannte Apify-Personen,
  letzter Lauf, gespeicherte Mitarbeiterzahl) und fragt nur den günstigen Details-Actor
  (≈ 0,02 $) nach der aktuellen Mitarbeiterzahl. Der volle Employees-Lauf (≈ 0,45 $) läuft nur,
  wenn die Zahl sich um mehr als 2 Personen bzw. 5 % geändert hat, keine Zahl bekannt ist oder
  der letzte Lauf 90 Tage alt ist (`APIFY_VOLLABRUF_TAGE`). Die Zahl wird als Fakt
  `linkedin:employeeCount` persistiert. Damit kostet eine mittlere Firma im 14-Tage-Takt
  ≈ 0,04 $ Apify im Monat statt ≈ 0,95 $.
- Offen: Betreiber-Alarm bei 80 % des Apify-Monatslimits; Apify-Ausfall im Producer nicht
  mehr still (Meldung statt stiller SERP-Rückfall).

### Stand der Umsetzung

- **P0 umgesetzt** (v0.1.903, 2026-11-02): Takte 14/14/14/30/30, Apify-Delta-Abruf.
- **P1 umgesetzt im Gateway** (Commit 5b0604db, 2026-11-02, noch nicht deployt): Migration
  `20261102_pricing_sitze`, Plan-Katalog (`lib/billing-plans.ts`, `GET /v1/plaene`), `lib/sitze.ts`
  (Sitze, PlanZeitraum, tagesanteiliges Kontingent, Test `test:kontingent`). Abweichung vom Plan:
  `PlanZeitraum` statt `PlanTag`; `ausgabenLimitCents` bleibt bestehen, `paygLimitCents` kommt als
  eigene Spalte dazu (keine Umbenennung, Altlogik bleibt lauffähig).
- **P2 umgesetzt im Gateway** (2026-11-02, hinter `PRICING_TIERS=1`, Standard aus): `lib/kontingent.ts`
  (Stand, Kostenschätzung je Pool-Stufe, Vorabprüfung mit 402 `kontingent_erschoepft` / `firmen_limit`),
  Sitz-Routen `GET/POST /v1/tenants/me/sitze`, `PUT /v1/tenants/me/mitglieder/{actorId}/sitz`,
  `PUT/DELETE /v1/tenants/me/sitze/{plan}/reduzieren`, `POST /v1/billing/plan-anfrage`,
  `PUT /v1/usage/payg`; Beitrittsfreigabe mit `sitz` (Enterprise prüft `maxMitglieder`, sonst Sitz oder
  Free-Platz), Austritt gibt den Sitz frei; Vorabprüfung in `/v1/imports/by-ids` (mit
  `NeuverarbeitungEntry` bei `erzwingen`), `/v1/imports/from-list` und `/internal/quota/try-reserve`
  (master-data übergibt jetzt `companyId`); `/v1/usage` liefert `kontingent` und `kannSelbstWechseln`;
  `bestandVerbuchen` verbucht Konten im Modus `sitz`. Noch offen in P2: Meldungen bei 80/100 %,
  Wartezustand ist die offene Beitrittsanfrage (kein eigener Mitgliedsstatus nötig; Spalte bleibt ungenutzt).
- **P3 umgesetzt im Gateway** (2026-11-02): `lib/sitze-stripe.ts` — ein Abo je Organisation mit einer
  Position je Plan (`STRIPE_PRICE_PRO|MAX|ULTRA`), Sitz dazu = Menge hoch mit Proration, Reduktion =
  Menge sofort runter ohne Proration (bezahlt bis Zyklusende, Sitz endet per Cron), Widerruf = Menge hoch
  ohne Proration; **kein Subscription Schedule nötig** (Abweichung vom Plan, einfacher und gleiches
  Kundenverhalten). Erster Kauf ohne Abo → Checkout (`POST /v1/tenants/me/sitze` liefert `checkout.url`,
  Rückkehr `app` oder `konsole` via `ADMIN_KONSOLE_URL`), Webhook `customer.subscription.*` erkennt
  Sitz-Abos (`metadata.sitze` oder Max/Ultra-Preis) und gleicht Mengen mit der Sitz-Tabelle ab
  (`sitzeAusStripeAbgleichen`; zu viele → freie Sitze enden, zugewiesene nie still), `subscription.deleted`
  setzt alle Mitglieder auf Free. Vorschau `GET /v1/billing/sitze/vorschau?plan&anzahl` über
  `invoices.createPreview` (nur Proration-Zeilen). Persönliches Checkout ist für Mitglieder einer
  Sitz-Organisation gesperrt. Offen in P3: `reconcileWithStripe` für Sitz-Abos, Stripe-Preise im Dashboard
  anlegen (Betreiber), Portal-Konfiguration ohne Mengenänderung.
- **P4 umgesetzt** (2026-11-02): Gateway `lib/apify-preise.ts` (Preistabelle je Actor, Startgebühr,
  USD→EUR, Aufschlag 300 % per Env; Schätzung aus `maxItems` × Ziele; Kundenpreistabelle), Proxy liest
  Header `x-ava-apify-kontext` (linkedin | firmenverarbeitung, Standard firmenverarbeitung), schätzt den
  Lauf, prüft bei `linkedin` das Limit (`402 linkedin_nicht_im_free_plan | linkedin_limit_fehlt |
  linkedin_limit_erreicht`, 20 % Puffer) und schreibt `LlmUsage.kontext/preisCents`; echte Apify-Kosten
  ersetzen die Schätzung (`anbieter-kosten.ts`). Mit `PRICING_TIERS=1` sind Apify-Kontakte der
  Firmenverarbeitung auch für Free erlaubt (nur Beobachtung bleibt gesperrt). Routen `GET /v1/usage/linkedin`,
  `PUT /v1/usage/linkedin-limit` (Owner/Admin), öffentlich `GET /v1/plaene/linkedin-preise`; Cron
  `linkedinAbrechnen` legt je Nutzer einen Rechnungsposten des Vormonats auf den Stripe-Kunden der
  Organisation (Enterprise nur Ereignis). Desktop: Hauptprozess sendet `linkedin`, Kontakt-Producer
  `firmenverarbeitung`; Watchlist/Personen-Radar behandeln `LINKEDIN_LIMIT` wie fehlendes Guthaben (Lauf
  endet, Automatik bleibt an); Chat-Werkzeug `linkedin_limit_setzen` (Stand + Limit, confirmAction).
  Offen in P4: Dialog mit Preistabelle und Limit-Pflicht beim ersten Einschalten einer Beobachtung (P6),
  Chat-Meldung bei Pause.
- **P5 umgesetzt** (2026-11-02, hinter `PRICING_TIERS=1`): `lib/rollen.ts` unterscheidet
  `darfEinzelstufeErzwingen` (nur Betreiber, Keycloak-Rolle) und `darfFirmaErzwingen` (jede Rolle;
  Kontingent-Prüfung und `NeuverarbeitungEntry` aus P2). Retry-Endpunkt mit `erzwingen` → 403 mit
  Hinweis auf die ganze Firma; `/v1/tenants/me` liefert `betreiber`. **Interpretation:** nicht erzwungene
  Retries (Reparatur fehlender oder fehlgeschlagener Stufen, kostenlos, Frische bleibt) bleiben für alle
  und für MCP `neu_verarbeiten`, sonst bräche der Chat-Ablauf „Firma unvollständig → Stufe nachholen“.
  Desktop: Schritt-Formular nur noch mit `useIstBetreiber`, „Firma komplett neu verarbeiten“ für alle mit
  `bestaetigen()` und Kontingenthinweis (auch in der Firmenansicht), Chat-Werkzeug `firma_neu_verarbeiten`
  (confirmAction), Systemprompt und Fähigkeitsgruppe angepasst; `retry_stage` bleibt die Reparatur.
- **P6 Desktop, erster Teil umgesetzt** (2026-11-02): `routes/settings/PlanAbrechnungSection.tsx`
  (erscheint, sobald `/v1/usage.kontingent` gefüllt ist; sonst alte PlanSection): Kopfkarte „Dein Plan“ mit
  Kontingentbalken (anteilig gekennzeichnet), Bestand nach Stufen, Prognose, geplanter Wechsel mit „rückgängig“,
  Zahlungszustände; Plan-Auswahl aus `/v1/plaene` (Upgrade sofort: freier Sitz oder Kauf mit Vorschau,
  erster Kauf über die Kasse; Downgrade/Free zum Zyklusende vorgemerkt; Mitglieder „Anfragen“); Ultra-Karte
  „Über das Kontingent hinaus“; LinkedIn-Karte (Verbrauch je Funktion, Limit, Preise). Gateway dazu:
  geplante Planwechsel je Mitglied in `TenantBilling.sitzeGeplant.wechsel` (PUT …/sitz `zum: zyklusende`,
  DELETE …/sitz/wechsel, Cron führt sie aus), `GET /tenants/me/sitze` mit `ich`, `zyklusende`, `stripe`,
  `wechsel`; Portal nutzt den Stripe-Kunden der Sitz-Organisation (Owner/Admin). Aufnahme-Dialog
  `KontingentDialogHost` auf das Ereignis `ava:kontingent-erschoepft` (Plan wechseln / Admin bitten / nur
  passende Firmen aufnehmen / Abbrechen); `UsageChip` und `QuotaExhaustedBanner` zeigen das Kontingent in
  Euro; Texte „Starter-Plan“ ersetzt; Chat: `abrechnung_status` mit Kontingent, `plan_wechseln`,
  `payg_freigeben`; Jargon-Prüfung um Pay-as-you-go, Apify, Proration, Seat erweitert. Visuell geprüft
  (statische Vorschau, hell/dunkel, 1280 und schmal).
  Noch offen in P6: Stufen-Pille und Monatswert in „Meine Firmen“, Dialog mit Limit-Pflicht beim ersten
  Einschalten einer LinkedIn-Beobachtung, Meldungen bei 80/100 %, Chat-Meldung bei LinkedIn-Pause, Systemprompt-
  Regeln zum Plan.
- **Offen:** P6 Rest, P7 Konsole, P8 PWA, P9 Migration/Texte. Stripe-Dashboard (2026-11-02, Joyce
  per Browser): Produkte „AVA Pro“ 49 € (`price_1TWLJF0r0BPxCh2slgfeLNb7`, vorher „AVA Starter“), „AVA Max“
  149 € (`price_1TWLJH0r0BPxCh2sUvtHrQX6`, vorher „AVA Pro“), „AVA Ultra“ 299 € neu
  (`price_1UXLSE0r0BPxCh2sdDGTbBXz`); Kundenportal erlaubt keine Plan- oder Mengenänderung. Secrets
  `STRIPE_PRICE_PRO/MAX/ULTRA`, `ADMIN_KONSOLE_URL` setzen und `STRIPE_PRICE_STARTER` entfernen muss Joyce
  (Berechtigung).
  entfällt: P4 LinkedIn
  nach Verbrauch, P5 Neuverarbeitung-Regeln (Betreiber-Rolle), P6 Desktop, P7 Konsole, P8 PWA, P9
  Migration/Texte. Deploy der Migration braucht Joyces Freigabe (Prod-DB).

### P1 Gateway: Datenmodell und Plan-Katalog

- Migration `20261101_pricing_tiers`:
  - **Organisation** (`TenantBilling` der Org): `mode` neu `sitze` (neben `enterprise`,
    Altwerte `seats`/`subscription` nur noch Migration), `stripeCustomerId`,
    `stripeSubscriptionId` (ein Abo), `sitzeGeplant` jsonb (vorgemerkte Reduktionen je Plan
    zum Zyklusende), `maxMitglieder` (Enterprise), `firmenLimit`, `linkedinLimitCents`
    (Enterprise, Betreiber).
  - Neue Tabelle **`Sitz`**(id, tenantId, plan pro|max|ultra, stripeItemId, actorId null =
    frei, zugewiesenAm, zugewiesenVon, endetAm null = läuft, reduziertZum null): Quelle für
    Mengen je Plan, freie Sitze und die Zuweisung. Historie über `endetAm` (nie löschen).
  - **Nutzerkonto** (`TenantBilling` des Nutzers): `tier` wird aus dem aktiven Sitz abgeleitet
    (`free` ohne Sitz, `enterprise` in Enterprise-Org), `paygFreigabePeriode`,
    `paygLimitCents` (umbenannt aus `ausgabenLimitCents`), `linkedinLimitCents`.
    Tagesanteiliges Kontingent aus der `Sitz`-Historie (`kontingentCents(nutzer, periode)`).
  - `TenantMember`: Zustand `status` aktiv | wartend (offene Beitrittsanfrage ohne Platz),
    plus `JoinRequest.sitzWunsch`.
  - `LlmUsage`: `preisCents`, `kontext`. Neue Tabelle `NeuverarbeitungEntry(billingAccountId,
    periodKey, companyId, lauf, stufe, preisCents, createdAt)`.
- `lib/billing-plans.ts` → **Plan-Katalog** (Preis, Kontingent, Stripe-Preis-Env
  `STRIPE_PRICE_PRO|MAX|ULTRA`, Rang, Merkmale), `GET /v1/plaene` öffentlich. Env
  `PLAN_PRO_CENTS=4900`, `PLAN_MAX_CENTS=14900`, `PLAN_ULTRA_CENTS=29900`, Kontingent
  standardmäßig = Preis (`KONTINGENT_*_CENTS` überschreibbar).
- `resolveBillingAccountId`: Kontingent/Bestand immer am **Nutzer** (außer Enterprise →
  Organisation); Zahlung immer an der **Organisation**. Seats-Modus (Sammelabrechnung alt) für
  neue Konten gesperrt, Altkonten migriert (P9).

### P2 Gateway: Mitglieder, Pläne, Kontingent-Prüfung, Verbuchung

- **Sitze**: `GET /v1/tenants/me/sitze` (Sitze je Plan: gekauft, zugewiesen, frei,
  vorgemerkte Reduktion, Zyklusende; Mitglieder mit Sitz/Free/wartend; Free-Plätze `3 −
  freeAnzahl`), `POST /v1/tenants/me/sitze {plan, anzahl, actorId?}` (kaufen, optional gleich
  zuweisen; Stripe-Menge anteilig), `PUT /v1/tenants/me/mitglieder/{actorId}/sitz {plan|free}`
  (zuweisen/umsetzen/entziehen; kauft bei Bedarf einen Sitz dazu, wenn `kaufen: true`),
  `PUT /v1/tenants/me/sitze/{plan}/reduzieren {anzahl}` (zum Zyklusende, widerrufbar),
  `POST /v1/billing/plan-anfrage` (Mitglied → Meldung). Alle Schreibwege Owner/Admin.
- **Free-Deckel und Wartezustand**: `decideJoinRequest` (bestehend) nimmt den Sitz entgegen
  (`sitz: pro|max|ultra|free`); Free nur bei `freeAnzahl < 3`, sonst `409 free_plaetze_belegt`
  mit `freeNutzer[]` und den freien bezahlten Sitzen als Alternative. Ohne Entscheidung bleibt
  die Anfrage offen = Mitglied wartend (kein Zugriff; `/v1/usage` liefert `status: wartend`,
  App zeigt Wartebildschirm). Einladung per E-Mail trägt `sitz` mit und reserviert ihn.
  Enterprise: `mitglieder < maxMitglieder`, sonst `409 mitglieder_limit`.
- `lib/kontingent.ts`: `kontingentStand(konto, periode)` (tagesanteiliges Kontingent,
  Bestandswert je Stufe, Neuverarbeitungen, PAYG, übrig, Prognose) und
  `kontingentPruefen(konto, companyIds[])`. Prüfung an **allen** Aufnahmewegen (from-list,
  by-ids inkl. erzwingen, Radar-Übernahme, Leads-Übernahme, MCP `import_anlegen`, Workflow-
  Import, `/internal/quota/try-reserve` ersetzt dort die Ausgabenlimit-Logik; Enterprise gegen
  `firmenLimit`). Einheitliche Antwort `402 kontingent_erschoepft`.
- Verbuchung: `bestandVerbuchen` je Nutzer (Free: lebenslang wie heute); `paygAbrechnen`,
  `linkedinAbrechnen` am Monatsabschluss, idempotent über BillingEvent. `assertQuotaAvailable`
  und `ausgabenlimitReicht` entfernen (tot).
- `GET /v1/usage` liefert `plan`, `kontingent`, `linkedin`, `wechsel`, `payg`, `rolle`
  (`kannSelbstWechseln`), bei Enterprise `vertrag` (Limits, Mitglieder).
- Meldungen an den Nutzer (und Owner/Admin) bei 80 %/100 % Kontingent, 80 % LinkedIn-Limit,
  am 1. bei Bestand > Kontingent; an Owner/Admin bei Plan-Anfragen und wenn Free-Plätze voll.

### P3 Stripe

- Produkte/Preise: AVA Pro 49 €, Max 149 €, Ultra 299 € je Sitz und Monat, automatische
  Steuer (Betreiber legt im Dashboard an). **Keine Jahrespreise** (Vorgabe Joyce).
- **Ein Stripe-Kunde und ein Abo je Organisation**, Abo-Positionen je Plan mit `quantity` =
  gekaufte Sitze (`metadata.tenantId`). Erster Kauf: Checkout-Session (Zahlungsmittel +
  erste Sitze), danach `subscriptionItems.update(quantity)` serverseitig: erhöhen mit
  `proration_behavior: create_prorations` (sofort, anteilig), reduzieren mit
  `proration_behavior: none` zum Zyklusende über Subscription Schedule (Phase ab
  `current_period_end` mit den Zielmengen; ein Schedule je Abo, bei jeder Vormerkung neu
  geschrieben, `release` beim Widerruf). Vorschau `GET /v1/billing/vorschau?plan&anzahl` über
  `invoices.createPreview`.
- Webhooks: `customer.subscription.updated` → Mengen je Plan mit der Tabelle `Sitz`
  abgleichen (mehr Menge als Sitze → freie Sitze anlegen; weniger → zuletzt freie Sitze
  beenden, nie zugewiesene), `subscription_schedule.*` → `sitzeGeplant`, `invoice.paid /
  payment_failed` je Organisation. Reconcile prüft Mengen, Schedules und offene Posten.
- Customer Portal: nur Zahlungsmittel, Rechnungen, Adresse; Mengenänderung im Portal aus.
- PAYG (Ultra) und LinkedIn als `invoiceItems` auf die nächste Organisationsrechnung, je
  Nutzer ein Posten mit Namen im Text; Idempotenz je Org, Nutzer, Periode (und Stufe).
- Enterprise außerhalb von Stripe (`enterprise_export`, CSV mit Spalten LinkedIn, Firmen-Limit,
  Mitglieder).
- Bestehende Checkout-/In-Place-Logik (routes/v1/billing.ts:129–196) wird auf Items mit
  Mengen umgebaut; Webhook-Mapping Preis → Tier wird zu Preis → Plan-Item.

### P4 LinkedIn nach Verbrauch

- `lib/apify-preise.ts`: Preistabelle je Actor (Startgebühr, Preis je Item, Default
  `maxItems`), Env-überschreibbar, `GET /v1/plaene/linkedin-preise` für Kunden (Preis je
  1.000 Items / je Profil).
- Apify-Proxy: `kontext` aus Header, Schätzung `preisCents = round(usd × kurs × 4)`,
  Vorabprüfung gegen `linkedinLimitCents` des Nutzers (Enterprise: der Organisation) nur für
  `kontext = linkedin`, `402 linkedin_limit_erreicht`; `checkQuota` bekommt `kind <> 'apify'`.
- `apifyLaufNachtragen` setzt `preisCents` auf den echten Wert × 4; Schätzungen ohne Ist nach
  14 Tagen als Ist übernommen.
- Desktop: Scheduler (Watchlist, Personen-Radar, Leads) behandeln 402 als Pause mit Chat-
  Meldung; `PUT /v1/usage/linkedin-limit` (eigenes Limit, Owner/Admin auch für Mitglieder);
  Chat `linkedin_limit_setzen` (confirmAction); Dialog mit Preistabelle und Limit-Pflicht beim
  ersten Aktivieren.
- Free: `apify_nicht_im_free_plan` entfällt, `bootstrap.ts:696`-Gate weg; Beobachtungs-
  funktionen für Free weiterhin gesperrt.

### P5 Neuverarbeitung-Regeln

- Gateway: Retry-Endpunkt nur `istBetreiber` (403 `nur_betreiber`); `/v1/imports/by-ids
  {erzwingen}` für alle Rollen mit Kontingent-Prüfung + `NeuverarbeitungEntry` (Betreiber ohne
  Verbrauch); `darfErzwingen` entfällt; MCP `neu_verarbeiten` → ganze Firma.
- Desktop: `RetryStageForm` nur mit Betreiber-Rolle (`useIstBetreiber` aus dem JWT), „Firma
  komplett neu verarbeiten“ für alle mit Kostenhinweis und `bestaetigen()`; zweiter Knopf in
  firma-uebernehmen.tsx gleich; `retry_stage` nur bei Betreiber registriert; neues Werkzeug
  `firma_neu_verarbeiten` (confirmAction, Kontingentfolge); Systemprompt-Regel.
- Auffrischung/Heartbeat bleiben betreibergesteuert und kostenlos.

### P6 Desktop-App: Plan & Abrechnung (UI/UX)

Vorbild Claude/ChatGPT: ruhige Kopfkarte mit dem eigenen Plan, darunter Plan-Auswahl,
Wechsel in einem Bestätigungsblatt mit klarer Geld- und Zeitangabe. Zuweisung an andere
Mitglieder bleibt in der Konsole; die App verlinkt dorthin.

- **Kopfkarte „Dein Plan“**: Planname mit Pille, Preis, nächstes Abrechnungsdatum,
  Kontingentbalken „32,50 € von 49 € genutzt“ (bei anteiligem Monat: „von 31,60 € in diesem
  Monat“ mit Erklärzeile „Plan seit 12.11.“), Aufschlüsselung „61 Firmen im Bestand: 40 klein
  · 18 mittel · 3 groß“, Prognose „reicht noch für etwa 16 mittlere Firmen“. Knöpfe: Owner/
  Admin „Plan ändern“ + „Rechnungen und Zahlungsmittel“; Mitglied „Wechsel anfragen“ +
  Hinweis „Pläne verwaltet eure Organisation in der Konsole“. Zustände: geplanter Downgrade
  („wechselt am 14.12. zu Pro · rückgängig“), past_due, Kündigung, Enterprise („Enterprise ·
  Vertrag eurer Organisation“, Bestand der Organisation, ggf. Firmen-Limit).
- **Plan-Auswahl** (`.plan-grid` erweitern): vier Karten Free / Pro / Max / Ultra, aktuelle
  markiert, höhere „Upgrade“ (primär), niedrigere „Zum 14.12. wechseln“ (sekundär),
  Enterprise als Textzeile „Für Teams mit Sammelabrechnung: Vertrag auf Anfrage“. Je Karte
  Preis, Kontingent, Beispielzeile („z. B. 98 kleine oder 32 große Firmen“), drei bis vier
  Merkmale aus dem Katalog; Free zeigt „3 Plätze je Organisation“. Begriffe nach Glossar:
  „Plan“, „Kontingent“, „Verbrauch“, nie „Tier“.
- **Bestätigungsblatt**: Upgrade „Heute zahlst du anteilig 67,40 € (Gutschrift für den Rest
  von Pro). Ab 14.12. 149 € im Monat. Dein Kontingent für November steigt auf 92,30 €.“
  Downgrade: Wirkdatum, Bestandswarnung, „Du behältst alle Daten“.
- **Ultra-Zusatz**: Karte „Über das Kontingent hinaus“: Schalter (nur Owner/Admin) + Limit-
  Feld, Dialog mit Stufenpreisen, „gilt bis 30.11., danach wieder aus“, Stand „bisher 12,50 €
  über dem Kontingent“.
- **LinkedIn-Beobachtung**: Abschnitt unter Plan & Abrechnung und Hinweiszeile im Bereich
  LinkedIn: Monatsverbrauch gegen Limit, je Funktion, Limit-Feld, Preistabelle, Pause-Zustand.
- **Aufnahme-Dialog** bei `402 kontingent_erschoepft`: „Dein Kontingent reicht für 12 der 20
  Firmen“ mit „Auf Max wechseln und alle aufnehmen“ (nur `kannSelbstWechseln`, sonst
  „Admin um Upgrade bitten“), „Nur 12 aufnehmen“, „Abbrechen“ (Ultra: „Für diesen Monat über
  das Kontingent hinaus“). Gleiche Komponente für Chat-Import, Radar, Leads.
- **Überall sonst**: `UsageChip` zeigt Kontingent in €; `QuotaExhaustedBanner` mit „Plan
  ändern“/„Admin bitten“; Ingest.tsx-Hinweis; Meine Firmen: Stufen-Pille und Monatswert je
  Firma; Texte „Starter-Plan“ ersetzen; `PLAN_CARDS` weg, Katalog aus `GET /v1/plaene`.
- Chat-Werkzeuge: `abrechnung_status` (Plan, Kontingent anteilig, LinkedIn, Rolle),
  `plan_wechseln` (confirmAction, nur Owner/Admin für sich; Mitglied → `plan_anfragen`),
  `payg_freigeben`, `linkedin_limit_setzen`, `payg_limit_setzen` (ersetzt
  `abrechnung_limit_setzen`). Fähigkeitsgruppe „abrechnung“, Vorschläge, Systemprompt.
- Jargon-Prüfung um „Tier“, „Pay-as-you-go“ (→ „nach Verbrauch“), „Apify“, „Proration“
  erweitern; hell/dunkel/mobil messen.

### P7 Konsole admin.ava.bi

- **/mitglieder (Owner/Admin)**: Kopfzeile „Sitze: Pro 3 (2 belegt) · Max 1 (1 belegt) ·
  Free 3 von 3 · nächste Abrechnung 14.12.“ mit „Sitz hinzufügen“; Spalte „Plan“ je Mitglied
  mit Auswahl (freie Sitze zuerst, sonst „Sitz dazukaufen, heute anteilig X €“), vorgemerkte
  Reduktionen mit Widerruf; Beitrittsanfragen als Block „Wartend“ mit Sitz-Auswahl beim
  Freigeben; Einladen-Dialog mit Sitz-Auswahl, Free gesperrt, wenn drei belegt („Weise einem
  der drei Free-Nutzer einen Sitz zu oder lade mit Sitz ein“). Enterprise: Spalte
  „Enterprise“, Kopfzeile „Mitglieder 7 von 10“.
- **/abrechnung (Owner/Admin)**: Zahlungsmittel/Rechnungsadresse (Portal), Rechnungen der
  Organisation, Sitze und Mengen mit Zyklus, Monatsübersicht je Mitglied (Kontingent-
  Auslastung, PAYG, LinkedIn), LinkedIn-Limits je Mitglied, PAYG-Freigaben. Seats-Aktivierung entfällt für neue Konten (Altkonten lesen).
  Feste Preistexte raus, Werte aus `/v1/plaene`.
- **/verarbeitungskosten (Betreiber)**: Rechner mit „Nutzer je Plan“ und „Firmen je Stufe je
  Nutzer“ (Durchschnitt), „LinkedIn-Items je Monat“; Ausgabe: Umsatz je Monat (Pläne +
  LinkedIn), Direktkosten (Stufen + Apify), Marge/Aufschlag, Worst Case je Plan (voll mit
  großen Firmen). Angebot-PDF **nur noch für Enterprise**: Positionen „AVA Enterprise –
  Lizenz je Nutzer“, „Firmen im Bestand je Stufe“ (oder Fixpreis), „LinkedIn-Beobachtung“ als
  Hinweis oder Pauschale, „Onboarding“; Laufzeit 12 Monate mit Jahresnachlass bleibt. Für
  Pro/Max/Ultra kein Angebot, sondern Verweis auf die Self-Service-Pläne.
- **/betreiber**: Kundenliste je Organisation mit Mitgliedern je Plan, Kontingent-Auslastung,
  PAYG, LinkedIn-Verbrauch, Apify-Kosten der Firmenverarbeitung (Spur) **und** der
  Beobachtung getrennt; Kundenansicht: Enterprise an/aus, `maxMitglieder`, `firmenLimit`,
  `linkedinLimitCents`, Fixpreis (Information), Plan im Auftrag des Kunden setzen, Actor-
  Preistabelle, Apify-Monatslimit des Betreiberkontos mit Füllstand (P0). Enterprise-
  Empfehlung rechnet mit Nutzern × Stufenmix statt Seats.
- Proxy-Allowlist um alle neuen Pfade ergänzen.

### P8 PWA (ava-app)

- Unter „Mehr“ Karte „Dein Plan“: Plan, Kontingentbalken, LinkedIn-Verbrauch, Link zur
  Konsole („Plan ändern“ bzw. „Wechsel anfragen“). `402 kontingent_erschoepft` mit Hinweis.
  Allowlist um `/v1/usage`, `/v1/plaene`.

### P9 Migration, Texte, Betrieb

- **Bestandskunden**: je Organisation ein neues Abo mit Sitzen (Pro-Sitz je bisherigem
  Pro-Nutzer bzw. nach Oktober-Bestandswert; Skript macht Vorschlag, Joyce gibt je Organisation
  frei); bisherige persönliche Pro-Abos zum Zyklusende kündigen, Rest als Gutschrift auf das
  Organisationsabo; Sammelabrechnung (Seats) endet mit der letzten Periode; Starter → Pro-Sitz.
  Organisationen mit mehr als drei Free-Nutzern: Bestandsschutz bis Umschalttag + 30 Tage,
  danach Einladungssperre (keine Zwangsentfernung). Free unverändert.
- **Website/AGB**: Preisseite mit vier Plänen je Nutzer, 3 Free-Plätze, Kontingent-Regeln,
  LinkedIn nach Verbrauch mit Preistabelle, Enterprise für Sammelabrechnung; Do-not-claim-Liste;
  AGB-Bausteine (Zyklus je Nutzer, Wechsel zum Zyklusende, anteiliges Kontingent, Pay-as-you-go-
  Zustimmung je Monat). README-Abschnitt Abrechnung.
- **Monitoring**: Betreiber-Kennzahlen Plan-Verteilung je Organisation, Auslastung, Wechsel
  (BillingEvent `plan_zugewiesen`, `plan_upgrade`, `plan_downgrade_geplant`,
  `plan_downgrade_wirksam`, `plan_anfrage`, `payg_freigegeben`, `linkedin_limit_gesetzt`,
  `linkedin_limit_erreicht`, `free_plaetze_voll`).
- Doku: PLAN_ABRECHNUNG_ZUGANG.md und PLAN_ABRECHNUNG_SEATS.md mit Verweis „abgelöst durch
  PLAN_PRICING_TIERS.md“ für Nicht-Enterprise; DECISIONS.md.

## 4. Reihenfolge und Aufwand (grob)

| Schritt | Inhalt | Aufwand | Abhängigkeit |
|---|---|---|---|
| P0 | Kontakt-Takt 90 Tage, Apify-Alarm | 0,5 Tag | – |
| P1 | Migration, Plan-Katalog, tagesanteiliges Kontingent | 1,5 Tage | – |
| P2 | Sitze/Zuweisung/Wartezustand, Free-Deckel, Kontingent-Prüfung überall, Verbuchung, Meldungen | 3 Tage | P1 |
| P3 | Stripe: ein Abo je Org mit Mengen je Plan, anteilig hoch / zum Zyklusende runter, Vorschau, Webhooks | 1,5 Tage | P1, Stripe-Dashboard |
| P4 | LinkedIn nach Verbrauch | 1,5 Tage | P1 |
| P5 | Neuverarbeitung-Regeln | 1 Tag | P2 |
| P6 | Desktop Plan & Abrechnung, Aufnahme-Dialog, Chips, Werkzeuge | 3 Tage | P2–P4 |
| P7 | Konsole: Mitglieder/Pläne, Abrechnung, Rechner/Angebot, Betreiber | 3 Tage | P2–P4 |
| P8 | PWA-Karte | 0,5 Tag | P2 |
| P9 | Migration, Texte, Monitoring | 1,5 Tage + Freigaben | P3 |

Gesamt etwa 17 Arbeitstage. Gateway zuerst hinter Feature-Schalter `PRICING_TIERS=1`
(Altlogik bleibt bis zum Umschalten), dann Konsole (Zuweisung muss vor der App da sein), dann
Desktop/PWA, Umschalten und Migration an einem Monatsersten, empfohlen 2026-12-01.

## 5. Entschieden (Joyce, 2026-11-01)

- Plan je Nutzer als **Sitz**, Zuweisung durch die Organisation, Standard Free, höchstens 3
  Free je Organisation; wer ohne verfügbaren Platz beitritt, wartet auf Freigabe.
- **Sitz-Modell nach Vorbild Claude Team / ChatGPT Business** (Joyce, 2026-11-01 spät): ein
  Abo und ein Zyklus je Organisation, Sitze sofort anteilig dazu, Reduktion zum Zyklusende,
  Kontingent je Nutzer nicht gepoolt; ersetzt die zwischenzeitliche Vorgabe „eigener Zyklus je
  Nutzer“.
- Kontingent beim Upgrade anteilig; Stufen-Erhöhung nie nachberechnen; LinkedIn-Preise als
  Tabelle; keine Jahrespläne (Enterprise-Angebote behalten den Jahresnachlass).
- Enterprise manuell, ohne Standard-Limits, Betreiber kann Mitgliederzahl, Firmen-Limit und
  LinkedIn-Limit je Organisation setzen; Kosten je Organisation immer einsehbar.
- Apify-Kontakte im Kontakt-Producer im Stufenpreis; Beobachtung rein nach Verbrauch.

## 6. Noch offen (Empfehlung jeweils zuerst)

1. **PAYG- und LinkedIn-Freigaben nur durch Owner/Admin** (Empfehlung, Kosten landen auf dem
   Zahlungsmittel der Organisation) oder jedes Mitglied für sich?
2. **Free in bezahlter Organisation**: 25 Firmen lebenslang wie heute (Empfehlung) oder nur
   lesen?
3. **Enterprise-Firmen-Limit**: harte Sperre (Empfehlung) oder nur Hinweis an den Betreiber?
4. **Mindestsitze**: keine (Empfehlung; Ein-Personen-Organisationen sind der Normalfall) oder
   wie die Vorbilder ab zwei Sitzen?
5. **Umschalttermin** 2026-12-01; Bestandskunden starten mit Sitzen, deren Kontingent ihren
   Oktober-Bestandswert deckt (Empfehlung).

## 7. Risiken und Hinweise

- **Marge bei großen Firmen** hängt am Apify-Delta-Abruf (P0): Ultra voll mit großen Firmen
  ≈ 62 € Direktkosten auf 299 €; ohne die Prüfung der Mitarbeiterzahl wären es im 14-Tage-Takt
  ≈ 190 € Apify.
- **Free-Deckel umgehen**: Die 25 Free-Firmen hängen am Nutzer (lebenslang), eine zweite
  Organisation bringt derselben Person nichts; bleibt der übliche Freemium-Missbrauch mit
  mehreren E-Mail-Adressen, wie bei den Vorbildern.
- **Doppelzählung je Nutzer** kann Teams überraschen, die Listen teilen; klarer Satz in App
  und Preisseite („Jeder Nutzer hat sein eigenes Kontingent“).
- **Zwei Wahrheiten Stripe/Gateway** bei Mengen und Schedules: Reconcile gleicht Mengen je
  Plan mit der Sitz-Tabelle ab und beendet nie zugewiesene Sitze automatisch.
- **Schätzung vs. Ist bei LinkedIn**: Limit-Prüfung mit 20 % Puffer; Preisänderungen der
  Actors monatlich gegen die Tabelle prüfen.
- **Sammelabrechnung/Seats** wird für neue Konten stillgelegt; Code bleibt für Altkonten bis
  zur letzten Migration und für Enterprise-Export.
