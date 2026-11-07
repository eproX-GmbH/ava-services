---
id: import-haengt
titel: Der Import dauert lange oder scheint zu hängen
fragen:
  - import hängt
  - seit einer stunde passiert nichts
  - verarbeitung steckt fest
  - alles ist rot in der liste
  - processing stuck
  - warum dauert das so lange
schlagworte: [hängt, steckt fest, dauert, langsam, keine bewegung, zeitüberschreitung, abgebrochen, rot, fehlgeschlagen, neu anstoßen, pausiert]
aktionen:
  - { art: chat_vorschlag, ziel: "Mein Import hängt. Prüf bitte, wo er steht, und starte fehlgeschlagene Schritte neu.", label: "Import prüfen" }
  - { art: app_oeffnen, ziel: aufgaben, label: "Vorgänge öffnen" }
stand: 2026-11-07
---
Die Verarbeitung läuft in deiner AVA, also auf deinem Rechner oder deiner Server-Instanz. Ist die App geschlossen, steht sie still und läuft beim nächsten Start weiter. Bei großen Listen laufen die Firmen nicht alle gleichzeitig; das kann Stunden dauern.

Woran du Hänger erkennst: Die Leiste über dem Eingabefeld zeigt nach 15 Minuten „seit … keine Bewegung“. Bleibt ein Schritt 30 Minuten ohne Lebenszeichen, wird er mit „Zeitüberschreitung“ abgebrochen; das ist kein Datenfehler. Nach 60 Minuten ganz ohne Fortschritt wird die Aufgabe abgebrochen, offene Schritte enden mit Fehler, und ich sage dir, wo es stehen blieb.

Was ich tun kann: nachsehen, welche Schritte fehlgeschlagen sind, und genau diese neu starten. Prüf auch, ob die Verarbeitung oben in Meine Firmen auf „Pausiert“ steht oder die Firma dort ausgesetzt ist. Hängt es danach immer noch, melde es über „Problem melden“; die Protokolle deines Geräts gehen mit.
