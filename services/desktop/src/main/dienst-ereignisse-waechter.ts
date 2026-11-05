// Wächter für den Rückkanal fremder Dienste (docs/PLAN_CLOSE_MCP.md, C4):
// fragt alle drei Minuten neue, ungelesene Ereignisse ab und meldet sie als
// Benachrichtigung ("CompLeadly: Lead hat geantwortet · Max Muster, Firma").
// Markiert sie danach als gelesen; im Chat bleiben sie über dienst_ereignisse
// abrufbar.

import type { GatewayClient } from "./agent/gateway-client";
import { ereignisKurz } from "./agent/tools/dienste";
import { notifier, windows } from "../core/platform";

const TAKT_MS = 3 * 60_000;
const ERSTER_TAKT_MS = 90_000;

const TYP_TEXT: Record<string, string> = {
  connection_request_sent: "Kontaktanfrage gesendet",
  connection_request_accepted: "Kontaktanfrage angenommen",
  message_sent: "Nachricht gesendet",
  lead_replied: "Lead hat geantwortet",
  inmail_sent: "InMail gesendet",
  profile_visited: "Profil besucht",
  lead_exported: "Lead exportiert",
};

function typText(typ: string | null): string {
  if (!typ) return "Ereignis";
  const key = typ.toLowerCase().replace(/[\s.-]+/g, "_");
  return TYP_TEXT[key] ?? typ.replace(/[_.]+/g, " ");
}

export class DienstEreignisseWaechter {
  private timer: NodeJS.Timeout | null = null;
  private laeuft = false;

  constructor(private readonly deps: { gateway: GatewayClient; signedIn: () => boolean; log?: (m: string) => void }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), TAKT_MS);
    }, ERSTER_TAKT_MS);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
    }
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.laeuft || !this.deps.signedIn()) return;
    this.laeuft = true;
    try {
      const r = await this.deps.gateway.request<{ ereignisse: Array<{ id: string; dienst: string; typ: string | null; nutzlast: unknown; empfangenAt: string; gelesenAt: string | null }> }>(
        "/v1/dienste/ereignisse",
        { query: { ungelesen: "1", limit: "20" } },
      );
      const liste = r.ereignisse ?? [];
      if (liste.length === 0) return;
      const jeDienst = new Map<string, typeof liste>();
      for (const e of liste) jeDienst.set(e.dienst, [...(jeDienst.get(e.dienst) ?? []), e]);
      for (const [dienst, es] of jeDienst) {
        const erstes = ereignisKurz(es[0]!);
        const wer = [erstes.name, erstes.firma].filter(Boolean).join(", ");
        const titel = `${dienstName(dienst)}: ${typText(es[0]!.typ)}${es.length > 1 ? ` (+${es.length - 1})` : ""}`;
        notifier().show({ title: titel, body: wer || "Neues Ereignis über den Rückkanal", silent: true, onClick: () => windows().focusMain() });
      }
      await this.deps.gateway.request("/v1/dienste/ereignisse/gelesen", { method: "POST", body: { ids: liste.map((e) => e.id) } }).catch(() => undefined);
      this.deps.log?.(`[dienst-ereignisse] ${liste.length} Ereignisse gemeldet`);
    } catch (err) {
      this.deps.log?.(`[dienst-ereignisse] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.laeuft = false;
    }
  }
}

function dienstName(slug: string): string {
  if (slug === "compleadly") return "CompLeadly";
  if (slug === "close") return "Close";
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}
