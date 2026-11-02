// Z5/Z7 (docs/PLAN_ABRECHNUNG_ZUGANG.md): Abrechnungsstand im Chat — Plan,
// Aufnahmen nach Stufe, voraussichtliche Kosten, Ausgabenlimit (lesen und
// setzen). Plan-Wechsel laufen ueber Einstellungen → Plan & Abrechnung.
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

interface Usage {
  tier: string;
  used: number;
  limit: number;
  remaining: number;
  periodKey: string;
  periodEnd: string | null;
  status: string;
  parkedCount: number;
  entitlement?: { source?: string; paidBy?: string | null; role?: string | null; seats?: { count?: number; tier?: string } | null };
  /** docs/PLAN_PRICING_TIERS.md P2 — Kontingent je Nutzer im Sitz-Modell (null, solange der Schalter aus ist). */
  kontingent?: {
    plan: string; kontingentCents: number | null; anteilig: boolean; verbrauchtCents: number; uebrigCents: number | null; neuverarbeitungCents: number;
    stufen: { klein: number; mittel: number; gross: number; offen: number };
    payg: { moeglich: boolean; freigegeben: boolean; limitCents: number | null; ueberCents: number };
    enterprise: { firmenLimit: number | null; firmenImBestand: number } | null;
  } | null;
  kannSelbstWechseln?: boolean;
  zugang?: {
    stufen: { klein: number; mittel: number; gross: number; offen: number };
    verbrauchtCents: number;
    guthabenCents: number;
    uebrigCents: number;
    ueberschreitungCents: number;
    ausgabenLimitCents?: number | null;
    limitQuelle?: "kunde" | "betreiber" | null;
    erwartetCents?: number;
  };
}

const STUFEN_TEXT = "Stufen je Firma im Bestand und Monat: klein 0,50 € (kein LinkedIn-Firmenprofil), mittel 1,00 € (LinkedIn-Profil, unter 50 Personen), gross 1,50 € (50 oder mehr Personen). Gezaehlt wird jede Firma, die im Abrechnungsmonat in Meine Firmen steht (Monat der Aufnahme und jeder Monat, an dessen Ende sie noch im Bestand ist), einmal je Organisation; Entfernen wirkt ab dem Folgemonat. Aufbereitung, Auffrischung, Alarme und Waechter sind enthalten. Die Stufe steht nach dem Lauf fest.";
const eur = (cents: number) => Math.round(cents) / 100;

export function buildAbrechnungTools(deps: { gateway: GatewayClient }): Tool[] {
  const status = defineTool({
    name: "abrechnung_status",
    summary: "Plan, Firmen im Bestand dieser Periode nach Stufe (klein/mittel/gross), voraussichtliche Kosten und Ausgabenlimit lesen.",
    category: "abrechnung plan kosten ausgabenlimit kontingent preise stufe abo free pro",
    description:
      "Liest den Abrechnungsstand des Nutzers: Plan (free/pro/enterprise), Aufnahmen der Periode nach Stufe, voraussichtliche Kosten " +
      "(zugeordnete Aufnahmen zum Stufenpreis plus offene), Ausgabenlimit je Monat und wer zahlt (eigenes Abo oder Seat der Organisation). " +
      STUFEN_TEXT + " Pro: 49 € je Nutzer und Monat plus Stufenpreis je aufgenommener Firma, kein fester Deckel (nur eine hohe Notbremse). " +
      "Free: 25 Firmen lebenslang ohne LinkedIn-Kontakte. Nur lesend; Upgrade oder Kuendigung laufen ueber Einstellungen → Plan & Abrechnung.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r) => {
      const u = r as { tier?: string; aufnahmen?: number; error?: string };
      return u.error ? `Fehler: ${u.error.slice(0, 60)}` : `${u.tier ?? "?"}: ${u.aufnahmen ?? 0} Aufnahmen in dieser Periode`;
    },
    run: async (_args, c) => {
      const u = await deps.gateway.request<Usage>("/v1/usage", { signal: c.signal });
      // P6 — Sitz-Modell: Plan je Nutzer mit Monatskontingent in Euro.
      if (u.kontingent) {
        const k = u.kontingent;
        const planName: Record<string, string> = { free: "Free", pro: "Pro", max: "Max", ultra: "Ultra", enterprise: "Enterprise" };
        const firmen = k.stufen.klein + k.stufen.mittel + k.stufen.gross + k.stufen.offen;
        return {
          plan: planName[k.plan] ?? k.plan,
          status: u.status,
          periodenEnde: u.periodEnd,
          kontingent: k.plan === "enterprise"
            ? { art: "Vertrag", firmenImBestand: k.enterprise?.firmenImBestand ?? firmen, firmenLimit: k.enterprise?.firmenLimit ?? null }
            : k.plan === "free"
              ? { art: "Free", firmenGenutzt: u.used, firmenGesamt: u.limit }
              : { art: "Monatskontingent", kontingentEur: eur(k.kontingentCents ?? 0), anteilig: k.anteilig, verbrauchtEur: eur(k.verbrauchtCents), uebrigEur: eur(k.uebrigCents ?? 0), neuverarbeitungenEur: eur(k.neuverarbeitungCents), firmenImBestand: firmen, stufen: k.stufen },
          ueberDasKontingentHinaus: k.payg.moeglich ? { freigegeben: k.payg.freigegeben, deckelEur: k.payg.limitCents == null ? null : eur(k.payg.limitCents), bisherEur: eur(k.payg.ueberCents) } : null,
          kannPlanSelbstWechseln: u.kannSelbstWechseln !== false,
          preiseJeFirmaUndMonat: { klein: 0.5, mittel: 1.0, gross: 1.5 },
          hinweis:
            k.plan === "free"
              ? "Free: 25 Firmen insgesamt, hoechstens 3 Free-Mitglieder je Organisation. Mehr mit einem Sitz (Pro 49 €, Max 149 €, Ultra 299 € je Nutzer und Monat = Monatskontingent)."
              : k.plan === "enterprise"
                ? "Enterprise: Abrechnung laut Vertrag mit AVA."
                : u.kannSelbstWechseln === false
                  ? "Den Plan weist die Organisation zu (Owner/Admin in der Konsole). Einen groesseren Plan kann der Nutzer in Einstellungen → Plan & Abrechnung anfragen."
                  : "Plan aendern in Einstellungen → Plan & Abrechnung oder mit plan_wechseln: Upgrade sofort (anteilig berechnet), Downgrade zum Zyklusende.",
        };
      }
      const z = u.zugang;
      const aufnahmen = z ? z.stufen.klein + z.stufen.mittel + z.stufen.gross + z.stufen.offen : u.used;
      const limit = z?.ausgabenLimitCents ?? null;
      const erwartet = z ? (z.erwartetCents ?? z.verbrauchtCents) : 0;
      return {
        tier: u.tier,
        status: u.status,
        periode: u.periodKey === "lifetime" ? "lebenslang (Free)" : u.periodKey === "unlimited" ? "unbegrenzt" : u.periodKey,
        periodenEnde: u.periodEnd,
        notbremse: u.limit === -1 ? { verbraucht: u.used, deckel: "unbegrenzt" } : { verbraucht: u.used, deckel: u.limit, frei: u.remaining },
        geparkt: u.parkedCount,
        bezahltVon: u.entitlement?.source === "seat" ? `Organisation${u.entitlement.paidBy ? ` (${u.entitlement.paidBy})` : ""}` : u.entitlement?.source === "enterprise" ? "Enterprise-Vertrag" : "eigenes Konto",
        aufnahmen,
        stufen: z?.stufen ?? null,
        kosten: z && u.tier !== "free"
          ? { zugeordnetEur: eur(z.verbrauchtCents), voraussichtlichEur: eur(erwartet), enthaltenEur: z.guthabenCents > 0 ? eur(Math.min(z.verbrauchtCents, z.guthabenCents)) : 0 }
          : null,
        ausgabenlimit: u.tier === "free" ? null : limit == null ? { gesetzt: false } : { gesetzt: true, limitEur: eur(limit), erreicht: erwartet >= limit },
        preiseJeStufe: { klein: 0.5, mittel: 1.0, gross: 1.5 },
        hinweis:
          u.tier === "free"
            ? "Free: 25 Firmen lebenslang, Kontakte nur von der Website (kein LinkedIn). Mehr Firmen und LinkedIn-Kontakte mit Pro (49 € je Nutzer und Monat plus 0,50 bis 1,50 € je Firma im Bestand und Monat)."
            : limit != null && erwartet >= limit
              ? z?.limitQuelle === "betreiber"
                ? "Das mit AVA vereinbarte Monatslimit fuer die Hintergrundverarbeitung ist erreicht: neue Firmen werden ab dem naechsten Monat aufgenommen; fuer mehr Volumen an AVA wenden."
                : "Das Ausgabenlimit ist erreicht: neue Firmen warten, bis das Limit erhoeht wird (abrechnung_limit_setzen) oder der Monat wechselt."
              : "Jede Firma im Bestand wird je Monat zum Stufensatz berechnet; wer nicht mehr zahlen will, entfernt die Firma aus Meine Firmen (wirkt ab dem Folgemonat). Ein Ausgabenlimit je Monat laesst sich mit abrechnung_limit_setzen setzen.",
      };
    },
  });

  const limitSetzen = defineTool({
    name: "abrechnung_limit_setzen",
    summary: "Monatliches Ausgabenlimit fuer Aufnahmen setzen oder aufheben (Euro, leer = kein Limit).",
    category: "abrechnung ausgabenlimit limit budget kosten deckel",
    description:
      "Setzt das Ausgabenlimit je Monat fuer Aufnahmen (in Euro) oder hebt es auf (limitEur = null). Ist das Limit erreicht, warten neue Firmen bis zum " +
      "naechsten Monat oder bis das Limit erhoeht wird. Bei Sammelabrechnung darf nur Owner oder Admin der Organisation das Limit setzen. " +
      "Fragt vor dem Setzen nach Bestaetigung. Nicht im Free-Plan.",
    parameters: {
      type: "object",
      properties: { limitEur: { type: ["number", "null"], description: "Limit in Euro je Monat, null = kein Limit" } },
      required: ["limitEur"],
    },
    schema: yup.object({ limitEur: yup.number().min(0).max(1_000_000).nullable().defined() }).noUnknown(true),
    preview: (r) => {
      const u = r as { limitEur?: number | null; abgebrochen?: boolean; error?: string };
      return u.error ? `Fehler: ${u.error.slice(0, 60)}` : u.abgebrochen ? "abgebrochen" : u.limitEur == null ? "Ausgabenlimit aufgehoben" : `Ausgabenlimit ${u.limitEur} €`;
    },
    run: async (args, c) => {
      const u = await deps.gateway.request<Usage>("/v1/usage", { signal: c.signal });
      if (u.tier === "free") return { error: "Im Free-Plan gibt es kein Ausgabenlimit (25 Firmen lebenslang)." };
      if (u.zugang?.limitQuelle === "betreiber") return { error: "Das Monatslimit ist im Vertrag mit AVA festgelegt und laesst sich hier nicht aendern." };
      if (u.entitlement?.source === "seat" && u.entitlement.role !== "owner" && u.entitlement.role !== "admin") {
        return { error: "Das Ausgabenlimit deiner Organisation setzt nur der Owner oder ein Admin." };
      }
      const alt = u.zugang?.ausgabenLimitCents ?? null;
      const neu = args.limitEur == null ? null : Math.round(args.limitEur * 100);
      const text = neu == null ? "Ausgabenlimit aufheben?" : `Ausgabenlimit auf ${(neu / 100).toFixed(2)} € je Monat setzen?`;
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            `${text}\n\n` +
            `Bisher: ${alt == null ? "kein Limit" : `${(alt / 100).toFixed(2)} €`}. ` +
            (u.entitlement?.source === "seat" ? "Das Limit gilt fuer die ganze Organisation. " : "") +
            "Ist es erreicht, warten neue Firmen bis zum naechsten Monat oder bis du es erhoehst.",
          confirmValue: "setzen",
          options: [{ value: "setzen", label: neu == null ? "Aufheben" : "Setzen" }, { value: "cancel", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "setzen") return { abgebrochen: true };
      const r = await deps.gateway.request<{ ausgabenLimitCents: number | null }>("/v1/usage/ausgabenlimit", { method: "PUT", body: { ausgabenLimitCents: neu }, signal: c.signal });
      return { limitEur: r.ausgabenLimitCents == null ? null : eur(r.ausgabenLimitCents), vorherEur: alt == null ? null : eur(alt) };
    },
  });
  // docs/PLAN_PRICING_TIERS.md P4 — Monatslimit der LinkedIn-Beobachtung (nach Verbrauch).
  const linkedinLimit = defineTool({
    name: "linkedin_limit_setzen",
    summary: "Monatslimit fuer die LinkedIn-Beobachtung (beobachtete Posts, Watchlist, Leads) setzen oder aufheben.",
    category: "linkedin beobachtung limit kosten verbrauch deckel",
    description:
      "Die LinkedIn-Beobachtung wird nach Verbrauch berechnet. Setzt das Monatslimit in Euro (limitEur) fuer den Nutzer; ohne Limit laeuft keine Beobachtung. " +
      "Nur Owner oder Admin der Organisation duerfen es setzen (die Kosten landen auf der Rechnung der Organisation). Fragt vor dem Setzen nach Bestaetigung. " +
      "Liefert ohne limitEur den aktuellen Stand (Verbrauch im Monat je Funktion, Limit, Preise je 1.000).",
    parameters: {
      type: "object",
      properties: { limitEur: { type: ["number", "null"], description: "Limit in Euro je Monat; weglassen = nur Stand anzeigen; null = aufheben" } },
    },
    schema: yup.object({ limitEur: yup.number().min(0).max(10_000).nullable().optional() }).noUnknown(true),
    preview: (r) => {
      const u = r as { limitEur?: number | null; abgebrochen?: boolean; error?: string; verbrauchtEur?: number };
      return u.error ? `Fehler: ${u.error.slice(0, 60)}` : u.abgebrochen ? "abgebrochen" : u.limitEur === undefined ? `Verbrauch ${u.verbrauchtEur ?? 0} €` : u.limitEur == null ? "Limit aufgehoben" : `LinkedIn-Limit ${u.limitEur} €`;
    },
    run: async (args, c) => {
      type Stand = { limitCents: number | null; verbrauchtCents: number; geschaetztCents: number; jeFunktion: Record<string, number>; laeufe: number; enterprise: boolean; preise?: Array<{ einheit: string; centsJe1000: number }> };
      let stand: Stand;
      try {
        stand = await deps.gateway.request<Stand>("/v1/usage/linkedin", { signal: c.signal });
      } catch (err) {
        return { error: err instanceof Error && /404/.test(err.message) ? "Die Abrechnung nach Verbrauch ist noch nicht freigeschaltet." : String(err) };
      }
      if (args.limitEur === undefined) {
        return { limitEur: undefined, verbrauchtEur: eur(stand.verbrauchtCents), limitEurAktuell: stand.limitCents == null ? null : eur(stand.limitCents), jeFunktionEur: Object.fromEntries(Object.entries(stand.jeFunktion).map(([k, v]) => [k, eur(v)])), laeufe: stand.laeufe, preiseJe1000Eur: (stand.preise ?? []).map((p) => ({ einheit: p.einheit, eur: eur(p.centsJe1000) })) };
      }
      if (stand.enterprise) return { error: "Bei Enterprise legt AVA das Limit laut Vertrag fest." };
      const neu = args.limitEur == null ? null : Math.round(args.limitEur * 100);
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `${neu == null ? "Limit der LinkedIn-Beobachtung aufheben? Danach laeuft keine Beobachtung mehr." : `Limit der LinkedIn-Beobachtung auf ${(neu / 100).toFixed(2)} € je Monat setzen?`}\n\nBisher: ${stand.limitCents == null ? "kein Limit" : `${(stand.limitCents / 100).toFixed(2)} €`}, verbraucht diesen Monat ${(stand.verbrauchtCents / 100).toFixed(2)} €.`,
          confirmValue: "setzen",
          options: [{ value: "setzen", label: neu == null ? "Aufheben" : "Setzen" }, { value: "cancel", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "setzen") return { abgebrochen: true };
      const r = await deps.gateway.request<{ stand: Stand }>("/v1/usage/linkedin-limit", { method: "PUT", body: { limitCents: neu }, signal: c.signal });
      return { limitEur: r.stand.limitCents == null ? null : eur(r.stand.limitCents), verbrauchtEur: eur(r.stand.verbrauchtCents) };
    },
  });
  // P6 — eigener Plan (Sitz) wechseln: Owner/Admin fuer sich; Mitglieder fragen an.
  const planWechseln = defineTool({
    name: "plan_wechseln",
    summary: "Eigenen Plan wechseln (Pro/Max/Ultra/Free): Upgrade sofort, Downgrade zum Zyklusende; Mitglieder fragen an.",
    category: "plan wechseln upgrade downgrade abo kuendigen sitz",
    description:
      "Wechselt den Plan des Nutzers im Sitz-Modell. Upgrade wirkt sofort (freier Sitz der Organisation oder Kauf, anteilig berechnet), " +
      "Downgrade oder Free wird zum Zyklusende vorgemerkt. Nur Owner/Admin duerfen wechseln; ein Mitglied stellt mit demselben Werkzeug eine Anfrage an Owner/Admin. Fragt vorher nach.",
    parameters: { type: "object", required: ["plan"], properties: { plan: { type: "string", enum: ["free", "pro", "max", "ultra"] } } },
    schema: yup.object({ plan: yup.mixed<"free" | "pro" | "max" | "ultra">().oneOf(["free", "pro", "max", "ultra"]).required() }).noUnknown(true),
    preview: (r) => {
      const x = r as { abgebrochen?: boolean; error?: string; angefragt?: boolean; vorgemerkt?: boolean; plan?: string; checkoutUrl?: string };
      return x.error ? `Fehler: ${x.error.slice(0, 60)}` : x.abgebrochen ? "abgebrochen" : x.angefragt ? "Anfrage gesendet" : x.vorgemerkt ? `Wechsel zu ${x.plan} vorgemerkt` : x.checkoutUrl ? "Kasse geoeffnet" : `Plan ${x.plan}`;
    },
    run: async (args, c) => {
      const u = await deps.gateway.request<Usage>("/v1/usage", { signal: c.signal });
      if (!u.kontingent) return { error: "Der Planwechsel im Chat ist noch nicht freigeschaltet. In Einstellungen → Plan & Abrechnung nachsehen." };
      const aktuell = u.kontingent.plan;
      if (aktuell === "enterprise") return { error: "Enterprise-Vertraege aendert AVA." };
      if (aktuell === args.plan) return { error: `Du hast bereits den Plan ${args.plan}.` };
      const rang: Record<string, number> = { free: 0, pro: 1, max: 2, ultra: 3 };
      const hoch = rang[args.plan]! > (rang[aktuell] ?? 0);
      if (u.kannSelbstWechseln === false) {
        const v = await c.ui.confirmAction({ kind: "additive", prompt: `Owner und Admins deiner Organisation um den Plan ${args.plan} bitten?`, confirmValue: "ja", options: [{ value: "ja", label: "Anfragen" }, { value: "cancel", label: "Abbrechen" }] }, c.signal);
        if (v !== "ja") return { abgebrochen: true };
        await deps.gateway.request("/v1/billing/plan-anfrage", { method: "POST", body: { plan: args.plan }, signal: c.signal });
        return { angefragt: true, plan: args.plan };
      }
      type Sitze = { ich: string; zyklusende: string | null; stripe: boolean; jePlan: Record<string, { frei: number }> };
      const sz = await deps.gateway.request<Sitze>("/v1/tenants/me/sitze", { signal: c.signal });
      const bis = sz.zyklusende ? new Date(sz.zyklusende).toLocaleDateString("de-DE") : "zum Zyklusende";
      const text = hoch
        ? `Auf ${args.plan} wechseln? Dein Kontingent steigt sofort anteilig; ${sz.jePlan[args.plan]?.frei ? "ein freier Sitz eurer Organisation wird dir zugewiesen" : sz.stripe ? "ein neuer Sitz wird anteilig bis zum Zyklusende berechnet" : "der erste Sitz laeuft ueber die Kasse (Zahlungsmittel hinterlegen)"}.`
        : `Zum ${bis} auf ${args.plan} wechseln? Bis dahin bleibt dein Plan ${aktuell}; der Wechsel laesst sich bis zum Stichtag zuruecknehmen.`;
      const v = await c.ui.confirmAction({ kind: "additive", prompt: text, confirmValue: "ja", options: [{ value: "ja", label: hoch ? "Upgrade" : "Vormerken" }, { value: "cancel", label: "Abbrechen" }] }, c.signal);
      if (v !== "ja") return { abgebrochen: true };
      if (hoch) {
        if (sz.jePlan[args.plan]?.frei) {
          await deps.gateway.request(`/v1/tenants/me/mitglieder/${encodeURIComponent(sz.ich)}/sitz`, { method: "PUT", body: { plan: args.plan }, signal: c.signal });
          return { plan: args.plan, sofort: true };
        }
        const r = await deps.gateway.request<{ checkout?: { url: string } | null }>("/v1/tenants/me/sitze", { method: "POST", body: { plan: args.plan, anzahl: 1, actorId: sz.ich, rueckkehr: "app" }, signal: c.signal });
        if (r.checkout?.url) return { plan: args.plan, checkoutUrl: r.checkout.url, hinweis: "Zum Abschluss die Kasse im Browser oeffnen (Link)." };
        return { plan: args.plan, sofort: true };
      }
      await deps.gateway.request(`/v1/tenants/me/mitglieder/${encodeURIComponent(sz.ich)}/sitz`, { method: "PUT", body: { plan: args.plan, zum: "zyklusende" }, signal: c.signal });
      return { plan: args.plan, vorgemerkt: true, am: sz.zyklusende };
    },
  });

  // P6 — Ultra: fuer den laufenden Monat ueber das Kontingent hinaus (Owner/Admin).
  const paygFreigeben = defineTool({
    name: "payg_freigeben",
    summary: "Ultra: fuer den laufenden Monat Firmen ueber das Kontingent hinaus aufnehmen (freigeben oder zuruecknehmen, optional mit Deckel).",
    category: "kontingent ueberschreiten freigeben pay deckel ultra",
    description:
      "Nur mit Ultra-Sitz und nur Owner/Admin: gibt fuer den laufenden Monat Aufnahmen ueber das Kontingent hinaus frei (jede weitere Firma zum Stufenpreis), optional mit Deckel in Euro; am Monatsersten endet die Freigabe von selbst. Fragt vorher nach.",
    parameters: { type: "object", required: ["freigeben"], properties: { freigeben: { type: "boolean" }, deckelEur: { type: ["number", "null"] } } },
    schema: yup.object({ freigeben: yup.boolean().required(), deckelEur: yup.number().min(0).max(100_000).nullable().optional() }).noUnknown(true),
    preview: (r) => { const x = r as { abgebrochen?: boolean; error?: string; freigegeben?: boolean }; return x.error ? `Fehler: ${x.error.slice(0, 60)}` : x.abgebrochen ? "abgebrochen" : x.freigegeben ? "freigegeben" : "zurueckgenommen"; },
    run: async (args, c) => {
      const deckel = args.deckelEur == null ? null : Math.round(args.deckelEur * 100);
      const v = await c.ui.confirmAction({ kind: "additive", prompt: args.freigeben ? `Fuer den laufenden Monat ueber das Kontingent hinaus aufnehmen${deckel != null ? `, hoechstens ${(deckel / 100).toFixed(2)} € zusaetzlich` : ""}? Jede weitere Firma wird zum Stufenpreis berechnet; am Monatsersten ist die Freigabe wieder aus.` : "Freigabe ueber das Kontingent hinaus zuruecknehmen?", confirmValue: "ja", options: [{ value: "ja", label: args.freigeben ? "Freigeben" : "Zuruecknehmen" }, { value: "cancel", label: "Abbrechen" }] }, c.signal);
      if (v !== "ja") return { abgebrochen: true };
      try {
        await deps.gateway.request("/v1/usage/payg", { method: "PUT", body: { freigeben: args.freigeben, limitCents: deckel }, signal: c.signal });
        return { freigegeben: args.freigeben };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
  return [status, limitSetzen, linkedinLimit, planWechseln, paygFreigeben];
}
