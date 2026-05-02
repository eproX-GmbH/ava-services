import { create } from "zustand";
import type { PostgresStatus } from "../../../shared/types";

// Postgres supervisor mirror (Phase 8.v1.0).
//
// Same pattern as the Ollama mirror: main owns the truth (the postgres
// child process, port binding, initdb state). The renderer keeps a
// synchronous-readable copy here, populated by the initial `getStatus`
// call on App mount and refreshed by the `postgres-status:changed` push.
//
// `ready` flips on first arrival so the Settings status row can render
// a deterministic state instead of flicker between "unknown" and the
// real value during boot.

const INITIAL_STATUS: PostgresStatus = {
  state: "idle",
  host: null,
  port: null,
  dataDir: null,
  version: null,
  errorMessage: null,
};

interface PostgresState {
  ready: boolean;
  status: PostgresStatus;
  setStatus: (status: PostgresStatus) => void;
}

export const usePostgresStore = create<PostgresState>((setState) => ({
  ready: false,
  status: INITIAL_STATUS,
  setStatus: (status) => setState({ status, ready: true }),
}));
