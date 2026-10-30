// Website-Themen (docs/PLAN_THEMEN.md, T1): lokaler Store je Nutzer.
// Datei `userData/themen/themen.json`; der Pfad geht als AVA_THEMEN_CONFIG an den
// Website-Producer, der die Datei je Lauf neu liest (kein Neustart noetig).

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_AKTIVE_THEMEN, MAX_THEMEN, themaSchluessel, type Thema, type ThemaBegriff, type ThemaEingabe } from "../../shared/themen-types";

interface Datei {
  version: 1;
  themen: Thema[];
}

function kurz(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function begriffeNormal(liste: string[], quelle: ThemaBegriff["quelle"]): ThemaBegriff[] {
  const out: ThemaBegriff[] = [];
  const gesehen = new Set<string>();
  for (const roh of liste) {
    const t = kurz(roh, 60);
    const k = t.toLowerCase();
    if (t.length < 2 || gesehen.has(k)) continue;
    gesehen.add(k);
    out.push({ text: t, quelle });
    if (out.length >= 40) break;
  }
  return out;
}

export class ThemenStore extends EventEmitter {
  private readonly dir: string;
  private readonly datei: string;
  private cache: Thema[] | null = null;

  constructor(userDataDir: string) {
    super();
    this.dir = join(userDataDir, "themen");
    this.datei = join(this.dir, "themen.json");
  }

  /** Pfad der Datei fuer den Website-Producer (AVA_THEMEN_CONFIG). */
  pfad(): string {
    if (!existsSync(this.datei)) this.schreibe(this.list());
    return this.datei;
  }

  list(): Thema[] {
    if (this.cache) return this.cache.map((t) => ({ ...t, begriffe: [...t.begriffe] }));
    let themen: Thema[] = [];
    try {
      if (existsSync(this.datei)) {
        const raw = JSON.parse(readFileSync(this.datei, "utf8")) as Partial<Datei>;
        themen = Array.isArray(raw.themen) ? raw.themen.filter((t) => t && typeof t.id === "string" && typeof t.name === "string") : [];
      }
    } catch {
      themen = [];
    }
    this.cache = themen;
    return themen.map((t) => ({ ...t, begriffe: [...t.begriffe] }));
  }

  aktive(): Thema[] {
    return this.list().filter((t) => t.aktiv);
  }

  get(id: string): Thema | null {
    return this.list().find((t) => t.id === id) ?? null;
  }

  /** Anlegen oder aendern. Wirft bei zu vielen Themen oder leerem Namen. */
  speichern(e: ThemaEingabe): Thema {
    const themen = this.list();
    const name = kurz(e.name, 80);
    if (!name) throw new Error("Ein Thema braucht einen Namen.");
    const schluessel = themaSchluessel(name);
    if (!schluessel) throw new Error("Der Name ergibt keinen brauchbaren Schluessel.");
    const jetzt = new Date().toISOString();
    const vorhanden = e.id ? themen.find((t) => t.id === e.id) : themen.find((t) => t.schluessel === schluessel);
    if (!vorhanden && themen.length >= MAX_THEMEN) throw new Error(`Hoechstens ${MAX_THEMEN} Themen.`);
    const aktiv = e.aktiv ?? vorhanden?.aktiv ?? true;
    const andereAktive = themen.filter((t) => t.aktiv && t.id !== vorhanden?.id).length;
    if (aktiv && andereAktive >= MAX_AKTIVE_THEMEN) throw new Error(`Hoechstens ${MAX_AKTIVE_THEMEN} Themen gleichzeitig aktiv.`);
    const avaBegriffe = vorhanden?.begriffe.filter((b) => b.quelle === "ava") ?? [];
    const nutzerBegriffe = e.begriffe ? begriffeNormal(e.begriffe, "nutzer") : (vorhanden?.begriffe.filter((b) => b.quelle === "nutzer") ?? []);
    const neu: Thema = {
      id: vorhanden?.id ?? randomBytes(6).toString("hex"),
      schluessel,
      name,
      beschreibung: kurz(e.beschreibung ?? vorhanden?.beschreibung ?? "", 300),
      warum: kurz(e.warum ?? vorhanden?.warum ?? "", 300),
      begriffe: [...nutzerBegriffe, ...avaBegriffe.filter((a) => !nutzerBegriffe.some((n) => n.text.toLowerCase() === a.text.toLowerCase()))],
      aktiv,
      quelle: e.quelle ?? vorhanden?.quelle ?? "nutzer",
      createdAt: vorhanden?.createdAt ?? jetzt,
      updatedAt: jetzt,
    };
    const next = vorhanden ? themen.map((t) => (t.id === vorhanden.id ? neu : t)) : [...themen, neu];
    this.schreibe(next);
    return neu;
  }

  /** Von AVA ergaenzte Begriffe setzen (ersetzen die bisherigen AVA-Begriffe). */
  begriffeErgaenzen(id: string, begriffe: string[]): Thema {
    const themen = this.list();
    const t = themen.find((x) => x.id === id);
    if (!t) throw new Error("Thema nicht gefunden.");
    const nutzer = t.begriffe.filter((b) => b.quelle === "nutzer");
    const ava = begriffeNormal(begriffe, "ava").filter((a) => !nutzer.some((n) => n.text.toLowerCase() === a.text.toLowerCase()));
    const neu: Thema = { ...t, begriffe: [...nutzer, ...ava], updatedAt: new Date().toISOString() };
    this.schreibe(themen.map((x) => (x.id === id ? neu : x)));
    return neu;
  }

  loeschen(id: string): boolean {
    const themen = this.list();
    const next = themen.filter((t) => t.id !== id);
    if (next.length === themen.length) return false;
    this.schreibe(next);
    return true;
  }

  private schreibe(themen: Thema[]): void {
    this.cache = themen;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.datei}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, themen } satisfies Datei, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.datei);
    } catch (err) {
      console.warn("[themen-store] schreiben fehlgeschlagen:", err);
    }
    this.emit("changed", themen);
  }
}
