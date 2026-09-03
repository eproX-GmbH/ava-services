// T5 (PLAN_TENANT_MULTI_ACCOUNT.md) — Konto und Tenant im Chat.
//
//   account_info — read-only: angemeldetes Konto, Tenant (Name, Rolle,
//                  Mitgliederzahl, Herkunft der Tenant-ID) und die
//                  weiteren Konten auf diesem Geraet.
//
// Bewusst KEIN Wechsel-Tool: ein Kontowechsel startet AVA neu (Konzept
// Abschnitt 3) und wuerde den laufenden Chat abbrechen; er bleibt im
// Konto-Menue der Topbar. API-Keys gehen nie ueber den Chat.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { GatewayClient } from "../gateway-client";
import type { AuthStatus, AccountRecord } from "../../../shared/types";

export interface AccountToolDeps {
  gateway: GatewayClient;
  getAuthStatus: () => AuthStatus;
  listAccounts: () => { active: string | null; accounts: AccountRecord[] };
}

interface WhoamiAntwort {
  tenantId: string;
  actorId: string;
  scopes: string[];
  tenantName?: string | null;
  role?: string;
  memberCount?: number;
  email?: string | null;
  tenantSource?: "claim" | "sub";
}

export function buildAccountTools(deps: AccountToolDeps): Tool[] {
  const info = defineTool({
    name: "account_info",
    summary: "Angemeldetes Konto, Tenant und weitere Konten auf diesem Geraet anzeigen.",
    category: "konto tenant mandant anmeldung account nutzer",
    description:
      "Liefert das angemeldete Konto (Name, E-Mail, Nutzer-ID), den Tenant " +
      "(Name, Rolle, Mitgliederzahl, ob die Tenant-ID aus dem Token-Claim " +
      "oder dem Kompatibilitaets-Fallback stammt) und die weiteren Konten, " +
      "die auf diesem Geraet bekannt sind. Read-only. Kontowechsel und " +
      "'Anderes Konto hinzufuegen' laufen ueber das Konto-Menue in der " +
      "Kopfzeile, weil AVA dafuer neu startet.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: () => "Konto-Info",
    run: async () => {
      const status = deps.getAuthStatus();
      if (!status.signedIn) return { angemeldet: false, hinweis: "Nicht angemeldet." };
      let whoami: WhoamiAntwort | null = null;
      let whoamiFehler: string | null = null;
      try {
        whoami = await deps.gateway.request<WhoamiAntwort>("/v1/whoami", { method: "GET" });
      } catch (err) {
        whoamiFehler = err instanceof Error ? err.message : String(err);
      }
      const konten = deps.listAccounts();
      const tenantId = whoami?.tenantId ?? status.tenantId ?? null;
      const persoenlich = tenantId !== null && tenantId === status.actorId;
      return {
        angemeldet: true,
        konto: {
          name: status.name ?? null,
          email: status.email ?? whoami?.email ?? null,
          userId: status.actorId,
        },
        tenant: {
          id: tenantId,
          name: whoami?.tenantName ?? status.tenantName ?? (persoenlich ? "persoenlicher Tenant" : null),
          rolle: whoami?.role ?? (persoenlich ? "owner" : "member"),
          mitglieder: whoami?.memberCount ?? (persoenlich ? 1 : null),
          herkunft:
            whoami?.tenantSource === "claim"
              ? "tenant_id-Claim aus Keycloak"
              : "Kompatibilitaets-Fallback (Tenant = Nutzer-ID); Keycloak-Tenants noch nicht aktiv",
          hinweis: persoenlich
            ? "Persoenlicher Tenant: nur dieses Konto. Zusammenlegen mit anderen Nutzern pflegt der Operator."
            : "Geteilter Tenant: Firmen und Vorgaenge koennen kuenftig im Tenant sichtbar werden (T6).",
        },
        ...(whoamiFehler ? { whoamiFehler } : {}),
        weitereKontenAufDiesemGeraet: konten.accounts
          .filter((a) => a.sub !== status.actorId)
          .map((a) => ({
            name: a.name,
            email: a.email,
            zuletztGenutzt: a.lastUsedAt,
          })),
        wechselHinweis:
          "Kontowechsel: Konto-Menue in der Kopfzeile (AVA startet mit dem gewaehlten Konto neu). Lokale Daten, Chats und Schluessel sind strikt je Konto getrennt; nur lokale KI-Modelle werden geteilt.",
      };
    },
  });
  return [info];
}
