// Onboarding O5 (docs/PLAN_ONBOARDING.md): Mails an Nutzer ueber Mailgun (EU-Region).
// Empfaenger ist IMMER die Registrierungsadresse des Kontos (MailEinstellung),
// nie eine freie Adresse. Willkommen geht ohne Zustimmung raus (gehoert zur
// Registrierung); Neuigkeiten nur nach Bestaetigung (Double-Opt-in), nie nach Abmeldung.

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { loadEnv } from "../env";
import { logger } from "../logger";
import { AVA_LOGO_PNG_BASE64 } from "./logo";
import type { Mail } from "./vorlagen";

let logo: Buffer | null = null;
function logoLaden(): Buffer {
  logo ??= Buffer.from(AVA_LOGO_PNG_BASE64, "base64");
  return logo;
}

const DIENSTMAILS = new Set(["willkommen", "beitritt"]);

export function versandBereit(): boolean {
  return Boolean(loadEnv().MAILGUN_API_KEY);
}

export interface MailKonto { actorId: string; email: string; vorname: string | null; token: string; neuigkeiten: boolean; abgemeldet: boolean }

/** Konto fuer Mails anlegen oder lesen (Adresse aus der Registrierung, Token fuer die Links). */
export async function mailKonto(pool: Pool, e: { actorId: string; email: string; vorname?: string | null }): Promise<MailKonto> {
  const token = randomBytes(24).toString("hex");
  const r = await pool.query<{ actorId: string; email: string; vorname: string | null; token: string; neuigkeiten: boolean; abgemeldetAt: Date | null }>(
    `INSERT INTO "MailEinstellung" ("actorId", "email", "vorname", "token") VALUES ($1, $2, $3, $4)
     ON CONFLICT ("actorId") DO UPDATE SET "vorname" = COALESCE("MailEinstellung"."vorname", EXCLUDED."vorname")
     RETURNING "actorId", "email", "vorname", "token", "neuigkeiten", "abgemeldetAt"`,
    [e.actorId, e.email.trim().toLowerCase(), e.vorname?.trim() || null, token],
  );
  const z = r.rows[0]!;
  return { actorId: z.actorId, email: z.email, vorname: z.vorname, token: z.token, neuigkeiten: z.neuigkeiten, abgemeldet: !!z.abgemeldetAt };
}

export async function mailKontoLesen(pool: Pool, actorId: string): Promise<MailKonto | null> {
  const r = await pool.query<{ actorId: string; email: string; vorname: string | null; token: string; neuigkeiten: boolean; abgemeldetAt: Date | null }>(
    `SELECT "actorId", "email", "vorname", "token", "neuigkeiten", "abgemeldetAt" FROM "MailEinstellung" WHERE "actorId" = $1`, [actorId],
  );
  const z = r.rows[0];
  return z ? { actorId: z.actorId, email: z.email, vorname: z.vorname, token: z.token, neuigkeiten: z.neuigkeiten, abgemeldet: !!z.abgemeldetAt } : null;
}

export function linkAdressen(token: string): { bestaetigen: string; abmelden: string } {
  const basis = loadEnv().GATEWAY_PUBLIC_URL.replace(/\/+$/, "");
  return { bestaetigen: `${basis}/mail/bestaetigen?t=${token}`, abmelden: `${basis}/mail/abmelden?t=${token}` };
}

/** Eine Mail an das Konto schicken. art = willkommen | top10 | neuigkeiten (Protokoll in MailVersand). */
export async function mailSenden(pool: Pool, konto: MailKonto, art: string, mail: Mail): Promise<{ ok: boolean; grund?: string }> {
  const env = loadEnv();
  const protokoll = (status: string, mailgunId: string | null, fehler: string | null) =>
    pool.query(`INSERT INTO "MailVersand" ("actorId", "art", "status", "mailgunId", "fehler") VALUES ($1, $2, $3, $4, $5)`, [konto.actorId, art, status, mailgunId, fehler]).catch(() => undefined);
  if (konto.abgemeldet) { await protokoll("uebersprungen", null, "abgemeldet"); return { ok: false, grund: "abgemeldet" }; }
  // Dienstmails (Willkommen, Beitrittsanfrage an Admins) brauchen keine Zustimmung, Neuigkeiten schon.
  if (!DIENSTMAILS.has(art) && !konto.neuigkeiten) { await protokoll("uebersprungen", null, "keine Zustimmung"); return { ok: false, grund: "keine Zustimmung" }; }
  if (!env.MAILGUN_API_KEY) { await protokoll("uebersprungen", null, "MAILGUN_API_KEY fehlt"); return { ok: false, grund: "Versand nicht eingerichtet" }; }
  const form = new FormData();
  form.set("from", env.MAIL_ABSENDER);
  form.set("to", konto.email);
  form.set("subject", mail.betreff);
  form.set("html", mail.html);
  form.set("text", mail.text);
  form.set("o:tag", `ava-${art}`);
  // Keine Oeffnungs-/Klickverfolgung (Datenschutz); Abmeldelink kommt aus der Vorlage.
  form.set("o:tracking", "no");
  const { abmelden } = linkAdressen(konto.token);
  form.set("h:List-Unsubscribe", `<${abmelden}>`);
  form.set("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  form.append("inline", new Blob([new Uint8Array(logoLaden())], { type: "image/png" }), "ava-logo.png");
  try {
    const res = await fetch(`${env.MAILGUN_API_BASE.replace(/\/+$/, "")}/v3/${env.MAILGUN_DOMAIN}/messages`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`api:${env.MAILGUN_API_KEY}`).toString("base64")}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      await protokoll("fehler", null, `${res.status} ${text.slice(0, 300)}`);
      logger.warn({ actorId: konto.actorId, art, status: res.status }, "[mail] Mailgun lehnte ab");
      return { ok: false, grund: `Mailgun ${res.status}` };
    }
    let id: string | null = null;
    try { id = (JSON.parse(text) as { id?: string }).id ?? null; } catch { /* egal */ }
    await protokoll("gesendet", id, null);
    logger.info({ actorId: konto.actorId, art }, "[mail] gesendet");
    return { ok: true };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    await protokoll("fehler", null, m.slice(0, 300));
    return { ok: false, grund: m };
  }
}

export async function bestaetigen(pool: Pool, token: string): Promise<boolean> {
  const r = await pool.query(`UPDATE "MailEinstellung" SET "neuigkeiten" = TRUE, "bestaetigtAt" = COALESCE("bestaetigtAt", NOW()), "abgemeldetAt" = NULL, "updatedAt" = NOW() WHERE "token" = $1`, [token]);
  return (r.rowCount ?? 0) > 0;
}

export async function abmelden(pool: Pool, token: string): Promise<boolean> {
  const r = await pool.query(`UPDATE "MailEinstellung" SET "neuigkeiten" = FALSE, "abgemeldetAt" = NOW(), "updatedAt" = NOW() WHERE "token" = $1`, [token]);
  return (r.rowCount ?? 0) > 0;
}
