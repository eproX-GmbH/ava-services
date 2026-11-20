// ChatGPT-Plugin (docs/PLAN_CHATGPT_PLUGIN.md, C1/C2): feste Werkzeugmenge unter
// <mcp-host>/chatgpt, englische Beschreibungen fuer Pruefung und Scan, vollstaendige
// Annotationen und schlanke Antworten (keine internen IDs, keine Rohzeitstempel,
// Kontakte als saubere Liste statt Rohfakten).
//
// Die Liste ist FEST: unabhaengig von Org-Schaltern und vom Kopf-Relais. OpenAI
// vergleicht taeglich mit der eingereichten Fassung; abgeschaltete Bereiche
// antworten beim Aufruf mit einem klaren Hinweis. Jede Aenderung an PLUGIN_TOOLS
// ist eine neue Plugin-Version (Schnappschuss-Test scripts/test-mcp-plugin.mjs).
//
// Reine Funktionen ohne Gateway-Abhaengigkeiten, damit der Test sie direkt laedt.

export const PLUGIN_PFAD = "/chatgpt";

export interface Annotationen {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
}

const LESEN: Annotationen = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/**
 * Annotationen je Werkzeug (gilt fuer /mcp UND /chatgpt). Begruendung im Plan, Tabelle 3.2:
 * nichts ist unumkehrbar (Notizen und Firmen lassen sich in AVA entfernen); Import,
 * Neuverarbeitung und Recherche rufen Websites und Register im offenen Netz ab.
 */
export const ANNOTATIONEN: Record<string, Annotationen> = {
  ava_kontext: LESEN,
  firma_suchen: LESEN,
  firma_lesen: LESEN,
  firma_kontakte: LESEN,
  meine_firmen: LESEN,
  meldungen: LESEN,
  firmen_ereignisse: LESEN,
  auftrag_status: LESEN,
  auftraege: LESEN,
  protokoll_ablegen: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  import_anlegen: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  neu_verarbeiten: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  recherche_anstossen: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

export type PluginSchalter = "lesen" | "auftraege" | "kontakte";

export interface PluginTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schalter: PluginSchalter;
}

const LAENDER = ["DE", "AT", "CH", "UK", "NO", "FI"];

export const PLUGIN_TOOLS: PluginTool[] = [
  {
    name: "ava_kontext",
    title: "Load AVA context",
    schalter: "lesen",
    description:
      "Call this once at the start of every conversation, without asking the user. Returns who AVA is (a B2B sales assistant for companies in Germany, Austria and Switzerland), how to work with the other tools, and the user's account and organization. Answer the user in their language (usually German).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "firma_suchen",
    title: "Search companies",
    schalter: "lesen",
    description:
      "Search AVA's company register data (about 10.5 million companies from DE, AT, CH, UK, NO, FI) by name, city or register number. Returns companyId, name, city, country and register status. Continue with firma_lesen using the companyId.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search text, at least 2 characters (name, city or register number)" },
        land: { type: "string", enum: LAENDER, description: "Optional country filter" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10" },
      },
      required: ["q"],
    },
  },
  {
    name: "firma_lesen",
    title: "Read company",
    schalter: "lesen",
    description:
      "Read one company: register master data plus optional sections. bereiche: profil (AI summary, website), register (managing directors, capital, purpose), publikationen (annual and group accounts with key figures), kunden (customers and partners named on the website), konzern (subsidiaries, parent), gesellschafter (shareholders, DE only), aenderungen (changes of managing directors and master data), verlauf (register history), notizen (the user's notes), fluktuation (leadership turnover over 24 months). " +
      "`verarbeitung.stand` tells whether the company is fully processed for the user (fehlt | laeuft | unvollstaendig | vollstaendig). If fehlt, call import_anlegen with the companyId right away; if unvollstaendig, call neu_verarbeiten. Do not ask the user first, and never present empty sections of an unprocessed company as a finding.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "companyId from firma_suchen or meine_firmen" },
        bereiche: {
          type: "array",
          items: { type: "string", enum: ["profil", "register", "publikationen", "kunden", "konzern", "gesellschafter", "aenderungen", "verlauf", "notizen", "fluktuation"] },
          description: "Sections to include; without it only master data",
        },
      },
      required: ["companyId"],
    },
  },
  {
    name: "meine_firmen",
    title: "List my companies",
    schalter: "lesen",
    description: "The companies in the user's list (\"Meine Firmen\"), paged, with processing state per company. Optional search text and country.",
    inputSchema: {
      type: "object",
      properties: {
        suche: { type: "string", description: "Optional search text" },
        land: { type: "string", enum: LAENDER },
        seite: { type: "integer", minimum: 1, description: "Page, default 1" },
        proSeite: { type: "integer", minimum: 1, maximum: 200, description: "Page size, default 50" },
      },
    },
  },
  {
    name: "meldungen",
    title: "Get news on my companies",
    schalter: "lesen",
    description:
      "News on the user's companies since a point in time: changes of managing directors and master data, new annual accounts, contact changes, new customers and references. Without companyIds the first 300 companies of the user's list are used.",
    inputSchema: {
      type: "object",
      properties: {
        companyIds: { type: "array", items: { type: "string" }, description: "Optional: only these companies" },
        seit: { type: "string", description: "ISO timestamp, e.g. 2026-10-01T00:00:00Z; default 14 days ago" },
      },
    },
  },
  {
    name: "firmen_ereignisse",
    title: "Get personnel changes",
    schalter: "lesen",
    description:
      "Personnel and management changes at the user's companies (or at given companies), e.g. \"Which new sales directors were there recently?\". Kinds: neu (new in the role), verlassen (left the company), wechsel (promotion or other department), geschaeftsfuehrung (appointment or removal per register). " +
      "Each event has person, role before and after, company, date with zeitpunktArt (laut_profil = date from the profile; erstmals_gesehen or festgestellt = when AVA noticed it, may be later than the real change; register) and a source URL. Mention the kind of date in the answer. Contains names of people; use them only for the user's question.",
    inputSchema: {
      type: "object",
      properties: {
        companyIds: { type: "array", items: { type: "string" }, description: "Only these companies; default all of the user's companies" },
        gruppen: {
          type: "array",
          items: { type: "string", enum: ["geschaeftsfuehrung", "aufsicht", "vertrieb", "marketing", "einkauf", "it", "personal", "finanzen", "technik", "service"] },
          description: "Role areas, e.g. ['vertrieb'] for sales",
        },
        ebene: { type: "string", enum: ["leitung", "mitarbeit"], description: "leitung = heads, directors, chiefs, VPs, managing directors" },
        arten: { type: "array", items: { type: "string", enum: ["neu", "verlassen", "wechsel", "geschaeftsfuehrung"] } },
        seitTage: { type: "integer", minimum: 1, maximum: 3650, description: "Days back, default 90" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 100" },
      },
    },
  },
  {
    name: "firma_kontakte",
    title: "Get company contacts",
    schalter: "kontakte",
    description:
      "Contact persons at a company with role, department and, where known, business e-mail, phone and profile link, plus the source. Personal data: call only when the user asks for contacts or a recipient, and mention only what the question needs.",
    inputSchema: { type: "object", properties: { companyId: { type: "string" } }, required: ["companyId"] },
  },
  {
    name: "protokoll_ablegen",
    title: "Save a note",
    schalter: "auftraege",
    description:
      "Save a meeting note or remark on a company in AVA, optionally linked to a person (personId from firma_kontakte). The note appears in AVA at the company (firma_lesen, section notizen) and can be deleted there. datum = time of the meeting (ISO), default now.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string" },
        text: { type: "string", description: "Content, 3 to 20,000 characters" },
        personId: { type: "string", description: "Optional: person the note is about" },
        datum: { type: "string", description: "Optional: ISO time of the meeting" },
      },
      required: ["companyId", "text"],
    },
  },
  {
    name: "import_anlegen",
    title: "Add companies",
    schalter: "auftraege",
    description:
      "Add companies to the user's list and start processing (register, website, annual accounts, contacts). Preferred: companyIds from firma_suchen. Alternatively a list of {name, ort, land} (fuzzy matching). Processing runs as soon as the AVA app runs for the user and can take hours; the answer contains a transactionId for auftrag_status. Counts against the user's quota like an import in the app; companies can be removed again in AVA.",
    inputSchema: {
      type: "object",
      properties: {
        companyIds: { type: "array", items: { type: "string" }, maxItems: 500, description: "companyIds from firma_suchen (preferred)" },
        firmen: {
          type: "array",
          maxItems: 500,
          items: { type: "object", properties: { name: { type: "string" }, ort: { type: "string", description: "City" }, land: { type: "string", enum: LAENDER } }, required: ["name", "ort"] },
        },
        name: { type: "string", description: "Optional label for the job" },
      },
    },
  },
  {
    name: "neu_verarbeiten",
    title: "Reprocess a company",
    schalter: "auftraege",
    description:
      "Run one processing stage again for a company in the user's list: structuredContent (register), companyPublication (annual accounts), website, companyProfile, companyContact (contacts). Runs as soon as the AVA app runs for the user.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string" },
        stufe: { type: "string", enum: ["structuredContent", "companyPublication", "website", "companyProfile", "companyContact"] },
      },
      required: ["companyId", "stufe"],
    },
  },
  {
    name: "auftrag_status",
    title: "Get job status",
    schalter: "lesen",
    description: "Status of a job (transactionId from import_anlegen or auftraege): companies total, done and failed, open steps, last sign of life.",
    inputSchema: { type: "object", properties: { transactionId: { type: "string" } }, required: ["transactionId"] },
  },
  {
    name: "auftraege",
    title: "List my jobs",
    schalter: "lesen",
    description: "The user's jobs (imports and processing runs), newest first, paged.",
    inputSchema: { type: "object", properties: { seite: { type: "integer", minimum: 1 }, proSeite: { type: "integer", minimum: 1, maximum: 100 } } },
  },
];

/** tools/list-Eintraege der Plugin-Menge (fest). */
export function pluginToolListe(): Array<Record<string, unknown>> {
  return PLUGIN_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { title: t.title, ...ANNOTATIONEN[t.name] },
  }));
}

export interface PluginFreigabe {
  aktiv: boolean;
  lesen: boolean;
  auftraege: boolean;
  kontakte: boolean;
}

/** Hinweis, wenn die Organisation einen Bereich nicht freigeschaltet hat; null = erlaubt. */
export function pluginSperre(t: PluginTool, s: PluginFreigabe): string | null {
  if (!s.aktiv) {
    return "AVA ist für ChatGPT in deiner Organisation noch nicht freigeschaltet. Eine Person mit Admin-Rechten schaltet es in der AVA-App unter Einstellungen → Organisation → MCP ein.";
  }
  if (t.schalter === "kontakte" && !s.kontakte) {
    return "Ansprechpartner sind für ChatGPT in deiner Organisation nicht freigegeben. Eine Person mit Admin-Rechten kann das in der AVA-App unter Einstellungen → Organisation → MCP einschalten. Kontakte siehst du solange direkt in AVA.";
  }
  if (t.schalter === "auftraege" && !s.auftraege) {
    return "Aufträge über ChatGPT (Importe, Notizen, Neuverarbeitung) sind in deiner Organisation abgeschaltet. Das geht weiterhin direkt in der AVA-App.";
  }
  if (t.schalter === "lesen" && !s.lesen) {
    return "Lesen über ChatGPT ist in deiner Organisation abgeschaltet.";
  }
  return null;
}

// ---- C2: schlanke Antworten -------------------------------------------------

/** Felder, die nie an ChatGPT gehen (interne Kennungen, Technik, Rohdaten). */
const WEG = new Set([
  "tenantId", "actorId", "ownerId", "userId", "userIds", "createdBy", "updatedBy", "requestedBy",
  "requestId", "traceId", "sessionId", "correlationId", "jobId", "messageId", "workerId", "instanceId",
  "lastObsId", "obsId", "observationId", "sourceId", "rawId",
  "hash", "contentHash", "checksum", "fingerprint", "normalized", "identityKey", "scopeCompanyId",
  "raw", "rawJson", "rawPayload", "payloadRaw", "html", "markdown", "embedding", "vector", "vektor",
  "debug", "log", "logs", "stack", "errorStack",
  "deletedAt", "deactivatedAt", "deactivatedReason", "lastSeenAt",
  "confidence", "held", "zugang", "gesellschafterStand",
]);
// createdAt/updatedAt bleiben (Meldungen, Notizen und Vorgaenge tragen darin ihr Datum),
// werden aber wie alle Zeitstempel auf den Tag gekuerzt.

const ISO_ZEIT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/;

/** Rekursiv: interne Felder weg, Zeitstempel auf das Datum, leere Werte weg. */
export function saeubern(v: unknown, tiefe = 0): unknown {
  if (tiefe > 12) return undefined;
  if (typeof v === "string") {
    const m = ISO_ZEIT.exec(v);
    return m ? m[1] : v;
  }
  if (Array.isArray(v)) {
    if (v.length > 200 && typeof v[0] === "number") return undefined;
    const out = v.map((x) => saeubern(x, tiefe + 1)).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith("_") || WEG.has(k)) continue;
      const s = saeubern(w, tiefe + 1);
      if (s === undefined || s === null || s === "") continue;
      out[k] = s;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v ?? undefined;
}

type Zeile = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Kontakte (Rohfakten der Kontakt-DB) als schlanke Personenliste. */
export function kontakteSchlank(roh: unknown, companyId: string): Record<string, unknown> {
  const j = (roh ?? {}) as { companyName?: string; websiteUrl?: string; companyFacts?: Zeile[]; employments?: Zeile[] };
  const fakten = (j.companyFacts ?? []).filter((f) => f.entityType === "PERSON" && f.status === "ACTIVE");
  const jePerson = new Map<string, Map<string, { value: string; quelle: string | null; eigen: boolean }>>();
  for (const f of fakten) {
    const pid = str(f.entityId);
    const feld = str(f.field);
    const wert = str(f.value);
    if (!pid || !feld || !wert) continue;
    const m = jePerson.get(pid) ?? new Map();
    // Fakten DIESER Firma gewinnen (die Route sortiert sie zuerst).
    if (!m.has(feld)) m.set(feld, { value: wert, quelle: str(f.lastSource), eigen: f.companyId === companyId });
    jePerson.set(pid, m);
  }
  const aktuell = new Map<string, Zeile>();
  for (const e of j.employments ?? []) {
    const pid = str(e.personId);
    if (!pid || e.isCurrent === false) continue;
    if (!aktuell.has(pid)) aktuell.set(pid, e);
  }
  const personen: Record<string, unknown>[] = [];
  for (const [pid, e] of aktuell) {
    const m = jePerson.get(pid);
    const name = m?.get("fullName")?.value ?? [m?.get("firstName")?.value, m?.get("lastName")?.value].filter(Boolean).join(" ");
    if (!name) continue;
    const mail = m?.get("email");
    const quelle = [mail?.quelle, m?.get("jobTitle")?.quelle, m?.get("fullName")?.quelle].find((q) => q && /^https?:\/\//.test(q)) ?? null;
    const start = str(e.startDate);
    const p: Record<string, unknown> = {
      personId: pid,
      name,
      rolle: str(e.title) ?? m?.get("jobTitle")?.value ?? null,
      bereich: str(e.department) ?? m?.get("department")?.value ?? null,
      seit: start ? start.slice(0, 10) : null,
      email: mail?.value ?? null,
      // Adressen aus dem Firmenmuster sind abgeleitet, nicht gefunden.
      emailArt: mail ? (/^(pattern|zuordnung):/.test(mail.quelle ?? "") ? "abgeleitet" : "gefunden") : null,
      telefon: m?.get("phone")?.value ?? m?.get("mobilePhone")?.value ?? null,
      profil: m?.get("linkedinUrl")?.value ?? m?.get("xingUrl")?.value ?? null,
      quelle,
    };
    personen.push(saeubern(p) as Record<string, unknown>);
  }
  personen.sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
  return { firma: str(j.companyName), website: str(j.websiteUrl), anzahl: personen.length, personen };
}

/** Meine Firmen: nur Name, Ort, Land, Status und Verarbeitungsstand je Firma. */
export function meineFirmenSchlank(roh: unknown, stand: (zeile: Zeile) => string): Record<string, unknown> {
  const j = (roh ?? {}) as { pageNumber?: number; pageSize?: number; count?: number; companies?: Zeile[] };
  return {
    seite: j.pageNumber ?? 1,
    gesamt: j.count ?? (j.companies ?? []).length,
    firmen: (j.companies ?? []).map((z) =>
      saeubern({
        companyId: z.companyId,
        name: z.name,
        ort: z.location,
        land: z.country,
        registerStatus: z.registerStatus === "ACTIVE" ? undefined : z.registerStatus,
        insolvenz: z.insolvencyStatus === "NONE" ? undefined : z.insolvencyStatus,
        ruhend: z.zustand === "ruhend" ? true : undefined,
        verarbeitung: stand(z),
      }),
    ),
  };
}

/** Schlanke Fassung einer Werkzeug-Antwort fuer das Plugin. */
export function pluginAntwort(name: string, daten: unknown, args: Record<string, unknown>, stand: (zeile: Zeile) => string): Record<string, unknown> {
  let out: unknown;
  if (name === "firma_kontakte") out = kontakteSchlank(daten, String(args.companyId ?? ""));
  else if (name === "meine_firmen") out = meineFirmenSchlank(daten, stand);
  else out = saeubern(daten);
  if (out && typeof out === "object" && !Array.isArray(out)) return out as Record<string, unknown>;
  return { ergebnis: out ?? null };
}
