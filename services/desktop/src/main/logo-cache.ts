// Firmenlogos (docs/PLAN_FIRMENLOGOS.md, LG3): Bilder fuer `ava-logo://<sha256>`.
//
// Der Renderer darf Bilder nur von eigenen Protokollen laden (Seitenrichtlinie img-src). Das
// Protokoll holt ein Logo einmal mit der Anmeldung des Nutzers vom Gateway (/v1/logos/<sha256>)
// und legt es dauerhaft im geraeteweiten Ordner ab: Die Adresse ist die Pruefsumme des Inhalts,
// ein einmal geladenes Bild aendert sich nie. Bewusst ohne electron-Import (der Handler wird in
// index.ts angemeldet), damit die Logik ohne Electron pruefbar bleibt.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENDUNG: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/x-icon": "ico", "image/svg+xml": "svg" };
const MIME: Record<string, string> = Object.fromEntries(Object.entries(ENDUNG).map(([m, e]) => [e, m]));
const MAX_BYTES = 300_000;
const RUHE_NACH_FEHLER_MS = 5 * 60_000;

export interface LogoQuelle {
  /** Ordner fuer den Zwischenspeicher (geraeteweit, nicht je Konto: Logos sind fuer alle gleich). */
  ordner: string;
  gatewayUrl: string;
  getAccessToken: () => Promise<string | null>;
  /** Nur fuer Tests. */
  fetchFn?: typeof fetch;
  jetzt?: () => number;
}

export interface LogoBild {
  inhalt: Buffer;
  mime: string;
}

const fehlschlaege = new Map<string, number>();
const laufend = new Map<string, Promise<LogoBild | null>>();

/** Nur fuer Tests. */
export function logoCacheLeeren(): void {
  fehlschlaege.clear();
  laufend.clear();
}

function ausOrdner(ordner: string, sha256: string): LogoBild | null {
  for (const [endung, mime] of Object.entries(MIME)) {
    const pfad = join(ordner, `${sha256}.${endung}`);
    if (existsSync(pfad)) {
      try {
        return { inhalt: readFileSync(pfad), mime };
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function vomGateway(sha256: string, q: LogoQuelle): Promise<LogoBild | null> {
  const token = await q.getAccessToken().catch(() => null);
  if (!token) return null;
  const res = await (q.fetchFn ?? fetch)(`${q.gatewayUrl.replace(/\/+$/, "")}/v1/logos/${sha256}`, {
    headers: { authorization: `Bearer ${token}`, accept: "image/*" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const endung = ENDUNG[mime];
  if (!endung) return null;
  const inhalt = Buffer.from(await res.arrayBuffer());
  if (inhalt.length === 0 || inhalt.length > MAX_BYTES) return null;
  try {
    mkdirSync(q.ordner, { recursive: true });
    const ziel = join(q.ordner, `${sha256}.${endung}`);
    const vorlaeufig = `${ziel}.${process.pid}.tmp`;
    writeFileSync(vorlaeufig, inhalt);
    renameSync(vorlaeufig, ziel);
  } catch {
    /* Ohne Schreibrecht wird das Bild eben jedes Mal geholt. */
  }
  return { inhalt, mime };
}

/** Logo aus dem Ordner, sonst vom Gateway; nach einem Fehlschlag fuenf Minuten Ruhe je Bild. */
export async function logoLaden(sha256: string, q: LogoQuelle): Promise<LogoBild | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const lokal = ausOrdner(q.ordner, sha256);
  if (lokal) return lokal;
  const jetzt = (q.jetzt ?? Date.now)();
  const zuletzt = fehlschlaege.get(sha256);
  if (zuletzt !== undefined && jetzt - zuletzt < RUHE_NACH_FEHLER_MS) return null;
  const schon = laufend.get(sha256);
  if (schon) return schon;
  const lauf = vomGateway(sha256, q)
    .catch(() => null)
    .then((bild) => {
      if (bild) fehlschlaege.delete(sha256);
      else fehlschlaege.set(sha256, (q.jetzt ?? Date.now)());
      return bild;
    })
    .finally(() => laufend.delete(sha256));
  laufend.set(sha256, lauf);
  return lauf;
}

/** Antwort fuer den Protokoll-Handler: `ava-logo://<sha256>` (eine Endung am Ende wird ignoriert). */
export async function logoAntwort(anfrageUrl: string, q: LogoQuelle): Promise<Response> {
  let sha256 = "";
  try {
    const u = new URL(anfrageUrl);
    sha256 = (u.host || u.pathname.replace(/^\/+/, "")).toLowerCase().replace(/\.[a-z]+$/, "");
  } catch {
    /* unten 404 */
  }
  const bild = await logoLaden(sha256, q);
  if (!bild) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(bild.inhalt), {
    status: 200,
    headers: {
      "content-type": bild.mime,
      "cache-control": "max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      // SVG wird nur als Bild eingebunden; beim direkten Oeffnen fuehrt es nichts aus.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
