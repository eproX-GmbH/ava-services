---
id: chat-scan-pdf
titel: Gescanntes PDF ohne Text lesen lassen
fragen:
  - ist ein scan-pdf was heißt das
  - du kannst mein gescanntes pdf nicht lesen
  - wie viele seiten soll ich rendern
  - pdf ist nur ein bild
  - eingescannter vertrag lesen
schlagworte: [scan, scan-pdf, gescannt, pdf, bild, ocr, seiten, rendern, vision, bildmodell, kosten]
aktionen:
  - { art: app_oeffnen, ziel: modell, label: "Bild-Modell wählen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Manche PDFs sind nur eingescannte Bilder ohne Text. Das erkenne ich beim Hochladen und frage dich: „ist ein Scan-PDF“. Dann wandle ich die Seiten in Bilder um, damit das Modell sie lesen kann.

Du wählst, wie viele Seiten: 5, 10, 20 oder alle. Der Rest wird nicht gelesen. Seiten als Bilder kosten deutlich mehr als normaler Text, die Knöpfe zeigen den ungefähren Umfang. Nimm deshalb nur so viele Seiten, wie du brauchst, und lade lieber einen Auszug hoch, wenn es nur um wenige Seiten geht.

Damit das klappt, muss dein Chat-Modell Bilder verstehen. In der Modell-Liste steht bei solchen Modellen „vision“. Mit einem Modell ohne Bildverständnis werden die Seiten ignoriert.
