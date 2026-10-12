// Aufraeumer fuer verwaiste Browser im Worker (Befund 2026-10-12 auf
// ava-register-worker: vier Chromium-Prozesse liefen 6,5 Tage ohne lebenden
// Besitzer weiter, belegten den Speicher der 1-GB-Maschine, und jeder neue
// Browserstart scheiterte mit "DevToolsActivePort file doesn't exist").
//
// Die Desktop-App hat dafuer einen Wachhund (services/desktop/src/main/
// browser-sweep.ts); der Fly-Worker hatte keinen. Dies ist die auf Linux/macOS
// eingedampfte Fassung mit derselben Auswahlregel:
//
//   1. Browser mit `--ava-browser`, deren `--ava-owner=<pid>` nicht mehr lebt.
//   2. chromedriver ohne lebenden Elternprozess.
//   3. Kinder der gewaehlten Prozesse (Chrome-Helfer).
//
// Dazu kommen die Profilverzeichnisse `/tmp/ava-chrome-*`, die kein lebender
// Prozess mehr nennt. Laeuft beim Start und danach periodisch.

import { execFile } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AVA_PROFIL_PRAEFIX } from "./browser-lebenszyklus";

const execFileP = promisify(execFile);

export type Prozess = { pid: number; ppid: number; args: string };

const OWNER = /--ava-owner=(\d+)/;
const AVA_BROWSER = /(^|\s)--ava-browser(\s|=|$)/;
const CHROMEDRIVER = /(^|[\\/\s])chromedriver(\s|$)/i;
const CHROME = /(chrome|chromium)/i;

/** Reine Auswahl, testbar: welche Prozesse sind verwaiste AVA-Browser? */
export function waehleVerwaiste(prozesse: Prozess[], eigenePid: number): number[] {
  const lebend = new Set(prozesse.map((p) => p.pid));
  const elternLebt = (p: Prozess) => p.ppid > 1 && lebend.has(p.ppid);
  const wurzeln = new Set<number>();
  for (const p of prozesse) {
    if (p.pid === eigenePid) continue;
    if (AVA_BROWSER.test(p.args)) {
      const m = OWNER.exec(p.args);
      const owner = m ? Number(m[1]) : 0;
      if (!owner || !lebend.has(owner)) wurzeln.add(p.pid);
      continue;
    }
    const m = OWNER.exec(p.args);
    if (m && CHROME.test(p.args)) {
      if (!lebend.has(Number(m[1]))) wurzeln.add(p.pid);
      continue;
    }
    if (CHROMEDRIVER.test(p.args) && !elternLebt(p)) {
      wurzeln.add(p.pid);
      continue;
    }
    // Crashpad-Handler haengen sich an PID 1 und ueberleben ihren Browser.
    if (/chrome_crashpad_handler/.test(p.args) && !elternLebt(p)) wurzeln.add(p.pid);
  }
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

/** Profilverzeichnisse, die kein lebender Prozess mehr nennt und aelter als `mindestAlterMs` sind. */
export function waehleVerwaisteProfile(
  eintraege: Array<{ pfad: string; alterMs: number }>,
  prozesse: Prozess[],
  mindestAlterMs: number,
): string[] {
  const genannt = prozesse.map((p) => p.args).join("\n");
  return eintraege.filter((e) => e.alterMs >= mindestAlterMs && !genannt.includes(e.pfad)).map((e) => e.pfad);
}

export async function listeProzesse(): Promise<Prozess[]> {
  const { stdout } = await execFileP("ps", ["-Ao", "pid=,ppid=,args="], { maxBuffer: 32 * 1024 * 1024 });
  const out: Prozess[] = [];
  for (const zeile of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(zeile);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? "" });
  }
  return out;
}

function listeProfile(): Array<{ pfad: string; alterMs: number }> {
  const basis = tmpdir();
  const jetzt = Date.now();
  const out: Array<{ pfad: string; alterMs: number }> = [];
  let namen: string[];
  try {
    namen = readdirSync(basis);
  } catch {
    return out;
  }
  for (const n of namen) {
    if (!n.startsWith(AVA_PROFIL_PRAEFIX)) continue;
    const pfad = join(basis, n);
    try {
      out.push({ pfad, alterMs: jetzt - statSync(pfad).mtimeMs });
    } catch {
      /* zwischenzeitlich weg */
    }
  }
  return out;
}

/**
 * Verwaiste Browser beenden und alte Profile loeschen. Fehler bleiben im
 * Protokoll; der Worker laeuft weiter.
 */
export async function raeumeWaisen(log: (zeile: string) => void, opts: { profilMindestAlterMs?: number } = {}): Promise<{ prozesse: number; profile: number }> {
  if (process.platform === "win32") return { prozesse: 0, profile: 0 };
  let prozesse: Prozess[];
  try {
    prozesse = await listeProzesse();
  } catch (err) {
    log(`[waisen] Prozessliste fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    return { prozesse: 0, profile: 0 };
  }
  const pids = waehleVerwaiste(prozesse, process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* schon weg */
    }
  }
  // Profile erst nach dem Beenden pruefen; ein eben beendeter Browser nennt
  // sein Profil nicht mehr. Mindestalter schuetzt ein Profil, das gerade
  // angelegt wird, aber noch keinen Prozess hat.
  const profile = waehleVerwaisteProfile(listeProfile(), pids.length ? await listeProzesse().catch(() => prozesse) : prozesse, opts.profilMindestAlterMs ?? 30 * 60_000);
  for (const pfad of profile) {
    try {
      rmSync(pfad, { recursive: true, force: true });
    } catch {
      /* Komfort, kein Muss */
    }
  }
  if (pids.length || profile.length) log(`[waisen] ${pids.length} verwaiste Browserprozesse beendet, ${profile.length} alte Profile entfernt`);
  return { prozesse: pids.length, profile: profile.length };
}

/** Beim Start einmal, danach alle `intervallMs`. Der Zeiger haelt den Prozess nicht am Leben. */
export function starteWaisenWache(log: (zeile: string) => void, intervallMs = 30 * 60_000): () => void {
  void raeumeWaisen(log);
  const t = setInterval(() => void raeumeWaisen(log), intervallMs);
  t.unref?.();
  return () => clearInterval(t);
}
