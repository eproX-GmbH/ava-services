// Loopback-Token-Dienst fuer das ChatGPT-Abo in Producern
// (docs/PLAN_CHATGPT_ABO_UEBERALL.md, E1).
//
// Producer sind Kindprozesse. Statt den Access-Token (1 h gueltig) in ihre
// Umgebung zu legen und sie bei jedem Refresh neu zu starten, holen sie ihn
// je Anfrage hier ab: GET /plan-token mit dem Geheimnis aus der Umgebung.
// Nur 127.0.0.1, zufaelliger Port, Geheimnis je App-Start. Antwort 404,
// wenn gerade kein nutzbares Abo besteht (Producer melden dann einen
// klaren Fehler statt eines Absturzes). BYOK-Regel bleibt gewahrt: der
// Endpunkt lebt im Main, nicht im Renderer.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

export interface PlanTokenAntwort {
  accessToken: string;
  model?: string;
}

export class PlanTokenServer {
  private server: Server | null = null;
  private port = 0;
  private readonly secret = randomBytes(24).toString("hex");

  constructor(private readonly quelle: () => Promise<PlanTokenAntwort | null>) {}

  async start(): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void (async () => {
          try {
            if (req.method !== "GET" || !(req.url ?? "").startsWith("/plan-token")) {
              res.writeHead(404).end();
              return;
            }
            if (req.headers["x-ava-plan-secret"] !== this.secret) {
              res.writeHead(403).end();
              return;
            }
            const t = await this.quelle();
            if (!t) {
              res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "kein_abo" }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(t));
          } catch (err) {
            res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        })();
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        this.server = server;
        resolve();
      });
    });
  }

  /** Umgebung fuer Kindprozesse; null, solange der Dienst nicht laeuft. */
  endpunkt(): { url: string; secret: string } | null {
    if (!this.server || !this.port) return null;
    return { url: `http://127.0.0.1:${this.port}/plan-token`, secret: this.secret };
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.port = 0;
  }
}
