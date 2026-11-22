// Staging/UAT (docs/PLAN_STAGING.md ST5): Kanal des angemeldeten Kontos vom Gateway holen,
// in der Kopfzeile anzeigen und den Update-Feed umstellen (staging: Kandidat über das Gateway,
// prod: GitHub „latest“ wie bisher). Ein Kontowechsel startet die App neu, daher genügt eine
// Prüfung nach dem Start und danach alle fünf Minuten.
import { BrowserWindow, ipcMain } from "electron";

export interface KanalStand {
  kanal: "prod" | "staging";
  gateway: "prod" | "staging";
  testZahlung: boolean;
  version: { prod: string | null; staging: string | null };
}
interface Gateway { request<T>(path: string, init?: { signal?: AbortSignal }): Promise<T> }

let stand: KanalStand | null = null;
export const kanalStand = (): KanalStand | null => stand;

export function startKanalWaechter(deps: { gateway: Gateway; isSignedIn: () => boolean; beiWechsel: (k: KanalStand) => void }): () => void {
  ipcMain.handle("kanal:get", () => stand);
  const pruefen = async (): Promise<void> => {
    if (!deps.isSignedIn()) return;
    let neu: KanalStand;
    try {
      neu = await deps.gateway.request<KanalStand>("/v1/kanal");
    } catch {
      return; // altes Gateway ohne /v1/kanal oder offline: Stand bleibt
    }
    if (JSON.stringify(neu) === JSON.stringify(stand)) return;
    const kanalWechsel = neu.kanal !== stand?.kanal;
    stand = neu;
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("kanal:changed", neu);
    if (kanalWechsel) deps.beiWechsel(neu);
  };
  void pruefen();
  const t = setInterval(() => void pruefen(), 5 * 60_000);
  t.unref?.();
  return () => clearInterval(t);
}
