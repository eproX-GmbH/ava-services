// O2 (docs/PLAN_ORGANISATIONEN.md) — Organisation im Chat (Self-Service).
//
//   org_info            — read-only: eigene Organisation, Rolle, Vorgaben,
//                         offene Beitrittsanfrage; Admins sehen zusaetzlich
//                         den Einladungslink.
//   org_members         — read-only: Mitglieder + offene Anfragen (Admin).
//   org_member_approve  — Anfrage annehmen/ablehnen (Admin, confirmAction).
//   org_member_remove   — Mitglied entfernen (Admin, destruktiv).
//   org_billing_info    — B2: Sammelabrechnung (Zustand, laufender Monat, Datensaetze; Admin).
//   org_billing_activate_seats / _deactivate_seats / _set_tier — Owner, confirmAction.
//   org_billing_invoices — Datensatz einer Periode mit Personen-Nachweis (Admin).
//
// Anlegen, Beitritt per Link, Rollen, Austritt bleiben in der UI: sie
// starten AVA neu (Tenant-Wechsel) oder brauchen einen Link von aussen.

import * as yup from "yup";
import { DEEP_RESEARCH_MODELS } from "../../../shared/research-models";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { GatewayClient } from "../gateway-client";
import { ORG_FEATURES, type OrgState, type OrgPolicy, type OrgBillingState, type OrgBillingInvoice } from "../../../shared/types";

export interface OrgToolDeps {
  gateway: GatewayClient;
  /** O3 — Vorgaben nach Aenderung sofort lokal uebernehmen. */
  refreshPolicy: () => Promise<unknown>;
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
      const r = await deps.gateway.request<{ seat?: { tier: string; unitPriceCents: number } }>(
        `/v1/tenants/me/requests/${encodeURIComponent(args.requestId)}`,
        {
          method: "POST",
          body: { entscheidung: args.entscheidung },
        },
      );
      return {
        ok: true,
        entscheidung: args.entscheidung,
        wer,
        ...(r?.seat
          ? { seat: r.seat, hinweis: `Zaehlt ab dem naechsten Stichtag als ${r.seat.tier}-Seat (${(r.seat.unitPriceCents / 100).toFixed(2)} EUR/Monat, voller Monat).` }
          : {}),
      };
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

  // O3 — Vorgaben (Admin, confirmAction). Schluessel-Eingabe bleibt UI-only.
  const featuresSet = defineTool({
    name: "org_features_set",
    summary: "Funktionen der Organisation ab- oder freischalten (Admin, mit Bestaetigung).",
    category: "organisation vorgaben funktionen abschalten policy compliance",
    description:
      "Schaltet Funktionen fuer ALLE Mitglieder ab oder frei: " +
      ORG_FEATURES.map((f) => `${f.key} (${f.label})`).join(", ") +
      ". Abgeschaltet = aus Navigation, Einstellungen und Chat entfernt, Hintergrunddienste gestoppt; " +
      "kontakte wird zusaetzlich im Gateway abgewiesen. Nur genannte Schluessel aendern sich. Fragt vorher nach.",
    parameters: {
      type: "object",
      required: ["features"],
      properties: {
        features: {
          type: "object",
          description: "Schluessel → true (erlaubt) | false (abgeschaltet)",
          additionalProperties: { type: "boolean" },
        },
      },
    },
    schema: yup
      .object({
        features: yup
          .object()
          .test("keys", "unbekannter Funktionsschluessel", (v) =>
            Object.keys(v ?? {}).every((k) => ORG_FEATURES.some((f) => f.key === k)),
          )
          .required(),
      })
      .noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean; aus?: string[] }) =>
      r.abgebrochen ? "abgebrochen" : `Vorgaben gesetzt — aus: ${r.aus?.length ? r.aus.join(", ") : "nichts"}`,
    run: async (args, c) => {
      const feats = args.features as Record<string, boolean>;
      const zeilen = Object.entries(feats).map(([k, v]) => {
        const f = ORG_FEATURES.find((x) => x.key === k);
        return `${f?.label ?? k}: ${v ? "frei" : "AUS"}`;
      });
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Vorgaben fuer alle Mitglieder aendern?\n\n${zeilen.join("\n")}`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: "Setzen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ok: false, abgebrochen: true };
      const neu = await deps.gateway.request<OrgPolicy>("/v1/tenants/me/policy", { method: "PUT", body: { features: feats } });
      await deps.refreshPolicy();
      return { ok: true, aus: Object.entries(neu.features).filter(([, v]) => v === false).map(([k]) => k) };
    },
  });

  const providerSet = defineTool({
    name: "org_provider_set",
    summary: "Anbieter-Sperre, Modellvorgaben und Prompt-Audit der Organisation setzen (Admin, mit Bestaetigung).",
    category: "organisation vorgaben anbieter modell sperre audit",
    description:
      "Setzt providerLock (Mitglieder duerfen Anbieter/Schluessel/Modell nicht lokal ueberschreiben), " +
      "chatModel, producerModel (null = frei), researchModel (Deep-Research-Modell, nur OpenAI: " +
      "o4-mini-deep-research-2025-06-26 oder o3-deep-research-2025-06-26; null = Standard) und promptAudit (Opt-in). Schluessel selbst werden NIE ueber " +
      "den Chat gesetzt. Nur genannte Felder aendern sich. Fragt vorher nach.",
    parameters: {
      type: "object",
      properties: {
        providerLock: { type: "boolean" },
        chatModel: { type: ["string", "null"] },
        producerModel: { type: ["string", "null"] },
        researchModel: { type: ["string", "null"] },
        promptAudit: { type: "boolean" },
      },
    },
    schema: yup
      .object({
        providerLock: yup.boolean().optional(),
        chatModel: yup.string().max(120).nullable().optional(),
        producerModel: yup.string().max(120).nullable().optional(),
        researchModel: yup
          .string()
          .oneOf(DEEP_RESEARCH_MODELS.map((m) => m.id))
          .nullable()
          .optional(),
        promptAudit: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean }) => (r.abgebrochen ? "abgebrochen" : "Vorgaben gesetzt"),
    run: async (args, c) => {
      const zeilen = Object.entries(args)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v === null ? "frei" : String(v)}`);
      if (zeilen.length === 0) return { ok: false, hinweis: "Nichts angegeben." };
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `KI-Vorgaben der Organisation aendern?\n\n${zeilen.join("\n")}`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: "Setzen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ok: false, abgebrochen: true };
      const neu = await deps.gateway.request<OrgPolicy>("/v1/tenants/me/policy", { method: "PUT", body: args });
      await deps.refreshPolicy();
      return { ok: true, vorgaben: neu };
    },
  });

  // O6 — Limits und Verbrauch.
  const limitsSet = defineTool({
    name: "org_limits_set",
    summary: "Limit fuer KI-Aufrufe ueber Organisationsschluessel setzen (Admin, mit Bestaetigung).",
    category: "organisation limit budget kosten verbrauch quota",
    description:
      "Setzt das Limit fuer Aufrufe ueber Organisationsschluessel: mode 'off' (kein Limit), 'org_total' (Monatsbudget der " +
      "Organisation in US-Dollar) oder 'per_user_daily' (Tagesbudget je Mitglied in US-Dollar); hardStop true = Aufrufe " +
      "werden abgelehnt, false = nur Hinweis. split true = Chat (Hauptmodell) und Hintergrund-Verarbeitung getrennt begrenzen: " +
      "budgetUsd gilt dann fuer die Hintergrund-Verarbeitung, chatBudgetUsd fuer den Chat (weglassen = Chat unbegrenzt). " +
      "Eigene Schluessel bleiben unlimitiert. Fragt vor der Ausfuehrung nach.",
    parameters: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["off", "org_total", "per_user_daily"] },
        budgetUsd: { type: "number", description: "Budget in US-Dollar (Monat bei org_total, Tag je Mitglied bei per_user_daily); bei split nur Hintergrund-Verarbeitung" },
        hardStop: { type: "boolean" },
        split: { type: "boolean", description: "Chat und Hintergrund-Verarbeitung getrennt begrenzen" },
        chatBudgetUsd: { type: "number", description: "Chat-Budget in US-Dollar bei split (weglassen = Chat unbegrenzt)" },
      },
    },
    schema: yup
      .object({
        mode: yup.string().oneOf(["off", "org_total", "per_user_daily"]).required(),
        budgetUsd: yup.number().min(0).max(1_000_000).optional(),
        hardStop: yup.boolean().optional(),
        split: yup.boolean().optional(),
        chatBudgetUsd: yup.number().min(0).max(1_000_000).optional(),
      })
      .noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean; text?: string }) => (r.abgebrochen ? "abgebrochen" : r.text ?? "Limit gesetzt"),
    run: async (args, c) => {
      const chatText = args.split ? ` (Hintergrund), Chat ${args.chatBudgetUsd != null ? `${args.chatBudgetUsd} USD` : "unbegrenzt"}` : "";
      const text =
        args.mode === "off"
          ? "Kein Limit"
          : args.mode === "org_total"
            ? `Monatsbudget der Organisation ${args.budgetUsd ?? "?"} USD${chatText}`
            : `Tagesbudget je Mitglied ${args.budgetUsd ?? "?"} USD${chatText}`;
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `Limit setzen: ${text}${args.mode !== "off" ? (args.hardStop === false ? " (nur Hinweis)" : " (harter Stopp)") : ""}?`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: "Setzen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ok: false, abgebrochen: true };
      const cents = args.budgetUsd != null ? Math.round(args.budgetUsd * 100) : null;
      const chatCents = args.chatBudgetUsd != null ? Math.round(args.chatBudgetUsd * 100) : null;
      await deps.gateway.request("/v1/tenants/me/quota", {
        method: "PUT",
        body: {
          mode: args.mode,
          ...(args.mode === "org_total" ? { orgMonthlyCents: cents } : {}),
          ...(args.mode === "per_user_daily" ? { userDailyCents: cents } : {}),
          ...(args.hardStop !== undefined ? { hardStop: args.hardStop } : {}),
          ...(args.split !== undefined ? { split: args.split } : {}),
          ...(args.split && args.mode === "org_total" ? { chatOrgMonthlyCents: chatCents } : {}),
          ...(args.split && args.mode === "per_user_daily" ? { chatUserDailyCents: chatCents } : {}),
        },
      });
      return { ok: true, text };
    },
  });

  const usage = defineTool({
    name: "org_usage",
    summary: "Verbrauch ueber Organisationsschluessel (Monat, heute, je Mitglied) anzeigen.",
    category: "organisation verbrauch kosten limit budget",
    description:
      "Liefert Limit und Stand (Monatsbudget bzw. Tagesbudget) sowie den Verbrauch ueber Organisationsschluessel je Mitglied " +
      "und Tag (Admins: alle Mitglieder; Mitglieder: nur eigener). Betraege in US-Cent (Schaetzung aus der Preistabelle).",
    parameters: { type: "object", properties: { tage: { type: "number", description: "Zeitraum in Tagen (1–90, Standard 30)" } } },
    schema: yup.object({ tage: yup.number().integer().min(1).max(90).optional() }).noUnknown(true),
    preview: (r: { monthCents?: number }) => `Verbrauch diesen Monat: ${((r.monthCents ?? 0) / 100).toFixed(2)} USD`,
    run: async (args) => {
      const q = await deps.gateway.request<{ quota: unknown; stand: unknown }>("/v1/tenants/me/quota", { method: "GET" });
      const u = await deps.gateway.request<{ rows: unknown[]; monthCents: number; todayCents: number; adminView: boolean }>(
        `/v1/tenants/me/usage?days=${args.tage ?? 30}`,
        { method: "GET" },
      );
      return { limit: q.quota, stand: q.stand, monthCents: u.monthCents, todayCents: u.todayCents, adminView: u.adminView, jeTag: u.rows };
    },
  });

  // O9 — Radar-Firmen mit der Organisation teilen.
  const radarShare = defineTool({
    name: "radar_share",
    summary: "Radar-Firmen (discoveryIds) mit allen Mitgliedern der Organisation teilen.",
    category: "radar firmen teilen organisation empfehlen kollegen",
    description:
      "Teilt Radar-Kandidaten mit der Organisation: sie erscheinen bei allen Mitgliedern oben im Radar unter 'Von der Organisation " +
      "geteilt', unabhaengig vom ICP, mit optionaler Notiz. discoveryIds aus discovery_candidates. Fragt vor der Ausfuehrung nach.",
    parameters: {
      type: "object",
      required: ["discoveryIds"],
      properties: {
        discoveryIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        notiz: { type: "string", description: "Optionale Notiz fuer die Mitglieder (max. 500 Zeichen)" },
      },
    },
    schema: yup
      .object({ discoveryIds: yup.array().of(yup.string().trim().min(1).required()).min(1).max(200).required(), notiz: yup.string().trim().max(500).optional() })
      .noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean; geteilt?: number }) => (r.abgebrochen ? "abgebrochen" : `${r.geteilt ?? 0} Firmen geteilt`),
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `${args.discoveryIds.length} Radar-Firma${args.discoveryIds.length === 1 ? "" : "n"} mit allen Mitgliedern der Organisation teilen?${args.notiz ? ` Notiz: „${args.notiz}"` : ""}`,
          confirmValue: "ja",
          options: [
            { value: "ja", label: "Teilen" },
            { value: "nein", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { ok: false, abgebrochen: true };
      const r = await deps.gateway.request<{ geteilt: number; unbekannt: string[] }>("/v1/tenants/me/shares/radar", {
        method: "POST",
        body: { discoveryIds: args.discoveryIds, ...(args.notiz ? { note: args.notiz } : {}) },
      });
      return { ok: true, ...r };
    },
  });

  // ---- B2 — Sammelabrechnung (docs/PLAN_ABRECHNUNG_SEATS.md) ----------------

  const eur = (cents: number) => `${(cents / 100).toFixed(2).replace(".", ",")} EUR`;
  const ladeBilling = () => deps.gateway.request<OrgBillingState>("/v1/tenants/me/billing", { method: "GET" });

  const billingInfo = defineTool({
    name: "org_billing_info",
    summary: "Sammelabrechnung der Organisation: Zustand, Tier, Seats im laufenden Monat, Prognose, Datensaetze (Admin).",
    category: "organisation abrechnung rechnung seats lizenzen sammelabrechnung kosten",
    description:
      "Liefert fuer Admins/Owner die Sammelabrechnung der Organisation: Modus (none = jedes Mitglied zahlt selbst, " +
      "seats = Sammelabrechnung, enterprise = Vertrag), Organisations-Tier, Zahlungsstatus, Seats im laufenden Monat " +
      "(Regel: eine Person zaehlt, wenn sie an mindestens einem Tagesstichtag 00:00 UTC Mitglied war — voller Monat, " +
      "keine anteilige Berechnung), Prognose in EUR netto, vorgemerkte Aenderungen und die bisherigen Monatsdatensaetze. " +
      "Read-only. Mitglieder ohne Admin-Rolle sehen ihren Seat unter Einstellungen → Plan.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: (r: { mode?: string; seatTier?: string | null; hinweis?: string }) =>
      r.hinweis ?? (r.mode === "seats" ? `Sammelabrechnung ${r.seatTier ?? ""}` : "keine Sammelabrechnung"),
    run: async () => {
      const st = await lade();
      if (st.kind !== "organisation") return { hinweis: "Du bist in keiner Organisation.", mode: "none" };
      if (!istAdmin(st)) return { hinweis: "Nur Admins sehen die Abrechnung. Deinen eigenen Seat zeigt Einstellungen → Plan.", mode: "unbekannt" };
      const b = await ladeBilling();
      return {
        organisation: b.tenantName,
        mode: b.mode,
        status: b.status,
        seatTier: b.seatTier,
        seit: b.since,
        endetAm: b.endsAt,
        tierAb: b.tierNext ? { tier: b.tierNext, ab: b.tierNextFrom } : null,
        maxSeats: b.maxSeats,
        mitgliederJetzt: b.memberCount,
        preise: { starter: eur(b.prices.starter), pro: eur(b.prices.pro) },
        laufenderMonat: {
          periode: b.currentPeriod.periodKey,
          seatsBisher: b.currentPeriod.seatCount,
          positionen: b.currentPeriod.lines.map((l) => `${l.seats} x ${l.tier} = ${eur(l.amountCents)}`),
          prognoseNetto: eur(b.projectedCents),
        },
        datensaetze: b.invoices.map((i) => ({ periode: i.periodKey, seats: i.seatCount, netto: eur(i.subtotalCents), status: i.status })),
        seite: "#/organisation",
      };
    },
  });

  // v0.1.604 (Operator 2026-09-09): Sammelabrechnung aktivieren/beenden und
  // Tier wechseln sind NICHT per Chat moeglich — Preisstufen-Wechsel ohne
  // Zahlungsprozess darf kein Self-Service sein. Lesen (Info, Rechnungen) bleibt.

  const billingInvoices = defineTool({
    name: "org_billing_invoices",
    summary: "Abrechnungsdatensatz eines Monats mit Personen-Nachweis (Admin).",
    category: "organisation abrechnung rechnung nachweis seats monat export",
    description:
      "Liefert den Datensatz einer Periode (YYYY-MM): Positionen je Tier, Seats mit Name/E-Mail, Tier, erstem und letztem " +
      "Stichtag und Anzahl Stichtage, Pruefsumme. Ohne Periode: Liste aller Datensaetze. CSV-Export ueber die Seite " +
      "'Organisation' (#/organisation). Read-only, Admin.",
    parameters: { type: "object", properties: { periode: { type: "string", description: "YYYY-MM, z. B. 2026-09" } } },
    schema: yup.object({ periode: yup.string().matches(/^\d{4}-\d{2}$/).optional() }).noUnknown(true),
    preview: (r: { periode?: string; seats?: unknown[]; datensaetze?: unknown[] }) =>
      r.periode ? `Datensatz ${r.periode}: ${r.seats?.length ?? 0} Seats` : `${r.datensaetze?.length ?? 0} Datensaetze`,
    run: async (args) => {
      if (!args.periode) {
        const b = await ladeBilling();
        return { datensaetze: b.invoices.map((i) => ({ periode: i.periodKey, seats: i.seatCount, netto: eur(i.subtotalCents), status: i.status })) };
      }
      const inv = await deps.gateway.request<OrgBillingInvoice>(`/v1/tenants/me/billing/invoices/${args.periode}`, { method: "GET" });
      return {
        periode: inv.periodKey,
        status: inv.status,
        netto: eur(inv.subtotalCents),
        positionen: inv.lines.map((l) => ({ tier: l.tier, seats: l.seats, einzelpreis: eur(l.unitPriceCents), betrag: eur(l.amountCents) })),
        seats: (inv.seats ?? []).map((s) => ({ name: s.name, email: s.email, tier: s.tier, ersterStichtag: s.firstCountedDay, letzterStichtag: s.lastCountedDay, stichtage: s.countedDays })),
        pruefsumme: inv.computeHash,
      };
    },
  });

  return [info, members, approve, remove, featuresSet, providerSet, limitsSet, usage, radarShare, billingInfo, billingInvoices];
}
