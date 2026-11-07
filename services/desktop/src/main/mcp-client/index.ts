// Verwaltung der verbundenen Dienste (docs/PLAN_CLOSE_MCP.md, C2): laedt die
// Dienste beim Start, verbindet sie im Hintergrund, registriert ihre Werkzeuge
// in der Werkzeugliste des Agenten (und damit in tool_search und in den
// Workflows) und entfernt sie beim Trennen. Organisationsschalter
// `mcp.dienste`: aus = keine Werkzeuge, keine Verbindung.

import { EventEmitter } from "node:events";
import type { ToolRegistry } from "../agent/tool-registry";
import { featureEnabled, onOrgPolicyChange } from "../org-policy";
import { setzeWerkzeugArt } from "../workflows/catalog";
import { McpVerbindung, fehlerText, zugangsKopfzeilen } from "./client";
import { agentenkarteLaden, auftragSenden, auftragStatus } from "./a2a";
import { entferneDienst, ladeDienste, neueId, slugAus, speichereDienst, type DienstArt, type McpDienst, type McpGeheimnisse, type McpZugangArt } from "./store";
import { baueAgentWerkzeuge, baueWerkzeuge } from "./werkzeuge";

export interface McpDienstAnzeige extends McpDienst {
  art: DienstArt;
  verbunden: boolean;
  transport: "http" | "sse" | "a2a" | null;
  werkzeugNamen: string[];
}

interface Laufend {
  dienst: McpDienst;
  geheimnisse: McpGeheimnisse;
  verbindung: McpVerbindung | null;
  /** A2A: geladene Agentenkarte gilt als "verbunden". */
  agentVerbunden: boolean;
  werkzeugNamen: string[];
}

function artVon(d: McpDienst): DienstArt {
  return d.art === "a2a" ? "a2a" : "mcp";
}

/** Eingabe fuer einen neuen Dienst (Einstellungen oder Zugangskarte im Chat). */
export interface McpHinzufuegen {
  name: string;
  url: string;
  art?: DienstArt;
  zugang: McpZugangArt;
  zugangscode?: string;
  kopfzeilen?: Record<string, string>;
  benutzer?: string;
  passwort?: string;
  clientId?: string;
  clientSecret?: string;
  tokenAdresse?: string;
  scope?: string;
}

function pruefeTokenAdresse(a: string | undefined): string {
  let u: URL;
  try {
    u = new URL((a ?? "").trim());
  } catch {
    throw new Error("Die Adresse für die Anmeldung ist keine gültige Internetadresse.");
  }
  if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw new Error("Die Adresse für die Anmeldung muss mit https beginnen.");
  return u.toString();
}

export class McpDienste extends EventEmitter {
  private readonly laufend = new Map<string, Laufend>();
  private gestartet = false;

  constructor(private readonly deps: { registry: ToolRegistry; log?: (m: string) => void }) {
    super();
  }

  async start(): Promise<void> {
    if (this.gestartet) return;
    this.gestartet = true;
    const alle = await ladeDienste().catch(() => []);
    for (const { dienst, geheimnisse } of alle) this.laufend.set(dienst.id, { dienst, geheimnisse, verbindung: null, agentVerbunden: false, werkzeugNamen: [] });
    onOrgPolicyChange(() => {
      if (!featureEnabled("mcp.dienste")) void this.alleTrennen();
      else void this.alleVerbinden();
    });
    void this.alleVerbinden();
  }

  liste(): McpDienstAnzeige[] {
    return [...this.laufend.values()].map((l) => this.anzeige(l));
  }

  private async alleVerbinden(): Promise<void> {
    if (!featureEnabled("mcp.dienste")) return;
    for (const l of this.laufend.values()) {
      if (l.verbindung || l.agentVerbunden) continue;
      await this.verbinde(l).catch(() => undefined);
    }
  }

  private async alleTrennen(): Promise<void> {
    for (const l of this.laufend.values()) await this.trenne(l);
    this.emit("aenderung", this.liste());
  }

  /** Neuen Dienst anlegen: verbinden, Werkzeuge lesen, speichern. Wirft bei Fehlern (nichts gespeichert). */
  async hinzufuegen(args: McpHinzufuegen): Promise<McpDienstAnzeige> {
    if (!featureEnabled("mcp.dienste")) throw new Error("Deine Organisation hat weitere Dienste abgeschaltet.");
    const name = args.name.trim();
    const url = args.url.trim();
    if (name.length < 2) throw new Error("Bitte einen Namen angeben.");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("Die Adresse ist keine gültige Internetadresse.");
    }
    if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw new Error("Nur https-Adressen sind erlaubt.");
    const art: DienstArt = args.art === "a2a" ? "a2a" : "mcp";
    // Gleiche Adresse und Art = Zugang erneuern: Eintrag (id, slug, Werkzeugnamen)
    // bleibt, Zugang und Stand werden ersetzt. Kein Doppel-Eintrag.
    const bisher = [...this.laufend.values()].find((l) => artVon(l.dienst) === art && l.dienst.url === u.toString()) ?? null;
    const vergeben = new Set([...this.laufend.values()].filter((l) => l !== bisher).map((l) => l.dienst.slug));
    const dienst: McpDienst = {
      id: bisher?.dienst.id ?? neueId(),
      art,
      name,
      slug: bisher?.dienst.slug ?? slugAus(name, vergeben),
      url: u.toString(),
      zugang: args.zugang,
      kopfzeilenNamen: args.zugang === "kopfzeilen" ? Object.keys(args.kopfzeilen ?? {}).filter(Boolean) : [],
      ...(args.zugang === "client" ? { tokenAdresse: pruefeTokenAdresse(args.tokenAdresse), ...(args.scope?.trim() ? { scope: args.scope.trim().slice(0, 500) } : {}) } : {}),
      erstelltAm: bisher?.dienst.erstelltAm ?? new Date().toISOString(),
      zuletztVerbunden: null,
      werkzeuge: 0,
      fehler: null,
    };
    const geheimnisse: McpGeheimnisse = {
      ...(args.zugang === "zugangscode" && args.zugangscode ? { zugangscode: args.zugangscode.trim() } : {}),
      ...(args.zugang === "kopfzeilen" && args.kopfzeilen ? { kopfzeilen: Object.fromEntries(Object.entries(args.kopfzeilen).filter(([k, v]) => k.trim() && v.trim()).map(([k, v]) => [k.trim(), v.trim()])) } : {}),
      ...(args.zugang === "anmeldung" ? { benutzer: (args.benutzer ?? "").trim(), passwort: args.passwort ?? "" } : {}),
      ...(args.zugang === "client" ? { clientId: (args.clientId ?? "").trim(), clientSecret: (args.clientSecret ?? "").trim() } : {}),
    };
    if (args.zugang === "anmeldung" && (!geheimnisse.benutzer || !geheimnisse.passwort)) throw new Error("Bitte Benutzername und Passwort angeben.");
    if (args.zugang === "client" && (!geheimnisse.clientId || !geheimnisse.clientSecret)) throw new Error("Bitte Client-ID und Client-Secret angeben.");
    const l: Laufend = { dienst, geheimnisse, verbindung: null, agentVerbunden: false, werkzeugNamen: [] };
    // Alte Verbindung erst trennen (gleiche Werkzeugnamen); scheitert der neue
    // Zugang, laeuft der alte Eintrag unveraendert weiter.
    if (bisher) await this.trenne(bisher);
    try {
      await this.verbinde(l, { werfen: true });
    } catch (err) {
      if (bisher) void this.verbinde(bisher).catch(() => undefined);
      throw err;
    }
    await speichereDienst(l.dienst, geheimnisse);
    this.laufend.set(dienst.id, l);
    this.emit("aenderung", this.liste());
    return this.anzeige(l);
  }

  async entfernen(id: string): Promise<void> {
    const l = this.laufend.get(id);
    if (!l) return;
    await this.trenne(l);
    this.laufend.delete(id);
    await entferneDienst(id);
    this.emit("aenderung", this.liste());
  }

  /** Verbindung erneuern und Werkzeugliste neu lesen. */
  async pruefen(id: string): Promise<McpDienstAnzeige> {
    const l = this.laufend.get(id);
    if (!l) throw new Error("Dienst nicht gefunden.");
    await this.trenne(l);
    await this.verbinde(l, { werfen: true });
    await speichereDienst(l.dienst);
    this.emit("aenderung", this.liste());
    return this.anzeige(l);
  }

  private anzeige(l: Laufend): McpDienstAnzeige {
    const art = artVon(l.dienst);
    return { ...l.dienst, art, verbunden: art === "a2a" ? l.agentVerbunden : Boolean(l.verbindung), transport: art === "a2a" ? (l.agentVerbunden ? "a2a" : null) : (l.verbindung?.art ?? null), werkzeugNamen: [...l.werkzeugNamen] };
  }

  private async verbinde(l: Laufend, opts: { werfen?: boolean } = {}): Promise<void> {
    if (artVon(l.dienst) === "a2a") return this.verbindeAgent(l, opts);
    const v = new McpVerbindung(l.dienst, l.geheimnisse);
    try {
      await v.verbinden();
      const beschreibungen = await v.werkzeuge();
      const gebaut = baueWerkzeuge(l.dienst, beschreibungen, (name, args, signal) => this.mitFehlermeldung(l, () => v.aufrufen(name, args, signal)));
      for (const n of l.werkzeugNamen) this.deps.registry.unregister(n);
      l.werkzeugNamen = [];
      for (const { tool, klasse } of gebaut) {
        if (this.deps.registry.has(tool.name)) this.deps.registry.unregister(tool.name);
        this.deps.registry.register(tool);
        setzeWerkzeugArt(tool.name, klasse);
        l.werkzeugNamen.push(tool.name);
      }
      l.verbindung = v;
      l.dienst = { ...l.dienst, werkzeuge: gebaut.length, zuletztVerbunden: new Date().toISOString(), fehler: null };
      this.deps.log?.(`[mcp-dienste] ${l.dienst.name}: ${gebaut.length} Werkzeuge über ${v.art}`);
      if (this.laufend.has(l.dienst.id)) {
        await speichereDienst(l.dienst).catch(() => undefined);
        this.emit("aenderung", this.liste());
      }
    } catch (err) {
      await v.schliessen().catch(() => undefined);
      const text = fehlerText(err);
      l.dienst = { ...l.dienst, fehler: text };
      this.deps.log?.(`[mcp-dienste] ${l.dienst.name}: ${text}`);
      if (this.laufend.has(l.dienst.id)) this.emit("aenderung", this.liste());
      if (opts.werfen) throw new Error(text);
    }
  }

  /** A2A: Agentenkarte laden, zwei Werkzeuge registrieren; keine stehende Verbindung. */
  private async verbindeAgent(l: Laufend, opts: { werfen?: boolean } = {}): Promise<void> {
    try {
      const karte = await agentenkarteLaden(l.dienst.url, await zugangsKopfzeilen(l.dienst, l.geheimnisse));
      const gebaut = baueAgentWerkzeuge(
        l.dienst,
        karte,
        (text, signal) => this.mitFehlermeldung(l, async () => auftragSenden(karte, await zugangsKopfzeilen(l.dienst, l.geheimnisse), text, { signal })),
        (taskId, signal) => this.mitFehlermeldung(l, async () => auftragStatus(karte, await zugangsKopfzeilen(l.dienst, l.geheimnisse), taskId, signal)),
      );
      for (const n of l.werkzeugNamen) this.deps.registry.unregister(n);
      l.werkzeugNamen = [];
      for (const { tool, klasse } of gebaut) {
        if (this.deps.registry.has(tool.name)) this.deps.registry.unregister(tool.name);
        this.deps.registry.register(tool);
        setzeWerkzeugArt(tool.name, klasse);
        l.werkzeugNamen.push(tool.name);
      }
      l.agentVerbunden = true;
      l.dienst = { ...l.dienst, werkzeuge: gebaut.length, zuletztVerbunden: new Date().toISOString(), fehler: null };
      this.deps.log?.(`[mcp-dienste] Agent ${l.dienst.name} (${karte.name}): ${karte.skills.length} Fähigkeiten`);
      if (this.laufend.has(l.dienst.id)) {
        await speichereDienst(l.dienst).catch(() => undefined);
        this.emit("aenderung", this.liste());
      }
    } catch (err) {
      const text = fehlerText(err);
      l.agentVerbunden = false;
      l.dienst = { ...l.dienst, fehler: text };
      this.deps.log?.(`[mcp-dienste] Agent ${l.dienst.name}: ${text}`);
      if (this.laufend.has(l.dienst.id)) this.emit("aenderung", this.liste());
      if (opts.werfen) throw new Error(text);
    }
  }

  /**
   * Joyce 2026-11-05: Ein abgelaufener oder ungueltiger Zugang muss sichtbar
   * werden — nicht nur als Werkzeugfehler im Chat. Zugangsfehler (401/403)
   * landen als `fehler` am Dienst (Karte in den Einstellungen, Warnband in
   * der App), und das Werkzeug sagt dem Modell, wo der Nutzer den Zugang
   * erneuert. Andere Fehler bleiben Werkzeugfehler ohne Dienst-Markierung.
   */
  private async mitFehlermeldung<T>(l: Laufend, f: () => Promise<T>): Promise<T> {
    try {
      const r = await f();
      if (l.dienst.fehler) {
        l.dienst = { ...l.dienst, fehler: null };
        this.emit("aenderung", this.liste());
      }
      return r;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      const zugang = /\b(401|403)\b|unauthori|forbidden|invalid[_ ]token|token.*(expired|abgelaufen)|abgelaufen/i.test(m);
      if (zugang) {
        const text = `Zugang abgelehnt oder abgelaufen (${fehlerText(err)})`;
        l.dienst = { ...l.dienst, fehler: text };
        await speichereDienst(l.dienst).catch(() => undefined);
        this.emit("aenderung", this.liste());
        this.deps.log?.(`[mcp-dienste] ${l.dienst.name}: ${text}`);
        throw new Error(
          `Der Zugang zu ${l.dienst.name} ist abgelaufen oder ungültig. Das Werkzeug kann erst wieder laufen, wenn der Nutzer unter Einstellungen → Verbindungen → Weitere Dienste den Zugangscode erneuert (Dienst entfernen und neu verbinden). Nicht erneut versuchen; dem Nutzer den Weg nennen.`,
        );
      }
      throw new Error(`${l.dienst.name}: ${fehlerText(err)}`);
    }
  }

  private async trenne(l: Laufend): Promise<void> {
    for (const n of l.werkzeugNamen) this.deps.registry.unregister(n);
    l.werkzeugNamen = [];
    l.agentVerbunden = false;
    const v = l.verbindung;
    l.verbindung = null;
    if (v) await v.schliessen();
  }

  async stop(): Promise<void> {
    for (const l of this.laufend.values()) await this.trenne(l);
  }
}
