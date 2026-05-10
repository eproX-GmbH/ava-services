// LinkedIn-Beobachter IPC surface (Phase L0).
//
// Wires the renderer's settings panel + consent modal + kill-switch
// to the on-disk store. Validates the consent gate so a malicious /
// confused renderer can't flip `enabled: true` without the user
// having accepted the modal first.

import { ipcMain } from "electron";
import type { LinkedInSettings } from "../../shared/types";
import { read, write, reset } from "./store";

export function initLinkedIn(): void {
  ipcMain.handle("linkedin:settings:get", (): LinkedInSettings => read());

  ipcMain.handle(
    "linkedin:settings:update",
    (_e, partial: Partial<LinkedInSettings>): LinkedInSettings | { error: string } => {
      const current = read();
      const next: LinkedInSettings = { ...current, ...partial };

      // Consent gate: cannot enable without an accepted consent.
      if (next.enabled && !next.consentAcceptedAt) {
        return { error: "Consent not accepted. Run linkedin:consent:accept first." };
      }

      // Cloud image analysis requires a separate explicit opt-in.
      if (next.imageAnalysis === "cloud" && !next.imageAnalysisCloudOptIn) {
        return { error: "Cloud image analysis requires explicit opt-in." };
      }

      // Clamp scanIntervalHours to [1, 24].
      if (typeof partial.scanIntervalHours === "number") {
        const clamped = Math.max(1, Math.min(24, Math.round(partial.scanIntervalHours)));
        next.scanIntervalHours = clamped;
      }

      return write(next);
    },
  );

  ipcMain.handle("linkedin:consent:accept", (): LinkedInSettings => {
    return write({ consentAcceptedAt: Date.now() });
  });

  ipcMain.handle("linkedin:consent:revoke", (): LinkedInSettings => {
    return write({ consentAcceptedAt: null, enabled: false });
  });

  ipcMain.handle("linkedin:killswitch", (): { ok: true } => {
    reset();
    return { ok: true };
  });
}
