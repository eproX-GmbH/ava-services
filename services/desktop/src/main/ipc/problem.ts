// docs/PLAN_PROBLEM_MELDEN.md M2 — IPC fuer „Problem melden“: Vorschau des
// Snapshot-Inhalts, Melden (Gateway oder Mail), eigene Meldungen, Antworten,
// gelesen, Dateien nachreichen, Zaehler ungelesener Antworten.
import { ipcMain } from "electron";
import { problemMelden, type MeldungEingabe, type MeldungErgebnis } from "../problem/melden";
import { snapshotInhaltBeschreibung, type SnapshotDeps } from "../problem/snapshot";
import type { ProblemAbholer } from "../problem/abholen";

interface Gateway { request<T>(path: string, init?: Record<string, unknown>): Promise<T> }

export function registerProblemIpc(deps: SnapshotDeps & { gateway: Gateway; abholer: ProblemAbholer }): void {
  ipcMain.handle("problem:inhalt", () => snapshotInhaltBeschreibung());
  ipcMain.handle("problem:melden", async (_e, eingabe: MeldungEingabe): Promise<MeldungErgebnis> => {
    const r = await problemMelden(deps, eingabe);
    void deps.abholer.pruefen();
    return r;
  });
  ipcMain.handle("problem:meine", () => deps.gateway.request("/v1/meldungen/meine"));
  ipcMain.handle("problem:lesen", (_e, id: string) => deps.gateway.request(`/v1/meldungen/${encodeURIComponent(String(id))}`));
  ipcMain.handle("problem:antworten", async (_e, input: { id: string; text: string }) => {
    const r = await deps.gateway.request(`/v1/meldungen/${encodeURIComponent(String(input.id))}/nachrichten`, { method: "POST", body: { text: String(input.text) } });
    return r;
  });
  ipcMain.handle("problem:gelesen", async (_e, id: string) => {
    await deps.gateway.request(`/v1/meldungen/${encodeURIComponent(String(id))}/gelesen`, { method: "PUT" });
    return deps.abholer.pruefen();
  });
  ipcMain.handle("problem:nachreichen", async (_e, input: { id: string; dateien: Array<{ name: string; mime: string; base64: string }> }) => {
    const fd = new FormData();
    for (const d of input.dateien.slice(0, 3)) fd.append("datei", new Blob([new Uint8Array(Buffer.from(d.base64, "base64"))], { type: d.mime || "application/octet-stream" }), d.name.slice(0, 120));
    return deps.gateway.request(`/v1/meldungen/${encodeURIComponent(String(input.id))}/anhaenge`, { method: "POST", multipart: fd });
  });
  ipcMain.handle("problem:ungelesen", () => deps.abholer.pruefen());
}
