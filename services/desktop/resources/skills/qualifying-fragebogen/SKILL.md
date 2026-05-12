---
name: qualifying-fragebogen
description: >
  Füllt einen strukturierten Qualifying-Fragebogen für eine Firma aus
  (BANT- bzw. MEDDIC-Flavor). Aktiviere bei Anfragen wie Qualifizierung,
  Lead-Bewertung, BANT, MEDDIC, „ist die Firma ein Lead", „passt zu uns
  als Kunde".
language: de
b2b-scope: qualifying
allowed-tools:
  - company_get
  - company_profile
  - company_financials
  - company_contacts
  - company_publications
  - company_crm_summary
requires-user-confirm: false
disable-model-invocation: true
user-invocable: true
arguments:
  - name: company-id
    description: AVA-companyId der zu qualifizierenden Firma
    required: true
  - name: kriterien
    description: >
      Kommagetrennte Liste eigener Kriterien (z. B. umsatz,branche,region).
      Wenn leer, wird der Default-Satz benutzt (Größe, Branche, Region,
      Entscheider, Aktivität, Risiken).
    required: false
---

# Qualifying-Fragebogen

Du erstellst eine sachliche, prüfbare Qualifizierung der Firma. Nichts
spekulieren. Jede Aussage muss durch ein Tool-Ergebnis gedeckt sein. Wenn
ein Tool nichts liefert, schreibe das offen.

## Eingaben

- `companyId`: `${company-id}`
- `kriterien`: `${kriterien}` - wenn leer, nutze den Default-Satz unten.

## Ablauf

1. `company_get` und `company_profile` für Basisdaten.
2. `company_financials` für Umsatz, Bilanz, Mitarbeiterzahl (falls vorhanden).
3. `company_contacts` für Entscheider-Erreichbarkeit.
4. `company_publications` für Aktivitäts-Signale der letzten zwölf Monate.
5. `company_crm_summary` für interne Aktivität und Status.

## Fragebogen

Für jeden Abschnitt schreibst du:

- **Frage:** die Leitfrage.
- **Tool:** welches Tool die Antwort gestützt hat.
- **Befund:** ein bis zwei Sätze, konkret und mit Zahlen/Daten wenn
  vorhanden.
- **Konfidenz:** `hoch`, `mittel` oder `niedrig`.

### 1. Größe

- Frage: Wie viele Mitarbeiter, welcher Umsatz (falls verfügbar)?
- Tool: `company_profile`, `company_financials`
- Befund: <…>
- Konfidenz: <…>

### 2. Branche und Geschäftsmodell

- Frage: In welcher Branche tätig, welches Geschäftsmodell (B2B/B2C,
  Hersteller/Händler/Dienstleister)?
- Tool: `company_profile`
- Befund: <…>
- Konfidenz: <…>

### 3. Region und Standort

- Frage: Hauptsitz, weitere Standorte, regionale Reichweite?
- Tool: `company_profile`
- Befund: <…>
- Konfidenz: <…>

### 4. Entscheider-Erreichbarkeit

- Frage: Gibt es eine Geschäftsführung mit Mail oder Telefon im
  Kontakt-Pool?
- Tool: `company_contacts`
- Befund: <Name + Rolle + Erreichbarkeit, ohne Mail/Tel auszuschreiben>
- Konfidenz: <…>

### 5. Aktivitäts-Signale

- Frage: Welche Veröffentlichungen in den letzten zwölf Monaten? Welche
  CRM-Aktivität?
- Tool: `company_publications`, `company_crm_summary`
- Befund: <…>
- Konfidenz: <…>

### 6. Risiken und Red Flags

- Frage: Insolvenzhinweise, sehr alte Daten, fehlende Anschrift, nur eine
  Quelle?
- Tool: `company_profile`, `company_financials`, `company_publications`
- Befund: <…>
- Konfidenz: <…>

## Eigene Kriterien (optional)

Wenn `kriterien` gesetzt war, ergänze für jeden weiteren Eintrag einen
Abschnitt im selben Format. Wenn ein Kriterium nicht aus den erlaubten
Tools gedeckt werden kann, schreibe `nicht prüfbar mit den aktuell
erlaubten Tools` und mache keinen Hilfsweg auf.

## Empfehlung

Schließe mit genau einer Zeile ab:

```
**Empfehlung: weiterverfolgen | beobachten | überspringen** - <ein Satz Begründung>
```

Regel:

- `weiterverfolgen`: mindestens vier Abschnitte mit Konfidenz `hoch` oder
  `mittel`, keine schweren Red Flags.
- `beobachten`: gemischtes Bild oder fehlende Entscheider-Daten.
- `überspringen`: harte Red Flags (Insolvenz, sehr alt, keine
  Erreichbarkeit) oder kaum belastbare Befunde.

## Hinweise

- Beim Erwähnen der Firma im Ausgabetext einmal `[<Firmenname>](company:${company-id})`
  setzen.
- Keine Geviertstriche, keine Emojis, knappe Sätze.
