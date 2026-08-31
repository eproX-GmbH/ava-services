// Phase 2 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Mini-Profil.
//
// Fuer offene Kandidaten mit Website: Kurzcrawl (Startseite + bis zu 4
// relevante Unterseiten wie Impressum/Leistungen, robots.txt wird
// respektiert) → kompaktes deutsches Firmen-Profil per LLM (nutzt das
// GUENSTIGE Producer-Modell, falls konfiguriert — Hintergrundarbeit
// gehoert nicht aufs Chat-Modell) → 768d-Embedding lokal via Ollama →
// zentral ans Gateway (einer verarbeitet, alle profitieren).
//
// Verarbeitungs-Sperre A9: profiledAt juenger als 6 Monate → Kandidat
// wird uebersprungen. Client-seitig vorgefiltert, serverseitig beim
// PUT nochmal durchgesetzt (Schutz gegen parallel arbeitende Nutzer).
//
// Kein Bot-Detection-Bypass (A7): schlaegt ein Abruf fehl (auch 403 &
// Co.), wird die Firma in diesem Lauf einfach uebersprungen —
// profiledAt bleibt leer, ein spaeterer Lauf versucht es erneut.

import * as yup from "yup";
import { BrowserWindow } from "electron";
import type { GatewayClient } from "../agent/gateway-client";
import type { LlmProviderManager } from "../agent/providers";
import {
  buildMessages,
  parseJsonObject,
  streamToText,
} from "../link-monitor/llm";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const USER_AGENT = "AVA-Desktop-Discovery/0.1 (+https://github.com/eproX-GmbH)";
const PAGE_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 600_000;
const MAX_SUBPAGES = 4;
const MAX_TEXT_PER_PAGE = 6_000;
const PROFILE_MAX_AGE_MS = 6 * 30 * 24 * 3600 * 1000; // A9: 6 Monate

const SUBPAGE_RE =
  /impressum|imprint|leistung|service|angebot|produkt|portfolio|referenz|ueber-?uns|über-?uns|about|unternehmen|kompetenz|branche/i;

const profileSchema = yup.object({
  branche: yup.string().trim().min(2).max(120).required(),
  kurzbeschreibung: yup.string().trim().min(20).max(500).required(),
  leistungen: yup.array().of(yup.string().trim().min(2).max(120).required()).min(1).max(10).required(),
  zielkunden: yup.string().trim().max(300).default(""),
  region: yup.string().trim().max(160).default(""),
  groessenIndiz: yup.string().trim().max(200).default(""),
  keywords: yup.array().of(yup.string().trim().min(2).max(60).required()).max(12).default([]),
});

export type MiniProfile = yup.InferType<typeof profileSchema>;

export interface ProfilerSummary {
  betrachtet: number;
  profiliert: number;
  uebersprungenFrisch: number;
  crawlFehler: number;
  llmFehler: number;
  ohneEmbedding: number;
  dauerSek: number;
  beispiele: Array<{ name: string; branche: string }>;
  /** v0.1.474 — IDs, deren Crawl/LLM scheiterte (Backoff im Worker). */
  fehlgeschlagenIds: string[];
}

// ---- Crawl -----------------------------------------------------------------

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text")) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total > MAX_PAGE_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&szlig;/g, "ß")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_PER_PAGE);
}

/** Minimaler robots.txt-Check: Disallow-Prefixe fuer User-agent *. */
async function fetchDisallows(base: string): Promise<string[]> {
  try {
    const res = await fetch(`${base}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const text = (await res.text()).slice(0, 50_000);
    const out: string[] = [];
    let forAll = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const ua = /^user-agent:\s*(.+)$/i.exec(line);
      if (ua) {
        forAll = ua[1]!.trim() === "*";
        continue;
      }
      if (!forAll) continue;
      const dis = /^disallow:\s*(\S+)/i.exec(line);
      if (dis?.[1] && dis[1] !== "/") out.push(dis[1]);
      // "Disallow: /" fuer alle → ganze Site tabu.
      if (dis?.[1] === "/") return ["/"];
    }
    return out;
  } catch {
    return [];
  }
}

function isAllowed(path: string, disallows: string[]): boolean {
  return !disallows.some((d) => path.startsWith(d));
}

export function pickSubpageLinks(html: string, base: URL, coreDomain: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 30) {
    const href = m[1]!;
    if (!SUBPAGE_RE.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (!u.hostname.endsWith(coreDomain)) continue;
      u.hash = "";
      u.search = "";
      const key = u.toString();
      if (seen.has(key) || key === base.toString()) continue;
      seen.add(key);
      out.push(key);
    } catch {
      /* unbrauchbarer Link */
    }
  }
  return out.slice(0, MAX_SUBPAGES);
}

// ---- Browser-Fallback ------------------------------------------------------
//
// Plain-HTTP scheitert an JS-gerenderten Seiten (SPA liefert leeres
// HTML) und an Bot-Gates, die den schlichten fetch-UA ablehnen. Dann
// laedt ein verstecktes Electron-Fenster die Seite wie ein echter
// Browser und liest das GERENDERTE innerText. Serialisiert (Mutex),
// damit parallele Crawls keine Fenster-Flut erzeugen. Kein Bypass von
// Challenges (A7): wenn die Seite nach dem Rendern leer bleibt, bleibt
// sie leer.

let browserFetchChain: Promise<unknown> = Promise.resolve();

async function fetchTextViaBrowser(url: string): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    let win: BrowserWindow | null = null;
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          backgroundThrottling: false,
          images: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      // v0.1.481 — Helfer-Fenster nie im macOS-Fenster-/Dock-Menue listen.
      win.excludedFromShownWindowsMenu = true;
      await Promise.race([
        win.loadURL(url),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("browser timeout")), 25_000),
        ),
      ]);
      // Kurz rendern lassen (Hydration/Nachlade-Inhalte).
      await new Promise((r) => setTimeout(r, 2_500));
      const text = (await win.webContents.executeJavaScript(
        "document.body ? document.body.innerText : ''",
        true,
      )) as string;
      const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
      return cleaned.length >= 200 ? cleaned.slice(0, 30_000) : null;
    } catch {
      return null;
    } finally {
      try {
        win?.destroy();
      } catch {
        /* schon zu */
      }
    }
  };
  const result = browserFetchChain.then(run, run);
  browserFetchChain = result.catch(() => null);
  return result as Promise<string | null>;
}

/** Website eines Kandidaten kurz crawlen. null = nicht erreichbar.
 *
 *  `startUrl` (optional): exakte Einstiegs-URL inkl. Pfad — wichtig fuer
 *  Kunden-Beispiele im ICP-Assistenten (z. B. der konkrete
 *  Engel-&-Voelkers-Shop statt der globalen Konzern-Startseite).
 *  Ohne startUrl wird wie bisher die Domain-Wurzel (+www-Fallback)
 *  genommen. */
export async function crawlSite(
  coreDomain: string,
  startUrl?: string,
): Promise<string | null> {
  let homeHtml: string | null = null;
  let base: URL | null = null;
  const starts = startUrl
    ? [startUrl, `https://${coreDomain}`]
    : [`https://${coreDomain}`, `https://www.${coreDomain}`];
  for (const candidate of starts) {
    homeHtml = await fetchPageText(candidate);
    if (homeHtml) {
      base = new URL(candidate);
      break;
    }
  }
  // Duennes/leeres statisches HTML (SPA, Bot-Gate) → Browser-Fallback:
  // gerendertes innerText aus einem versteckten Electron-Fenster. Das
  // Ergebnis ist bereits Text (kein HTML) und hat keine Links fuer den
  // Unterseiten-Crawl — fuer die LLM-Analyse reicht die gerenderte
  // Startseite in der Praxis aus.
  if (!homeHtml || htmlToText(homeHtml).length < 200) {
    for (const candidate of starts) {
      const rendered = await fetchTextViaBrowser(candidate);
      if (rendered) return rendered;
    }
  }
  if (!homeHtml || !base) return null;

  const disallows = await fetchDisallows(base.origin);
  if (disallows.includes("/")) {
    // Site verbietet Crawling komplett — respektieren, nur nicht crawlen.
    return null;
  }
  const parts: string[] = [htmlToText(homeHtml)];
  for (const link of pickSubpageLinks(homeHtml, base, coreDomain)) {
    const path = new URL(link).pathname;
    if (!isAllowed(path, disallows)) continue;
    const html = await fetchPageText(link);
    if (html) parts.push(`[Seite ${path}] ${htmlToText(html)}`);
  }
  const text = parts.join("\n\n").trim();
  return text.length >= 200 ? text : null;
}

// ---- LLM + Embedding -------------------------------------------------------

export async function buildProfile(
  providers: LlmProviderManager,
  candidate: { name: string; city: string | null; category: string | null },
  siteText: string,
): Promise<MiniProfile | null> {
  if (!providers.getStatus().ready) return null;
  const system =
    "Du erstellst ein KOMPAKTES deutsches Firmen-Kurzprofil ausschliesslich " +
    "auf Basis des mitgelieferten Website-Texts. Keine Vermutungen ueber " +
    "Dinge, die nicht im Text stehen. KEINE Personennamen aufnehmen. " +
    'Antworte NUR als JSON: {"branche": "...", "kurzbeschreibung": ' +
    '"2-3 Saetze", "leistungen": ["..."], "zielkunden": "...", ' +
    '"region": "...", "groessenIndiz": "z. B. Teamgroesse/Standorte, ' +
    'falls erkennbar, sonst leer", "keywords": ["..."]}';
  const user =
    `Firma: ${candidate.name}` +
    (candidate.city ? ` (${candidate.city})` : "") +
    (candidate.category ? `\nQuell-Kategorie: ${candidate.category}` : "") +
    `\n\nWebsite-Text:\n${siteText.slice(0, 24_000)}`;
  try {
    const raw = await streamToText(
      providers,
      buildMessages(system, user, "discprofile"),
      {
        timeoutMs: 60_000,
        ...(providers.getProducerModelOverride()
          ? { modelOverride: providers.getProducerModelOverride() }
          : {}),
      },
    );
    const parsed = parseJsonObject(raw);
    if (!parsed) return null;
    return profileSchema.validateSync(parsed, { abortEarly: true });
  } catch {
    return null;
  }
}

export function renderProfileText(name: string, city: string | null, p: MiniProfile): string {
  const lines = [
    `${name}${city ? ` (${city})` : ""} — ${p.branche}.`,
    p.kurzbeschreibung,
    `Leistungen: ${p.leistungen.join(", ")}.`,
  ];
  if (p.zielkunden) lines.push(`Zielkunden: ${p.zielkunden}.`);
  if (p.region) lines.push(`Region: ${p.region}.`);
  if (p.groessenIndiz) lines.push(`Groesse: ${p.groessenIndiz}.`);
  if (p.keywords.length > 0) lines.push(`Stichworte: ${p.keywords.join(", ")}.`);
  return lines.join("\n");
}

export async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embeddinggemma:latest", input: [text] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { embeddings?: number[][] };
    return json.embeddings?.[0] ?? null;
  } catch {
    return null;
  }
}

// ---- Lauf ------------------------------------------------------------------

interface CandidateForProfiling {
  discoveryId: string;
  name: string;
  city: string | null;
  category: string | null;
  domain: string;
  profiledAt: string | null;
}

/** Prioritaets-Sortierung: Kandidaten, deren Kategorie oder Name zu den
 *  ICP-Branchen passt, werden ZUERST profiliert — so liefern schon die
 *  ersten Laeufe echte Treffer statt ehrlicher Absagen. Substring in
 *  beide Richtungen ("Immobilien" ↔ "Immobilienmakler"). */
function prioritize<T extends { name: string; category: string | null }>(
  candidates: T[],
  terms: string[],
): T[] {
  const t = terms.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 2);
  if (t.length === 0) return candidates;
  const matches = (c: T): boolean => {
    const hay = `${c.category ?? ""} ${c.name}`.toLowerCase();
    return t.some((term) => hay.includes(term) || (c.category ?? "").toLowerCase().length > 2 && term.includes((c.category ?? "").toLowerCase()));
  };
  const hit: T[] = [];
  const rest: T[] = [];
  for (const c of candidates) (matches(c) ? hit : rest).push(c);
  return [...hit, ...rest];
}

export async function runProfiler(
  gateway: GatewayClient,
  providers: LlmProviderManager,
  opts: {
    limit: number;
    /** ICP-Branchen fuer die Prioritaets-Sortierung (optional). */
    prioritizeTerms?: string[];
    /** v0.1.474 — Kandidaten mit Fehl-Backoff ueberspringen. */
    exclude?: Set<string>;
    /** v0.1.474 — true = LLM gerade anderweitig gebraucht (Chat-Turn)
     *  → Worker wartet zwischen Kandidaten, statt zu konkurrieren. */
    shouldPause?: () => boolean;
  },
): Promise<ProfilerSummary | { error: string }> {
  const t0 = Date.now();
  let all: CandidateForProfiling[];
  try {
    const r = await gateway.request<{ candidates: CandidateForProfiling[] }>(
      "/v1/discovery/candidates?limit=500",
    );
    all = r.candidates;
  } catch (err) {
    return {
      error: `Kandidaten-Abruf fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // A9-Vorfilter: nur Kandidaten ohne (aktuelles) Profil.
  const now = Date.now();
  const due = all.filter(
    (c) =>
      (!c.profiledAt || now - Date.parse(c.profiledAt) > PROFILE_MAX_AGE_MS) &&
      !opts.exclude?.has(c.discoveryId),
  );
  const batch = prioritize(due, opts.prioritizeTerms ?? []).slice(0, opts.limit);

  const summary: ProfilerSummary = {
    betrachtet: batch.length,
    profiliert: 0,
    uebersprungenFrisch: 0,
    crawlFehler: 0,
    llmFehler: 0,
    ohneEmbedding: 0,
    dauerSek: 0,
    beispiele: [],
    fehlgeschlagenIds: [],
  };
  if (batch.length === 0) {
    summary.dauerSek = Math.round((Date.now() - t0) / 1000);
    return summary;
  }

  // v0.1.474 — Concurrency 3 (Crawls ueberlappen; das LLM serialisiert
  // sich bei Ollama ohnehin selbst). Zwischen Kandidaten wird pausiert,
  // wenn der Nutzer gerade aktiv chattet (shouldPause).
  const queue = [...batch];
  const workers = Array.from({ length: 3 }, async () => {
    for (;;) {
      const cand = queue.shift();
      if (!cand) return;
      // Aktiver Chat-Turn hat Vorrang vor Hintergrund-Profilen.
      while (opts.shouldPause?.()) {
        await new Promise((r) => setTimeout(r, 5_000));
      }
      const siteText = await crawlSite(cand.domain);
      if (!siteText) {
        summary.crawlFehler++;
        summary.fehlgeschlagenIds.push(cand.discoveryId);
        continue;
      }
      const profile = await buildProfile(providers, cand, siteText);
      if (!profile) {
        summary.llmFehler++;
        summary.fehlgeschlagenIds.push(cand.discoveryId);
        continue;
      }
      const profileText = renderProfileText(cand.name, cand.city, profile);
      const embedding = await embedText(profileText);
      if (!embedding) summary.ohneEmbedding++;
      try {
        const res = await gateway.request<{ saved: boolean; skipped?: string }>(
          `/v1/discovery/candidates/${encodeURIComponent(cand.discoveryId)}/profile`,
          {
            method: "PUT",
            body: { profileJson: profile, profileText, embedding },
          },
        );
        if (res.saved) {
          summary.profiliert++;
          if (summary.beispiele.length < 5) {
            summary.beispiele.push({ name: cand.name, branche: profile.branche });
          }
        } else {
          summary.uebersprungenFrisch++;
        }
      } catch (err) {
        console.warn(
          `[discovery] Profil-Upload fuer ${cand.discoveryId} fehlgeschlagen:`,
          err,
        );
        summary.llmFehler++;
      }
    }
  });
  await Promise.all(workers);

  summary.dauerSek = Math.round((Date.now() - t0) / 1000);
  return summary;
}
