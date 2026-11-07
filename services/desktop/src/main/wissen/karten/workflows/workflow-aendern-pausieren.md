---
id: workflow-aendern-pausieren
titel: Einen Workflow ändern, pausieren oder löschen
fragen:
  - workflow pausieren
  - workflow ausschalten
  - workflow löschen
  - schritt im workflow ändern
  - mail obergrenze im workflow erhöhen
  - workflow umbenennen
schlagworte: [workflow, ändern, bearbeiten, editor, pausieren, aktiv, deaktivieren, löschen, schritt, parameter, fehler-workflow, rückgängig]
aktionen:
  - { art: chat_vorschlag, ziel: "Pausiere meinen Workflow.", label: "Workflow pausieren" }
  - { art: app_oeffnen, ziel: workflows, label: "Workflows öffnen" }
stand: 2026-11-07
---
Sag mir einfach, was anders sein soll, etwa „setz im Workflow Radar-Import den Mindest-Score auf 80“ oder „pausiere den Workflow“. Ich zeige dir die Änderung und frage vorher nach. Für Änderungen im Chat, auch fürs Pausieren, brauche ich ein Chat-Modell der höchsten Stufe. Der Schalter in der App geht immer.

In der App unter Vorgänge → Workflows:
- Der Schalter „aktiv“ auf der Karte pausiert den Workflow. Pausiert läuft er nur noch, wenn du ihn selbst startest.
- „Öffnen“ führt in den Editor. Klick auf einen Schritt zeigt Name, Parameter, Modus, das Verhalten „Bei Fehler“ und die Freigabe. Im Reiter „Trigger“ stellst du Auslöser, Firmenbezug, einen Fehler-Workflow und die Mail-Obergrenze je Tag ein. Rückgängig und Wiederholen gibt es oben, gespeichert wird mit „Speichern“. Größere Umbauten gehen leichter mit „Im Chat ändern“.
- „Löschen“ entfernt den Workflow samt seinen Läufen, nach einer Rückfrage.
