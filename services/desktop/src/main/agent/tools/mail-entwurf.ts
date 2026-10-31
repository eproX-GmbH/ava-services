// Mail-Entwurf direkt ins Entwürfe-Postfach legen (2026-10-31, Feedback Patrick):
// Der Chat-Block ```mail-entwurf landet nur per Klick im Postfach — für „leg mir
// das in die Entwürfe“, mehrere Entwürfe auf einmal und Workflows braucht es ein
// Werkzeug. Gleiche Logik wie der Knopf (mail-entwurf/eml.ts, IMAP APPEND), der
// Nutzer öffnet den Entwurf in seinem Mail-Programm und drückt Senden.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { AttachmentStore } from "../attachment-store";
import type { FesteAnhaenge } from "../../mail-entwurf/feste-anhaenge";
import { entwurfInsPostfach } from "../../mail-entwurf/eml";
import { postfachStand } from "../../mail-entwurf/postfach";
import { mailEntwurfLesen } from "../../../shared/mail-entwurf";

export interface MailEntwurfToolDeps {
  attachments?: AttachmentStore | null;
  festeAnhaenge?: FesteAnhaenge | null;
}

const LISTE = yup.array().of(yup.string().trim().min(3).required()).optional();

export function buildMailEntwurfTools(deps: MailEntwurfToolDeps): Tool[] {
  const ablegen = defineTool({
    name: "mail_entwurf_ablegen",
    summary: "Einen Mail-Entwurf in den Entwürfe-Ordner des eigenen Postfachs legen (Nutzer verschickt selbst).",
    category: "mail entwurf entwuerfe postfach ablegen ansprache outreach",
    description:
      "Legt eine Mail als Entwurf in den Entwürfe-Ordner des eingerichteten Entwurfs-Postfachs (IMAP). Der Nutzer sieht sie in seinem Mail-Programm, auf dem Handy und im Webmail, prüft sie und verschickt sie selbst. " +
      "Nutzen, wenn der Nutzer Entwürfe direkt im Postfach will („leg mir das in die Entwürfe“), bei mehreren Entwürfen auf einmal und in Workflows; sonst reicht der Block ```mail-entwurf im Chat. " +
      "`an` nur mit bekannten Adressen (Kontakte, company_get), nie erfinden; ohne Adresse nicht aufrufen, sondern sagen, dass sie fehlt. `text` ist Klartext mit Anrede und Grußformel. " +
      "Ist kein Entwurfs-Postfach eingerichtet, kommt ein Fehler mit Hinweis auf die Einstellung.",
    parameters: {
      type: "object",
      required: ["betreff", "text"],
      properties: {
        an: { type: "array", items: { type: "string" }, description: "Empfänger (E-Mail-Adressen). Leer erlaubt, dann trägt der Nutzer sie im Mail-Programm ein." },
        cc: { type: "array", items: { type: "string" } },
        betreff: { type: "string" },
        text: { type: "string", description: "Klartext ohne Markdown, mit Anrede und Grußformel." },
        anhaenge: { type: "array", items: { type: "string" }, description: "Im Chat hochgeladene Dateien (Handle att-…) oder feste Anhänge (fix-…)." },
      },
    },
    schema: yup
      .object({
        an: LISTE,
        cc: LISTE,
        betreff: yup.string().trim().min(1).max(998).required(),
        text: yup.string().min(1).max(100_000).required(),
        anhaenge: yup.array().of(yup.string().trim().min(1).required()).max(20).optional(),
      })
      .noUnknown(true),
    preview: (r: { ok?: boolean; ordner?: string; an?: string[]; error?: string; abgebrochen?: boolean }) =>
      r.abgebrochen ? "abgebrochen" : r.ok ? `Entwurf abgelegt (${r.ordner ?? "Entwürfe"}) an ${(r.an ?? []).join(", ") || "—"}` : `Fehler: ${r.error ?? "?"}`,
    run: async (args, ctx) => {
      const stand = postfachStand();
      if (!stand.eingerichtet) {
        return { ok: false, error: "Kein Entwurfs-Postfach eingerichtet. Der Nutzer richtet es unter Einstellungen → Verbindungen → Mail-Entwürfe ein (IMAP-Zugang zum eigenen Postfach)." };
      }
      const gelesen = mailEntwurfLesen({ an: args.an ?? [], cc: args.cc ?? [], betreff: args.betreff, text: args.text, anhaenge: args.anhaenge ?? [] });
      if ("fehler" in gelesen) return { ok: false, error: gelesen.fehler };
      const e = gelesen.entwurf;
      const value = await ctx.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Diesen Entwurf in die Entwürfe von ${stand.absender} legen?\n\nAn: ${e.an.join(", ") || "—"}\n${e.cc.length ? `CC: ${e.cc.join(", ")}\n` : ""}Betreff: ${e.betreff}${e.anhaenge.length ? `\nAnhänge: ${e.anhaenge.join(", ")}` : ""}\n\n${e.text.slice(0, 1500)}${e.text.length > 1500 ? "\n\n[…gekürzt]" : ""}`,
          confirmValue: "ablegen",
          options: [
            { value: "ablegen", label: "In die Entwürfe legen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        ctx.signal,
      );
      if (value !== "ablegen") return { ok: false, abgebrochen: true, userDeclined: true as const };
      try {
        const r = await entwurfInsPostfach(e, { chat: deps.attachments ?? null, fest: deps.festeAnhaenge ?? null }, ctx.conversationId);
        return { ok: true, ordner: r.ordner, an: e.an, betreff: e.betreff, anhaenge: r.anhaenge, postfach: stand.absender };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  return [ablegen];
}
