import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";
import { getDb as getLinkedInDb, signalsForCompany } from "../../linkedin/db";
import { read as readLinkedInSettings } from "../../linkedin/store";
import { landText, statusWarnungText } from "../../firmen-status";

// Read-only company tools (Phase 8.b).
//
// Each tool wraps one gateway endpoint from /v1/companies. Args are kept
// small — the model picks them, so simpler is better. Previews are short
// strings the renderer can render in a tool-result chip; the full result
// is fed back into the model via the `tool` message in the next loop.

interface Ctx {
  gateway: GatewayClient;
  /** T5 — Firmen des Tenants (aus den eigenen Vorgaengen). Lazy, weil
   *  der Aufruf das Gateway befragt; nur company_tech_stack braucht ihn. */
  getTenantCompanyIds: () => Promise<string[]>;
}

function pickFirst<T>(...vals: T[]): T | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== ("" as unknown)) return v;
  }
  return undefined;
}

export function buildCompanyTools(ctx: Ctx): Tool[] {
  const { gateway } = ctx;

  const search = defineTool({
    name: "company_search",
    description:
      "Fuzzy-search companies by name (Deutschland, Oesterreich, Schweiz). Returns up to `limit` candidate matches (id, name, location, country DE | AT | CH, registerStatus: ACTIVE | CLOSED = Registerblatt geschlossen/geloescht | LOESCHUNG_ANGEKUENDIGT = Loeschung angekuendigt; nenne dem Nutzer geloeschte oder in Loeschung befindliche Firmen ausdruecklich). Treffer ausserhalb Deutschlands tragen ein Feld `land` (z. B. \"Österreich, Firmenbuch FN 56247t\"): nenne das Land, wenn es fuer den Nutzer nicht offensichtlich ist. Use this first when the user mentions a company by name. Mit gruendungVon/gruendungBis/sortierung laesst sich nach dem Gruendungsjahr filtern und sortieren; das Jahr ist nur fuer Firmen bekannt, deren Registerinhalt schon abgerufen wurde, und der Name wird dann woertlich gesucht.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Company name (partial OK)." },
        limit: {
          type: "integer",
          description: "Max matches to return.",
          minimum: 1,
          maximum: 25,
          default: 10,
        },
        gruendungVon: { type: "integer", description: "Nur Firmen, die in diesem Jahr oder spaeter gegruendet wurden.", minimum: 1000, maximum: 2100 },
        gruendungBis: { type: "integer", description: "Nur Firmen, die in diesem Jahr oder frueher gegruendet wurden.", minimum: 1000, maximum: 2100 },
        sortierung: { type: "string", description: "Nach Gruendungsjahr sortieren: gruendung_auf (aelteste zuerst) oder gruendung_ab (juengste zuerst).", enum: ["gruendung_auf", "gruendung_ab"] },
      },
      required: ["q"],
    },
    schema: yup.object({
      q: yup.string().trim().min(1).required(),
      limit: yup.number().integer().min(1).max(25).default(10),
      gruendungVon: yup.number().integer().min(1000).max(2100).optional(),
      gruendungBis: yup.number().integer().min(1000).max(2100).optional(),
      sortierung: yup.string().oneOf(["gruendung_auf", "gruendung_ab"]).optional(),
    }),
    run: async (args, c) => {
      // Gruendungsjahr-Filter: Das Jahr kommt aus dem strukturierten
      // Registerinhalt, den nur abgerufene Firmen haben. Mit Filter sucht das
      // Gateway den Namensteil woertlich statt unscharf.
      const gruendung = {
        ...(args.gruendungVon !== undefined ? { gruendungVon: args.gruendungVon } : {}),
        ...(args.gruendungBis !== undefined ? { gruendungBis: args.gruendungBis } : {}),
        ...(args.sortierung ? { sortierung: args.sortierung } : {}),
      };
      const data = await gateway.request<{
        items?: Array<Record<string, unknown>>;
        total?: number;
      }>("/v1/companies/search", {
        query: { q: args.q, limit: args.limit, ...gruendung },
        signal: c.signal,
      });
      // Statuswarnung je Treffer (Insolvenz, Loeschung, Liquidation) an erster Stelle.
      const items = (data.items ?? []).map((it) => {
        const w = statusWarnungText(it as never);
        const l = (it as { country?: string }).country && (it as { country?: string }).country !== "DE" ? landText(it as never) : null;
        return { ...(w ? { statusWarnung: w } : {}), ...(l ? { land: l } : {}), ...it };
      });
      const mitWarnung = items.filter((it) => (it as { statusWarnung?: string }).statusWarnung).length;
      return { items, total: data.total ?? 0, ...(mitWarnung > 0 ? { hinweis: `${mitWarnung} Treffer mit Statuswarnung (statusWarnung): dem Nutzer ausdruecklich nennen.` } : {}) };
    },
    preview: (r) =>
      r.total === 0
        ? "no matches"
        : `${r.total} match${r.total === 1 ? "" : "es"}${(r as { hinweis?: string }).hinweis ? ", mit Statuswarnung" : ""}`,
  });

  const get = defineTool({
    name: "company_get",
    description:
      "Fetch the canonical company record (legal name, register, address, country) by its global companyId. Field `land` fasst Land und Register zusammen (z. B. \"Österreich, Firmenbuch FN 56247t, Landesgericht Salzburg\"); country DE | AT | CH, registerType HRB/HRA (DE) oder FN (AT), legalForm = amtliche Rechtsform, uid = Umsatzsteuer-Id. Bei oesterreichischen Firmen gibt es keinen kostenlosen Vollauszug (JustizOnline, kostenpflichtig).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) => {
      const r = await gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}`,
        { signal: c.signal },
      );
      // Status zuerst: Insolvenz, Loeschung, Liquidation muessen den Kontext dominieren.
      const warnung = statusWarnungText(r as never);
      const l = landText(r as never);
      return { ...(warnung ? { statusWarnung: warnung } : {}), ...(l ? { land: l } : {}), ...r };
    },
    preview: (r) => {
      const name = pickFirst(
        (r as { name?: string }).name,
        (r as { legalName?: string }).legalName,
      );
      const w = (r as { statusWarnung?: string }).statusWarnung;
      return `${name ? `company: ${name}` : "company record"}${w ? ` — ${w.slice(0, 60)}` : ""}`;
    },
  });

  // Firmen-Verflechtungen (docs/PLAN_VERFLECHTUNGEN.md §5, V7): Gesellschafter,
  // Netz und tieferer Lauf. Nur deutsche Firmen (HRB), Org-Feature verflechtungen.
  const shareholders = defineTool({
    name: "company_shareholders",
    description:
      "Gesellschafter einer deutschen Firma aus der neuesten Gesellschafterliste des Handelsregisters (Personen mit Geburtsjahr und Wohnort, Firmen mit Registerangabe, Nennbetrag, Prozent) " +
      "sowie Beteiligungen der Firma an anderen Firmen. `stand` sagt, ob und wann die Liste gelesen wurde (LISTE, KEINE = keine Liste im Registerordner, UNSICHER/FEHLER = Lesung verworfen, mit Gruenden). " +
      "Nur fuer HRB-Firmen; HRA-Firmen haben keine Gesellschafterliste.",
    parameters: { type: "object", properties: { companyId: { type: "string" } }, required: ["companyId"] },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }).noUnknown(true),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(`/v1/companies/${encodeURIComponent(args.companyId)}/shareholders`, { signal: c.signal }),
    preview: (r) => {
      const g = ((r as { gesellschafter?: unknown[] }).gesellschafter ?? []).length;
      const st = (r as { stand?: { ergebnis?: string } | null }).stand?.ergebnis ?? "ungeprueft";
      return `${g} Gesellschafter, Stand ${st}`;
    },
  });

  const network = defineTool({
    name: "company_network",
    description:
      "Firmengeflecht um eine deutsche Firma: Knoten (Firmen, Personen) und Kanten (BETEILIGUNG mit Prozent, GESCHAEFTSFUEHRUNG, ADRESSE) per Breitensuche bis `tiefe` (1 bis 6, Standard 2). " +
      "Zeigt, wer die Firma haelt, woran sie beteiligt ist und welche Personen mehrere Firmen verbinden. `abgeschnitten` = mehr als 300 Knoten.",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" }, tiefe: { type: "integer", minimum: 1, maximum: 6 } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required(), tiefe: yup.number().integer().min(1).max(6).optional() }).noUnknown(true),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(`/v1/companies/${encodeURIComponent(args.companyId)}/network`, { query: { tiefe: args.tiefe ?? 2 }, signal: c.signal }),
    preview: (r) => `${((r as { knoten?: unknown[] }).knoten ?? []).length} Knoten, ${((r as { kanten?: unknown[] }).kanten ?? []).length} Kanten`,
  });

  const networkDeepen = defineTool({
    name: "company_network_deepen",
    description:
      "Firmengeflecht ab einer deutschen HRB-Firma tiefer verfolgen: AVA liest die Gesellschafterliste der Firma und rekursiv die ihrer Firmen-Gesellschafter (Standard bis Tiefe 6, hoechstens 200 Firmen je Lauf). " +
      "Laeuft im Hintergrund auf diesem Rechner mit dem eigenen KI-Modell (Bild-Modell ab Stufe A noetig) und legt den Vorgang 'Verflechtungen <Firma>' an. " +
      "`ohneBremse` hebt Tiefen- und Firmengrenze auf (grosse Konstrukte) und wird vom Nutzer bestaetigt. Der Standardlauf ohne Aufruf liest automatisch eine Ebene.",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string" },
        name: { type: "string", description: "Firmenname fuer den Vorgangsnamen" },
        maxTiefe: { type: "integer", minimum: 1, maximum: 12 },
        ohneBremse: { type: "boolean" },
      },
      required: ["companyId"],
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(1).required(),
        name: yup.string().trim().max(200).optional(),
        maxTiefe: yup.number().integer().min(1).max(12).optional(),
        ohneBremse: yup.boolean().optional(),
      })
      .noUnknown(true),
    run: async (args, c) => {
      if (!/^[A-Z0-9]+_HRB_/.test(args.companyId)) return { error: "Nur deutsche HRB-Firmen haben eine Gesellschafterliste." };
      const tiefe = args.maxTiefe ?? 6;
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            `Firmengeflecht ab ${args.name ?? args.companyId} tiefer verfolgen?\n\n` +
            (args.ohneBremse
              ? `OHNE Notbremse: unbegrenzte Tiefe und Firmenzahl. Bei grossen Konstrukten koennen hunderte Registerabrufe und Modellaufrufe entstehen.`
              : `Bis Tiefe ${tiefe}, hoechstens 200 Firmen. Jede Firma kostet einen Registerabruf und zwei Modell-Lesungen.`),
          confirmValue: "start",
          options: [
            { value: "start", label: "Starten", description: "Vorgang 'Verflechtungen' anlegen" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "start") return { abgebrochen: true };
      return gateway.request<Record<string, unknown>>("/v1/verflechtungen/kontexte", {
        method: "POST",
        body: { companyId: args.companyId, name: args.name, maxTiefe: tiefe, ohneBremse: args.ohneBremse === true },
        signal: c.signal,
      });
    },
    preview: (r) => {
      const x = r as { abgebrochen?: boolean; error?: string; kontext?: string; unbekannt?: boolean };
      if (x.error) return x.error;
      if (x.abgebrochen) return "abgebrochen";
      return x.unbekannt ? "Firma noch nicht in den Stammdaten, wird nachgezogen" : `Lauf gestartet (${x.kontext ?? ""})`;
    },
  });

  const verflechtungenPerson = defineTool({
    name: "verflechtungen_person",
    description:
      "Person aus Gesellschafterlisten und Geschaeftsfuehrung (Id aus company_network oder company_shareholders, Feld personId): Name, Geburtsjahr, Wohnort, Rollen je Firma (GESCHAEFTSFUEHRER, GESELLSCHAFTER, PROKURIST mit von/bis) und Beteiligungen mit Quote. " +
      "Zeigt, in welchen Firmen dieselbe Person steckt.",
    parameters: { type: "object", properties: { personId: { type: "string" } }, required: ["personId"] },
    schema: yup.object({ personId: yup.string().trim().min(3).required() }).noUnknown(true),
    run: async (args, c) => gateway.request<Record<string, unknown>>(`/v1/verflechtungen/personen/${encodeURIComponent(args.personId)}`, { signal: c.signal }),
    preview: (r) => {
      const p = r as { vorname?: string; nachname?: string; rollen?: unknown[]; beteiligungen?: unknown[] };
      return `${p.vorname ?? ""} ${p.nachname ?? ""}: ${(p.rollen ?? []).length} Rollen, ${(p.beteiligungen ?? []).length} Beteiligungen`;
    },
  });

  // Insolvenz-Delta — Status und Veroeffentlichungen des Insolvenzportals; Pruefung anfordern.
  const insolvency = defineTool({
    name: "company_insolvency",
    description:
      "Insolvenzstatus einer Firma (NONE, VERDACHT, SICHERUNG = vorlaeufiger Insolvenzverwalter, EROEFFNET, ABGEWIESEN mangels Masse, AUFGEHOBEN) " +
      "mit den gespeicherten Veroeffentlichungen (Datum, Aktenzeichen, Gegenstand, Text; quelle insolvenzportal = Deutschland, ediktsdatei = Oesterreich). Mit pruefen=true wird eine neue " +
      "Abfrage fuer diese Firma eingereiht (Insolvenzportal bei deutschen, Ediktsdatei bei oesterreichischen Firmen AT_FN...; laeuft im Hintergrund ueber die Register-Worker, Ergebnis nach einigen Minuten bis Stunden).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" }, pruefen: { type: "boolean", description: "neue Pruefung im Insolvenzportal anfordern" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required(), pruefen: yup.boolean().optional() }).noUnknown(true),
    run: async (args, c) => {
      const daten = await gateway.request<Record<string, unknown>>(`/v1/companies/${encodeURIComponent(args.companyId)}/insolvency-events`, { signal: c.signal });
      let eingereiht: unknown = null;
      if (args.pruefen === true) {
        // Oesterreich: Ediktsdatei und Firmenbuch-Detail ueber die AT-Route; sonst Insolvenzportal.
        const route = /^AT_FN/.test(args.companyId) ? "/v1/register-jobs/at" : "/v1/register-jobs/insolvenz";
        eingereiht = await gateway.request<Record<string, unknown>>(route, { method: "POST", body: { companyIds: [args.companyId], grund: "chat" }, signal: c.signal });
      }
      return { ...daten, pruefungEingereiht: eingereiht };
    },
    preview: (r) => {
      const s = (r as { insolvencyStatus?: string }).insolvencyStatus ?? "NONE";
      const n = ((r as { events?: unknown[] }).events ?? []).length;
      return `Insolvenzstatus ${s}, ${n} Veroeffentlichungen`;
    },
  });

  const profile = defineTool({
    name: "company_profile",
    description:
      "Get the LLM-derived profile for a company (corporate purpose, summary, headcount, market positioning).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/profile`,
        { signal: c.signal },
      ),
    preview: () => "profile fetched",
  });

  const keywords = defineTool({
    name: "company_keywords",
    description:
      "List extracted keywords/tags for a company (industries, products, themes).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) => {
      const data = await gateway.request<{ items?: unknown[] }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/keywords`,
        { signal: c.signal },
      );
      return { items: data.items ?? [] };
    },
    preview: (r) => `${r.items.length} keywords`,
  });

  const website = defineTool({
    name: "company_website",
    description:
      "Get the crawled website summary for a company (homepage URL, scraped sections, last crawl).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/website`,
        { signal: c.signal },
      ),
    preview: (r) => {
      const url = pickFirst(
        (r as { url?: string }).url,
        (r as { homepageUrl?: string }).homepageUrl,
      );
      return url ? `website: ${url}` : "website fetched";
    },
  });

  const publications = defineTool({
    name: "company_publications",
    description:
      "List financial publications (annual reports etc.) for a company. Each item carries year, KPIs, and stateOfAffairs narrative.",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) => {
      const data = await gateway.request<{ items?: unknown[] }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/publications`,
        { signal: c.signal },
      );
      return { items: data.items ?? [] };
    },
    preview: (r) => `${r.items.length} publications`,
  });

  const contacts = defineTool({
    name: "company_contacts",
    description:
      "Get the contact aggregate for a company (board members, generic emails, phone numbers).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/contacts`,
        { signal: c.signal },
      ),
    preview: () => "contacts fetched",
  });

  // T5 (v0.1.510) — firmenuebergreifend: "Welche meiner Firmen nutzen
  // HubSpot?" Quelle sind die tech:<kategorie>-Fakten aus der
  // Datenschutzerklaerung. Read-only, daher ohne confirmAction.
  const techStack = defineTool({
    name: "company_tech_stack",
    summary:
      "Eingesetzte Systeme der eigenen Firmen (CRM, Hosting, Marketing) — optional nach Anbieter oder Kategorie filtern.",
    category: "firmen systeme technologie",
    description:
      "Listet die eingesetzten Systeme der verarbeiteten Firmen. Quelle ist " +
      "ausschliesslich die Datenschutzerklaerung der jeweiligen Website — dort " +
      "muessen Auftragsverarbeiter benannt werden. Mit `vendor` nach einem " +
      "Anbieter filtern (Teiltreffer, z. B. 'hubspot'), mit `kategorie` nach " +
      "crm | erp | buchhaltung | marketing | analytics | support | shop | hosting | " +
      "kommunikation | produktivitaet | hr | zahlung | consent. WICHTIG fuer die Antwort: eine Nennung belegt " +
      "eine Geschaeftsbeziehung, NICHT zwingend den aktiven Betrieb — solche " +
      "Seiten sind oft veraltet oder aus Vorlagen erzeugt. Sag das dazu, wenn " +
      "du daraus Schluesse ziehst.",
    parameters: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "Anbieter-Teiltreffer, z. B. 'hubspot'." },
        kategorie: { type: "string", description: "Kategorie-Filter, z. B. 'crm'." },
      },
    },
    schema: yup.object({
      vendor: yup.string().trim().min(2).max(80).optional(),
      kategorie: yup.string().trim().min(2).max(40).optional(),
    }),
    preview: (r) => {
      const n = (r as { treffer?: unknown[] })?.treffer?.length ?? 0;
      return `${n} Treffer`;
    },
    run: async (args, c) => {
      const companyIds = await ctx.getTenantCompanyIds();
      if (companyIds.length === 0) {
        return {
          treffer: [],
          hinweis:
            "Noch keine verarbeiteten Firmen gefunden — erst Firmen importieren und verarbeiten lassen.",
        };
      }
      const res = await gateway.request<{
        items: Array<{
          companyId: string;
          companyName: string | null;
          kategorie: string;
          vendor: string;
          evidenceUrl: string | null;
        }>;
      }>("/v1/companies/tech-stack", {
        method: "POST",
        body: {
          companyIds: companyIds.slice(0, 300),
          ...(args.vendor ? { vendor: args.vendor } : {}),
          ...(args.kategorie ? { kategorie: args.kategorie } : {}),
        },
        signal: c.signal,
      });
      return {
        treffer: res.items,
        durchsuchteFirmen: Math.min(companyIds.length, 300),
        hinweis:
          "Quelle ist die Datenschutzerklaerung: eine Nennung belegt eine Geschaeftsbeziehung, nicht zwingend den aktiven Betrieb.",
      };
    },
  });

  const structuredContent = defineTool({
    name: "company_structured_content",
    description:
      "Get extracted structured content (facts, observations, signals) the cascade has stored for a company.",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/structured-content`,
        { signal: c.signal },
      ),
    preview: () => "structured content fetched",
  });

  // v0.1.65 — per-stage LLM provenance for the agent's reliability
  // hints. Returns one row per stage with `llmTier` (1..4 = C..S; null
  // for non-LLM scrape stages) and `llmModel` (e.g. "gpt-4o",
  // "qwen2.5:7b"; null on non-LLM or pre-tracking writes). The agent
  // is expected to soft-warn when answering with data sourced from
  // tier-B/C cells — see system-prompt update.
  const dataQuality = defineTool({
    name: "company_data_quality",
    description:
      "Get per-stage LLM provenance for a company: which model produced each cell, what tier (S/A/B/C reliability), and when. Use this to qualify your answer when the user asks about company facts — soft-warn on tier-B/C sources, especially Tier C (small local models can hallucinate).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<{
        companyId: string;
        stages: Record<
          string,
          {
            updatedAt: string | null;
            llmTier: number | null;
            llmModel: string | null;
          }
        >;
      }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/state`,
        { signal: c.signal },
      ),
    preview: (r) => {
      const llmStages = Object.values(r.stages).filter(
        (s) => s.llmTier != null,
      );
      if (llmStages.length === 0) return "no LLM data yet";
      const worst = Math.min(
        ...llmStages.map((s) => s.llmTier as number),
      );
      const letter = ({ 4: "S", 3: "A", 2: "B", 1: "C" } as const)[
        worst as 1 | 2 | 3 | 4
      ];
      return `worst tier across ${llmStages.length} stages: ${letter}`;
    },
  });

  // L6 — agent-facing window into the LinkedIn-Beobachter signals for a
  // company. Stays main-side (no gateway round-trip) because the data
  // lives in the local linkedin DB. Returns nothing when the master
  // switch is off so the tool degrades gracefully.
  const linkedInSignals = defineTool({
    name: "company_linkedin_signals",
    description:
      "Liefert die letzten LinkedIn-Signale für eine Firma. Zeigt Beitrag, Signal-Art, Stärke, gematchte Personen und kurze Zusammenfassung. Nutze das Tool, wenn der Nutzer fragt 'was tut sich bei <Firma> auf LinkedIn?' oder eine Status-Übersicht möchte.",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string" },
        limit: {
          type: "integer",
          description: "Max signals to return.",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      required: ["companyId"],
    },
    schema: yup.object({
      companyId: yup.string().trim().min(1).required(),
      limit: yup.number().integer().min(1).max(50).default(10),
    }),
    run: async (args) => {
      const settings = readLinkedInSettings();
      if (!settings.enabled) {
        return {
          enabled: false,
          items: [] as Array<Record<string, unknown>>,
          note: "LinkedIn-Beobachter ist deaktiviert.",
        };
      }
      const db = await getLinkedInDb();
      const rows = await signalsForCompany(db, args.companyId, args.limit);
      return {
        enabled: true,
        items: rows.map((r) => ({
          postUrn: r.postUrn,
          postedAt: r.postedAt,
          authorName: r.authorDisplayName,
          signalKind: r.signalKind,
          signalStrength: r.signalStrength,
          summary: r.summary,
          permalink: r.permalink,
        })),
      };
    },
    preview: (r) => {
      if (!r.enabled) return "linkedin disabled";
      return `${r.items.length} linkedin signal${r.items.length === 1 ? "" : "s"}`;
    },
  });

  // Workstream C — CRM-context fan-out.
  //
  // Wraps GET /v1/companies/:id/crm/details. Returns enriched payloads
  // for every CRM the company is linked to. Cheap when the cache row
  // is < 6h old (DB-only); a stale cache or `refresh=true` triggers a
  // fresh CRM-side fetch in the gateway (HubSpot today; Salesforce /
  // Dynamics surface `notConfigured: true`).
  //
  // Companies with no CRM links return `{ details: [] }` — the agent
  // should treat that as "no CRM context to report" and omit the
  // CRM-Kontext subsection from its summary.
  const crmSummary = defineTool({
    name: "company_crm_summary",
    description:
      "Pulls CRM-side context for an AVA company: open deals, recent contacts, " +
      "last activity. Use this when the user asks for an overview / status of a " +
      "specific company they've imported from a CRM (HubSpot today). Returns " +
      "empty when the company has no CRM link. Cheap to call when cached " +
      "(no CRM API hit for up to 6h); safe to include in the default fan-out " +
      "for open company questions without burning quota.",
    parameters: {
      type: "object",
      required: ["companyId"],
      properties: {
        companyId: { type: "string", description: "AVA master-data companyId." },
        refresh: {
          type: "boolean",
          description:
            "Force a fresh CRM-side fetch even if a cached payload < 6h old exists. Default false.",
        },
      },
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(1).required(),
        refresh: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: {
      details?: Array<{
        crmType?: string;
        deals?: unknown[];
        contacts?: unknown[];
        notConfigured?: boolean;
      }>;
    }) => {
      const details = r.details ?? [];
      if (details.length === 0) return "no CRM link";
      const dealCount = details.reduce(
        (n, d) => n + (Array.isArray(d.deals) ? d.deals.length : 0),
        0,
      );
      const contactCount = details.reduce(
        (n, d) => n + (Array.isArray(d.contacts) ? d.contacts.length : 0),
        0,
      );
      return `${dealCount} deals · ${contactCount} contacts across ${details.length} CRM(s)`;
    },
    run: async (args, c) =>
      gateway.request<{
        details: Array<{
          crmType: string;
          fetchedAt: string;
          notConfigured?: boolean;
          contacts?: unknown[];
          deals?: unknown[];
          notes?: unknown[];
          lastActivity?: string | null;
        }>;
      }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/crm/details`,
        { query: { refresh: args.refresh ? "true" : "false" }, signal: c.signal },
      ),
  });

  // ---- contact_linkedin_lookup (v0.1.476, WL0-Konsequenz 3) ---------------
  //
  // Gezielter LinkedIn-Profil-Nachschlag fuer einen bekannten Kontakt:
  // SERP-Suche (site:linkedin.com/in "<Name>" "<Firma>") ueber den
  // Gateway-Proxy, dann Slug≈Name-Plausibilitaetscheck (WL0 hat gezeigt,
  // dass der Slug bei echten Treffern den Namen traegt). Persist NUR
  // ueber die Nadeloehr-Route (POST …/contacts/linkedin-url) — mit
  // confirmAction (Klasse A: legt Neues an, ueberschreibt nichts).

  const foldName = (v: string): string =>
    v
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .replace(/ae/g, "a")
      .replace(/oe/g, "o")
      .replace(/ue/g, "u")
      .replace(/ss/g, "s")
      .replace(/[^a-z0-9]+/g, "-");

  const profileFromSerpUrl = (raw: string | undefined): string | null => {
    if (!raw) return null;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
      const m = /^\/in\/([^/]+)/.exec(u.pathname);
      if (!m?.[1]) return null;
      const slug = decodeURIComponent(m[1]).trim().toLowerCase();
      return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}` : null;
    } catch {
      return null;
    }
  };

  const linkedinLookup = defineTool({
    name: "contact_linkedin_lookup",
    summary:
      "LinkedIn-Profil-URL fuer einen bekannten Kontakt per SERP-Suche finden und (nach Plausibilitaetscheck) am Kontakt speichern.",
    category: "kontakte linkedin",
    description:
      "Sucht die LinkedIn-Profil-URL einer Person (site:linkedin.com/in " +
      "Suche via SERP), prueft ob der Profil-Slug plausibel zum Namen " +
      "passt, und speichert den besten Treffer am Kontakt der Firma " +
      "(companyId + fullName noetig; Firmenname verbessert die Suche). " +
      "Bei mehreren plausiblen Treffern werden die Kandidaten " +
      "zurueckgegeben — dann per ask_user_choice klaeren lassen und mit " +
      "chosenUrl erneut aufrufen. Kostet 1 SERP-Abfrage.",
    parameters: {
      type: "object",
      required: ["companyId", "fullName"],
      properties: {
        companyId: { type: "string", description: "AVA-companyId der Firma." },
        fullName: { type: "string", description: "Voller Personenname." },
        companyName: {
          type: "string",
          description: "Firmenname fuer die Suche (empfohlen).",
        },
        chosenUrl: {
          type: "string",
          description:
            "Bereits geklaerte Profil-URL — ueberspringt die Suche und speichert direkt.",
        },
      },
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(2).required(),
        fullName: yup.string().trim().min(3).max(200).required(),
        companyName: yup.string().trim().max(200).optional(),
        chosenUrl: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r) => {
      const res = r as { saved?: boolean; kandidaten?: unknown[]; error?: string };
      if (res.error) return res.error;
      if (res.saved) return "Profil-URL gespeichert";
      if (res.kandidaten?.length) return `${res.kandidaten.length} Kandidaten — Auswahl noetig`;
      return "Kein plausibles Profil gefunden";
    },
    run: async (args, c) => {
      const persist = async (url: string): Promise<unknown> => {
        const value = await c.ui.confirmAction(
          {
            kind: "additive",
            prompt:
              `LinkedIn-Profil am Kontakt speichern?\n\n` +
              `${args.fullName} (${args.companyName ?? args.companyId})\n${url}`,
            confirmValue: "save",
            options: [
              { value: "save", label: "Speichern", description: "POST ans Gateway" },
              { value: "cancel", label: "Verwerfen" },
            ],
          },
          c.signal,
        );
        if (value !== "save") return { saved: false, abgebrochen: true };
        const res = await gateway.request<{
          saved: boolean;
          personId: string;
          normalizedUrl: string;
        }>(
          `/v1/companies/${encodeURIComponent(args.companyId)}/contacts/linkedin-url`,
          {
            method: "POST",
            body: { fullName: args.fullName, linkedinUrl: url },
            signal: c.signal,
          },
        );
        return { saved: res.saved, url: res.normalizedUrl, personId: res.personId };
      };

      if (args.chosenUrl) {
        const norm = profileFromSerpUrl(args.chosenUrl);
        if (!norm) {
          return { error: "chosenUrl ist keine LinkedIn-Profil-URL (linkedin.com/in/…)." };
        }
        return persist(norm);
      }

      const q = args.companyName
        ? `site:linkedin.com/in "${args.fullName}" "${args.companyName}"`
        : `site:linkedin.com/in "${args.fullName}"`;
      const body = await gateway.request<{
        organic_results?: Array<{ link?: string; title?: string }>;
      }>("/v1/proxy/valueserp", {
        method: "POST",
        body: { q, num: 10 },
        signal: c.signal,
      });

      // Plausibilitaet: alle Namens-Tokens (>=3 Zeichen) muessen im
      // gefalteten Slug vorkommen (WL0-Befund: bei echten Treffern
      // traegt der Slug den Namen; Umlaut-/ae-ue-Falten beidseitig).
      const tokens = foldName(args.fullName)
        .split("-")
        .filter((t) => t.length >= 3);
      const seen = new Set<string>();
      const plausibel: Array<{ url: string; titel: string | null }> = [];
      for (const r of body.organic_results ?? []) {
        const url = profileFromSerpUrl(r.link);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const slugFold = foldName(decodeURIComponent(url.split("/in/")[1] ?? ""));
        if (tokens.length > 0 && tokens.every((t) => slugFold.includes(t))) {
          plausibel.push({ url, titel: r.title ?? null });
        }
      }

      if (plausibel.length === 0) {
        return {
          saved: false,
          hinweis:
            "Kein Profil gefunden, dessen Slug plausibel zum Namen passt — nichts gespeichert (kein Raten).",
        };
      }
      if (plausibel.length === 1) return persist(plausibel[0]!.url);
      return {
        saved: false,
        kandidaten: plausibel,
        hinweis:
          "Mehrere plausible Profile — lass den Nutzer per ask_user_choice waehlen und rufe das Tool mit chosenUrl erneut auf.",
      };
    },
  });

  // C1 — Personen: Herkunft, Art.-14-Hinweis, Informiert am, Loeschung.
  const personHerkunft = defineTool({
    name: "person_herkunft",
    summary: "Herkunftsnachweis einer Person (Art. 15): alle Angaben mit Quelle, Beleg, Zeitpunkt, erhebender Organisation.",
    category: "person kontakt herkunft auskunft dsgvo artikel 15 beleg quelle",
    description:
      "Liefert den vollstaendigen Herkunftsnachweis einer Person (personId aus company_contacts, Feld personId/entityId der " +
      "Personen-Fakten): Fakten, Beobachtungen mit Quelle/Beleg-URL/Zeitpunkt/Lauf/erhebendem Tenant, Beschaeftigungen, " +
      "Information-nach-Art.-14-Vermerke. format 'markdown' = druckbarer Bericht fuer ein Auskunftsersuchen.",
    parameters: { type: "object", required: ["personId"], properties: { personId: { type: "string" }, format: { type: "string", enum: ["json", "markdown"] } } },
    schema: yup.object({ personId: yup.string().trim().min(4).required(), format: yup.string().oneOf(["json", "markdown"]).optional() }).noUnknown(true),
    preview: (r: { person?: { fullName?: string }; markdown?: string }) => `Herkunft: ${r.person?.fullName ?? (r.markdown ? "Bericht" : "?")}`,
    run: async (args) => {
      if (args.format === "markdown") {
        const md = await gateway.request<string>(`/v1/persons/${encodeURIComponent(args.personId)}/herkunft?format=markdown`, { method: "GET" });
        return { markdown: md };
      }
      return gateway.request<Record<string, unknown>>(`/v1/persons/${encodeURIComponent(args.personId)}/herkunft`, { method: "GET" });
    },
  });

  const personHinweis = defineTool({
    name: "person_hinweis",
    summary: "Vorformulierten Hinweistext nach Art. 14 DSGVO fuer eine Person liefern.",
    category: "person kontakt information artikel 14 hinweis dsgvo",
    description: "Liefert den Hinweistext (Quelle, Zweck, Speicherdauer, Rechte, Kontakt) fuer die Information der Person nach Art. 14. Optional kontaktEmail der Organisation.",
    parameters: { type: "object", required: ["personId"], properties: { personId: { type: "string" }, kontaktEmail: { type: "string" } } },
    schema: yup.object({ personId: yup.string().trim().min(4).required(), kontaktEmail: yup.string().trim().email().optional() }).noUnknown(true),
    preview: () => "Art.-14-Hinweistext",
    run: async (args) =>
      gateway.request<{ text: string }>(`/v1/persons/${encodeURIComponent(args.personId)}/hinweis${args.kontaktEmail ? `?kontaktEmail=${encodeURIComponent(args.kontaktEmail)}` : ""}`, { method: "GET" }),
  });

  const personInformed = defineTool({
    name: "person_informed",
    summary: "Dokumentieren, dass eine Person nach Art. 14 informiert wurde (Informiert am).",
    category: "person kontakt informiert artikel 14 dokumentation",
    description: "Setzt fuer meine Organisation den Vermerk 'Informiert am' an der Person (Kanal optional, z. B. 'E-Mail'). Fragt vor der Ausfuehrung nach.",
    parameters: { type: "object", required: ["personId"], properties: { personId: { type: "string" }, kanal: { type: "string" } } },
    schema: yup.object({ personId: yup.string().trim().min(4).required(), kanal: yup.string().trim().max(60).optional() }).noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean }) => (r.abgebrochen ? "abgebrochen" : "als informiert markiert"),
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        { kind: "additive", prompt: `Person ${args.personId.slice(0, 8)}… als nach Art. 14 informiert markieren${args.kanal ? ` (${args.kanal})` : ""}?`, confirmValue: "ja", options: [{ value: "ja", label: "Markieren" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (value !== "ja") return { ok: false, abgebrochen: true };
      await gateway.request(`/v1/persons/${encodeURIComponent(args.personId)}/informed`, { method: "POST", body: { channel: args.kanal ?? "chat" } });
      return { ok: true };
    },
  });

  const personDelete = defineTool({
    name: "person_delete",
    summary: "Person global loeschen (Loeschwunsch, Art. 17) — Tombstone sperrt die Wiedererfassung.",
    category: "person kontakt loeschen loeschwunsch artikel 17 dsgvo widerspruch",
    description:
      "Loescht eine Person im gesamten geteilten Bestand (alle Organisationen) und sperrt die erneute Erfassung ueber Namens- und " +
      "Profil-Kennung. Nur fuer Organisationen, die die Person erhoben haben. Irreversibel; fragt IMMER nach. Grund optional.",
    parameters: { type: "object", required: ["personId"], properties: { personId: { type: "string" }, grund: { type: "string" } } },
    schema: yup.object({ personId: yup.string().trim().min(4).required(), grund: yup.string().trim().max(500).optional() }).noUnknown(true),
    preview: (r: { ok?: boolean; abgebrochen?: boolean; fullName?: string | null }) => (r.abgebrochen ? "abgebrochen" : `geloescht: ${r.fullName ?? "?"}`),
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        {
          kind: "destructive",
          prompt: `Person ${args.personId.slice(0, 8)}… im GESAMTEN Bestand loeschen und gegen erneute Erfassung sperren? Das gilt fuer alle Organisationen und ist nicht umkehrbar.`,
          confirmValue: "loeschen",
          options: [{ value: "loeschen", label: "Loeschen" }, { value: "nein", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "loeschen") return { ok: false, abgebrochen: true };
      return gateway.request<{ ok: boolean; fullName: string | null; tombstones: number }>(`/v1/persons/${encodeURIComponent(args.personId)}`, { method: "DELETE", body: { reason: args.grund ?? "Loeschwunsch (Chat)" } });
    },
  });

  return [
    personHerkunft,
    personHinweis,
    personInformed,
    personDelete,
    search,
    get,
    insolvency,
    profile,
    keywords,
    website,
    publications,
    contacts,
    structuredContent,
    dataQuality,
    linkedInSignals,
    crmSummary,
    linkedinLookup,
    techStack,
    shareholders,
    network,
    networkDeepen,
    verflechtungenPerson,
  ];
}
