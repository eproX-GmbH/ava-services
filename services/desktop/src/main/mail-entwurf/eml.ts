// .eml-Entwurf (docs/PLAN_MAIL_ENTWURF.md, Stufe 2): vollständige MIME-Mail mit
// Anhängen und X-Unsent: 1, damit Outlook sie als bearbeitbaren Entwurf öffnet.
// Ohne Electron, damit auch die Server-AVA sie für die App bauen kann.

import MailComposer from "nodemailer/lib/mail-composer";
import type { AttachmentStore } from "../agent/attachment-store";
import { FEST_PRAEFIX, type MailEntwurf } from "../../shared/mail-entwurf";
import type { FesteAnhaenge } from "./feste-anhaenge";
import { entwurfAblegen, postfachAbsender, postfachStand, type ImapFabrik } from "./postfach";

/** Woher Anhänge kommen: Chat-Uploads (att-…, 7 Tage) und feste Anhänge (fix-…). */
export interface AnhangQuellen {
  chat?: AttachmentStore | null;
  fest?: FesteAnhaenge | null;
}

/** Wie bei mail_send: SMTP-übliche Grenze für die Summe der Anhänge. */
export const ANHANG_MAX_BYTES = 20 * 1024 * 1024;

export interface EmlAnhang {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** Löst die Anhänge des Entwurfs auf: erst feste Anhänge (Handle oder Name), dann Chat-Uploads. */
export function anhaengeLaden(quellen: AnhangQuellen, e: MailEntwurf, conversationId?: string): { anhaenge: EmlAnhang[] } | { fehler: string } {
  if (e.anhaenge.length === 0) return { anhaenge: [] };
  const anhaenge: EmlAnhang[] = [];
  let summe = 0;
  const dazu = (a: EmlAnhang, groesse: number): string | null => {
    if (anhaenge.some((x) => x.filename === a.filename)) return null;
    summe += groesse;
    if (summe > ANHANG_MAX_BYTES) return "Die Anhänge sind zusammen größer als 20 MB.";
    anhaenge.push(a);
    return null;
  };
  for (const angabe of e.anhaenge) {
    const fest = quellen.fest?.aufloesen(angabe);
    if (fest) {
      const f = dazu({ filename: fest.anhang.name, content: fest.bytes, contentType: fest.anhang.mimeType }, fest.anhang.sizeBytes);
      if (f) return { fehler: f };
      continue;
    }
    if (angabe.startsWith(FEST_PRAEFIX)) return { fehler: `Den festen Anhang ${angabe} gibt es nicht mehr.` };
    if (!quellen.chat) return { fehler: "Anhänge sind hier nicht verfügbar." };
    const r = quellen.chat.aufloesen(conversationId, angabe);
    if ("fehler" in r) return { fehler: `${r.fehler} (Chat-Uploads bleiben 7 Tage erhalten.)` };
    const f = dazu({ filename: r.datei.filename, content: Buffer.from(r.datei.bytes), contentType: r.datei.mimeType }, r.datei.sizeBytes);
    if (f) return { fehler: f };
  }
  return { anhaenge };
}

/**
 * `von`: Absender (für den Entwurf im eigenen Postfach). `ungesendet`: X-Unsent: 1,
 * damit Outlook die Datei als Entwurf öffnet (nicht für das Postfach nötig).
 */
export async function emlBauen(e: MailEntwurf, anhaenge: EmlAnhang[], opts: { von?: string | null; ungesendet?: boolean } = {}): Promise<Buffer> {
  const mail = new MailComposer({
    ...(opts.von ? { from: opts.von } : {}),
    to: e.an,
    ...(e.cc.length ? { cc: e.cc } : {}),
    subject: e.betreff,
    text: e.text,
    attachments: anhaenge,
    ...(opts.ungesendet !== false ? { headers: { "X-Unsent": "1" } } : {}),
  });
  return await mail.compile().build();
}

/** Stufe 3: Entwurf mit Absender und Anhängen in den Entwürfe-Ordner des eigenen Postfachs legen. */
export async function entwurfInsPostfach(e: MailEntwurf, quellen: AnhangQuellen, conversationId?: string, fabrik?: ImapFabrik): Promise<{ ordner: string; anhaenge: number }> {
  const a = anhaengeLaden(quellen, e, conversationId);
  if ("fehler" in a) throw new Error(a.fehler);
  const mime = await emlBauen(e, a.anhaenge, { von: postfachAbsender(postfachStand()), ungesendet: false });
  const r = await entwurfAblegen(mime, fabrik);
  return { ordner: r.ordner, anhaenge: a.anhaenge.length };
}
