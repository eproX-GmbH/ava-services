// DbClient skeleton.
//
// Per DECISIONS.md D3 the gateway's operation surface is scoped in Step 5
// from the Desktop-App's actual data flow — NOT by mirroring the full
// Postgres schema. Until Step 5, this package only exposes connectivity
// primitives that let the supervisor decide whether to boot (D11: online-only,
// no degraded mode).
//
// Each service continues to import its generated PrismaClient directly.
// Shared read/write operations move into this package incrementally as the
// Desktop-App's scope is defined.

export interface DbClient {
  readonly isConnected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  // Lightweight liveness probe. The supervisor calls this at startup
  // (D11: fail fast, no offline fallback).
  healthCheck(): Promise<void>;
}

export type DbDriver = "direct" | "gateway";

export interface DirectDbConfig {
  databaseUrl: string;
}

export interface GatewayDbConfig {
  baseUrl: string;
  accessToken?: string;
}
