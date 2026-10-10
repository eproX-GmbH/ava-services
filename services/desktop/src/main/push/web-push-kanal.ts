// Web-Push an die AVA-App (docs/PLAN_APP_PWA.md §3.4, P7): ein weiterer
// Zustellkanal neben Desktop-Mitteilung und Telegram. Abweichung vom Plan:
// keine Tabelle im Gateway, die AVA hält ihre Push-Abos und den VAPID-
// Schlüssel selbst und sendet direkt an die Push-Dienste (Apple, Google,
// Mozilla). So bleibt alles beim Nutzer und es braucht keine Datenbank-
// änderung. Jede AVA-Instanz hat ihren eigenen Schlüssel; die App abonniert
// bei der Instanz, mit der sie gerade spricht.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { credentials, paths } from "../../core/platform";
import type { Alert, AlertPrefs, AlertSeverity } from "../../shared/types";
import type { ExtraNotificationChannel } from "../notifications";

export interface PushAbo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  geraet: string;
  seit: string;
}

interface Datei {
  vapidPublic: string;
  /** Privater Schlüssel, verschlüsselt mit der Ablage dieser Instanz (base64). */
  vapidPrivateEnc: string;
  abos: PushAbo[];
}

const RANG: Record<AlertSeverity, number> = { info: 0, warn: 1, urgent: 2 };
const MAX_ABOS = 20;

export class WebPushKanal implements ExtraNotificationChannel {
  private daten: Datei | null = null;
  private readonly datei: string;

  constructor(
    private readonly deps: { prefs: () => AlertPrefs; log?: (z: string) => void },
  ) {
    const dir = join(paths().get("userData"), "push");
    mkdirSync(dir, { recursive: true });
    this.datei = join(dir, "abos.json");
  }

  private laden(): Datei {
    if (this.daten) return this.daten;
    if (existsSync(this.datei)) {
      try {
        this.daten = JSON.parse(readFileSync(this.datei, "utf8")) as Datei;
        return this.daten;
      } catch {
        /* neu anlegen */
      }
    }
    const k = webpush.generateVAPIDKeys();
    this.daten = { vapidPublic: k.publicKey, vapidPrivateEnc: credentials().encryptString(k.privateKey).toString("base64"), abos: [] };
    this.speichern();
    return this.daten;
  }

  private speichern(): void {
    writeFileSync(this.datei, JSON.stringify(this.daten, null, 2), { mode: 0o600 });
  }

  oeffentlicherSchluessel(): string {
    return this.laden().vapidPublic;
  }

  abonnieren(abo: { endpoint: string; keys: { p256dh: string; auth: string } }, geraet: string): number {
    if (!/^https:\/\//.test(abo.endpoint) || !abo.keys?.p256dh || !abo.keys?.auth) throw new Error("Ungültiges Push-Abo.");
    const d = this.laden();
    d.abos = d.abos.filter((a) => a.endpoint !== abo.endpoint);
    d.abos.push({ endpoint: abo.endpoint, keys: { p256dh: abo.keys.p256dh, auth: abo.keys.auth }, geraet: geraet.slice(0, 80), seit: new Date().toISOString() });
    if (d.abos.length > MAX_ABOS) d.abos = d.abos.slice(-MAX_ABOS);
    this.speichern();
    return d.abos.length;
  }

  abbestellen(endpoint: string): boolean {
    const d = this.laden();
    const vorher = d.abos.length;
    d.abos = d.abos.filter((a) => a.endpoint !== endpoint);
    this.speichern();
    return d.abos.length !== vorher;
  }

  hatAbo(endpoint: string): boolean {
    return this.laden().abos.some((a) => a.endpoint === endpoint);
  }

  enqueue(alert: Alert): boolean {
    const d = this.laden();
    if (d.abos.length === 0) return false;
    const p = this.deps.prefs();
    if (alert.severity !== "urgent") {
      if (RANG[alert.severity] < RANG[p.pushSeverityThreshold]) return false;
      if (this.ruhezeit(p)) return false;
    }
    void this.senden({
      titel: alert.companyName ? `${alert.companyName}: ${alert.headline}` : alert.headline,
      text: alert.rationale.slice(0, 200),
      url: alert.companyId ? `/firmen/${encodeURIComponent(alert.companyId)}` : "/meldungen",
      tag: alert.id,
      dringend: alert.severity === "urgent",
    });
    return true;
  }

  /** Testnachricht an alle Geräte. */
  async test(): Promise<{ gesendet: number; fehler: number }> {
    return this.senden({ titel: "AVA", text: "Mitteilungen sind eingerichtet.", url: "/meldungen", tag: "test", dringend: false });
  }

  private ruhezeit(p: AlertPrefs): boolean {
    const q = p.quietHours;
    if (!q.enabled) return false;
    const jetzt = new Date();
    if (q.silenceWeekends && (jetzt.getDay() === 0 || jetzt.getDay() === 6)) return true;
    const m = jetzt.getHours() * 60 + jetzt.getMinutes();
    if (q.startMinute === q.endMinute) return false;
    return q.startMinute < q.endMinute ? m >= q.startMinute && m < q.endMinute : m >= q.startMinute || m < q.endMinute;
  }

  private async senden(n: { titel: string; text: string; url: string; tag: string; dringend: boolean }): Promise<{ gesendet: number; fehler: number }> {
    const d = this.laden();
    let privat: string;
    try {
      privat = credentials().decryptString(Buffer.from(d.vapidPrivateEnc, "base64"));
    } catch {
      this.deps.log?.("[push] VAPID-Schlüssel nicht lesbar");
      return { gesendet: 0, fehler: d.abos.length };
    }
    const optionen = {
      vapidDetails: { subject: "mailto:support@ava.bi", publicKey: d.vapidPublic, privateKey: privat },
      TTL: n.dringend ? 24 * 3600 : 3600,
      urgency: (n.dringend ? "high" : "normal") as "high" | "normal",
    };
    let gesendet = 0;
    let fehler = 0;
    const tot: string[] = [];
    await Promise.all(
      d.abos.map(async (a) => {
        try {
          await webpush.sendNotification({ endpoint: a.endpoint, keys: a.keys }, JSON.stringify(n), optionen);
          gesendet++;
        } catch (err) {
          fehler++;
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) tot.push(a.endpoint);
          else this.deps.log?.(`[push] Zustellung fehlgeschlagen (${status ?? "?"})`);
        }
      }),
    );
    if (tot.length) {
      d.abos = d.abos.filter((a) => !tot.includes(a.endpoint));
      this.speichern();
    }
    return { gesendet, fehler };
  }
}
