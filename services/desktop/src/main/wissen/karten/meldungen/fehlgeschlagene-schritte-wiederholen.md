---
id: fehlgeschlagene-schritte-wiederholen
titel: Fehlgeschlagene Verarbeitungsschritte automatisch wiederholen lassen
fragen:
  - wiederholt ava fehlgeschlagene schritte
  - automatisch erneut versuchen ausschalten
  - verarbeitung ist fehlgeschlagen was nun
  - auto retry
  - ava versucht es immer wieder
schlagworte: [wiederholen, erneut versuchen, fehlgeschlagen, auto-retry, verarbeitung, schritt, automatisch, fehler, neustart]
aktionen:
  - { art: app_oeffnen, ziel: meldungen_einstellen, label: "Einstellung öffnen" }
  - { art: app_oeffnen, ziel: aufgaben, label: "Laufende Aufgaben öffnen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Schlägt ein Verarbeitungsschritt einer Firma fehl, zum Beispiel weil eine Website gerade nicht erreichbar war, versuche ich es von selbst erneut. Dafür schaue ich alle 10 Minuten nach fehlgeschlagenen Schritten und starte sie neu. Aufgeben tue ich erst, wenn ein Schritt mindestens fünfmal gescheitert ist und der erste Fehler mehr als 24 Stunden zurückliegt, damit nichts endlos in einer Schleife hängt.

Der Schalter heißt „Fehlgeschlagene Schritte automatisch erneut versuchen“ und steht unter Einstellungen → Meldungen → „Meldungen & Ruhezeiten“. Er ist voreingestellt an. Ausschalten lohnt sich nur, wenn ein Schritt immer wieder scheitert und du das erst klären willst.

Einzelne Schritte einer Firma kann ich dir auch gezielt im Chat neu starten, sag mir einfach, um welche Firma es geht.
