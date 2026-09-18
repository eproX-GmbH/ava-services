// Eigener Browser für die Hintergrundverarbeitung: Chrome for Testing.
//
// Warum (docs/ANALYSE_CHROME_PROZESSE.md, D10 und L5): Bisher startete AVA die
// Chrome-Installation der Person. Für macOS sind die Hintergrundinstanzen damit
// Teil derselben Anwendung wie ihr sichtbares Fenster — beim Herunterfahren
// fordert das System "Google Chrome" zum Beenden auf und wartet auf eine
// Antwort, die eine Instanz ohne Oberfläche nie gibt. Das ist der direkte
// Auslöser der Meldung, Google Chrome lasse sich nicht beenden.
//
// Chrome for Testing ist eine eigenständige Fassung von Google, gedacht für
// automatisierte Abläufe. Sie trägt eine eigene Programmkennung
// (com.google.chrome.for.testing) und einen eigenen Namen. Damit gilt:
//
//   - Das Betriebssystem zählt AVAs Browser nicht mehr zur Anwendung der
//     Person. Herunterfahren, Abmelden und "Alle Fenster schließen" der Person
//     berühren ihn nicht, und er hält nichts davon auf.
//   - Verwechslungen sind ausgeschlossen: Der Prozess heißt anders, liegt in
//     einem AVA-Ordner und trägt zusätzlich den Schalter --ava-browser.
//   - Browser und Treiber stammen aus demselben Paket und passen immer
//     zusammen. Das beseitigt die wiederkehrenden Versionskonflikte zwischen
//     Chrome und chromedriver.
//
// Die Fassung wird nicht mitgeliefert (rund 160 MB), sondern einmalig geladen.
// Schlägt das fehl, arbeitet AVA weiter wie bisher mit dem Browser der Person;
// die Verarbeitung fällt dadurch nie aus.

import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const execFileP = promisify(execFile);

/**
 * Bezugsquelle. Nur diese beiden Hosts werden angesprochen, beide von Google
 * betrieben; die Liste ist bewusst hier und nicht aufrufbar von außen.
 */
const VERSIONEN_URL = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const ERLAUBTE_HOSTS = ["googlechromelabs.github.io", "storage.googleapis.com"];

/** Obergrenze je Archiv; die echten liegen bei rund 160 MB. */
const MAX_ARCHIV_BYTES = 400 * 1024 * 1024;

export type { BrowserStand } from "../shared/types";
import type { BrowserStand } from "../shared/types";

type Plattform = "mac-arm64" | "mac-x64" | "win64" | "linux64";

function plattform(): Plattform | null {
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (process.platform === "win32") return process.arch === "x64" ? "win64" : null;
  if (process.platform === "linux") return process.arch === "x64" ? "linux64" : null;
  return null;
}

/** Pfad der Programmdatei innerhalb des entpackten Archivs. */
function browserPfadIn(wurzel: string, p: Plattform): string {
  if (p === "mac-arm64" || p === "mac-x64") {
    const ordner = p === "mac-arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
    return join(wurzel, ordner, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  }
  if (p === "win64") return join(wurzel, "chrome-win64", "chrome.exe");
  return join(wurzel, "chrome-linux64", "chrome");
}

function treiberPfadIn(wurzel: string, p: Plattform): string {
  const ordner = `chromedriver-${p}`;
  return join(wurzel, ordner, p === "win64" ? "chromedriver.exe" : "chromedriver");
}

export class ChromeForTesting {
  private stand: BrowserStand = { zustand: "fehlt" };
  private laufend: Promise<BrowserStand> | null = null;

  constructor(
    private readonly wurzel: string,
    private readonly log: (zeile: string) => void = () => {},
    private readonly melde: (stand: BrowserStand) => void = () => {},
  ) {}

  aktuellerStand(): BrowserStand {
    return this.stand;
  }

  /** Pfad zur Programmdatei, wenn eine Fassung bereitliegt; sonst null. */
  browserPfad(): string | null {
    return this.stand.zustand === "bereit" ? this.stand.pfad : null;
  }

  /** Verzeichnis des passenden Treibers, für den Suchpfad der Producer. */
  treiberVerzeichnis(): string | null {
    if (this.stand.zustand !== "bereit" || !this.stand.treiber) return null;
    return join(this.stand.treiber, "..");
  }

  /**
   * Bereits geladene Fassung suchen, ohne etwas herunterzuladen. Wird beim
   * Start aufgerufen, damit AVA sofort weiß, ob sie ihren eigenen Browser hat.
   */
  async sucheVorhandene(): Promise<BrowserStand> {
    const p = plattform();
    if (!p) return this.setze({ zustand: "aus" });
    let eintraege: string[] = [];
    try {
      eintraege = await readdir(this.wurzel);
    } catch {
      return this.setze({ zustand: "fehlt" });
    }
    // Neueste zuerst, damit nach einer Aktualisierung die jüngste gilt.
    for (const version of eintraege.sort(vergleicheVersionen).reverse()) {
      const verzeichnis = join(this.wurzel, version);
      const browser = browserPfadIn(verzeichnis, p);
      if (!existsSync(browser)) continue;
      const treiber = treiberPfadIn(verzeichnis, p);
      return this.setze({ zustand: "bereit", version, pfad: browser, treiber: existsSync(treiber) ? treiber : null });
    }
    return this.setze({ zustand: "fehlt" });
  }

  /**
   * Fassung sicherstellen: vorhandene nehmen, sonst die stabile Fassung laden.
   * Mehrfachaufrufe teilen sich denselben Lauf. Ein Fehlschlag ist kein
   * Beinbruch — der Aufrufer weicht dann auf den Browser der Person aus.
   */
  async stelleSicher(): Promise<BrowserStand> {
    if (this.laufend) return this.laufend;
    if (this.stand.zustand === "bereit") return this.stand;
    this.laufend = this.laden().finally(() => {
      this.laufend = null;
    });
    return this.laufend;
  }

  private async laden(): Promise<BrowserStand> {
    const p = plattform();
    if (!p) return this.setze({ zustand: "aus" });
    const vorhanden = await this.sucheVorhandene();
    if (vorhanden.zustand === "bereit") return vorhanden;

    try {
      this.setze({ zustand: "laedt", fortschritt: 0 });
      const { version, browserUrl, treiberUrl } = await this.ermittleQuellen(p);
      this.log(`[browser] lade Chrome for Testing ${version} für ${p}`);
      const ziel = join(this.wurzel, version);
      await mkdir(ziel, { recursive: true });

      await this.ladeUndEntpacke(browserUrl, ziel, (anteil) => this.setze({ zustand: "laedt", fortschritt: Math.round(anteil * 50) }));
      await this.ladeUndEntpacke(treiberUrl, ziel, (anteil) => this.setze({ zustand: "laedt", fortschritt: 50 + Math.round(anteil * 50) }));

      const browser = browserPfadIn(ziel, p);
      if (!existsSync(browser)) throw new Error("Programmdatei nach dem Entpacken nicht gefunden");
      const treiber = treiberPfadIn(ziel, p);
      for (const datei of [browser, treiber]) {
        if (!existsSync(datei)) continue;
        await chmod(datei, 0o755).catch(() => undefined);
      }
      await this.entferneQuarantaene(ziel);
      await this.raeumeAlteVersionen(version);
      this.log(`[browser] Chrome for Testing ${version} bereit`);
      return this.setze({ zustand: "bereit", version, pfad: browser, treiber: existsSync(treiber) ? treiber : null });
    } catch (err) {
      const meldung = err instanceof Error ? err.message : String(err);
      this.log(`[browser] Chrome for Testing nicht verfügbar: ${meldung}`);
      return this.setze({ zustand: "fehler", meldung });
    }
  }

  private async ermittleQuellen(p: Plattform): Promise<{ version: string; browserUrl: string; treiberUrl: string }> {
    const antwort = await fetch(VERSIONEN_URL, { signal: AbortSignal.timeout(30_000) });
    if (!antwort.ok) throw new Error(`Versionsliste nicht abrufbar (${antwort.status})`);
    const daten = (await antwort.json()) as {
      channels?: { Stable?: { version?: string; downloads?: { chrome?: Array<{ platform: string; url: string }>; chromedriver?: Array<{ platform: string; url: string }> } } };
    };
    const stabil = daten.channels?.Stable;
    const version = stabil?.version;
    const browserUrl = stabil?.downloads?.chrome?.find((e) => e.platform === p)?.url;
    const treiberUrl = stabil?.downloads?.chromedriver?.find((e) => e.platform === p)?.url;
    if (!version || !browserUrl || !treiberUrl) throw new Error("Versionsliste ohne passende Fassung");
    for (const url of [browserUrl, treiberUrl]) pruefeUrl(url);
    return { version, browserUrl, treiberUrl };
  }

  private async ladeUndEntpacke(url: string, ziel: string, fortschritt: (anteil: number) => void): Promise<void> {
    pruefeUrl(url);
    const antwort = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!antwort.ok || !antwort.body) throw new Error(`Download fehlgeschlagen (${antwort.status})`);
    const gesamt = Number(antwort.headers.get("content-length") ?? 0);
    if (gesamt > MAX_ARCHIV_BYTES) throw new Error(`Archiv zu groß (${gesamt} Bytes)`);

    const temp = await mkdtemp(join(tmpdir(), "ava-cft-"));
    const archiv = join(temp, "paket.zip");
    try {
      let gelesen = 0;
      const strom = Readable.fromWeb(antwort.body as never);
      strom.on("data", (stueck: Buffer) => {
        gelesen += stueck.length;
        if (gelesen > MAX_ARCHIV_BYTES) strom.destroy(new Error("Archiv überschreitet die Größengrenze"));
        if (gesamt > 0) fortschritt(Math.min(1, gelesen / gesamt));
      });
      await pipeline(strom, createWriteStream(archiv));
      const groesse = (await stat(archiv)).size;
      if (groesse > MAX_ARCHIV_BYTES) throw new Error(`Archiv zu groß (${groesse} Bytes)`);
      await entpacke(archiv, ziel);
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * macOS hängt heruntergeladenen Programmen ein Quarantäne-Merkmal an, das den
   * Start ohne Rückfrage verhindert. Die Fassung ist von Google signiert; wir
   * entfernen nur das Merkmal, die Signaturprüfung des Systems bleibt.
   */
  private async entferneQuarantaene(ziel: string): Promise<void> {
    if (process.platform !== "darwin") return;
    await execFileP("xattr", ["-dr", "com.apple.quarantine", ziel], { timeout: 60_000 }).catch(() => undefined);
  }

  /** Nur die aktuelle Fassung behalten; ältere belegen je rund 160 MB. */
  private async raeumeAlteVersionen(behalten: string): Promise<void> {
    let eintraege: string[] = [];
    try {
      eintraege = await readdir(this.wurzel);
    } catch {
      return;
    }
    for (const eintrag of eintraege) {
      if (eintrag === behalten) continue;
      await rm(join(this.wurzel, eintrag), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private setze(stand: BrowserStand): BrowserStand {
    this.stand = stand;
    try {
      this.melde(stand);
    } catch {
      /* Zuhörer-Fehler nie weitertragen */
    }
    return stand;
  }
}

function pruefeUrl(url: string): void {
  let ziel: URL;
  try {
    ziel = new URL(url);
  } catch {
    throw new Error("ungültige Adresse");
  }
  if (ziel.protocol !== "https:") throw new Error("nur https erlaubt");
  if (!ERLAUBTE_HOSTS.includes(ziel.hostname)) throw new Error(`Host nicht erlaubt: ${ziel.hostname}`);
}

async function entpacke(archiv: string, ziel: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileP(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archiv.replace(/'/g, "''")}' -DestinationPath '${ziel.replace(/'/g, "''")}' -Force`],
      { timeout: 10 * 60_000, windowsHide: true },
    );
    return;
  }
  // -o überschreibt, -q hält die Ausgabe klein. Das Archiv kommt von Google
  // und enthält ausschließlich den Browser beziehungsweise den Treiber.
  await execFileP("unzip", ["-o", "-q", archiv, "-d", ziel], { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 });
}

/** Versionen wie 153.0.8010.52 der Größe nach vergleichen. */
function vergleicheVersionen(a: string, b: string): number {
  const za = a.split(".").map((t) => Number(t) || 0);
  const zb = b.split(".").map((t) => Number(t) || 0);
  for (let i = 0; i < Math.max(za.length, zb.length); i++) {
    const d = (za[i] ?? 0) - (zb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
