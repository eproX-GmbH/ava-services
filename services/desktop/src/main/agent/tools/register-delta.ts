// Register-Delta S6 — Chat-Tools fuer "Mithelfen": Status lesen, Einstellung
// aendern (mit Bestaetigung, Self-Service-Regel).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { MithelfenSupervisor } from "../../register-delta/supervisor";
import { workerModus } from "../../worker-modus";

const GRUND_TEXT: Record<string, string> = {
  aus: "ausgeschaltet",
  organisation: "von der Organisation abgeschaltet",
  abgemeldet: "nicht angemeldet",
  akku: "Akkubetrieb (nur im Netzbetrieb aktiv)",
  nicht_installiert: "Worker nicht installiert",
  gesperrt: "Registerportal hat die Abfragen vorübergehend gesperrt",
};

export function buildRegisterDeltaTools(deps: { get: () => MithelfenSupervisor | null; queueStatus: () => Promise<Record<string, unknown> | null> }): Tool[] {
  const status = defineTool({
    name: "register_delta_status",
    summary: "Stammdaten mitpflegen: Status des lokalen Register-Workers und der geteilten Job-Queue.",
    category: "stammdaten mithelfen register handelsregister worker queue status aktualisierung",
    description:
      "Zeigt, ob dieser Rechner Register-Jobs abarbeitet (Nummernfront neuer Firmen, Registerbekanntmachungen, Auffrischung bekannter Firmen), " +
      "warum er gerade pausiert, welchen Job er bearbeitet, wie viele Abfragen in der letzten Stunde liefen (Budget 60), und den Stand der " +
      "geteilten Queue (offene und erledigte Jobs, aktive Worker). Nur lesend.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.lokal?.laeuft ? "Mithelfen aktiv" : `Mithelfen pausiert: ${r.lokal?.pausenText ?? "-"}`),
    run: async () => {
      const sup = deps.get();
      if (!sup) return { error: "Mithelfen noch nicht initialisiert." };
      const s = sup.status();
      const queue = await deps.queueStatus();
      return { lokal: { ...s, pausenText: s.pausenGrund ? GRUND_TEXT[s.pausenGrund] : null }, queue };
    },
  });
  const config = defineTool({
    name: "register_delta_config",
    summary: "Stammdaten mitpflegen ein-/ausschalten, Akku schonen oder den Worker-Modus setzen (mit Bestaetigung).",
    category: "stammdaten mithelfen einstellung register worker netzbetrieb akku worker-modus nur handelsregister",
    description:
      "Liest oder aendert die Einstellung: aktiv = dieser Rechner arbeitet Register-Jobs der Organisation ab (Handelsregister-Abfragen mit der " +
      "eigenen IP, hoechstens 60 je Stunde, Chrome im Hintergrund), nurNetzbetrieb = auf Akku pausieren, nurRegister = Worker-Modus: AVA " +
      "verarbeitet dann ausschliesslich Handelsregister-Jobs, alles andere (Herzschlag, Vorgaenge, Producer, Ablaeufe, Mail, Radar) ruht. " +
      "Ohne Argumente: aktuelle Werte. Schaltet die Organisation die Funktion ab, gilt das vorrangig.",
    parameters: { type: "object", properties: { aktiv: { type: "boolean" }, nurNetzbetrieb: { type: "boolean" }, nurRegister: { type: "boolean" } } },
    schema: yup.object({ aktiv: yup.boolean().optional(), nurNetzbetrieb: yup.boolean().optional(), nurRegister: yup.boolean().optional() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.geaendert ? "Mithelfen-Einstellung geaendert" : "Mithelfen-Einstellung gelesen"),
    run: async (args, c) => {
      const sup = deps.get();
      if (!sup) return { error: "Mithelfen noch nicht initialisiert." };
      if (args.aktiv === undefined && args.nurNetzbetrieb === undefined && args.nurRegister === undefined) return { geaendert: false, ...sup.status() };
      const teile: string[] = [];
      if (args.aktiv !== undefined) teile.push(`Mithelfen → ${args.aktiv ? "an" : "aus"}`);
      if (args.nurNetzbetrieb !== undefined) teile.push(`nur Netzbetrieb → ${args.nurNetzbetrieb ? "an" : "aus"}`);
      if (args.nurRegister !== undefined) teile.push(`Worker-Modus (nur Handelsregister, alles andere ruht) → ${args.nurRegister ? "an" : "aus"}`);
      const value = await c.ui.confirmAction(
        { kind: "additive", prompt: `Stammdaten mitpflegen ändern: ${teile.join(", ")}?`, confirmValue: "ja", options: [{ value: "ja", label: "Ändern" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { geaendert: false, abgebrochen: true };
      const next = sup.setSettings({
        ...(args.aktiv !== undefined ? { aktiv: args.aktiv } : {}),
        ...(args.nurNetzbetrieb !== undefined ? { nurNetzbetrieb: args.nurNetzbetrieb } : {}),
        ...(args.nurRegister !== undefined ? { nurRegister: args.nurRegister } : {}),
      });
      // Der Worker-Modus haelt die uebrigen Hintergrunddienste an oder laesst
      // sie wieder anlaufen; ohne diesen Schritt bliebe nur der Schalter gesetzt.
      if (args.nurRegister !== undefined) await workerModus.setzen(args.nurRegister === true);
      return { geaendert: true, ...sup.status(), ...(args.nurRegister !== undefined ? { ruhendeDienste: args.nurRegister ? workerModus.angemeldet() : [] } : {}) };
    },
  });
  return [status, config];
}
