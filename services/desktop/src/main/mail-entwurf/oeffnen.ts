// Mail-Entwurf im Mail-Programm des Nutzers öffnen (docs/PLAN_MAIL_ENTWURF.md E2).
// Automatisch: Outlook bekommt eine .eml (Entwurf mit Anhängen), andere Programme
// einen mailto:-Link, ohne Programm bietet der Renderer Webmail an.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { app, shell } from "electron";
import { paths } from "../../core/platform";
import { autoWeg, emlDateiname, mailtoUrl, programmIstOutlook, webmailUrl, type MailEntwurf, type MailEntwurfZiel } from "../../shared/mail-entwurf";
import { anhaengeLaden, emlBauen, entwurfInsPostfach, type AnhangQuellen } from "./eml";
import { mailEntwurfZiel } from "./einstellung";
import { postfachStand } from "./postfach";

export interface MailProgramm {
  name: string;
  pfad: string | null;
}

export type OeffnenWeg = "eml" | "mailto" | "postfach" | "gmail" | "outlook-web" | "outlook-live";

export interface OeffnenErgebnis {
  /** Was tatsächlich geöffnet wurde; "keins" = kein Mail-Programm, der Renderer bietet Webmail an. */
  weg: OeffnenWeg | "keins";
  programm: string | null;
  /** mailto:/Webmail tragen keine Anhänge; der Renderer bietet dann die .eml oder den Ordner an. */
  anhaengeFehlen: boolean;
  /** Bei „postfach“: Ordner, in dem der Entwurf liegt. */
  ordner?: string;
  fehler?: string;
}

/** Standardprogramm für mailto: (macOS, Windows; unter Linux nur der Name). */
export async function mailProgramm(): Promise<MailProgramm | null> {
  let name = "";
  try {
    name = app.getApplicationNameForProtocol("mailto:").trim();
  } catch {
    name = "";
  }
  if (!name) return null;
  let pfad: string | null = null;
  try {
    pfad = (await app.getApplicationInfoForProtocol("mailto:")).path || null;
  } catch {
    pfad = null;
  }
  return { name: name.replace(/\.app$/i, ""), pfad };
}

/** Was der Knopf bei „automatisch“ tut (shared autoWeg); `hatAnhaenge` je Entwurf. */
export async function empfohlenerWeg(ziel: MailEntwurfZiel = mailEntwurfZiel(), hatAnhaenge = false): Promise<{ weg: OeffnenWeg | "keins"; programm: string | null }> {
  if (ziel !== "auto" && ziel !== "programm") return { weg: ziel, programm: null };
  const p = await mailProgramm();
  if (ziel === "programm") return p ? { weg: "mailto", programm: p.name } : { weg: "keins", programm: null };
  return { weg: autoWeg(p?.name ?? null, postfachStand().eingerichtet, hatAnhaenge), programm: p?.name ?? null };
}

const ordner = () => join(paths().get("userData"), "mail-entwuerfe");

/** Alte Entwurfsdateien (älter als ein Tag) wegräumen. */
function aufraeumen(dir: string): void {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (Date.now() - statSync(p).mtimeMs > 24 * 3600_000) rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* egal */
  }
}

function neuerOrdner(): string {
  const basis = ordner();
  mkdirSync(basis, { recursive: true });
  aufraeumen(basis);
  const dir = join(basis, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** .eml öffnen: bei Outlook ausdrücklich mit Outlook, sonst mit dem Programm für .eml-Dateien. */
async function emlOeffnen(datei: string, programm: MailProgramm | null): Promise<void> {
  const outlook = programm && programmIstOutlook(programm.name) ? programm : null;
  if (outlook?.pfad && process.platform === "darwin") {
    spawn("open", ["-a", outlook.pfad, datei], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (outlook?.pfad && process.platform === "win32" && /outlook\.exe$/i.test(outlook.pfad)) {
    spawn(outlook.pfad, ["/eml", datei], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  const fehler = await shell.openPath(datei);
  if (fehler) throw new Error(fehler);
}

export async function mailEntwurfOeffnen(
  e: MailEntwurf,
  weg: MailEntwurfZiel | undefined,
  deps: { quellen: AnhangQuellen; conversationId?: string },
): Promise<OeffnenErgebnis> {
  const programm = await mailProgramm();
  const ziel = weg ?? mailEntwurfZiel();
  const hatAnhaenge = e.anhaenge.length > 0;
  const gewaehlt = ziel === "auto" || ziel === "programm" ? (await empfohlenerWeg(ziel, hatAnhaenge)).weg : ziel;
  try {
    if (gewaehlt === "keins") return { weg: "keins", programm: null, anhaengeFehlen: hatAnhaenge };
    if (gewaehlt === "postfach") {
      const r = await entwurfInsPostfach(e, deps.quellen, deps.conversationId);
      return { weg: "postfach", programm: programm?.name ?? null, anhaengeFehlen: false, ordner: r.ordner };
    }
    if (gewaehlt === "eml") {
      const r = anhaengeLaden(deps.quellen, e, deps.conversationId);
      if ("fehler" in r) return { weg: "eml", programm: programm?.name ?? null, anhaengeFehlen: hatAnhaenge, fehler: r.fehler };
      const datei = join(neuerOrdner(), emlDateiname(e));
      writeFileSync(datei, await emlBauen(e, r.anhaenge));
      await emlOeffnen(datei, programm);
      return { weg: "eml", programm: programm?.name ?? null, anhaengeFehlen: false };
    }
    if (gewaehlt === "mailto") {
      await shell.openExternal(mailtoUrl(e));
      return { weg: "mailto", programm: programm?.name ?? null, anhaengeFehlen: hatAnhaenge };
    }
    await shell.openExternal(webmailUrl(e, gewaehlt));
    return { weg: gewaehlt, programm: null, anhaengeFehlen: hatAnhaenge };
  } catch (err) {
    return { weg: gewaehlt, programm: programm?.name ?? null, anhaengeFehlen: hatAnhaenge, fehler: err instanceof Error ? err.message : String(err) };
  }
}

/** Anhänge in einen Ordner legen und zeigen, damit der Nutzer sie in die Mail zieht. */
export function anhaengeZeigen(e: MailEntwurf, deps: { quellen: AnhangQuellen; conversationId?: string }): { ok: true; anzahl: number } | { ok: false; fehler: string } {
  const r = anhaengeLaden(deps.quellen, e, deps.conversationId);
  if ("fehler" in r) return { ok: false, fehler: r.fehler };
  if (r.anhaenge.length === 0) return { ok: false, fehler: "Der Entwurf hat keine Anhänge." };
  const dir = neuerOrdner();
  let erste = "";
  for (const a of r.anhaenge) {
    const p = join(dir, basename(a.filename));
    writeFileSync(p, a.content);
    erste ||= p;
  }
  shell.showItemInFolder(erste);
  return { ok: true, anzahl: r.anhaenge.length };
}
