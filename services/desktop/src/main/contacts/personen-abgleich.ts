// Doppelte Personen zusammenführen, AVA-Teil (Gateway lib/contact-extraction/personen-abgleich.ts).
//
// Je Firma (höchstens alle 7 Tage) stößt AVA den Abgleich an: Der Gateway führt sichere
// Paare selbst zusammen (gleiches Profil, LinkedIn-Slug = voller Name, gleiche belegte
// Adresse) und liefert Kandidaten „nur Vorname, genau ein Gegenstück“. Über die
// entscheidet hier ein KI-Urteil (Hintergrund-Kanal); nur bei „ja“ geht die
// Zusammenführung an den Gateway, der die Bedingungen noch einmal prüft.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yup from "yup";

export type Urteil = (system: string, user: string) => Promise<string | null>;

interface PersonKarte {
  personId: string;
  fullName: string;
  titel: string | null;
  abteilung: string | null;
  beschreibung: string | null;
  linkedin: string | null;
  quellen: string[];
}

interface AbgleichAntwort {
  firma: string | null;
  personen: number;
  zusammengefuehrt: Array<{ behalten: string; aufgeloest: string; regel: string; grund: string }>;
  kandidaten: Array<{ vorname: PersonKarte; voll: PersonKarte }>;
}

export interface PersonenAbgleichDeps {
  gatewayRequest: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  isSignedIn: () => boolean;
  isLlmBusy: () => boolean;
  urteil?: Urteil | null;
  log: (m: string) => void;
  audit: (e: { summary: string; metadata: Record<string, unknown> }) => void;
}

const TICK_MS = 30 * 60_000;
const ERSTER_TICK_MS = 8 * 60_000;
const ABSTAND_MS = 7 * 86_400_000;
const FIRMEN_JE_TICK = 15;

const URTEIL_SCHEMA = yup.object({ gleich: yup.boolean().required(), begruendung: yup.string().max(400).default("") });

interface Stand {
  geprueft: Record<string, string>;
  /** Urteile je Paar (vornameId|vollId), damit dasselbe Paar nicht immer wieder gefragt wird. */
  urteile: Record<string, { gleich: boolean; at: string }>;
}

export class PersonenAbgleich {
  private timer: NodeJS.Timeout | null = null;
  private laeuft = false;
  private stand: Stand;
  private readonly datei: string;

  constructor(private readonly deps: PersonenAbgleichDeps, userData: string) {
    this.datei = join(userData, "personen-abgleich.json");
    this.stand = this.laden();
  }

  start(): void {
    if (this.timer) return;
    const erster = setTimeout(() => void this.tick(), ERSTER_TICK_MS);
    erster.unref?.();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private laden(): Stand {
    try {
      if (existsSync(this.datei)) {
        const s = JSON.parse(readFileSync(this.datei, "utf8")) as Partial<Stand>;
        return { geprueft: s.geprueft ?? {}, urteile: s.urteile ?? {} };
      }
    } catch {
      /* neu anfangen */
    }
    return { geprueft: {}, urteile: {} };
  }

  private speichern(): void {
    try {
      const tmp = `${this.datei}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.stand));
      renameSync(tmp, this.datei);
    } catch (err) {
      this.deps.log(`[personen-abgleich] Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async firmen(): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = await this.deps.gatewayRequest<{ companies?: Array<{ companyId: string }> }>(`/v1/companies/matrix?pageNumber=${page}&pageSize=100`);
      const rows = r.companies ?? [];
      out.push(...rows.map((x) => x.companyId));
      if (rows.length < 100) break;
    }
    return out;
  }

  /** Ein Durchlauf; `companyId` gezielt für eine Firma (Chat-Werkzeug). */
  async tick(companyId?: string): Promise<string> {
    if (this.laeuft) return "läuft bereits";
    if (!this.deps.isSignedIn()) return "nicht angemeldet";
    if (!companyId && this.deps.isLlmBusy()) return "pausiert (Chat aktiv)";
    this.laeuft = true;
    const teile: string[] = [];
    try {
      const jetzt = Date.now();
      const faellig = companyId ? [companyId] : (await this.firmen()).filter((id) => jetzt - Date.parse(this.stand.geprueft[id] ?? "1970-01-01") > ABSTAND_MS).slice(0, FIRMEN_JE_TICK);
      for (const id of faellig) {
        const t = await this.firma(id);
        if (t) teile.push(t);
      }
      return teile.join("; ") || "nichts zusammenzuführen";
    } catch (err) {
      return `Fehler: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.laeuft = false;
      this.speichern();
    }
  }

  private async firma(companyId: string): Promise<string | null> {
    const r = await this.deps.gatewayRequest<AbgleichAntwort>(`/v1/companies/${encodeURIComponent(companyId)}/contacts/abgleich`, { method: "POST", body: {} });
    this.stand.geprueft[companyId] = new Date().toISOString();
    const erledigt = r.zusammengefuehrt.map((z) => `${z.aufgeloest} → ${z.behalten}`);
    for (const k of r.kandidaten) {
      const schluessel = `${k.vorname.personId}|${k.voll.personId}`;
      if (this.stand.urteile[schluessel] || !this.deps.urteil) continue;
      const u = await this.urteilen(r.firma, r.personen, k.vorname, k.voll);
      if (!u) continue;
      this.stand.urteile[schluessel] = { gleich: u.gleich, at: new Date().toISOString() };
      if (!u.gleich) continue;
      try {
        const m = await this.deps.gatewayRequest<{ behalten: string; aufgeloest: string }>(`/v1/companies/${encodeURIComponent(companyId)}/contacts/zusammenfuehren`, {
          method: "POST",
          body: { vornameId: k.vorname.personId, vollId: k.voll.personId, grund: `KI-Urteil: ${u.begruendung}`.slice(0, 500) },
        });
        erledigt.push(`${m.aufgeloest} → ${m.behalten} (KI-Urteil)`);
      } catch (err) {
        this.deps.log(`[personen-abgleich] Zusammenführen abgelehnt: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (erledigt.length === 0) return null;
    const text = `${r.firma ?? companyId}: ${erledigt.join(", ")}`;
    this.deps.log(`[personen-abgleich] ${text}`);
    this.deps.audit({ summary: `Doppelte Kontakte zusammengeführt — ${text}`, metadata: { companyId, anzahl: erledigt.length } });
    return text;
  }

  private async urteilen(firma: string | null, personen: number, a: PersonKarte, b: PersonKarte): Promise<{ gleich: boolean; begruendung: string } | null> {
    const system =
      "Du prüfst, ob zwei Kontakteinträge derselben Firma dieselbe Person sind. Eintrag A trägt nur einen Vornamen (z. B. von der Teamseite der Website), " +
      "Eintrag B Vor- und Nachnamen. Gleich nur, wenn nichts dagegen spricht und Position, Abteilung, Beschreibung oder Quellen zusammenpassen; " +
      "unterschiedliche Funktionen (z. B. Vertrieb gegen Entwicklung) sprechen dagegen. Kleine Firmen machen eine Übereinstimmung wahrscheinlicher. " +
      'Im Zweifel nein. Antworte nur mit JSON: {"gleich": true|false, "begruendung": "ein Satz"}.';
    const karte = (p: PersonKarte) =>
      [`Name: ${p.fullName}`, p.titel && `Position: ${p.titel}`, p.abteilung && `Abteilung: ${p.abteilung}`, p.beschreibung && `Beschreibung: ${p.beschreibung}`, p.linkedin && `LinkedIn: ${p.linkedin}`, p.quellen.length && `Quellen: ${p.quellen.join(", ")}`]
        .filter(Boolean)
        .join("\n");
    const user = `Firma: ${firma ?? "unbekannt"} (${personen} bekannte Personen)\n\nA:\n${karte(a)}\n\nB:\n${karte(b)}`;
    try {
      const text = await this.deps.urteil!(system, user);
      const m = text?.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const j = URTEIL_SCHEMA.validateSync(JSON.parse(m[0]));
      return { gleich: j.gleich, begruendung: j.begruendung };
    } catch {
      return null;
    }
  }
}
