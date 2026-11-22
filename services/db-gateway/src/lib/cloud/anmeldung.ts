// Ein-Klick-Bestätigung einer Kunden-Instanz (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z4).
//
// Die Instanz meldet sich beim ersten Start über den Device Flow an. Statt Adresse und Code auf
// einer Setup-Seite zu zeigen, holt das Gateway den fertigen Bestätigungslink
// (`verification_uri_complete`) von GET /anmeldung der Instanz und gibt ihn nur dem gebundenen
// Nutzer: als Knopf in der App und als Link in der Erinnerungsmail. Ein Klick, Keycloak fragt
// „Zugriff erlauben?“, fertig. Fremde Konten scheitern an der Kontobindung der Instanz.
//
// Beide Tokens leiten sich aus INTERNAL_HMAC_SECRET ab (je Zweck eigener Präfix), damit das
// Gateway nichts zusätzlich speichern muss. Kein process-weites loadEnv: die Tests laufen ohne.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const geheim = () => process.env.INTERNAL_HMAC_SECRET?.trim() || "";
export const anmeldungEingerichtet = () => geheim().length > 0;

const hmac = (zweck: string, wert: string) => createHmac("sha256", geheim()).update(`${zweck}:${wert}`).digest("base64url");

/** Token, mit dem das Gateway GET /anmeldung der Instanz lesen darf; null ohne Geheimnis. */
export function instanzToken(instanzId: string): string | null {
  return anmeldungEingerichtet() ? hmac("ava-cloud-instanz-v1", instanzId) : null;
}

/** Signierter Mail-Link „Jetzt bestätigen“: Instanz-ID + Ablauf (Sekunden). */
export function bestaetigenToken(instanzId: string, bisMs: number): string | null {
  if (!anmeldungEingerichtet()) return null;
  const nutzlast = `${instanzId}.${Math.floor(bisMs / 1000)}`;
  return `${Buffer.from(nutzlast).toString("base64url")}.${hmac("ava-cloud-bestaetigen-v1", nutzlast)}`;
}

/** Instanz-ID aus einem gültigen, nicht abgelaufenen Mail-Link; sonst null. */
export function bestaetigenTokenPruefen(t: string, jetzt = Date.now()): string | null {
  if (!anmeldungEingerichtet() || t.length > 300) return null;
  const [teil, sig] = t.split(".");
  if (!teil || !sig) return null;
  const nutzlast = Buffer.from(teil, "base64url").toString("utf8");
  const erwartet = Buffer.from(hmac("ava-cloud-bestaetigen-v1", nutzlast));
  const bekommen = Buffer.from(sig);
  if (erwartet.length !== bekommen.length || !timingSafeEqual(erwartet, bekommen)) return null;
  const m = /^([0-9a-f-]{36})\.(\d{9,11})$/.exec(nutzlast);
  if (!m || Number(m[2]) * 1000 < jetzt) return null;
  return m[1]!;
}

/** Antwort von GET /anmeldung der Instanz (fremde Daten: immer prüfen). */
export const AnmeldeStandSchema = z.object({
  angemeldet: z.boolean(),
  phase: z.string().max(40).optional(),
  link: z.string().url().max(500).nullable().optional(),
  code: z.string().max(40).nullable().optional(),
  bis: z.string().max(40).nullable().optional(),
});
export type AnmeldeStand = z.infer<typeof AnmeldeStandSchema>;

/**
 * Nur Links auf die Gerätebestätigung des eigenen Anmeldedienstes weitergeben: Eine
 * kompromittierte Instanz darf dem Nutzer keinen fremden Link unterschieben.
 */
export function linkErlaubt(link: string, realmUrl: string | undefined = process.env.KEYCLOAK_REALM_URL): boolean {
  if (!realmUrl) return false;
  try {
    const l = new URL(link);
    const r = new URL(realmUrl.replace(/\/+$/, ""));
    return l.protocol === "https:" && l.origin === r.origin && l.pathname === `${r.pathname}/device`;
  } catch {
    return false;
  }
}

/** Bestätigungslink aus dem Stand, wenn er erlaubt ist; sonst null. */
export function bestaetigungsLink(a: AnmeldeStand | null, realmUrl?: string): { link: string; bis: string | null } | null {
  if (!a || a.angemeldet || !a.link) return null;
  if (!linkErlaubt(a.link, realmUrl ?? process.env.KEYCLOAK_REALM_URL)) return null;
  return { link: a.link, bis: a.bis ?? null };
}
