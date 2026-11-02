// docs/PLAN_PROBLEM_MELDEN.md M2 — Antworten des Betreibers abholen: alle 10 Minuten
// GET /v1/meldungen/meine; neue Betreiber-Nachrichten werden Meldungen in AVA
// (Dedupe ueber sourceRef) und setzen den Zaehler fuer den Knopf im Chat.
import type { AlertsStore } from "../agent/alerts-store";
import type { Alert } from "../../shared/types";

interface Gateway { request<T>(path: string): Promise<T> }
interface Meine { meldungen: Array<{ id: string; kennung: string; titel: string; status: string; ungelesenNutzer: boolean; letzteNachricht: string | null; letzteBetreiberAntwortAt: string | null }>; ungelesen: number }

export class ProblemAbholer {
  private timer: NodeJS.Timeout | null = null;
  private erst: NodeJS.Timeout | null = null;
  private ungelesen = 0;
  /** Wird vom Hauptprozess gesetzt (Renderer benachrichtigen). */
  onChanged: ((ungelesen: number) => void) | null = null;
  constructor(private readonly deps: { gateway: Gateway; alerts: AlertsStore; notify: (a: Alert) => void; isSignedIn: () => boolean }) {}

  start(): void {
    this.erst = setTimeout(() => void this.pruefen(), 90_000);
    this.timer = setInterval(() => void this.pruefen(), 10 * 60_000);
  }
  stop(): void {
    if (this.erst) clearTimeout(this.erst);
    if (this.timer) clearInterval(this.timer);
  }
  stand(): number {
    return this.ungelesen;
  }

  async pruefen(): Promise<number> {
    if (!this.deps.isSignedIn()) return this.ungelesen;
    try {
      const r = await this.deps.gateway.request<Meine>("/v1/meldungen/meine");
      const vorher = this.ungelesen;
      this.ungelesen = r.ungelesen;
      for (const m of r.meldungen) {
        if (!m.ungelesenNutzer || !m.letzteBetreiberAntwortAt) continue;
        const a = this.deps.alerts.add({
          tenantId: null,
          companyId: "",
          companyName: "Problemmeldung",
          kind: "reminder",
          severity: "info",
          headline: `Antwort zu deiner Meldung ${m.kennung}`,
          rationale: `${m.titel}: ${(m.letzteNachricht ?? "").slice(0, 300)}\n\nAntworten unter „Problem melden“ unten links im Chat.`,
          sourceRef: `problem:${m.id}:${m.letzteBetreiberAntwortAt}`,
        });
        if (a) { try { this.deps.notify(a); } catch { /* best-effort */ } }
      }
      if (vorher !== this.ungelesen) this.onChanged?.(this.ungelesen);
    } catch { /* Gateway nicht erreichbar oder aeltere Version */ }
    return this.ungelesen;
  }
}
