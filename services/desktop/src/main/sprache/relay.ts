// Sprachmodus — Relay zum Chat-Orchestrator (docs/PLAN_SPRACHMODUS.md, S2).
//
// `auftrag` gibt einen Zug in die bestehende Unterhaltung und sammelt die
// Stream-Frames dieses Zugs ein. Sofort zurueck: "laeuft". Spaeter, per
// Ereignis `sprache:ergebnis`: Text ohne Zaeune und Links, Bloecke
// (Chart, Buying Center), Rueckfragen des Orchestrators. So hat die
// Sprach-KI dieselben Werkzeuge, Skills und Sicherheitsregeln wie der Chat,
// ohne dass etwas davon ein zweites Mal gebaut wird.

import type { AgentOrchestrator } from "../agent/orchestrator";
import type { AgentStreamFrame, SpracheBlock, SpracheErgebnis, SpracheRueckfrage, SpracheSchritt, SpracheFortschritt } from "../../shared/types";

const CHART_RE = /```chart\s*\n([\s\S]*?)\n```/g;
const BC_RE = /```buying-center\s*\n([\s\S]*?)\n```/g;

/** Markdown-Links, Bilder und company:-Verweise zu blossem Text; Zaeune raus. */
export function textFuerSprache(md: string): string {
  return md
    .replace(CHART_RE, "")
    .replace(BC_RE, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*\|.*\|\s*$/gm, (z) => z.replace(/\|/g, " ").replace(/-{3,}/g, "").trim())
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let blockZaehler = 0;
export function bloeckeAus(md: string): SpracheBlock[] {
  const aus: SpracheBlock[] = [];
  const hinzu = (art: SpracheBlock["art"], raw: string) => {
    let titel = art === "chart" ? "Diagramm" : "Buying Center";
    let bezug: string | null = null;
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const t = j["title"] ?? j["titel"] ?? j["name"] ?? j["companyName"];
      if (typeof t === "string" && t.trim()) titel = `${titel}: ${t.trim().slice(0, 60)}`;
      const c = j["companyId"] ?? j["company"];
      if (typeof c === "string") bezug = c;
    } catch {
      const m = /"companyId"\s*:\s*"([^"]+)"/.exec(raw);
      if (m) bezug = m[1] ?? null;
    }
    blockZaehler += 1;
    aus.push({ id: `b${blockZaehler}`, art, raw, titel, bezug });
  };
  for (const m of md.matchAll(CHART_RE)) hinzu("chart", m[1] ?? "");
  for (const m of md.matchAll(BC_RE)) hinzu("buying-center", m[1] ?? "");
  return aus;
}

interface Lauf {
  requestId: string;
  conversationId: string;
  text: string;
  toolPreviews: string[];
  schritte: SpracheSchritt[];
  usage: import("../../shared/types").AgentTurnUsage | null;
}

export class SpracheRelay {
  private laufend: Lauf | null = null;

  constructor(
    private readonly orchestrator: AgentOrchestrator,
    private readonly senden: (e: SpracheErgebnis) => void,
    /** Laufender Fortschritt (Werkzeuge, Tokens) fuer die Anzeige unter der Kugel. */
    private readonly fortschritt: (f: SpracheFortschritt) => void = () => undefined,
    /** Lesbarer Name eines Werkzeugs (Tool.summary), sonst der technische Name. */
    private readonly werkzeugName: (name: string) => string = (n) => n,
  ) {
    orchestrator.on("stream", (f: AgentStreamFrame) => this.frame(f));
  }

  /** Auftrag in die Unterhaltung geben. Sofort zurueck; Ergebnis per Ereignis. */
  auftrag(input: { conversationId: string; text: string; images?: import("../../shared/types").AgentMessageImage[] }): { laeuft: boolean; requestId: string | null; grund?: string } {
    if (this.laufend) return { laeuft: false, requestId: null, grund: "Ein Auftrag läuft noch. Warte auf sein Ergebnis." };
    try {
      const r = this.orchestrator.send({ conversationId: input.conversationId, message: input.text, images: input.images, quelle: "sprache" });
      this.laufend = { requestId: r.requestId, conversationId: input.conversationId, text: "", toolPreviews: [], schritte: [], usage: null };
      return { laeuft: true, requestId: r.requestId };
    } catch (err) {
      return { laeuft: false, requestId: null, grund: err instanceof Error ? err.message : String(err) };
    }
  }

  rueckfrage(choiceId: string, wert: string): { ok: boolean; grund?: string } {
    try {
      this.orchestrator.answerChoice(choiceId, wert);
      return { ok: true };
    } catch (err) {
      return { ok: false, grund: err instanceof Error ? err.message : String(err) };
    }
  }

  abbrechen(): void {
    if (this.laufend) this.orchestrator.abort(this.laufend.requestId);
    this.laufend = null;
  }

  private melden(l: Lauf, fertig = false): void {
    this.fortschritt({ requestId: l.requestId, conversationId: l.conversationId, schritte: l.schritte.map((s) => ({ ...s })), usage: l.usage, fertig });
  }

  private frame(f: AgentStreamFrame): void {
    const l = this.laufend;
    if (!l || f.requestId !== l.requestId) return;
    switch (f.kind) {
      case "token":
        l.text += f.delta;
        return;
      case "tool-call":
        l.schritte.push({ id: f.toolCall.id, name: f.toolCall.name, label: this.werkzeugName(f.toolCall.name), status: "laeuft", preview: null });
        this.melden(l);
        return;
      case "tool-result": {
        l.toolPreviews.push(f.preview);
        const s = l.schritte.find((x) => x.id === f.toolCallId);
        if (s) { s.status = f.ok ? "ok" : "fehler"; s.preview = f.preview.slice(0, 160); }
        this.melden(l);
        return;
      }
      case "usage":
        l.usage = f.usage;
        this.melden(l);
        return;
      case "choice-request":
      case "text-request":
      case "match-request": {
        const g = f as { choiceId: string; prompt: string; options?: SpracheRueckfrage["options"] };
        const rueckfrage: SpracheRueckfrage = {
          choiceId: g.choiceId, prompt: g.prompt,
          art: f.kind === "choice-request" ? "choice" : f.kind === "text-request" ? "text" : "match",
          options: g.options,
        };
        this.senden({ requestId: l.requestId, conversationId: l.conversationId, text: textFuerSprache(l.text), bloecke: [], rueckfrage, fehler: null, fertig: false });
        return;
      }
      case "error":
        this.senden({ requestId: l.requestId, conversationId: l.conversationId, text: textFuerSprache(l.text), bloecke: [], rueckfrage: null, fehler: f.message, fertig: true });
        this.laufend = null;
        return;
      case "done": {
        if (f.usage) l.usage = f.usage;
        this.melden(l, true);
        const bloecke = bloeckeAus(l.text);
        let text = textFuerSprache(l.text);
        if (!text && l.toolPreviews.length) text = l.toolPreviews.join("\n");
        this.senden({ requestId: l.requestId, conversationId: l.conversationId, text, bloecke, rueckfrage: null, fehler: null, fertig: true });
        this.laufend = null;
        return;
      }
      default:
        return;
    }
  }
}
