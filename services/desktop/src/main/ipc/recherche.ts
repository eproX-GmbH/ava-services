// IPC-Handler „Recherche-Einstellungen“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import type { LlmProviderManager } from "../agent";
import type { ProducerSupervisor } from "../producer-supervisor";
import type { ResearchFeaturesStore } from "../research/store";

export interface RechercheIpcDeps {
  producers: ProducerSupervisor[];
  providers: LlmProviderManager;
  researchBundle: () => unknown;
  researchStore: ResearchFeaturesStore;
}

export function registerRechercheIpc(deps: RechercheIpcDeps): void {
  const { producers, providers, researchBundle, researchStore } = deps;

  ipcMain.handle("research:getBundle", () => researchBundle());

  // 2026-09-24 — manueller Lauf je Firma: Gibt es einen OpenAI-Schluessel
  // (eigener oder Organisation)? Ohne ihn zeigt die Firmenansicht statt der
  // Knoepfe den Hinweis auf die Einstellungen.
  ipcMain.handle("research:manuellerStand", () => researchStore.manuellerStand({ providerLocked: providers.isProviderLocked() }));

  ipcMain.handle(
    "research:setFeatureConfig",
    (_e, args: {
      feature: "expansionTenders" | "jobPostings";
      partial: {
        tier?: "off" | "standard" | "deep";
        provider?: "openai" | "anthropic" | null;
        keyId?: string | null;
      };
    }) => {
      researchStore.setFeatureConfig(args.feature, args.partial);
      return researchBundle();
    },
  );

  ipcMain.handle(
    "research:createKey",
    (_e, args: { provider: "openai" | "anthropic"; label: string; plaintext: string }) => {
      const id = researchStore.createKey(args);
      return { id, bundle: researchBundle() };
    },
  );

  ipcMain.handle("research:deleteKey", (_e, args: { keyId: string }) => {
    const { detachedFeatures } = researchStore.deleteKey(args.keyId);
    return { detachedFeatures, bundle: researchBundle() };
  });

  // Probe handler (Phase G) — does a 1-token round-trip against the
  // provider so we can give green/red feedback in the Settings UI.
  // Plaintext key never leaves this process.
  ipcMain.handle(
    "research:probeKey",
    async (_e, args: { keyId: string }): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      const plaintext = await researchStore.__getPlaintextKeyForProbe(args.keyId);
      if (!plaintext) {
        return { ok: false, error: "Key not found or undecryptable" };
      }
      // Provider deduction: global:* aliases are obvious; for uuid we
      // need to read the meta.
      const allKeys = researchStore.listKeys();
      let provider: "openai" | "anthropic" | null = null;
      if (args.keyId === "global:openai") provider = "openai";
      else if (args.keyId === "global:anthropic") provider = "anthropic";
      else provider = allKeys.find((k) => k.id === args.keyId)?.provider ?? null;

      if (!provider) {
        return { ok: false, error: "Unknown provider for keyId" };
      }

      const t0 = Date.now();
      try {
        if (provider === "openai") {
          // /v1/models is the cheapest authenticated endpoint -- list of
          // available models, ~$0 cost. Verifies the key works.
          const resp = await fetch("https://api.openai.com/v1/models", {
            headers: { authorization: `Bearer ${plaintext}` },
          });
          if (!resp.ok) {
            const txt = (await resp.text()).slice(0, 200);
            researchStore.markProbeResult(args.keyId, false);
            return { ok: false, error: `OpenAI ${resp.status}: ${txt}` };
          }
        } else {
          // Anthropic has no "list models" endpoint without consuming
          // credits. A 1-token ping with max_tokens=1 is the minimum
          // viable probe (costs ~$0.0001).
          const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": plaintext,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5",
              max_tokens: 1,
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          if (!resp.ok) {
            const txt = (await resp.text()).slice(0, 200);
            researchStore.markProbeResult(args.keyId, false);
            return { ok: false, error: `Anthropic ${resp.status}: ${txt}` };
          }
        }
        const latencyMs = Date.now() - t0;
        researchStore.markProbeResult(args.keyId, true);
        return { ok: true, latencyMs };
      } catch (err) {
        researchStore.markProbeResult(args.keyId, false);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // v0.1.179 — Pre-import skip-mode IPCs. The renderer (or chat-tool)
  // calls these around an import POST so the user can opt out of
  // expensive research features for that batch without permanently
  // toggling them off.
  //
  // Flow:
  //   1. research:beginSkipMode      → snapshot + flip to off
  //   2. research:waitWebsiteReady   → block until producer reboots
  //   3. (caller does the import POST, captures transactionId)
  //   4. research:attachSkipToTransaction(snap, tx)
  //   5. (TransactionStream observes completion)
  //   6. research:endSkipModeForTransaction(tx) → restore snapshot
  //
  // If anything between 2 and 6 fails, the user's saved config stays
  // at off -- fail-safe to not-spending. They can re-enable in
  // Settings.
  ipcMain.handle("research:beginSkipMode", () => {
    return { snapshotKey: researchStore.beginSkipMode() };
  });

  ipcMain.handle(
    "research:waitWebsiteReady",
    async (_e, args?: { timeoutMs?: number }) => {
      const timeoutMs = args?.timeoutMs ?? 30_000;
      const website = producers.find((p) => p.getStatus().name === "website");
      if (!website) {
        return { ready: false, reason: "website producer not registered" };
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const s = website.getStatus().state;
        if (s === "ready") return { ready: true };
        if (s === "error") {
          return {
            ready: false,
            reason: website.getStatus().errorMessage ?? "producer in error state",
          };
        }
        // Poll every 250ms — tight enough for the typical 5-15s
        // restart cycle, loose enough to not burn CPU.
        await new Promise((r) => setTimeout(r, 250));
      }
      return { ready: false, reason: `timeout after ${timeoutMs}ms` };
    },
  );

  ipcMain.handle(
    "research:attachSkipToTransaction",
    (_e, args: { snapshotKey: string; transactionId: string }) => {
      return {
        ok: researchStore.attachSkipSnapshotToTransaction(
          args.snapshotKey,
          args.transactionId,
        ),
      };
    },
  );

  ipcMain.handle(
    "research:endSkipModeForTransaction",
    (_e, args: { transactionId: string }) => {
      return { ok: researchStore.endSkipModeForTransaction(args.transactionId) };
    },
  );

  ipcMain.handle("research:hasPendingSkipMode", () => {
    return { pending: researchStore.hasPendingSkipMode() };
  });
}
