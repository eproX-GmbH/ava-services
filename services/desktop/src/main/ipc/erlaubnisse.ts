// IPC „Erlaubnisse“ (docs/PLAN_ERLAUBNISSE.md §2.4): Uebersicht und Widerruf der
// dauerhaften Erlaubnisse („Immer erlauben“) fuer Einstellungen → Konto.

import { ipcMain } from "electron";
import type { AuditEventInput } from "../audit/audit-types";
import { dauerErlaubnis } from "../agent/dauer-erlaubnis";

export function registerErlaubnisseIpc(deps: { audit: (input: AuditEventInput) => void }): void {
  const protokoll = (summary: string, metadata: Record<string, unknown>) =>
    deps.audit({ actorType: "user", actorId: null, category: "agent", action: "agent.erlaubnis.widerrufen", severity: "info", subjectType: null, subjectId: null, summary, metadata });

  ipcMain.handle("erlaubnisse:liste", () => dauerErlaubnis.liste());

  ipcMain.handle("erlaubnisse:widerrufen", (_e, werkzeug: string) => {
    const ok = dauerErlaubnis.widerrufen(String(werkzeug));
    if (ok) protokoll(`Dauerhafte Erlaubnis widerrufen (${werkzeug})`, { werkzeug });
    return { ok };
  });

  ipcMain.handle("erlaubnisse:alleWiderrufen", () => {
    const anzahl = dauerErlaubnis.alleWiderrufen();
    if (anzahl > 0) protokoll(`Alle dauerhaften Erlaubnisse widerrufen (${anzahl})`, { anzahl });
    return { anzahl };
  });
}
