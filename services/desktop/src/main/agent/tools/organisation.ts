// O2 (docs/PLAN_ORGANISATIONEN.md) — Organisation im Chat (Self-Service).
//
//   org_info            — read-only: eigene Organisation, Rolle, Vorgaben,
//                         offene Beitrittsanfrage; Admins sehen zusaetzlich
//                         den Einladungslink.
//   org_members         — read-only: Mitglieder + offene Anfragen (Admin).
//   org_member_approve  — Anfrage annehmen/ablehnen (Admin, confirmAction).
//   org_member_remove   — Mitglied entfernen (Admin, destruktiv).
//
// Anlegen, Beitritt per Link, Rollen, Austritt bleiben in der UI: sie
// starten AVA neu (Tenant-Wechsel) oder brauchen einen Link von aussen.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { GatewayClient } from "../gateway-client";
import type { OrgState } from "../../../shared/types";

export interface OrgToolDeps {
  gateway: GatewayClient;
}

function istAdmin(st: OrgState): boolean {
  return st.kind === "organisation" && (st.myRole === "owner" || st.myRole === "admin");
}

export function buildOrganisationTools(deps: OrgToolDeps): Tool[] {
  const lade = () => deps.gateway.request<OrgState>("/v1/tenants/me", { method: "GET" });

  const info = defineTool({
    name: "org_info",
    summary: "Eigene Organisation anzeigen: Name, Rolle, Mitgliederzahl, Vorgaben, Einladungslink (Admin).",
    category: "organisation tenant mandant team firma mitglieder einladung",
    description:
      "Liefert die Organisation des angemeldeten Kontos (oder 'persoenlicher Bereich'), " +
      "die eigene Rolle (owner/admin/member), Mitgliederzahl, die Vorgaben (Funktionen, " +
      "Anbieter-Sperre, Modelle, Prompt-Audit) und fuer Admins den Einladungslink " +
      "ava://join/<token>. Read-only. Organisation anlegen, per Link beitreten oder " +
      "verlassen laeuft ueber die Seite 'Organisation' (#/organisation), weil AVA dabei neu startet.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: (r: { name?: string | null; kind?: string }) =>
      r.kind === "organisation" ? `Organisation ${r.name ?? ""}` : "persoenlicher Bereich",
    run: async () => {
      const st = await lade();
      return {
        kind: st.kind,
        name: st.name,
        rolle: st.myRole,
        mitglieder: st.members.length,
        offeneAnfragen: istAdmin(st) ? st.openRequests.length : undefined,
        einladungslink: st.inviteToken ? `ava://join/${st.inviteToken}` : undefined,
        vorgaben: st.policy,
        seite: "#/organisation",
      };
    },
  });

  const members = defineTool({
    name: "org_members",
    summary: "Mitglieder und offene Beitrittsanfragen der Organisation auflisten (Admin).",
    category: "organisation mitglieder anfragen beitritt team",
    description:
      "Listet Mitglieder (Nutzer-ID, Name/E-Mail soweit bekannt, Rolle, seit) und fuer Admins " +
      "die offenen Beitrittsanfragen mit Anfrage-ID. Die Anfrage-ID braucht org_member_approve.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: (r: { mitglieder?: unknown[]; anfragen?: unknown[] }) =>
      `${r.mitglieder?.length ?? 0} Mitglieder, ${r.anfragen?.length ?? 0} offene Anfragen`,
    run: async () => {
      const st = await lade();
      if (st.kind !== "organisation") return { hinweis: "Du bist in keiner Organisation.", mitglieder: [], anfragen: [] };
      return {
        organisation: st.name,
        rolle: st.myRole,
        mitglieder: st.members.map((m) => ({
          actorId: m.actorId,
          name: m.name,
          email: m.email,
          rolle: m.role,
          seit: m.joinedAt,
        })),
        anfragen: istAdmin(st)
          ? st.openRequests.map((r) => ({ requestId: r.id, actorId: r.actorId, name: r.name, email: r.email, seit: r.requestedAt }))
          : [],
      };
    },
  });

  const approve = defineTool({
    name: "org_member_approve",
    summary: "Beitrittsanfrage annehmen oder ablehnen (Admin, mit Bestaetigung).",
    category: "organisation anfrage annehmen ablehnen freigeben beitritt",
    description:
      "Entscheidet eine offene Beitrittsanfrage. requestId aus org_members. 'approve' macht den " +
      "Nutzer zum Mitglied (seine AVA startet beim naechsten Abgleich neu), 'reject' lehnt ab. " +
      "Fragt vor der Ausfuehrung nach.",
    parameters: {
      type: "object",
      required: ["requestId", "entscheidung"],
      properties: {
        requestId: { type: "string", description: "Anfrage-ID aus org_members" },
        entscheidung: { type: "string", enum: ["approve", "reject"] },
      },
    },
    schema: yup
      .object({
        requestId: yup.string().trim().min(4).max(64).required(),
        entscheidung: yup.string().oneOf(["approve", "reject"]).required(),
      })
      .noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean; entscheidung?: string }) =>
      r.abgebrochen ? "abgebrochen" : r.entscheidung === "approve" ? "Anfrage angenommen" : "Anfrage abgelehnt",
    run: async (args, c) => {
      const st = await lade();
      const req = st.openRequests.find((r) => r.id === args.requestId);
      const wer = req ? (req.name ?? req.email ?? req.actorId.slice(0, 8)) : args.requestId;
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            args.entscheidung === "approve"
              ? `${wer} in ${st.name ?? "die Organisation"} aufnehmen?`
              : `Beitrittsanfrage von ${wer} ablehnen?`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: args.entscheidung === "approve" ? "Aufnehmen" : "Ablehnen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ok: false, abgebrochen: true };
      await deps.gateway.request(`/v1/tenants/me/requests/${encodeURIComponent(args.requestId)}`, {
        method: "POST",
        body: { entscheidung: args.entscheidung },
      });
      return { ok: true, entscheidung: args.entscheidung, wer };
    },
  });

  const remove = defineTool({
    name: "org_member_remove",
    summary: "Mitglied aus der Organisation entfernen (Admin, destruktiv, mit Bestaetigung).",
    category: "organisation mitglied entfernen rauswerfen austritt",
    description:
      "Entfernt ein Mitglied; es faellt auf seinen persoenlichen Bereich zurueck, seine AVA startet " +
      "beim naechsten Abgleich neu. Der letzte Owner kann nicht entfernt werden. actorId aus " +
      "org_members. Fragt vor der Ausfuehrung nach. Fuer den eigenen Austritt die Seite 'Organisation' nutzen.",
    parameters: {
      type: "object",
      required: ["actorId"],
      properties: { actorId: { type: "string", description: "Nutzer-ID aus org_members" } },
    },
    schema: yup.object({ actorId: yup.string().trim().min(4).max(128).required() }).noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean }) => (r.abgebrochen ? "abgebrochen" : "Mitglied entfernt"),
    run: async (args, c) => {
      const st = await lade();
      const m = st.members.find((x) => x.actorId === args.actorId);
      const wer = m ? (m.name ?? m.email ?? m.actorId.slice(0, 8)) : args.actorId;
      const value = await c.ui.confirmAction(
        {
          kind: "destructive",
          prompt: `${wer} aus ${st.name ?? "der Organisation"} entfernen? Die Person verliert den Zugriff auf gemeinsame Daten und Schluessel.`,
          confirmValue: "entfernen",
          options: [
            { value: "entfernen", label: "Entfernen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "entfernen") return { ok: false, abgebrochen: true };
      await deps.gateway.request(`/v1/tenants/me/members/${encodeURIComponent(args.actorId)}`, { method: "DELETE" });
      return { ok: true, wer };
    },
  });

  return [info, members, approve, remove];
}
