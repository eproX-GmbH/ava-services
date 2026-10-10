// Mail-Entwürfe aus dem Chat im Mail-Programm öffnen (docs/PLAN_MAIL_ENTWURF.md).
// Der Renderer schickt den Rohblock; geprüft wird hier noch einmal.

import { ipcMain } from "electron";
import type { AttachmentStore } from "../agent/attachment-store";
import { mailEntwurfLesen, MAIL_ENTWURF_ZIELE, type MailEntwurfZiel } from "../../shared/mail-entwurf";
import { mailEntwurfZiel, mailEntwurfZielSetzen } from "../mail-entwurf/einstellung";
import { anhaengeZeigen, empfohlenerWeg, mailEntwurfOeffnen } from "../mail-entwurf/oeffnen";

export function registerMailEntwurfIpc(deps: { attachments: AttachmentStore | null }): void {
  ipcMain.handle("mail-entwurf:stand", async () => {
    const ziel = mailEntwurfZiel();
    const { weg, programm } = await empfohlenerWeg(ziel);
    return { ziel, weg, programm };
  });

  ipcMain.handle("mail-entwurf:oeffnen", async (_e, input: { raw: string; weg?: string; conversationId?: string }) => {
    const r = mailEntwurfLesen(input?.raw);
    if ("fehler" in r) return { weg: "keins", programm: null, anhaengeFehlen: false, fehler: r.fehler };
    const weg = MAIL_ENTWURF_ZIELE.includes(input.weg as MailEntwurfZiel) ? (input.weg as MailEntwurfZiel) : undefined;
    return mailEntwurfOeffnen(r.entwurf, weg, { attachments: deps.attachments, conversationId: input.conversationId });
  });

  ipcMain.handle("mail-entwurf:anhaenge-zeigen", (_e, input: { raw: string; conversationId?: string }) => {
    const r = mailEntwurfLesen(input?.raw);
    if ("fehler" in r) return { ok: false, fehler: r.fehler };
    return anhaengeZeigen(r.entwurf, { attachments: deps.attachments, conversationId: input.conversationId });
  });

  ipcMain.handle("mail-entwurf:ziel-setzen", (_e, ziel: string) => mailEntwurfZielSetzen(ziel as MailEntwurfZiel));
}
