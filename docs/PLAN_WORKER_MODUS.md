# Worker-Modus

Stand 2026-09-17, umgesetzt in v0.1.678.

Ein Rechner soll nebenher als Verarbeiter laufen dürfen: AVA arbeitet dann
ausschließlich Handelsregister-Jobs ab und lässt alles andere ruhen. Gedacht für
den Betreiber und Kolleginnen und Kollegen, die einen Rechner dafür abstellen.

## Was läuft, was ruht

Weiter aktiv:

- Register-Delta (Mithelfen): Registerblätter, strukturierter Registerinhalt,
  später Gesellschafterlisten.
- Anmeldung, weil der Worker dafür einen Token braucht.
- Aktualisierung der App, Wachhund, die Aufräumläufe einmal am Tag.

Angehalten, solange der Modus an ist:

Herzschlag, Wiederholungen, Auffrischung, Nachlauf hängender Schritte,
Producer, Vorgänge, Statuswächter, E-Mail-Muster, Abläufe, Radar, Mini-Profile,
Beobachtungsliste, Personen-Radar, geplante Aufgaben, Link-Beobachter, Mail,
Erreichbarkeitsprüfung.

Die App bleibt bedienbar. Gespeicherte Daten sind weiter sichtbar, nur es
entstehen keine neuen.

## Aufbau

`services/desktop/src/main/worker-modus.ts` hält eine Liste von Diensten. Jeder
Dienst meldet sich dort an, wo er im Start verdrahtet wird, und sagt, wie er
anhält und wieder anläuft. Ein Dienst kann zusätzlich angeben, ob er überhaupt
laufen darf (`darfLaufen`), damit er nach dem Ausschalten nicht gegen eine
Organisationsvorgabe oder eine eigene Einstellung anläuft.

Wichtig für neue Hintergrunddienste: Wer ein `setInterval` oder einen Supervisor
ergänzt, meldet ihn direkt nach dem Start mit an. Ohne Anmeldung läuft er im
Worker-Modus weiter, und das fällt niemandem auf.

Meldet sich ein Dienst an, während der Modus schon läuft, wird er sofort
angehalten. Das deckt die Dienste ab, die erst spät im Start anlaufen.

## Schalter

Der Schalter sitzt bei den Einstellungen unter „Stammdaten mitpflegen"
(`nurRegister` in derselben Datei wie die übrigen Mithelfen-Einstellungen,
`<userData>/register-delta/settings.json`). Er lässt sich nur setzen, wenn
Mithelfen an ist, denn sonst bliebe gar nichts übrig, was arbeitet.

Im Chat: `register_delta_config` mit `nurRegister`, mit Rückfrage wie alle
schreibenden Werkzeuge.

Solange der Modus läuft, steht unter dem Kopf der App ein Band, das sich nicht
wegklicken lässt. Sonst sucht man den Fehler an der falschen Stelle, wenn keine
Vorgänge mehr laufen.
