// Verwaiste Hintergrund-Browser beenden (2026-09-16).
//
// Befund: Auf dem Rechner des Betreibers lagen 110 chromedriver- und Headless-
// Chrome-Prozesse mit 2,7 GB RAM, teils sechs Tage alt, Elternprozess launchd.
// Ursache: Die Producer (structured-content, company-publication, website) und
// der Register-Delta-Worker starten Chrome ueber Selenium. Wird ein Producer
// per SIGKILL beendet (Stop-Timeout, Absturz, App-Ende), bleiben chromedriver
// und Chrome als Waisen stehen; das Betriebssystem raeumt Enkelprozesse nicht
// auf. Ausserdem hinterlassen Entwicklungslaeufe dieselben Waisen.
//
// Loesung: Jeder von AVA gestartete Chrome traegt den Schalter
// `--ava-owner=<pid des Producers>` (Chrome ignoriert unbekannte Schalter).
// Dieser Sweep laeuft beim Start, stuendlich und beim Beenden und beendet
//   1. Chrome-Prozesse mit `--ava-owner=<pid>`, deren Besitzer nicht mehr lebt
//      (beim Beenden: alle),
//   2. chromedriver-Prozesse ohne lebenden Elternprozess,
//   3. Headless-Chrome-Hauptprozesse ohne lebenden Elternprozess (Altbestand
//      ohne Marker),
// jeweils samt Kindprozessen. Fremde, sichtbare Chrome-Fenster des Nutzers
// sind nie betroffen: sie sind weder headless noch markiert noch verwaist.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface Prozess {
  pid: number;
  ppid: number;
  args: string;
}

const OWNER = /--ava-owner=(\d+)/;
const CHROMEDRIVER = /(^|[\\/\s])chromedriver(\.exe)?(\s|$)/i;
const CHROME = /(chrome|chromium)/i;

/** Reine Auswahl, testbar: welche Prozesse sind verwaiste AVA-Browser? */
export function waehleVerwaiste(prozesse: Prozess[], opts: { alle?: boolean; eigenePid?: number } = {}): number[] {
  const lebend = new Set(prozesse.map((p) => p.pid));
  const elternLebt = (p: Prozess) => p.ppid > 1 && lebend.has(p.ppid);
  const wurzeln = new Set<number>();
  for (const p of prozesse) {
    if (p.pid === opts.eigenePid) continue;
    const m = OWNER.exec(p.args);
    if (m && CHROME.test(p.args)) {
      const owner = Number(m[1]);
      if (opts.alle || !lebend.has(owner)) wurzeln.add(p.pid);
      continue;
    }
    if (CHROMEDRIVER.test(p.args) && !elternLebt(p)) {
      wurzeln.add(p.pid);
      continue;
    }
    // Altbestand ohne Marker: headless Chrome-Hauptprozess (kein --type=…) ohne lebenden Elternprozess.
    if (CHROME.test(p.args) && /--headless/.test(p.args) && !/--type=/.test(p.args) && !elternLebt(p)) wurzeln.add(p.pid);
  }
  // Kindprozesse der Wurzeln mitnehmen (Chrome-Helfer, Chrome unter chromedriver).
  const gewaehlt = new Set(wurzeln);
  let neu = true;
  while (neu) {
    neu = false;
    for (const p of prozesse) {
      if (!gewaehlt.has(p.pid) && gewaehlt.has(p.ppid)) {
        gewaehlt.add(p.pid);
        neu = true;
      }
    }
  }
  return [...gewaehlt];
}

export async function listeProzesse(): Promise<Prozess[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileP(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    const rows = JSON.parse(stdout || "[]") as Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>;
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, args: r.CommandLine ?? "" }));
  }
  const { stdout } = await execFileP("ps", ["-Ao", "pid=,ppid=,args="], { maxBuffer: 32 * 1024 * 1024 });
  const out: Prozess[] = [];
  for (const zeile of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(zeile);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? "" });
  }
  return out;
}

function beende(pids: number[]): void {
  if (pids.length === 0) return;
  if (process.platform === "win32") {
    const args = ["/F", "/T"];
    for (const pid of pids) args.push("/PID", String(pid));
    spawn("taskkill", args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => undefined);
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* schon weg */
    }
  }
}

/** Verwaiste AVA-Browser beenden; `alle` beim App-Ende (jeder markierte Chrome). Liefert die Anzahl. */
export async function beendeVerwaisteBrowser(opts: { alle?: boolean; log?: (zeile: string) => void } = {}): Promise<number> {
  let prozesse: Prozess[];
  try {
    prozesse = await listeProzesse();
  } catch (err) {
    opts.log?.(`[browser-sweep] Prozessliste fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  const pids = waehleVerwaiste(prozesse, { alle: opts.alle, eigenePid: process.pid });
  if (pids.length > 0) {
    beende(pids);
    opts.log?.(`[browser-sweep] ${pids.length} verwaiste Browser-Prozesse beendet${opts.alle ? " (App-Ende)" : ""}`);
  }
  return pids.length;
}
