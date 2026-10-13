# Prompt für den Website-Agenten (ava.bi): Nachtrag Abrechnung „Zugang zum Ergebnis“

Stand 2026-10-13, Desktop v0.1.839, Gateway mit Betreiber-Spur (Z1–Z5 aus
docs/PLAN_ABRECHNUNG_ZUGANG.md). Ergänzt docs/WEBSITE_PROMPT_UPDATE_2026-09-07.md
(Abschnitt 4 „Preise und Abrechnung“ wird durch diesen Text ersetzt). Ton wie gehabt:
sachlich, Du-Form, keine Geviertstriche, keine Superlative, nichts versprechen, was
nicht live ist.

---

## 1. Das neue Preismodell in einem Absatz

AVA berechnet nicht die Arbeit, sondern den **Zugang zum Ergebnis**: Für jede Firma,
die Du in Deinen Bestand aufnimmst, zahlst Du einen festen Preis je Stufe. Das Modell
für die Aufbereitung der Firmendaten (Profil, Website, Kontakte, E-Mail-Adressen) stellt
AVA, Du brauchst dafür keinen eigenen KI-Schlüssel. Alles, was nur Dir gehört (Chat,
Firmen-Radar, Recherche, Alarme, Buying Center, Workflows), läuft weiter über Dein
Modell: lokal, mit eigenem Schlüssel oder mit Deinem ChatGPT-Abo.

## 2. Preistabelle (netto, zzgl. 19 % MwSt.)

| Plan | Preis | Enthalten | Kontakte | Deckel |
|---|---|---|---|---|
| Kostenlos | 0 € | 25 Firmen, lebenslang (kein monatlicher Reset) | von der Website der Firma | 25 Firmen |
| Starter | 49 € je Monat und Nutzer | 40 € Zugangsguthaben je Monat | Website und LinkedIn | 500 Firmen je Monat |
| Pro | 149 € je Monat und Nutzer | 130 € Zugangsguthaben je Monat | Website und LinkedIn | 2.000 Firmen je Monat |
| Enterprise | individuell | nach Vereinbarung, eigene Cloud-Instanz möglich | Website und LinkedIn | kein Deckel |

**Preis je aufgenommener Firma (Stufe steht nach der Aufbereitung fest):**

| Stufe | Preis | Wann |
|---|---|---|
| Klein | 1,00 € | kein LinkedIn-Firmenprofil zuordenbar, Kontakte nur von der Website |
| Mittel | 2,00 € | LinkedIn-Firmenprofil zugeordnet, bis 100 Personen |
| Groß | 3,50 € | LinkedIn-Firmenprofil, über 100 Personen |

Das Guthaben wird monatlich mit den Stufenpreisen verrechnet. Was darüber hinausgeht,
kommt zum Stufenpreis auf die nächste Rechnung (Pay-as-you-go). Der Deckel bleibt als
Sicherheitsgrenze, kein Leistungsversprechen. Im Kostenlos-Plan gibt es kein Guthaben:
25 Firmen, einmal, für immer. Aufgefrischte Daten (Website alle 30 Tage, Kontakte alle
90 Tage, Alarme, Register- und Insolvenzwächter) sind im Plan enthalten.

## 3. Sätze, die die Seite so sagen darf

- „Du zahlst für das Ergebnis, nicht für die Arbeit. Ob AVA eine Firma gerade neu
  aufbereitet oder den aktuellen Datensatz schon kennt, kostet dasselbe.“
- „Öffentliche Firmendaten (Register, Website, Jahresabschlüsse, Ansprechpartner)
  bereitet AVA einmal auf und hält sie für alle Kunden aktuell. Deshalb sind die
  Daten frischer und der Preis niedriger, als wenn jeder allein rechnen müsste.“
- „Deine eigenen Daten bleiben bei Dir: Idealkundenprofil, Notizen, Buying Center,
  CRM-Verknüpfungen, Alarmeinstellungen, Bewertungen und Dein Bestand werden mit
  niemandem geteilt.“
- „Für die Aufbereitung der Firmen brauchst Du keinen KI-Schlüssel. Chat, Radar und
  Recherche laufen über Dein Modell, weil die Ergebnisse nur Dir gehören.“
- „Stellenanzeigen, Ausschreibungen und Deep Research laufen immer über Dein Modell;
  die Ergebnisse sind nur frisch etwas wert.“

## 4. Nicht behaupten

- Keine Preise je Verarbeitung, keine „KI-Kosten“ für den Kunden bei der Aufbereitung.
- Keine Angabe eines Modellnamens für die Aufbereitung (das Modell gibt AVA vor und
  kann es wechseln).
- Keine Rückerstattung oder Gutschrift, wenn andere Kunden dieselbe Firma nutzen.
- Nicht „unbegrenzt“ für Starter oder Pro; der Deckel gilt.
- Keine automatische Rechnungsstellung für Sammelabrechnungen versprechen, solange
  sie als „in Einführung“ gekennzeichnet ist.
- Nicht „LinkedIn-Kontakte im Kostenlos-Plan“.

## 5. FAQ-Bausteine

**Warum zahle ich für eine Firma, die andere Kunden auch nutzen?** Du zahlst für den
Zugang zum aktuellen Ergebnis in Deinem Bestand, nicht für die Rechenarbeit. Jeder Kunde
zahlt dasselbe, niemand finanziert den anderen, und alle profitieren von einem Datensatz,
der ständig gepflegt wird.

**Was ist eine Stufe?** Nach der Aufbereitung steht fest, wie aufwendig die Firma war:
ob ein LinkedIn-Firmenprofil zugeordnet werden konnte und wie viele Ansprechpartner es
gibt. Daraus ergibt sich Klein, Mittel oder Groß. Vorher siehst Du die Spanne 1,00 bis
3,50 €, danach den genauen Preis in Deinem Bestand und am Vorgang.

**Was passiert, wenn mein Guthaben aufgebraucht ist?** AVA arbeitet weiter bis zum
Deckel Deines Plans. Aufnahmen über das Guthaben hinaus kommen zum Stufenpreis auf die
nächste Rechnung. In den Einstellungen und im Chat („Wie steht mein Guthaben?“) siehst Du
jederzeit den Stand.

**Was kostet die Auffrischung?** Nichts extra. Website, Kontakte, Register- und
Insolvenzwächter laufen für Firmen in Deinem Bestand im Plan mit.

## 6. Bausteine für AGB und Datenschutzerklärung (zur Prüfung durch die Rechtsberatung)

**AGB, Leistungsbeschreibung:** „Der Anbieter stellt dem Kunden Zugang zu aufbereiteten
Firmendaten bereit. Die Vergütung richtet sich nach der Anzahl der in den Bestand des
Kunden aufgenommenen Firmen und ihrer Stufe (Klein, Mittel, Groß) gemäß Preisliste.
Enthaltene Guthaben verfallen zum Ende des Abrechnungsmonats. Aufnahmen über das
Guthaben hinaus werden zum jeweils gültigen Stufenpreis mit der nächsten Rechnung
abgerechnet. Die Stufe wird nach Abschluss der Aufbereitung anhand objektiver Merkmale
festgelegt und dem Kunden in der Anwendung angezeigt.“

**AGB, Datenpool:** „Öffentlich zugängliche Firmendaten werden vom Anbieter einmalig
aufbereitet, fortlaufend aktualisiert und allen Kunden gleichermaßen bereitgestellt. Ein
Anspruch auf exklusive Nutzung einzelner Firmendatensätze besteht nicht. Vom Kunden
selbst erzeugte Inhalte (Idealkundenprofil, Notizen, Bewertungen, Verknüpfungen, eigene
Bestandslisten) werden nicht an andere Kunden weitergegeben.“

**AGB, KI-Modelle:** „Für die Aufbereitung der Firmendaten setzt der Anbieter eigene
KI-Modelle ein, deren Auswahl ihm obliegt. Für kundenindividuelle Funktionen (Chat,
Recherche, Radar, Alarme, Workflows) nutzt die Anwendung die vom Kunden hinterlegten
Modellzugänge; die dabei entstehenden Kosten beim jeweiligen Anbieter trägt der Kunde.“

**Datenschutzerklärung, Personendaten:** „Zur Bereitstellung von Ansprechpartnern
verarbeitet der Anbieter berufliche Kontaktdaten (Name, Funktion, geschäftliche
E-Mail-Adresse, beruflicher Profil-Link) aus öffentlich zugänglichen Quellen, darunter
Unternehmenswebsites und berufliche Netzwerke. Diese Daten werden kundenübergreifend
gepflegt und auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO verarbeitet. Betroffene
Personen werden gemäß Art. 14 DSGVO informiert; der Hinweistext ist in der Anwendung je
Person abrufbar. Betroffene können der Verarbeitung jederzeit widersprechen.“

**Datenschutzerklärung, Auftragsverarbeiter:** Für die Aufbereitung nutzt der Anbieter
Dienstleister für Suchergebnisse (Traject Data, valueserp), für berufliche
Netzwerkdaten (Apify) und für KI-Modelle (OpenAI); jeweils mit Auftragsverarbeitungs-
vertrag und, soweit Drittland, auf Basis der EU-Standardvertragsklauseln. Die Liste ist
mit der Rechtsberatung gegen die tatsächlichen Verträge zu prüfen.
