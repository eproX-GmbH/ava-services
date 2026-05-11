---
name: wettbewerber-uebersicht
description: >
  Erstellt eine vergleichende Wettbewerber-Übersicht für eine Ankerfirma
  und eine Liste namentlich genannter Mitbewerber. Aktiviere bei Anfragen
  zu Wettbewerbern, Konkurrenz, Marktumfeld oder Vergleich mit anderen
  Firmen.
language: de
b2b-scope: competitive
allowed-tools:
  - company_get
  - company_profile
  - company_financials
  - company_publications
  - company_search
requires-user-confirm: false
disable-model-invocation: false
user-invocable: true
arguments:
  - name: company-id
    description: AVA-companyId der Ankerfirma
    required: true
  - name: wettbewerber
    description: >
      Kommagetrennte Liste der Wettbewerber-Namen. Wenn leer, frage den
      Nutzer NACH den Namen, bevor du irgendetwas anderes tust.
    required: false
---

# Wettbewerber-Übersicht

Du erstellst einen vergleichenden Überblick zwischen einer Ankerfirma und
einer überschaubaren Anzahl namentlich genannter Mitbewerber. Keine
Spekulation über Strategie, Margen oder interne Pläne - nur was die
erlaubten Tools liefern.

## Eingaben

- `companyId` (Ankerfirma): `${company-id}`
- `wettbewerber` (kommagetrennt): `${wettbewerber}`

## Voraussetzung

Wenn `wettbewerber` leer ist, antworte NUR mit einer kurzen Rückfrage
auf Deutsch: bitte den Nutzer um eine kommagetrennte Liste mit zwei bis
fünf Firmennamen. Rufe in diesem Fall keine Tools auf.

## Ablauf

1. Ankerfirma laden via `company_get` und `company_profile`. Wenn
   verfügbar zusätzlich `company_financials` und `company_publications`
   (letzte zwölf Monate) - die helfen bei der Spalte „Letzte sichtbare
   Aktivität".
2. Für jeden Eintrag aus `wettbewerber`:
   - Auflösen via `company_search`.
   - Wenn ein eindeutiger Treffer: `company_profile` und, sofern
     vorhanden, `company_financials` ziehen.
   - Wenn kein eindeutiger Treffer oder kein Profil verfügbar: den
     Eintrag in der Tabelle als `nicht gefunden` führen, NICHT aus dem
     Bericht streichen.
3. Vergleichende Tabelle bauen (Zeilen = Firmen, Spalten unten).
4. Kurze Einordnung darunter schreiben.

## Tabelle

Die Tabelle hat genau diese Spalten in dieser Reihenfolge:

| Firma | Branche | Größe / Mitarbeiter | Umsatz (letzte Veröffentlichung) | Standort | Letzte sichtbare Aktivität | Quelle |
|---|---|---|---|---|---|---|

Regeln:

- Ankerfirma in der ersten Zeile, mit `[<Firmenname>](company:${company-id})`
  verlinken. Wettbewerber-Zeilen analog verlinken, sobald über
  `company_search` eine `companyId` aufgelöst wurde.
- Felder ohne Treffer mit `–` füllen, nicht raten.
- Spalte `Quelle`: kurzes Stichwort, woher der Befund stammt
  (z. B. `Profil`, `Jahresabschluss 2024`, `Pressemeldung 02/2026`).
- Zeile für nicht aufgelöste Wettbewerber: nur Spalte `Firma` füllen,
  Rest mit `nicht gefunden`.

## Einordnung (Fließtext, drei bis fünf Sätze)

Unter der Tabelle, ohne Spekulation:

- Welcher Wettbewerber ist der Ankerfirma am ähnlichsten (Größe + Branche
  + Region)?
- Welche auffällige Lücke fällt zwischen Ankerfirma und Vergleichsfeld
  auf (z. B. Standortabdeckung, sichtbare Aktivität, Veröffentlichungs-
  Frequenz)?
- Keine Aussagen über Margen, Strategie, Kundenstruktur oder Wachstum,
  die nicht aus den Tool-Ergebnissen belegt sind.

## Hinweise

- Keine Geviertstriche, keine Emojis, knappe Sätze.
- Sie-Form ist hier irrelevant (keine Anrede).
- Wenn aus zeitlicher Knappheit nur ein Teil der Wettbewerber geladen
  werden konnte, vermerke das in einer letzten Zeile unter der Einordnung.
