# Abrechnung „Zugang zum Ergebnis“ (2026-10-13)

Entscheidung (Joyce an Patrick und Henning, 2026-10-13): Wir berechnen nicht die
Verarbeitung einer Firma, sondern den **Zugang zum Ergebnis**. Alles, was im geteilten Pool
landet (Firmenprofil, Website-Zuordnung, Kontakte, E-Mail-Urteil, Kunden-Erkennung), rechnet
AVA mit einem **von uns bezahlten und vorgegebenen Modell**. Damit ist die Modellqualität der
Firmenverarbeitung einheitlich, und niemand zahlt Modellkosten für Daten, die andere mitnutzen.
Alles, was nur dem Kunden gehört (Chat, Radar, Recherche, Alarm-Urteile, ICP-Abgleich, Buying
Center, Workflows), läuft weiter über sein Modell und wird mit niemandem geteilt.

Grundlage: docs/KALKULATION_VERARBEITUNGSKOSTEN.md (Direktkosten, Messwerte), Dashboard
„AVA Verarbeitungskosten“.

## 1. Zwei Spuren für Modellaufrufe

| Spur | Was | Modell | Wer zahlt | Ergebnis landet |
|---|---|---|---|---|
| **Pool** | Stufen Website (Zuordnungs-Judge), Profil, Kontakt (Extraktion, Rollen, Kunden), E-Mail (Zuordnungs-Urteil), Publikationen (Lagebericht-Auswertung), Auffrischung derselben Stufen | Betreiber-Modell, fest vorgegeben (Start: gpt-6.1-sol oder gpt-5.4-mini; luna nur, wo die Qualität es verlangt) | Betreiber, im Zugangspreis enthalten | geteilte Producer-Datenbanken |
| **Privat** | Chat, Vorschläge, Radar (Profil, ICP-Match), Recherche (Stellen, Ausschreibungen, Deep Research), Alarm-Urteile mit Nutzerprofil, ICP-Bestandsabgleich, Buying Center, Workflows, Verflechtungen-Auswertung, Telegram, Sprache | Modell des Kunden (lokal, eigener Schlüssel, ChatGPT-Abo, Organisationsschlüssel) | Kunde | nur beim Kunden |

Grenzfälle, bewusst entschieden:
- **Verflechtungen** (Gesellschafterlisten, LLM-Auswertung): Ergebnis liegt im Pool → Pool-Spur.
- **Konzernabschluss-Auswertung**: Pool-Spur (geteilte Publikationsdaten).
- **Alarm-Judge** mit Nutzerprofil: privat (das Urteil hängt am Profil des Nutzers).
- **Embeddings** (Chat-Gedächtnis, Radar): privat, lokal (embeddinggemma); Pool braucht keine.
- Kunde ohne eigenes Modell: Pool-Stufen laufen trotzdem; private Funktionen melden klar
  „braucht dein Modell“ (so wie heute ohne Schlüssel).

## 2. Preise (netto, je Firma, Aufnahme in den Bestand)

Direktkosten = valueserp + Apify (ab Mittel) + Betreiber-Modell (≈ 0,25 € bei 159 Aufrufen à
0,0029 $ mit gpt-6.1-sol; gemessen Sept./Okt. 2026 mit luna 1,21 $ / 0,44 $).

| Stufe | Kriterium (nach dem Lauf) | Direktkosten | Preis | Marge |
|---|---|---|---|---|
| klein | kein LinkedIn-Profil zugeordnet, ≤ 10 Personen | ≈ 0,30 € | **1,00 €** | 70 % |
| mittel | LinkedIn-Profil, Fenster 100 reicht | ≈ 0,75 € | **2,00 €** | 62 % |
| groß | Fenster voll + Zweitlauf, > 50 Personen | ≈ 0,95 € | **3,50 €** | 73 % |

Zweiter Kunde, dieselbe Firma innerhalb der Frischefrist: zahlt denselben Zugangspreis,
verursacht keine neuen Direktkosten (Frisch-Pfad). Das ist der Deckungsbeitrag des Pools und
die Antwort auf „warum zahle ich für andere“: niemand zahlt für die Arbeit, jeder für den Zugang.

Laufende Pflege (Auffrischung Website 30 Tage, Kontakte 90 Tage, Alarme, Register-/Insolvenz-
Wächter) ist im Seat enthalten; Direktkosten ≈ 0,05–0,25 € je Bestandsfirma und Monat.

| Plan | Preis/Monat | Zugangsguthaben | Pool-Modell | Apify/LinkedIn | Kontingent (Deckel) |
|---|---|---|---|---|---|
| Free | 0 € | 25 Firmen lebenslang | ja, Stufe klein (ohne Apify) | nein | 25 |
| Starter | 49 € | 40 € | ja | ja | 500/Monat |
| Pro | 149 € | 130 € | ja | ja | 2.000/Monat |
| Enterprise | n. V. | n. V. | ja, optional eigenes Modell für den Pool-Anteil | ja | unbegrenzt |

Free kostet uns je Nutzer maximal 25 × 0,30 € = 7,50 € einmalig. Über dem Guthaben:
Pay-as-you-go zum Stufenpreis bis zum Kontingent.

## 3. Umsetzung

| Stufe | Inhalt | Ort |
|---|---|---|
| **Z1 Betreiber-Spur im Gateway** | Provider-Kind `betreiber`: `/v1/llm/betreiber/*` wie der Organisationsschlüssel-Proxy, aber mit Betreiber-Schlüssel (Secret `OPERATOR_LLM_KEY`, Anbieter/Modell per Env), Modell-Pinning (Anfrage-Modell wird durch das vorgegebene ersetzt), Metering in `LlmUsage` mit `companyId` und `stufe` (neue Header `x-ava-company`, `x-ava-stufe`), Plan-Schalter (Free/Starter/Pro ja, Enterprise mit eigenem Pool-Modell nein). | services/db-gateway: routes/v1/llm-proxy.ts, lib/tenant-providers.ts, prisma (LlmUsage.companyId/stufe) |
| **Z2 Producer auf die Betreiber-Spur** | Pool-Producer (website, company-profile, company-contact, company-email, company-publication, Verflechtungen in structured-content) bekommen vom Desktop `LLM_PROVIDER=betreiber` + Gateway-Basis (`@ava/ai-provider` runtime.ts kennt `/v1/llm/<anbieter>`); kein Nutzer-Schlüssel mehr in diesen Prozessen. Manueller Recherche-Lauf (Stellen/Ausschreibungen) bleibt privat. | services/desktop/src/core/bootstrap.ts (extraEnv je Producer), packages/ai-provider |
| **Z3 Stufen-Zuordnung** | Nach Abschluss des Kontakt-Laufs schreibt das Gateway je (Transaktion, Firma) die Stufe klein/mittel/groß aus Fakten (Apify-Profil ja/nein, Fenster voll, Personenzahl) in `UsageEntry` (neue Spalten `stufe`, `preisCents`, `direktkostenCents`); Frisch-Pfad = Stufe des Pool-Datensatzes. | services/db-gateway: lib/persist-bus.ts (Kontakt-Persist), UsageEntry |
| **Z4 Guthaben und Pay-as-you-go** | `TenantBilling.guthabenCents` je Monat (aus dem Plan), Abzug je Aufnahme nach Stufe, darüber Pay-as-you-go-Posten; Monatsabschluss (billing-cron) schreibt Stripe-Positionen; Kontingent bleibt als Deckel. Free: 25 Firmen, nur Stufe klein (Apify aus). | billing-plans.ts, seat-billing.ts, billing-cron.ts |
| **Z5 Sichtbarkeit** | App: Guthabenstand und Preis je Aufnahme vor dem Import („2 Firmen, 1,00–3,50 € je Firma, Guthaben 32,50 €“), Stufe und Preis am Vorgang und in Meine Firmen; Chat-Tool `abrechnung_status` (Self-Service-Regel); Admin-Konsole: Modell der Pool-Spur, Direktkosten je Firma. | Desktop Settings/Abrechnung, agent/tools, ava-admin |
| **Z6 Texte** | Preisseite, AGB/Datenschutz: „Öffentliche Firmendaten werden kundenübergreifend aufbereitet und geteilt; Personendaten kundenübergreifend gepflegt (Art.-14-Hinweis); private Daten (ICP, Notizen, Buying Center, CRM, Alarme) nie.“ | docs/WEBSITE_PROMPT_*.md, Verträge |

Reihenfolge: Z1 → Z2 (ab dann zahlt der Betreiber die Pool-Modellkosten, Messung je Firma
beginnt) → Z3 → Z4/Z5 → Z6. Nach vier Wochen Messung in Z3 die Stufenpreise gegen die echten
Direktkosten prüfen.

## Stand

- Z1 (v0.1.835, Gateway deployt): Betreiber-Spur `/v1/llm/betreiber/*` (Secret `OPERATOR_OPENAI_API_KEY`, Modell `OPERATOR_POOL_MODEL`, Standard gpt-6-luna (gemessen 0,0008 $ je Aufruf, Sol 0,0029 $, 5.6-Luna 0,0068 $), im Gateway fest gesetzt), Metering `LlmUsage.kind = betreiber` mit `quelle` = Producer-Stufe, kein Organisations-Budget; zentraler Apify-Token `OPERATOR_APIFY_TOKEN` fuer `/v1/proxy/apify/*` (Organisations-Token nur noch Rueckfall); Abfrage `GET /v1/betreiber/spuren`.
- Z2 (v0.1.835): `@ava/ai-provider` kennt `AVA_LLM_LANE=betreiber` (+ `AVA_LLM_QUELLE`), die Desktop-App startet website, company-profile, company-contact, company-email, company-publication und structured-content ueber die Betreiber-Spur, sobald das Gateway sie meldet; Nutzerschluessel/ChatGPT-Abo bleiben fuer Chat, Radar, Recherche (Stellen, Ausschreibungen, Deep Research), Alarme, Workflows.
- Apify zentral (v0.1.835): kein Token mehr auf dem Geraet (Einstellungen-Abschnitt, IPC setKey/clearKey, Org-Werkzeug `org_apify_eigener_set` entfernt); Producer und Personen-Radar/Watchlist nur noch ueber `/v1/proxy/apify` mit Nutzer-JWT.
- Z3 (gebaut 2026-10-13, Deploy wartet auf Freigabe der Migration): `UsageEntry` bekommt `stufe`, `preisCents`, `direktkostenCents`, `grund`, `zugeordnetAm`; `lib/stufen.ts` ermittelt die Stufe aus dem Pool-Datensatz (Apify-Beobachtungen, aktuelle Personen: keine Apify = klein, Apify = mittel, >= 100 = gross) und schreibt sie in jede offene UsageEntry-Zeile der Firma (Frisch-Pfad bekommt dieselbe Stufe). Ausloeser: letztes Kontakt-Persist-Ereignis (cleanupTtlMs) bzw. Kontakt-Stufe skipped/failed. Preise/Kosten per Env `STUFE_PREIS_*_CENTS`, `STUFE_KOSTEN_*_CENTS` aenderbar.
- Z3 Nachlauf 2026-10-13: 227 Zugangs-Zeilen fuer 181 Firmen zugeordnet (167 klein, 60 mittel, 0 gross).
- Z4 (v0.1.836): Guthaben je Tier (`guthabenCents`: Starter 40 €, Pro 130 €, Free 0, Env `GUTHABEN_*_CENTS`); `/v1/usage` liefert `zugang` (Stufen, verbraucht, Guthaben, uebrig, Ueberschreitung); Monatsabschluss der Sammelabrechnung schreibt eine Zeile `zugang` mit der Ueberschreitung (Seats × Guthaben); Einzelabos bekommen die Ueberschreitung des Vormonats als Stripe-Rechnungsposten (Cron, idempotent ueber BillingEvent `zugang_ueberschreitung`); Free-Plan ohne Apify (Gateway 402 `apify_nicht_im_free_plan`, Desktop setzt den Apify-Weg im Free-Plan nicht); Anzeige in Einstellungen → Plan & Abrechnung. Das Kontingent (25/500/2.000) bleibt als Deckel.
- Z5 (Chat-Werkzeug fuer Guthaben, Stufe am Vorgang/Meine Firmen, Admin-Konsole) und Z6 (Texte) offen. Noetig vor Wirkung: `fly secrets set OPERATOR_OPENAI_API_KEY=… OPERATOR_APIFY_TOKEN=… -a ava-db-gateway` (Betreiber).

Recherche (Stellenanzeigen, Ausschreibungen/Expansion, Deep Research) bleibt bewusst beim Kundenmodell, auch wenn die Ergebnisse im Pool landen (Joyce, 2026-10-13): die Daten sind nur frisch wertvoll. Offen: Sichtbarkeit der Rechercheergebnisse nur fuer den zahlenden Nutzer und seine Organisation (Tenant-Kennzeichen an JobPosting/DeepResearch, Filter beim Lesen) — bewusst noch nicht umgesetzt.

## 4. Offene Entscheidungen

1. Pool-Modell: gpt-6.1-sol für alles oder luna für Profil/Kontakt-Extraktion (Qualität vs. 2,3× Kosten)?
2. Free-Plan: Pool-Modell inklusive (7,50 € je Nutzer) oder Free nur mit eigenem lokalen Modell?
3. Enterprise mit eigenem Pool-Modell (Datenhoheit) ja/nein; wenn ja, Zugangspreis ohne Modellanteil.
4. Apify-Aktor-Preise im Apify-Console bestätigen (Code-Kommentar vom 31.08.2026).
