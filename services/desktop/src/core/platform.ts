// Plattform-Schicht (docs/PLAN_AVA_CLOUD.md §12, Schritt R1).
//
// Alles, was AVA von ihrer Hülle braucht, läuft über diese Schnittstellen:
// Pfade, Geheimnis-Ablage, Benachrichtigungen, Öffnen von Links und Dateien,
// Prozess-Start, Fenster-Broadcast, Strom und Lebenszyklus. Die Electron-App
// liefert eine Umsetzung über die Electron-APIs (src/main/platform-electron.ts),
// der headless Server eine über Node allein (src/core/platform-node.ts).
//
// Regel ab R1: Unter src/core/ wird `electron` nicht importiert. Module unter
// src/main/, die noch Electron brauchen, stehen in der Ausnahmeliste von
// scripts/check-electron-imports.mjs, mit Grund und Schritt, der sie ablöst.
//
// Die Umsetzung wird einmal beim Start gesetzt (setPlatform). Wird vorher
// zugegriffen, gilt die Node-Umsetzung: So laufen Test-Skripte und der Server
// ohne weiteres Zutun, und die Electron-App setzt ihre Fassung als allererstes
// (erster Import in src/main/index.ts).

import { createNodePlatform } from "./platform-node";

/** Pfadarten, die heute über `app.getPath` gelesen werden. */
export type PathName = "userData" | "logs" | "home" | "downloads" | "exe" | "temp";

export interface Paths {
  /** Verzeichnis je Art; `userData` ist der Konto-Space, in dem alle Stores liegen. */
  get(name: PathName): string;
  /** Paketierte Auslieferung (Electron: app.isPackaged; Server: Ressourcenverzeichnis gesetzt). */
  readonly isPackaged: boolean;
  /** Versionsnummer der laufenden AVA. */
  version(): string;
  /** Wurzel der App-Dateien (Electron: app.getAppPath(); Server: Arbeitsverzeichnis). */
  appPath(): string;
  /** Verzeichnis der gebündelten Ressourcen (Producer, Ollama, Whisper, Skills); null, wenn es keines gibt. */
  resources(): string | null;
  /** Sprache der Umgebung, z. B. "de-DE". */
  locale(): string;
}

/** Ersatz für Electrons safeStorage: verschlüsselte Ablage kleiner Geheimnisse. */
export interface CredentialStore {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(data: Buffer): string;
}

export interface NotificationRequest {
  title: string;
  body: string;
  silent?: boolean;
  /** Dringend: darf Fokus-Modi durchbrechen (macOS "critical"). */
  urgent?: boolean;
  onClick?: () => void;
}

export interface Notifier {
  isSupported(): boolean;
  /** Zeigt eine Benachrichtigung; true, wenn sie tatsächlich angezeigt wurde. */
  show(req: NotificationRequest): boolean;
}

/** Ersatz für Electrons shell. */
export interface Opener {
  openExternal(url: string): Promise<void>;
  /** Liefert wie Electron einen leeren String bei Erfolg, sonst die Fehlermeldung. */
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

export interface NodeCommand {
  /** Ausführbare Datei, die ein Node-Skript ausführt. */
  command: string;
  /** Zusätzliche Umgebungsvariablen, die dafür nötig sind (Electron: ELECTRON_RUN_AS_NODE). */
  env: Record<string, string>;
}

export interface ProcessSpawner {
  /** Wie dieser Prozess ein weiteres Node-Skript startet (Producer, Wachhund, Register-Delta). */
  nodeCommand(): NodeCommand;
}

/** Brücke zu den Fenstern; im Server gibt es keine, alle Aufrufe sind dann wirkungslos. */
export interface WindowBridge {
  hasWindows(): boolean;
  isAnyFocused(): boolean;
  /** Sendet eine Nachricht an alle Fenster (Renderer-Kanal). */
  broadcast(channel: string, ...args: unknown[]): void;
  /** Holt die App und ihr Hauptfenster nach vorn. */
  focusMain(): void;
}

export type PowerEvent = "on-battery" | "on-ac" | "suspend" | "resume";

export interface Power {
  isOnBatteryPower(): boolean;
  on(event: PowerEvent, handler: () => void): void;
}

export interface Lifecycle {
  /** Startet AVA neu (Electron: relaunch + exit; Server: Prozess endet, der Container startet neu). */
  relaunch(): void;
  exit(code: number): void;
  /** Vor dem Beenden; Electron: before-quit. */
  onBeforeQuit(handler: () => void): void;
}

export interface Platform {
  readonly kind: "electron" | "node";
  readonly paths: Paths;
  readonly credentials: CredentialStore;
  readonly notifier: Notifier;
  readonly opener: Opener;
  readonly spawner: ProcessSpawner;
  readonly windows: WindowBridge;
  readonly power: Power;
  readonly lifecycle: Lifecycle;
}

let aktiv: Platform | null = null;

/** Einmal beim Start setzen; ein zweiter Aufruf mit anderer Art ist ein Programmierfehler. */
export function setPlatform(p: Platform): void {
  if (aktiv && aktiv.kind !== p.kind) {
    throw new Error(`Plattform bereits als ${aktiv.kind} gesetzt, ${p.kind} abgelehnt`);
  }
  aktiv = p;
}

export function platform(): Platform {
  if (!aktiv) aktiv = createNodePlatform();
  return aktiv;
}

// Kurzformen für die häufigen Zugriffe.
export const paths = (): Paths => platform().paths;
export const credentials = (): CredentialStore => platform().credentials;
export const notifier = (): Notifier => platform().notifier;
export const opener = (): Opener => platform().opener;
export const spawner = (): ProcessSpawner => platform().spawner;
export const windows = (): WindowBridge => platform().windows;
export const power = (): Power => platform().power;
export const lifecycle = (): Lifecycle => platform().lifecycle;
