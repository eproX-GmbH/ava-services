// IPC-Handler „Sprachmodus“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import type { SpracheEinstellungen } from "../../shared/types";
import { liveSitzungStarten } from "../sprache/live";
import { praegeSitzung } from "../sprache/session";
import type { GatewayClient, LlmProviderManager, UserProfileStore } from "../agent";
import type { Auth } from "../auth";
import type { SpracheRelay } from "../sprache/relay";
import type { SpracheStore } from "../sprache/store";

/** Stand des Sprachmodus, wie ihn index.ts berechnet und an den Renderer sendet. */
export interface SpracheStand {
  einstellungen: SpracheEinstellungen;
  verfuegbar: boolean;
  quelle: "eigen" | "organisation" | null;
  whisperBereit: boolean;
}

export interface SpracheIpcDeps {
  auth: Auth;
  gatewayClient: GatewayClient;
  providers: LlmProviderManager;
  spracheRelay: SpracheRelay;
  spracheStand: () => SpracheStand;
  spracheStore: SpracheStore;
  userProfile: UserProfileStore;
}

export function registerSpracheIpc(deps: SpracheIpcDeps): void {
  const { auth, gatewayClient, providers, spracheRelay, spracheStand, spracheStore, userProfile } = deps;

  ipcMain.handle("sprache:stand", () => spracheStand());

  ipcMain.handle("sprache:setzen", (_e, teil: Partial<import("../../shared/types").SpracheEinstellungen>) => {
    spracheStore.setzen(teil);
    return spracheStand();
  });

  ipcMain.handle("sprache:sitzung", async () => {
    const st = spracheStand();
    if (!st.einstellungen.aktiv) throw new Error("Der Sprachmodus ist ausgeschaltet.");
    if (!st.verfuegbar) throw new Error("Kein OpenAI-Schlüssel hinterlegt.");
    const prof = userProfile.get() as { name?: string | null; firstName?: string | null };
    const name = prof.firstName ?? prof.name ?? null;
    return praegeSitzung({ providers, stimme: st.einstellungen.stimme, nutzerName: name, actorId: auth.getStatus().actorId ?? null });
  });

  // GPT Live (2026-09-25): Sitzung serverseitig mit dem SDP-Angebot des Renderers anlegen.
  ipcMain.handle("sprache:liveSitzung", async (_e, a: { sdpOffer: string }) => {
    const st = spracheStand();
    if (!st.einstellungen.aktiv) throw new Error("Der Sprachmodus ist ausgeschaltet.");
    if (!st.verfuegbar) throw new Error("Kein OpenAI-Schlüssel hinterlegt.");
    const prof = userProfile.get() as { name?: string | null; firstName?: string | null };
    return liveSitzungStarten({ providers, sdpOffer: a.sdpOffer, stimme: st.einstellungen.stimme, nutzerName: prof.firstName ?? prof.name ?? null, actorId: auth.getStatus().actorId ?? null });
  });

  ipcMain.handle("sprache:auftrag", (_e, input: { conversationId: string; text: string; images?: import("../../shared/types").AgentMessageImage[] }) => spracheRelay.auftrag(input));

  ipcMain.handle("sprache:rueckfrage", (_e, a: { choiceId: string; wert: string }) => spracheRelay.rueckfrage(a.choiceId, a.wert));

  ipcMain.handle("sprache:abbrechen", () => { spracheRelay.abbrechen(); return true; });

  // S5 — Verbrauch je Realtime-Antwort ans Gateway, NUR beim Organisations-
  // schluessel (mit eigenem Schluessel zahlt der Nutzer direkt bei OpenAI).
  ipcMain.handle("sprache:verbrauch", async (_e, v: { model: string; latencyMs?: number; usage: Record<string, number>; sekunden?: number }) => {
    if (providers.keySource("openai") !== "organisation") return { gemeldet: false };
    try {
      await gatewayClient.request("/v1/llm-usage", { method: "POST", body: { provider: "openai", model: v.model, channel: "chat", latencyMs: v.latencyMs ?? 0, usage: v.usage, ...(typeof v.sekunden === "number" ? { sekunden: v.sekunden } : {}) } });
      return { gemeldet: true };
    } catch (err) {
      console.warn("[sprache] Verbrauchsmeldung fehlgeschlagen:", err instanceof Error ? err.message : String(err));
      return { gemeldet: false };
    }
  });
}
