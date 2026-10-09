// Ersatz für `electron-updater` im Server-Bündel: dort aktualisiert `docker pull`.
// Der Updater aus src/main/updater.ts wird zwar gebaut, aber nie gestartet; die
// Attrappe sorgt nur dafür, dass Konstruktion und stop() nicht scheitern.

import { EventEmitter } from "node:events";

export const autoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  logger: null as unknown,
  checkForUpdates: async () => null,
  downloadUpdate: async () => [] as string[],
  quitAndInstall: () => {},
});

export type UpdateInfo = { version: string; releaseDate?: string; releaseNotes?: unknown };
export type ProgressInfo = { percent: number; transferred: number; total: number; bytesPerSecond: number };
