// Wohin der Knopf „Im Mail-Programm öffnen“ Entwürfe schickt (docs/PLAN_MAIL_ENTWURF.md E3).
// <userData>/mail-entwurf.json; im Chat über settings_mail_entwurf änderbar.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../core/platform";
import { MAIL_ENTWURF_ZIELE, type MailEntwurfZiel } from "../../shared/mail-entwurf";

const datei = () => join(paths().get("userData"), "mail-entwurf.json");

export function mailEntwurfZiel(): MailEntwurfZiel {
  try {
    if (!existsSync(datei())) return "auto";
    const z = (JSON.parse(readFileSync(datei(), "utf8")) as { ziel?: unknown }).ziel;
    return MAIL_ENTWURF_ZIELE.includes(z as MailEntwurfZiel) ? (z as MailEntwurfZiel) : "auto";
  } catch {
    return "auto";
  }
}

export function mailEntwurfZielSetzen(ziel: MailEntwurfZiel): MailEntwurfZiel {
  if (!MAIL_ENTWURF_ZIELE.includes(ziel)) throw new Error(`Unbekanntes Ziel: ${String(ziel)}`);
  const tmp = `${datei()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ziel }, null, 2));
  renameSync(tmp, datei());
  return ziel;
}
