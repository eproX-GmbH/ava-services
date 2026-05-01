import { BrowserWindow, Notification } from "electron";
import type { AlertPrefsStore } from "./agent/alert-prefs-store";
import type {
  Alert,
  AlertSeverity,
  NotificationPermissionStatus,
} from "../shared/types";

// Native OS notifications (Phase 8.f3).
//
// Wraps Electron's `Notification` API and centralises every "should we
// actually show this?" gate so the rest of main never has to know about
// platform quirks:
//
//   1. Push must be supported by the OS (`Notification.isSupported()`).
//      Linux without libnotify, headless CI, etc. report false; we
//      surface that as a permission-status hint and disable the toggle
//      in Settings.
//   2. User must have toggled push on in Settings (defaults to off so a
//      first-run user isn't surprised by toasts).
//   3. Alert severity must meet the configured threshold.
//   4. Quiet hours must NOT be active. The window can wrap around
//      midnight (start=19:00, end=07:00) — we treat the gate as
//      "current time NOT in [end, start)".
//   5. (macOS only) The OS-level permission must be granted.
//      `new Notification(...)` throws on macOS when permission is
//      denied; we wrap with try/catch and degrade to "not shown".
//
// Severity → presentation:
//   info   → silent (no sound)
//   warn   → default sound, body + company name
//   urgent → uses macOS "critical" presentation where supported.
//
// Click handler: focuses the window and routes the renderer to
// /alerts. We post a `notifications:focusAlerts` IPC event the
// renderer can listen on (handled in App.tsx) — going through IPC
// keeps the main process decoupled from React Router.

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warn: 1,
  urgent: 2,
};

export class NotificationManager {
  private readonly prefs: AlertPrefsStore;

  constructor(prefs: AlertPrefsStore) {
    this.prefs = prefs;
  }

  /**
   * Ask the OS / user permission gate whether push CAN be shown right
   * now (independent of user prefs / quiet hours). The renderer reads
   * this to render the Settings hint when push is technically blocked.
   */
  permissionStatus(): NotificationPermissionStatus {
    if (!Notification.isSupported()) {
      return {
        available: false,
        reason:
          "Dieses System unterstützt keine nativen Benachrichtigungen.",
      };
    }
    return { available: true, reason: null };
  }

  /**
   * Decide + show. Returns true iff a toast was actually displayed,
   * false otherwise (with the reason logged in dev console).
   */
  notifyForAlert(alert: Alert): boolean {
    const reason = this.shouldSuppress(alert);
    if (reason) {
      // Silent: this is normal operation (push off, severity below
      // threshold, etc.) — no warn-level log.
      console.log(`[notifications] skipped (${reason}) for ${alert.id}`);
      return false;
    }
    try {
      const n = new Notification({
        title: titleFor(alert),
        body: bodyFor(alert),
        silent: alert.severity === "info",
        // macOS only: 'critical' enables the "Important" presentation
        // and bypasses Focus modes. Honour it for urgent alerts so the
        // analyst can rely on never missing one.
        urgency: alert.severity === "urgent" ? "critical" : "normal",
      });
      n.on("click", () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isMinimized()) win.restore();
          win.focus();
          win.webContents.send("notifications:focusAlerts");
        }
      });
      n.show();
      return true;
    } catch (err) {
      console.warn("[notifications] show failed:", err);
      return false;
    }
  }

  // ---- Internal -----------------------------------------------------------

  private shouldSuppress(alert: Alert): string | null {
    if (!Notification.isSupported()) return "OS unsupported";
    const prefs = this.prefs.get();
    if (!prefs.pushEnabled) return "push disabled";
    if (
      SEVERITY_RANK[alert.severity] <
      SEVERITY_RANK[prefs.pushSeverityThreshold]
    ) {
      return `below threshold (${alert.severity} < ${prefs.pushSeverityThreshold})`;
    }
    if (this.inQuietHours()) return "quiet hours";
    return null;
  }

  private inQuietHours(): boolean {
    const { quietHours } = this.prefs.get();
    if (!quietHours.enabled) return false;
    const now = new Date();
    if (quietHours.silenceWeekends) {
      const dow = now.getDay(); // 0 = Sun, 6 = Sat
      if (dow === 0 || dow === 6) return true;
    }
    const minute = now.getHours() * 60 + now.getMinutes();
    const { startMinute, endMinute } = quietHours;
    if (startMinute === endMinute) return false; // degenerate window
    if (startMinute < endMinute) {
      // Same-day window, e.g. 13:00–14:00.
      return minute >= startMinute && minute < endMinute;
    }
    // Wrap-around window, e.g. 19:00–07:00.
    return minute >= startMinute || minute < endMinute;
  }
}

// ---- Body / title helpers --------------------------------------------------

function titleFor(alert: Alert): string {
  // Severity prefix lets the user triage at a glance even when the OS
  // truncates the body (Windows toasts, macOS Notification Center).
  const prefix =
    alert.severity === "urgent"
      ? "⚠ "
      : alert.severity === "warn"
        ? "❗ "
        : "";
  return `${prefix}AVA · ${alert.companyName}`;
}

function bodyFor(alert: Alert): string {
  // We deliberately don't ship the rationale — it's often longer than
  // toast bodies render. Headline is already capped at 120 chars
  // upstream so it fits cleanly on every platform.
  return alert.headline;
}
