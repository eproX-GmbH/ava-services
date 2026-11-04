// Bestandssuche S3 (docs/PLAN_BESTANDSSUCHE.md): Vektoren fuer die Belegtabelle
// SuchBlock entstehen LOKAL (embeddinggemma via Ollama) — der Desktop holt in
// ruhigen Takten Bloecke der eigenen Firmen ohne Vektor, bettet sie ein und
// schreibt sie ins Gateway zurueck. "Einer rechnet, alle profitieren": der
// Vektor gehoert zum geteilten Beleg, nicht zum Nutzer. Compute bleibt beim
// Nutzer (keine Anbieter-Schluessel, keine Server-Rechenzeit).
//
// Takt 10 Minuten, je Takt bis 40 Bloecke (auf schwachen CPUs ~0,5 s je Block).
// Laeuft nur, wenn Ollama bereit ist und das Einbettungsmodell installiert ist;
// im Worker-Modus angehalten wie die anderen Zeitgeber.

import type { GatewayClient } from "./agent/gateway-client";
import type { OllamaStatus } from "../shared/types";

const TAKT_MS = 10 * 60_000;
const ERSTER_TAKT_MS = 3 * 60_000;
const JE_TAKT = 40;
const MODELL = "embeddinggemma:latest";

export interface SuchblockEmbedderDeps {
  gateway: GatewayClient;
  ollamaStatus: () => OllamaStatus;
  signedIn: () => boolean;
}

export class SuchblockEmbedder {
  private timer: NodeJS.Timeout | null = null;
  private laeuft = false;
  private gesamt = 0;

  constructor(private readonly deps: SuchblockEmbedderDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), TAKT_MS);
    }, ERSTER_TAKT_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private bereit(): boolean {
    if (!this.deps.signedIn()) return false;
    const st = this.deps.ollamaStatus();
    return st.state === "ready" && st.installed.some((m) => m.name === MODELL || m.name === MODELL.replace(":latest", ""));
  }

  async tick(): Promise<void> {
    if (this.laeuft || !this.bereit()) return;
    this.laeuft = true;
    try {
      const offen = await this.deps.gateway.request<{ bloecke: Array<{ id: string; titel: string; text: string }> }>("/v1/suchblock/offen", { query: { limit: JE_TAKT } });
      const bloecke = offen.bloecke ?? [];
      if (bloecke.length === 0) return;
      const host = this.deps.ollamaStatus().host ?? "http://127.0.0.1:11434";
      const res = await fetch(`${host}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODELL, input: bloecke.map((b) => `${b.titel}\n${b.text}`.slice(0, 4000)) }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
      const json = (await res.json()) as { embeddings?: number[][] };
      const vektoren = json.embeddings ?? [];
      const eintraege = bloecke.map((b, i) => ({ id: b.id, embedding: vektoren[i] ?? [] })).filter((e) => e.embedding.length > 0);
      const r = await this.deps.gateway.request<{ geschrieben: number }>("/v1/suchblock/embeddings", { method: "PUT", body: { modell: MODELL, eintraege } });
      this.gesamt += r.geschrieben ?? 0;
      console.info(`[suchblock-embedder] ${r.geschrieben ?? 0} Bloecke eingebettet (gesamt ${this.gesamt})`);
    } catch (err) {
      console.warn("[suchblock-embedder] Takt fehlgeschlagen:", err instanceof Error ? err.message : String(err));
    } finally {
      this.laeuft = false;
    }
  }
}
