// IPC-Handler „Sprachaufnahme und Mikrofon“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { app, ipcMain, shell, systemPreferences } from "electron";
import type { WhisperSidecar } from "../voice/whisper-sidecar";

export interface StimmeIpcDeps {
  whisper: WhisperSidecar;
}

export function registerStimmeIpc(deps: StimmeIpcDeps): void {
  const { whisper } = deps;

  // Voice / whisper sidecar IPC (Phase 8.n1). The download path is
  // long-running but resolves only when the GGUF lands on disk; the
  // renderer drives a progress bar off the `voice:download:progress`
  // push that's already wired above.
  ipcMain.handle("voice:getStatus", () => whisper.getStatus());

  ipcMain.handle("voice:downloadModel", () => whisper.downloadModel());

  ipcMain.handle("voice:cancelDownload", () => whisper.cancelDownload());

  ipcMain.handle("voice:deleteModel", () => whisper.deleteModel());

  // 8.n1 stub — renderer can already roundtrip but the body is a
  // placeholder string; 8.n2 swaps in the real whisper.cpp invocation.
  ipcMain.handle("voice:installBinary", async () => {
    await whisper.installBinary();
  });

  ipcMain.handle("voice:transcribe", async (_e, audio: Uint8Array) => {
    const u8 =
      audio instanceof Uint8Array
        ? audio
        : new Uint8Array(audio as ArrayBufferLike);
    return whisper.transcribe(u8);
  });

  // Microphone permission flow (Phase 8.n2 follow-up).
  // - macOS gates the mic at the OS level via TCC. The renderer
  //   queries the status BEFORE getUserMedia so it can show the
  //   right next step (request prompt vs. open System Settings).
  // - Windows / Linux don't expose an electron-queryable equivalent;
  //   we report `unsupported` and rely on getUserMedia errors at use
  //   time to drive the UI.
  ipcMain.handle("voice:micPermission", () => {
    // Dev mode runs the prebuilt `node_modules/electron/dist/Electron.app`
    // binary; macOS attaches mic permissions to the bundle's
    // CFBundleName, which for that binary is "Electron". In a packaged
    // build the bundle is "AVA". Surface this to the renderer
    // so the error message can tell the user where to LOOK in System
    // Settings.
    const isPackaged = app.isPackaged;
    const appNameInSettings = isPackaged ? app.getName() : "Electron";
    if (process.platform === "darwin") {
      return {
        status: systemPreferences.getMediaAccessStatus("microphone"),
        appNameInSettings,
        isDev: !isPackaged,
      };
    }
    return {
      status: "unsupported" as const,
      appNameInSettings,
      isDev: !isPackaged,
    };
  });

  ipcMain.handle("voice:requestMicPermission", async () => {
    if (process.platform === "darwin") {
      // Pops the system prompt the FIRST time it's called per-app;
      // subsequent calls return the user's prior decision. Returns
      // false when the user previously denied — that's the cue to
      // show the "open System Settings" affordance instead.
      return await systemPreferences.askForMediaAccess("microphone");
    }
    return true;
  });

  ipcMain.handle("voice:openMicSettings", async () => {
    // Deep-links into the OS privacy panel where the user can flip
    // the per-app toggle. macOS uses the x-apple.systempreferences
    // URL scheme; Windows uses the ms-settings: scheme.
    if (process.platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      );
    } else if (process.platform === "win32") {
      await shell.openExternal("ms-settings:privacy-microphone");
    } else {
      // Linux distros vary; punt to the generic privacy page where
      // it's available via the desktop session manager.
      await shell.openExternal("https://help.ubuntu.com/stable/ubuntu-help/privacy.html");
    }
  });
}
