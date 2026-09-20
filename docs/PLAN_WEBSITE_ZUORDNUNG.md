# Plan: Gehoert diese Website wirklich zu dieser Firma?

Stand 2026-09-20. Anlass: **JR Immobilien Verwaltung GmbH, HRB 18331,
Bad Oeynhausen / Am Hahler Hafen 14, Minden.** Das Handelsregister war
richtig, samt Geschaeftsfuehrer Justin Rafflenbeul. Dann fand der
Website-Dienst `jr-immobilienverwaltung.de` — eine Einzelunternehmerin
(Jessica Redder) in Bremen. Ab da war alles falsch: Firmenprofil,
Leistungen, USPs, Kontaktdaten. Im Impressum haette eine Sekunde
gereicht, um das zu sehen.

---

## 0. Meine Meinung vorweg

**Dein Vorschlag ist richtig, und die Stufenfolge ist die richtige
Reihenfolge.** Drei Dinge wuerde ich ergaenzen oder anders setzen.

**Erstens: Der eigentliche Konstruktionsfehler ist nicht die fehlende
Pruefung, sondern dass "keine Website" bisher kein moegliches Ergebnis
war.** Der Judge kann zwar `matchIndex: null` liefern — aber er bekommt
nur Titel, URL und Snippet zu sehen und wird mit Firmenname plus Ort
gefragt. Bei gleichem Namen passt das immer. Ein System, das eine Firma
ohne Website nicht ergebnislos verlassen kann, wird bei jeder
Namensgleichheit raten. Und Namensgleichheit ist bei "JR
Immobilienverwaltung", "Meier Bau", "Schmidt Logistik" der Normalfall,
nicht die Ausnahme.

**Zweitens, und das ist der gefaehrlichste Einzelbefund: Es gibt einen
stillen Pfad zur falschen URL, der nichts mit dem Judge zu tun hat.**
`heuristicFallback` in `website-judge.ts` nimmt bei JEDEM Fehler des
Sprachmodells — Zeitablauf, Anbieterstoerung, ungueltiges JSON —
**einfach den ersten Google-Treffer**, mit `confidence: "low"`. Diese
Vertrauensstufe wird nirgends ausgewertet. Ein Ollama-Neustart im
falschen Moment genuegt also, um eine beliebige Firma mit dem
erstbesten Suchergebnis zu verheiraten. Das gehoert weg, unabhaengig
vom Rest dieses Plans: Bei einem Fehler ist die richtige Antwort
"unbekannt", nicht "das erste Ergebnis".

**Drittens: Die Daten fuer Stufe 1 liegen bereits vor und werden
weggeworfen.** `upsertCompanySerpCommand` bekommt `street`, `zipCode`
und `city` herein. Weitergereicht an `searchAndJudge` wird aber nur
`companyName` und `city` (`valueserp-utils.ts`, Zeile 132). Die Strasse
— das trennschaerfste Merkmal ueberhaupt — sieht der Judge nie. Das ist
die billigste Verbesserung im ganzen Plan und sollte zuerst kommen.

**Was ich anders setzen wuerde als in deinem Entwurf:** Du schreibst
"Impressum bei Unsicherheit auslesen". Ich wuerde das Impressum
**immer** auslesen, wenn ein Kandidat gewaehlt wurde. Begruendung: Die
"Unsicherheit" ist genau das, was wir nicht zuverlaessig messen koennen
— im JR-Fall waere die Zuordnung nach Name und Ort **sicher** erschienen.
Ein Abruf kostet lokal ein paar hundert Millisekunden und keinen Cent
(die Seite wird ohnehin gleich danach vollstaendig gecrawlt). Eine
Pruefung, die nur dann laeuft, wenn man schon zweifelt, faengt genau den
Fall nicht, der wehtut.

---

## 1. Wo es heute auseinanderfaellt

```
Handelsregister (richtig)
  Name, Strasse, PLZ, Ort, Geschaeftsfuehrer
        |
        v
upsert-company-serp-command.ts      <- street/zipCode/city sind hier noch da
        |
        v
valueserp-utils.ts searchAndJudge({ companyName, city })   <- Strasse faellt weg
        |
        v
website-judge.ts                    <- sieht nur Titel, URL, Snippet
        |                              kennt weder Adresse noch GF
        |                              oeffnet die Seite nie
        v
Website-Zeile mit URL
        |
        +--> company-profile   (crawlt die FALSCHE Seite)
        +--> company-contact   (findet die FALSCHEN Menschen)
        +--> structured-content
```

Vier Schwachstellen, in der Reihenfolge ihrer Wirkung:

| # | Befund | Datei |
| --- | --- | --- |
| S1 | Strasse und PLZ erreichen den Judge nicht | `valueserp-utils.ts:132` |
| S2 | Geschaeftsfuehrer ist im Dienst gar nicht bekannt | — |
| S3 | Die Seite wird vor der Entscheidung nie geoeffnet | `website-judge.ts` |
| S4 | Bei LLM-Fehler wird der erste Treffer genommen | `website-judge.ts:64-81` |

---

## 2. Die Stufenfolge

Deine drei Stufen, plus eine Stufe 0 davor und eine klare Regel danach.

### Stufe 0 — mit dem suchen, was wir haben (sofort)

`searchAndJudge` bekommt `street`, `zipCode` und den Geschaeftsfuehrer
mit. Der Suchbegriff bleibt `Name + Ort` (eine Adresse in der Suchzeile
verschlechtert Google-Treffer), aber der **Judge-Prompt** nennt beides.
Damit kann das Modell einen Treffer schon an Title und Snippet
verwerfen, wenn dort "Bremen" steht und im Register "Minden".

Kostet nichts, faengt aber nur die offensichtlichen Faelle.

### Stufe 1 — Impressum lesen, wortgleicher Abgleich

Nach der Auswahl eines Kandidaten wird die Seite abgerufen und das
Impressum gesucht:

1. Direkter Versuch: `/impressum`, `/impressum.html`, `/imprint`,
   `/legal-notice`, `/kontakt/impressum`.
2. Sonst: Link im HTML, dessen Text oder `href` "impressum",
   "imprint" oder "legal" enthaelt (Fussbereich zuerst).

Aus dem Impressum werden **Anschrift** und **vertretungsberechtigte
Person** gelesen. Wortgleich (nach Grossschreibung und Leerzeichen)
gegen die Registerdaten:

- PLZ identisch UND Strasse identisch → **bestaetigt**, fertig.
- Name des Geschaeftsfuehrers identisch → **bestaetigt**, fertig.

### Stufe 2 — normalisierter Abgleich

Dieselbe Pruefung, aber vergleichbar gemacht:

- Strasse: `str.`/`straße`/`strasse` vereinheitlichen, Hausnummer
  getrennt vergleichen (`14` gegen `14a` gilt als gleich),
  Umlaute falten (dieselbe `falteUmlaute` wie bei den Kontakten —
  "Groß-Gerau" und "Gross-Gerau" sind derselbe Ort).
- Ort: gegen PLZ pruefen, nicht gegen den Ortsnamen. Register-Sitz und
  Geschaeftsanschrift weichen oft ab (im JR-Fall: Bad Oeynhausen gegen
  Minden — **beides richtig**, und genau deshalb darf ein Ortsunterschied
  allein nichts verwerfen).
- Personennamen: Titel weg ("Dipl.-Kfm."), Reihenfolge egal
  ("Rafflenbeul, Justin" = "Justin Rafflenbeul"), Umlaute gefaltet.

Trifft eines davon zu → **bestaetigt**.

### Stufe 3 — das Modell urteilt

Nur wenn Stufe 1 und 2 nichts ergeben. Das Modell bekommt die
Registerdaten und den Impressumstext und antwortet nach festem Schema:

```json
{ "urteil": "passt" | "passt_nicht" | "unklar", "grund": "ein Satz" }
```

Wichtig: **drei** Antwortmoeglichkeiten, nicht zwei. "Unklar" ist ein
ehrliches Ergebnis (Impressum unlesbar, Holding-Struktur, Seite einer
Unternehmensgruppe) und darf nicht in "passt" gebogen werden, nur damit
etwas herauskommt.

### Die Regel danach

| Ergebnis | Folge |
| --- | --- |
| bestaetigt (Stufe 1, 2 oder 3 "passt") | URL wird gespeichert, alles laeuft weiter |
| "passt_nicht" | **URL wird verworfen.** Kein Website-Eintrag, kein Profil, keine Kontakte |
| "unklar" | URL wird verworfen, aber als **offene Frage** vermerkt (siehe 4.) |
| kein Impressum auffindbar | "unklar" |

"Keine Website gefunden" ist damit ein vollwertiges, richtiges
Ergebnis — und zwar das richtige fuer die JR Immobilien Verwaltung GmbH.

---

## 3. Fallstricke, die ich sehe

Der Teil, um den du gebeten hast. Ich halte die ersten drei fuer die
ernsten.

**F1 — Die Pruefung selbst kann falsch liegen, und dann loeschen wir
etwas Richtiges.** Eine Firma mit Hauptsitz in Minden und einer Website,
die das Impressum der Muttergesellschaft in Hamburg zeigt, wuerde
verworfen. Das ist der teuerste Fehler dieses Plans: Heute bekommt der
Nutzer falsche Daten und sieht es; nach diesem Plan bekommt er gar keine
und sieht nichts. **Gegenmittel:** "passt_nicht" wird protokolliert und
ist in der Firmenansicht sichtbar ("Eine moegliche Website wurde
verworfen: …, Impressum nennt … — trotzdem verwenden?"). Der Nutzer kann
sie mit einem Klick annehmen. Das Urteil darf nie stumm sein.

**F2 — Viele Impressen nennen keinen Geschaeftsfuehrer**, sondern nur
eine Firmierung, und kleine Seiten haben gar kein Impressum (obwohl sie
muessten). Wenn "kein Impressum" hart zu "verwerfen" fuehrt, verlieren
wir Websites reihenweise. Deshalb ist "kein Impressum" = **unklar** und
nicht = "passt nicht". Und deshalb prueft Stufe 3 auch die
**Startseite**, nicht nur das Impressum: Adresse und Firmierung stehen
oft im Fussbereich.

**F3 — Das Modell laeuft lokal, und der Nutzer waehlt es selbst.** Ein
kleines Ollama-Modell urteilt anders als GPT-5. Ein wackliges Urteil,
das Daten LOESCHT, ist schlimmer als eines, das sie nur einsortiert.
**Gegenmittel:** Stufe 3 darf nur "passt_nicht" sagen, wenn Stufe 2
einen **klaren Widerspruch** gefunden hat (andere PLZ UND anderer Name).
Findet Stufe 2 schlicht nichts (leeres Impressum), ist das Ergebnis
"unklar" — und "unklar" verwirft zwar auch, aber sichtbar und
umkehrbar (F1).

**F4 — Mehr Abrufe, mehr Bot-Abwehr.** Ein zusaetzlicher Abruf je Firma,
auf einer Seite, die ohnehin gleich gecrawlt wird. Der vorhandene
`website-utils.search` mit Browser-Rueckfall deckt das ab. Bei einem
Massenimport sind es aber einige tausend zusaetzliche Aufrufe.
**Gegenmittel:** Das Impressum-Ergebnis in derselben Sitzung
zwischenspeichern, damit der spaetere Crawl es nicht erneut holt.

**F5 — Adressen aendern sich.** Das Register ist traege, ein Impressum
ist aktuell. Eine umgezogene Firma faellt durch Stufe 1 und 2 und landet
bei Stufe 3. Dort ist der GF-Name das rettende Merkmal — ein weiterer
Grund, ihn mitzugeben (S2).

**F6 — "unklar" wird zur Muelltonne.** Wenn am Ende 40 % der Firmen auf
"unklar" stehen, hat niemand etwas gewonnen. **Gegenmittel:** Die Quote
je Lauf messen und im Protokoll ausgeben. Liegt sie ueber 15 %, stimmt
etwas mit der Impressum-Erkennung nicht, nicht mit den Firmen.

**F7 — Keine Rueckwirkung auf Bestandsdaten.** Dieser Plan aendert nur
kuenftige Laeufe. Der Altbestand braucht einen eigenen Durchgang
(Abschnitt 6), und den halte ich fuer genauso wichtig: Die falschen
Daten stehen ja schon in der Datenbank.

---

## 4. Was gespeichert wird

Eine Zuordnung, die etwas verwirft, muss belegen koennen, warum.
Neue Felder an der Website-Zeile:

```
zuordnung        bestaetigt | verworfen | unklar
zuordnungStufe   0 | 1 | 2 | 3
zuordnungGrund   ein Satz, Klartext
impressumUrl     wo geprueft wurde
verworfeneUrl    die abgelehnte Adresse (fuer "trotzdem verwenden")
geprueftAm
```

`verworfeneUrl` ist das Gegenstueck zu F1: Die Adresse geht nicht
verloren, sie wird nur nicht verwendet. In der Firmenansicht erscheint
ein Hinweis mit der Moeglichkeit, sie doch zu uebernehmen — dann wird
die Zuordnung auf "vom Nutzer bestaetigt" gesetzt und nicht wieder
gefragt.

---

## 5. Umsetzungsstufen

| Stufe | Inhalt | Ergebnis |
| --- | --- | --- |
| **W0** | `heuristicFallback` entfernen: LLM-Fehler → kein Treffer statt erster Treffer. | Der stille Pfad zur falschen URL ist zu |
| **W1** | Strasse, PLZ und GF bis in den Judge-Prompt durchreichen (S1/S2). | Offensichtliche Fehlgriffe fallen schon hier |
| **W2** | Impressum finden und auslesen (Adresse, vertretungsberechtigte Person). | Grundlage fuer den Abgleich |
| **W3** | Stufe 1 und 2: wortgleich und normalisiert, mit geteilter Normalisierung. | Die klaren Faelle ohne Modellaufruf |
| **W4** | Stufe 3: Modellurteil mit drei Antworten, nur nach klarem Widerspruch verwerfend. | Die Graubereiche |
| **W5** | Felder speichern, Hinweis in der Firmenansicht, "trotzdem verwenden". | Kein stummes Urteil (F1) |
| **W6** | Quote "unklar" je Lauf im Protokoll (F6). | Wir merken, wenn die Pruefung selbst kaputt ist |
| **W7** | Altbestand durchgehen (Abschnitt 6). | Die bereits falschen Firmen |

W0 und W1 sind klein und wirken sofort — die wuerde ich unabhaengig vom
Rest vorziehen.

---

## 6. Altbestand

Zwei Schritte, beide erst nach ausdruecklicher Freigabe.

**Sichten (nur lesen).** Kandidaten sind Firmen, deren Website-Domain
nicht zum Firmennamen passt ODER deren Profil eine Adresse nennt, die
nicht zur Registeradresse passt. Ergebnis ist eine Liste zum Ansehen,
keine Aenderung.

**Bereinigen.** Fuer bestaetigte Fehlzuordnungen: Website-URL auf NULL,
Firmenprofil und die aus der Website gewonnenen Kontakte entfernen,
Registerdaten und Kontakte aus anderen Quellen (Apify/LinkedIn)
**bleiben**. Wiederholbar, in einer Transaktion, mit Protokolltabelle —
nach dem Muster von `tools/dubletten-bereinigung.sql`.

Fuer die JR Immobilien Verwaltung GmbH aus Minden heisst das: Website,
Firmenprofil und die daraus gezogenen Kontakte verschwinden. Register,
Geschaeftsfuehrer und Standort bleiben. Genau so soll die Firma
aussehen — als eine ohne Website.

---

## 7. Offene Entscheidungen

1. ~~**Woher kommt der Geschaeftsfuehrer?**~~ Geklaert beim Sichten der
   Produktionsdaten: Beides liegt in `ava_structured_content` und ist
   registergestuetzt, also genau die Wahrheit, gegen die wir pruefen
   wollen.

   - `StructuredContent` je `companyId`: `name`, `street`, `houseNumber`,
     `zipCode`, `city` — fuer die JR GmbH "Am Hahler Hafen 14, 32427
     Minden".
   - `ManagingDirector` je `companyId`: `firstName`, `lastName`,
     `birthDay`, `city` — dort steht Justin Rafflenbeul.

   Damit ist der Gateway-Abruf die klare Wahl: eine Stelle statt vier
   Aufrufpfade, und der Website-Dienst bleibt unabhaengig davon, was der
   Aufrufer weiss. Offen bleibt nur, ob das Gateway dafuer einen eigenen
   schlanken Endpunkt bekommt oder ob die bestehende Firmenabfrage
   reicht.
2. **Wie streng ist "klarer Widerspruch"?** Mein Vorschlag: andere PLZ
   UND kein uebereinstimmender Personenname. Nur eines von beidem
   reicht nicht.
3. **Was passiert bei "unklar" mit den Folgestufen?** Mein Vorschlag:
   behandeln wie "keine Website" — also kein Profil, keine Kontakte.
   Lieber eine leere Firma als eine falsch befuellte. Die Gegenposition
   waere, bei "unklar" weiterzulaufen und nur zu kennzeichnen.
4. **Soll die Pruefung abschaltbar sein?** Ich waere dagegen: Ein
   Schalter, der falsche Daten erlaubt, wird irgendwann versehentlich
   umgelegt.
