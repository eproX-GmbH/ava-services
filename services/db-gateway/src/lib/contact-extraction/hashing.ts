import { createHash } from "crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function buildObservationHash(args: {
  entityType: "COMPANY" | "PERSON";
  entityId: string;
  field: string;
  normalized: string;
  source: string;
  evidenceUrl?: string | null;
  /** Firmenbezug (scope.ts); "" oder fehlend = wie bisher, damit alte Hashes gueltig bleiben. */
  scopeCompanyId?: string | null;
}): string {
  const s = [
    args.entityType,
    args.entityId,
    args.field,
    args.normalized,
    args.source,
    args.evidenceUrl ?? "",
    ...(args.scopeCompanyId ? [args.scopeCompanyId] : []),
  ].join("|");
  return sha256(s);
}

export function buildSignalDedupKey(args: {
  entityType: "COMPANY" | "PERSON";
  entityId: string;
  type: string;
  field?: string | null;
  afterNorm?: string | null;
  scopeCompanyId?: string | null;
}): string {
  const s = [
    args.entityType,
    args.entityId,
    args.type,
    args.field ?? "",
    args.afterNorm ?? "",
    ...(args.scopeCompanyId ? [args.scopeCompanyId] : []),
  ].join("|");
  return sha256(s);
}
