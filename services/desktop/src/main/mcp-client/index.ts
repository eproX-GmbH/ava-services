// Verwaltung der verbundenen Dienste (docs/PLAN_CLOSE_MCP.md, C2): laedt die
// Dienste beim Start, verbindet sie im Hintergrund, registriert ihre Werkzeuge
// in der Werkzeugliste des Agenten (und damit in tool_search und in den
// Workflows) und entfernt sie beim Trennen. Organisationsschalter
// `mcp.dienste`: aus = keine Werkzeuge, keine Verbindung.

import { EventEmitter } from "node:events";
import type { ToolRegistry } from "../agent/tool-registry";
import { featureEnabled, onOrgPolicyChange } from "../org-policy";
import { setzeWerkzeugArt } from "../workflows/catalog";
import { McpVerbindung, fehlerText } from "./client";
import { entferneDienst, ladeDienste, neueId, slugAus, speichereDienst, type McpDienst, type McpGeheimnisse, type McpZugangArt } from "./store";
import { baueWerkzeuge } from "./werkzeuge";

export interface McpDienstAnzeige extends McpDienst {
  verbunden: boolean;
  transport: "http" | "sse" | null;
  werkzeugNamen: string[];
}

interface Laufend {
  dienst: McpDienst;
  geheimnisse: McpGeheimnisse;
  verbindung: McpVerbindung | null;
  werkzeugNamen: string[];
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
    for (const { dienst, geheimnisse } of alle) this.laufend.set(dienst.id, { dienst, geheimnisse, verbindung: null, werkzeugNamen: [] });
    onOrgPolicyChange(() => {
      if (!featureEnabled("mcp.dienste")) void this.alleTrennen();
      else void this.alleVerbinden();
    });
    void this.alleVerbinden();
  }

  liste(): McpDienstAnzeige[] {
    return [...this.laufend.values()].map((l) => ({ ...l.dienst, verbunden: Boolean(l.verbindung), transport: l.verbindung?.art ?? null, werkzeugNamen: [...l.werkzeugNamen] }));
  }

  private async alleVerbinden(): Promise<void> {
    if (!featureEnabled("mcp.dienste")) return;
    for (const l of this.laufend.values()) {
      if (l.verbindung) continue;
      await this.verbinde(l).catch(() => undefined);
    }
  }

  private async alleTrennen(): Promise<void> {
    for (const l of this.laufend.values()) await this.trenne(l);
    this.emit("aenderung", this.liste());
  }

  /** Neuen Dienst anlegen: verbinden, Werkzeuge lesen, speichern. Wirft bei Fehlern (nichts gespeichert). */
  async hinzufuegen(args: { name: string; url: string; zugang: McpZugangArt; zugangscode?: string; kopfzeilen?: Record<string, string> }): Promise<McpDienstAnzeige> {
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
    const vergeben = new Set([...this.laufend.values()].map((l) => l.dienst.slug));
    const dienst: McpDienst = {
      id: neueId(),
      name,
      slug: slugAus(name, vergeben),
      url: u.toString(),
      zugang: args.zugang,
      kopfzeilenNamen: args.zugang === "kopfzeilen" ? Object.keys(args.kopfzeilen ?? {}).filter(Boolean) : [],
      erstelltAm: new Date().toISOString(),
      zuletztVerbunden: null,
      werkzeuge: 0,
      fehler: null,
    };
    const geheimnisse: McpGeheimnisse = {
      ...(args.zugang === "zugangscode" && args.zugangscode ? { zugangscode: args.zugangscode.trim() } : {}),
      ...(args.zugang === "kopfzeilen" && args.kopfzeilen ? { kopfzeilen: Object.fromEntries(Object.entries(args.kopfzeilen).filter(([k, v]) => k.trim() && v.trim()).map(([k, v]) => [k.trim(), v.trim()])) } : {}),
    };
    const l: Laufend = { dienst, geheimnisse, verbindung: null, werkzeugNamen: [] };
    await this.verbinde(l, { werfen: true });
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
    return { ...l.dienst, verbunden: Boolean(l.verbindung), transport: l.verbindung?.art ?? null, werkzeugNamen: [...l.werkzeugNamen] };
  }

  private async verbinde(l: Laufend, opts: { werfen?: boolean } = {}): Promise<void> {
    const v = new McpVerbindung(l.dienst, l.geheimnisse);
    try {
      await v.verbinden();
      const beschreibungen = await v.werkzeuge();
      const gebaut = baueWerkzeuge(l.dienst, beschreibungen, (name, args, signal) => v.aufrufen(name, args, signal));
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

  private async trenne(l: Laufend): Promise<void> {
    for (const n of l.werkzeugNamen) this.deps.registry.unregister(n);
    l.werkzeugNamen = [];
    const v = l.verbindung;
    l.verbindung = null;
    if (v) await v.schliessen();
  }

  async stop(): Promise<void> {
    for (const l of this.laufend.values()) await this.trenne(l);
  }
}
