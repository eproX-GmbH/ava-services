import type { DbClient, GatewayDbConfig } from "../types";

// Gateway driver. Talks to the Hono-based DB gateway (DECISIONS.md D3) over
// REST. At this stage only `/v1/health` is defined — the per-operation API
// surface is designed in Step 5 from the Desktop-App's data flow.

export class GatewayDbClient implements DbClient {
  private _connected = false;

  constructor(private readonly config: GatewayDbConfig) {}

  get isConnected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    // Stateless HTTP — mark as connected after a successful health check.
    await this.healthCheck();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async healthCheck(): Promise<void> {
    const res = await fetch(new URL("/v1/health", this.config.baseUrl), {
      headers: this.config.accessToken
        ? { Authorization: `Bearer ${this.config.accessToken}` }
        : undefined,
    });
    if (!res.ok) {
      throw new Error(`DB gateway health check failed: ${res.status} ${res.statusText}`);
    }
  }
}
