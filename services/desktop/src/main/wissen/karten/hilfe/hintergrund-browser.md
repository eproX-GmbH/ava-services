---
id: hintergrund-browser
titel: Warum AVA einen eigenen Chrome im Hintergrund nutzt
fragen:
  - warum läuft chrome im hintergrund
  - ava öffnet chrome
  - chrome for testing was ist das
  - chrome lässt sich nicht beenden wegen ava
  - nutzt ava meinen browser
  - 160 mb download browser
schlagworte: [browser, chrome, chrome for testing, hintergrund, headless, prozess, aktivitätsanzeige, task-manager, download, sicherheit, firewall]
aktionen:
  - { art: chat_vorschlag, ziel: "Wie steht es um den Browser der Hintergrundverarbeitung?", label: "Browser prüfen" }
stand: 2026-11-07
---
Für Handelsregister, Firmen-Websites und Publikationen liest AVA Seiten mit einem eigenen Browser, unsichtbar im Hintergrund. Dafür lädt AVA einmalig eine eigene Fassung von Chrome for Testing, rund 160 MB. Deshalb siehst du in der Aktivitätsanzeige oder im Task-Manager Chrome-Prozesse, auch wenn dein Chrome geschlossen ist.

Dein eigener Chrome bleibt unberührt: AVA startet und beendet ihn nie und teilt keine Anmeldungen mit ihm. Der Hintergrund-Browser lädt keine Dateien von Websites herunter; Ausnahme sind Registerdokumente direkt vom Handelsregister. Er nimmt keine Verbindungen von außen an. Beim Start räumt AVA Reste aus früheren Sitzungen auf.

Den Zustand siehst du unter Einstellungen → Erweitert → Dienste auf diesem Rechner → Browser im Hintergrund. Fehlt die eigene Fassung noch, nutzt AVA so lange den installierten Browser; ich kann sie dir nach Rückfrage laden.
