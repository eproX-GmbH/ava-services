// Protokoll im Format der uebrigen Producer ("<zeit> | <level> | <text>"); der
// Supervisor liest stdout mit (Producer-Logs, 401-Erkennung, Audit-Marker).

export const EVENT_LOG = "company-email compute";

function zeile(level: string, text: string): string {
  return `${new Date().toISOString()} | ${level} | [${EVENT_LOG}] ${text}`;
}

export const logger = {
  info: (text: string): void => console.log(zeile("info", text)),
  error: (text: string): void => console.error(zeile("error", text)),
};

/** Audit-Eintrag ueber den stdout-Marker, den der ProducerSupervisor einsammelt. */
export function audit(eintrag: { action: string; summary: string; subjectId?: string | null; severity?: "info" | "warning"; metadata?: Record<string, unknown> }): void {
  const payload = {
    category: "producer",
    action: eintrag.action,
    severity: eintrag.severity ?? "info",
    subjectType: eintrag.subjectId ? "company" : null,
    subjectId: eintrag.subjectId ?? null,
    summary: eintrag.summary,
    metadata: eintrag.metadata ?? {},
  };
  console.log(`__AVA_AUDIT__${JSON.stringify(payload)}__/AVA_AUDIT__`);
}
