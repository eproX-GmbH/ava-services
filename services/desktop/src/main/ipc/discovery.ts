// IPC-Handler „Firmen-Discovery, Radar, ICP-Assistent“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { fillProfileFromIcp } from "../agent/icp-profile-sync";
import { radarActivity } from "../discovery/activity";
import { decideCandidates } from "../discovery/decide";
import { buildCustomerInputs, runIcpAnalysis } from "../discovery/icp-assistant";
import { listCandidatesWithMatches } from "../discovery/list";
import { runMatch } from "../discovery/matcher";
import { domainFromUrl } from "../discovery/scan";
import { join } from "node:path";
import type { AgentOrchestrator, GatewayClient, LlmProviderManager, UserProfileStore } from "../agent";
import type { IcpStore } from "../agent/icp-store";
import type { AuditEventInput } from "../audit/audit-types";
import type { CustomerProfileStore } from "../discovery/customer-profiles";
import type { DecideInput } from "../discovery/decide";
import type { MatchStore } from "../discovery/match-store";
import type { ProfileWorker } from "../discovery/profile-worker";
import type { RadarAlertEmitter } from "../discovery/radar-alerts";
import type { RadarSupervisor } from "../discovery/radar-supervisor";

export interface DiscoveryIpcDeps {
  agent: AgentOrchestrator;
  audit: (input: AuditEventInput) => void;
  customerProfiles: CustomerProfileStore;
  discoveryMatches: MatchStore;
  gatewayClient: GatewayClient;
  /** Schreibbar: der Handler setzt die Sperre selbst. */
  icpAnalysisRunning: { current: boolean };
  icpStore: IcpStore;
  profileWorker: { readonly current: ProfileWorker | null };
  providers: LlmProviderManager;
  radarAlertEmitter: { readonly current: RadarAlertEmitter | null };
  radarSupervisor: { readonly current: RadarSupervisor | null };
  userProfile: UserProfileStore;
}

export function registerDiscoveryIpc(deps: DiscoveryIpcDeps): void {
  const { agent, audit, customerProfiles, discoveryMatches, gatewayClient, icpAnalysisRunning, icpStore, profileWorker, providers, radarAlertEmitter, radarSupervisor, userProfile } = deps;

  // v0.1.636 — Live-Aktivitaet des Radars (Indikator + Popup).
  ipcMain.handle("discovery:activity", () => radarActivity.get());

  ipcMain.handle("discovery:candidates", async () => {
    try {
      return {
        ok: true,
        candidates: await listCandidatesWithMatches(
          gatewayClient,
          discoveryMatches,
          { limit: 300 },
        ),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(
    "discovery:decide",
    async (_e, decisions: DecideInput[]) => {
      const result = await decideCandidates(gatewayClient, decisions ?? []);
      if (!("error" in result)) {
        audit({
          actorType: "user",
          actorId: null,
          category: "import",
          action: "discovery.decide",
          severity: "info",
          subjectType: null,
          subjectId: result.transactionId,
          summary: `Radar: ${result.importiert} Firmen importiert, ${result.ignoriert} ignoriert`,
          metadata: {
            importiert: result.importiert,
            ignoriert: result.ignoriert,
            ohneOrt: result.ohneOrt,
          },
        });
      }
      return result;
    },
  );

  ipcMain.handle("discovery:match", async () => {
    const result = await runMatch(
      gatewayClient,
      providers,
      icpStore,
      discoveryMatches,
      customerProfiles,
    );
    // Alerts feuern auch beim MANUELLEN Match (Glocke + Push +
    // Telegram) — vorher nur im Automatik-Lauf, wodurch heisse Treffer
    // stumm blieben.
    if (!("error" in result) && radarAlertEmitter.current) {
      const emitted = radarAlertEmitter.current.emit(result.ergebnisse);
      if (emitted.neu > 0 || emitted.bereitsGemeldet > 0) {
        result.hinweise.push(
          `${emitted.neu} neue heisse Treffer gemeldet` +
            (emitted.bereitsGemeldet > 0
              ? ` (${emitted.bereitsGemeldet} bereits frueher gemeldet)`
              : "") +
            ".",
        );
      }
    }
    return result;
  });

  // v0.1.474 — Backlog-Abbau: der Button stoesst jetzt den
  // kontinuierlichen Worker an (voller Drain statt 25er-Happen);
  // laeuft schon einer, haengt sich der Klick an dessen Ergebnis.
  ipcMain.handle("discovery:profile", async () => {
    if (!profileWorker.current) return { error: "Profil-Worker nicht bereit." };
    return profileWorker.current.drain();
  });

  ipcMain.handle("discovery:getIcp", () => ({
    ...icpStore.get(),
    gesetzt: icpStore.isSet(),
    vollstaendig: icpStore.isComplete(),
    fehlend: icpStore.fehlendeFelder(),
  }));

  ipcMain.handle(
    "icpAssistant:analyze",
    async (e, args: { eigeneUrl: string; kundenUrls: string[] }) => {
      if (icpAnalysisRunning.current) {
        return { error: "Es laeuft bereits eine Analyse." };
      }
      const eigeneDomain = domainFromUrl(args?.eigeneUrl);
      if (!eigeneDomain) {
        return { error: "Die eigene Website-URL ist nicht verwertbar." };
      }
      const { inputs: kunden, unbrauchbar } = buildCustomerInputs(
        args?.kundenUrls ?? [],
        eigeneDomain,
      );
      icpAnalysisRunning.current = true;
      try {
        const result = await runIcpAnalysis(
          gatewayClient,
          providers,
          { eigeneDomain, kunden },
          (p) => {
            try {
              e.sender.send("icpAssistant:progress", p);
            } catch {
              /* Fenster ggf. geschlossen */
            }
          },
          customerProfiles,
        );
        audit({
          actorType: "user",
          actorId: null,
          category: "import",
          action: "discovery.icp-analyze",
          severity: "error" in result ? "warning" : "info",
          subjectType: null,
          subjectId: null,
          summary:
            "error" in result
              ? `ICP-Analyse fehlgeschlagen: ${result.error}`
              : `ICP-Analyse ${eigeneDomain}: ${result.kunden.length}/${kunden.length} Kunden-Websites eingeflossen` +
                (result.kundenFehlgeschlagen.length > 0
                  ? ` (fehlgeschlagen: ${result.kundenFehlgeschlagen.map((f) => f.domain).join(", ")})`
                  : ""),
          metadata: {
            eigeneDomain,
            kundenAnzahl: kunden.length,
            ...( "error" in result
              ? {}
              : {
                  beruecksichtigt: result.kunden.map((k) => `${k.name} (${k.domain})`),
                  fehlgeschlagen: result.kundenFehlgeschlagen,
                }),
            unbrauchbareUrls: unbrauchbar,
          },
        });
        if (!("error" in result) && unbrauchbar.length > 0) {
          result.hinweise.push(
            `Nicht als URL verwertbar: ${unbrauchbar.join(", ")}.`,
          );
        }
        return result;
      } finally {
        icpAnalysisRunning.current = false;
      }
    },
  );

  // I1 ICP-Assistent — Handeingabe ueber das Fragenkatalog-Formular.
  ipcMain.handle(
    "discovery:setIcp",
    (_e, patch: Partial<import("../agent/icp-store").IcpProfile>) => {
      const next = icpStore.set({ ...patch, quelle: patch.quelle ?? "manuell" });
      // ICP → Profil-Bruecke (v0.1.521): leere UND unveraendert
      // ICP-abgeleitete Felder werden aktualisiert; vom Nutzer
      // bearbeitete bleiben unangetastet und werden gemeldet.
      const sync = fillProfileFromIcp(userProfile, next);
      const profilErgaenzt = sync.aktualisiert;
      const profilBeibehalten = sync.beibehalten;
      audit({
        actorType: "user",
        actorId: null,
        category: "import",
        action: "discovery.icp-set",
        severity: "info",
        subjectType: null,
        subjectId: null,
        summary: `ICP aktualisiert (${next.quelle ?? "manuell"})`,
        metadata: { quelle: next.quelle },
      });
      return {
        ...next,
        gesetzt: icpStore.isSet(),
        vollstaendig: icpStore.isComplete(),
        fehlend: icpStore.fehlendeFelder(),
        profilErgaenzt,
        profilBeibehalten,
      };
    },
  );

  // Phase 4 — Radar-Automatik (Opt-in).
  ipcMain.handle("discovery:getRadarConfig", () =>
    radarSupervisor.current ? radarSupervisor.current.getConfig() : null,
  );

  ipcMain.handle(
    "discovery:setRadarConfig",
    (_e, patch: { enabled?: boolean; intervalHours?: 6 | 24 | 168; profileSofort?: boolean; maxOffeneKandidaten?: number }) => {
      if (!radarSupervisor.current) return null;
      const next = radarSupervisor.current.setConfig(patch ?? {});
      profileWorker.current?.setSofort(next.profileSofort);
      audit({
        actorType: "user",
        actorId: null,
        category: "import",
        action: "discovery.radar-config",
        severity: "info",
        subjectType: null,
        subjectId: null,
        summary:
          (next.enabled
            ? `Radar-Automatik AN (${next.intervalHours === 168 ? "wöchentlich" : next.intervalHours === 6 ? "4x täglich" : "täglich"})`
            : "Radar-Automatik AUS") + (next.profileSofort ? " · Mini-Profile sofort" : ""),
        metadata: { enabled: next.enabled, intervalHours: next.intervalHours, profileSofort: next.profileSofort, maxOffeneKandidaten: next.maxOffeneKandidaten },
      });
      return next;
    },
  );

  ipcMain.handle("discovery:radarRunNow", async () => {
    if (!radarSupervisor.current) return { error: "Radar noch nicht initialisiert." };
    return { outcome: await radarSupervisor.current.runNow("manuell") };
  });
}
