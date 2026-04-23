import type { DbClient, DirectDbConfig } from "../types";

// Direct Postgres driver. Uses a `pg`-compatible connection string and runs
// a trivial `SELECT 1` as liveness probe. Per-service Prisma clients stay in
// their own packages — this driver intentionally does NOT wrap Prisma so the
// @ava/db-client package doesn't take a dependency on every service's
// generated client.
//
// The liveness query is run via pg's Pool so we don't force a Prisma dep here.

type PgPool = {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
};

export class DirectDbClient implements DbClient {
  private pool?: PgPool;
  private _connected = false;

  constructor(private readonly config: DirectDbConfig) {}

  get isConnected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    // Lazy-require so consumers that never hit `direct` don't need pg installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg") as { Pool: new (cfg: { connectionString: string }) => PgPool };
    this.pool = new Pool({ connectionString: this.config.databaseUrl });
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    await this.pool?.end();
    this.pool = undefined;
    this._connected = false;
  }

  async healthCheck(): Promise<void> {
    if (!this.pool) throw new Error("DirectDbClient not connected");
    await this.pool.query("SELECT 1");
  }
}
