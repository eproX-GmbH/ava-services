# Informationspaket Website: Firmen-Radar nach Plan

Zweck: Vorlage fuer den Website-KI-Agenten (ava.bi). Alle Angaben sind
implementiert und serverseitig erzwungen (Stand v0.1.466). Regeln wie
gehabt: keine Em-Dashes, Du-Form, Mehrwert statt Technik, nichts
versprechen, was hier nicht steht.

## Das Feature in einem Satz

Der Firmen-Radar findet laufend Firmen in deiner Region, die noch nicht
in deinem CRM stehen, gleicht sie mit deinem Idealkundenprofil ab und
meldet dir die Treffer, die wirklich passen. Importiert wird nur, was du
ausdruecklich freigibst.

## Was jeder bekommt (alle Plaene)

- **Der grosse Erst-Scan ist fuer alle gleich.** Beim ersten Radar-Lauf
  sucht AVA einmalig mit voller Power (Pro-Niveau: alle Suchkanaele,
  grosser Radius, bis 300 Kandidaten) und baut dir deinen
  Start-Backlog auf. Dieser Lauf kostet kein Kontingent.
- **Firmen-Steckbriefe ohne Limit.** Die Kurzprofile der gefundenen
  Firmen erstellt AVA auf deinem Rechner, fuer jeden Plan
  unbegrenzt.
- **Volle Kontrolle.** Kein Kandidat landet automatisch im Bestand.
  Du entscheidest pro Firma: uebernehmen oder verwerfen.
- **Meldungen nach Relevanz.** Alle Plaene sehen dieselbe Rangliste.
  Kleinere Plaene bekommen weniger Meldungen, aber immer die
  bestplatzierten Treffer zuerst.

## Die Plaene im Vergleich

| | Free | Starter | Pro |
|---|---|---|---|
| Suchlaeufe | 1 pro Woche, manuell | 1 pro Tag, automatisch | bis 4 pro Tag, automatisch |
| Suchradius | bis 25 km | bis 50 km | bis 100 km |
| Suchgebiete gleichzeitig | 1 | 2 | 5 |
| Suchtiefe pro Lauf | Basis-Suche | erweiterte Suche mit KI-Suchplaner | volle Suche: KI-Suchplaner, Handelsregister-Abgleich, Website-Nachrecherche |
| Kandidaten pro Lauf | bis 50 | bis 150 | bis 300 |
| Treffer-Meldungen | die Top 3 der Woche | bis 10 pro Tag | alle passenden, sofort |
| Meldungs-Schwelle | nur sehr gute Treffer | nur sehr gute Treffer | auch gute Treffer |

Formulierungshilfen fuer die Tabelle:

- Free: „Zum Ausprobieren: einmal pro Woche in deiner Stadt suchen und
  die drei besten Treffer aufs Handy bekommen."
- Starter: „Fuer den Einstieg in systematische Neukundensuche: taeglich
  automatisch, zwei Gebiete, die Tages-Treffer kommen von selbst."
- Pro: „Fuer aktiven Vertrieb: bis zu fuenf Regionen im Blick, viermal
  taeglich aktualisiert, jeder passende Treffer sofort per Meldung,
  inklusive Aehnlichkeits-Hinweis zu deinen Bestandskunden."

## Was NICHT behauptet werden darf

- Nicht „unbegrenzt viele neue Kunden": Die Zahl neuer Firmen in einer
  Region ist endlich; der Radar lebt nach dem Erst-Backlog von
  Zugaengen und Aenderungen.
- Nicht „vollautomatischer Import": Import passiert NUR nach
  Nutzer-Entscheidung.
- Nicht „Echtzeit": Automatik-Takte sind woechentlich/taeglich/4x
  taeglich, keine Minuten-Frequenz.
- Kundenliste, Idealkundenprofil und Match-Bewertungen bleiben lokal
  auf dem Rechner des Nutzers; das DARF und SOLL als
  Datenschutz-Vorteil benannt werden.

## Upgrade-Logik (fuer Pricing-Sektion)

Der Kern-Pitch pro Stufe ist Frequenz und Reichweite, nicht Qualitaet:
Alle Plaene bekommen dieselbe Bewertungslogik und dieselbe Rangliste.
Wer mehr Gebiete beobachtet und oefter sucht, sieht neue Firmen
frueher und bekommt mehr passende Treffer gemeldet. Das ist der
ehrliche Grund fuers Upgrade.
