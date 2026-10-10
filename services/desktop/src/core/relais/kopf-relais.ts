// MCP-Relais, Kopf-Seite (docs/PLAN_AVA_CLOUD.md §11, X1).
//
// Der Kopf (Desktop-App oder Server) verbindet sich ausgehend per WebSocket mit
// dem Gateway (`/kopf-relais?access_token=…`), meldet eine Werkzeugliste an und
// beantwortet Aufrufe, die Claude oder ChatGPT über mcp.ava.bi stellen. Der
// Nutzer braucht so keine eigene öffentliche Adresse; der Gateway kennt den Kopf
// nur, solange er läuft.
//
// Was gemeldet wird: eine Kernmenge aus der ToolRegistry (dieselben Werkzeuge
// wie im Chat) plus zwei Meta-Werkzeuge, die alle übrigen erschließen:
//   werkzeug_suchen(q)              → passende Werkzeuge mit Schema
//   werkzeug_ausfuehren(name, args) → führt jedes Werkzeug der Registry aus
// Kein Client verträgt 280 Schemas im Kontext; AVA selbst arbeitet genauso
// (tool_search / tool_load, agent/tool-selection.ts).
//
// Rückfragen und Freigaben: Ein Werkzeug, das nachfragt (askChoice/askText) oder
// eine Freigabe braucht (confirmAction), läuft nicht weiter, sondern antwortet
// mit `rueckfrage` und einem Token. Der aufrufende Agent stellt die Frage dem
// Menschen und ruft dasselbe Werkzeug erneut auf, mit `_antworten: { "<token>":
// "<wert>" }`. Der zweite Lauf startet von vorn und findet die Antwort vor.
// Deterministisch, ohne hängende Zustände, und destruktive Aktionen kommen nie
// ohne diesen Umweg durch (Vollmacht-Stufe des Kanals ist „none“).

import { createHash } from "node:crypto";
import type { ToolRegistry } from "../../main/agent/tool-registry";
import type { Tool, ToolContext } from "../../main/agent/types";
import type { AgentChoiceOption } from "../../shared/types";
import { UiBridge, type RemoteAskHandler } from "../../main/agent/ui-bridge";
import { AvaFragen, type AvaAgent } from "./ava-fragen";

export interface KopfRelaisDeps {
  gatewayUrl: string;
  getAccessToken: () => Promise<string | null>;
  istAngemeldet: () => boolean;
  registry: ToolRegistry;
  version: string;
  audit?: (eintrag: { action: string; summary: string; metadata: Record<string, unknown> }) => void;
  log?: (zeile: string) => void;
  /** AVAs Orchestrator für ava_fragen; fehlt er, wird das Werkzeug nicht angeboten. */
  agent?: AvaAgent;
}

/**
 * Werkzeuge, die direkt in der MCP-Liste stehen. Ausgewählt nach dem, was der
 * Gateway NICHT schon selbst anbietet: Firmen suchen/lesen, Kontakte, Import,
 * Vorgänge und Neuigkeiten laufen über die firma_* / auftrag_* / meldungen-
 * Werkzeuge des Gateways (die auch ohne laufende AVA antworten). Doppelte
 * Namen (company_search neben firma_suchen) würden den Agenten nur verwirren.
 * Alles Übrige erreicht der Agent über werkzeug_suchen / werkzeug_ausfuehren.
 */
const KERNMENGE = [
  // Gedächtnis und Nutzerbild
  "recall_memory",
  "remember",
  "profile_get",
  // Meldungs-Postfach der App (Alarme, Radar, Status), getrennt von meldungen (Neuigkeiten je Firma)
  "alerts_list",
  // Workflows: ansehen, starten, Freigaben
  "workflow_list",
  "workflow_get",
  "workflow_run",
  "workflow_approvals",
  "workflow_approve",
  // Vertiefung über die Gateway-Lesewerkzeuge hinaus
  "publication_search",
  "kunden_umkehrsuche",
  "company_network",
  "buying_center_anzeigen",
  "evaluation_start_best_match",
  "evaluation_best_match_get",
  "discovery_candidates",
  // Postfach und CRM
  "mail_list_inbox",
  "mail_get_message",
  "crm_status",
  "crm_search_hubspot_companies",
  // Skills und Hintergrundaufgaben
  "skill_search",
  "skill_get",
  "aufgaben_liste",
];

/** Werkzeuge, die nur im AVA-Chat Sinn ergeben und über das Relais nie laufen. */
const NUR_CHAT = new Set(["ask_user_choice", "ask_user_text", "navigate", "notify", "tool_search", "tool_load", "report_self_correction"]);

/** Gateway-Werkzeuge, die dasselbe leisten; werkzeug_suchen weist auf sie hin statt sie zu doppeln. */
const GATEWAY_STATT: Record<string, string> = {
  company_search: "firma_suchen",
  company_get: "firma_lesen",
  company_contacts: "firma_kontakte",
  import_companies: "import_anlegen",
  transactions_list: "auftraege",
  transaction_get: "auftrag_status",
};


const MAX_ERGEBNIS_ZEICHEN = 30_000;
const AUFRUF_TIMEOUT_MS = 110_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

class RueckfrageNoetig extends Error {
  constructor(
    readonly rueckfrage: { token: string; frage: string; optionen?: Array<{ value: string; label: string }>; freitext?: boolean; optional?: boolean },
  ) {
    super("Rückfrage nötig");
    this.name = "RueckfrageNoetig";
  }
}

function token(werkzeug: string, frage: string): string {
  return createHash("sha256").update(`${werkzeug}\n${frage}`).digest("hex").slice(0, 10);
}

/** Beantwortet Rückfragen aus vorab mitgegebenen Antworten; sonst Abbruch mit Token. */
class RelaisRueckfragen implements RemoteAskHandler {
  constructor(
    private readonly werkzeug: string,
    private readonly antworten: Record<string, string>,
  ) {}

  async askChoice(prompt: string, options: AgentChoiceOption[]): Promise<string> {
    const t = token(this.werkzeug, prompt);
    const vorab = this.antworten[t];
    if (vorab !== undefined) {
      const treffer = options.find((o) => o.value === vorab || o.label === vorab);
      if (treffer) return treffer.value;
    }
    throw new RueckfrageNoetig({ token: t, frage: prompt, optionen: options.map((o) => ({ value: o.value, label: o.label })) });
  }

  async askText(prompt: string, opts: { optional?: boolean }): Promise<string> {
    const t = token(this.werkzeug, prompt);
    const vorab = this.antworten[t];
    if (vorab !== undefined) return vorab;
    throw new RueckfrageNoetig({ token: t, frage: prompt, freitext: true, optional: opts.optional === true });
  }
}

function kuerzen(text: string, max = MAX_ERGEBNIS_ZEICHEN): string {
  return text.length > max ? text.slice(0, max) + `\n… [gekürzt, ${text.length} Zeichen insgesamt]` : text;
}

function kompakt(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function zusammenfassung(tool: Tool): string {
  if (tool.summary) return tool.summary;
  const desc = tool.description.trim();
  const m = desc.match(/^.+?[.!?](?:\s|$)/);
  const satz = m ? m[0].trim() : desc;
  return satz.length > 200 ? satz.slice(0, 197) + "…" : satz;
}

export class KopfRelais {
  private ws: WebSocket | null = null;
  private laeuft = false;
  private reconnectMs = RECONNECT_MIN_MS;
  private timer: NodeJS.Timeout | null = null;
  private readonly offen = new Set<AbortController>();

  private readonly avaFragen: AvaFragen | null;

  constructor(private readonly deps: KopfRelaisDeps) {
    this.avaFragen = deps.agent ? new AvaFragen(deps.agent) : null;
  }

  start(): void {
    if (this.laeuft) return;
    this.laeuft = true;
    void this.verbinden();
  }

  stop(): void {
    this.laeuft = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const c of this.offen) c.abort();
    try {
      this.ws?.close(1000, "AVA beendet");
    } catch {
      /* egal */
    }
    this.ws = null;
  }

  stand(): { verbunden: boolean; werkzeuge: number } {
    return { verbunden: this.ws?.readyState === WebSocket.OPEN, werkzeuge: this.manifest().length };
  }

  private log(zeile: string): void {
    (this.deps.log ?? ((z: string) => console.log(z)))(`[mcp-relais] ${zeile}`);
  }

  private spaeter(): void {
    if (!this.laeuft) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.verbinden(), this.reconnectMs);
    this.timer.unref?.();
    // Normaler Backoff bis 60 s; nach einer Abweisung (4002) bleibt es bei 5 Minuten.
    if (this.reconnectMs < RECONNECT_MAX_MS) this.reconnectMs = Math.min(RECONNECT_MAX_MS, Math.round(this.reconnectMs * 1.7));
  }

  private wsUrl(tokenWert: string): string {
    const u = new URL(this.deps.gatewayUrl);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    u.pathname = "/kopf-relais";
    u.search = `?access_token=${encodeURIComponent(tokenWert)}`;
    return u.toString();
  }

  private async verbinden(): Promise<void> {
    if (!this.laeuft) return;
    if (!this.deps.istAngemeldet()) {
      this.spaeter();
      return;
    }
    let tokenWert: string | null = null;
    try {
      tokenWert = await this.deps.getAccessToken();
    } catch {
      tokenWert = null;
    }
    if (!tokenWert) {
      this.spaeter();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl(tokenWert));
    } catch (err) {
      this.log(`Verbindung nicht möglich: ${err instanceof Error ? err.message : String(err)}`);
      this.spaeter();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.reconnectMs = RECONNECT_MIN_MS;
      const werkzeuge = this.manifest();
      ws.send(JSON.stringify({ typ: "hallo", version: this.deps.version, werkzeuge }));
      this.log(`verbunden, ${werkzeuge.length} Werkzeuge gemeldet`);
    });
    ws.addEventListener("message", (ev) => {
      void this.nachricht(ws, typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws === ws) this.ws = null;
      this.log(`getrennt (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
      // 4002: ein anderer Kopf desselben Kontos ist schon verbunden (z. B. der
      // Server, während die Desktop-App läuft); nur selten erneut versuchen.
      if (ev.code === 4002 || ev.code === 4001) this.reconnectMs = 5 * RECONNECT_MAX_MS;
      this.spaeter();
    });
    ws.addEventListener("error", () => {
      /* close folgt */
    });
  }

  private async nachricht(ws: WebSocket, roh: string): Promise<void> {
    let n: { typ?: string; id?: string; name?: string; args?: unknown };
    try {
      n = JSON.parse(roh);
    } catch {
      return;
    }
    if (n.typ !== "aufruf" || typeof n.id !== "string" || typeof n.name !== "string") return;
    const args = n.args && typeof n.args === "object" ? (n.args as Record<string, unknown>) : {};
    const start = Date.now();
    const erg = await this.ausfuehren(n.name, args);
    this.deps.audit?.({
      action: "mcp.relais.call",
      summary: `MCP-Aufruf ${n.name}${erg.isError ? " (Fehler)" : ""}`,
      metadata: { werkzeug: n.name, ms: Date.now() - start, fehler: erg.isError === true, rueckfrage: erg.rueckfrage === true },
    });
    try {
      ws.send(JSON.stringify({ typ: "ergebnis", id: n.id, text: erg.text, ...(erg.isError ? { isError: true } : {}) }));
    } catch (err) {
      this.log(`Antwort nicht gesendet: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Werkzeugliste für den Gateway: Kernmenge plus die zwei Meta-Werkzeuge. */
  manifest(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const liste: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
      {
        name: "werkzeug_suchen",
        description:
          `Werkzeuge der laufenden AVA des Nutzers finden: Stichwortsuche über alle ${this.werkzeuge().length} Werkzeuge (Workflows, Mail, CRM, Notion, Obsidian, Gedächtnis, Buying Center, Radar, Einstellungen …). Liefert Name, Kurzbeschreibung und Parameter-Schema; danach mit werkzeug_ausfuehren aufrufen. q: '*' liefert den Überblick mit Anzahl je Bereich.`,
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string", description: "Suchwörter, z. B. 'workflow starten', 'hubspot kontakt anlegen'" },
            limit: { type: "integer", description: "Treffer (Standard 8, max 20)" },
          },
          required: ["q"],
        },
      },
      {
        name: "werkzeug_ausfuehren",
        description:
          "Ein beliebiges Werkzeug der laufenden AVA des Nutzers ausführen (Name und Schema aus werkzeug_suchen). Antwortet ein Werkzeug mit `rueckfrage`, die Frage dem Nutzer stellen und denselben Aufruf mit `_antworten: {\"<token>\": \"<wert>\"}` wiederholen. Schreibende und destruktive Aktionen laufen nur mit dieser Bestätigung.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            args: { type: "object", description: "Argumente laut Schema des Werkzeugs" },
            _antworten: { type: "object", description: "Antworten auf Rückfragen: Token → Wert" },
          },
          required: ["name"],
        },
      },
    ];
    if (this.avaFragen) liste.unshift({ name: "ava_fragen", description: AvaFragen.BESCHREIBUNG, inputSchema: AvaFragen.SCHEMA });
    for (const name of KERNMENGE) {
      const t = this.deps.registry.get(name);
      if (!t) continue;
      liste.push({ name: t.name, description: this.mitRueckfrageHinweis(t.description), inputSchema: this.schemaMitAntworten(t.parameters) });
    }
    return liste;
  }

  private mitRueckfrageHinweis(description: string): string {
    return description.length > 3600 ? description.slice(0, 3600) + "…" : description;
  }

  private schemaMitAntworten(schema: Record<string, unknown>): Record<string, unknown> {
    const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, unknown>;
    return { ...schema, type: "object", properties: { ...props, _antworten: { type: "object", description: "Antworten auf Rückfragen (Token → Wert), siehe rueckfrage im Ergebnis" } } };
  }

  private werkzeuge(): Tool[] {
    return this.deps.registry.list().filter((t) => !NUR_CHAT.has(t.name));
  }

  /** Überblick: Anzahl je Bereich, damit der Agent weiß, was es gibt. */
  private katalog(): string {
    const je = new Map<string, number>();
    for (const t of this.werkzeuge()) {
      const k = t.category ?? t.name.split("_")[0] ?? "sonstige";
      je.set(k, (je.get(k) ?? 0) + 1);
    }
    return kompakt({
      gesamt: this.werkzeuge().length,
      bereiche: [...je.entries()].sort((a, b) => b[1] - a[1]).map(([bereich, anzahl]) => ({ bereich, anzahl })),
      hinweis: "Mit werkzeug_suchen { q: '<Stichwort oder Bereich>' } die Werkzeuge eines Bereichs mit Schema holen.",
    });
  }

  private suchen(q: string, limit: number): string {
    if (q === "*" || q.toLowerCase() === "katalog") return this.katalog();
    const woerter = q.toLowerCase().split(/\s+/).filter(Boolean);
    const alle = this.werkzeuge();
    const treffer = alle
      .map((t) => {
        const name = t.name.toLowerCase();
        const zsf = zusammenfassung(t).toLowerCase();
        const desc = t.description.toLowerCase();
        const kat = (t.category ?? "").toLowerCase();
        let score = 0;
        for (const w of woerter) {
          if (name.includes(w)) score += 10;
          if (kat && kat.includes(w)) score += 8;
          if (zsf.includes(w)) score += 5;
          if (desc.includes(w)) score += 1;
        }
        return { t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
      .slice(0, Math.max(1, Math.min(20, limit)));
    return kompakt({
      gesamt: alle.length,
      treffer: treffer.map(({ t }) => ({
        name: t.name,
        kategorie: t.category ?? null,
        kurz: zusammenfassung(t),
        ...(GATEWAY_STATT[t.name] ? { lieber: `${GATEWAY_STATT[t.name]} (Gateway, antwortet auch ohne laufende AVA)` } : {}),
        schema: t.parameters,
      })),
      hinweis: treffer.length === 0 ? "Nichts gefunden; andere Stichwörter versuchen (deutsch oder englisch) oder q: '*' für den Überblick." : "Mit werkzeug_ausfuehren { name, args } aufrufen.",
    });
  }

  async ausfuehren(name: string, roh: Record<string, unknown>): Promise<{ text: string; isError?: boolean; rueckfrage?: boolean }> {
    if (name === "ava_fragen") {
      if (!this.avaFragen) return { text: "ava_fragen ist in dieser AVA nicht verfügbar.", isError: true };
      return this.avaFragen.ausfuehren(roh);
    }
    if (name === "werkzeug_suchen") {
      const q = String(roh.q ?? "").trim();
      if (!q) return { text: "q fehlt.", isError: true };
      return { text: this.suchen(q, Number(roh.limit) || 8) };
    }
    let zielName = name;
    let args: Record<string, unknown> = roh;
    if (name === "werkzeug_ausfuehren") {
      zielName = String(roh.name ?? "").trim();
      args = roh.args && typeof roh.args === "object" ? { ...(roh.args as Record<string, unknown>) } : {};
      if (roh._antworten) args._antworten = roh._antworten;
    }
    const tool = this.deps.registry.get(zielName);
    if (!tool) return { text: `Unbekanntes Werkzeug: ${zielName}. Mit werkzeug_suchen nach dem richtigen Namen suchen.`, isError: true };
    if (NUR_CHAT.has(zielName)) {
      return { text: `${zielName} ist nur im AVA-Chat sinnvoll; Rückfragen an den Nutzer stellst du selbst.`, isError: true };
    }
    const antwortenRoh = args._antworten;
    const antworten: Record<string, string> = {};
    if (antwortenRoh && typeof antwortenRoh === "object") {
      for (const [k, v] of Object.entries(antwortenRoh as Record<string, unknown>)) if (typeof v === "string") antworten[k] = v;
    }
    const { _antworten: _weg, ...reineArgs } = args;
    void _weg;

    const ctrl = new AbortController();
    this.offen.add(ctrl);
    const zeit = setTimeout(() => ctrl.abort(), AUFRUF_TIMEOUT_MS);
    const ui = new UiBridge(
      {
        emit: () => {},
        pending: new Map(),
        audit: (e) => this.deps.audit?.({ action: e.action, summary: e.summary, metadata: { ...e.metadata, kanal: "mcp" } }),
      },
      `mcp-${Date.now()}`,
      "mcp-relais",
      true,
      new RelaisRueckfragen(zielName, antworten),
      "none",
    );
    const ctx: ToolContext = {
      signal: ctrl.signal,
      log: (msg) => this.log(`[${zielName}] ${msg}`),
      ui,
      autonomousMode: true,
    };
    try {
      const parsed = tool.parseArgs(reineArgs);
      const ergebnis = await tool.run(parsed, ctx);
      let vorschau = "";
      try {
        vorschau = tool.preview(ergebnis);
      } catch {
        vorschau = "";
      }
      return { text: kuerzen(kompakt({ werkzeug: zielName, vorschau: vorschau.slice(0, 600), ergebnis })) };
    } catch (err) {
      if (err instanceof RueckfrageNoetig) {
        return {
          text: kompakt({
            werkzeug: zielName,
            rueckfrage: err.rueckfrage,
            hinweis:
              "Das Werkzeug braucht eine Antwort des Nutzers. Frage stellen, dann denselben Aufruf wiederholen mit _antworten: { \"" +
              err.rueckfrage.token +
              "\": \"<Wert bzw. value der Option>\" }.",
          }),
          rueckfrage: true,
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { text: kompakt({ werkzeug: zielName, fehler: ctrl.signal.aborted ? `Zeitüberschreitung nach ${AUFRUF_TIMEOUT_MS / 1000} s` : msg }), isError: true };
    } finally {
      clearTimeout(zeit);
      this.offen.delete(ctrl);
    }
  }
}
