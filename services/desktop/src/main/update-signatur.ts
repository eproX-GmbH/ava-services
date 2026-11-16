// Signaturpruefung heruntergeladener Windows-Updates.
//
// electron-updater prueft jedes heruntergeladene AVA-Setup.exe mit
// PowerShell `Get-AuthenticodeSignature`, gibt dem Aufruf aber nur 20
// Sekunden. Das Setup ist rund 1,8 GB gross; Get-AuthenticodeSignature
// hasht die ganze Datei, und der Virenscanner prueft sie beim Oeffnen
// zusaetzlich. Auf langsameren oder verwalteten Rechnern dauert das
// laenger als 20 s, der Prozess wird abgeschossen und electron-updater
// meldet "Command failed: ... Get-AuthenticodeSignature ..." — der
// Nutzer sah "Signatur stimmt nicht", obwohl die Signatur nie geprueft
// wurde (Befund Joyce 2026-11-16, v0.1.965 -> v0.1.970).
//
// Diese Pruefung ersetzt die eingebaute (NsisUpdater.verifyUpdateCodeSignature):
//   - grosszuegige Frist (5 Min) und ein zweiter Versuch,
//   - PowerShell direkt ohne cmd.exe-Umweg, Dateipfad ueber eine
//     Umgebungsvariable statt im Befehl (keine Quoting-Fallen),
//   - nur die benoetigten Felder als JSON,
//   - bleibt streng: Kann nicht geprueft werden, wird NICHT installiert.
//
// Rueckgabe wie von electron-updater erwartet: null = gueltig signiert,
// sonst ein Text, warum nicht (electron-updater wirft dann
// ERR_UPDATER_INVALID_SIGNATURE und loescht die Datei).

import { execFile } from "node:child_process";
import { join, normalize } from "node:path";

const FRIST_MS = 5 * 60 * 1000;
const VERSUCHE = 2;

/** Kennung am Anfang der Rueckgabe, wenn PowerShell gar nicht geantwortet
 *  hat. Die Fehleranzeige (renderer/lib/updater-error.ts) unterscheidet
 *  damit "konnte nicht pruefen" von "falsch signiert". */
export const PRUEFUNG_NICHT_MOEGLICH = "Signaturpruefung nicht moeglich";

const SKRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$s = Get-AuthenticodeSignature -LiteralPath $env:AVA_UPDATE_DATEI",
  "$subject = $null",
  "if ($s.SignerCertificate) { $subject = $s.SignerCertificate.Subject }",
  "[pscustomobject]@{ Status = [int]$s.Status; StatusMessage = [string]$s.StatusMessage; Path = [string]$s.Path; Subject = $subject } | ConvertTo-Json -Compress",
].join("; ");

export interface SignaturErgebnis {
  Status?: unknown;
  StatusMessage?: unknown;
  Path?: unknown;
  Subject?: unknown;
}

/** Zerlegt einen Distinguished Name ("CN=eproX GmbH, O=eproX GmbH, C=DE")
 *  in Schluessel/Wert. Kommas in Anfuehrungszeichen bleiben erhalten. */
export function zerlegeDn(dn: string): Map<string, string> {
  const teile: string[] = [];
  let aktuell = "";
  let inAnfuehrung = false;
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i];
    if (c === "\\" && i + 1 < dn.length) {
      aktuell += dn[i + 1];
      i++;
      continue;
    }
    if (c === '"') {
      inAnfuehrung = !inAnfuehrung;
      continue;
    }
    if ((c === "," || c === "+") && !inAnfuehrung) {
      teile.push(aktuell);
      aktuell = "";
      continue;
    }
    aktuell += c;
  }
  teile.push(aktuell);
  const ergebnis = new Map<string, string>();
  for (const teil of teile) {
    const gleich = teil.indexOf("=");
    if (gleich <= 0) continue;
    const schluessel = teil.slice(0, gleich).trim().toUpperCase();
    const wert = teil.slice(gleich + 1).trim();
    if (schluessel) ergebnis.set(schluessel, wert);
  }
  return ergebnis;
}

/** Bewertet die PowerShell-Antwort. null = gueltig und vom richtigen
 *  Herausgeber, sonst Begruendung. Rein, damit sie testbar ist. */
export function bewerteSignatur(
  daten: SignaturErgebnis,
  herausgeber: string[],
  datei: string,
): string | null {
  const roh = JSON.stringify(daten);
  // 0 = SignatureStatus.Valid
  if (daten.Status !== 0) {
    return `Signatur ungueltig (Status ${String(daten.Status)}: ${String(daten.StatusMessage ?? "")}), raw: ${roh}`;
  }
  if (typeof daten.Path === "string" && daten.Path.length > 0) {
    if (normalize(daten.Path).toLowerCase() !== normalize(datei).toLowerCase()) {
      return `Signatur gehoert zu einer anderen Datei (${daten.Path}), raw: ${roh}`;
    }
  }
  if (typeof daten.Subject !== "string" || daten.Subject.length === 0) {
    return `Signatur ohne Zertifikat-Subject, raw: ${roh}`;
  }
  const subject = zerlegeDn(daten.Subject);
  for (const name of herausgeber) {
    const dn = zerlegeDn(name);
    if (dn.size > 0) {
      let alle = true;
      for (const [k, v] of dn) {
        if (subject.get(k) !== v) {
          alle = false;
          break;
        }
      }
      if (alle) return null;
    } else if (name === subject.get("CN")) {
      return null;
    }
  }
  return `Signiert von "${daten.Subject}", erwartet: ${herausgeber.join(" | ")}`;
}

function powershellPfad(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir;
  return root
    ? join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/** Umgebung fuer PowerShell: PSModulePath raus (sonst laedt Windows
 *  PowerShell 5.1 ggf. Module von PowerShell 7, electron-builder #7127),
 *  Dateipfad als eigene Variable. Windows-Umgebungsnamen sind
 *  gross/klein-unabhaengig, daher der Vergleich in Kleinbuchstaben. */
function umgebung(datei: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() === "psmodulepath") continue;
    env[k] = v;
  }
  env.AVA_UPDATE_DATEI = datei;
  return env;
}

function einmalPruefen(
  datei: string,
): Promise<{ ok: true; stdout: string } | { ok: false; grund: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    execFile(
      powershellPfad(),
      ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command", SKRIPT],
      {
        timeout: FRIST_MS,
        windowsHide: true,
        env: umgebung(datei),
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const dauer = Math.round((Date.now() - start) / 1000);
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          const grund = e.killed
            ? `PowerShell nach ${dauer} s abgebrochen (Frist ${FRIST_MS / 1000} s)`
            : `PowerShell-Fehler nach ${dauer} s: ${e.message}${stderr ? ` | ${String(stderr).trim()}` : ""}`;
          resolve({ ok: false, grund });
          return;
        }
        console.info(`[updater] Signaturpruefung: PowerShell fertig nach ${dauer} s`);
        resolve({ ok: true, stdout: String(stdout) });
      },
    );
  });
}

/** Ersatz fuer electron-updaters verifySignature (Windows). */
export async function pruefeUpdateSignatur(
  herausgeber: string[],
  datei: string,
): Promise<string | null> {
  console.info(`[updater] Signaturpruefung startet: ${datei} (erwartet: ${herausgeber.join(" | ")})`);
  let letzterGrund = "";
  for (let versuch = 1; versuch <= VERSUCHE; versuch++) {
    const r = await einmalPruefen(datei);
    if (!r.ok) {
      letzterGrund = r.grund;
      console.warn(`[updater] Signaturpruefung Versuch ${versuch}/${VERSUCHE}: ${r.grund}`);
      continue;
    }
    let daten: SignaturErgebnis;
    try {
      daten = JSON.parse(r.stdout.trim()) as SignaturErgebnis;
    } catch {
      letzterGrund = `PowerShell-Antwort nicht lesbar: ${r.stdout.slice(0, 300)}`;
      console.warn(`[updater] Signaturpruefung Versuch ${versuch}/${VERSUCHE}: ${letzterGrund}`);
      continue;
    }
    const urteil = bewerteSignatur(daten, herausgeber, datei);
    if (urteil === null) {
      console.info("[updater] Signaturpruefung: gueltig");
    } else {
      console.warn(`[updater] Signaturpruefung: abgelehnt — ${urteil}`);
    }
    return urteil;
  }
  return `${PRUEFUNG_NICHT_MOEGLICH}: ${letzterGrund}`;
}
