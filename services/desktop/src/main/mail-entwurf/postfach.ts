// Entwurfs-Postfach (docs/PLAN_MAIL_ENTWURF.md Stufe 3): AVA legt Mail-Entwürfe per
// IMAP APPEND in den Entwürfe-Ordner des eigenen Postfachs. Dort erscheinen sie in
// jedem Mail-Programm, im Webmail und auf dem Handy, mit Anhängen; der Nutzer öffnet
// den Entwurf und drückt Senden. AVA schreibt NUR in diesen Ordner, liest nichts.
// Passwort verschlüsselt über credentials() (Desktop: Schlüsselbund, Server: AVA_SECRETS_KEY).
// Ohne Electron, läuft auch im Server.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentials, paths } from "../../core/platform";
import type { PostfachAnbieter, PostfachEinstellung, PostfachStand } from "../../shared/mail-entwurf";

export type { PostfachEinstellung, PostfachStand };

export const POSTFACH_ANBIETER: PostfachAnbieter[] = [
  { id: "ionos", name: "IONOS", host: "imap.ionos.de", port: 993 },
  { id: "strato", name: "STRATO", host: "imap.strato.de", port: 993 },
  { id: "gmx", name: "GMX", host: "imap.gmx.net", port: 993, hinweis: "In den GMX-Einstellungen „POP3/IMAP-Abruf“ erlauben." },
  { id: "webde", name: "WEB.DE", host: "imap.web.de", port: 993, hinweis: "In den WEB.DE-Einstellungen „POP3/IMAP-Abruf“ erlauben." },
  { id: "telekom", name: "Telekom (t-online.de)", host: "secureimap.t-online.de", port: 993, hinweis: "Eigenes E-Mail-Passwort aus dem Telekom-Kundencenter verwenden." },
  { id: "gmail", name: "Gmail / Google Workspace", host: "imap.gmail.com", port: 993, hinweis: "Ein App-Passwort anlegen (Google-Konto → Sicherheit → App-Passwörter); das normale Passwort geht nicht." },
  { id: "icloud", name: "iCloud Mail", host: "imap.mail.me.com", port: 993, hinweis: "Ein app-spezifisches Passwort unter appleid.apple.com anlegen." },
  { id: "microsoft", name: "Microsoft 365 / Outlook.com", host: "outlook.office365.com", port: 993, gesperrt: true, hinweis: "Microsoft erlaubt die Anmeldung per Passwort nicht mehr. Bitte „Outlook-Entwurf (.eml)“ nutzen." },
  { id: "andere", name: "Anderer Anbieter (IMAP)", host: "", port: 993 },
];

const kfg = () => join(paths().get("userData"), "mail-entwurf-postfach.json");
const geheim = () => join(paths().get("userData"), "mail-entwurf-postfach.bin");

export function postfachStand(): PostfachStand {
  try {
    if (!existsSync(kfg()) || !existsSync(geheim())) return { eingerichtet: false };
    return { ...(JSON.parse(readFileSync(kfg(), "utf8")) as PostfachEinstellung), eingerichtet: true };
  } catch {
    return { eingerichtet: false };
  }
}

function passwort(): string | null {
  try {
    if (!credentials().isEncryptionAvailable()) return null;
    return credentials().decryptString(readFileSync(geheim()));
  } catch {
    return null;
  }
}

function einstellungSchreiben(e: PostfachEinstellung): void {
  const tmp = `${kfg()}.tmp`;
  writeFileSync(tmp, JSON.stringify(e, null, 2));
  renameSync(tmp, kfg());
}

export function postfachEntfernen(): void {
  rmSync(kfg(), { force: true });
  rmSync(geheim(), { force: true });
}

/** Entwürfe-Ordner finden: RFC 6154 \Drafts, sonst übliche Namen. */
export function entwuerfeOrdner(liste: Array<{ path: string; specialUse?: string; flags?: Set<string> | string[] }>): string | null {
  for (const m of liste) {
    const flags = Array.isArray(m.flags) ? m.flags : m.flags ? [...m.flags] : [];
    if (m.specialUse === "\\Drafts" || flags.includes("\\Drafts")) return m.path;
  }
  const nachName = new Map(liste.map((m) => [m.path.toLowerCase(), m.path]));
  for (const k of ["Drafts", "Entwürfe", "Entwurf", "INBOX.Drafts", "INBOX/Drafts", "INBOX.Entwürfe", "[Gmail]/Drafts", "[Gmail]/Entwürfe", "Concepts"]) {
    const t = nachName.get(k.toLowerCase());
    if (t) return t;
  }
  return null;
}

interface ImapClient {
  connect(): Promise<void>;
  list(): Promise<Array<{ path: string; specialUse?: string; flags?: Set<string> | string[] }>>;
  append(path: string, content: Buffer, flags?: string[], idate?: Date): Promise<unknown>;
  logout(): Promise<void>;
}

/** Für Tests austauschbar. */
export type ImapFabrik = (opts: { host: string; port: number; secure: boolean; user: string; pass: string }) => Promise<ImapClient>;

const standardFabrik: ImapFabrik = async ({ host, port, secure, user, pass }) => {
  const { ImapFlow } = (await import("imapflow")) as unknown as { ImapFlow: new (o: Record<string, unknown>) => ImapClient };
  return new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false, emitLogs: false, socketTimeout: 30_000 });
};

async function mitVerbindung<T>(e: Pick<PostfachEinstellung, "host" | "port" | "secure" | "benutzer">, pass: string, fn: (c: ImapClient) => Promise<T>, fabrik: ImapFabrik): Promise<T> {
  const c = await fabrik({ host: e.host, port: e.port, secure: e.secure, user: e.benutzer, pass });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => undefined);
  }
}

function lesbar(err: unknown): string {
  const t = err instanceof Error ? err.message : String(err);
  if (/auth|login|credential|invalid/i.test(t)) return "Anmeldung abgelehnt. Benutzername und Passwort prüfen (bei Gmail und iCloud ein App-Passwort).";
  if (/ENOTFOUND|getaddrinfo/i.test(t)) return "Server nicht gefunden. Adresse prüfen.";
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(t)) return "Server nicht erreichbar (Port oder Verschlüsselung prüfen).";
  return t;
}

/**
 * Speichert die Verbindung erst, wenn Anmeldung und Entwürfe-Ordner klappen.
 * `pass` leer = gespeichertes Passwort behalten (nur Einstellungen ändern).
 */
export async function postfachEinrichten(
  e: Omit<PostfachEinstellung, "ordner" | "geprueft">,
  pass: string,
  fabrik: ImapFabrik = standardFabrik,
): Promise<{ ok: true; stand: PostfachStand } | { ok: false; fehler: string }> {
  const anbieter = POSTFACH_ANBIETER.find((a) => a.id === e.anbieter);
  if (anbieter?.gesperrt) return { ok: false, fehler: anbieter.hinweis ?? "Bei diesem Anbieter geht es nicht per Passwort." };
  if (!e.host || !e.benutzer || !e.absender) return { ok: false, fehler: "Server, Benutzername und Absenderadresse sind nötig." };
  if (!credentials().isEncryptionAvailable()) return { ok: false, fehler: "Passwörter lassen sich hier nicht verschlüsselt speichern." };
  const pw = pass || passwort();
  if (!pw) return { ok: false, fehler: "Passwort fehlt." };
  try {
    const ordner = await mitVerbindung(e, pw, async (c) => entwuerfeOrdner(await c.list()), fabrik);
    if (!ordner) return { ok: false, fehler: "Anmeldung klappt, aber kein Entwürfe-Ordner gefunden." };
    if (pass) writeFileSync(geheim(), credentials().encryptString(pass), { mode: 0o600 });
    einstellungSchreiben({ ...e, ordner, geprueft: new Date().toISOString() });
    return { ok: true, stand: postfachStand() };
  } catch (err) {
    return { ok: false, fehler: lesbar(err) };
  }
}

/** Legt die fertige Mail (MIME) als Entwurf ab. */
export async function entwurfAblegen(mime: Buffer, fabrik: ImapFabrik = standardFabrik): Promise<{ ordner: string }> {
  const s = postfachStand();
  if (!s.eingerichtet) throw new Error("Kein Entwurfs-Postfach eingerichtet (Einstellungen → Mail-Entwürfe).");
  const pw = passwort();
  if (!pw) throw new Error("Das Passwort des Entwurfs-Postfachs ist nicht lesbar. Bitte in den Einstellungen neu eingeben.");
  try {
    return await mitVerbindung(
      s,
      pw,
      async (c) => {
        const ordner = s.ordner ?? entwuerfeOrdner(await c.list());
        if (!ordner) throw new Error("Kein Entwürfe-Ordner gefunden.");
        await c.append(ordner, mime, ["\\Draft", "\\Seen"], new Date());
        return { ordner };
      },
      fabrik,
    );
  } catch (err) {
    throw new Error(lesbar(err));
  }
}

/** Absender im Entwurf: „Name <adresse>“. */
export function postfachAbsender(s: PostfachStand): string | null {
  if (!s.eingerichtet) return null;
  return s.name ? `"${s.name.replace(/"/g, "")}" <${s.absender}>` : s.absender;
}
