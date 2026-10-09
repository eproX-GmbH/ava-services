// IPC-Handler „Vorschläge und Hintergrundaufgaben“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import type { ToolRegistry } from "../agent/tool-registry";
import { featureEnabled } from "../org-policy";
import { faehigkeitenText, nichtZugeordnet, verfuegbareFaehigkeiten } from "../suggestions/faehigkeiten";
import { workerModus } from "../worker-modus";
import type { HintergrundAufgaben } from "../aufgaben/aufgaben";
import type { ChipErzeugung } from "../suggestions/erzeugung";
import type { NutzerstandService } from "../suggestions/nutzerstand";
import type { VorschlaegeSettingsStore } from "../suggestions/settings";

export interface VorschlaegeIpcDeps {
  agentRegistry: ToolRegistry;
  chipErzeugung: { readonly current: ChipErzeugung | null };
  hintergrundAufgaben: HintergrundAufgaben;
  nutzerstand: { readonly current: NutzerstandService | null };
  vorschlaegeSettings: { readonly current: VorschlaegeSettingsStore | null };
}

export function registerVorschlaegeIpc(deps: VorschlaegeIpcDeps): void {
  const { agentRegistry, chipErzeugung, hintergrundAufgaben, nutzerstand, vorschlaegeSettings } = deps;

ipcMain.handle("aufgaben:liste", (_e, conversationId?: string) => hintergrundAufgaben.alle(conversationId));

ipcMain.handle("aufgaben:abbrechen", (_e, id: string) => hintergrundAufgaben.abbrechen(String(id)));

  ipcMain.handle("suggestions:nutzerstand", (_e, opts: { frisch?: boolean } | undefined) => nutzerstand.current!.get({ frisch: opts?.frisch === true }));

  ipcMain.handle("suggestions:startseite", (_e, opts: { frisch?: boolean } | undefined) =>
    // Im Worker-Modus ohne Modell: Die Startseite wuerde sonst bei jedem Oeffnen
    // Chips per KI erzeugen — genau die Kosten, die der Modus ausschliessen soll.
    chipErzeugung.current!.startseite({
      frisch: opts?.frisch === true,
      ohneModell: !featureEnabled("vorschlaege") || !vorschlaegeSettings.current!.get().startseite || workerModus.aktiv(),
    }),
  );

  ipcMain.handle("suggestions:getSettings", () => ({ ...vorschlaegeSettings.current!.get(), orgErlaubt: featureEnabled("vorschlaege") }));

  ipcMain.handle("suggestions:setSettings", (_e, patch: { startseite?: boolean; gespraech?: boolean }) => {
    const next = vorschlaegeSettings.current!.set({
      ...(patch?.startseite !== undefined ? { startseite: patch.startseite === true } : {}),
      ...(patch?.gespraech !== undefined ? { gespraech: patch.gespraech === true } : {}),
    });
    return { ...next, orgErlaubt: featureEnabled("vorschlaege") };
  });

  ipcMain.handle("suggestions:faehigkeiten", async () => {
    const st = await nutzerstand.current!.get();
    const namen = agentRegistry.list().map((t) => t.name);
    return { gruppen: verfuegbareFaehigkeiten(namen, st.gesperrteModule), text: faehigkeitenText(verfuegbareFaehigkeiten(namen, st.gesperrteModule)), nichtZugeordnet: nichtZugeordnet(namen) };
  });
}
