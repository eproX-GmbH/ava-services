// Gesellschafterlisten (docs/PLAN_VERFLECHTUNGEN.md §4 Schritt 2, §8 Nr. 1):
// Pruefung einer vom Registerportal geladenen Datei. Erlaubt sind nur PDF,
// TIFF und ZIP (mit genau einer PDF- oder TIFF-Datei) bis 20 MB, erkannt an
// den Magic Bytes, nie am Dateinamen. Nichts wird ausgefuehrt oder entpackt
// auf Platte; ZIP wird im Speicher gelesen.

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export const DOKUMENT_MAX_BYTES = 20 * 1024 * 1024;

export type DokumentArt = "pdf" | "tiff";

export type GeprueftesDokument = {
  art: DokumentArt;
  mime: "application/pdf" | "image/tiff";
  bytes: Buffer;
  sha256: string;
  /** Dateiname im ZIP, sonst der Download-Name */
  dateiname: string;
};

export function erkenneArt(bytes: Buffer): DokumentArt | "zip" | null {
  if (bytes.length < 8) return null;
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const kopf = bytes.subarray(0, 4);
  if ((kopf[0] === 0x49 && kopf[1] === 0x49 && kopf[2] === 0x2a && kopf[3] === 0x00) || (kopf[0] === 0x4d && kopf[1] === 0x4d && kopf[2] === 0x00 && kopf[3] === 0x2a)) return "tiff";
  if (kopf[0] === 0x50 && kopf[1] === 0x4b && (kopf[2] === 0x03 || kopf[2] === 0x05 || kopf[2] === 0x07)) return "zip";
  return null;
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * ZIP im Speicher ohne Bibliothek: Zentralverzeichnis vom Ende her lesen
 * (die ZIPs des Registerportals haben einen fehlerhaften Kommentar-Laengen-
 * Eintrag, an dem strikte Parser wie yauzl scheitern). Genommen wird die
 * erste Datei, deren Inhalt PDF oder TIFF ist; nur "stored" und "deflate".
 */
async function ausZip(bytes: Buffer): Promise<{ bytes: Buffer; name: string } | null> {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const LOC = 0x04034b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70_000); i--) {
    if (bytes.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP ohne Zentralverzeichnis");
  const anzahl = bytes.readUInt16LE(eocd + 10);
  let pos = bytes.readUInt32LE(eocd + 16);
  for (let n = 0; n < anzahl && pos + 46 <= bytes.length; n++) {
    if (bytes.readUInt32LE(pos) !== CEN) break;
    const methode = bytes.readUInt16LE(pos + 10);
    const komprimiert = bytes.readUInt32LE(pos + 20);
    const unkomprimiert = bytes.readUInt32LE(pos + 24);
    const nameLen = bytes.readUInt16LE(pos + 28);
    const extraLen = bytes.readUInt16LE(pos + 30);
    const kommentarLen = bytes.readUInt16LE(pos + 32);
    const lokal = bytes.readUInt32LE(pos + 42);
    const name = bytes.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + kommentarLen;
    if (name.endsWith("/") || unkomprimiert === 0 || unkomprimiert > DOKUMENT_MAX_BYTES) continue;
    if (lokal + 30 > bytes.length || bytes.readUInt32LE(lokal) !== LOC) continue;
    const lokalNameLen = bytes.readUInt16LE(lokal + 26);
    const lokalExtraLen = bytes.readUInt16LE(lokal + 28);
    const start = lokal + 30 + lokalNameLen + lokalExtraLen;
    const roh = bytes.subarray(start, start + komprimiert);
    let inhalt: Buffer;
    if (methode === 0) inhalt = Buffer.from(roh);
    else if (methode === 8) inhalt = inflateRawSync(roh);
    else continue; // andere Verfahren nicht zugelassen
    const art = erkenneArt(inhalt);
    if (art === "pdf" || art === "tiff") return { bytes: inhalt, name: name.split("/").pop() ?? name };
  }
  return null;
}

/**
 * Datei pruefen: Groesse, Magic Bytes, bei ZIP der Inhalt. Wirft bei allem,
 * was keine Gesellschafterliste sein kann (HTML, Skripte, leere Datei).
 */
export async function pruefeDokument(bytes: Buffer, dateiname: string): Promise<GeprueftesDokument> {
  if (bytes.length === 0) throw new Error("leere Datei");
  if (bytes.length > DOKUMENT_MAX_BYTES) throw new Error(`Datei zu gross: ${bytes.length} Bytes`);
  let art = erkenneArt(bytes);
  let inhalt = bytes;
  let name = dateiname;
  if (art === "zip") {
    const e = await ausZip(bytes);
    if (!e) throw new Error("ZIP ohne PDF oder TIFF");
    inhalt = e.bytes;
    name = e.name;
    art = erkenneArt(inhalt);
  }
  if (art !== "pdf" && art !== "tiff") throw new Error(`unerwarteter Dateityp (${bytes.subarray(0, 4).toString("hex")})`);
  return { art, mime: art === "pdf" ? "application/pdf" : "image/tiff", bytes: inhalt, sha256: sha(inhalt), dateiname: name };
}
