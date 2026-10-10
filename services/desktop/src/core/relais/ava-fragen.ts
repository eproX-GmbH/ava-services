// ava_fragen (docs/PLAN_AVA_CLOUD.md §11.3 Nr. 3): AVAs eigener Agent als ein
// MCP-Werkzeug. Claude oder ChatGPT gibt einen Auftrag in natürlicher Sprache;
// AVA bearbeitet ihn mit Soul, Gedächtnis, Nutzerprofil und allen Werkzeugen in
// einer eigenen Konversation (derselbe Weg wie Telegram: startAutonomousConversation)
// und liefert die fertige Antwort zurück.
//
// Regeln:
//   - Vollmacht fest „none“ (Konversation mit source "mcp"): jede Freigabe und
//     jede Rückfrage geht an den Menschen hinter dem aufrufenden Agenten.
//   - Rückfragen werden gesammelt und mit Token zurückgegeben. Der Agent fragt
//     den Nutzer und ruft ava_fragen mit derselben `gespraech`-ID und
//     `antworten: { token: wert }` erneut auf; die Konversation läuft weiter
//     und findet die Antworten vor.
//   - Lange Züge: Nach WARTE_MS kommt `status: "laeuft"` zurück; ein Aufruf mit
//     derselben `gespraech`-ID (ohne neue Nachricht) holt das Ergebnis ab.
//   - Ist AVA gerade mit etwas anderem beschäftigt (Chat in der App, Telegram,
//     Mail-Triage), kommt eine klare Meldung; nichts wird still eingereiht.

import { createHash, randomUUID } from "node:crypto";
import type { AgentChoiceOption, AgentStreamFrame } from "../../shared/types";
import type { RemoteAskHandler } from "../../main/agent/ui-bridge";

/** Was ava_fragen vom Orchestrator braucht (schmal, damit Tests ihn nachbilden können). */
export interface AvaAgent {
  getStatus(): { ready: boolean; inFlightRequestId: string | null };
  startAutonomousConversation(input: {
    initialMessage: string;
    conversationId?: string;
    remoteAsk?: RemoteAskHandler;
    source?: "telegram" | "mail" | "aufgabe" | "mcp";
  }): { conversationId: string; requestId: string } | null;
  on(event: "stream", listener: (frame: AgentStreamFrame) => void): unknown;
  off(event: "stream", listener: (frame: AgentStreamFrame) => void): unknown;
}

export interface Rueckfrage {
  token: string;
  frage: string;
  optionen?: Array<{ value: string; label: string }>;
  freitext?: boolean;
}

interface Lauf {
  gespraech: string;
  requestId: string;
  laeuft: boolean;
  text: string;
  werkzeuge: string[];
  rueckfragen: Rueckfrage[];
  fehler: string | null;
  fertig: Promise<void>;
  zuletzt: number;
}

const WARTE_MS = 95_000;
const LAUF_FRIST_MS = 15 * 60_000;
const AUFBEWAHREN_MS = 30 * 60_000;
const MAX_ANTWORT_ZEICHEN = 30_000;

function token(frage: string): string {
  return createHash("sha256").update(frage).digest("hex").slice(0, 10);
}

/**
 * Rückfragen-Kanal für einen ava_fragen-Zug: Beantwortet aus mitgegebenen
 * Antworten, sammelt sonst die Frage und bricht den Werkzeugaufruf ab. Der
 * Agent bekommt die Fehlermeldung als Werkzeugergebnis und beendet den Zug mit
 * einem Hinweis; die Frage geht über das Ergebnis an den aufrufenden Agenten.
 */
class SammelnderRueckfrager implements RemoteAskHandler {
  constructor(
    private readonly antworten: Record<string, string>,
    private readonly gesammelt: Rueckfrage[],
  ) {}

  private offen(r: Rueckfrage): never {
    if (!this.gesammelt.some((x) => x.token === r.token)) this.gesammelt.push(r);
    throw new Error(
      `Rückfrage an den Nutzer offen (Token ${r.token}): ${r.frage} — Die Frage wird dem Nutzer gestellt. Beende deinen Zug jetzt mit einer kurzen Zusammenfassung, was du schon erledigt hast und was nach der Antwort folgt; nichts als erledigt melden, was nicht gelaufen ist.`,
    );
  }

  async askChoice(prompt: string, options: AgentChoiceOption[]): Promise<string> {
    const t = token(prompt);
    const vorab = this.antworten[t];
    if (vorab !== undefined) {
      const treffer = options.find((o) => o.value === vorab || o.label === vorab);
      if (treffer) return treffer.value;
    }
    return this.offen({ token: t, frage: prompt, optionen: options.map((o) => ({ value: o.value, label: o.label })) });
  }

  async askText(prompt: string): Promise<string> {
    const t = token(prompt);
    const vorab = this.antworten[t];
    if (vorab !== undefined) return vorab;
    return this.offen({ token: t, frage: prompt, freitext: true });
  }
}

export class AvaFragen {
  private readonly laeufe = new Map<string, Lauf>();

  constructor(private readonly agent: AvaAgent) {}

  static readonly BESCHREIBUNG =
    "AVAs eigenen Agenten einen Auftrag in natürlicher Sprache bearbeiten lassen: mit Gedächtnis, Nutzerprofil, Skills und allen rund 280 Werkzeugen der laufenden AVA, über mehrere Schritte. Sinnvoll für zusammengesetzte Aufgaben („Vertriebsblick auf Firma X mit Buying Center und letzten Meldungen“), wenn AVAs Kontext zählt. Für einzelne Abfragen sind die direkten Werkzeuge schneller und billiger (AVA nutzt dafür ihr eigenes Modell). Antwort enthält `gespraech` für Folgefragen. Kommen `rueckfragen` zurück, die Frage(n) dem Nutzer stellen und ava_fragen mit derselben `gespraech` und `antworten: {\"<token>\": \"<wert bzw. value>\"}` erneut aufrufen. Steht `status: \"laeuft\"`, später mit derselben `gespraech` (ohne nachricht) das Ergebnis abholen. Schreibende Aktionen laufen nur mit Bestätigung des Nutzers.";

  static readonly SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
      nachricht: { type: "string", description: "Der Auftrag oder die Folgefrage an AVA" },
      gespraech: { type: "string", description: "ID aus einer früheren Antwort, um das Gespräch fortzusetzen oder ein laufendes Ergebnis abzuholen" },
      antworten: { type: "object", description: "Antworten des Nutzers auf rueckfragen: Token → Wert (bei Optionen der value)" },
    },
  };

  private aufraeumen(): void {
    const grenze = Date.now() - AUFBEWAHREN_MS;
    for (const [k, l] of this.laeufe) if (!l.laeuft && l.zuletzt < grenze) this.laeufe.delete(k);
  }

  private ergebnis(l: Lauf): Record<string, unknown> {
    if (l.laeuft) {
      return {
        gespraech: l.gespraech,
        status: "laeuft",
        bisher: l.werkzeuge.length ? { werkzeuge: l.werkzeuge.slice(-12) } : undefined,
        hinweis: "AVA arbeitet noch. Später ava_fragen mit derselben gespraech (ohne nachricht) aufrufen, um das Ergebnis abzuholen.",
      };
    }
    const text = l.text.length > MAX_ANTWORT_ZEICHEN ? l.text.slice(0, MAX_ANTWORT_ZEICHEN) + "\n… [gekürzt]" : l.text;
    return {
      gespraech: l.gespraech,
      status: l.fehler ? "fehler" : l.rueckfragen.length ? "rueckfrage" : "fertig",
      antwort: text || null,
      ...(l.fehler ? { fehler: l.fehler } : {}),
      ...(l.werkzeuge.length ? { werkzeuge: [...new Set(l.werkzeuge)] } : {}),
      ...(l.rueckfragen.length
        ? {
            rueckfragen: l.rueckfragen,
            hinweis: "Fragen dem Nutzer stellen, dann ava_fragen mit derselben gespraech und antworten: { token: wert } aufrufen.",
          }
        : {}),
    };
  }

  private warten(l: Lauf, ms: number): Promise<void> {
    return Promise.race([l.fertig, new Promise<void>((r) => setTimeout(r, ms))]);
  }

  async ausfuehren(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    this.aufraeumen();
    const gespraechArg = typeof args.gespraech === "string" && args.gespraech.trim() ? args.gespraech.trim() : null;
    let nachricht = typeof args.nachricht === "string" ? args.nachricht.trim() : "";
    const antworten: Record<string, string> = {};
    if (args.antworten && typeof args.antworten === "object") {
      for (const [k, v] of Object.entries(args.antworten as Record<string, unknown>)) if (typeof v === "string") antworten[k] = v;
    }

    // Laufendes Ergebnis abholen.
    const vorher = gespraechArg ? this.laeufe.get(gespraechArg) : undefined;
    if (vorher?.laeuft) {
      await this.warten(vorher, WARTE_MS);
      return { text: JSON.stringify(this.ergebnis(vorher)) };
    }
    if (gespraechArg && !nachricht && Object.keys(antworten).length === 0) {
      if (vorher) return { text: JSON.stringify(this.ergebnis(vorher)) };
      return { text: "Zu dieser gespraech gibt es kein Ergebnis (mehr). Mit nachricht neu fragen.", isError: true };
    }

    // Antworten auf Rückfragen auch dem Modell in Klartext mitgeben.
    if (Object.keys(antworten).length > 0) {
      const fragen = vorher?.rueckfragen ?? [];
      const zeilen = Object.entries(antworten).map(([t, w]) => {
        const f = fragen.find((x) => x.token === t);
        const label = f?.optionen?.find((o) => o.value === w)?.label ?? w;
        return `- ${f ? f.frage : `Rückfrage ${t}`}: ${label}`;
      });
      nachricht = `Antworten des Nutzers auf deine Rückfragen:\n${zeilen.join("\n")}${nachricht ? `\n\n${nachricht}` : "\n\nBitte jetzt fortfahren."}`;
    }
    if (!nachricht) return { text: "nachricht fehlt.", isError: true };

    const st = this.agent.getStatus();
    if (!st.ready) return { text: "AVAs Modell ist gerade nicht bereit (kein Anbieter oder Schlüssel eingerichtet).", isError: true };
    if (st.inFlightRequestId) {
      return { text: "AVA bearbeitet gerade etwas anderes (Chat in der App, Telegram oder eine Hintergrundaufgabe). In einer Minute erneut versuchen.", isError: true };
    }

    const gespraech = gespraechArg ?? `mcp-${randomUUID()}`;
    const rueckfragen: Rueckfrage[] = [];
    const started = this.agent.startAutonomousConversation({
      conversationId: gespraech,
      initialMessage: nachricht,
      remoteAsk: new SammelnderRueckfrager(antworten, rueckfragen),
      source: "mcp",
    });
    if (!started) return { text: "AVA hat den Auftrag nicht angenommen (Modell nicht bereit oder beschäftigt). Gleich erneut versuchen.", isError: true };

    let erledigt: () => void = () => {};
    const lauf: Lauf = {
      gespraech: started.conversationId,
      requestId: started.requestId,
      laeuft: true,
      text: "",
      werkzeuge: [],
      rueckfragen,
      fehler: null,
      fertig: new Promise<void>((r) => (erledigt = r)),
      zuletzt: Date.now(),
    };
    this.laeufe.set(lauf.gespraech, lauf);

    let frist: NodeJS.Timeout;
    const ende = (fehler: string | null): void => {
      if (!lauf.laeuft) return;
      lauf.laeuft = false;
      lauf.fehler = fehler;
      lauf.zuletzt = Date.now();
      clearTimeout(frist);
      this.agent.off("stream", onFrame);
      erledigt();
    };
    const onFrame = (frame: AgentStreamFrame): void => {
      if (frame.requestId !== lauf.requestId) return;
      lauf.zuletzt = Date.now();
      if (frame.kind === "token" && frame.delta) lauf.text += frame.delta;
      else if (frame.kind === "tool-call") lauf.werkzeuge.push(frame.toolCall.name);
      else if (frame.kind === "done") ende(null);
      else if (frame.kind === "error") ende(frame.message);
    };
    this.agent.on("stream", onFrame);
    frist = setTimeout(() => ende("Zeitüberschreitung: AVA hat den Zug nicht innerhalb von 15 Minuten beendet."), LAUF_FRIST_MS);
    frist.unref?.();

    await this.warten(lauf, WARTE_MS);
    return { text: JSON.stringify(this.ergebnis(lauf)), ...(lauf.fehler ? { isError: true } : {}) };
  }
}
