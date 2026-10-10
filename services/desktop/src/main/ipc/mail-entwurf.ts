// Mail-Entwürfe aus dem Chat im Mail-Programm öffnen (docs/PLAN_MAIL_ENTWURF.md).
// Der Renderer schickt den Rohblock; geprüft wird hier noch einmal. Dazu die
// Einstellungen: Ziel, Entwurfs-Postfach (Stufe 3) und feste Anhänge.

import { ipcMain } from "electron";
import type { AttachmentStore } from "../agent/attachment-store";
import { mailEntwurfLesen, MAIL_ENTWURF_ZIELE, type MailEntwurfZiel } from "../../shared/mail-entwurf";
import { mailEntwurfZiel, mailEntwurfZielSetzen } from "../mail-entwurf/einstellung";
import type { FesteAnhaenge } from "../mail-entwurf/feste-anhaenge";
import { anhaengeZeigen, empfohlenerWeg, mailEntwurfOeffnen } from "../mail-entwurf/oeffnen";
import { POSTFACH_ANBIETER, postfachEinrichten, postfachEntfernen, postfachStand, type PostfachEinstellung } from "../mail-entwurf/postfach";

export function registerMailEntwurfIpc(deps: { attachments: AttachmentStore | null; festeAnhaenge: FesteAnhaenge | null }): void {
  const quellen = { chat: deps.attachments, fest: deps.festeAnhaenge };

  ipcMain.handle("mail-entwurf:stand", async (_e, input?: { hatAnhaenge?: boolean }) => {
    const ziel = mailEntwurfZiel();
    const { weg, programm } = await empfohlenerWeg(ziel, input?.hatAnhaenge === true);
    const p = postfachStand();
    return {
      ziel,
      weg,
      programm,
      postfach: p.eingerichtet ? { absender: p.absender, ordner: p.ordner } : null,
      festeAnhaenge: (deps.festeAnhaenge?.liste() ?? []).map((a) => ({ id: a.id, name: a.name, immer: a.immer })),
    };
  });

  ipcMain.handle("mail-entwurf:oeffnen", async (_e, input: { raw: string; weg?: string; conversationId?: string }) => {
    const r = mailEntwurfLesen(input?.raw);
    if ("fehler" in r) return { weg: "keins", programm: null, anhaengeFehlen: false, fehler: r.fehler };
    const weg = MAIL_ENTWURF_ZIELE.includes(input.weg as MailEntwurfZiel) ? (input.weg as MailEntwurfZiel) : undefined;
    return mailEntwurfOeffnen(r.entwurf, weg, { quellen, conversationId: input.conversationId });
  });

  ipcMain.handle("mail-entwurf:anhaenge-zeigen", (_e, input: { raw: string; conversationId?: string }) => {
    const r = mailEntwurfLesen(input?.raw);
    if ("fehler" in r) return { ok: false, fehler: r.fehler };
    return anhaengeZeigen(r.entwurf, { quellen, conversationId: input.conversationId });
  });

  ipcMain.handle("mail-entwurf:ziel-setzen", (_e, ziel: string) => mailEntwurfZielSetzen(ziel as MailEntwurfZiel));

  // ---- Einstellungen ----
  ipcMain.handle("mail-entwurf:einstellungen", () => ({
    ziel: mailEntwurfZiel(),
    postfach: postfachStand(),
    anbieter: POSTFACH_ANBIETER,
    festeAnhaenge: deps.festeAnhaenge?.liste() ?? [],
  }));

  ipcMain.handle("mail-entwurf:postfach-einrichten", (_e, input: { einstellung: Omit<PostfachEinstellung, "ordner" | "geprueft">; passwort: string }) =>
    postfachEinrichten(input.einstellung, String(input.passwort ?? "")),
  );

  ipcMain.handle("mail-entwurf:postfach-entfernen", () => {
    postfachEntfernen();
    return { ok: true };
  });

  ipcMain.handle("mail-entwurf:fest-hinzufuegen", (_e, input: { name: string; mimeType: string; bytes: Uint8Array; immer?: boolean; beschreibung?: string }) => {
    if (!deps.festeAnhaenge) return { ok: false, fehler: "Nicht verfügbar." };
    try {
      return { ok: true, anhang: deps.festeAnhaenge.hinzufuegen({ ...input, bytes: new Uint8Array(input.bytes) }) };
    } catch (err) {
      return { ok: false, fehler: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("mail-entwurf:fest-aendern", (_e, input: { id: string; immer?: boolean; beschreibung?: string | null }) => deps.festeAnhaenge?.aendern(input.id, input) ?? null);

  ipcMain.handle("mail-entwurf:fest-entfernen", (_e, id: string) => deps.festeAnhaenge?.entfernen(id) ?? false);
}
