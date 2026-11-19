# Plan: Erstansprache, die von selbst alles nutzt, was AVA weiß

Stand 2026-11-19 · Anlass: Sprachnachricht von Patrick (19.11., 14:08) mit seiner Mail an
Herrn Schwer (IEF-Werner, Vertriebsorganisation). Bis die Mail brauchbar war, brauchte es acht bis
zehn Runden („nimm alle Daten“, „verknüpfe alles“, „auch Finanzen und Mitarbeiterzahl“). Wunsch:
AVA zieht von Anfang an alles in Betracht und schreibt wie der beste Vertriebler, nicht generisch
wie ein allgemeiner Chatbot.

## 0. Ergebnis in drei Sätzen

Die Daten für eine gute Erstansprache hat AVA, aber verteilt über ein Dutzend Bereiche und
Werkzeuge. Nichts sagt dem Modell, dass es sie *vor* dem Schreiben einsammeln soll, und nichts
prüft, ob die fertige Mail sie nutzt. Der Plan bündelt die Vorbereitung in einem Aufruf
(`ansprache_vorbereiten`), gibt dem Schreiben eine feste Regel samt Aufbau und prüft die Mail vor
der Ausgabe gegen die gesammelten Fakten; Korrekturen des Nutzers werden zu seinem Stil.

## 1. Befund

### 1.1 Was heute passiert

- Der Systemprompt regelt für Mails nur die **Form**: Block ```` ```mail-entwurf ````, Adresse und
  ihr Prüfstatus, Du/Sie, fehlende Angaben gebündelt erfragen. Zum **Inhalt** einer Ansprache steht
  dort nichts.
- Das Modell schreibt deshalb mit dem, was gerade im Gespräch liegt, meist dem Firmenprofil. Jede
  weitere Quelle holt es erst, wenn der Nutzer sie verlangt. Das sind Patricks acht bis zehn Runden.
- Die Endfassung zeigt, was möglich ist: Produktbereiche (Palettierer, Mikromontage,
  Transportsysteme, Radmesstechnik), Gebietsverantwortliche für Deutschland, Österreich und die Schweiz, eine These zur
  Vertriebsproduktivität. Sie ist aber mit rund 350 Wörtern für eine Erstansprache lang, und
  aktuelle Anlässe (etwa die neue Vertriebsleitung Systeme seit 11/2026, siehe Firmenhistorie)
  fehlen.

### 1.2 Was AVA zu einer Firma und Person schon hat

| Quelle | Werkzeug / Route heute | Für die Ansprache |
|---|---|---|
| Profil, Branche, Produktbereiche, Website-Fakten | `company_get` profil, website | Worum es bei der Firma geht |
| Registerinhalt, Gegenstand, Geschäftsführung | `company_get` register | Wer entscheidet |
| Jahresabschlüsse: Umsatz, Mitarbeiter, Entwicklung | `company_get` publikationen | Größe, Wachstum, Druck |
| Kontakte mit Rolle, Zuständigkeit, Adresse | `company_contacts`, `kontakt_suchen` | Richtiger Empfänger |
| Personalwechsel, Fluktuation | `firmen_ereignisse`, Bereich fluktuation | Frischer Anlass |
| Stellenanzeigen, Expansion, Ausschreibungen | `company_get` stellen, expansion | Bedarf, Wachstum |
| Kunden/Referenzen, gemeinsame Kunden | `company_get` kunden | Brücke zu eigenen Referenzen |
| Fokus-Themen-Befunde (privat) | `company_get` fokus | Treffer zum eigenen Angebot |
| Meldungen, Neuigkeiten | `alerts_list`, `/alerts/neuheiten` | Aktueller Aufhänger |
| LinkedIn-Signale, beobachtete Posts | `company_linkedin_signals` | Persönlicher Bezug |
| Buying Center (privat) | `buying_center_anzeigen` | Rolle des Empfängers |
| CRM-Stand, Notizen | `company_get` crm, Notizen | Vorgeschichte, nicht doppelt ansprechen |
| Eigenes Profil, Idealkundenprofil | Prompt-Kontext, `icp_get` | Was der Nutzer anbietet |

Lücke auf der eigenen Seite: Das Profil hat Bio, Rolle, Branchen, Regionen, Tonfall, aber kein
festes Feld für **das eigene Angebot** (Leistungen, Nutzen, Referenzen mit Ergebnis). Ohne das
bleibt jede Ansprache auf der Seite des Absenders vage.

## 2. Zielbild

1. Der Nutzer sagt „Schreib eine Erstansprache an Herrn Schwer bei IEF-Werner“ (oder „an den
   Vertriebsleiter von …“, „LinkedIn-Nachricht an …“). AVA ruft **ohne Rückfrage** einmal
   `ansprache_vorbereiten` auf und schreibt im selben Zug.
2. Die Antwort zeigt **zuerst drei bis fünf Aufhänger** mit Quelle („Neue Vertriebsleitung Systeme
   seit 11/2026 · LinkedIn“, „Umsatz +12 % bei 180 Mitarbeitern · Jahresabschluss“, Zahlen hier nur Beispiel), dann den
   ```` ```mail-entwurf ````. Der Nutzer sieht, worauf die Mail baut, und kann einen Aufhänger
   tauschen („nimm statt Finanzen die Expansion“).
3. Aufbau der Mail (fest, außer der Nutzer will es anders): Bezug (ein konkreter, frischer Anlass)
   → These (was das für den Empfänger bedeutet) → Nutzen (ein Satz zum eigenen Angebot, mit
   Referenz, wenn eine passt) → Vorschlag (konkret, klein) → eine Frage. Standardlänge 120–180
   Wörter, Betreff mit Bezug, keine Floskeln.
4. Vor der Ausgabe prüft AVA die Mail (`ansprache_pruefen`): mindestens zwei Fakten aus der
   Vorbereitung, kein Satz, der zu jeder Firma passen würde, Länge im Rahmen, Anrede und Empfänger
   stimmen. Fällt sie durch, schreibt AVA einmal neu, ohne den Nutzer zu fragen.
5. Korrigiert der Nutzer („kürzer“, „Finanzen immer rein“, „nie mit einer Frage enden“), merkt AVA
   sich das als seinen Ansprache-Stil und wendet es beim nächsten Mal von selbst an.

Ton: Fakten nutzen, aber kein Überwachungston. „Mir ist aufgefallen, dass Sie die Vertriebsleitung
Systeme neu besetzt haben“ ja; „Wir haben Ihre Personalwechsel ausgewertet“ nein.

## 3. Technik

- **Gateway, neue Route** `GET /v1/companies/{id}/ansprache?personId=…`: sammelt parallel die
  firmenseitigen Daten aus 1.2 (Profil, Register, jüngster Abschluss mit Umsatz und Mitarbeitern
  samt Vorjahr, Kontakte kompakt, Personalwechsel 12 Monate, Fluktuation, Stellen, Expansion,
  Kunden, Neuigkeiten 90 Tage, LinkedIn-Signale) und liefert sie **verdichtet** (Ziel unter
  3.000 Tokens). Dazu eine deterministische Rangfolge der Aufhänger nach Frische und Stärke:
  Personalwechsel beim Empfänger oder in seinem Bereich > Neuigkeit/Meldung < 90 Tage >
  Expansion/Ausschreibung > Stellen im Zielbereich > Finanzentwicklung > Referenz-Überschneidung >
  Produktbereiche. Zentral, damit app.ava.bi und Copilot/MCP dasselbe bekommen.
- **Desktop, Werkzeug `ansprache_vorbereiten`** (Kern, immer da): ruft die Route und legt die
  privaten, lokalen Teile dazu: eigenes Angebot und Profil, Idealkundenprofil-Abgleich,
  Fokus-Themen-Befunde, Buying-Center-Rolle des Empfängers, CRM-Vorgeschichte, gespeicherter
  Ansprache-Stil. Ergebnis: `aufhaenger[]` (Fakt, Quelle, Datum, Stärke), `empfaenger` (Name,
  Rolle, Adresse samt Status, Du/Sie falls bekannt), `angebot`, `stil`, `vorgeschichte`.
- **Prompt-Regel „Erstansprache“** (wie „Bestandsfragen“/„Personalwechsel“): Auslöser, erster
  Schritt ist EIN `ansprache_vorbereiten`, Aufbau und Länge aus 2.3, Ausgabeformat aus 2.2, Ton,
  danach `ansprache_pruefen`. Nicht nachfragen, was die Vorbereitung beantwortet.
- **`ansprache_pruefen` (deterministisch, ohne KI):** zählt Treffer von Fakten der Vorbereitung im
  Text (Zahlen, Namen, Produktbereiche, Daten), prüft Länge, eine Liste von Floskeln
  („ich hoffe, diese Mail erreicht Sie gut“, „innovative Lösungen“, „Synergien“), Platzhalter,
  Empfänger und Anrede. Rückgabe: bestanden oder konkrete Mängel. Kein zweiter KI-Aufruf nötig.
- **„Mein Angebot“ im Profil:** neues Feld (Leistungen, Nutzen in einem Satz, Referenzen mit
  Ergebnis, Belege). Erstbefüllung aus der eigenen Website (Start-Analyse liest sie ohnehin) als
  Vorschlag zum Bestätigen; in Einstellungen → Profil und per Chat pflegbar (Self-Service-Regel).
- **Stil-Gedächtnis:** Korrekturen an einem Entwurf erkennt der Prompt („kürzer“, „ohne …“, „immer
  …“) und legt sie mit `remember` unter einer festen Kategorie `ansprache` ab; die Vorbereitung
  liefert sie als `stil` mit. Der Nutzer sieht und löscht sie wie jede Erinnerung.
- **MCP/App:** Gateway-Werkzeug `ansprache_vorbereiten` (nur firmenseitig) für Copilot und andere
  Clients; in app.ava.bi derselbe Weg über den Chat.
- **Lösungskarten:** neue Karte „Erstansprache schreiben lassen“, Karte „Texte an Kunden“
  ergänzt.

## 4. Stufen

| Stufe | Inhalt | Aufwand |
|---|---|---|
| **A0** | Prüffälle: fünf echte Ansprachen (IEF-Werner und vier weitere aus Patricks und Joyces Alltag), je Maßstab „gute Endfassung“; Bewertungsraster (Fakten, Frische, Länge, Floskeln, Bezug zum eigenen Angebot) | 0,5 Tag |
| **A1** | Gateway-Route `ansprache` mit Verdichtung und Aufhänger-Rangfolge, Tests | 1 Tag |
| **A2** | Desktop `ansprache_vorbereiten` (Kern), Prompt-Regel, Ausgabeformat | 1 Tag |
| **A3** | `ansprache_pruefen` und ein automatischer Überarbeitungsdurchgang | 0,5 Tag |
| **A4** | „Mein Angebot“ im Profil, Vorschlag aus der eigenen Website, Chat-Werkzeug zum Pflegen | 1 Tag |
| **A5** | Stil-Gedächtnis aus Korrekturen | 0,5 Tag |
| **A6** | MCP-Werkzeug, Lösungskarten, Prüffälle gegen das eingestellte Modell laufen lassen | 0,5 Tag |

Reihenfolge: A0 → A1 → A2 → A3 (damit ist Patricks Problem gelöst), dann A4, A5, A6.
Abnahme: Für alle fünf Prüffälle ist der **erste** Entwurf ohne Nachschieben mindestens so gut wie
die Endfassung nach Raster.

## 5. Entscheidungen (Empfehlung zuerst)

1. **Werkzeug plus feste Regel** statt nur Prompt-Text. Ein Prompt allein („nutze alle Daten“)
   verlangt vom Modell zwölf Aufrufe und scheitert genau daran; ein Aufruf mit verdichtetem
   Ergebnis ist schneller und billiger. Alternative: eingebauter Skill (weniger fest verdrahtet).
2. **Selbstprüfung deterministisch**, ohne zweiten KI-Durchgang. Kostet nichts und ist erklärbar.
   Alternative: KI-Kritiker (besser bei Stilfragen, doppelte Kosten je Mail).
3. **Standardlänge 120–180 Wörter**, „ausführlich“ auf Wunsch oder als gespeicherter Stil.
   Alternative: keine Vorgabe (dann bleiben Mails wie heute oft über 300 Wörter).
4. **Aufhänger sichtbar vor der Mail.** Macht die Arbeit nachvollziehbar und den Unterschied zu
   einem allgemeinen Chatbot sichtbar. Alternative: nur auf Nachfrage.
5. **„Mein Angebot“ als eigenes Profilfeld**, Erstbefüllung aus der eigenen Website als Vorschlag.
   Alternative: weiter nur die Bio (unschärfer, wird für die Ansprache nicht gezielt gepflegt).
6. **Stil lernen nur aus ausdrücklichen Korrekturen**, sichtbar als Erinnerung. Alternative:
   still aus jeder Änderung lernen (undurchsichtig).
7. **Kein Überwachungston** als feste Regel (2.5).

## 6. Risiken

- **Zu viel Kontext:** Alle Quellen ungefiltert sprengen das Kontextfenster kleiner lokaler
  Modelle. Deshalb Verdichtung im Gateway und höchstens fünf Aufhänger.
- **Veraltete oder falsche Fakten** in einer Mail an Dritte sind peinlicher als im Chat. Jeder
  Aufhänger trägt Datum und Quelle; älter als zwölf Monate nur Finanzen und Produkte.
- **Fakten ohne Brücke:** Viele Fakten machen noch keine gute Mail. Die Regel verlangt EINEN Bezug
  und EINE These, nicht eine Aufzählung.
- **Personenbezug:** Personalwechsel und LinkedIn-Aktivität sind öffentlich, wirken aber schnell
  aufdringlich. Tonregel und Prüfung auf Überwachungsformulierungen.
- **Modellqualität:** Kleine lokale Modelle schreiben schwächer. Die Prüfung fängt Floskeln und
  fehlende Fakten ab, nicht aber Eleganz; die Prüffälle zeigen, welches Modell reicht.

## 7. Stand

- 2026-11-19: Befund und Plan geschrieben (Sprachnachricht lokal transkribiert, Prompt und
  Werkzeuge gesichtet). Wartet auf Abnahme.
