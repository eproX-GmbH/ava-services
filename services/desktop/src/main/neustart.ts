// Neustart ueber den regulaeren Beenden-Pfad (Befund 2026-11-09: jeder
// Kontowechsel erzeugte einen macOS-Absturzbericht). Vorher hiess Neustart
// app.relaunch() + app.exit(0): exit ueberspringt before-quit, Producer,
// PGlite und SQLite bleiben offen, und der V8-Abbau laeuft mitten in
// ausstehende libuv-Rueckrufe → SIGTRAP im alten Prozess. app.quit() faehrt
// alles herunter wie beim normalen Beenden (inkl. Notausgang nach 20 s);
// app.relaunch() startet AVA danach neu.
import { app } from "electron";

let angefordert = false;

export function neuStarten(): void {
  if (angefordert) return;
  angefordert = true;
  app.relaunch();
  app.quit();
}

/** true, wenn das laufende Beenden ein Neustart ist (Anzeige „Wird neu gestartet“). */
export function istNeustart(): boolean {
  return angefordert;
}
