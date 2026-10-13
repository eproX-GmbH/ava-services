# Prompt für den Website-Agenten (ava.bi): Nachtrag Abrechnung „Zugang zum Ergebnis“

Stand 2026-10-13, Desktop v0.1.840, Gateway mit Betreiber-Spur (Z1–Z8 aus
docs/PLAN_ABRECHNUNG_ZUGANG.md: ein Plan Pro, Ausgabenlimit, Aufnahme beim Firmenprofil). Ergänzt docs/WEBSITE_PROMPT_UPDATE_2026-09-07.md
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

| Plan | Preis | Aufnahmen | Kontakte | Grenze |
|---|---|---|---|---|
| Kostenlos | 0 € | 25 Firmen, lebenslang (kein monatlicher Reset) | von der Website der Firma | 25 Firmen |
| Pro | 49 € je Monat und Nutzer | 1,00 bis 3,50 € je im Monat verarbeiteter Firma, nach Stufe | Website und LinkedIn | eigenes Ausgabenlimit je Monat, frei wählbar |
| Enterprise | individuell | nach Vereinbarung, eigene Cloud-Instanz möglich | Website und LinkedIn | nach Vereinbarung |

**Preis je verarbeiteter Firma und Monat (Stufe steht nach der Aufbereitung fest):**

| Stufe | Preis | Wann |
|---|---|---|
| Klein | 1,00 € | kein LinkedIn-Firmenprofil zuordenbar, Kontakte nur von der Website |
| Mittel | 2,00 € | LinkedIn-Firmenprofil zugeordnet, bis 100 Personen |
| Groß | 3,50 € | LinkedIn-Firmenprofil, über 100 Personen |

Pro ist der einzige bezahlte Plan: 49 € je Nutzer und Monat, dazu jede Firma, die AVA im
Abrechnungsmonat für Dich verarbeitet hat, zum Stufenpreis, abgerechnet mit der
Monatsrechnung (Pay-as-you-go). Es gibt kein
enthaltenes Guthaben und keinen festen Firmen-Deckel; stattdessen setzt sich jeder Kunde
in den Einstellungen (oder im Chat) ein Ausgabenlimit je Monat. Ist es erreicht, warten
neue Firmen bis zum nächsten Monat oder bis das Limit erhöht wird. Im Kostenlos-Plan gibt
es 25 Firmen, einmal, für immer. Alarme, Register- und Insolvenzwächter sind im Plan
enthalten.

**Wann eine Firma zählt:** Eine Firma zählt in dem Monat, in dem AVA sie für Dich
wirklich verarbeitet hat, also ihr Firmenprofil von der erreichbaren Website neu
erstellt hat. Das gilt für die erste Aufbereitung und für jede Auffrischung (Website
alle 30 Tage). Innerhalb eines Monats zählt eine Firma höchstens einmal. Nicht gezählt
wird, was AVA überspringt, weil der Datensatz schon aktuell ist. Firmen ohne erreichbare
Website kosten nichts, auch wenn Registerdaten oder Jahresabschlüsse vorliegen. Fehlende
Jahresabschlüsse, Publikationen oder Kontakte ändern am Preis nichts, sie gehören zum
Ergebnis, soweit es sie gibt.

## 2a. Preiskarte Pro und Stufen-Erklärung (Nachtrag nach Sichtung der Seite, 2026-10-13)

Die Spanne „1,00 € bis 3,50 € je aufgenommener Firma“ allein lässt zwei Fragen offen:
welche Stufen es gibt und wie oft der Betrag anfällt. Deshalb:

**Auf der Pro-Karte** statt des ersten Stichpunkts: „Dazu je im Monat verarbeiteter
Firma 1,00 € (klein), 2,00 € (mittel) oder 3,50 € (groß), siehe Stufen“ mit Sprung zur
Erklärung unter den Karten. Den Stichpunkt „Auffrischung, Alarme und Wächter inklusive“
ersetzen durch „Zählt nur, was AVA im Monat wirklich verarbeitet; Alarme und Wächter
inklusive“. Unter dem Preis „49 €“ bleibt „je Nutzer und Monat, netto“.

**Unter den Karten** ein Block „Was eine Firma kostet“ mit diesem Satz und der Tabelle:

„Die Stufe hängt davon ab, wie aufwendig die Suche nach Ansprechpartnern war. Sie steht
nach der Aufbereitung fest und wird dir in deinem Bestand und am Vorgang angezeigt;
vorher siehst du die Spanne. Der Betrag fällt in jedem Monat an, in dem AVA die Firma
für dich neu verarbeitet: bei der ersten Aufbereitung und bei jeder Auffrischung,
höchstens einmal je Monat. Was AVA überspringt, weil der Datensatz aktuell ist, kostet
nichts. Alles steht auf der nächsten Monatsrechnung.“

| Stufe | Preis je verarbeitetem Monat | Woran AVA das festmacht |
|---|---|---|
| Klein | 1,00 € | Kein LinkedIn-Firmenprofil zuordenbar; Ansprechpartner nur von der Website. |
| Mittel | 2,00 € | LinkedIn-Firmenprofil zugeordnet, bis 100 Personen dort gelistet. |
| Groß | 3,50 € | LinkedIn-Firmenprofil mit über 100 Personen, zweiter Durchlauf nötig. |

Rechenbeispiel, das die Seite nennen darf: „Ein Nutzer lässt im Monat 40 Firmen
verarbeiten, 30 klein und 10 mittel: 49 € plus 30 × 1,00 € plus 10 × 2,00 € = 99 € netto.
Im Folgemonat frischt AVA 20 davon auf (15 klein, 5 mittel): 49 € plus 25 € = 74 €.“

## 3. Sätze, die die Seite so sagen darf

- „49 € je Nutzer und Monat, dazu 1,00 bis 3,50 € je aufgenommener Firma. Du bestimmst
  mit Deinem Ausgabenlimit, wie viel es im Monat maximal wird.“
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
- Nicht „unbegrenzt“ für Pro: es gibt eine hohe technische Notbremse je Monat, die nicht
  beworben wird.
- Kein „Starter“-Plan, kein „Zugangsguthaben“, keine Firmenzahl „inklusive“ bei Pro.
- Keine Aussage, dass Jahresabschlüsse oder Kontakte für jede Firma vorliegen; der
  Preis hängt nur an Website und Firmenprofil, nicht am Umfang der Registerdaten.
- Nicht „einmalig“ und nicht „Auffrischung inklusive“ beim Preis je Firma; die
  Auffrischung ist eine Verarbeitung und zählt im jeweiligen Monat. Die Spanne „1,00 bis
  3,50 €“ nie ohne „je im Monat verarbeiteter Firma“ und ohne Hinweis auf die Stufen.
- „Du zahlst für das Ergebnis, nicht für die Arbeit“ ist kein Werbesatz; er gehört nur in
  FAQ und AGB (siehe unten).
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

**Warum zahle ich für die Arbeit nicht?** Du zahlst für das Ergebnis, nicht für die
Arbeit. Ob AVA eine Firma gerade neu aufbereitet oder den aktuellen Datensatz schon kennt,
kostet dasselbe.

**Wie behalte ich die Kosten im Griff?** Mit dem Ausgabenlimit je Monat in den
Einstellungen (oder im Chat: „Setz mein Ausgabenlimit auf 100 €“). Ist es erreicht, warten
neue Firmen bis zum nächsten Monat oder bis Du es erhöhst. Im Chat („Wie stehen meine
Kosten?“) und in den Einstellungen siehst Du jederzeit, was in diesem Monat angefallen ist.

**Wann zahle ich für eine Firma?** In jedem Monat, in dem AVA ihr Firmenprofil von der
Website neu erstellt: bei der ersten Aufbereitung und bei jeder Auffrischung, höchstens
einmal je Monat. Hat eine Firma keine erreichbare Website, kostet sie nichts. Was AVA
überspringt, weil der Datensatz schon aktuell ist, kostet ebenfalls nichts; mehrere
Listen mit derselben Firma zählen nicht doppelt.

**Was, wenn es keine Jahresabschlüsse gibt?** Gerade bei kleinen Firmen ist das üblich.
Der Preis bleibt derselbe, Du bekommst Profil, Website-Inhalte, Register- und
Kontaktdaten, soweit vorhanden.

**Was kostet die Auffrischung?** Die Auffrischung der Website und des Profils (alle 30
Tage) ist eine Verarbeitung und zählt in dem Monat zum Stufenpreis. Alarme, Register- und
Insolvenzwächter laufen für Firmen in Deinem Bestand im Plan mit.

## 6. Bausteine für AGB und Datenschutzerklärung (zur Prüfung durch die Rechtsberatung)

**AGB, Leistungsbeschreibung:** „Der Anbieter stellt dem Kunden Zugang zu aufbereiteten
Firmendaten bereit. Die Vergütung richtet sich nach der Anzahl der in den Bestand des
Kunden aufgenommenen Firmen und ihrer Stufe (Klein, Mittel, Groß) gemäß Preisliste.
Die Grundgebühr wird je Nutzer und Monat berechnet; Aufnahmen werden zum jeweils gültigen
Stufenpreis mit der Rechnung des Folgemonats abgerechnet. Der Kunde kann ein monatliches
Ausgabenlimit festlegen; bei Erreichen werden keine weiteren Firmen verarbeitet. Eine
Firma gilt in einem Abrechnungsmonat als verarbeitet, wenn der Anbieter ihr Firmenprofil
aus der öffentlich erreichbaren Website in diesem Monat erstellt oder aktualisiert hat;
je Kundenkonto und Monat wird sie höchstens einmal berechnet. Firmen ohne erreichbare
Website werden nicht berechnet. Umfang und Verfügbarkeit weiterer
öffentlicher Daten (Registerauszüge, Jahresabschlüsse, Ansprechpartner) sind nicht
Gegenstand der Vergütung. Der Kunde zahlt für den Zugang zum Ergebnis, nicht für die
Rechenarbeit. Die Stufe wird nach Abschluss der Aufbereitung anhand objektiver Merkmale
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
