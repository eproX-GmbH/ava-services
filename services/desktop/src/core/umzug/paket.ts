// Umzugspaket (docs/PLAN_AVA_CLOUD.md §13.3): alles, was AVA lokal hält, als
// Folge von Einträgen; Geheimnisse im Klartext (das Paket selbst wird Ende-zu-
// Ende verschlüsselt übertragen) und auf dem Ziel mit dessen Ablage neu
// verschlüsselt.
//
// Eintrag: [u32 Länge Kopf][Kopf-JSON][Inhalt]
//   Kopf: { p: relativer Pfad, a: Art, n: Inhaltslänge, f?: Form }
//   Arten:  "d"  Datei unverändert
//           "s"  Geheimnis-Datei (Inhalt = Klartext), f = "raw" | "b64"
//           "j"  JSON mit Geheimnis-Feldern ({"__umzugGeheimnis": Klartext})
//           "g"  Datenbank-Abzug (PGlite, gzip-Tar) für das Verzeichnis p
//
// Nicht übertragen werden Browser-Caches und -Sitzungen sowie alles, was an
// diese Instanz gebunden ist (Anmeldung, Instanz-ID, Telegram-Bot, Abo-Anmeldungen
// bei OpenAI und Anthropic, Logs, Browser-Fassung). Dieselbe Liste schützt diese
// Teile auf dem Ziel vor dem Überschreiben.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { credentials } from "../platform";
import { datenbankAbzug } from "./datenbanken";

/** Oberste Einträge des Datenverzeichnisses, die nie umziehen und nie überschrieben werden. */
export const NICHT_UMZIEHEN = new Set([
  // Browser-Caches und Electron-Sitzungen (LinkedIn-Anmeldung, Login-Fenster)
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Partitions",
  "Local Storage",
  "Session Storage",
  "WebStorage",
  "Service Worker",
  "Shared Dictionary",
  "shared_proto_db",
  "Trust Tokens",
  "Network Persistent State",
  "Conversions",
  "blob_storage",
  "IndexedDB",
  "Cookies",
  "Cookies-journal",
  "Preferences",
  "TransportSecurity",
  "Network",
  "Crashpad",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  // Instanzgebunden
  "instanz.json",
  "auth.bin",
  "identity.json",
  "oidc-discovery.json",
  "siwc-host.json",
  "telegram",
  "logs",
  "chrome-for-testing",
  "producer-logs",
  "worker-modus-start.flag",
  "auto-neustarts.json",
  "tenant-switch.json",
  "pending-install.json",
  "ava-heartbeat.txt",
  // Umzug selbst
  ".umzug-eingang",
  ".umzug-alt",
  "umzug-letzter.json",
]);

/** Einzelne Dateien in Unterordnern, die instanzgebunden sind. */
export const NICHT_UMZIEHEN_PFADE = new Set([
  ["agent", "openai-subscription.enc"].join("/"),
  ["agent", "anthropic-subscription.enc"].join("/"),
  ["register-delta", "worker.token"].join("/"),
]);

export interface PaketKopf {
  p: string;
  a: "d" | "s" | "j" | "g";
  n: number;
  f?: "raw" | "b64";
}

const GEHEIMNIS_MARKE = "__umzugGeheimnis";

function relPosix(basis: string, pfad: string): string {
  return relative(basis, pfad).split(sep).join("/");
}

function istAusgeschlossen(rel: string): boolean {
  const erstes = rel.split("/")[0] ?? rel;
  if (NICHT_UMZIEHEN.has(erstes)) return true;
  if (NICHT_UMZIEHEN_PFADE.has(rel)) return true;
  // Chrome-Profile der Producer und temporäre Dateien
  if (/(^|\/)ava-chrome-[^/]*($|\/)/.test(rel)) return true;
  return false;
}

/** Versucht eine Geheimnis-Datei zu entschlüsseln; liefert Klartext und Form oder null. */
function entschluesseleDatei(inhalt: Buffer): { klar: string; form: "raw" | "b64" } | null {
  try {
    return { klar: credentials().decryptString(inhalt), form: "raw" };
  } catch {
    /* evtl. Base64-Text */
  }
  const text = inhalt.toString("utf8").trim();
  if (/^[A-Za-z0-9+/=_-]{16,}$/.test(text)) {
    try {
      return { klar: credentials().decryptString(Buffer.from(text, "base64")), form: "b64" };
    } catch {
      /* kein Geheimnis */
    }
  }
  return null;
}

/** Ersetzt verschlüsselte Base64-Werte in JSON durch {__umzugGeheimnis: Klartext}; liefert null, wenn keiner drin ist. */
function entschluesseleJson(wert: unknown): { wert: unknown; treffer: number } {
  let treffer = 0;
  const gehe = (v: unknown): unknown => {
    if (typeof v === "string" && v.length >= 24 && /^[A-Za-z0-9+/=]+$/.test(v)) {
      try {
        const klar = credentials().decryptString(Buffer.from(v, "base64"));
        treffer += 1;
        return { [GEHEIMNIS_MARKE]: klar };
      } catch {
        return v;
      }
    }
    if (Array.isArray(v)) return v.map(gehe);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = gehe(x);
      return o;
    }
    return v;
  };
  return { wert: gehe(wert), treffer };
}

/** Verschlüsselt {__umzugGeheimnis} zurück mit der Ablage dieser Instanz. */
export function verschluesseleJson(wert: unknown): unknown {
  if (Array.isArray(wert)) return wert.map(verschluesseleJson);
  if (wert && typeof wert === "object") {
    const o = wert as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o[GEHEIMNIS_MARKE] === "string") {
      return credentials().encryptString(o[GEHEIMNIS_MARKE] as string).toString("base64");
    }
    const neu: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) neu[k] = verschluesseleJson(x);
    return neu;
  }
  return wert;
}

export function eintrag(kopf: PaketKopf, inhalt: Buffer): Buffer {
  const k = Buffer.from(JSON.stringify(kopf), "utf8");
  const laenge = Buffer.alloc(4);
  laenge.writeUInt32BE(k.length, 0);
  return Buffer.concat([laenge, k, inhalt]);
}

export interface PaketStatistik {
  dateien: number;
  geheimnisse: number;
  datenbanken: number;
  bytes: number;
}

/**
 * Erzeugt die Einträge des Pakets nacheinander (kein Gesamtpaket im Speicher).
 * `statistik` wird während des Durchlaufs gefüllt.
 */
export async function* paketEintraege(datenverzeichnis: string, statistik: PaketStatistik): AsyncGenerator<Buffer> {
  const stapel: string[] = [datenverzeichnis];
  while (stapel.length) {
    const ordner = stapel.pop()!;
    let namen: string[];
    try {
      namen = readdirSync(ordner);
    } catch {
      continue;
    }
    for (const name of namen.sort()) {
      const pfad = join(ordner, name);
      const rel = relPosix(datenverzeichnis, pfad);
      if (istAusgeschlossen(rel)) continue;
      let st;
      try {
        st = statSync(pfad);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (existsSync(join(pfad, "PG_VERSION"))) {
          const abzug = await datenbankAbzug(pfad);
          if (abzug) {
            statistik.datenbanken += 1;
            statistik.bytes += abzug.length;
            yield eintrag({ p: rel, a: "g", n: abzug.length }, abzug);
            continue;
          }
          // Nicht geöffnet: Dateien ruhen und werden direkt kopiert.
        }
        stapel.push(pfad);
        continue;
      }
      if (!st.isFile()) continue;
      let inhalt: Buffer;
      try {
        inhalt = readFileSync(pfad);
      } catch {
        continue;
      }
      if (/\.(enc|bin)$/.test(name)) {
        const g = entschluesseleDatei(inhalt);
        if (g) {
          const klar = Buffer.from(g.klar, "utf8");
          statistik.geheimnisse += 1;
          statistik.bytes += klar.length;
          yield eintrag({ p: rel, a: "s", n: klar.length, f: g.form }, klar);
          continue;
        }
      }
      if (name.endsWith(".json") && inhalt.length < 5 * 1024 * 1024) {
        try {
          const { wert, treffer } = entschluesseleJson(JSON.parse(inhalt.toString("utf8")));
          if (treffer > 0) {
            const j = Buffer.from(JSON.stringify(wert), "utf8");
            statistik.geheimnisse += treffer;
            statistik.bytes += j.length;
            yield eintrag({ p: rel, a: "j", n: j.length }, j);
            continue;
          }
        } catch {
          /* kein JSON, unverändert */
        }
      }
      statistik.dateien += 1;
      statistik.bytes += inhalt.length;
      yield eintrag({ p: rel, a: "d", n: inhalt.length }, inhalt);
    }
  }
}

/** Liest Einträge aus einem fortlaufenden Byte-Strom (Teile beliebig geschnitten). */
export class PaketLeser {
  private teile: Buffer[] = [];
  private laenge = 0;
  /** Bytes, die für den nächsten Eintrag mindestens vorliegen müssen (0 = unbekannt). */
  private bedarf = 4;

  constructor(private readonly aufEintrag: (kopf: PaketKopf, inhalt: Buffer) => void) {}

  private zusammen(): Buffer {
    if (this.teile.length > 1) this.teile = [Buffer.concat(this.teile, this.laenge)];
    return this.teile[0] ?? Buffer.alloc(0);
  }

  schreibe(teil: Buffer): void {
    this.teile.push(teil);
    this.laenge += teil.length;
    // Erst zusammenfügen, wenn genug für den nächsten Schritt da ist (große Inhalte ohne quadratisches Kopieren).
    while (this.laenge >= this.bedarf) {
      const b = this.zusammen();
      const kl = b.readUInt32BE(0);
      if (b.length < 4 + kl) {
        this.bedarf = 4 + kl;
        return;
      }
      const kopf = JSON.parse(b.subarray(4, 4 + kl).toString("utf8")) as PaketKopf;
      const ende = 4 + kl + kopf.n;
      if (b.length < ende) {
        this.bedarf = ende;
        return;
      }
      this.aufEintrag(kopf, Buffer.from(b.subarray(4 + kl, ende)));
      const rest = b.subarray(ende);
      this.teile = rest.length ? [Buffer.from(rest)] : [];
      this.laenge = rest.length;
      this.bedarf = 4;
    }
  }

  restlos(): boolean {
    return this.laenge === 0;
  }
}
