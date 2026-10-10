// Mail-Entwürfe, die der Nutzer selbst verschickt (docs/PLAN_MAIL_ENTWURF.md).
// AVA schreibt sie als ```mail-entwurf-Block mit JSON; dieses Modul prüft den
// Block und baut daraus mailto:- und Webmail-Links. Gemeinsam für Hauptprozess,
// Renderer und Telegram; die AVA-App (ava-app) hat eine Kopie.

import * as yup from "yup";

export interface MailEntwurf {
  an: string[];
  cc: string[];
  betreff: string;
  /** Klartext mit Anrede und Grußformel. */
  text: string;
  /** Chat-Uploads (Handle att-… oder Dateiname), die mitgehen sollen. */
  anhaenge: string[];
}

/** Wohin der Knopf den Entwurf schickt. „auto“: Desktop wählt nach dem Standardprogramm. */
export type MailEntwurfZiel = "auto" | "programm" | "eml" | "gmail" | "outlook-web" | "outlook-live";
export const MAIL_ENTWURF_ZIELE: readonly MailEntwurfZiel[] = ["auto", "programm", "eml", "gmail", "outlook-web", "outlook-live"];
export const ZIEL_TEXT: Record<MailEntwurfZiel, string> = {
  auto: "automatisch",
  programm: "Mail-Programm",
  eml: "Outlook-Entwurf (.eml)",
  gmail: "Gmail",
  "outlook-web": "Outlook im Web (Microsoft 365)",
  "outlook-live": "Outlook.com",
};

export const MAIL_ENTWURF_FENCE_RE = /```mail-entwurf\s*\n([\s\S]*?)\n```/g;
export const MAIL_ENTWURF_OPEN_RE = /```mail-entwurf\b/;

const adresse = yup.string().trim().max(254).email("keine gültige E-Mail-Adresse");
const schema = yup
  .object({
    an: yup.array().of(adresse.required()).max(20).default([]),
    cc: yup.array().of(adresse.required()).max(20).default([]),
    betreff: yup.string().trim().max(300).default(""),
    text: yup.string().max(20_000).required("text fehlt"),
    anhaenge: yup.array().of(yup.string().trim().min(1).max(200).required()).max(20).default([]),
  })
  .noUnknown(false);

/**
 * Modelle schreiben Zeilenumbrüche gern roh in JSON-Strings. Solche Umbrüche
 * innerhalb von Strings werden zu \n, alles andere bleibt unverändert.
 */
function umbruecheMaskieren(raw: string): string {
  let aus = "";
  let imString = false;
  let escape = false;
  for (const z of raw) {
    if (imString) {
      if (escape) escape = false;
      else if (z === "\\") escape = true;
      else if (z === '"') imString = false;
      else if (z === "\n") {
        aus += "\\n";
        continue;
      } else if (z === "\r") continue;
      else if (z === "\t") {
        aus += "\\t";
        continue;
      }
    } else if (z === '"') imString = true;
    aus += z;
  }
  return aus;
}

/** Prüft den Inhalt eines ```mail-entwurf-Blocks. */
export function mailEntwurfLesen(raw: unknown): { entwurf: MailEntwurf } | { fehler: string } {
  let daten: unknown = raw;
  if (typeof raw === "string") {
    try {
      daten = JSON.parse(umbruecheMaskieren(raw.trim()));
    } catch {
      return { fehler: "Der Entwurf ist kein gültiges JSON." };
    }
  }
  // Ein einzelner Empfänger als Text ist häufig; als Liste behandeln.
  if (daten && typeof daten === "object") {
    const d = daten as Record<string, unknown>;
    for (const k of ["an", "cc", "anhaenge"]) {
      if (typeof d[k] === "string") d[k] = (d[k] as string).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  try {
    const e = schema.validateSync(daten, { abortEarly: true, stripUnknown: true });
    return { entwurf: { an: e.an ?? [], cc: e.cc ?? [], betreff: e.betreff ?? "", text: e.text, anhaenge: e.anhaenge ?? [] } };
  } catch (err) {
    return { fehler: err instanceof Error ? err.message : String(err) };
  }
}

/** Zeilenumbrüche nach RFC 6068 als CRLF. */
const kodieren = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, "\r\n"));

/** mailto:-Link (RFC 6068). Anhänge kann mailto: nicht. */
export function mailtoUrl(e: MailEntwurf): string {
  const teile: string[] = [];
  if (e.cc.length) teile.push(`cc=${e.cc.map(encodeURIComponent).join(",")}`);
  if (e.betreff) teile.push(`subject=${kodieren(e.betreff)}`);
  teile.push(`body=${kodieren(e.text)}`);
  return `mailto:${e.an.map(encodeURIComponent).join(",")}?${teile.join("&")}`;
}

/** Webmail mit ausgefülltem Entwurf (ohne Anhänge). */
export function webmailUrl(e: MailEntwurf, ziel: "gmail" | "outlook-web" | "outlook-live"): string {
  const p = new URLSearchParams();
  if (ziel === "gmail") {
    p.set("view", "cm");
    p.set("fs", "1");
    if (e.an.length) p.set("to", e.an.join(","));
    if (e.cc.length) p.set("cc", e.cc.join(","));
    if (e.betreff) p.set("su", e.betreff);
    p.set("body", e.text);
    return `https://mail.google.com/mail/?${p.toString()}`;
  }
  if (e.an.length) p.set("to", e.an.join(","));
  if (e.cc.length) p.set("cc", e.cc.join(","));
  if (e.betreff) p.set("subject", e.betreff);
  p.set("body", e.text);
  const basis = ziel === "outlook-web" ? "https://outlook.office.com/mail/deeplink/compose" : "https://outlook.live.com/mail/0/deeplink/compose";
  return `${basis}?${p.toString().replace(/\+/g, "%20")}`;
}

/** Outlook wertet X-Unsent aus und öffnet die .eml als Entwurf; andere Programme zeigen sie als empfangene Mail. */
export const programmIstOutlook = (name: string | null | undefined) => !!name && /outlook/i.test(name);

/** Dateiname für die .eml: Betreff, sonst Empfänger. */
export function emlDateiname(e: MailEntwurf): string {
  const grund = (e.betreff || e.an[0] || "Entwurf").replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${grund || "Entwurf"}.eml`;
}

/** Lesbarer Text für Kanäle ohne Knopf (Telegram, Kopieren). */
export function mailEntwurfAlsText(e: MailEntwurf): string {
  const kopf = [e.an.length ? `An: ${e.an.join(", ")}` : "An: (Adresse fehlt)", ...(e.cc.length ? [`Cc: ${e.cc.join(", ")}`] : []), `Betreff: ${e.betreff || "(ohne Betreff)"}`];
  const anhang = e.anhaenge.length ? `\n\nAnhänge: ${e.anhaenge.join(", ")}` : "";
  return `${kopf.join("\n")}\n\n${e.text.trim()}${anhang}`;
}

/** Ersetzt alle Blöcke in einem Antworttext (für Kanäle ohne Karte). */
export function mailEntwuerfeErsetzen(md: string, ersatz: (e: MailEntwurf | null, raw: string) => string): string {
  return md.replace(MAIL_ENTWURF_FENCE_RE, (_m, raw: string) => {
    const r = mailEntwurfLesen(raw);
    return ersatz("entwurf" in r ? r.entwurf : null, raw);
  });
}
