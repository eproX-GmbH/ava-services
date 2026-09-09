# Plan: Abrechnung — Einzel-Abo haerten, Seat-Sammelabrechnung fuer Organisationen

Stand 2026-09-06 (Code v0.1.543, Gateway mit O1–O6/O8). Status: B1 + B2
UMGESETZT (2026-09-06, siehe STATUS am Ende); B3 ohne Stripe-Rechnung
(A-2), B4 offen.

Baut auf `PLAN_ORGANISATIONEN.md` (Tenant/Mitglieder/Policy) und dem
Monetization-Track M1–M3 (`lib/billing.ts`, `routes/v1/billing.ts`,
Q-Track Parken/Resume) auf. Beruehrt `PLAN_ENTERPRISE_FREIGABE.md`
E6.3 (Lizenz ueber Gruppen) und E1.3 (Audit-Events).

---

## 0. Kurzfassung

**Empfehlung: „Belegungsmonat" statt anteiliger Abrechnung.** Eine
Organisation zahlt am Monatsende **eine** Rechnung ueber alle Seats des
abgelaufenen Monats. Ein Seat zaehlt, wenn die Person an mindestens
einem Tages-Stichtag (00:00 UTC) des Monats Mitglied war. Kein Seat
wird anteilig berechnet, nichts wird erstattet, nichts vorausbezahlt.
Wer am 20. beitritt, kostet den Monat; wer am 3. geht, kostet den
Monat; wer am selben Tag rein- und wieder rausgeht, kostet nichts. Ein
Tier-Upgrade im Monat wird als das hoehere Tier berechnet, ein
Downgrade wirkt ab Folgemonat. Damit gibt es genau eine Rechenregel,
und sie ist aus einem Datensatz (Mitgliedschafts-Intervalle) jederzeit
reproduzierbar — das ist die geforderte Auditierbarkeit.

**Technisch:** Stripe bleibt Zahlungs- und Rechnungsmaschine, aber die
Organisation bekommt **kein Stripe-Subscription-Objekt mit Menge**,
sondern das Gateway erzeugt am Monatsersten aus dem eigenen
Abrechnungsdatensatz eine Stripe-Rechnung (Stripe Invoicing:
Rechnungs-PDF, Steuer, Einzug per Karte/SEPA oder Rechnung mit
Zahlungsziel, Mahnwesen). Damit entfaellt jede Proration-Logik von
Stripe-Seite, und Konzernkunden koennen auf Rechnung zahlen.

**Voraussetzung:** Abrechnung und Datenmandant muessen getrennt werden.
Heute ist beides `tenantId`; seit den Organisationen (O1) ist der
`tenantId` eines Mitglieds die Organisation — mit der Folge, dass alle
Mitglieder heute stillschweigend die Free-Zeile der Organisation
teilen und ihre persoenlichen Abos verwaist weiterlaufen (Abschnitt 1.2).
Der neue Begriff **Abrechnungskonto** (`billingAccountId`) loest das:
persoenlich = der Nutzer, Sammelabrechnung = die Organisation.

**Einzel-Abo** bleibt wie heute (Stripe Checkout, Portal, Kuendigung
zum Periodenende) und wird gehaertet: Webhook-Idempotenz, Zustand
`past_due`, taegliche Abgleichung mit Stripe, Audit-Events.

Aufwand: ≈ 22 Entwicklertage in vier Stufen (Abschnitt 10).

---

## 1. Ist-Zustand (am Code erhoben)

### 1.1 Was existiert

| Baustein | Beleg | Verhalten |
|---|---|---|
| `TenantBilling` (tier, quotaLimit, stripeCustomerId, stripeSubscriptionId, periodEnd, cancelAtPeriodEnd) | `prisma/schema.prisma:254-269` | eine Zeile je `tenantId`, lazily als `free/25` angelegt (`lib/billing.ts` `ensureBillingRow`) |
| `UsageEntry(tenantId, periodKey, companyId)` | `schema.prisma:290-300` | Kontingentverbrauch: ein Eintrag je erfolgreichem `structured-content`-Persist, idempotent je Periode (`persist-bus.ts:908`) |
| Tiers und Limits | `lib/billing-plans.ts` | free 25 lebenslang, starter 500/Monat (49 €), pro 2000/Monat (149 €), enterprise unbegrenzt; Preise nur in der Desktop-UI (`Settings.tsx:4943-4983`) |
| Periode | `periodKeyFor` | UTC-Kalendermonat, **nicht** an den Stripe-Abrechnungstag gebunden; Resume-Cron rollt `periodEnd` monatsweise (`quota-resume-worker.ts:117-123`) |
| Checkout | `routes/v1/billing.ts` | Stripe Checkout (Subscription, `quantity: 1`, automatic tax), In-place-Upgrade mit Proration bei bestehendem Abo, Stale-Customer-Heilung (v0.1.158), 409 bei gleichem Tarif |
| Portal | dito | Stripe Customer Portal (Kuendigung, Zahlungsmittel, Downgrade) |
| Webhook | dito | `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed` (nur Log); Upsert je `tenantId`; **kein Event-Dedupe, keine Reihenfolgepruefung** |
| Vorabpruefung | `assertQuotaAvailable` → 402 `quota_exceeded`; `/internal/quota/try-reserve` mit `FOR UPDATE` | Import parkt Firmen (`ParkedCompany`), Resume bei Tier-Wechsel/Cron |
| Tier-Gates ausserhalb Kontingent | `lib/discovery.ts:118-160` (Radar-Staffelung), Desktop `watchlist/store.ts:164`, `radar-supervisor.ts:160-172`, `agent/tools/discovery.ts:200` | lesen `TenantBilling.tier` des **Tenants** bzw. `/v1/usage` (30-Min-Cache im Desktop, `index.ts:985-1010`) |
| Desktop | `main/billing.ts`, `Settings.tsx` „Plan & Verbrauch" | Checkout/Portal im Systembrowser, `ava://billing/*`-Rueckkanal, Plan-Karten, Kuendigungshinweis; Chat-Tools `billing_open_checkout/portal` |
| O6 `TenantQuota` | Migration `20260905_tenant_quota` | Limits fuer LLM-Stellvertreteraufrufe in Cent — **kein** Seat-Bezug |

### 1.2 Befund: Abrechnung und Organisation kollidieren heute

- Auth loest `tenantId` = Organisation auf, sobald ein Nutzer Mitglied ist (`middleware/auth.ts`, `lib/membership-cache.ts`); Persist-Events tragen `AVA_TENANT_ID` = Organisation (`producer-supervisor.ts:717`).
- `recordUsage`, `getUsageSnapshot`, `assertQuotaAvailable`, Radar-Limits lesen ausschliesslich `TenantBilling[tenantId]`. Fuer eine Organisation existiert diese Zeile nur lazily als **free/25 lebenslang**.
- Folge: Alle Mitglieder teilen sich 25 Firmen, unabhaengig von ihren persoenlichen Abos; das persoenliche Starter-/Pro-Abo (auf `TenantBilling[sub]`) wird weiter von Stripe abgebucht, aber nicht mehr genutzt. Beim Verlassen der Organisation greift es wieder.
- Beitritt/Entfernen (`lib/tenants.ts` `decideJoinRequest`, `removeMember`) fassen `TenantBilling` nicht an; `TenantMember`-Zeilen werden **geloescht**, es gibt keine Mitgliedschaftshistorie (`joinedAt` nur der aktuellen Zeile).
- Einzige Operator-Loesung heute: `tier='enterprise'` per psql auf die Organisation.

### 1.3 Weitere Haertungsluecken im Einzel-Abo

- Webhooks ohne `StripeEvent`-Dedupe und ohne `event.created`-Vergleich: ein verspaetetes `subscription.updated` kann ein spaeteres `subscription.deleted` ueberschreiben.
- `invoice.payment_failed` aendert nichts; es gibt keinen Zustand `past_due`/`unpaid` — der Nutzer behaelt das Tier bis Stripe das Abo loescht.
- Kein Abgleich mit Stripe ausserhalb der Webhooks (verpasster Webhook = dauerhaft falscher Tier).
- Kontingentperiode (UTC-Monat) und Stripe-Periode (Vertragstag) laufen auseinander; `periodEnd` in `TenantBilling` ist der Stripe-Wert, die Anzeige „Monat" der Kalendermonat.
- Kein Audit-Datensatz je Tier-/Abo-Aenderung (nur Logzeilen).
- Downgrade nur ueber das Portal; die Portal-Konfiguration (Proration, erlaubte Preise) liegt ausserhalb des Repos.
- Free-Tier-Kontingent „25 lebenslang" wird ueber `periodKey='lifetime'` gezaehlt; ein Wechsel Free→Starter→Free laesst die 25 verbraucht.

---

## 2. Ziele und Nicht-Ziele

**Ziele**
1. Einzelnutzer schliessen weiter selbst ueber Stripe ab; nichts aendert sich fuer sie ausser mehr Robustheit.
2. Organisationen koennen per Opt-in **Sammelabrechnung** aktivieren: alle Seats auf einer Monatsrechnung, mindestens Starter, nie Free.
3. Fixe monatliche Betraege, keine anteilige Berechnung, keine Erstattung, keine Vorauszahlung von Seats.
4. Jede Rechnung ist aus einem Datensatz reproduzierbar (wer, welches Tier, welche Tage, welcher Preis) und als Export verfuegbar.
5. Alle Beitritts-/Austritts-/Tierwechsel-Faelle sind deterministisch geregelt (Abschnitt 7).

**Nicht-Ziele**
- Keine Zahlung „pro Firma" oder anderes Metering fuer Seats.
- Kein Mischbetrieb „Organisation zahlt manche, andere zahlen selbst" innerhalb einer Organisation (entweder Sammelabrechnung fuer alle Mitglieder oder fuer keines).
- Keine Aenderung der Kontingentgroessen je Tier.

---

## 3. Abrechnungsmodell „Belegungsmonat"

### 3.1 Regeln

| # | Regel |
|---|---|
| R1 | Abrechnungsperiode = UTC-Kalendermonat (deckungsgleich mit `periodKey`). Rechnung entsteht am 1. des Folgemonats (nachschuessig). |
| R2 | **Seat-Zaehlung:** Eine Person zaehlt als Seat des Monats, wenn ihre Mitgliedschaft in der Organisation an mindestens einem Tages-Stichtag (00:00:00 UTC) innerhalb des Monats bestand. Gezaehlt wird je Person, nicht je Platz: Rotation eines Platzes ueber mehrere Personen ergibt mehrere Seats. |
| R3 | **Tier je Seat:** das hoechste Tier, das die Person an einem gezaehlten Stichtag hatte (Upgrade im Monat = hoeheres Tier fuer den ganzen Monat, eine Zeile). |
| R4 | **Downgrade** (Organisation oder einzelner Seat) wird zum naechsten Monatsersten wirksam; Berechtigungen bleiben bis dahin auf dem hoeheren Tier. Kein Refund noetig. |
| R5 | **Austritt/Entfernen** beendet den Zugang sofort; der Seat bleibt fuer den laufenden Monat gezaehlt (R2). |
| R6 | **Beitritt** aktiviert das Seat-Tier sofort (der Nutzer bekommt sofort Starter/Pro-Berechtigungen); gezaehlt wird ab dem ersten Stichtag (R2). Beitritt und Entfernen am selben UTC-Tag vor Mitternacht = kein Seat. |
| R7 | **Aktivierung der Sammelabrechnung** wirkt sofort auf alle Mitglieder; der erste Rechnungsmonat ist der Aktivierungsmonat (alle Mitglieder mit ≥ 1 Stichtag). |
| R8 | **Deaktivierung** wirkt zum Monatsende: letzte Rechnung fuer den laufenden Monat; ab dem 1. gilt fuer jedes Mitglied wieder sein persoenliches Abrechnungskonto. |
| R9 | **Kontingent** der Organisation im laufenden Monat = Σ Tier-Kontingent aller aktuell belegten Seats (500 je Starter, 2000 je Pro), gemeinsam genutzt; Verbrauch (`UsageEntry`) haengt am Abrechnungskonto der Organisation. |
| R10 | Rechnungsbetrag = Σ je Tier (Seats × Listenpreis) zzgl. Steuer (Stripe Tax). Rabatte ueber Stripe-Coupons am Kunden, nicht in der Zaehlung. |

### 3.2 Beispiele (Starter 49 €, Pro 149 €)

| Fall | Ergebnis |
|---|---|
| A ist den ganzen Monat Mitglied (Starter) | 1 × 49 € |
| B tritt am 20. bei, bleibt | 1 × 49 € (Stichtage 21.–31.) |
| C tritt am 5. bei, wird am 6. entfernt | 1 × 49 € (Stichtag 6. 00:00 bestand) |
| D tritt am 5. um 09:00 bei, wird am 5. um 17:00 entfernt | 0 € |
| E ist Starter, wird am 12. auf Pro gehoben | 1 × 149 € |
| F ist Pro, Organisation stellt am 12. auf Starter um | 1 × 149 € in diesem Monat, 49 € ab Folgemonat |
| G verlaesst am 2., H nimmt am 3. den „Platz" | 2 Seats |
| Organisation aktiviert Sammelabrechnung am 28. mit 6 Mitgliedern | 6 Seats fuer diesen Monat (Stichtage 29.–31.) |

Die Faelle B und C sind die bewussten Haerten des Modells: Sie kaufen die
Einfachheit (keine Tagesbruchteile, keine Erstattung). Als optionale
Abmilderung ohne Proration ist ein **Karenzband** moeglich: Seats, die
erst nach dem 25. (konfigurierbar) erstmals gezaehlt wuerden, werden dem
Folgemonat zugeschlagen. Empfehlung: Default aus, als Operator-Schalter
je Organisation vorhalten (Entscheidung A-3).

### 3.3 Warum nicht Stripe-Mengen-Abos mit `proration_behavior: none`

Ein Stripe-Subscription-Item mit `quantity` und abgeschalteter Proration
rechnet **vorschuessig**: Mengenerhoehung im Monat ist bis zur naechsten
Rechnung kostenlos, Verringerung wird nicht erstattet. Das entspricht
„fixe Betraege", laesst aber Platz-Rotation zu (ein Seat, viele
Personen) und zaehlt niemals Personen. Stripe-Meter (nutzungsbasiert)
wuerde R2 abbilden, verlangt aber, dass alle Meter-Events vor dem
Periodenende gemeldet sind, und macht die Monatslogik von der
Stripe-Periode abhaengig. Eigenes Zaehlen plus **Stripe Invoicing**
(Rechnung aus Positionen, `auto_advance`, `collection_method`
`charge_automatically` oder `send_invoice`) ist die kleinste Loesung,
die R1–R10 exakt umsetzt und Zahlung auf Rechnung fuer Konzerne erlaubt.

---

## 4. Entscheidungen, die vor der Umsetzung fallen muessen

| # | Frage | Empfehlung |
|---|---|---|
| A-1 | Ein Tier fuer alle Seats der Organisation oder Tier je Seat? | **Stufe 1: ein Organisations-Tier** (Starter oder Pro, Free ausgeschlossen). **Stufe 3 (optional): Seat-Upgrade einzelner Mitglieder auf Pro**, nie unter das Organisations-Tier. Das Datenmodell traegt das Tier je Seat von Anfang an; die UI kommt spaeter. Begruendung: Mischtarife machen Rechnung, Admin-UI und Erklaerung komplexer, das Kontingent ist ohnehin gepoolt (R9). |
| A-2 | Rechnungsmechanik: Stripe Invoicing aus eigenem Datensatz (empfohlen) oder Stripe-Meter-Subscription? | **Stripe Invoicing.** Fallback Meter, falls die Buchhaltung ein Subscription-Objekt je Kunde verlangt. |
| A-3 | Karenzband (Seats ab dem 25. zaehlen im Folgemonat)? | Als Operator-Schalter vorsehen, **Default aus**. |
| A-4 | Zahlungsarten fuer Organisationen | Karte + SEPA-Lastschrift automatisch (Default, via Stripe Checkout `mode: setup`); **Rechnung mit 14 Tagen Zahlungsziel nur nach Operator-Freigabe** (`invoicePaymentAllowed`). |
| A-5 | Persoenliches Abo eines Mitglieds beim Beitritt zu einer Organisation mit Sammelabrechnung | **Automatisch `cancel_at_period_end`** mit Hinweis (kein Refund, Restlaufzeit unberuehrt, im Portal widerrufbar). Berechtigung kommt ab sofort aus dem Seat. |
| A-6 | Organisation ohne Sammelabrechnung: Woher kommt das Tier der Mitglieder? | **Vom persoenlichen Abrechnungskonto** jedes Mitglieds (eigener Verbrauch, eigenes Kontingent, eigene Feature-Gates). Das behebt den Befund 1.2 und erhaelt „Nutzer koennen weiterhin einzeln abschliessen". Organisationsweite Kontingente gibt es nur mit Sammelabrechnung. |
| A-7 | Wer darf Sammelabrechnung aktivieren/deaktivieren, Tier wechseln, Zahlungsmittel aendern? | **Nur `owner`.** Admins duerfen Mitglieder aufnehmen (erhoeht Kosten); optional `maxSeats` in der Policy als Deckel, Owner wird bei jeder Aufnahme mit Kostenwirkung benachrichtigt. |
| A-8 | Zeitzone der Stichtage | **UTC** (deckungsgleich mit `periodKey`; Abweichung zur Berliner Mitternacht 1–2 h, nur fuer Beitritte um Mitternacht relevant). |
| A-9 | Zahlungsstoerung: Karenz und Wirkung | Stripe Smart Retries; `past_due` ab erstem Fehlschlag mit Banner; nach **14 Tagen** `suspended`: keine Importe/Radar-Scans (402 `billing_suspended`), Lesen bleibt; nach Zahlung sofort `active`. Gleiche Maschine fuer Einzel-Abos. |
| A-10 | Kontingentperiode Einzel-Abo: Kalendermonat (heute) oder Stripe-Periode? | **Kalendermonat beibehalten**, in der UI ehrlich benennen („Kontingent je Kalendermonat, Abrechnung am Vertragstag"). Umstellung waere Aufwand ohne Nutzen. |
| A-11 | Enterprise-Organisationen (Vertrag, Operator-gepflegt) | `tier='enterprise'` bleibt Operator-Setzung; Seat-Zaehlung laeuft trotzdem (Reporting), Rechnung wird **nicht** ueber Stripe erzeugt, sondern als Datensatz exportiert. |

---

## 5. Datenmodell (Gateway)

```
BillingAccount        id (= actorId fuer persoenlich | tenantId fuer Organisation)
                      kind: personal | organisation
                      mode: stripe_subscription | seats | enterprise | none
                      tier (Organisations-Tier bei seats; Abo-Tier bei stripe_subscription)
                      status: active | past_due | suspended | canceled
                      stripeCustomerId, stripeSubscriptionId (nur stripe_subscription)
                      paymentMethod: card | sepa | invoice | none
                      invoicePaymentAllowed BOOL (Operator)
                      graceDays INT (Default 14), suspendedAt, periodEnd, cancelAtPeriodEnd
                      karenzTag INT NULL (A-3), maxSeats INT NULL
                      createdAt, updatedAt
                      → ersetzt TenantBilling (Migration: jede TenantBilling-Zeile wird
                        BillingAccount kind=personal, mode aus stripeSubscriptionId abgeleitet)

TenantMembership      id, tenantId, actorId, role, joinedAt, leftAt NULL, leftReason,
                      seatTier NULL (A-1 Stufe 3), seatTierSince
                      → Historie; TenantMember bleibt als "aktuelle Sicht" (View oder
                        Tabelle mit leftAt IS NULL), Loeschung wird zu leftAt = now()

SeatTierChange        tenantId, actorId NULL (NULL = Organisations-Tier), tier, validFrom
                      → Intervalle fuer R3/R4

SeatInvoice           id, tenantId, periodKey, status: draft | issued | paid | void |
                      uncollectible | enterprise_export, currency, subtotalCents, taxCents,
                      totalCents, stripeInvoiceId, stripeInvoiceUrl, pdfUrl,
                      computedAt, issuedAt, paidAt, computeHash (sha256 der Zeilen)
                      UNIQUE(tenantId, periodKey)
SeatInvoiceLine       invoiceId, tier, seats, unitPriceCents, amountCents
SeatInvoiceSeat       invoiceId, actorId, email, name, tier, firstCountedDay,
                      lastCountedDay, countedDays, membershipIds[]
                      → der Personen-Nachweis je Rechnung

BillingEvent          id, billingAccountId, ts, kind (checkout_completed, tier_changed,
                      seat_mode_enabled/disabled, seat_counted, invoice_issued, invoice_paid,
                      payment_failed, suspended, reactivated, reconciled_from_stripe, …),
                      source: webhook | admin | cron | operator, stripeEventId NULL,
                      actorId NULL, payload JSON
                      → Audit; spaeter Emitter in AuditEvent (E1.3)

StripeEvent           id (Stripe event id) PK, type, created, processedAt
                      → Webhook-Dedupe und Reihenfolge

UsageEntry            tenantId → billingAccountId (Spalte umbenennen, Index anpassen)
ParkedCompany,        bleiben je Daten-Tenant (das Parken gehoert zum Import), Kontingent-
DiscoveryQuotaOverride  Aufloesung ueber billingAccountId
```

**Aufloesung `billingAccountFor(auth)`** (eine Funktion, ueberall genutzt):
1. Tenant ist Organisation **und** `BillingAccount[tenantId].mode ∈ {seats, enterprise}` → Organisation.
2. Sonst → `actorId` (persoenliches Konto), auch wenn der Daten-Tenant die Organisation ist.

Alle heutigen `TenantBilling`-Leser (`billing.ts`, `internal-quota.ts`,
`discovery.ts`, `quota-resume-worker.ts`, Persist-Bus) werden auf diese
Funktion umgestellt. Der Persist-Event traegt dafuer neben
`AVA_TENANT_ID` den `actorId` (kommt heute schon als `userId` in
master-data an; im Gateway-Persist-Pfad ergaenzen).

---

## 6. Ablaeufe

### 6.1 Sammelabrechnung aktivieren (Owner)
1. Organisation → Abrechnung → „Sammelabrechnung aktivieren", Tier waehlen (Starter/Pro), Vorschau: aktuelle Mitglieder × Preis.
2. `POST /v1/tenants/me/billing/seats/activate {tier}` → Stripe Customer fuer die Organisation (Name, Rechnungsadresse, USt-ID aus Formular), Checkout `mode: setup` (Karte/SEPA) → Systembrowser; Rueckkanal `ava://billing/seats-setup`.
3. Webhook `checkout.session.completed` (setup) → `BillingAccount[org].mode = seats, status = active, paymentMethod`. Ab jetzt: `billingAccountFor` liefert die Organisation; alle Mitglieder erhalten sofort das Organisations-Tier; `SeatTierChange(org, tier, now)`.
4. Fuer jedes Mitglied mit persoenlichem Stripe-Abo: `cancel_at_period_end=true` (A-5), `BillingEvent personal_sub_scheduled_cancel`, OS-/Chat-Hinweis an das Mitglied.
5. Rechnung auf Rechnung (A-4): statt Checkout ein Antrag; Operator setzt `invoicePaymentAllowed`, Aktivierung ohne Zahlungsmittel mit `collection_method: send_invoice`.

### 6.2 Beitritt (Admin nimmt an)
- `decideJoinRequest` schliesst eine offene `TenantMembership` des Nutzers (`leftAt`), oeffnet eine neue, `BillingEvent member_joined`. Bei `mode = seats`: persoenliches Abo wie 6.1.4; optional `maxSeats`-Pruefung (409 `seat_limit_reached`); Owner-Benachrichtigung mit Kostenwirkung.
- Der Desktop des Beigetretenen erkennt den Tenant-Wechsel (O2), laedt `/v1/usage` neu und sieht „Dein Zugang wird von <Organisation> bezahlt".

### 6.3 Austritt/Entfernen
- `removeMember`: `leftAt = now()`, `leftReason = removed | left`, Rueckfall auf persoenlichen Tenant und damit auf das persoenliche Abrechnungskonto (Free, sofern kein eigenes Abo). Seat bleibt fuer den Monat gezaehlt (R5). Hinweis an den Entfernten: „Dein Kontingent ist jetzt wieder dein eigenes (Free/…)".
- Vom Nutzer geparkte Firmen (`ParkedCompany` je Daten-Tenant) bleiben bei der Organisation.

### 6.4 Tier-Wechsel der Organisation
- Upgrade: sofort wirksam, `SeatTierChange(org, pro, now)`; Monat wird als Pro berechnet (R3).
- Downgrade: `SeatTierChange(org, starter, naechster 1.)`; UI zeigt „ab 1.10. Starter". Kein Refund.

### 6.5 Monatsabschluss (Cron am 1. um 00:10 UTC, idempotent, nachholbar)
1. Fuer jede Organisation mit `mode ∈ {seats, enterprise}`: Seats des Vormonats aus `TenantMembership`-Intervallen und `SeatTierChange` berechnen (R2/R3, Karenzband A-3), `SeatInvoice(draft)` + Lines + Seats schreiben, `computeHash`.
2. `mode = seats`: Stripe `invoiceItems.create` je Tier-Zeile (Beschreibung „AVA Pro-Seat, September 2026, 4 Seats"), `invoices.create({customer, collection_method, days_until_due, automatic_tax, auto_advance: true, metadata: {tenantId, periodKey}})` mit Idempotency-Key `seat-invoice:<tenantId>:<periodKey>`, `finalize`. `SeatInvoice.status = issued`, Stripe-IDs/URLs speichern.
3. `mode = enterprise`: `status = enterprise_export`, keine Stripe-Rechnung.
4. 0 Seats → keine Rechnung, `SeatInvoice` mit 0 Zeilen fuer den Nachweis.
5. Nachholen: Cron prueft taeglich alle Perioden ohne `SeatInvoice` seit `seatBillingSince` (Gateway-Ausfall am 1.).

### 6.6 Zahlung und Mahnwesen (fuer Seats und Einzel-Abo gleich)
- Webhooks `invoice.paid`, `invoice.payment_failed`, `invoice.marked_uncollectible`, `invoice.voided`; Stripe Smart Retries konfiguriert.
- Zustandsmaschine `BillingAccount.status`: `active → past_due` (erster Fehlschlag, Banner + Mail via Stripe) `→ suspended` (nach `graceDays`) `→ active` (bei `invoice.paid`); `canceled` bei `subscription.deleted` bzw. Deaktivierung.
- `suspended`: `assertQuotaAvailable` wirft 402 `billing_suspended` (neue Fehlerklasse neben `quota_exceeded`), Radar-Automatik pausiert, Lesen/Chat bleiben; Desktop-Banner mit Portal-Link.

### 6.7 Deaktivieren (Owner)
- `POST …/seats/deactivate` → `mode` wechselt zum naechsten 1. auf `none` (Vormerkung sichtbar, widerrufbar); letzte Rechnung im Monatsabschluss. Mitglieder werden vorab informiert: „Ab 1.10. gilt wieder dein persoenliches Abo".

### 6.8 Organisation aufloesen
- Existiert heute nicht (kein Loeschen). Wenn es kommt: nur bei `status ∉ {past_due, suspended}` oder nach Operator-Freigabe; Abschlussrechnung fuer den laufenden Monat wird sofort erzeugt.

---

## 7. Edge-Case-Katalog

| # | Situation | Regelung |
|---|---|---|
| K1 | Mitglied hat persoenliches Pro-Abo, Organisation aktiviert Starter-Seats | Seat = Starter (Organisations-Tier). Persoenliches Abo `cancel_at_period_end`; bis Periodenende gilt **max(persoenlich, Seat)** fuer Feature-Gates, Kontingent aber aus dem Organisationspool. Hinweis an den Nutzer, Upgrade des Seats auf Pro in Stufe 3. |
| K2 | Nutzer tritt am 31. um 23:30 UTC bei | Erster Stichtag 1. 00:00 → zaehlt im Folgemonat. |
| K3 | Nutzer wird versehentlich aufgenommen und am selben Tag entfernt | Kein Seat (R6). |
| K4 | Nutzer wird entfernt und im selben Monat erneut aufgenommen | Eine Person = ein Seat (R2, Zaehlung je Person). |
| K5 | Nutzer wechselt im Monat von Organisation A zu Organisation B | Seat bei A **und** bei B (jeweils eigene Rechnung), sofern beide Stichtage haben. |
| K6 | Owner deaktiviert Sammelabrechnung am 15. | Wirkt zum 1.; Monat wird voll berechnet; Mitglieder ab dem 1. persoenlich (Free, wenn kein Abo). Vorwarnung an alle. |
| K7 | Zahlung schlaegt fehl, Mitglieder arbeiten weiter | `past_due` 14 Tage ohne Einschraenkung, danach `suspended` (keine Importe). Seats werden weiter gezaehlt und berechnet, solange `mode = seats` (Zugang bestand). |
| K8 | `suspended`, Owner behebt Zahlung | `invoice.paid` → `active` sofort; geparkte Firmen werden per Resume-Worker nachgespielt. |
| K9 | Organisation ist Enterprise (Operator) | Keine Stripe-Rechnung; Seat-Datensatz als Export; Kontingent unbegrenzt. |
| K10 | Persoenliches Abo eines Mitglieds laeuft ab, waehrend es Mitglied mit Seat ist | Irrelevant (Seat traegt). Beim spaeteren Austritt: Free. |
| K11 | Mitglied wird `owner`, altes Owner-Konto verlaesst | Abrechnungskonto haengt am Tenant, nicht am Owner; Stripe-Customer-Kontakt (E-Mail) wird auf den neuen Owner aktualisiert (`customers.update`). |
| K12 | Organisation ohne Sammelabrechnung, Mitglied mit Pro-Abo importiert | Verbrauch und Kontingent am persoenlichen Konto (A-6); Daten landen im Organisations-Tenant. Andere Mitglieder haben ihr eigenes Kontingent. |
| K13 | Zwei Importe parallel am Monatsende, Stichtag dazwischen | Unerheblich fuer Seats; Kontingent-Race bleibt ueber `try-reserve` (`FOR UPDATE`) geregelt. |
| K14 | Gateway am 1. nicht erreichbar | Monatsabschluss holt nach (6.5.5); Rechnungsdatum ist der Erstellungstag, Leistungszeitraum bleibt der Vormonat. |
| K15 | Stripe-Webhook verpasst oder doppelt | `StripeEvent`-Dedupe; taeglicher Abgleich (8.2) heilt fehlende Zustaende. |
| K16 | Stripe-Key wechselt Test→Live (bekannter Fall v0.1.158) | Stale-Customer-Heilung auch fuer Organisations-Customer; `BillingEvent customer_recreated`. |
| K17 | Owner senkt `maxSeats` unter die aktuelle Mitgliederzahl | Bestehende Mitglieder bleiben; nur neue Aufnahmen blockiert. |
| K18 | Rabatt/Kulanz | Stripe-Coupon am Customer; Zaehlung unveraendert; Rabatt erscheint auf der Rechnung. |
| K19 | Mitglied ist zugleich Operator-Testkonto | Operator-Tenants: `mode = enterprise`. |
| K20 | Karenzband aktiv (A-3), Beitritt am 26., Austritt am 3. des Folgemonats | Folgemonat hat Stichtage 1.–3. → 1 Seat im Folgemonat, 0 im Beitrittsmonat. |

---

## 8. Refactoring Einzel-Abo (Haertung)

| # | Massnahme | Wo |
|---|---|---|
| H1 | `TenantBilling` → `BillingAccount` (Migration mit Daten-Uebernahme, `UsageEntry.tenantId` → `billingAccountId`), `billingAccountFor()` als einzige Aufloesung, alle Leser umstellen | Gw `lib/billing.ts`, `internal-quota.ts`, `discovery.ts`, `quota-resume-worker.ts`, `persist-bus.ts` |
| H2 | `StripeEvent`-Dedupe + Reihenfolge (`event.created` ≥ zuletzt verarbeitet je Subscription, sonst ignorieren und loggen) | Gw `routes/v1/billing.ts` |
| H3 | Zustandsmaschine `status` inkl. `invoice.paid`/`payment_failed`/`marked_uncollectible`; `graceDays`; 402 `billing_suspended` | Gw `lib/billing-state.ts` (neu) |
| H4 | Taeglicher Stripe-Abgleich: je `stripeCustomerId` `subscriptions.list` → Tier/Status/periodEnd gegen DB; Abweichung → korrigieren + `BillingEvent reconciled_from_stripe` | Gw Cron |
| H5 | `BillingEvent` fuer jede Zustandsaenderung; Leseroute `GET /v1/billing/events` (eigenes Konto) | Gw |
| H6 | Webhook-Signatur-Fehler und Handler-Fehler als Metrik (Prometheus existiert) + Alarmierung | Gw |
| H7 | Portal-Konfiguration ins Repo als Skript (`scripts/stripe-portal-config.mjs`: erlaubte Preise, Proration bei Downgrade, Kuendigung zum Periodenende, Rechnungs-Historie) | Inf |
| H8 | Free-Kontingent nach Rueckkehr aus einem bezahlten Tier: `periodKey='lifetime'` bleibt (Entscheidung dokumentieren) oder Free-Zaehler beim ersten Bezahlabo einfrieren und bei Rueckkehr fortfuehren — Empfehlung: **bleibt** (einfach, keine Doppelnutzung) | Doc |
| H9 | Checkout mit `client_reference_id = billingAccountId` zusaetzlich zu `metadata`, damit der Webhook auch ohne Metadaten zuordnet | Gw |
| H10 | Tests: Webhook-Fixtures (Stripe CLI `stripe trigger` + gespeicherte Events) fuer created/updated/deleted/payment_failed/paid in Reihenfolge und vertauscht; Migrationstest in PGlite | Gw `scripts/test-billing.mjs` |

---

## 9. Desktop und Chat

- **Organisation → Abrechnung** (Owner; Admin lesend): Modus, Organisations-Tier, Zahlungsmittel (Portal), „Seats diesen Monat: 7 (davon 1 neu seit dem 12.)", voraussichtlicher Betrag, Rechnungen (Periode, Seats, Betrag, Status, PDF-Link), Seat-Nachweis je Rechnung als CSV/JSON-Export, `maxSeats`, Aktivieren/Deaktivieren/Tier-Wechsel mit Rueckfrage.
- **Mitglieder-Liste**: Spalte „Seat seit / Tier", bei `mode = seats`.
- **Plan & Verbrauch** (Mitglied mit Seat): Plan-Karten und Checkout **ausgeblendet** (Regel „gesperrte UI komplett ausblenden"), stattdessen „Dein Zugang: Pro-Seat, bezahlt von <Organisation>", Kontingent des Pools, Portal-Button nur fuer das eigene Rest-Abo, solange es laeuft.
- **Banner**: `past_due` (Owner: „Zahlung fehlgeschlagen, bis <Datum> beheben"), `suspended` (alle: „Importe pausiert"), Vormerkungen (Downgrade/Deaktivierung zum 1.).
- **Chat-Tools** (Self-Service-Regel, alle mutierenden mit `confirmAction`): `org_billing_info` (alle Mitglieder, read-only), `org_billing_activate_seats`, `org_billing_deactivate_seats`, `org_billing_set_tier`, `org_billing_invoices`, `org_billing_export_seats` (Owner); `org_member_set_seat_tier` (Stufe 3). Zahlungsmittel bleiben UI/Portal-only (wie Keys).
- **Benachrichtigungen**: Owner bei jeder Aufnahme („+1 Seat, ab <Monat> +49 €"), Mitglieder bei Aktivierung/Deaktivierung/Downgrade, Owner bei Rechnung/Zahlungsstoerung (zusaetzlich zur Stripe-Mail).
- `getTenantTierCached` und Radar-/Watchlist-Gates lesen kuenftig `/v1/usage.entitlement = { tier, source: personal | seat | enterprise, paidBy }`.

---

## 10. Umsetzungsstufen

| Stufe | Inhalt | Tage | Deploy |
|---|---|---|---|
| B1 | **Abrechnungskonto trennen + Haertung**: H1–H6, H9, H10; `TenantMembership`-Historie (Beitritt/Austritt schreiben Intervalle); `/v1/usage` mit `entitlement`; Befund 1.2 damit behoben (Mitglieder ohne Sammelabrechnung nutzen ihr eigenes Konto) | 7 | ja (Migration) |
| B2 | **Seat-Zaehlung + Monatsabschluss**: `SeatTierChange`, `SeatInvoice*`, Zaehlfunktion mit Tests (Beispiele 3.2, Katalog K1–K20 als Testfaelle), Cron 6.5 zunaechst **nur Datensatz** (kein Stripe), Exportroute | 5 | ja |
| B3 | **Stripe-Anbindung Organisation**: Customer + Setup-Checkout, Invoicing (6.5.2), Webhooks `invoice.*`, Zustandsmaschine fuer Organisationen, Portal-Konfiguration (H7), Deaktivierung, A-5-Automatik, Desktop-Seite Abrechnung, Banner, Chat-Tools | 7 | ja |
| B4 | Optional: Seat-Tier je Mitglied (A-1 Stufe 3), Karenzband (A-3), Rechnung auf Rechnung (A-4), `maxSeats` | 3 | ja |
| | **Summe** | **≈ 22** | |

Reihenfolge B1 → B2 → B3. B1 allein ist bereits ein Gewinn (Befund 1.2,
verpasste Webhooks, Zahlungsstoerungen). B2 laeuft einen Monat im
Schatten (Datensatz ohne Rechnung), damit die erste echte Rechnung gegen
einen bekannten Datensatz geprueft werden kann.

## 11. Risiken

- **Migration `TenantBilling` → `BillingAccount`** beruehrt den Persist-Pfad; Feature-Flag `BILLING_ACCOUNT_RESOLUTION=legacy|new` fuer einen Release, Abgleich beider Snapshots im Log.
- **Stripe Invoicing + automatic tax** setzt Kundenadresse/USt-ID voraus; ohne Adresse schlaegt die Rechnungserstellung fehl → Aktivierung verlangt das Formular, Monatsabschluss meldet fehlende Stammdaten als `BillingEvent invoice_blocked` und holt nach.
- **Erster Rechnungsmonat** kann fuer den Kunden ueberraschend sein (Aktivierung am 28. = voller Monat fuer alle). Die Vorschau bei der Aktivierung nennt den Betrag explizit; Operator kann per Karenzband (A-3) oder Coupon abfedern.
- **Timing des Cron** am Monatsersten bei mehreren Gateway-Instanzen: Advisory-Lock je `(tenantId, periodKey)` und Idempotency-Key bei Stripe.
- **Kuendigungsautomatik persoenlicher Abos (A-5)** greift in das Abo eines Dritten ein (des Mitglieds); Hinweis und Widerruf im Portal sind Pflicht, sonst Beschwerden.

---

## STATUS (2026-09-06)

**Entscheidungen (Joyce, 2026-09-06):** A-1 ein Organisations-Tier ·
A-2 erst nur Datensatz erfassen, Stripe Invoicing spaeter · A-5 ja
(persoenliches Abo beim Beitritt automatisch zum Periodenende kuendigen).
Alle anderen Punkte aus Abschnitt 4 laufen mit der jeweiligen Empfehlung
(A-3 Karenzband als DB-Spalte `karenzTag`, Default aus; A-7 nur Owner;
A-8 UTC; A-9 Karenz 14 Tage; A-10 Kalendermonat; A-11 Enterprise ohne
Stripe).

**Umgesetzt (Gateway, Migration `20260906_seat_billing`):**
- Abweichung vom Datenmodell in §5: die Tabelle heisst weiterhin
  `TenantBilling` (kein Rename), `tenantId` ist die billingAccountId;
  neue Spalten kind/mode/status/pastDueSince/suspendedAt/graceDays/
  seatTier/seatBillingSince/seatBillingEndsAt/maxSeats/karenzTag/
  lastStripeEventAt. `UsageEntry.tenantId` → `billingAccountId`.
- `lib/billing.ts`: `resolveBillingAccountId()` (Organisation nur bei
  mode seats|enterprise, sonst persoenliches Konto), `effectiveTier`,
  Seat-Kontingent = Mitglieder × Tier-Kontingent (R9), `entitlement`
  im `/v1/usage`-Snapshot, `billing_suspended` als 402.
- `lib/memberships.ts` + `TenantMembership`: Intervalle bei Anlegen,
  Aufnahme (auch Claim-Altpfad in whoami), Entfernen/Austritt, Rolle;
  Backfill aus `TenantMember`.
- `lib/seat-billing.ts`: `computeSeats` (R2/R3, Karenz), Zeitachse
  `SeatTierChange`, Aktivieren/Beenden/Tier/Deckel (Owner), A-5-Hook,
  Monatsabschluss `closePeriod` (Advisory-Lock, idempotent, nachholbar),
  `applyScheduledSeatChanges`, Datensaetze `SeatInvoice*` mit CSV.
- `lib/billing-cron.ts` (stuendlich): vorgemerkte Aenderungen, Abschluss
  fehlender Monate, past_due → suspended nach graceDays, taeglicher
  Stripe-Abgleich (H4). `BILLING_CRON_DISABLED=1` schaltet ab.
- `routes/v1/seat-billing.ts`: GET billing, activate/deactivate/tier/
  PATCH seats, invoices (+CSV), close.
- `routes/v1/billing.ts` (Einzelabo): Checkout/Portal auf das
  persoenliche Konto (`actorId`) statt Daten-Tenant, 409 fuer Seat-
  bezahlte Mitglieder, `StripeEvent`-Dedupe (H2), Reihenfolge ueber
  `lastStripeEventAt`, `invoice.paid`/`payment_failed` → Zustand (H3),
  `BillingEvent` fuer alle Vorgaenge (H5), `client_reference_id` (H9).
- `internal-quota` try-reserve nimmt `userId` (master-data sendet ihn,
  Submodul-Aenderung in `gateway-client.ts` + `publish-company-producer-
  triggers.ts`); ohne userId Altverhalten.
- Tests: `scripts/test-seat-billing.mts` (15 Faelle aus §3.2/§7).

**Umgesetzt (Desktop):** `UsageSnapshot.entitlement/status`; Plan &
Abrechnung zeigt fuer Seat-Mitglieder Seat/Pool/Rest-Abo statt Plan-
Karten; Banner bei `suspended`; Organisation → Abrechnung (Owner:
aktivieren mit Kostenvorschau, Tier, Deckel, beenden/zuruecknehmen;
Admin lesend; Datensaetze mit Personen-Nachweis und CSV); Kostenhinweis
bei offenen Anfragen; Chat-Tools `org_billing_info`,
`org_billing_activate_seats`, `org_billing_deactivate_seats`,
`org_billing_set_tier`, `org_billing_invoices`; `org_member_approve`
meldet den Seat.

**Offen:** Stripe Invoicing/Zahlungsmittel fuer Organisationen (B3,
A-2 spaeter), Rechnung auf Rechnung (A-4), Owner-OS-Benachrichtigung bei
Aufnahme (heute nur UI-Hinweis + BillingEvent), Portal-Konfiguration als
Skript (H7), Webhook-Fixture-Tests (H10), Seat-Tier je Mitglied (B4),
`docs/DATENMODELL.md`. Deploy: Gateway-Migration + master-data-Bump
(vendor/pin) + Desktop-Release zusammen ausrollen; bis der neue
master-data live ist, laeuft try-reserve ohne userId im Altverhalten.

**Nachtrag 2026-09-09 (v0.1.604):** Chat-Tools zum Aktivieren/Beenden der Sammelabrechnung und zum Tier-Wechsel entfernt (Operator: Preisstufen-Wechsel ohne Zahlungsprozess darf kein Self-Service sein). Offen: Die Seite Organisation → Abrechnung erlaubt dieselben Aktionen (Gateway-Routen `/v1/tenants/me/billing/seats*`, Owner) — Freischaltung durch den Betreiber (z. B. Spalte `selfServiceSeats`) oder Stripe Invoicing (B3) noetig, Entscheidung ausstehend.
