import pino from "pino";
import { loadEnv } from "./env";

export const logger = pino({
  level: loadEnv().LOG_LEVEL,
  // fly.io already adds timestamps in logfmt, so we stay JSON + bare.
  base: { service: "db-gateway" },
});
