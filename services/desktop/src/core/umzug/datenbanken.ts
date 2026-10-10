// Eingebettete Datenbanken (PGlite) für den Umzug (docs/PLAN_AVA_CLOUD.md §13.3).
//
// Jeder Store, der eine PGlite-Instanz öffnet, meldet sie hier an. Der Umzug
// zieht davon im laufenden Betrieb einen konsistenten Abzug (`dumpDataDir`),
// statt die Dateien einer offenen Datenbank zu kopieren. Ist eine Datenbank
// nicht geöffnet, sind ihre Dateien ruhend und werden direkt kopiert.

import { resolve } from "node:path";

interface Dumpbar {
  dumpDataDir?: (compression?: "auto" | "gzip" | "none") => Promise<Blob | File>;
}

const dumper = new Map<string, () => Promise<Blob | File>>();

export function registriereDatenbank(verzeichnis: string, instanz: unknown): void {
  const d = instanz as Dumpbar;
  if (typeof d?.dumpDataDir !== "function") return;
  dumper.set(resolve(verzeichnis), () => d.dumpDataDir!("gzip"));
}

export function abmeldenDatenbank(verzeichnis: string): void {
  dumper.delete(resolve(verzeichnis));
}

/** Abzug einer offenen Datenbank; null, wenn sie nicht geöffnet ist. */
export async function datenbankAbzug(verzeichnis: string): Promise<Buffer | null> {
  const f = dumper.get(resolve(verzeichnis));
  if (!f) return null;
  try {
    const blob = await f();
    return Buffer.from(await blob.arrayBuffer());
  } catch {
    // Geschlossen oder beim Beenden: ruhende Dateien werden dann direkt kopiert.
    return null;
  }
}

/** Datenbank aus einem Abzug in ein leeres Verzeichnis einspielen (beim Start, vor den Stores). */
export async function datenbankEinspielen(verzeichnis: string, abzug: Buffer): Promise<void> {
  const mod = (await import("@electric-sql/pglite")) as unknown as {
    PGlite: new (pfad: string, opts: { loadDataDir: Blob }) => { waitReady: Promise<void>; close(): Promise<void> };
  };
  const db = new mod.PGlite(verzeichnis, { loadDataDir: new Blob([new Uint8Array(abzug)]) });
  await db.waitReady;
  await db.close();
}
