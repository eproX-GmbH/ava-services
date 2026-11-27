// Objektspeicher (S3-artig, Wasabi) fuer Dateien, die nicht in die Datenbank gehoeren. Erster
// Nutzer: Firmenlogos (docs/PLAN_FIRMENLOGOS.md, LG2, Entscheidung Joyce 2026-11-27: Bucket
// ava-prod, Region eu-central-2). Nur das Gateway greift zu; die Zugangsdaten liegen als
// Secrets auf Prod- und Staging-Gateway und nie auf Geraeten der Nutzer.
//
// Bewusst ohne das AWS-Paket: eine SigV4-Signatur sind 30 Zeilen, das Gateway braucht nur
// PUT, GET und HEAD. Der Verbindungsaufbau lief im Test vereinzelt in Zeitueberschreitungen,
// deshalb feste Frist und Wiederholungen.

import { createHash, createHmac } from "node:crypto";
import { logger } from "./logger";

export interface ObjektspeicherZugang {
  endpunkt: string;
  region: string;
  bucket: string;
  zugang: string;
  geheimnis: string;
}

/** Zugang aus der Umgebung; null, solange der Speicher nicht eingerichtet ist (dann ruht alles, was ihn braucht). */
export function objektspeicherZugang(env: NodeJS.ProcessEnv = process.env): ObjektspeicherZugang | null {
  const endpunkt = (env.OBJEKTSPEICHER_ENDPUNKT ?? "").trim().replace(/\/+$/, "");
  const region = (env.OBJEKTSPEICHER_REGION ?? "").trim();
  const bucket = (env.OBJEKTSPEICHER_BUCKET ?? "").trim();
  const zugang = (env.OBJEKTSPEICHER_ZUGANG ?? "").trim();
  const geheimnis = (env.OBJEKTSPEICHER_GEHEIMNIS ?? "").trim();
  if (!endpunkt || !region || !bucket || !zugang || !geheimnis) return null;
  if (!/^https:\/\//.test(endpunkt)) return null;
  return { endpunkt, region, bucket, zugang, geheimnis };
}

export const objektspeicherAktiv = (): boolean => objektspeicherZugang() !== null;

const sha = (d: Buffer | string) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

/** Pfad-Segmente kodieren wie S3 es fuer die Signatur erwartet (Schraegstriche bleiben). */
const pfadKodiert = (schluessel: string) => schluessel.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

/** Signierte Kopfzeilen fuer eine Anfrage (AWS Signature Version 4, Dienst s3, Pfad-Stil). */
export function signiere(
  z: ObjektspeicherZugang,
  methode: string,
  schluessel: string,
  koerper: Buffer,
  kopf: Record<string, string> = {},
  jetzt: Date = new Date(),
): { url: string; kopf: Record<string, string> } {
  const host = new URL(z.endpunkt).host;
  const pfad = `/${z.bucket}/${pfadKodiert(schluessel)}`;
  const zeit = jetzt.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const tag = zeit.slice(0, 8);
  const hash = sha(koerper);
  const alle: Record<string, string> = { host, "x-amz-content-sha256": hash, "x-amz-date": zeit };
  for (const [k, v] of Object.entries(kopf)) alle[k.toLowerCase()] = v.trim();
  const namen = Object.keys(alle).sort();
  const kanonisch = [methode, pfad, "", namen.map((n) => `${n}:${alle[n]}\n`).join(""), namen.join(";"), hash].join("\n");
  const bereich = `${tag}/${z.region}/s3/aws4_request`;
  const zuSignieren = ["AWS4-HMAC-SHA256", zeit, bereich, sha(kanonisch)].join("\n");
  const schluesselKette = hmac(hmac(hmac(hmac(`AWS4${z.geheimnis}`, tag), z.region), "s3"), "aws4_request");
  const signatur = createHmac("sha256", schluesselKette).update(zuSignieren).digest("hex");
  const { host: _host, ...sende } = alle;
  return {
    url: `${z.endpunkt}${pfad}`,
    kopf: { ...sende, authorization: `AWS4-HMAC-SHA256 Credential=${z.zugang}/${bereich}, SignedHeaders=${namen.join(";")}, Signature=${signatur}` },
  };
}

const FRIST_MS = 8_000;
const VERSUCHE = 3;

async function anfrage(z: ObjektspeicherZugang, methode: string, schluessel: string, koerper: Buffer, kopf: Record<string, string>): Promise<Response> {
  let letzter: unknown;
  for (let i = 0; i < VERSUCHE; i++) {
    const s = signiere(z, methode, schluessel, koerper, kopf);
    try {
      const res = await fetch(s.url, { method: methode, headers: s.kopf, body: methode === "PUT" ? new Uint8Array(koerper) : undefined, signal: AbortSignal.timeout(FRIST_MS) });
      // 5xx und 429 sind voruebergehend; alles andere entscheidet der Aufrufer.
      if (res.status < 500 && res.status !== 429) return res;
      letzter = new Error(`Objektspeicher antwortet ${res.status}`);
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      letzter = err;
    }
    if (i < VERSUCHE - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw letzter instanceof Error ? letzter : new Error(String(letzter));
}

/** Gibt es das Objekt schon? (Inhalts-adressierte Schluessel muessen nicht neu geschrieben werden.) */
export async function objektVorhanden(schluessel: string, z = objektspeicherZugang()): Promise<boolean> {
  if (!z) return false;
  const res = await anfrage(z, "HEAD", schluessel, Buffer.alloc(0), {});
  return res.status === 200;
}

export async function objektAblegen(schluessel: string, inhalt: Buffer, mime: string, z = objektspeicherZugang()): Promise<void> {
  if (!z) throw new Error("Objektspeicher ist nicht eingerichtet");
  const res = await anfrage(z, "PUT", schluessel, inhalt, { "content-type": mime, "cache-control": "private, max-age=31536000, immutable" });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`Objektspeicher: Ablegen von ${schluessel} scheiterte (${res.status}) ${text}`);
  }
  await res.arrayBuffer().catch(() => undefined);
}

export async function objektHolen(schluessel: string, z = objektspeicherZugang()): Promise<{ inhalt: Buffer; mime: string | null } | null> {
  if (!z) return null;
  const res = await anfrage(z, "GET", schluessel, Buffer.alloc(0), {});
  if (res.status === 404) return null;
  if (!res.ok) {
    logger.warn({ schluessel, status: res.status }, "[objektspeicher] Lesen scheiterte");
    return null;
  }
  return { inhalt: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") };
}
