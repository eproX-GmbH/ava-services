// v0.1.200 — Audit-Trail types. The canonical declarations live in
// `shared/types.ts` so the renderer can import them without dragging
// in main-only code. This module just re-exports them under stable
// names so the rest of main/audit/ stays unchanged.
//
// One source of truth: anything that touches audit (store, IPC,
// renderer) should reference the shared types via this module or
// directly via `shared/types`.

export type {
  AuditActorType,
  AuditCategory,
  AuditEvent,
  AuditEventInput,
  AuditListQuery,
  AuditListResponse,
  AuditSeverity,
  AuditSubjectType,
} from "../../shared/types";
