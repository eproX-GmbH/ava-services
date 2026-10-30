// IPC „Website-Themen“ (docs/PLAN_THEMEN.md, T1): Liste, Speichern, Loeschen,
// Begriffe ergaenzen. Die Einstellungs-Oberflaeche haengt daran.

import { ipcMain } from "electron";
import type { LlmProviderManager } from "../agent/providers";
import { begriffeVorschlagen } from "../themen/begriffe";
import type { ThemenStore } from "../themen/store";
import type { ThemaEingabe } from "../../shared/themen-types";

export interface ThemenIpcDeps {
  themen: { readonly current: ThemenStore | null };
  providers: LlmProviderManager;
}

export function registerThemenIpc(deps: ThemenIpcDeps): void {
  const store = () => {
    const s = deps.themen.current;
    if (!s) throw new Error("Themen noch nicht initialisiert.");
    return s;
  };
  ipcMain.handle("themen:list", () => store().list());
  ipcMain.handle("themen:save", (_e, eingabe: ThemaEingabe) => store().speichern(eingabe));
  ipcMain.handle("themen:remove", (_e, id: string) => store().loeschen(String(id)));
  ipcMain.handle("themen:begriffe", async (_e, id: string) => {
    const t = store().get(String(id));
    if (!t) throw new Error("Thema nicht gefunden.");
    const neu = await begriffeVorschlagen(deps.providers, t);
    return store().begriffeErgaenzen(t.id, [...t.begriffe.filter((b) => b.quelle === "ava").map((b) => b.text), ...neu]);
  });
}
