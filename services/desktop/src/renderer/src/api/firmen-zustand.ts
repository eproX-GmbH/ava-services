// docs/PLAN_PRICING_TIERS.md P10 — aktiv/ruhend je Firma: Lesen, Uebersicht,
// Aktivieren (sofort oder ab Monatswechsel mit Tausch), Ruhen lassen,
// Vormerkung zuruecknehmen. Nutzersichtbar heisst es „aktiv“ und „ruhend“.
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch, GatewayError, type KontingentErschoepftDetail } from "./gateway";

export type Zustand = "aktiv" | "ruhend";

export interface FirmenZustand {
  companyId: string;
  zustand: Zustand;
  seit: string | null;
  geplant: Zustand | null;
  geplantAb: string | null;
  geplantTausch: string[];
}

export interface ZustandAntwort {
  aktivModell: boolean;
  zustaende: FirmenZustand[];
  aktivierung: { moeglich: boolean; ablehnung: KontingentErschoepftDetail | null } | null;
}

export interface ZustandUebersicht {
  aktivModell: boolean;
  gesamt: number;
  aktiv: number;
  ruhend: number;
  geplantAktiv: Array<{ companyId: string; name: string | null; ab: string; tausch: string[]; wartet: boolean }>;
  geplantRuhend: Array<{ companyId: string; name: string | null; ab: string }>;
  tauschvorschlaege: Array<{ companyId: string; name: string | null; aktivSeit: string | null }>;
  free: { genutzt: number; limit: number } | null;
  naechsterMonat: string;
}

export function useFirmenZustand(companyId: string | undefined, pruefen = false) {
  return useQuery<ZustandAntwort>({
    queryKey: ["firmen-zustand", companyId, pruefen],
    queryFn: () => gatewayFetch<ZustandAntwort>("/v1/firmen/zustand", { query: { companyIds: companyId!, ...(pruefen ? { pruefen: "1" } : {}) } }),
    enabled: !!companyId,
    staleTime: 30_000,
  });
}

export function useZustandUebersicht(enabled = true) {
  return useQuery<ZustandUebersicht>({
    queryKey: ["firmen-zustand", "uebersicht"],
    queryFn: () => gatewayFetch<ZustandUebersicht>("/v1/firmen/zustand/uebersicht"),
    enabled,
    staleTime: 30_000,
  });
}

export type AktivierenErgebnis =
  | { ok: true; transactionId: string | null; aktiv: string[]; ruhend: string[] }
  | { ok: false; ablehnung: KontingentErschoepftDetail };

/** Aktivieren; bei vollem Kontingent kommt die Ablehnung zurueck statt des globalen Dialogs. */
export async function firmaAktivieren(companyId: string, opts: { ab?: "sofort" | "monatswechsel"; tausch?: string[]; quelle?: string } = {}): Promise<AktivierenErgebnis> {
  try {
    const r = await gatewayFetch<{ ok: true; transactionId: string | null; aktiv: string[]; ruhend: string[] }>(`/v1/firmen/${encodeURIComponent(companyId)}/zustand`, {
      method: "PUT",
      body: { zustand: "aktiv", ab: opts.ab ?? "sofort", ...(opts.tausch ? { tausch: opts.tausch } : {}), quelle: opts.quelle ?? "liste" },
      ohneKontingentDialog: true,
    });
    return r;
  } catch (e) {
    if (e instanceof GatewayError && e.status === 402 && e.body && typeof e.body === "object") {
      return { ok: false, ablehnung: e.body as KontingentErschoepftDetail };
    }
    throw e;
  }
}

export async function firmaRuhenLassen(companyId: string, ab: "sofort" | "monatswechsel" = "sofort", quelle = "liste"): Promise<void> {
  await gatewayFetch(`/v1/firmen/${encodeURIComponent(companyId)}/zustand`, { method: "PUT", body: { zustand: "ruhend", ab, quelle } });
}

export async function vormerkungWiderrufen(companyId: string): Promise<void> {
  await gatewayFetch(`/v1/firmen/${encodeURIComponent(companyId)}/zustand/geplant`, { method: "DELETE" });
}

/** „2026-12“ → „1. Dezember“ */
export function monatsersterText(periodKey: string): string {
  const [j, m] = periodKey.split("-").map(Number);
  if (!j || !m) return periodKey;
  return `1. ${new Date(Date.UTC(j, m - 1, 1)).toLocaleDateString("de-DE", { month: "long", timeZone: "UTC" })}`;
}
