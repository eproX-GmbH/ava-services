// O3 (docs/PLAN_ORGANISATIONEN.md) — Organisationsvorgaben im Hauptprozess.
//
// Quelle: /v1/whoami → policy (organisation.ts holt sie nach Anmeldung,
// alle 10 Minuten und auf Anforderung). Persistiert je Konto-Space in
// org-policy.json, damit die Gates schon beim Boot greifen (Mail, Telegram,
// Scheduler starten VOR dem ersten whoami). Persoenliche Tenants haben
// keine Vorgaben → alles erlaubt.

import { app, BrowserWindow } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OrgPolicy, OrgFeatureKey } from "../shared/types";

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  features: {},
  providerLock: false,
  chatModel: null,
  producerModel: null,
  promptAudit: false,
};

type Listener = (neu: OrgPolicy, alt: OrgPolicy) => void;

let aktuell: OrgPolicy = DEFAULT_ORG_POLICY;
let geladen = false;
const listeners = new Set<Listener>();

function pfad(): string {
  return join(app.getPath("userData"), "org-policy.json");
}

function lade(): void {
  if (geladen) return;
  geladen = true;
  try {
    const p = pfad();
    if (!existsSync(p)) return;
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<OrgPolicy>;
    aktuell = normalisiere(raw);
  } catch (err) {
    console.warn("[org-policy] org-policy.json nicht lesbar:", err);
  }
}

function normalisiere(raw: Partial<OrgPolicy> | null | undefined): OrgPolicy {
  const feats: Record<string, boolean> = {};
  if (raw?.features && typeof raw.features === "object") {
    for (const [k, v] of Object.entries(raw.features)) feats[k] = v !== false;
  }
  return {
    features: feats,
    providerLock: raw?.providerLock === true,
    chatModel: typeof raw?.chatModel === "string" ? raw.chatModel : null,
    producerModel: typeof raw?.producerModel === "string" ? raw.producerModel : null,
    promptAudit: raw?.promptAudit === true,
  };
}

export function getOrgPolicy(): OrgPolicy {
  lade();
  return aktuell;
}

export function featureEnabled(key: OrgFeatureKey): boolean {
  lade();
  return aktuell.features[key] !== false;
}

/** Vom whoami-Abgleich: speichern, bei Aenderung Gates + Renderer informieren. */
export function applyOrgPolicy(raw: Partial<OrgPolicy> | null | undefined): boolean {
  lade();
  const neu = normalisiere(raw);
  const alt = aktuell;
  if (JSON.stringify(neu) === JSON.stringify(alt)) return false;
  aktuell = neu;
  try {
    writeFileSync(pfad(), JSON.stringify(neu, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn("[org-policy] org-policy.json nicht schreibbar:", err);
  }
  const aus = Object.entries(neu.features).filter(([, v]) => v === false).map(([k]) => k);
  console.log(`[org-policy] Vorgaben aktualisiert — abgeschaltet: ${aus.length ? aus.join(", ") : "nichts"}; providerLock=${neu.providerLock}`);
  for (const l of listeners) {
    try {
      l(neu, alt);
    } catch (err) {
      console.warn("[org-policy] Listener-Fehler:", err);
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("org:policyChanged", neu);
    } catch {
      /* zerstoertes Fenster */
    }
  }
  return true;
}

export function onOrgPolicyChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Feature, das ein Chat-Tool voraussetzt (undefined = immer verfuegbar). */
export function featureOfTool(name: string): OrgFeatureKey | undefined {
  if (name.startsWith("mail_")) return "mail";
  if (name.startsWith("personen_radar_")) return "linkedin.radar";
  if (name.startsWith("linkedin_") || name === "company_linkedin_signals") return "linkedin.beobachter";
  if (name === "contact_linkedin_lookup" || name === "company_contacts") return "kontakte";
  return undefined;
}

/** true, wenn das Tool nach Vorgabe gesperrt ist. */
export function toolGesperrt(name: string): boolean {
  const f = featureOfTool(name);
  return f !== undefined && !featureEnabled(f);
}
