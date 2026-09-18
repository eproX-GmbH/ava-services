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

## Vorfall 2026-09-18: Start im Worker-Modus blieb hängen

In v0.1.678 hing AVA, nachdem der Modus eingeschaltet war. Beim nächsten Start
kam kein Fenster mehr: Die App blieb kurz nach dem Anwenden des Modus stehen,
der Wachhund erkannte den Stillstand und startete sie endlos neu. Der Schalter
war damit nur noch von außen erreichbar, in
`<userData>/accounts/<konto>/register-delta/settings.json`.

Aus dem Sample des hängenden Prozesses: Der Hauptthread rechnete durchgehend
JavaScript, und der Speicher lag nach 23 Sekunden Laufzeit bei 1,1 Gigabyte
statt der üblichen paar hundert Megabyte. Es läuft dort also etwas, das Speicher
anhäuft. Welcher der siebzehn Dienste das auslöst, war aus dem Sample nicht
abzulesen, weil die Namen im übersetzten Code fehlen. Alle Stopp-Methoden für
sich sind harmlos, sie löschen nur Zeitgeber.

Gegenmaßnahmen in v0.1.679:

- **Der Start hängt nicht mehr davon ab.** Der Modus wird erst fünf Sekunden
  nach dem Hochfahren angewendet, nicht mehr mitten im Start.
- **Ein Merker erkennt den Fehlschlag.** Vor dem Anwenden wird eine Datei
  geschrieben und danach gelöscht. Liegt sie beim nächsten Start noch da, hat
  AVA den Versuch nicht überlebt: Dann startet sie ohne den Modus und schaltet
  ihn in den Einstellungen ab. Das gilt für den Start und für das Einschalten.
- **Jeder Dienst hat eine Frist** von drei Sekunden und wird einzeln
  protokolliert, mit einer Zeile davor und einer danach, synchron geschrieben.
  Blockiert ein Dienst, steht sein Name als letzter im Protokoll.
- **Die Dienstliste wird kopiert**, bevor sie durchlaufen wird. Meldet sich
  währenddessen ein Dienst an, kann die Schleife sonst nicht enden.

Bleibt offen: Welcher Dienst den Speicher treibt. Die nächste Meldung aus dem
Protokoll beantwortet das. Der Verdacht, dass dieselbe Ursache hinter dem
Hänger beim Beenden steckt, liegt nahe: Auch dort blockiert nach dem Stoppen
vieler Dienste synchrones JavaScript die Ereignisschleife, siehe
`docs/ANALYSE_CHROME_PROZESSE.md` Punkt D11.
