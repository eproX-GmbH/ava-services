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

  /**
   * @param quelle   ChatGPT-Abo-Token (GET /plan-token), 404 ohne Abo.
   * @param gateway  Keycloak-Access-Token des Nutzers (GET /gateway-token),
   *                 garantiert gueltig fuer die naechsten Minuten. Producer
   *                 holen es alle paar Minuten, statt das beim Start
   *                 eingefrorene 15-Minuten-Token zu benutzen (Patrick
   *                 2026-11-03: Lauf laenger als das Token → 401 → Neustart-
   *                 Schleife).
   */
  constructor(
    private readonly quelle: () => Promise<PlanTokenAntwort | null>,
    private readonly gateway?: () => Promise<string | null>,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void (async () => {
          try {
            const pfad = req.url ?? "";
            if (req.method !== "GET" || !(pfad.startsWith("/plan-token") || pfad.startsWith("/gateway-token"))) {
              res.writeHead(404).end();
              return;
            }
            if (req.headers["x-ava-plan-secret"] !== this.secret) {
              res.writeHead(403).end();
              return;
            }
            if (pfad.startsWith("/gateway-token")) {
              const accessToken = this.gateway ? await this.gateway() : null;
              if (!accessToken) {
                res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "nicht_angemeldet" }));
                return;
              }
              res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ accessToken }));
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

  /** Endpunkt fuer das Gateway-Token; null ohne Dienst oder ohne Quelle. */
  gatewayEndpunkt(): { url: string; secret: string } | null {
    if (!this.server || !this.port || !this.gateway) return null;
    return { url: `http://127.0.0.1:${this.port}/gateway-token`, secret: this.secret };
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.port = 0;
  }
}
