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
import { postfachStand, type ImapFabrik } from "../../mail-entwurf/postfach";
import { mailEntwurfLesen, type MailEntwurf } from "../../../shared/mail-entwurf";

export interface MailEntwurfToolDeps {
  attachments?: AttachmentStore | null;
  festeAnhaenge?: FesteAnhaenge | null;
  /** Nur fuer Tests: IMAP-Verbindung ersetzen. */
  imapFabrik?: ImapFabrik;
}

/** Hoechstens so viele Entwuerfe je Sammelaufruf (eine Bestaetigung). */
const SAMMEL_MAX = 50;

const LISTE = yup.array().of(yup.string().trim().min(3).required()).optional();

export function buildMailEntwurfTools(deps: MailEntwurfToolDeps): Tool[] {
  const ablegen = defineTool({
    name: "mail_entwurf_ablegen",
    summary: "Einen Mail-Entwurf in den Entwürfe-Ordner des eigenen Postfachs legen (Nutzer verschickt selbst).",
    category: "mail entwurf entwuerfe postfach ablegen ansprache outreach",
    description:
      "Legt eine Mail als Entwurf in den Entwürfe-Ordner des eingerichteten Entwurfs-Postfachs (IMAP). Der Nutzer sieht sie in seinem Mail-Programm, auf dem Handy und im Webmail, prüft sie und verschickt sie selbst. " +
      "Nutzen, wenn der Nutzer Entwürfe direkt im Postfach will („leg mir das in die Entwürfe“), bei mehreren Entwürfen auf einmal und in Workflows; sonst reicht der Block ```mail-entwurf im Chat. " +
      "Für MEHRERE Entwürfe (z. B. eine Mail je Lead) stattdessen mail_entwuerfe_ablegen: eine Bestätigung für alle. " +
      "`an` nur mit gespeicherten Adressen (kontakt_suchen, company_contacts, company_get; emailStatus bestätigt, wahrscheinlich oder ungeprüft zaehlen alle, eine abgeleitete und vom Mailserver bestaetigte Adresse ist belegt), keine selbst gebildete; ohne Adresse nicht aufrufen, sondern sagen, dass sie fehlt. `text` ist Klartext mit Anrede und Grußformel. " +
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
        const r = await entwurfInsPostfach(e, { chat: deps.attachments ?? null, fest: deps.festeAnhaenge ?? null }, ctx.conversationId, deps.imapFabrik);
        return { ok: true, ordner: r.ordner, an: e.an, betreff: e.betreff, anhaenge: r.anhaenge, postfach: stand.absender };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  // Feedback Patrick 2026-11-09: „alle Leads anschreiben und mit einem Klick in die
  // Entwuerfe“ — bisher eine Bestaetigung je Mail. Hier eine fuer alle, im Chat und
  // als Workflow-Schritt (allItems).
  const sammeln = defineTool({
    name: "mail_entwuerfe_ablegen",
    summary: "Mehrere Mail-Entwürfe auf einmal in die Entwürfe des eigenen Postfachs legen, mit EINER Bestätigung.",
    category: "mail entwurf entwuerfe postfach ablegen mehrere alle sammel bulk massen ansprache outreach leads",
    description:
      "Legt bis zu 50 Mails auf einmal als Entwürfe in den Entwürfe-Ordner des eingerichteten Entwurfs-Postfachs (IMAP). Der Nutzer bestätigt EINMAL für alle, prüft sie dann im Mail-Programm und verschickt selbst. " +
      "Nutzen, sobald es um mehr als einen Entwurf geht (z. B. „schreib allen offenen Leads eine Mail und leg sie in die Entwürfe“): erst alle Texte schreiben, dann EIN Aufruf mit allen. " +
      "Je Entwurf gelten dieselben Regeln wie bei mail_entwurf_ablegen: `an` nur mit gespeicherten Adressen, keine selbst gebildete; Entwürfe ohne Adresse weglassen und im Text nennen. " +
      "Im Workflow als Schritt mit Modus „alle Items“, z. B. entwuerfe: {{ $input.all().map(i => ({ an: [i.json.an], betreff: i.json.betreff, text: i.json.text })) }}.",
    parameters: {
      type: "object",
      required: ["entwuerfe"],
      properties: {
        entwuerfe: {
          type: "array",
          minItems: 1,
          maxItems: SAMMEL_MAX,
          items: {
            type: "object",
            required: ["betreff", "text"],
            properties: {
              an: { type: "array", items: { type: "string" } },
              cc: { type: "array", items: { type: "string" } },
              betreff: { type: "string" },
              text: { type: "string", description: "Klartext ohne Markdown, mit Anrede und Grußformel." },
              anhaenge: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    schema: yup
      .object({
        entwuerfe: yup
          .array()
          .of(
            yup
              .object({
                an: LISTE,
                cc: LISTE,
                betreff: yup.string().trim().min(1).max(998).required(),
                text: yup.string().min(1).max(100_000).required(),
                anhaenge: yup.array().of(yup.string().trim().min(1).required()).max(20).optional(),
              })
              .noUnknown(true),
          )
          .min(1)
          .max(SAMMEL_MAX)
          .required(),
      })
      .noUnknown(true),
    preview: (r: { abgelegt?: number; fehler?: unknown[]; abgebrochen?: boolean; error?: string }) =>
      r.abgebrochen ? "abgebrochen" : r.error ? `Fehler: ${r.error}` : `${r.abgelegt ?? 0} Entwürfe abgelegt${r.fehler?.length ? `, ${r.fehler.length} fehlgeschlagen` : ""}`,
    run: async (args, ctx) => {
      const stand = postfachStand();
      if (!stand.eingerichtet) {
        return { ok: false, error: "Kein Entwurfs-Postfach eingerichtet. Der Nutzer richtet es unter Einstellungen → Verbindungen → Mail-Entwürfe ein (IMAP-Zugang zum eigenen Postfach)." };
      }
      const gueltig: MailEntwurf[] = [];
      const ungueltig: Array<{ nr: number; betreff: string; grund: string }> = [];
      args.entwuerfe.forEach((x, i) => {
        const g = mailEntwurfLesen({ an: x.an ?? [], cc: x.cc ?? [], betreff: x.betreff, text: x.text, anhaenge: x.anhaenge ?? [] });
        if ("fehler" in g) ungueltig.push({ nr: i + 1, betreff: x.betreff, grund: g.fehler });
        else gueltig.push(g.entwurf);
      });
      if (gueltig.length === 0) return { ok: false, error: "Keiner der Entwürfe ist gültig.", ungueltig };
      const liste = gueltig
        .slice(0, 25)
        .map((e, i) => `${i + 1}. ${e.an.join(", ") || "(ohne Empfänger)"} · ${e.betreff}`)
        .join("\n");
      const value = await ctx.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            `${gueltig.length === 1 ? "Diesen Entwurf" : `Diese ${gueltig.length} Entwürfe`} in die Entwürfe von ${stand.absender} legen? Du prüfst und verschickst sie danach selbst.\n\n${liste}` +
            `${gueltig.length > 25 ? `\n… und ${gueltig.length - 25} weitere` : ""}` +
            `${ungueltig.length ? `\n\nNicht dabei (ungültig): ${ungueltig.map((u) => `${u.nr}. ${u.betreff} (${u.grund})`).join("; ")}` : ""}` +
            `\n\nBeispiel (Nr. 1):\n${gueltig[0]!.text.slice(0, 700)}${gueltig[0]!.text.length > 700 ? "\n[…gekürzt]" : ""}`,
          confirmValue: "ablegen",
          options: [
            { value: "ablegen", label: gueltig.length === 1 ? "In die Entwürfe legen" : `Alle ${gueltig.length} in die Entwürfe legen` },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        ctx.signal,
      );
      if (value !== "ablegen") return { ok: false, abgebrochen: true, userDeclined: true as const };
      const abgelegt: Array<{ an: string[]; betreff: string; ordner: string }> = [];
      const fehler: Array<{ an: string[]; betreff: string; grund: string }> = [];
      for (const e of gueltig) {
        if (ctx.signal?.aborted) break;
        try {
          const r = await entwurfInsPostfach(e, { chat: deps.attachments ?? null, fest: deps.festeAnhaenge ?? null }, ctx.conversationId, deps.imapFabrik);
          abgelegt.push({ an: e.an, betreff: e.betreff, ordner: r.ordner });
        } catch (err) {
          fehler.push({ an: e.an, betreff: e.betreff, grund: err instanceof Error ? err.message : String(err) });
        }
      }
      return { ok: fehler.length === 0, abgelegt: abgelegt.length, postfach: stand.absender, entwuerfe: abgelegt, fehler, ungueltig };
    },
  });

  return [ablegen, sammeln];
}
