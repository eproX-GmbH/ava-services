// IPC-Handler „Register-Delta (Mithelfen)“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { BrowserWindow, ipcMain, webContents } from "electron";
import { workerModus } from "../worker-modus";
import type { MithelfenSupervisor } from "../register-delta/supervisor";

export interface StammdatenIpcDeps {
  mithelfen: { readonly current: MithelfenSupervisor | null };
  registerQueueStatus: () => Promise<Record<string, unknown> | null>;
  workerModusMerkerLoeschen: () => void;
  workerModusMerkerSetzen: () => void;
}

export function registerStammdatenIpc(deps: StammdatenIpcDeps): void {
  const { mithelfen, registerQueueStatus, workerModusMerkerLoeschen, workerModusMerkerSetzen } = deps;

  ipcMain.handle("registerDelta:status", () => mithelfen.current!.status());

  ipcMain.handle("registerDelta:setSettings", async (_e, patch: { aktiv?: boolean; nurNetzbetrieb?: boolean; nurRegister?: boolean }) => {
    const status = mithelfen.current!.setSettings({
      ...(patch?.aktiv !== undefined ? { aktiv: patch.aktiv === true } : {}),
      ...(patch?.nurNetzbetrieb !== undefined ? { nurNetzbetrieb: patch.nurNetzbetrieb === true } : {}),
      ...(patch?.nurRegister !== undefined ? { nurRegister: patch.nurRegister === true } : {}),
    });
    // Worker-Modus haelt die uebrigen Hintergrunddienste an oder laesst sie
    // wieder anlaufen; erst danach den neuen Stand melden. Wird Mithelfen
    // abgeschaltet, faellt der Worker-Modus mit weg (siehe setSettings).
    if (patch?.nurRegister !== undefined || patch?.aktiv === false) {
      // Merker wie beim Start: Stuerzt AVA beim Einschalten ab, startet sie
      // beim naechsten Mal ohne den Modus statt in einer Schleife zu haengen.
      if (status.nurRegister === true) workerModusMerkerSetzen();
      try {
        await workerModus.setzen(status.nurRegister === true);
      } finally {
        workerModusMerkerLoeschen();
      }
      const neu = mithelfen.current!.status();
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("register-delta:status:changed", neu);
      return neu;
    }
    return status;
  });

  ipcMain.handle("registerDelta:queue", () => registerQueueStatus());

  ipcMain.handle("registerDelta:verlauf", () => mithelfen.current!.verlauf());
}
