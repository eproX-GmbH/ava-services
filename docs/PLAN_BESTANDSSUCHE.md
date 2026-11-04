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
| S4 | Messung an zehn Fragen aus dem Vertriebsalltag (bAV, SAP, Vertriebsstellen, ISO 27001, Photovoltaik), Nachschärfen der Begriffsbildung im Werkzeug-Prompt. | offen |

## 4. Mengengerüst

Bestand je Nutzer bis 5.000 Firmen (Deckel wie Matrix), je Quelle bis 400
Treffer. Volltext ohne Index über `to_tsvector('german', text)` je Abfrage:
bei Stellen und Profilen einige tausend Zeilen je Nutzer, deutlich unter
einer Sekunde. Sobald S2 steht, trägt `SuchBlock` einen GIN-Index.
