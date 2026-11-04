# Plan: Bestandssuche — Belege über alle eigenen Firmen finden

Stand 2026-11-04. Anlass: Patrick fragte AVA „zeig mir alle meine Firmen, die
betriebliche Altersvorsorge anbieten“. AVA hatte die Belege (Fokus-Thema,
Stellenanzeigen je Firma), aber kein Werkzeug über den ganzen Bestand, und
antwortete „kann ich nicht“. Patricks Einordnung: Retrieval mit harten
Datenbankfiltern plus semantischer Suche, sauber nach Quellen getrennt.

## 1. Befund

- Fokus-Themen sind bereits eine harte Abfrage (`CompanyThema`, Filter
  `thema=` am Matrix-Endpunkt), aber nur für die Firmenliste, nicht im Chat.
- Für Jahresabschlüsse existiert ein hybrider Weg je Firma: `PublicationBlock`
  zentral mit tsvector (BM25) und gespeicherten Embeddings, Nachsortierung lokal
  (embeddinggemma). Nicht bestandsweit.
- Kein Index für Firmenprofil, Stellen, Karriereleistungen, Referenzen,
  Themenbefunde; die Texte liegen in drei Producer-Datenbanken (website,
  company-profile, company-publication) und im Gateway (`CompanyKunde`).

## 2. Entscheidungen (Joyce, 2026-11-04)

1. Standard 5 Firmen im Ergebnis; der Nutzer kann mehr verlangen, AVA setzt
   `limit` bis 100.
2. Nur Firmen, deren Belege das Suchkriterium wenigstens im Ansatz enthalten:
   harter Volltext-Treffer (tsquery) ist Pflicht, Semantik sortiert nur nach.
3. Harte Filter zuerst (Bestand des Nutzers ohne ruhende Firmen, Quellen),
   dann BM25, später Vektoren als zweite Stufe.
4. EINE zentrale Tabelle mit Spalte `quelle` statt einer Tabelle je Thema
   (S2). Trennung der Quellen über den Filter, kein Vermischen von Abschluss
   und Profil in einem Block; Fragen über Quellen hinweg bleiben möglich.
5. Embeddings bleiben lokal (Compute-Invariante): Producer rechnen sie beim
   Persistieren wie bei `PublicationBlock`. Der Altbestand wird nur per
   Volltext übernommen; Vektoren füllen sich mit jeder Auffrischung nach.

## 3. Stufen

| Stufe | Inhalt | Stand |
|---|---|---|
| S1 | Gateway `POST /v1/companies/bestand/suche` (Bestand aus master-data minus ruhend, Volltext je Quelle: stelle, karriere, thema, kunde, profil, abschluss; `websearch_to_tsquery('german')` je Begriff ODER-verknüpft, `ts_headline` als Auszug, Rang je Firma = bester Treffer plus 10 % je weiterer Quelle, bis 3 Belege je Firma). Chat-Werkzeug `bestand_suchen` (begriffe mit Synonymen, quellen, limit 1–100, Standard 5, `gesamtTreffer`). | gebaut 2026-11-04, Gateway-Deploy offen, Desktop v0.1.923 |
| S2 | Zentrale Tabelle `SuchBlock` im Gateway (Migration 20261104_suchblock: companyId, quelle, ref, titel, text, quelleUrl, datum, tsv GENERATED german, embedding REAL[], UNIQUE(quelle, companyId, ref), GIN auf tsv). `lib/suchblock.ts`: Belegbau je Quelle (eine Stelle für Persist UND Backfill), `suchbloeckeErsetzen` (Lauf ersetzt den Stand der Firma je Quelle), `suchbloeckeSuchen`, Backfill. Persist-Haken nach COMMIT in `applyWebsiteResearch` (stelle, thema, karriere), `applyCompanyProfile` (profil, nur wenn der Stand neuer war) und `schreibeKunden` (kunde, alle Referenzen der Firma), best-effort. Route liest die fünf Quellen aus `SuchBlock`, Abschlüsse weiter aus `PublicationBlock`. Betreiber: `GET /v1/betreiber/suchblock/stand`, `POST /v1/betreiber/suchblock/backfill` (im Hintergrund, Altbestand 2026-11-04: 507 Stellen, 28 Karriereseiten, 9 Themen, 909 Profile, 1.749 Referenzen). | live 2026-11-04 (Gateway v360); Backfill 07:40 UTC in 27 s: 488 Stellen, 15 Karriereseiten, 4 Themen, 1.706 Referenzen, 909 Profile (Karriere/Themen ohne Text oder ohne Fund entfallen) |
| S3 | Vektoren ohne Producer-Umbau: der Desktop holt in ruhigen Takten (alle 10 Min, 40 Blöcke) Belege der eigenen Firmen ohne Vektor (`GET /v1/suchblock/offen`), bettet sie lokal mit embeddinggemma ein und schreibt sie zurück (`PUT /v1/suchblock/embeddings`, nur Firmen des Bestands; Spalte `embeddingModell`, Migration 20261104_suchblock_embedding). So bekommt auch der Altbestand Vektoren, „einer rechnet, alle profitieren“; im Worker-Modus angehalten. Suche: Werkzeug bettet die `frage` (sonst die Begriffe) lokal ein und schickt `frageEmbedding`; das Gateway verschmilzt BM25-Rang und Kosinus-Rang per RRF (k=60), Blöcke ohne Vektor behalten den BM25-Anteil, Volltext-Treffer bleibt Pflicht. Antwort nennt `semantik` (Kandidaten, davon mit Vektor). Abschlussblöcke bringen ihre vorhandenen Vektoren mit. | gebaut 2026-11-04 (Desktop v0.1.924, Gateway-Deploy offen) |
| S4 | Messung an zehn Fragen (§5), Nachschärfen der Begriffs- und Quellenwahl im Werkzeug-Prompt. | 2026-11-04, Desktop v0.1.925 |
| S5 | Werkzeugwahl und Antwortformat (Befund Joyce 2026-11-04: AVA fragte zweimal nach, lud das Werkzeug nie und antwortete aus Allgemeinwissen, rund 300k Tokens). `bestand_suchen` ist jetzt dauerhaft verfügbar (always-on, kein `tool_load`), hat eine Kurzbeschreibung für die Werkzeugsuche, der System-Prompt bekommt den Abschnitt „Bestandsfragen“ (keine Rückfrage, ein Aufruf, Tabelle `Firma | Beleg | Quelle` mit `company:`-Link und Quell-URL, Satz zu Treffern/Bestand und zu weiteren Treffern), die Seele zählt Bestandsfragen zu den Datenfragen, die Fähigkeitsliste kennt die Gruppe `bestandssuche`. | Desktop v0.1.926; v0.1.927: Werkzeug war bis dahin gar nicht registriert (lag in der Bereichsliste von `company_get`), seitdem Startwarnung bei fehlenden Kern-Werkzeugen |

## 4. Mengengerüst

Bestand je Nutzer bis 5.000 Firmen (Deckel wie Matrix), je Quelle bis 400
Treffer. Volltext ohne Index über `to_tsvector('german', text)` je Abfrage:
bei Stellen und Profilen einige tausend Zeilen je Nutzer, deutlich unter
einer Sekunde. Sobald S2 steht, trägt `SuchBlock` einen GIN-Index.

## 5. Messung 2026-11-04 (S4)

Korpus: `SuchBlock` nach dem Backfill (3.122 Belege, 909 Firmen), Vektoren für die
Messung lokal auf dem Mac gerechnet (embeddinggemma), Fusion wie im Gateway
(RRF k=60). Begriffe je Frage so gewählt, wie AVA sie bilden soll. Beurteilt wurden
die fünf bestplatzierten Firmen je Frage nach dem gezeigten Beleg.

| Frage | Begriffe | Belege / Firmen | BM25 Top 5 | Fusion Top 5 | Befund |
|---|---|---|---|---|---|
| bAV für Mitarbeitende | betriebliche Altersvorsorge, bAV, Altersvorsorge, Pensionskasse, Direktversicherung | 26 / 13 | 5/5 richtig, alle Ränge gleich (0,200) | 5/5, Fokus-Themen und Karriereseiten mit wörtlichem „betriebliche Altersvorsorge“ oben | Volltext liefert bei kurzen Blöcken gleiche Ränge; die Semantik sortiert sinnvoll |
| SAP im Einsatz | SAP, SAP S/4HANA, SAP ERP | 10 / 6 | 3/5 (zwei Referenzen „SAP als Partner“) | 3/5 | Frage „setzt ein“ braucht Quellen stelle + profil; Referenz-Treffer sind korrekt belegt, aber eine andere Aussage |
| Vertriebsmitarbeiter gesucht | Vertriebsmitarbeiter, Sales Manager, Vertrieb, Account Manager, Gebietsverkaufsleitung | 43 / 33 | 2/5 (Firmennamen „… Vertriebs GmbH“ aus Referenzen) | 5/5 (nur Stellen) | Semantik hebt Stellen an; mit quellen=stelle ohne Umweg |
| ISO 27001 | ISO 27001, Informationssicherheit, ISMS, TISAX | 21 / 14 | 5/5 (Zertifikate, TISAX als Verwandtes) | 5/5 | gut |
| Photovoltaik/Nachhaltigkeit | Photovoltaik, Nachhaltigkeit, erneuerbare Energien, CO2, Klimaneutral | 68 / 68 | 4/5 | 5/5 | „CO2“ zu allgemein, Semantik gleicht aus |
| Homeoffice | Homeoffice, Home-Office, mobiles Arbeiten, Remote | 28 / 14 | 3/5 („Remote-Support“, „Remote, Deutschland“) | 5/5 | „Remote“ als Einzelwort trifft Fremdes |
| Automobilindustrie beliefern | Automobilindustrie, Automotive, Automobilzulieferer, OEM | 102 / 84 | 5/5 (Referenzen „X Automotive“ sind hier die richtige Quelle) | 5/5 | gut |
| Ausbildung | Ausbildung, Auszubildende, Azubi, Duales Studium | 194 / 65 | 5/5 | 5/5 | gut |
| Robotik/Automatisierung | Robotik, Automatisierung, Roboter, Automation | 167 / 119 | 5/5 | 5/5 | gut |
| Jobrad | Jobrad, Dienstrad, Fahrradleasing, E-Bike | 10 / 6 | 4/5 (Felgenhersteller über „E-Bike“) | 4/5 | „E-Bike“ zu allgemein |

Ergebnis: 41 von 50 BM25-Plätzen richtig, 47 von 50 nach Fusion; die Semantik
verbessert fünf Fragen und verschlechtert keine. Die drei verbleibenden Fehler
kommen aus zu allgemeinen Einzelbegriffen (Remote, E-Bike, OEM) und aus
Referenz-Treffern bei „setzt ein“-Fragen. Nachgeschärft im Werkzeug-Prompt
(v0.1.925): keine Allerweltswörter als Einzelbegriff, Quellen nach Frageart
(bietet → karriere/thema/stelle; sucht → stelle; nutzt → stelle/profil; beliefert →
kunde/profil; zertifiziert → kunde/profil/thema; Zahlen → abschluss), Belege
immer einordnen. Offen: `ts_rank_cd` liefert bei kurzen Blöcken gleiche Ränge
(0,2); mit Vektoren im Bestand löst die Fusion das, ohne Vektoren bleibt die
Reihenfolge innerhalb gleicher Ränge zufällig. Laufzeit je Frage unter 200 ms
für den Volltext.
