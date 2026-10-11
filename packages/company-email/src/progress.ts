// transaction.progress fuer die Status-Matrix (DESKTOP_DATA_FLOW.md §6): eine
// eigene Zeile "company-email" je Firma. company-email persistiert ueber REST,
// nicht ueber den Persist-Bus — den Endzustand meldet der Producer daher selbst.

import { randomUUID } from "node:crypto";
import { PROGRESS } from "./routing";

export const SERVICE_NAME = "company-email";

export type ProgressState = "in_progress" | "completed" | "skipped" | "failed";

export interface ProgressEingabe {
  transactionId: string;
  companyId: string;
  state: ProgressState;
  errorMessage?: string;
}

export function buildProgressEvent(input: ProgressEingabe, tenantId: string): Record<string, unknown> {
  const jetzt = new Date().toISOString();
  return {
    id: randomUUID(),
    specversion: "1.0",
    datacontenttype: "application/json",
    time: jetzt,
    type: PROGRESS,
    source: SERVICE_NAME,
    subject: input.companyId,
    transaction: input.transactionId,
    services: [SERVICE_NAME],
    data: {
      transactionId: input.transactionId,
      tenantId,
      service: SERVICE_NAME,
      companyId: input.companyId,
      state: input.state,
      errorMessage: input.errorMessage,
      updatedAt: jetzt,
    },
  };
}
