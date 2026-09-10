// M2 (docs/PLAN_EMAIL_MUSTER.md) — Existenzpruefung einer Adresse per
// SMTP-Handshake bis RCPT TO, ohne Zustellung (nie DATA). Laeuft lokal auf
// dem Geraet des Nutzers; viele Netze sperren Port 25 → pruefePort25().

import { promises as dns } from "node:dns";
import net from "node:net";
import tls from "node:tls";

export type PruefErgebnis = "existiert" | "existiert_nicht" | "unbekannt" | "catch_all" | "gesperrt";

export interface PruefDetails {
  ergebnis: PruefErgebnis;
  mx: string | null;
  code: number | null;
  antwort: string | null;
  dauerMs: number;
}

const EHLO_NAME = "ava-check.local";
const CONNECT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 10_000;

export async function mxHosts(domain: string): Promise<string[]> {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length > 0) return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).filter((h) => h && h !== ".");
  } catch {
    /* kein MX */
  }
  try {
    const a = await dns.resolve4(domain);
    return a.length > 0 ? [domain] : [];
  } catch {
    return [];
  }
}

interface SmtpSocket {
  write: (s: string) => void;
  read: () => Promise<{ code: number; text: string }>;
  upgradeTls: () => Promise<void>;
  end: () => void;
}

function verbinde(host: string, servername: string): Promise<SmtpSocket> {
  return new Promise((resolve, reject) => {
    let sock: net.Socket | tls.TLSSocket = net.createConnection({ host, port: 25 });
    let buf = "";
    let waiter: { resolve: (r: { code: number; text: string }) => void; reject: (e: Error) => void } | null = null;
    let timer: NodeJS.Timeout | null = null;
    const armTimeout = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => waiter?.reject(new Error("smtp read timeout")), READ_TIMEOUT_MS);
    };
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      // Antwort komplett, wenn die letzte Zeile "NNN " (Leerzeichen nach dem Code) hat.
      const lines = buf.split(/\r?\n/).filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        const code = Number(last.slice(0, 3));
        const text = lines.join("\n");
        buf = "";
        if (timer) clearTimeout(timer);
        const w = waiter;
        waiter = null;
        w?.resolve({ code, text });
      }
    };
    const attach = (s: net.Socket | tls.TLSSocket): void => {
      s.on("data", onData);
      s.on("error", (e) => waiter?.reject(e));
      s.on("close", () => waiter?.reject(new Error("smtp connection closed")));
    };
    const connectTimer = setTimeout(() => {
      sock.destroy();
      reject(new Error("smtp connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    sock.once("error", (e) => {
      clearTimeout(connectTimer);
      reject(e);
    });
    sock.once("connect", () => {
      clearTimeout(connectTimer);
      attach(sock);
      resolve({
        write: (s: string) => {
          sock.write(s + "\r\n");
        },
        read: () =>
          new Promise((res, rej) => {
            waiter = { resolve: res, reject: rej };
            armTimeout();
          }),
        upgradeTls: () =>
          new Promise((res, rej) => {
            const plain = sock as net.Socket;
            plain.removeAllListeners("data");
            const secure = tls.connect({ socket: plain, servername, rejectUnauthorized: false }, () => {
              sock = secure;
              attach(secure);
              res();
            });
            secure.once("error", rej);
          }),
        end: () => {
          try {
            sock.end();
          } catch {
            /* egal */
          }
        },
      });
    });
  });
}

/**
 * Handshake bis RCPT TO fuer `adressen` (max 5) am gleichen MX. Liefert je
 * Adresse das Ergebnis. `catchAllProbe` (zufaellige Adresse) wird zuerst
 * geprueft: antwortet der Server 250, ist alles "catch_all".
 */
export async function pruefeAdressen(domain: string, adressen: string[], opts: { catchAllProbe?: string; log?: (m: string) => void } = {}): Promise<Map<string, PruefDetails>> {
  const out = new Map<string, PruefDetails>();
  const start = Date.now();
  const setzeAlle = (ergebnis: PruefErgebnis, mx: string | null, code: number | null, antwort: string | null): Map<string, PruefDetails> => {
    for (const a of adressen) out.set(a, { ergebnis, mx, code, antwort, dauerMs: Date.now() - start });
    return out;
  };
  const hosts = await mxHosts(domain);
  if (hosts.length === 0) return setzeAlle("existiert_nicht", null, null, "kein MX-/A-Eintrag");
  let sock: SmtpSocket | null = null;
  let mx: string | null = null;
  let letzterFehler = "";
  for (const h of hosts.slice(0, 2)) {
    try {
      sock = await verbinde(h, h);
      mx = h;
      break;
    } catch (e) {
      letzterFehler = e instanceof Error ? e.message : String(e);
      opts.log?.(`smtp ${h}: ${letzterFehler}`);
    }
  }
  if (!sock || !mx) {
    const gesperrt = /timeout|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(letzterFehler);
    return setzeAlle(gesperrt ? "gesperrt" : "unbekannt", null, null, letzterFehler);
  }
  try {
    const greeting = await sock.read();
    if (greeting.code !== 220) return setzeAlle("unbekannt", mx, greeting.code, greeting.text);
    sock.write(`EHLO ${EHLO_NAME}`);
    let ehlo = await sock.read();
    if (ehlo.code !== 250) {
      sock.write(`HELO ${EHLO_NAME}`);
      ehlo = await sock.read();
      if (ehlo.code !== 250) return setzeAlle("unbekannt", mx, ehlo.code, ehlo.text);
    }
    if (/STARTTLS/i.test(ehlo.text)) {
      sock.write("STARTTLS");
      const st = await sock.read();
      if (st.code === 220) {
        await sock.upgradeTls();
        sock.write(`EHLO ${EHLO_NAME}`);
        await sock.read();
      }
    }
    sock.write("MAIL FROM:<>");
    const mf = await sock.read();
    if (mf.code !== 250) return setzeAlle("unbekannt", mx, mf.code, mf.text);
    const rcpt = async (adr: string): Promise<{ code: number; text: string }> => {
      sock!.write(`RCPT TO:<${adr}>`);
      return sock!.read();
    };
    if (opts.catchAllProbe) {
      const p = await rcpt(opts.catchAllProbe);
      if (p.code >= 250 && p.code < 260) return setzeAlle("catch_all", mx, p.code, p.text);
    }
    for (const a of adressen.slice(0, 5)) {
      const r = await rcpt(a);
      const ergebnis: PruefErgebnis = r.code >= 250 && r.code < 260 ? "existiert" : r.code === 550 || r.code === 551 || r.code === 553 || r.code === 554 ? "existiert_nicht" : "unbekannt";
      out.set(a, { ergebnis, mx, code: r.code, antwort: r.text.slice(0, 200), dauerMs: Date.now() - start });
      await new Promise((r2) => setTimeout(r2, 2_000));
    }
    sock.write("QUIT");
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const a of adressen) if (!out.has(a)) out.set(a, { ergebnis: "unbekannt", mx, code: null, antwort: msg, dauerMs: Date.now() - start });
    return out;
  } finally {
    sock.end();
  }
}

/** Ist Port 25 aus diesem Netz erreichbar? Test gegen bekannte MX-Hosts. */
export async function pruefePort25(testDomains: string[] = ["gmail.com", "outlook.com"]): Promise<{ erreichbar: boolean; grund: string }> {
  let grund = "";
  for (const d of testDomains) {
    const hosts = await mxHosts(d);
    for (const h of hosts.slice(0, 1)) {
      try {
        const s = await verbinde(h, h);
        const g = await s.read();
        s.write("QUIT");
        s.end();
        if (g.code === 220) return { erreichbar: true, grund: `${h} antwortet` };
        grund = `${h}: ${g.code}`;
      } catch (e) {
        grund = `${h}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  return { erreichbar: false, grund: grund || "kein MX erreichbar" };
}

export function zufallsAdresse(domain: string): string {
  const r = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);
  return `ava-${r}@${domain}`;
}
