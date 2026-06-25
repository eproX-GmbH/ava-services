// LM2 — Browse-Engine für die Link-Überwachung.
//
// Öffnet eine beliebige URL in einem versteckten Electron-BrowserWindow,
// simuliert menschliches Verhalten (Scrollen mit Jitter), folgt optional
// einfacher Pagination und gibt den sichtbaren Seitentext zurück. Die
// LLM-gestützte Interpretation (was beobachten, Diff) macht der Extractor
// in einem späteren Schritt — diese Engine liefert nur das Rohmaterial.
//
// Architektur: bewusst dasselbe Vorgehen wie der LinkedIn-Scraper
// (main/linkedin/scraper-window.ts) — verstecktes Fenster, Stealth-
// Injektion pro Navigation. Für LinkedIn-URLs nutzen wir die
// `persist:linkedin`-Partition, in der die Login-Cookies des Nutzers
// bereits liegen (kein Re-Inject nötig — exakt wie die
// Signalüberwachung). Generische URLs bekommen eine eigene,
// persistente `persist:link-monitor`-Partition.
//
// Rein LOKAL: alles läuft im Desktop-Main-Process des Nutzers.

import { BrowserWindow } from "electron";
import { LINK_MONITOR_RUN_TIMEOUT_MS } from "../../shared/types";
import { read as readLinkedInSettings } from "../linkedin/store";
import { buildStealthInjection } from "../linkedin/stealth";

export interface BrowseResult {
  /** URL nach evtl. Redirects. */
  finalUrl: string;
  title: string;
  /** Sichtbarer, normalisierter Seitentext (ggf. gekürzt). */
  text: string;
  /** Bei Pagination: Text je besuchter Seite (inkl. Startseite). */
  pages: string[];
  /** true, wenn wegen Deadline/Längenlimit abgeschnitten wurde. */
  truncated: boolean;
  /** Anzahl tatsächlich besuchter Seiten (1 = keine Pagination). */
  pagesVisited: number;
  /** Nicht-fatale Notiz (z. B. „Login fehlt", „Timeout"). */
  note: string | null;
}

export interface BrowseOptions {
  /** true → persist:linkedin-Partition (eingeloggte Session nutzen). */
  isLinkedIn: boolean;
  /** Freitext-Anweisungen; steuert nur, ob wir Pagination versuchen. */
  instructions?: string;
  signal?: AbortSignal;
  /** Absolute Deadline (Date.now()-Basis). Default: jetzt + 3 Min. */
  deadlineAt?: number;
  /** Max Scroll-Schritte pro Seite (Default 8). */
  maxScrolls?: number;
  /** Max Pagination-Seiten (Default 5). */
  maxPages?: number;
}

/** Obergrenze für den extrahierten Text pro Seite (Zeichen). Schützt vor
 *  riesigen Seiten und hält den LLM-Diff bezahlbar. */
const MAX_TEXT_PER_PAGE = 40_000;
const MAX_TOTAL_TEXT = 120_000;

class DeadlineError extends Error {
  constructor() {
    super("link-monitor: run deadline reached");
    this.name = "DeadlineError";
  }
}

function nowPastDeadline(deadlineAt: number): boolean {
  return Date.now() >= deadlineAt;
}

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** loadURL mit Deadline-/Abort-Schutz. Wirft bei Timeout NICHT — gibt
 *  false zurück, damit wir den Teil-DOM trotzdem auslesen können. */
async function navigateWithDeadline(
  win: BrowserWindow,
  url: string,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const budget = Math.max(2000, Math.min(60_000, deadlineAt - Date.now()));
  const load = win.webContents
    .loadURL(url)
    .then(() => true)
    .catch(() => false);
  const timeout = new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), budget);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve(false);
      },
      { once: true },
    );
  });
  return Promise.race([load, timeout]);
}

/** Sichtbaren Text + Titel + finale URL aus dem aktuellen DOM lesen. */
async function extractVisibleText(win: BrowserWindow): Promise<{
  title: string;
  text: string;
  finalUrl: string;
}> {
  const js = `(() => {
    const pick = (s) => (typeof s === "string" ? s : "");
    let text = "";
    try {
      // innerText respektiert grob die Sichtbarkeit (display:none etc.).
      text = pick(document.body && document.body.innerText);
    } catch (e) { text = ""; }
    // Whitespace normalisieren, Leerzeilen zusammenfassen.
    text = text.replace(/[ \\t\\f\\v]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
    return {
      title: pick(document.title),
      finalUrl: pick(location.href),
      text: text.slice(0, ${MAX_TEXT_PER_PAGE}),
    };
  })()`;
  try {
    const res = (await win.webContents.executeJavaScript(js, false)) as {
      title: string;
      text: string;
      finalUrl: string;
    };
    return res;
  } catch {
    return { title: "", text: "", finalUrl: win.webContents.getURL() };
  }
}

/** Menschliches Scrollen: schrittweise nach unten mit Jitter-Pausen, bis
 *  ans Seitenende oder maxScrolls/Deadline. Lädt Infinite-Scroll-Inhalte
 *  nach. */
async function humanScroll(
  win: BrowserWindow,
  maxScrolls: number,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<void> {
  let lastHeight = 0;
  for (let i = 0; i < maxScrolls; i++) {
    if (nowPastDeadline(deadlineAt) || signal?.aborted) return;
    const height = (await win.webContents
      .executeJavaScript(
        `(() => { try { window.scrollBy(0, Math.round(window.innerHeight*0.9)); } catch(e){}
                  return Math.round(document.body ? document.body.scrollHeight : 0); })()`,
        false,
      )
      .catch(() => 0)) as number;
    await sleep(jitter(600, 1400), signal).catch(() => undefined);
    // Seite wächst nicht mehr → wahrscheinlich am Ende.
    if (height && height === lastHeight) return;
    lastHeight = height;
  }
}

/** Versucht, einen „nächste Seite"-Link/Button zu finden und zu klicken.
 *  Best-effort: rel=next, aria-label/Text „Weiter"/„Next"/„›". Gibt true
 *  zurück, wenn geklickt wurde (Navigation/AJAX wahrscheinlich). */
async function clickNextPage(win: BrowserWindow): Promise<boolean> {
  const js = `(() => {
    const cands = [];
    const push = (el) => { if (el) cands.push(el); };
    push(document.querySelector('a[rel="next"]'));
    push(document.querySelector('[aria-label="Next"],[aria-label="Weiter"],[aria-label="Nächste Seite"]'));
    const txt = ["weiter","nächste","naechste","next","mehr laden","load more","show more","›","»"];
    const all = Array.from(document.querySelectorAll('a,button'));
    for (const el of all) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t) continue;
      if (txt.some((k) => t === k || t.includes(k))) { push(el); break; }
    }
    const target = cands.find((el) => el && !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true');
    if (!target) return false;
    try { target.scrollIntoView({block:'center'}); } catch(e) {}
    try { target.click(); return true; } catch(e) { return false; }
  })()`;
  try {
    return (await win.webContents.executeJavaScript(js, false)) as boolean;
  } catch {
    return false;
  }
}

function wantsPagination(instructions: string | undefined): boolean {
  if (!instructions) return false;
  const t = instructions.toLowerCase();
  return (
    t.includes("pagination") ||
    t.includes("seiten") ||
    t.includes("blätter") ||
    t.includes("blaetter") ||
    t.includes("weiter") ||
    t.includes("alle ") ||
    t.includes("durchgehen") ||
    t.includes("nächste") ||
    t.includes("naechste") ||
    t.includes("load more") ||
    t.includes("mehr laden")
  );
}

function createWindow(isLinkedIn: boolean): BrowserWindow {
  const fp = readLinkedInSettings().fingerprint;
  const width = fp?.viewport.width ?? 1440;
  const height = fp?.viewport.height ?? 900;
  const debugWindow = process.env.AVA_LINK_MONITOR_DEBUG_WINDOW === "1";
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    x: debugWindow ? undefined : -2000,
    y: debugWindow ? undefined : -2000,
    skipTaskbar: !debugWindow,
    focusable: debugWindow,
    frame: debugWindow,
    webPreferences: {
      // LinkedIn-URLs erben die eingeloggte Session aus persist:linkedin.
      partition: isLinkedIn ? "persist:linkedin" : "persist:link-monitor",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: false,
    },
  });
  (win as unknown as { __avaLinkMonitor?: boolean }).__avaLinkMonitor = true;
  if (!debugWindow) {
    try {
      (
        win as unknown as { excludedFromShownWindowsMenu?: boolean }
      ).excludedFromShownWindowsMenu = true;
    } catch {
      /* nur macOS */
    }
    try {
      win.setOpacity(0);
    } catch {
      /* ignore */
    }
    try {
      win.setIgnoreMouseEvents(true);
    } catch {
      /* ignore */
    }
  }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (fp) {
    try {
      win.webContents.setUserAgent(fp.userAgent);
      win.webContents.session.setUserAgent(fp.userAgent);
    } catch {
      /* ignore */
    }
    // Stealth pro Navigation injizieren (auch SPA-Routen).
    const stealthJs = buildStealthInjection(fp);
    const reinject = (): void => {
      if (!win.isDestroyed()) {
        win.webContents.executeJavaScript(stealthJs, false).catch(() => undefined);
      }
    };
    win.webContents.on("did-start-navigation", reinject);
    win.webContents.on("dom-ready", reinject);
  }
  return win;
}

/**
 * Öffnet die URL, verhält sich menschlich, folgt optional Pagination und
 * liefert den sichtbaren Text. Wirft NIE wegen Timeout — gibt das bis zur
 * Deadline gesammelte Teilergebnis mit `truncated`/`note` zurück. Echte
 * Abbrüche (signal.abort) werfen AbortError.
 */
export async function browseUrl(
  url: string,
  opts: BrowseOptions,
): Promise<BrowseResult> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + LINK_MONITOR_RUN_TIMEOUT_MS;
  const maxScrolls = opts.maxScrolls ?? 8;
  const maxPages = opts.maxPages ?? 5;
  const paginate = wantsPagination(opts.instructions);

  const win = createWindow(opts.isLinkedIn);
  const pages: string[] = [];
  let title = "";
  let finalUrl = url;
  let truncated = false;
  let note: string | null = null;

  try {
    const loaded = await navigateWithDeadline(
      win,
      url,
      deadlineAt,
      opts.signal,
    );
    if (!loaded) {
      note = "Seite nicht (vollständig) geladen — Teilergebnis.";
      truncated = true;
    }
    // Erste Seite: settle + scroll + extract.
    await sleep(jitter(800, 1600), opts.signal).catch(() => undefined);

    let totalLen = 0;
    let pagesVisited = 0;
    for (let p = 0; p < (paginate ? maxPages : 1); p++) {
      if (nowPastDeadline(deadlineAt)) {
        truncated = true;
        break;
      }
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

      await humanScroll(win, maxScrolls, deadlineAt, opts.signal);
      const snap = await extractVisibleText(win);
      if (p === 0) {
        title = snap.title;
        finalUrl = snap.finalUrl;
      }
      if (snap.text) {
        pages.push(snap.text);
        totalLen += snap.text.length;
        pagesVisited++;
      }
      if (totalLen >= MAX_TOTAL_TEXT) {
        truncated = true;
        break;
      }
      if (!paginate) break;
      if (p < maxPages - 1) {
        if (nowPastDeadline(deadlineAt)) {
          truncated = true;
          break;
        }
        const clicked = await clickNextPage(win);
        if (!clicked) break; // keine weitere Seite
        await sleep(jitter(1000, 2000), opts.signal).catch(() => undefined);
      }
    }

    const text = pages.join("\n\n---\n\n").slice(0, MAX_TOTAL_TEXT);
    return {
      finalUrl,
      title,
      text,
      pages,
      truncated,
      pagesVisited: Math.max(pagesVisited, pages.length),
      note,
    };
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
  }
}

export { DeadlineError };
