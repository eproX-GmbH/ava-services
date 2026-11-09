// LinkedIn-Leads: Uebernahme und Kontakt-Nachlegen als reine Gateway-Logik
// (docs/PLAN_LINKEDIN_LEADS.md L4/L5), genutzt vom IPC der Oberflaeche und von
// den Chat-Werkzeugen. Keine Electron-Abhaengigkeit.

import type { GatewayClient } from "../agent/gateway-client";
import type { LinkedInLead } from "../../shared/types";
import { ortAusImpressum } from "../discovery/ort-impressum";
import { kernWoerter, namensVerwandt, ortPasst, registerTreffer, stufenHinweis } from "../discovery/namensabgleich";

type Gw = <T>(pfad: string, opts?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }) => Promise<T>;

export function gwVon(client: GatewayClient): Gw {
  return <T>(pfad: string, opts?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }) =>
    client.request<T>(pfad, opts ? { method: opts.method, body: opts.body } : undefined);
}

export function anlassText(lead: Pick<LinkedInLead, "createdAt" | "aktivitaet" | "postTitel" | "kommentar">): string {
  const datum = new Date(lead.createdAt).toLocaleDateString("de-DE");
  const was = lead.aktivitaet === "comment" ? "kommentiert" : "reagiert";
  const post = lead.postTitel ? `den LinkedIn-Post „${lead.postTitel}“` : "einen beobachteten LinkedIn-Post";
  const text = `Hat am ${datum} ${post} ${was}${lead.kommentar ? `: „${lead.kommentar}“` : ""}`;
  return text.length > 290 ? `${text.slice(0, 287)}…` : text;
}

export async function leadLesen(gw: Gw, id: string): Promise<LinkedInLead> {
  return gw<LinkedInLead>(`/v1/linkedin-leads/${encodeURIComponent(id)}`);
}

export interface UebernahmeErgebnis {
  ok: boolean;
  companyId?: string;
  personId?: string | null;
  transactionId?: string | null;
  hinweise: string[];
  error?: string;
  /** Firma hat keinen bekannten Sitz: Aufrufer kann den Ort nachliefern (opts.ort). */
  ortFehlt?: boolean;
  /** Mehrere Register-Firmen passen zum Namen: Aufrufer waehlt eine (opts.companyId). PM-2026-0007 */
  auswahlNoetig?: boolean;
  kandidaten?: FirmenKandidat[];
}

export interface FirmenKandidat {
  companyId: string;
  name: string;
  location: string | null;
  registerStatus: string | null;
}

/** Person des Leads als Kontakt an der Firma anlegen (LinkedIn-URL, Rolle, Anlass). */
export async function kontaktAnlegen(gw: Gw, lead: LinkedInLead, companyId: string): Promise<{ personId: string; created: boolean }> {
  if (!lead.personName || !/linkedin\.com\/in\//i.test(lead.profileUrl)) throw new Error("Name oder Profil-URL fehlt.");
  return gw<{ personId: string; created: boolean }>(`/v1/companies/${encodeURIComponent(companyId)}/contacts/linkedin-url`, {
    method: "POST",
    body: { fullName: lead.personName, linkedinUrl: lead.profileUrl, ...(lead.rolle ? { title: lead.rolle } : {}), evidenceUrl: lead.postUrl, beschreibung: anlassText(lead), source: "linkedin-lead" },
  });
}

/** Lead → Firma im Bestand + Person als Kontakt mit Anlass (ein Schritt). */
export async function leadUebernehmen(gw: Gw, id: string, opts: { ort?: string | null; companyId?: string | null } = {}): Promise<UebernahmeErgebnis> {
  const hinweise: string[] = [];
  const lead = await leadLesen(gw, id);
  if (lead.status === "uebernommen") return { ok: false, hinweise, error: "Dieser Lead ist bereits übernommen." };

  // 1. Firma bestimmen: gewaehlt/bekannt → Register-Suche nach Name und Ort → Auswahl → ohne Register per Website.
  let companyId = opts.companyId?.trim() || lead.companyId || lead.masterCompanyId || null;
  // Sitz: Nutzerangabe → Mini-Profil → Impressum direkt lesen.
  let firmaOrt = opts.ort?.trim() || lead.firmaOrt || null;
  let firmaPlz = opts.ort?.trim() ? null : lead.firmaPlz;
  if (!companyId && !firmaOrt && lead.firmaDomain) {
    const imp = await ortAusImpressum(lead.firmaDomain);
    if (imp) {
      firmaOrt = imp.ort;
      firmaPlz = imp.plz;
      hinweise.push(`Sitz ${imp.plz} ${imp.ort} laut Impressum.`);
    }
  }
  let kandidaten: FirmenKandidat[] = [];
  if (!companyId && lead.firmaName) {
    try {
      const r = await gw<{ items: Array<{ companyId: string; name: string; location?: string | null; registerStatus?: string | null }> }>(`/v1/companies/search?q=${encodeURIComponent(lead.firmaName)}&limit=10`);
      // Nur Kandidaten mit passendem Namen; die Suche ist unscharf und liefert sonst
      // auch Firmen, die nur im Ort oder in „GmbH“ uebereinstimmen (2026-11-09).
      const gesucht = kernWoerter(lead.firmaName);
      kandidaten = (r.items ?? [])
        .map((i) => ({ companyId: i.companyId, name: i.name, location: i.location ?? null, registerStatus: i.registerStatus ?? null }))
        .filter((k) => namensVerwandt(gesucht, kernWoerter(k.name)));
      // Stufe 1 exakt (Name + Ort), dann gleicher Kernname, dann aehnlicher Name, jeweils am Ort.
      const exakt = firmaOrt ? kandidaten.filter((k) => k.name.trim().toLowerCase() === lead.firmaName!.trim().toLowerCase() && ortPasst(k.location, firmaOrt)) : [];
      if (exakt.length === 1) {
        companyId = exakt[0]!.companyId;
        hinweise.push(`Register-Firma ${exakt[0]!.name}${exakt[0]!.location ? ` (${exakt[0]!.location})` : ""} zugeordnet.`);
      } else if (firmaOrt) {
        const t = registerTreffer({ name: lead.firmaName, ort: firmaOrt }, kandidaten);
        if (t.kandidat) {
          companyId = t.kandidat.companyId;
          hinweise.push(stufenHinweis(lead.firmaName, t.kandidat, t.stufe));
        }
      }
    } catch {
      /* Suche nicht entscheidend */
    }
  }
  // PM-2026-0007: Mehrere Register-Firmen zum Namen und kein Ort, der entscheidet —
  // die Kandidaten zur Auswahl geben statt nach einem unbekannten Ort zu fragen.
  // Mit Ort aus dem Mini-Profil, der keinen Treffer ergibt, ebenfalls, solange kein
  // Website-Weg offen ist und der Nutzer den Ort nicht selbst genannt hat.
  // Seit 2026-11-09 auch bei nur EINEM Namensverwandten ohne passenden Ort: bestaetigen lassen statt blind nehmen.
  if (!companyId && kandidaten.length > 0 && (!firmaOrt || (!lead.firmaDomain && !opts.ort?.trim()))) {
    return { ok: false, auswahlNoetig: true, kandidaten, hinweise, error: kandidaten.length > 1 ? `Mehrere Firmen heißen ähnlich wie „${lead.firmaName}“. Bitte die richtige auswählen.` : `Im Register gibt es eine ähnlich benannte Firma zu „${lead.firmaName}“. Bitte bestätigen, ob sie gemeint ist.` };
  }
  if (!companyId && lead.firmaName && kandidaten.length === 0) hinweise.push(`Keine Register-Firma namens „${lead.firmaName}“ gefunden.`);
  if (!companyId && lead.firmaDomain) {
    if (!firmaOrt) return { ok: false, ortFehlt: true, hinweise, error: `${kandidaten.length === 0 && lead.firmaName ? `Keine Register-Firma namens „${lead.firmaName}“ gefunden. ` : ""}Der Sitz der Firma ist nicht bekannt (weder im Mini-Profil noch im Impressum). Bitte den Ort angeben, dann wird die Firma über ihre Website angelegt.` };
    const w = await gw<{ companyId: string; domain: string; neu: boolean; konflikt?: Array<{ companyId: string; name: string | null }> }>("/v1/companies/web", {
      method: "POST",
      body: { name: lead.firmaName ?? lead.firmaDomain, website: lead.firmaDomain, ort: firmaOrt, ...(firmaPlz ? { plz: firmaPlz } : {}) },
    });
    companyId = w.konflikt?.[0]?.companyId ?? w.companyId;
    hinweise.push(w.konflikt?.length ? `Website gehört zur Register-Firma ${w.konflikt[0]!.name ?? w.konflikt[0]!.companyId}.` : w.neu ? "Firma ohne Registereintrag über ihre Website angelegt." : "Firma war bereits angelegt.");
  }
  if (!companyId) return { ok: false, hinweise, error: lead.firmaName ? `Keine passende Firma zu „${lead.firmaName}“ gefunden und keine Website bekannt.` : "Keine Firma zu diesem Lead bekannt." };

  // 2. In den Bestand aufnehmen und verarbeiten.
  let transactionId: string | null = null;
  try {
    const imp = await gw<{ transactionId: string }>("/v1/imports/by-ids", { method: "POST", body: { companyIds: [companyId], transactionName: `LinkedIn-Lead: ${lead.personName ?? lead.firmaName ?? companyId}` } });
    transactionId = imp.transactionId;
  } catch (err) {
    hinweise.push(`Verarbeitung nicht gestartet: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
  }

  // 3. Person als Kontakt mit Anlass.
  let personId: string | null = null;
  try {
    const k = await kontaktAnlegen(gw, lead, companyId);
    personId = k.personId;
    hinweise.push(k.created ? "Person als Kontakt angelegt." : "Person war als Kontakt bekannt, Anlass ergänzt.");
  } catch (err) {
    hinweise.push(`Kontakt nicht angelegt: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
  }

  await gw(`/v1/linkedin-leads/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "uebernommen", companyId, personId } });
  return { ok: true, companyId, personId, transactionId, hinweise };
}

export async function kontaktNachholen(gw: Gw, id: string): Promise<{ ok: boolean; personId?: string | null; error?: string }> {
  const lead = await leadLesen(gw, id);
  if (!lead.companyId) return { ok: false, error: "Zu diesem Lead ist keine Firma hinterlegt." };
  try {
    const k = await kontaktAnlegen(gw, lead, lead.companyId);
    await gw(`/v1/linkedin-leads/${encodeURIComponent(id)}`, { method: "PATCH", body: { personId: k.personId } });
    return { ok: true, personId: k.personId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

// 2026-10-31 (Feedback Patrick): Uebernahmen bis Gateway-Fix hinterliessen Leads ohne
// Person (Kontaktanlage 500). Beim naechsten Listen eigene uebernommene Leads ohne
// Person einmal je Sitzung still nachholen, statt neun Klicks auf „Kontakt nachholen“.
const nachgeholt = new Set<string>();

export async function fehlendeKontakteNachholen(gw: Gw, items: LinkedInLead[]): Promise<LinkedInLead[]> {
  const offen = items.filter((l) => l.status === "uebernommen" && !l.personId && l.companyId && !nachgeholt.has(l.id));
  if (offen.length === 0) return items;
  const ergebnis = new Map<string, string>();
  for (const l of offen.slice(0, 20)) {
    nachgeholt.add(l.id);
    const r = await kontaktNachholen(gw, l.id);
    if (r.ok && r.personId) ergebnis.set(l.id, r.personId);
    else console.warn(`[leads] Kontakt zu Lead ${l.id} (${l.personName ?? "?"}) nicht nachgeholt: ${r.error ?? "unbekannt"}`);
  }
  return items.map((l) => (ergebnis.has(l.id) ? { ...l, personId: ergebnis.get(l.id)! } : l));
}

export async function leadIgnorieren(gw: Gw, id: string, grund: string | null): Promise<LinkedInLead> {
  return gw<LinkedInLead>(`/v1/linkedin-leads/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "ignoriert", ignoriertGrund: grund } });
}

export async function leadZuruecknehmen(gw: Gw, id: string): Promise<LinkedInLead> {
  return gw<LinkedInLead>(`/v1/linkedin-leads/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "offen", ignoriertGrund: null } });
}

export async function leadsListe(gw: Gw, q: { status?: string; postUrl?: string; nurKommentare?: boolean; alle?: boolean; seite?: number; groesse?: number }): Promise<{ gesamt: number; items: LinkedInLead[] }> {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.alle) p.set("alle", "true");
  if (q.postUrl) p.set("postUrl", q.postUrl);
  if (q.nurKommentare) p.set("nurKommentare", "true");
  p.set("seite", String(q.seite ?? 1));
  p.set("groesse", String(q.groesse ?? 50));
  const r = await gw<{ gesamt: number; items: LinkedInLead[] }>(`/v1/linkedin-leads?${p.toString()}`);
  // Nur eigene Leads (ohne alle=true): Nachholen schreibt am Lead, das bleibt beim Besitzer.
  return q.alle ? r : { ...r, items: await fehlendeKontakteNachholen(gw, r.items ?? []) };
}
