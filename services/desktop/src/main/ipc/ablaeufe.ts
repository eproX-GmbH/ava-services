// IPC-Handler „Workflows“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { WorkflowService } from "../workflows";

export interface AblaeufeIpcDeps {
  wf: () => WorkflowService;
}

export function registerAblaeufeIpc(deps: AblaeufeIpcDeps): void {
  const { wf } = deps;

  ipcMain.handle("workflows:list", () => wf().list());

  ipcMain.handle("workflows:get", (_e, id: string) => wf().get(String(id)));

  ipcMain.handle("workflows:catalog", () => wf().catalog());

  ipcMain.handle("workflows:approvals", (_e, status?: string) => wf().approvals((status as "open" | "all" | undefined) ?? "open"));

  ipcMain.handle("workflows:executions", (_e, id: string, limit?: number) => wf().executions(String(id), limit ?? 50));

  ipcMain.handle("workflows:execution", (_e, id: string, executionId: string) => wf().execution(String(id), String(executionId)));

  ipcMain.handle("workflows:executionsAll", (_e, opts?: { status?: string; workflowId?: string; sinceDays?: number; limit?: number }) => wf().executionsAll(opts ?? {}));

  ipcMain.handle("workflows:rerun", (_e, id: string, executionId: string) => wf().rerun(String(id), String(executionId)));

  ipcMain.handle("workflows:save", (_e, input: Parameters<WorkflowService["save"]>[0]) => {
    try {
      return wf().save(input, { createdBy: "user" });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:patch", (_e, id: string, patch: Record<string, unknown>) => {
    try {
      return { workflow: wf().patch(String(id), patch) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:delete", (_e, id: string) => ({ ok: wf().delete(String(id)) }));

  ipcMain.handle("workflows:resolveCompany", async (_e, query: string) => {
    try {
      return { kandidaten: await wf().resolveCompany(String(query)) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // W7 — Teilen mit der Organisation.
  ipcMain.handle("workflows:share", async (_e, id: string) => {
    try {
      return { workflow: await wf().shareToOrg(String(id)) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:orgList", async () => {
    try {
      const items = await wf().listOrgWorkflows();
      return { items: items.map((i) => ({ ...i, vonMir: wf().isSharedByMe(i) })) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:adopt", async (_e, orgId: string) => {
    try {
      return await wf().adoptFromOrg(String(orgId));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:orgRevoke", async (_e, orgId: string) => {
    try {
      await wf().revokeOrgWorkflow(String(orgId));
      return { ok: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:runBatch", async (_e, id: string, firmen: Array<{ companyId?: string; discoveryId?: string; companyName?: string }>, opts?: { dryRun?: boolean }) => {
    try {
      const p = wf().runBatch(String(id), Array.isArray(firmen) ? firmen : [], { trigger: opts?.dryRun ? "test" : "manual", dryRun: opts?.dryRun === true });
      void p.catch(() => {});
      return { gestartet: Array.isArray(firmen) ? firmen.length : 0 };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:templates", () => wf().templates());

  ipcMain.handle("workflows:createFromTemplate", (_e, templateId: string) => {
    try {
      return wf().createFromTemplate(String(templateId));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:estimate", (_e, id: string) => {
    const def = wf().get(String(id));
    return def ? wf().estimate(def) : null;
  });

  ipcMain.handle("workflows:run", async (_e, id: string, opts?: { dryRun?: boolean; companyId?: string; companyName?: string; discoveryId?: string; companyQuery?: string; untilNode?: string }) => {
    try {
      const p = wf().run(String(id), {
        trigger: opts?.dryRun ? "test" : "manual",
        dryRun: opts?.dryRun === true,
        ...(opts?.untilNode ? { untilNode: opts.untilNode } : {}),
        ...(opts?.companyId ? { company: { companyId: opts.companyId, companyName: opts.companyName } } : opts?.discoveryId ? { company: { discoveryId: opts.discoveryId } } : {}),
        ...(opts?.companyQuery ? { companyQuery: opts.companyQuery } : {}),
      });
      void p.catch(() => {});
      return { gestartet: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("workflows:cancel", (_e, executionId: string) => ({ ok: wf().cancel(String(executionId)) }));

  ipcMain.handle("workflows:approve", (_e, approvalId: string, approved: boolean, note?: string) => ({ ok: wf().decideApproval(String(approvalId), approved === true, note) }));
}
