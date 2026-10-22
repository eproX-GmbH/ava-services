// IPC „LinkedIn-Leads“ (docs/PLAN_LINKEDIN_LEADS.md L3/L4): Leads lesen, ignorieren,
// uebernehmen. Die Uebernahme ist der eine Schritt aus Lead → Firma im Bestand +
// Person als Kontakt mit Anlass; sie nutzt die vorhandenen Gateway-Routen (Suche,
// Firma ohne Register, Import per ID, Kontakt per LinkedIn-URL).

import { ipcMain } from "electron";
import type { AuditEventInput } from "../audit/audit-types";
import type { GatewayClient } from "../agent/gateway-client";

export interface LeadsIpcDeps {
  audit: (input: AuditEventInput) => void;
  gatewayClient: GatewayClient;
}

interface Lead {
  id: string;
  postUrl: string;
  postTitel: string | null;
  personName: string | null;
  profileUrl: string;
  headline: string | null;
  rolle: string | null;
  aktivitaet: string;
  reactionType: string | null;
  kommentar: string | null;
  firmaDomain: string | null;
  firmaName: string | null;
  companyId: string | null;
  konfidenz: number | null;
  status: string;
  grund: string | null;
  firmaOrt: string | null;
  firmaPlz: string | null;
  firmaBranche: string | null;
  firmaKurz: string | null;
  masterCompanyId: string | null;
  createdAt: string;
}

export function anlassText(lead: Lead): string {
  const datum = new Date(lead.createdAt).toLocaleDateString("de-DE");
  const was = lead.aktivitaet === "comment" ? "kommentiert" : "reagiert";
  const post = lead.postTitel ? `den LinkedIn-Post „${lead.postTitel}“` : "einen beobachteten LinkedIn-Post";
  const text = `Hat am ${datum} ${post} ${was}${lead.kommentar ? `: „${lead.kommentar}“` : ""}`;
  return text.length > 290 ? `${text.slice(0, 287)}…` : text;
}

export function registerLeadsIpc(deps: LeadsIpcDeps): void {
  const { audit, gatewayClient } = deps;
  const gw = <T>(pfad: string, opts?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }): Promise<T> =>
    gatewayClient.request<T>(pfad, opts ? { method: opts.method, body: opts.body } : undefined);

  ipcMain.handle("leads:list", (_e, q: { status?: string; postUrl?: string; nurKommentare?: boolean; seite?: number; groesse?: number }) => {
    const p = new URLSearchParams();
    if (q?.status) p.set("status", q.status);
    if (q?.postUrl) p.set("postUrl", q.postUrl);
    if (q?.nurKommentare) p.set("nurKommentare", "true");
    p.set("seite", String(q?.seite ?? 1));
    p.set("groesse", String(q?.groesse ?? 50));
    return gw<{ gesamt: number; items: Lead[] }>(`/v1/linkedin-leads?${p.toString()}`);
  });

  ipcMain.handle("leads:posts", () => gw<{ posts: unknown[] }>("/v1/linkedin-leads/posts"));

  ipcMain.handle("leads:ignorieren", async (_e, args: { id: string; grund?: string | null }) => {
    const r = await gw<Lead>(`/v1/linkedin-leads/${encodeURIComponent(args.id)}`, { method: "PATCH", body: { status: "ignoriert", ignoriertGrund: args.grund ?? null } });
    audit({ actorType: "user", actorId: null, category: "linkedin", action: "linkedin.lead.ignoriert", severity: "info", subjectType: "person", subjectId: null, summary: `LinkedIn-Lead ignoriert: ${r.personName ?? args.id}${args.grund ? ` (${args.grund})` : ""}`, metadata: { grund: args.grund ?? null } });
    return r;
  });

  ipcMain.handle("leads:zuruecknehmen", (_e, args: { id: string }) =>
    gw<Lead>(`/v1/linkedin-leads/${encodeURIComponent(args.id)}`, { method: "PATCH", body: { status: "offen", ignoriertGrund: null } }),
  );

  /** Uebernommener Lead ohne Kontakt (Kontaktanlage war gescheitert): nur die Person nachlegen. */
  ipcMain.handle("leads:kontaktNachholen", async (_e, args: { id: string }): Promise<{ ok: boolean; personId?: string | null; error?: string }> => {
    const lead = await gw<Lead>(`/v1/linkedin-leads/${encodeURIComponent(args.id)}`);
    if (!lead.companyId) return { ok: false, error: "Zu diesem Lead ist keine Firma hinterlegt." };
    if (!lead.personName || !/linkedin\.com\/in\//i.test(lead.profileUrl)) return { ok: false, error: "Name oder Profil-URL fehlt." };
    try {
      const k = await gw<{ personId: string; created: boolean }>(`/v1/companies/${encodeURIComponent(lead.companyId)}/contacts/linkedin-url`, {
        method: "POST",
        body: { fullName: lead.personName, linkedinUrl: lead.profileUrl, ...(lead.rolle ? { title: lead.rolle } : {}), evidenceUrl: lead.postUrl, beschreibung: anlassText(lead), source: "linkedin-lead" },
      });
      await gw(`/v1/linkedin-leads/${encodeURIComponent(args.id)}`, { method: "PATCH", body: { personId: k.personId } });
      return { ok: true, personId: k.personId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  });

  /** Lead → Firma im Bestand + Person als Kontakt mit Anlass (ein Schritt). */
  ipcMain.handle("leads:uebernehmen", async (_e, args: { id: string }): Promise<{ ok: boolean; companyId?: string; personId?: string | null; transactionId?: string | null; hinweise: string[]; error?: string }> => {
    const hinweise: string[] = [];
    const lead = await gw<Lead>(`/v1/linkedin-leads/${encodeURIComponent(args.id)}`);
    if (lead.status === "uebernommen") return { ok: false, hinweise, error: "Dieser Lead ist bereits übernommen." };

    // 1. Firma bestimmen: bekannt → Register-Suche nach Name und Ort → ohne Register per Website.
    let companyId = lead.companyId ?? lead.masterCompanyId ?? null;
    if (!companyId && lead.firmaName) {
      try {
        const r = await gw<{ items: Array<{ companyId: string; name: string; location?: string | null }> }>(`/v1/companies/search?q=${encodeURIComponent(lead.firmaName)}&limit=5`);
        const ort = (lead.firmaOrt ?? "").toLowerCase();
        const treffer = ort ? r.items.find((i) => (i.location ?? "").toLowerCase().includes(ort)) : r.items.length === 1 ? r.items[0] : undefined;
        if (treffer) {
          companyId = treffer.companyId;
          hinweise.push(`Register-Firma ${treffer.name}${treffer.location ? ` (${treffer.location})` : ""} zugeordnet.`);
        }
      } catch {
        /* Suche nicht entscheidend */
      }
    }
    if (!companyId && lead.firmaDomain) {
      if (!lead.firmaOrt) return { ok: false, hinweise, error: "Für diese Firma fehlt noch der Ort (das Mini-Profil ist noch nicht fertig). Bitte in ein paar Minuten erneut versuchen." };
      const w = await gw<{ companyId: string; domain: string; neu: boolean; konflikt?: Array<{ companyId: string; name: string | null }> }>("/v1/companies/web", {
        method: "POST",
        body: { name: lead.firmaName ?? lead.firmaDomain, website: lead.firmaDomain, ort: lead.firmaOrt, ...(lead.firmaPlz ? { plz: lead.firmaPlz } : {}) },
      });
      companyId = w.konflikt?.[0]?.companyId ?? w.companyId;
      hinweise.push(w.konflikt?.length ? `Website gehört zur Register-Firma ${w.konflikt[0]!.name ?? w.konflikt[0]!.companyId}.` : w.neu ? "Firma ohne Registereintrag über ihre Website angelegt." : "Firma war bereits angelegt.");
    }
    if (!companyId) return { ok: false, hinweise, error: "Keine Firma zu diesem Lead bekannt." };

    // 2. In den Bestand aufnehmen und verarbeiten (bereits vorhandene Firmen bleiben, Verarbeitung wird aufgefrischt).
    let transactionId: string | null = null;
    try {
      const imp = await gw<{ transactionId: string }>("/v1/imports/by-ids", { method: "POST", body: { companyIds: [companyId], transactionName: `LinkedIn-Lead: ${lead.personName ?? lead.firmaName ?? companyId}` } });
      transactionId = imp.transactionId;
    } catch (err) {
      hinweise.push(`Verarbeitung nicht gestartet: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }

    // 3. Person als Kontakt mit Anlass. Braucht eine Profil-URL der Form /in/…
    let personId: string | null = null;
    if (lead.personName && /linkedin\.com\/in\//i.test(lead.profileUrl)) {
      try {
        const k = await gw<{ personId: string; created: boolean }>(`/v1/companies/${encodeURIComponent(companyId)}/contacts/linkedin-url`, {
          method: "POST",
          body: { fullName: lead.personName, linkedinUrl: lead.profileUrl, ...(lead.rolle ? { title: lead.rolle } : {}), evidenceUrl: lead.postUrl, beschreibung: anlassText(lead), source: "linkedin-lead" },
        });
        personId = k.personId;
        hinweise.push(k.created ? "Person als Kontakt angelegt." : "Person war als Kontakt bekannt, Anlass ergänzt.");
      } catch (err) {
        hinweise.push(`Kontakt nicht angelegt: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      }
    } else {
      hinweise.push("Kein Kontakt angelegt: Name oder Profil-URL fehlt.");
    }

    await gw(`/v1/linkedin-leads/${encodeURIComponent(args.id)}`, { method: "PATCH", body: { status: "uebernommen", companyId, personId } });
    audit({ actorType: "user", actorId: null, category: "linkedin", action: "linkedin.lead.uebernommen", severity: "info", subjectType: "company", subjectId: companyId, summary: `LinkedIn-Lead übernommen: ${lead.personName ?? "?"} → ${lead.firmaName ?? companyId}`, metadata: { leadId: args.id, personId, transactionId } });
    return { ok: true, companyId, personId, transactionId, hinweise };
  });
}
