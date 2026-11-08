// Onboarding (docs/PLAN_ONBOARDING.md): lokale Marken in userData/onboarding.json.
// Jede Marke wird genau einmal gesetzt und nie zurueckgenommen.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../../core/platform";

export interface OnboardingMarke {
  /** O2: Start-ICP geprueft (uebernommen, verworfen oder nicht noetig). */
  startIcpGeprueft?: string;
  /** O2: Begruessung hat nach der Website gefragt. */
  websiteGefragt?: string;
  begruessungId?: string;
  /** O3: neues Konto erkannt, Start-Workflow soll angelegt werden. */
  startWorkflowFaellig?: string;
  /** O3: Start-Workflow angelegt (kommt nach dem Loeschen nie wieder). */
  startWorkflowAngelegt?: string;
  /** O3: Ereignis radar.erstlauf ausgeloest. */
  erstlaufGemeldet?: string;
  /** O3/O5: Mail "Deine Top 10" wartet, bis der Import verarbeitet ist (dann genau einmal). */
  top10Mail?: { transactionId: string; firmen: Array<{ name: string; ort: string | null; branche: string | null; score: number; grund: string }>; seit: string; erledigt?: string; ergebnis?: string };
}

export function onboardingDatei(): string {
  return join(paths().get("userData"), "onboarding.json");
}

export function markeLesen(datei: string): OnboardingMarke {
  try {
    return existsSync(datei) ? (JSON.parse(readFileSync(datei, "utf8")) as OnboardingMarke) : {};
  } catch {
    return {};
  }
}

export function markeSetzen(datei: string, patch: Partial<OnboardingMarke>): void {
  try {
    mkdirSync(dirname(datei), { recursive: true });
    writeFileSync(datei, JSON.stringify({ ...markeLesen(datei), ...patch }, null, 2), "utf8");
  } catch (err) {
    console.warn("[onboarding] Marke nicht gespeichert:", err instanceof Error ? err.message : err);
  }
}
