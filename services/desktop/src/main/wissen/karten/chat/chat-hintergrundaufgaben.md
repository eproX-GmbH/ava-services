---
id: chat-hintergrundaufgaben
titel: Laufende Verarbeitung im Chat verfolgen und Bescheid bekommen
fragen:
  - sag mir bescheid wenn der import fertig ist
  - wie weit ist die verarbeitung
  - 12 von 40 firmen fertig was heißt das
  - abgebrochen 60 minuten ohne jeden fortschritt
  - muss ich warten bis das fertig ist
  - nicht mehr verfolgen
schlagworte: [hintergrundaufgabe, aufgabe, fortschritt, import, verarbeitung, fertig, melden, benachrichtigung, abgebrochen, vorgang, warten, meldest du dich, wenn fertig, durch sind]
aktionen:
  - { art: chat_vorschlag, ziel: "Wie weit sind meine laufenden Verarbeitungen?", label: "Stand zeigen" }
  - { art: app_oeffnen, ziel: aufgaben, label: "Laufende Aufgaben öffnen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Startest du einen Import oder eine andere Verarbeitung, verfolge ich sie im Hintergrund. Im Chat steht dazu eine Karte mit Fortschritt, etwa „12 von 40 Firmen fertig“. Bei bis zu fünf Firmen siehst du die Schritte je Firma direkt dort, sonst führt „Vorgang öffnen“ zur Übersicht. Du musst nicht warten und kannst weiterarbeiten.

Sobald alles fertig ist, melde ich mich in diesem Gespräch von selbst mit dem Ergebnis, auch mit Fehlschlägen und dem nächsten sinnvollen Schritt. Ist die App gerade nicht im Vordergrund, bekommst du eine Systembenachrichtigung. Für andere laufende Vorgänge sag einfach „sag Bescheid, wenn es fertig ist“.

Bewegt sich 60 Minuten lang gar nichts, breche ich mit „Abgebrochen: 60 Minuten ohne jeden Fortschritt“ ab und biete an, es neu anzustoßen. Das × an der Karte beendet nur das Verfolgen, die Verarbeitung läuft weiter. Ist die App zu, melde ich mich beim nächsten Start.
