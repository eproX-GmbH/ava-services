---
id: meldungen-keine-fundstellen
titel: „Keine neuen Fundstellen“ im Prüflauf, arbeitet AVA überhaupt?
fragen:
  - da steht 0 kandidaten geprüft
  - keine neuen fundstellen heißt das es geht nicht
  - prüflauf findet nichts
  - fundstellen warten auf bewertung
  - lauf übersprungen
schlagworte: [fundstellen, keine neuen fundstellen, 0 kandidaten, prüflauf, heartbeat, rückstand, übersprungen, warten, bewertet, verlauf]
aktionen:
  - { art: app_oeffnen, ziel: meldungen_einstellen, label: "Letzte Prüfläufe" }
  - { art: chat_vorschlag, ziel: "Prüf jetzt, ob es neue Meldungen gibt", label: "Jetzt prüfen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Ja, das ist normal. Jeder Lauf schaut nur, was seit dem letzten Lauf neu dazugekommen ist. Bei einem Takt von 15 Minuten ist das meistens nichts, dann steht dort „keine neuen Fundstellen“ und „nichts zu bewerten“. Der erste Lauf nach dem Start der App schaut dagegen bis zu 30 Tage zurück und findet entsprechend mehr.

Was die anderen Angaben unter Einstellungen → Meldungen bei „Letzte Prüfläufe“ bedeuten:

- „bewertet“: Funde, die ich in diesem Lauf beurteilt habe; aufgeklappt siehst du je Fund „gemeldet“, „nicht alarmwürdig“ mit Grund oder „gesammelt“.
- „schon früher bewertet“ und „bereits gemeldet“: kommt nicht doppelt.
- „warten auf den nächsten Lauf“: Ich bewerte höchstens 20 Funde je Lauf, oder das KI-Modell war nicht bereit. Der Rest kommt im nächsten Lauf dran.
- „übersprungen“: Der vorige Lauf lief noch.

Die Liste gilt nur für die aktuelle Sitzung und ist nach einem Neustart leer.
