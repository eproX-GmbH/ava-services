// Umzug zwischen zwei AVA-Instanzen desselben Kontos (docs/PLAN_AVA_CLOUD.md §13.3).
//
// Ablauf (das Ziel holt immer):
//   1. Ziel → Quelle   umzug-start   { umzugId, pub }          (X25519, frisch je Umzug)
//   2. Quelle → Ziel   umzug-teil    { umzugId, n, pub?, d }   (AES-256-GCM, Schlüssel aus ECDH+HKDF)
//      Ziel → Quelle   umzug-ack     { umzugId, n }            (Fenster von 8 Teilen)
//   3. Quelle → Ziel   umzug-ende    { umzugId, teile, sha256, statistik }
//   4. Ziel prüft, legt `bereit.json` ab und startet neu; beim Start ersetzt
//      `wendeUmzugAn()` das Datenverzeichnis (bis auf instanzgebundene Teile)
//      durch das Paket. Der alte Stand liegt danach unter `.umzug-alt/`.
//   Senden statt Holen: Quelle → Ziel  umzug-bitte { umzugId } — das Ziel holt dann.
//
// Der Gateway reicht nur Chiffrat durch. Beide Seiten sind dasselbe Konto (das
// Relais prüft es), die Bestätigung holt die auslösende Seite beim Menschen ein.

import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, createPublicKey, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentials, lifecycle, paths } from "../platform";
import type { KopfRelais } from "../relais/kopf-relais";
import { datenbankEinspielen } from "./datenbanken";
import { NICHT_UMZIEHEN, NICHT_UMZIEHEN_PFADE, PaketLeser, paketEintraege, verschluesseleJson, type PaketKopf, type PaketStatistik } from "./paket";

const TEIL_BYTES = 768 * 1024;
const FENSTER = 8;
const STILL_MS = 120_000;
const EINGANG = ".umzug-eingang";
const ALT = ".umzug-alt";

export type { UmzugPhase, UmzugStand } from "../../shared/types";
import type { UmzugStand } from "../../shared/types";

function schluessel(eigenPriv: KeyObject, fremdPubRaw: Buffer, umzugId: string): Buffer {
  const fremd = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), fremdPubRaw]), format: "der", type: "spki" });
  const geteilt = diffieHellman({ privateKey: eigenPriv, publicKey: fremd });
  return Buffer.from(hkdfSync("sha256", geteilt, Buffer.from(umzugId), Buffer.from("ava-umzug-v1"), 32));
}

function pubRaw(k: KeyObject): Buffer {
  return (k.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
}

function verschluesseln(key: Buffer, umzugId: string, n: number, klar: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(`${umzugId}:${n}`));
  const ct = Buffer.concat([c.update(klar), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function entschluesseln(key: Buffer, umzugId: string, n: number, b64: string): Buffer {
  const b = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAAD(Buffer.from(`${umzugId}:${n}`));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

function sicherePfad(basis: string, rel: string): string {
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) throw new Error(`ungültiger Pfad im Umzug: ${rel}`);
  return join(basis, ...rel.split("/"));
}

/** Einen empfangenen Eintrag in den Eingang schreiben; Geheimnisse mit der Ablage dieser Instanz neu verschlüsseln. */
export function eintragSchreiben(staging: string, kopf: PaketKopf, inhalt: Buffer, datenbanken: string[]): void {
  const ziel = sicherePfad(join(staging, "dateien"), kopf.p);
  if (kopf.a === "g") {
    const datei = sicherePfad(join(staging, "datenbanken"), `${kopf.p.replace(/\//g, "__")}.tgz`);
    mkdirSync(dirname(datei), { recursive: true });
    writeFileSync(datei, inhalt);
    datenbanken.push(kopf.p);
    return;
  }
  mkdirSync(dirname(ziel), { recursive: true });
  if (kopf.a === "s") {
    const enc = credentials().encryptString(inhalt.toString("utf8"));
    writeFileSync(ziel, kopf.f === "b64" ? enc.toString("base64") : enc);
    return;
  }
  if (kopf.a === "j") {
    writeFileSync(ziel, JSON.stringify(verschluesseleJson(JSON.parse(inhalt.toString("utf8")))), "utf8");
    return;
  }
  writeFileSync(ziel, inhalt);
}

export class Umzug {
  private stand: UmzugStand = { phase: "bereit", rolle: null, gegenueber: null, umzugId: null, teile: 0, bytes: 0, meldung: null, seit: null };
  private zielZustand: {
    umzugId: string;
    quelle: string;
    priv: KeyObject;
    key: Buffer | null;
    erwartet: number;
    hash: ReturnType<typeof createHash>;
    leser: PaketLeser;
    staging: string;
    datenbanken: string[];
    still: NodeJS.Timeout | null;
  } | null = null;
  private quellLauf: { umzugId: string; ziel: string; bestaetigt: number; weiter: (() => void) | null; abbruch: string | null } | null = null;
  private readonly hoerer = new Set<(s: UmzugStand) => void>();

  constructor(
    private readonly relais: KopfRelais,
    private readonly log: (zeile: string) => void = (z) => console.log(z),
  ) {
    relais.aufNachricht((von, n) => void this.nachricht(von, n));
  }

  aufStand(h: (s: UmzugStand) => void): () => void {
    this.hoerer.add(h);
    return () => this.hoerer.delete(h);
  }

  getStand(): UmzugStand {
    return this.stand;
  }

  private setze(p: Partial<UmzugStand>): void {
    this.stand = { ...this.stand, ...p };
    for (const h of this.hoerer) {
      try {
        h(this.stand);
      } catch {
        /* Anzeige */
      }
    }
  }

  private laeuft(): boolean {
    return this.stand.phase === "wartet" || this.stand.phase === "sendet" || this.stand.phase === "empfaengt";
  }

  /** Diese Instanz holt den Stand der Quelle und wird danach überschrieben. */
  holen(quelle: string): { ok: boolean; grund?: string; umzugId?: string } {
    if (this.laeuft()) return { ok: false, grund: "Es läuft bereits ein Umzug." };
    if (quelle === this.relais.instanzId()) return { ok: false, grund: "Quelle und Ziel sind dieselbe Instanz." };
    const q = this.relais.instanzen().find((i) => i.id === quelle);
    if (!q?.verbunden) return { ok: false, grund: "Die Quelle ist gerade nicht verbunden." };
    const umzugId = randomUUID();
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const staging = join(paths().get("userData"), EINGANG, umzugId);
    rmSync(join(paths().get("userData"), EINGANG), { recursive: true, force: true });
    mkdirSync(join(staging, "dateien"), { recursive: true });
    const hash = createHash("sha256");
    const datenbanken: string[] = [];
    const leser = new PaketLeser((kopf, inhalt) => eintragSchreiben(staging, kopf, inhalt, datenbanken));
    this.zielZustand = { umzugId, quelle, priv: privateKey, key: null, erwartet: 0, hash, leser, staging, datenbanken, still: null };
    this.setze({ phase: "wartet", rolle: "ziel", gegenueber: q.name, umzugId, teile: 0, bytes: 0, meldung: `Warte auf ${q.name}…`, seit: new Date().toISOString() });
    if (!this.relais.an(quelle, { art: "umzug-start", umzugId, pub: pubRaw(publicKey).toString("base64") })) {
      this.abbrechenZiel("Relais nicht verbunden.");
      return { ok: false, grund: "Diese Instanz ist gerade nicht mit dem Gateway verbunden." };
    }
    this.stillUeberwachen();
    this.log(`[umzug] hole von ${q.name} (${umzugId})`);
    return { ok: true, umzugId };
  }

  /** Diese Instanz schickt ihren Stand; das Ziel wird überschrieben. */
  senden(ziel: string): { ok: boolean; grund?: string } {
    if (this.laeuft()) return { ok: false, grund: "Es läuft bereits ein Umzug." };
    const z = this.relais.instanzen().find((i) => i.id === ziel);
    if (!z?.verbunden) return { ok: false, grund: "Das Ziel ist gerade nicht verbunden." };
    if (!this.relais.an(ziel, { art: "umzug-bitte", umzugId: randomUUID() })) return { ok: false, grund: "Diese Instanz ist gerade nicht mit dem Gateway verbunden." };
    this.setze({ phase: "wartet", rolle: "quelle", gegenueber: z.name, umzugId: null, teile: 0, bytes: 0, meldung: `${z.name} wird gebeten, den Stand zu holen…`, seit: new Date().toISOString() });
    return { ok: true };
  }

  private stillUeberwachen(): void {
    const z = this.zielZustand;
    if (!z) return;
    if (z.still) clearTimeout(z.still);
    z.still = setTimeout(() => this.abbrechenZiel("Die Quelle hat zwei Minuten lang nichts geschickt."), STILL_MS);
    z.still.unref?.();
  }

  private abbrechenZiel(grund: string): void {
    const z = this.zielZustand;
    if (z?.still) clearTimeout(z.still);
    if (z) rmSync(join(paths().get("userData"), EINGANG), { recursive: true, force: true });
    this.zielZustand = null;
    this.setze({ phase: "fehler", meldung: grund });
    this.log(`[umzug] abgebrochen: ${grund}`);
  }

  private async nachricht(von: string, n: Record<string, unknown>): Promise<void> {
    const art = n.art;
    if (art === "fehler" && von === "gateway") {
      if (this.zielZustand && n.ziel === this.zielZustand.quelle) this.abbrechenZiel("Die Quelle ist nicht mehr verbunden.");
      if (this.quellLauf && n.ziel === this.quellLauf.ziel) this.quellLauf.abbruch = "Das Ziel ist nicht mehr verbunden.";
      return;
    }
    if (art === "umzug-bitte") {
      // Die Quelle möchte senden: Bestätigt wurde dort. Wir holen.
      const r = this.holen(von);
      if (!r.ok) this.relais.an(von, { art: "umzug-abgelehnt", grund: r.grund ?? "" });
      return;
    }
    if (art === "umzug-abgelehnt") {
      this.setze({ phase: "fehler", meldung: `Ziel lehnt ab: ${String(n.grund ?? "")}` });
      return;
    }
    if (art === "umzug-start" && typeof n.umzugId === "string" && typeof n.pub === "string") {
      await this.alsQuelleSenden(von, n.umzugId, Buffer.from(n.pub, "base64"));
      return;
    }
    if (art === "umzug-ack" && this.quellLauf && n.umzugId === this.quellLauf.umzugId && typeof n.n === "number") {
      this.quellLauf.bestaetigt = Math.max(this.quellLauf.bestaetigt, n.n);
      const w = this.quellLauf.weiter;
      this.quellLauf.weiter = null;
      w?.();
      return;
    }
    if (art === "umzug-abbruch") {
      if (this.quellLauf && n.umzugId === this.quellLauf.umzugId) this.quellLauf.abbruch = String(n.grund ?? "Ziel hat abgebrochen.");
      if (this.zielZustand && n.umzugId === this.zielZustand.umzugId) this.abbrechenZiel(`Quelle hat abgebrochen: ${String(n.grund ?? "")}`);
      return;
    }
    const z = this.zielZustand;
    if (!z || von !== z.quelle || n.umzugId !== z.umzugId) return;
    try {
      if (art === "umzug-teil" && typeof n.n === "number" && typeof n.d === "string") {
        if (n.n !== z.erwartet) throw new Error(`Teil ${n.n} statt ${z.erwartet}`);
        if (!z.key) {
          if (typeof n.pub !== "string") throw new Error("Schlüssel der Quelle fehlt");
          z.key = schluessel(z.priv, Buffer.from(n.pub, "base64"), z.umzugId);
        }
        const klar = entschluesseln(z.key, z.umzugId, n.n, n.d);
        z.hash.update(klar);
        z.leser.schreibe(klar);
        z.erwartet += 1;
        this.setze({ phase: "empfaengt", teile: z.erwartet, bytes: this.stand.bytes + klar.length, meldung: `Empfange von ${this.stand.gegenueber}…` });
        this.relais.an(z.quelle, { art: "umzug-ack", umzugId: z.umzugId, n: z.erwartet });
        this.stillUeberwachen();
        return;
      }
      if (art === "umzug-ende") {
        if (n.teile !== z.erwartet) throw new Error(`unvollständig: ${z.erwartet} von ${String(n.teile)} Teilen`);
        if (n.sha256 !== z.hash.digest("hex")) throw new Error("Prüfsumme stimmt nicht");
        if (!z.leser.restlos()) throw new Error("Paket endet mitten in einem Eintrag");
        if (z.still) clearTimeout(z.still);
        writeFileSync(join(z.staging, "manifest.json"), JSON.stringify({ umzugId: z.umzugId, von: this.stand.gegenueber, datenbanken: z.datenbanken, statistik: n.statistik ?? null, zeit: new Date().toISOString() }));
        writeFileSync(join(paths().get("userData"), EINGANG, "bereit.json"), JSON.stringify({ umzugId: z.umzugId }));
        this.zielZustand = null;
        this.setze({ phase: "fertig", meldung: "Übertragen. AVA startet neu und übernimmt den Stand." });
        this.log(`[umzug] empfangen (${this.stand.bytes} Bytes), Neustart`);
        setTimeout(() => lifecycle().relaunch(), 2500);
      }
    } catch (err) {
      const grund = err instanceof Error ? err.message : String(err);
      this.relais.an(z.quelle, { art: "umzug-abbruch", umzugId: z.umzugId, grund });
      this.abbrechenZiel(grund);
    }
  }

  private async alsQuelleSenden(ziel: string, umzugId: string, zielPub: Buffer): Promise<void> {
    if (this.quellLauf) {
      this.relais.an(ziel, { art: "umzug-abbruch", umzugId, grund: "Die Quelle sendet bereits einen anderen Umzug." });
      return;
    }
    const zName = this.relais.instanzen().find((i) => i.id === ziel)?.name ?? ziel;
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const key = schluessel(privateKey, zielPub, umzugId);
    const eigenPub = pubRaw(publicKey).toString("base64");
    this.quellLauf = { umzugId, ziel, bestaetigt: 0, weiter: null, abbruch: null };
    this.setze({ phase: "sendet", rolle: "quelle", gegenueber: zName, umzugId, teile: 0, bytes: 0, meldung: `Sende an ${zName}…`, seit: new Date().toISOString() });
    this.log(`[umzug] sende an ${zName} (${umzugId})`);
    const hash = createHash("sha256");
    const statistik: PaketStatistik = { dateien: 0, geheimnisse: 0, datenbanken: 0, bytes: 0 };
    let n = 0;
    let puffer: Buffer[] = [];
    let pufferLaenge = 0;
    const lauf = this.quellLauf;
    const teilSenden = async (klar: Buffer): Promise<void> => {
      while (n - lauf.bestaetigt >= FENSTER) {
        if (lauf.abbruch) throw new Error(lauf.abbruch);
        await new Promise<void>((r) => {
          lauf.weiter = r;
          setTimeout(r, 5000);
        });
      }
      if (lauf.abbruch) throw new Error(lauf.abbruch);
      hash.update(klar);
      const ok = this.relais.an(ziel, { art: "umzug-teil", umzugId, n, ...(n === 0 ? { pub: eigenPub } : {}), d: verschluesseln(key, umzugId, n, klar) });
      if (!ok) throw new Error("Relais nicht verbunden");
      n += 1;
      this.setze({ teile: n, bytes: this.stand.bytes + klar.length });
    };
    try {
      for await (const e of paketEintraege(paths().get("userData"), statistik)) {
        puffer.push(e);
        pufferLaenge += e.length;
        while (pufferLaenge >= TEIL_BYTES) {
          const alles = Buffer.concat(puffer, pufferLaenge);
          await teilSenden(alles.subarray(0, TEIL_BYTES));
          const rest = alles.subarray(TEIL_BYTES);
          puffer = rest.length ? [Buffer.from(rest)] : [];
          pufferLaenge = rest.length;
        }
      }
      if (pufferLaenge > 0) await teilSenden(Buffer.concat(puffer, pufferLaenge));
      this.relais.an(ziel, { art: "umzug-ende", umzugId, teile: n, sha256: hash.digest("hex"), statistik });
      this.setze({ phase: "fertig", meldung: `An ${zName} gesendet (${statistik.dateien} Dateien, ${statistik.datenbanken} Datenbanken, ${statistik.geheimnisse} Schlüssel). Das Ziel startet neu.` });
      this.log(`[umzug] gesendet: ${JSON.stringify(statistik)}`);
    } catch (err) {
      const grund = err instanceof Error ? err.message : String(err);
      this.relais.an(ziel, { art: "umzug-abbruch", umzugId, grund });
      this.setze({ phase: "fehler", meldung: `Senden abgebrochen: ${grund}` });
      this.log(`[umzug] Senden abgebrochen: ${grund}`);
    } finally {
      this.quellLauf = null;
    }
  }
}

/**
 * Beim Start, bevor ein Store öffnet: liegt ein empfangener Umzug bereit, das
 * Datenverzeichnis (bis auf instanzgebundene Teile) beiseitelegen und durch das
 * Paket ersetzen. Fehler hier verhindern den Start nicht; der alte Stand bleibt
 * dann unter `.umzug-alt/` erhalten.
 */
export async function wendeUmzugAn(log: (zeile: string) => void = (z) => console.log(z)): Promise<void> {
  const daten = paths().get("userData");
  const marke = join(daten, EINGANG, "bereit.json");
  if (!existsSync(marke)) return;
  let umzugId = "";
  try {
    umzugId = (JSON.parse(readFileSync(marke, "utf8")) as { umzugId: string }).umzugId;
  } catch {
    rmSync(join(daten, EINGANG), { recursive: true, force: true });
    return;
  }
  const staging = join(daten, EINGANG, umzugId);
  const manifest = JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")) as { datenbanken: string[]; von?: string };
  const alt = join(daten, ALT, new Date().toISOString().replace(/[:.]/g, "-"));
  log(`[umzug] spiele Stand von ${manifest.von ?? "?"} ein (${umzugId})`);
  // Vorherigen Stand beiseitelegen (nur der letzte bleibt), statt zu löschen.
  rmSync(join(daten, ALT), { recursive: true, force: true });
  mkdirSync(alt, { recursive: true });
  for (const name of readdirSync(daten)) {
    if (NICHT_UMZIEHEN.has(name)) continue;
    try {
      renameSync(join(daten, name), join(alt, name));
    } catch (err) {
      log(`[umzug] ${name} nicht beiseitegelegt: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Paket einsetzen.
  const quelle = join(staging, "dateien");
  if (existsSync(quelle)) {
    for (const name of readdirSync(quelle)) {
      if (NICHT_UMZIEHEN.has(name)) continue;
      renameSync(join(quelle, name), join(daten, name));
    }
  }
  // Instanzgebundene Dateien in Unterordnern (Abo-Anmeldungen, Worker-Token) aus dem alten Stand zurückholen.
  for (const rel of NICHT_UMZIEHEN_PFADE) {
    const vorher = sicherePfad(alt, rel);
    if (!existsSync(vorher)) continue;
    const ziel = sicherePfad(daten, rel);
    mkdirSync(dirname(ziel), { recursive: true });
    rmSync(ziel, { force: true });
    renameSync(vorher, ziel);
  }
  for (const rel of manifest.datenbanken ?? []) {
    try {
      const ziel = sicherePfad(daten, rel);
      rmSync(ziel, { recursive: true, force: true });
      mkdirSync(ziel, { recursive: true });
      await datenbankEinspielen(ziel, readFileSync(join(staging, "datenbanken", `${rel.replace(/\//g, "__")}.tgz`)));
      log(`[umzug] Datenbank ${rel} eingespielt`);
    } catch (err) {
      log(`[umzug] Datenbank ${rel} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  rmSync(join(daten, EINGANG), { recursive: true, force: true });
  writeFileSync(join(daten, "umzug-letzter.json"), JSON.stringify({ umzugId, von: manifest.von ?? null, zeit: new Date().toISOString(), alterStand: alt }));
  log(`[umzug] fertig; vorheriger Stand unter ${alt}`);
}
