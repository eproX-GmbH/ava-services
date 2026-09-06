// O2 (docs/PLAN_ORGANISATIONEN.md) — Organisationen im Hauptprozess.
//
//   - Einladungslink `ava://join/<token>`: ankommende URL an den Renderer
//     reichen (Seite „Organisation" zeigt die Beitritts-Rueckfrage); kommt
//     der Link vor dem Fenster an, wird er bis zum ersten Abruf gepuffert.
//   - Tenant-Wechsel-Erkennung: /v1/whoami regelmaessig und auf Anforderung
//     pruefen. Aendert sich die Tenant-ID bei gleichem Konto (Beitritt
//     freigegeben, entfernt, Organisation angelegt/verlassen), Identitaet
//     nachziehen, Renderer informieren und AVA kontrolliert neu starten —
//     Producer-Env, Policy und Tenant-Sicht haengen am Tenant.
//   - Anfragen-Waechter: Admins bekommen eine OS-Benachrichtigung, wenn
//     neue Beitrittsanfragen offen sind (Meldungs-Feed ist firmengebunden
//     und passt hier nicht).

import { app, BrowserWindow, Notification } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readIdentity, updateIdentityTenant } from "./account-space";
import type { GatewayClient } from "./agent/gateway-client";
import type { OrgState, OrgPolicy, OrgShareRow } from "../shared/types";
import { applyOrgPolicy } from "./org-policy";

interface WhoamiLite {
  tenantId: string;
  actorId: string;
  tenantName?: string | null;
  role?: string;
  policy?: Partial<OrgPolicy> | null;
}

interface Deps {
  gateway: GatewayClient;
  isSignedIn: () => boolean;
  /** O5 — Organisationsschluessel (Hinweise) an den Provider-Manager melden. */
  onOrgProviders?: (providers: Record<string, string>) => void;
  /** O9 — neue, noch nicht gemeldete Radar-Freigaben (Sammel-Meldung). */
  onNeueRadarFreigaben?: (shares: OrgShareRow[]) => void;
}

let deps: Deps | null = null;
let pendingJoinToken: string | null = null;
let timer: NodeJS.Timeout | null = null;
let relaunchAngestossen = false;
let bekannteAnfragen: Set<string> | null = null;

const PRUEF_INTERVALL_MS = 10 * 60_000;
/** Wiederholungsschutz: derselbe Wechsel loest innerhalb dieser Frist
 *  keinen zweiten Neustart aus (Schleifen-Bremse, 2026-09-04). */
const WECHSEL_SPERRE_MS = 30 * 60_000;

function wechselMarkerPfad(): string {
  return join(app.getPath("userData"), "tenant-switch.json");
}

function letzterWechsel(): { from: string; to: string; at: number } | null {
  try {
    const p = wechselMarkerPfad();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as { from: string; to: string; at: number };
  } catch {
    return null;
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* zerstoertes Fenster */
    }
  }
}

function focusApp(): void {
  try {
    app.focus({ steal: true });
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  } catch {
    /* kosmetisch */
  }
}

/** Von billing.ts (Protokoll-Bruecke) aufgerufen: ava://join/<token>. */
export function handleJoinUrl(parsed: URL): void {
  const token = parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
    console.warn("[organisation] Einladungslink verworfen (Token-Form)");
    return;
  }
  pendingJoinToken = token;
  focusApp();
  if (BrowserWindow.getAllWindows().length > 0) broadcast("org:joinLink", { token });
}

/** Renderer holt einen gepufferten Link genau einmal ab (Kaltstart). */
export function consumePendingJoin(): string | null {
  const t = pendingJoinToken;
  pendingJoinToken = null;
  return t;
}

export function extractJoinToken(eingabe: string): string | null {
  const s = eingabe.trim();
  const m = /^ava:\/\/join\/([A-Za-z0-9_-]{8,64})\/?$/.exec(s);
  if (m) return m[1] ?? null;
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

/** Tenant-Wechsel pruefen. Liefert true, wenn ein Neustart angestossen wurde. */
export async function checkTenantChange(grund: string): Promise<boolean> {
  if (!deps || !deps.isSignedIn() || relaunchAngestossen) return false;
  let who: WhoamiLite;
  try {
    who = await deps.gateway.request<WhoamiLite>("/v1/whoami", { method: "GET" });
  } catch (err) {
    console.log(`[organisation] whoami (${grund}) nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  // O3 — Vorgaben immer uebernehmen (auch ohne Tenant-Wechsel).
  applyOrgPolicy(who.policy ?? null);
  const ident = readIdentity();
  if (!ident || ident.sub !== who.actorId) return false;
  if (!ident.tenantId) {
    updateIdentityTenant(who.tenantId, who.tenantName ?? null);
    return false;
  }
  if (ident.tenantId === who.tenantId) {
    if ((ident.tenantName ?? null) !== (who.tenantName ?? null)) {
      updateIdentityTenant(who.tenantId, who.tenantName ?? null);
    }
    return false;
  }
  const name = who.tenantName ?? (who.tenantId === who.actorId ? null : who.tenantId);
  const persoenlich = who.tenantId === who.actorId;
  const letzter = letzterWechsel();
  if (letzter && letzter.from === ident.tenantId && letzter.to === who.tenantId && Date.now() - letzter.at < WECHSEL_SPERRE_MS) {
    console.warn(
      `[organisation] Tenant-Wechsel ${ident.tenantId.slice(0, 12)}… → ${who.tenantId.slice(0, 12)}… wiederholt sich innerhalb von ${Math.round(WECHSEL_SPERRE_MS / 60000)} Min — KEIN weiterer Neustart (Schleifen-Bremse). Identitaet wird nur nachgezogen.`,
    );
    updateIdentityTenant(who.tenantId, who.tenantName ?? null);
    return false;
  }
  console.log(
    `[organisation] Tenant-Wechsel erkannt (${grund}): ${ident.tenantId.slice(0, 12)}… → ${who.tenantId.slice(0, 12)}… (${persoenlich ? "persoenlich" : name}) — Neustart`,
  );
  try {
    writeFileSync(wechselMarkerPfad(), JSON.stringify({ from: ident.tenantId, to: who.tenantId, at: Date.now() }));
  } catch {
    /* best-effort */
  }
  updateIdentityTenant(who.tenantId, who.tenantName ?? null);
  relaunchAngestossen = true;
  broadcast("org:tenantChanged", { tenantId: who.tenantId, tenantName: name, persoenlich });
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 2500);
  return true;
}

// O9 — Radar-Freigaben: einmal je Freigabe melden (Merker in userData).
function gemeldetPfad(): string {
  return join(app.getPath("userData"), "org-shares-notified.json");
}
function gemeldeteIds(): Set<string> {
  try {
    const p = gemeldetPfad();
    if (!existsSync(p)) return new Set();
    return new Set(JSON.parse(readFileSync(p, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}
function merkeGemeldet(ids: Set<string>): void {
  try {
    writeFileSync(gemeldetPfad(), JSON.stringify(Array.from(ids).slice(-2000)));
  } catch {
    /* best-effort */
  }
}

export async function listShares(kind?: "transaction" | "radar_company"): Promise<OrgShareRow[]> {
  if (!deps) return [];
  const qs = kind ? `?kind=${kind}` : "";
  const r = await deps.gateway.request<{ items: OrgShareRow[] }>(`/v1/tenants/me/shares${qs}`, { method: "GET" });
  return r.items ?? [];
}

export async function shareRadar(discoveryIds: string[], note?: string): Promise<{ geteilt: number; unbekannt: string[] }> {
  if (!deps) throw new Error("Organisation nicht initialisiert");
  return deps.gateway.request<{ geteilt: number; unbekannt: string[] }>("/v1/tenants/me/shares/radar", {
    method: "POST",
    body: { discoveryIds, ...(note ? { note } : {}) },
  });
}

export async function markShare(id: string, was: "seen" | "dismiss"): Promise<void> {
  if (!deps) return;
  await deps.gateway.request(`/v1/tenants/me/shares/${encodeURIComponent(id)}/${was}`, { method: "POST" });
}

async function pruefeRadarFreigaben(): Promise<void> {
  if (!deps || !deps.isSignedIn() || !deps.onNeueRadarFreigaben) return;
  let items: OrgShareRow[];
  try {
    items = await listShares("radar_company");
  } catch {
    return;
  }
  const gemeldet = gemeldeteIds();
  const ident = readIdentity();
  const neu = items.filter((x) => !gemeldet.has(x.id) && !x.seenAt && x.sharedBy !== ident?.sub);
  if (neu.length === 0) return;
  deps.onNeueRadarFreigaben(neu);
  for (const x of neu) gemeldet.add(x.id);
  merkeGemeldet(gemeldet);
}

async function pruefeAnfragen(): Promise<void> {
  if (!deps || !deps.isSignedIn()) return;
  let st: OrgState;
  try {
    st = await deps.gateway.request<OrgState>("/v1/tenants/me", { method: "GET" });
  } catch {
    return;
  }
  // O5 — hinterlegte Organisationsschluessel (nur Hinweise) weiterreichen.
  const provs: Record<string, string> = {};
  for (const p of st.providers ?? []) provs[p.kind] = p.keyHint;
  deps.onOrgProviders?.(provs);
  if (st.kind === "organisation") void pruefeRadarFreigaben();
  if (st.kind !== "organisation" || !(st.myRole === "owner" || st.myRole === "admin")) {
    bekannteAnfragen = null;
    return;
  }
  const ids = new Set(st.openRequests.map((r) => r.id));
  if (bekannteAnfragen) {
    const neu = st.openRequests.filter((r) => !bekannteAnfragen!.has(r.id));
    if (neu.length > 0) {
      broadcast("org:requestsChanged", { offen: ids.size });
      try {
        const wer = neu.map((r) => r.name ?? r.email ?? r.actorId.slice(0, 8)).join(", ");
        const n = new Notification({
          title: neu.length === 1 ? "Neue Beitrittsanfrage" : `${neu.length} neue Beitrittsanfragen`,
          body: `${wer} möchte ${st.name ?? "deiner Organisation"} beitreten. Freigeben unter Organisation.`,
        });
        n.on("click", () => {
          focusApp();
          broadcast("org:openPage", {});
        });
        n.show();
      } catch (err) {
        console.warn("[organisation] Benachrichtigung fehlgeschlagen:", err);
      }
    }
  }
  bekannteAnfragen = ids;
}

export function initOrganisation(d: Deps): void {
  deps = d;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void checkTenantChange("periodisch").then((neu) => {
      if (!neu) void pruefeAnfragen();
    });
  }, PRUEF_INTERVALL_MS);
  timer.unref?.();
}

/** Nach Anmeldung: Basis setzen bzw. Wechsel seit dem letzten Lauf erkennen. */
export function onSignedIn(): void {
  setTimeout(() => {
    void checkTenantChange("nach Anmeldung").then((neu) => {
      if (!neu) void pruefeAnfragen();
    });
  }, 4000);
}

export function stopOrganisation(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
