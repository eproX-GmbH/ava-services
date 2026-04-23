import { DirectDbClient } from "./drivers/direct";
import { GatewayDbClient } from "./drivers/gateway";
import type { DbClient, DbDriver } from "./types";

export interface MakeDbClientOptions {
  driver?: DbDriver;
  databaseUrl?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
}

export function makeDbClient(opts: MakeDbClientOptions = {}): DbClient {
  const driver: DbDriver =
    opts.driver ?? ((process.env.DB_CLIENT as DbDriver) || "direct");

  switch (driver) {
    case "gateway": {
      const baseUrl = opts.gatewayUrl ?? process.env.DB_GATEWAY_URL;
      if (!baseUrl) throw new Error("DB_GATEWAY_URL required for driver=gateway");
      return new GatewayDbClient({
        baseUrl,
        accessToken: opts.gatewayToken ?? process.env.DB_GATEWAY_TOKEN,
      });
    }
    case "direct": {
      const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("DATABASE_URL required for driver=direct");
      return new DirectDbClient({ databaseUrl });
    }
    default:
      throw new Error(`Unknown DB_CLIENT: ${driver}`);
  }
}
