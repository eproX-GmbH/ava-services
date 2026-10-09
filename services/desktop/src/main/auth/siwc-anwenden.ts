// Ergebnis einer ChatGPT-Anmeldung in den Provider-Store übernehmen. Gemeinsamer
// Pfad für das Fenster (ipc/agent.ts) und den Server (/setup), damit beide
// dieselbe Hülle schreiben: Flow „plan“, Client-ID der Installation, Scopes,
// gewähltes Modell bleibt erhalten, wenn dasselbe Konto neu verbindet.

import type { LlmProviderManager } from "../agent/providers";
import type { ProviderConfigStore, OpenAISubscriptionRecord } from "../agent/providers/store";
import type { SiwcTokenResult } from "./siwc-oauth";

export interface SiwcErgebnis extends SiwcTokenResult {
  clientId: string;
  planScope: boolean;
}

/** Vorherige Plan-Hülle, falls vorhanden (für Client-ID, Login-Hint und Modell). */
export async function vorherigePlanHuelle(store: ProviderConfigStore): Promise<OpenAISubscriptionRecord | null> {
  const alt = await store.getOpenAISubscriptionRecord().catch(() => null);
  return alt && alt.flow === "plan" ? alt : null;
}

export async function siwcErgebnisUebernehmen(
  providers: LlmProviderManager,
  ergebnis: SiwcErgebnis,
  vorherige: OpenAISubscriptionRecord | null,
): Promise<{ ok: true; email: string | null; planScope: boolean }> {
  providers.setOpenAISubscriptionRecord({
    accessToken: ergebnis.accessToken,
    refreshToken: ergebnis.refreshToken,
    expiresIn: ergebnis.expiresIn,
    flow: "plan",
    clientId: ergebnis.clientId,
    subject: ergebnis.subject,
    email: ergebnis.email,
    idToken: ergebnis.idToken,
    scopes: (ergebnis.scope ?? "").split(/[\s+]+/).filter(Boolean),
    planModel: vorherige && vorherige.subject === ergebnis.subject ? vorherige.planModel : undefined,
  });
  try {
    providers.setProvider("openai");
  } catch {
    /* Token gespeichert, Modus auf Abo — reicht für die Anzeige */
  }
  // Modellliste gleich laden, damit die Auswahl sofort da ist (best-effort).
  await providers.ladeChatgptPlanModelle().catch(() => undefined);
  return { ok: true, email: ergebnis.email ?? null, planScope: ergebnis.planScope };
}
