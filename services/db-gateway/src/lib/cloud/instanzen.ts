// Kunden-Instanzen anlegen, stoppen, starten, ruhen lassen, löschen
// (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §4/§5, Z1).
//
// Jeder Schritt ist wiederholbar: Was erledigt ist, steht in `schritte` bzw. in den Spalten
// (volumeId, maschineId). Bricht etwas ab (Fly-Fehler, Gateway-Neustart), setzt `fortsetzen`
// an derselben Stelle wieder an. Jeder Übergang landet in CloudEreignis.
//
// Z1 kennt nur Betreiber-Aufrufe. Wer wann laufen soll, entscheidet ab Z2 der Abgleicher.

import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { FlyKunden } from "./fly-maschinen";
import { GATEWAY_SECRET, GROESSEN, type Groesse, maschinenKonfig } from "./konfig";
import { instanzToken } from "./anmeldung";

export type Zustand = "zahlung_offen" | "wird_angelegt" | "wartet_auf_verbindung" | "laeuft" | "gestoppt" | "ruht" | "geloescht";
export type Soll = "laufen" | "gestoppt";
export type Grund = "zahlung" | "admin" | "kuendigung" | "abbestellt" | "betreiber" | "konto";
export type Quelle = "abgleicher" | "webhook" | "admin" | "betreiber" | "system" | "nutzer";

export interface CloudInstanz {
  id: string;
  tenantId: string;
  actorId: string;
  flyApp: string;
  region: string;
  groesse: Groesse;
  zustand: Zustand;
  /** Wunsch von Admin/Betreiber; das Soll ermittelt der Abgleicher daraus (abgleich.ts). */
  gewuenscht: Soll;
  soll: Soll;
  grund: Grund | null;
  imageVersion: string | null;
  maschineId: string | null;
  volumeId: string | null;
  /** Erledigte Anlege-Schritte, Fehlversuche, Alarm-Zeitpunkte (Abgleicher). */
  schritte: Record<string, boolean | number | string>;
  letzterFehler: string | null;
  verbundenAt: string | null;
  gesundAt: string | null;
  /** Abbestellt: läuft bis hierhin (Zyklusende), danach Soll gestoppt. */
  abbestelltZum: string | null;
  gestopptAt: string | null;
  geloeschtAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloudRepo {
  holen(id: string): Promise<CloudInstanz | null>;
  fuerMitglied(tenantId: string, actorId: string): Promise<CloudInstanz | null>;
  einfuegen(z: CloudInstanz): Promise<void>;
  aendern(id: string, teil: Partial<CloudInstanz>): Promise<void>;
  ereignis(instanzId: string, art: string, quelle: Quelle, details?: Record<string, unknown>): Promise<void>;
  ereignisse(instanzId: string, anzahl: number): Promise<Array<{ art: string; quelle: string; details: unknown; createdAt: string }>>;
  liste(): Promise<CloudInstanz[]>;
  /**
   * Die Instanz ist mit dem Konto verbunden (Relais oder GET /anmeldung): verbundenAt setzen,
   * „wartet_auf_verbindung“ → „laeuft“. Atomar, damit die Mail „Deine AVA läuft“ genau einmal
   * rausgeht. "neu" = erstmals verbunden, "wieder" = nach einer Abmeldung, "nichts" = schon so.
   */
  verbindungMelden(id: string): Promise<"neu" | "wieder" | "nichts">;
}

const SPALTEN = ["tenantId", "actorId", "flyApp", "region", "groesse", "zustand", "gewuenscht", "soll", "grund", "imageVersion", "maschineId", "volumeId", "schritte", "letzterFehler", "verbundenAt", "gesundAt", "abbestelltZum", "gestopptAt", "geloeschtAt"] as const;

function zeile(r: Record<string, unknown>): CloudInstanz {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null) ?? null);
  return {
    ...(r as unknown as CloudInstanz),
    schritte: (r.schritte as CloudInstanz["schritte"]) ?? {},
    verbundenAt: iso(r.verbundenAt), gesundAt: iso(r.gesundAt), abbestelltZum: iso(r.abbestelltZum), gestopptAt: iso(r.gestopptAt), geloeschtAt: iso(r.geloeschtAt),
    createdAt: iso(r.createdAt) ?? "", updatedAt: iso(r.updatedAt) ?? "",
  };
}

export function pgRepo(pool: pg.Pool): CloudRepo {
  return {
    async holen(id) {
      const r = await pool.query(`SELECT * FROM "CloudInstanz" WHERE id = $1`, [id]);
      return r.rows[0] ? zeile(r.rows[0]) : null;
    },
    async fuerMitglied(tenantId, actorId) {
      const r = await pool.query(`SELECT * FROM "CloudInstanz" WHERE "tenantId" = $1 AND "actorId" = $2 AND "geloeschtAt" IS NULL`, [tenantId, actorId]);
      return r.rows[0] ? zeile(r.rows[0]) : null;
    },
    async einfuegen(z) {
      await pool.query(
        `INSERT INTO "CloudInstanz" (id, ${SPALTEN.map((s) => `"${s}"`).join(", ")}) VALUES ($1, ${SPALTEN.map((_, i) => `$${i + 2}`).join(", ")})`,
        [z.id, ...SPALTEN.map((s) => (s === "schritte" ? JSON.stringify(z.schritte) : z[s]))],
      );
    },
    async aendern(id, teil) {
      const felder = Object.keys(teil).filter((k) => (SPALTEN as readonly string[]).includes(k));
      if (!felder.length) return;
      const werte = felder.map((k) => (k === "schritte" ? JSON.stringify(teil.schritte) : (teil as Record<string, unknown>)[k]));
      await pool.query(`UPDATE "CloudInstanz" SET ${felder.map((k, i) => `"${k}" = $${i + 2}`).join(", ")}, "updatedAt" = now() WHERE id = $1`, [id, ...werte]);
    },
    async ereignis(instanzId, art, quelle, details) {
      await pool.query(`INSERT INTO "CloudEreignis" (id, "instanzId", art, quelle, details) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), instanzId, art, quelle, details ? JSON.stringify(details) : null]);
    },
    async ereignisse(instanzId, anzahl) {
      const r = await pool.query(`SELECT art, quelle, details, "createdAt" FROM "CloudEreignis" WHERE "instanzId" = $1 ORDER BY "createdAt" DESC LIMIT $2`, [instanzId, anzahl]);
      return r.rows.map((x) => ({ ...x, createdAt: x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt }));
    },
    async liste() {
      const r = await pool.query(`SELECT * FROM "CloudInstanz" ORDER BY "createdAt" DESC LIMIT 500`);
      return r.rows.map(zeile);
    },
    async verbindungMelden(id) {
      const r = await pool.query<{ neu: boolean }>(
        `WITH alt AS (
           SELECT id, "verbundenAt" IS NULL AS neu FROM "CloudInstanz"
           WHERE id = $1 AND "geloeschtAt" IS NULL AND ("verbundenAt" IS NULL OR zustand = 'wartet_auf_verbindung')
           FOR UPDATE
         )
         UPDATE "CloudInstanz" c SET
           "verbundenAt" = COALESCE(c."verbundenAt", now()),
           zustand = CASE WHEN c.zustand = 'wartet_auf_verbindung' THEN 'laeuft' ELSE c.zustand END,
           schritte = c.schritte - 'wartetSeit' - 'm3_30m' - 'm3_24h',
           "updatedAt" = now()
         FROM alt WHERE c.id = alt.id
         RETURNING alt.neu`,
        [id],
      );
      return r.rows[0] ? (r.rows[0].neu ? "neu" : "wieder") : "nichts";
    },
  };
}

/** App-Name ohne Bezug zur Person (keine Mail, kein Name in Fly). */
export const appName = (zufall: () => string) => `ava-u-${zufall()}`;
const zufallKurz = () => randomBytes(8).toString("hex").slice(0, 10);

export class CloudBetrieb {
  /** Laufende Vorgänge je Instanz: nie zwei Fly-Abläufe gleichzeitig für dieselbe Instanz. */
  private readonly belegt = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repo: CloudRepo,
    private readonly fly: FlyKunden,
    private readonly opt: {
      zufall?: () => string;
      warteSek?: number;
      token?: (instanzId: string) => string | null;
      /** Z7: so lange nach einem Update auf „gesund“ warten, dann zurück (Standard 600 s). */
      updateWarteSek?: number;
      /** Abstand der Gesundheitsprüfungen nach einem Update (Standard 15 s). */
      pruefMs?: number;
      pause?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  beschaeftigt(id: string) { return this.belegt.has(id); }

  /** Lesetoken für GET /anmeldung der Instanz (null = Gateway ohne Geheimnis, Z4 aus). */
  gatewayToken(instanzId: string): string | null { return (this.opt.token ?? instanzToken)(instanzId); }

  private async exklusiv<T>(id: string, f: () => Promise<T>): Promise<T> {
    if (this.belegt.has(id)) throw new Error("Für diese Instanz läuft bereits ein Vorgang.");
    const p = f();
    this.belegt.set(id, p);
    try { return await p; } finally { this.belegt.delete(id); }
  }

  /** Legt den Datensatz an (oder liefert den bestehenden); die Fly-Schritte laufen über `fortsetzen`. */
  async anlegen(e: { tenantId: string; actorId: string; groesse?: Groesse; quelle: Quelle; zahlungOffen?: boolean }): Promise<CloudInstanz> {
    const da = await this.repo.fuerMitglied(e.tenantId, e.actorId);
    if (da) return da;
    const jetzt = new Date().toISOString();
    const z: CloudInstanz = {
      id: randomUUID(), tenantId: e.tenantId, actorId: e.actorId,
      flyApp: appName(this.opt.zufall ?? zufallKurz), region: "fra", groesse: e.groesse ?? "standard",
      zustand: e.zahlungOffen ? "zahlung_offen" : "wird_angelegt", gewuenscht: "laufen", soll: "laufen", grund: null, imageVersion: null, maschineId: null, volumeId: null,
      schritte: {}, letzterFehler: null, verbundenAt: null, gesundAt: null, abbestelltZum: null, gestopptAt: null, geloeschtAt: null, createdAt: jetzt, updatedAt: jetzt,
    };
    await this.repo.einfuegen(z);
    await this.repo.ereignis(z.id, "angefordert", e.quelle, { groesse: z.groesse, zahlungOffen: !!e.zahlungOffen });
    return z;
  }

  /** Zahlung eingegangen: aus „zahlung_offen“ wird „wird_angelegt“ (Anlegen übernimmt der Abgleicher). */
  async freigeben(id: string, quelle: Quelle): Promise<CloudInstanz | null> {
    const z = await this.muss(id);
    if (z.zustand !== "zahlung_offen") return null;
    await this.repo.aendern(id, { zustand: "wird_angelegt" });
    await this.repo.ereignis(id, "bezahlt", quelle, {});
    return { ...z, zustand: "wird_angelegt" };
  }

  /** Führt die noch fehlenden Anlege-Schritte aus. Wiederholbar. */
  fortsetzen(id: string, quelle: Quelle): Promise<CloudInstanz> {
    return this.exklusiv(id, async () => {
      let z = await this.muss(id);
      if (z.zustand !== "wird_angelegt") return z;
      const s = { ...z.schritte };
      const merke = async (teil: Partial<CloudInstanz>) => { await this.repo.aendern(id, { ...teil, schritte: s }); z = { ...z, ...teil, schritte: s }; };
      try {
        if (!s.app) {
          if (!(await this.fly.appVorhanden(z.flyApp))) await this.fly.appAnlegen(z.flyApp, `${z.flyApp}-netz`);
          s.app = true; await merke({});
        }
        if (!s.secrets) {
          const gt = this.gatewayToken(z.id);
          await this.fly.secretsSetzen(z.flyApp, {
            AVA_SECRETS_KEY: randomBytes(32).toString("hex"),
            AVA_SETUP_TOKEN: randomBytes(24).toString("base64url"), // Notzugang Betreiber; nicht gespeichert
            AVA_KONTO: z.actorId.toLowerCase(),
            ...(gt ? { [GATEWAY_SECRET]: gt } : {}), // abgeleitet, nicht gespeichert (anmeldung.ts)
          });
          s.secrets = true;
          if (gt) s.gatewayToken = true;
          await merke({});
        }
        if (!z.volumeId) await merke({ volumeId: await this.fly.volumeAnlegen(z.flyApp, GROESSEN[z.groesse].volumeGb) });
        if (!s.ips) { await this.fly.ipsZuweisen(z.flyApp); s.ips = true; await merke({}); }
        if (!z.maschineId) {
          const version = z.imageVersion ?? (await this.fly.neuesteVersion());
          if (!version) throw new Error("Kein Server-Image in der Kunden-Registry gefunden.");
          const m = await this.fly.maschineAnlegen(z.flyApp, maschinenKonfig({ instanzId: z.id, tenantId: z.tenantId, actorId: z.actorId, flyApp: z.flyApp, version, volumeId: z.volumeId!, groesse: z.groesse, gatewayToken: !!s.gatewayToken }));
          await merke({ maschineId: m.id, imageVersion: version });
        }
        const gestartet = await this.fly.warte(z.flyApp, z.maschineId!, "started", this.opt.warteSek ?? 180);
        if (!gestartet) throw new Error("Die Maschine ist nicht rechtzeitig gestartet.");
        delete s.versuche;
        const schonVerbunden = !!(await this.repo.holen(id))?.verbundenAt; // Relais kann schneller sein
        if (!schonVerbunden) s.wartetSeit = new Date().toISOString(); // Erinnerung M3 (abgleich.ts)
        await merke({ zustand: schonVerbunden ? "laeuft" : "wartet_auf_verbindung", letzterFehler: null });
        await this.repo.ereignis(id, "angelegt", quelle, { app: z.flyApp, version: z.imageVersion });
        return z;
      } catch (err) {
        const meldung = err instanceof Error ? err.message : String(err);
        s.versuche = Number(s.versuche ?? 0) + 1; // Zähler für den Abgleicher
        await this.repo.aendern(id, { letzterFehler: meldung.slice(0, 500), schritte: s });
        await this.repo.ereignis(id, "fehler", quelle, { schritt: "anlegen", meldung: meldung.slice(0, 300) });
        throw err;
      }
    });
  }

  /** Soll gestoppt: aus dem Proxy nehmen, stoppen. Die Maschine bleibt (Ruhen löscht sie). */
  /**
   * `absicht`: Admin/Betreiber will sie aus (Wunsch wird „gestoppt“). Der Abgleicher stoppt
   * ohne Absicht (z. B. Zahlung), damit sie nach Klärung von selbst wieder anläuft.
   */
  stoppen(id: string, grund: Grund, quelle: Quelle, opt: { absicht?: boolean } = {}): Promise<CloudInstanz> {
    return this.exklusiv(id, async () => {
      const z = await this.muss(id);
      if (z.zustand === "geloescht") throw new Error("Instanz ist gelöscht.");
      await this.repo.aendern(id, { soll: "gestoppt", grund, ...(opt.absicht ? { gewuenscht: "gestoppt" as const } : {}) });
      if (z.maschineId) {
        const m = await this.fly.maschineHolen(z.flyApp, z.maschineId);
        if (m && m.state !== "stopped" && m.state !== "destroyed") {
          await this.fly.cordon(z.flyApp, z.maschineId);
          await this.fly.stoppen(z.flyApp, z.maschineId);
          await this.fly.warte(z.flyApp, z.maschineId, "stopped", this.opt.warteSek ?? 120);
        }
      }
      const zustand: Zustand = z.zustand === "ruht" || !z.maschineId ? z.zustand : "gestoppt";
      const gestopptAt = z.gestopptAt ?? new Date().toISOString();
      await this.repo.aendern(id, { zustand, gestopptAt });
      await this.repo.ereignis(id, "gestoppt", quelle, { grund });
      return { ...z, soll: "gestoppt", grund, zustand, gestopptAt };
    });
  }

  /** Soll laufen: gestoppte Maschine starten, ruhende neu anlegen (gleiches Volume). */
  starten(id: string, quelle: Quelle, opt: { absicht?: boolean } = {}): Promise<CloudInstanz> {
    return this.exklusiv(id, async () => {
      const z = await this.muss(id);
      if (z.zustand === "geloescht") throw new Error("Instanz ist gelöscht.");
      if (z.zustand === "wird_angelegt" || z.zustand === "zahlung_offen") throw new Error("Instanz ist noch nicht angelegt.");
      await this.repo.aendern(id, { soll: "laufen", grund: null, ...(opt.absicht ? { gewuenscht: "laufen" as const } : {}) });
      let maschineId = z.maschineId;
      const vorhanden = maschineId ? await this.fly.maschineHolen(z.flyApp, maschineId) : null;
      if (!maschineId || !vorhanden || vorhanden.state === "destroyed") {
        const version = (await this.fly.neuesteVersion()) ?? z.imageVersion;
        if (!version || !z.volumeId) throw new Error("Neu anlegen nicht möglich (Image oder Volume fehlt).");
        const m = await this.fly.maschineAnlegen(z.flyApp, maschinenKonfig({ instanzId: z.id, tenantId: z.tenantId, actorId: z.actorId, flyApp: z.flyApp, version, volumeId: z.volumeId, groesse: z.groesse, gatewayToken: !!z.schritte.gatewayToken }));
        maschineId = m.id;
        await this.repo.aendern(id, { maschineId, imageVersion: version });
        await this.repo.ereignis(id, "neu_angelegt", quelle, { version });
      } else {
        await this.fly.uncordon(z.flyApp, maschineId);
        await this.fly.starten(z.flyApp, maschineId);
      }
      if (!(await this.fly.warte(z.flyApp, maschineId, "started", this.opt.warteSek ?? 180))) throw new Error("Die Maschine ist nicht rechtzeitig gestartet.");
      // Frisch lesen: Die Verbindung kann während des Wartens gemeldet worden sein (Relais).
      const zustand: Zustand = (await this.muss(id)).verbundenAt ? "laeuft" : "wartet_auf_verbindung";
      await this.repo.aendern(id, { zustand, gestopptAt: null, letzterFehler: null });
      await this.repo.ereignis(id, "gestartet", quelle, {});
      return { ...z, soll: "laufen", grund: null, zustand, maschineId, gestopptAt: null };
    });
  }

  /** Ruhen: Maschine löschen, Volume behalten. Danach kann Fly nichts mehr starten. */
  ruhen(id: string, quelle: Quelle): Promise<CloudInstanz> {
    return this.exklusiv(id, async () => {
      const z = await this.muss(id);
      if (z.soll !== "gestoppt" || (z.zustand !== "gestoppt" && z.zustand !== "ruht")) throw new Error("Nur eine gestoppte Instanz kann ruhen.");
      if (z.maschineId) await this.fly.maschineLoeschen(z.flyApp, z.maschineId);
      await this.repo.aendern(id, { zustand: "ruht", maschineId: null });
      await this.repo.ereignis(id, "ruht", quelle, {});
      return { ...z, zustand: "ruht", maschineId: null };
    });
  }

  /** Endgültig: Maschine, Volume (Sicherungen auf 1 Tag), App. */
  loeschen(id: string, quelle: Quelle): Promise<CloudInstanz> {
    return this.exklusiv(id, async () => {
      const z = await this.muss(id);
      if (z.zustand === "geloescht") return z;
      await this.repo.aendern(id, { soll: "gestoppt", gewuenscht: "gestoppt" });
      if (z.maschineId) await this.fly.maschineLoeschen(z.flyApp, z.maschineId);
      if (z.volumeId) await this.fly.volumeLoeschen(z.flyApp, z.volumeId);
      await this.fly.appLoeschen(z.flyApp);
      const geloeschtAt = new Date().toISOString();
      await this.repo.aendern(id, { zustand: "geloescht", maschineId: null, volumeId: null, geloeschtAt });
      await this.repo.ereignis(id, "geloescht", quelle, {});
      return { ...z, zustand: "geloescht", maschineId: null, volumeId: null, geloeschtAt };
    });
  }

  /**
   * Z7: Server-Version tauschen. Danach bis zu `updateWarteSek` auf „gesund“ warten (Prozess
   * antwortet, und war sie verbunden, ist sie wieder angemeldet); sonst automatisch zurück auf
   * die alte Version. Läuft exklusiv: Der Abgleicher lässt die Instanz solange in Ruhe (keine
   * Ausfallmail während des Updates).
   */
  aktualisieren(id: string, nach: string, quelle: Quelle): Promise<{ ergebnis: "ok" | "aktuell" | "zurueck"; von: string | null; nach: string; zurueckOk?: boolean }> {
    return this.exklusiv(id, async () => {
      const z = await this.muss(id);
      if (z.zustand !== "laeuft" && z.zustand !== "wartet_auf_verbindung") throw new Error("Nur eine laufende Instanz wird aktualisiert.");
      if (!z.maschineId) throw new Error("Instanz hat keine Maschine.");
      const von = z.imageVersion;
      if (von === nach) return { ergebnis: "aktuell" as const, von, nach };
      const konfig = (version: string) => maschinenKonfig({ instanzId: z.id, tenantId: z.tenantId, actorId: z.actorId, flyApp: z.flyApp, version, volumeId: z.volumeId!, groesse: z.groesse, gatewayToken: !!z.schritte.gatewayToken });
      await this.repo.ereignis(id, "update_start", quelle, { von, nach });
      await this.fly.maschineAktualisieren(z.flyApp, z.maschineId, konfig(nach));
      await this.repo.aendern(id, { imageVersion: nach });
      if (await this.bereitNachUpdate(z)) {
        await this.repo.ereignis(id, "aktualisiert", quelle, { von, nach });
        return { ergebnis: "ok" as const, von, nach };
      }
      // Nicht gesund geworden: zurück auf die vorige Version (falls bekannt).
      let zurueckOk = false;
      if (von) {
        await this.fly.maschineAktualisieren(z.flyApp, z.maschineId, konfig(von));
        await this.repo.aendern(id, { imageVersion: von });
        zurueckOk = await this.bereitNachUpdate(z);
      }
      await this.repo.ereignis(id, "update_zurueck", quelle, { von, nach, zurueckOk });
      return { ergebnis: "zurueck" as const, von, nach, zurueckOk };
    });
  }

  /** Nach einem Update: gestartet, antwortet, und eine verbundene Instanz ist wieder angemeldet. */
  private async bereitNachUpdate(z: CloudInstanz): Promise<boolean> {
    const sek = this.opt.updateWarteSek ?? 600;
    const pruefMs = this.opt.pruefMs ?? 15_000;
    const pause = this.opt.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const ende = Date.now() + sek * 1000;
    if (!(await this.fly.warte(z.flyApp, z.maschineId!, "started", Math.min(180, sek)))) return false;
    const token = z.schritte.gatewayToken ? this.gatewayToken(z.id) : null;
    const versuche = Math.max(1, Math.ceil((sek * 1000) / Math.max(pruefMs, 1)));
    for (let n = 0; n < versuche && (pruefMs === 0 || Date.now() < ende); n++) {
      if (token) {
        const an = await this.fly.anmeldung(z.flyApp, token);
        if (an && (an.angemeldet || !z.verbundenAt)) return true;
      } else if (await this.fly.gesund(z.flyApp)) return true;
      await pause(pruefMs);
    }
    return false;
  }

  /** Verbunden gemeldet (Relais, GET /anmeldung): siehe CloudRepo.verbindungMelden. */
  async verbindungMelden(id: string, quelle: Quelle, details: Record<string, unknown> = {}): Promise<"neu" | "wieder" | "nichts"> {
    const r = await this.repo.verbindungMelden(id);
    if (r !== "nichts") await this.repo.ereignis(id, r === "neu" ? "verbunden" : "wieder_verbunden", quelle, details);
    return r;
  }

  /** Die Instanz wartet wieder auf eine Bestätigung (Anmeldung verloren): zurück auf „wartet“. */
  async verbindungVerloren(id: string, quelle: Quelle, jetzt: number = Date.now()): Promise<void> {
    const z = await this.muss(id);
    if (z.zustand !== "laeuft") return;
    const schritte: CloudInstanz["schritte"] = { ...z.schritte, wartetSeit: new Date(jetzt).toISOString() };
    delete schritte.m3_30m; delete schritte.m3_24h;
    await this.repo.aendern(id, { zustand: "wartet_auf_verbindung", schritte });
    await this.repo.ereignis(id, "abgemeldet", quelle, {});
  }

  /** Datensatz plus Live-Zustand der Maschine bei Fly. */
  async stand(id: string) {
    const z = await this.muss(id);
    const m = z.maschineId ? await this.fly.maschineHolen(z.flyApp, z.maschineId).catch(() => null) : null;
    return { ...z, fly: m ? { state: m.state, image: m.config?.image ?? null } : null, beschaeftigt: this.beschaeftigt(id) };
  }

  private async muss(id: string) {
    const z = await this.repo.holen(id);
    if (!z) throw new Error("Instanz nicht gefunden.");
    return z;
  }
}
