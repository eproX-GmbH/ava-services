// .eml-Entwurf (docs/PLAN_MAIL_ENTWURF.md, Stufe 2): vollständige MIME-Mail mit
// Anhängen und X-Unsent: 1, damit Outlook sie als bearbeitbaren Entwurf öffnet.
// Ohne Electron, damit auch die Server-AVA sie für die App bauen kann.

import MailComposer from "nodemailer/lib/mail-composer";
import type { AttachmentStore } from "../agent/attachment-store";
import type { MailEntwurf } from "../../shared/mail-entwurf";

/** Wie bei mail_send: SMTP-übliche Grenze für die Summe der Anhänge. */
export const ANHANG_MAX_BYTES = 20 * 1024 * 1024;

export interface EmlAnhang {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** Löst die Anhänge des Entwurfs im AttachmentStore auf (Handle oder Dateiname). */
export function anhaengeLaden(store: AttachmentStore | null | undefined, e: MailEntwurf, conversationId?: string): { anhaenge: EmlAnhang[] } | { fehler: string } {
  if (e.anhaenge.length === 0) return { anhaenge: [] };
  if (!store) return { fehler: "Anhänge sind hier nicht verfügbar." };
  const anhaenge: EmlAnhang[] = [];
  let summe = 0;
  for (const a of e.anhaenge) {
    const r = store.aufloesen(conversationId, a);
    if ("fehler" in r) return { fehler: `${r.fehler} (Chat-Uploads bleiben 7 Tage erhalten.)` };
    if (anhaenge.some((x) => x.filename === r.datei.filename)) continue;
    summe += r.datei.sizeBytes;
    if (summe > ANHANG_MAX_BYTES) return { fehler: `Die Anhänge sind zusammen größer als 20 MB.` };
    anhaenge.push({ filename: r.datei.filename, content: Buffer.from(r.datei.bytes), contentType: r.datei.mimeType });
  }
  return { anhaenge };
}

export async function emlBauen(e: MailEntwurf, anhaenge: EmlAnhang[]): Promise<Buffer> {
  const mail = new MailComposer({
    to: e.an,
    ...(e.cc.length ? { cc: e.cc } : {}),
    subject: e.betreff,
    text: e.text,
    attachments: anhaenge,
    headers: { "X-Unsent": "1" },
  });
  return await mail.compile().build();
}
