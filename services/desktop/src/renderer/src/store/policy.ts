import { create } from "zustand";
import type { OrgPolicy, OrgFeatureKey } from "../../../shared/types";

// O3 — Spiegel der Organisationsvorgaben (Hauptprozess ist die Wahrheit,
// Push per `org:policyChanged`). Fehlender Schluessel = erlaubt.

interface PolicyState {
  policy: OrgPolicy;
  ready: boolean;
  set: (p: OrgPolicy) => void;
}

const ALLES_ERLAUBT: OrgPolicy = { features: {}, providerLock: false, chatModel: null, producerModel: null, promptAudit: false };

export const usePolicyStore = create<PolicyState>((setState) => ({
  policy: ALLES_ERLAUBT,
  ready: false,
  set: (p) => setState({ policy: p, ready: true }),
}));

export function useFeature(key: OrgFeatureKey): boolean {
  return usePolicyStore((s) => s.policy.features[key] !== false);
}
