// Azure-Brücke: lokaler OpenAI-kompatibler Durchreicher (nur 127.0.0.1) für
// Azure OpenAI mit dem eigenen Schlüssel (shared/azure-openai.ts).
//
// Chat, Producer, Recherche und Telegram sprechen OpenAI über SDKs, die eine
// Basis-Adresse (OPENAI_BASE_URL) und einen Bearer-Schlüssel nehmen. Einige
// Producer nennen Modelle fest im Code (z. B. gpt-5-mini); bei Azure heißen
// sie wie die Deployments des Kunden. Die Brücke übersetzt deshalb an EINER
// Stelle:
//   - Bearer = Geheimnis der Brücke → Azure-Endpunkt /openai/v1, Modell →
//     Deployment, Azure-Schlüssel als api-key und Bearer.
//   - anderer Bearer (z. B. ein separater OpenAI-Schlüssel für die Recherche)
//     → unverändert an api.openai.com.
// Antworten (auch Streams) werden ungepuffert durchgereicht.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { azureBaseURL, azureDeployment, type AzureOpenAIConfig } from "../../../shared/azure-openai";

const OPENAI_BASE = "https://api.openai.com/v1";
const MAX_BODY = 50 * 1024 * 1024;
const WEITERGEREICHTE_ANFRAGE = ["content-type", "accept", "openai-beta", "openai-organization", "openai-project", "x-stainless-helper-method"];
const WEITERGEREICHTE_ANTWORT = ["content-type", "cache-control", "retry-after", "x-request-id", "apim-request-id", "openai-processing-ms"];

export interface AzureBrueckeDeps {
  /** Aktuelle Azure-Konfiguration samt Schlüssel; null = Azure nicht eingerichtet. */
  ziel: () => Promise<{ cfg: AzureOpenAIConfig; key: string } | null>;
  log?: (zeile: string) => void;
}

export class AzureBruecke {
  readonly geheimnis = randomBytes(24).toString("base64url");
  private server: Server | null = null;
  private port = 0;
  private start: Promise<void> | null = null;

  constructor(private readonly deps: AzureBrueckeDeps) {}

  /** Basis-Adresse und Schlüssel für SDKs; startet die Brücke bei Bedarf. */
  async zugang(): Promise<{ baseURL: string; apiKey: string }> {
    await this.sicherstellen();
    return { baseURL: `http://127.0.0.1:${this.port}/v1`, apiKey: this.geheimnis };
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.start = null;
  }

  private sicherstellen(): Promise<void> {
    if (this.start) return this.start;
    this.start = new Promise<void>((resolve, reject) => {
      const s = createServer((req, res) => {
        void this.behandeln(req, res).catch((err) => {
          this.deps.log?.(`[azure-bruecke] Fehler: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) this.fehler(res, 502, "Azure OpenAI nicht erreichbar.");
          else res.destroy();
        });
      });
      s.on("error", (err) => {
        this.start = null;
        reject(err);
      });
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        this.port = typeof a === "object" && a ? a.port : 0;
        this.server = s;
        s.unref();
        resolve();
      });
    });
    return this.start;
  }

  private fehler(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message, type: "ava_azure_bridge" } }));
  }

  private istGeheimnis(bearer: string): boolean {
    const a = Buffer.from(bearer);
    const b = Buffer.from(this.geheimnis);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async lesen(req: IncomingMessage): Promise<Buffer | undefined> {
    if (req.method === "GET" || req.method === "HEAD") return undefined;
    const teile: Buffer[] = [];
    let n = 0;
    for await (const t of req) {
      n += (t as Buffer).length;
      if (n > MAX_BODY) throw new Error("Anfrage zu groß");
      teile.push(t as Buffer);
    }
    return Buffer.concat(teile);
  }

  private async behandeln(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (!url.startsWith("/v1/") && url !== "/v1") return this.fehler(res, 404, "Unbekannter Pfad.");
    const rest = url.slice(3); // ab "/…" inkl. Query
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
    if (!bearer) return this.fehler(res, 401, "Schlüssel fehlt.");

    const headers: Record<string, string> = {};
    for (const h of WEITERGEREICHTE_ANFRAGE) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    let body = await this.lesen(req);
    let ziel: string;
    if (this.istGeheimnis(bearer)) {
      const az = await this.deps.ziel();
      if (!az) return this.fehler(res, 503, "Azure OpenAI ist nicht eingerichtet (Endpunkt oder Schlüssel fehlt).");
      ziel = `${azureBaseURL(az.cfg.endpoint)}${rest}`;
      headers["api-key"] = az.key;
      headers.authorization = `Bearer ${az.key}`;
      if (body && (headers["content-type"] ?? "").includes("application/json")) {
        try {
          const json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
          if (typeof json.model === "string") {
            json.model = azureDeployment(az.cfg, json.model);
            body = Buffer.from(JSON.stringify(json), "utf8");
          }
        } catch {
          /* kein JSON: unverändert */
        }
      }
    } else {
      ziel = `${OPENAI_BASE}${rest}`;
      headers.authorization = `Bearer ${bearer}`;
    }

    const antwort = await fetch(ziel, {
      method: req.method ?? "GET",
      headers,
      body: body && body.length ? new Uint8Array(body) : undefined,
    });
    const aus: Record<string, string> = {};
    for (const h of WEITERGEREICHTE_ANTWORT) {
      const v = antwort.headers.get(h);
      if (v) aus[h] = v;
    }
    res.writeHead(antwort.status, aus);
    if (!antwort.body) {
      res.end();
      return;
    }
    Readable.fromWeb(antwort.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(res);
  }
}
