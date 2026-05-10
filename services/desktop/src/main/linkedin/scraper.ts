// LinkedIn-Beobachter feed scraper (Phase L2).
//
// Drives a hidden Electron BrowserWindow against the user's already-
// authenticated `persist:linkedin` partition. Cookies were captured by
// the L1 login flow — we don't re-inject them, the partition holds
// them automatically. We override the user-agent from the L0
// fingerprint to match what we presented during login.
//
// We deliberately ship NO Playwright. Reasons:
//   1) Zero extra deps; the Electron API is enough to navigate, scroll,
//      and run extractor JS in-page.
//   2) `persist:linkedin` cookies are already there.
//   3) If LinkedIn's bot detection forces a Playwright pivot in L7,
//      this module's API stays internal and can swap engines locally.
//
// Selectors live as STRING constants below — they will break on the
// next LinkedIn UI shift. Search for SELECTOR-FRAGILE before debugging.

import { app, BrowserWindow, net } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type {
  LinkedInScanOutcome,
  LinkedInScanResult,
} from "../../shared/types";
import { read as readSettings, write as writeSettings } from "./store";
import { hasStoredSession } from "./session";
import {
  closeDb,
  enqueueImageAnalysis,
  enqueueSignal,
  feedCounts,
  finishScanRun,
  getDb,
  insertMedia,
  latestScanRun,
  startScanRun,
  upsertActor,
  upsertInteraction,
  upsertPost,
} from "./db";
import { drainQueue } from "./extractor";
import { buildStealthInjection } from "./stealth";

export interface ScanOptions {
  manual: boolean;
  /** Default 30. */
  maxPosts?: number;
  signal?: AbortSignal;
}

interface RawPostExtract {
  postUrn: string;
  postKind:
    | "text"
    | "image"
    | "video"
    | "article"
    | "document"
    | "repost"
    | "event";
  postedAtRelative: string | null;
  permalink: string | null;
  externalUrl: string | null;
  text: string;
  rawHtml: string;
  author: {
    actorUrn: string;
    displayName: string;
    headline: string | null;
    profileUrl: string | null;
  };
  mediaUrls: Array<{ kind: "image" | "video" | "document"; url: string }>;
  surfacedInteractions: Array<{
    actor: {
      actorUrn: string;
      displayName: string;
      headline: string | null;
      profileUrl: string | null;
    };
    kind: "like" | "comment" | "share";
    commentText: string | null;
  }>;
}

let running = false;
let activeAbort: AbortController | null = null;

export function isScanRunning(): boolean {
  return running;
}

/** Surface the active AbortController so the IPC layer can cancel from
 *  outside. Returns null when no scan is in flight. */
export function cancelActiveScan(): boolean {
  if (!activeAbort) return false;
  activeAbort.abort();
  return true;
}

// ---- Utilities ----------------------------------------------------------

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

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message === "aborted")
  );
}

function mediaDir(): string {
  return join(app.getPath("userData"), "linkedin", "media");
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function extFromUrlOrType(
  url: string,
  contentType: string | null,
  kind: "image" | "video" | "document",
): string {
  const fromUrl = extname(new URL(url, "https://x.invalid").pathname).toLowerCase();
  if (fromUrl && fromUrl.length <= 6) return fromUrl;
  if (contentType) {
    const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (ct.startsWith("image/")) return "." + ct.slice(6).replace("jpeg", "jpg");
    if (ct.startsWith("video/")) return "." + ct.slice(6);
    if (ct === "application/pdf") return ".pdf";
  }
  return kind === "video" ? ".mp4" : kind === "document" ? ".bin" : ".jpg";
}

const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB

async function downloadMedia(
  url: string,
  kind: "image" | "video" | "document",
  postUrn: string,
  signal: AbortSignal,
): Promise<{ id: string; localPath: string; bytes: number } | null> {
  // We use Electron's `net` module rather than the BrowserWindow so
  // LinkedIn's in-page tracking doesn't re-trigger on the download.
  const req = net.request({ url, method: "GET", redirect: "follow" });
  return await new Promise((resolve) => {
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      try {
        req.abort();
      } catch {
        // ignore
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const chunks: Buffer[] = [];
    let total = 0;
    let contentType: string | null = null;
    let oversized = false;

    req.on("response", (res) => {
      contentType = res.headers["content-type"]
        ? Array.isArray(res.headers["content-type"])
          ? res.headers["content-type"][0] ?? null
          : (res.headers["content-type"] as string)
        : null;
      res.on("data", (chunk: Buffer) => {
        if (oversized) return;
        total += chunk.length;
        if (total > MAX_MEDIA_BYTES) {
          oversized = true;
          try {
            req.abort();
          } catch {
            // ignore
          }
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        signal.removeEventListener("abort", onAbort);
        if (aborted || oversized) {
          resolve(null);
          return;
        }
        const buf = Buffer.concat(chunks);
        const id = createHash("sha256").update(buf).digest("hex");
        const ext = extFromUrlOrType(url, contentType, kind);
        const safePostDir = encodeURIComponent(postUrn);
        const dir = join(mediaDir(), safePostDir);
        ensureDir(dir);
        const localPath = join(dir, id + ext);
        try {
          writeFileSync(localPath, buf);
        } catch (err) {
          console.warn(
            "[linkedin/scraper] media write failed:",
            err instanceof Error ? err.message : String(err),
          );
          resolve(null);
          return;
        }
        resolve({ id, localPath, bytes: buf.length });
      });
      res.on("error", () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      });
    });
    req.on("error", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(null);
    });
    req.end();
  });
}

/** Best-effort parser for LinkedIn relative timestamps in DE + EN.
 *  Returns null when the input is unparseable; callers should fall
 *  back to "now - 1 minute" so posted_at stays non-null for the L3
 *  rules engine. */
export function parseRelativeGerman(
  s: string | null,
  now: Date = new Date(),
): Date | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (/^(jetzt|gerade eben|now|just now)/.test(t)) return now;
  // LinkedIn DE: "vor 3 Std", "vor 12 Min", "vor 2 Tagen", "vor 1 Mo", "vor 1 J"
  // LinkedIn EN: "3h", "12m", "2d", "1mo", "1y"
  const deMatch = t.match(
    /vor\s+(\d+)\s*(min|minute|minuten|std|stunde|stunden|tag|tagen|wo|woche|wochen|mo|monat|monate|monaten|jahr|jahre|jahren|j)\b/,
  );
  const enMatch = t.match(/(\d+)\s*(s|m|min|h|hr|d|w|mo|mon|y|yr)\b/);
  let n: number | null = null;
  let unit: string | null = null;
  if (deMatch) {
    n = Number(deMatch[1]);
    unit = (deMatch[2] ?? "").toLowerCase();
  } else if (enMatch) {
    n = Number(enMatch[1]);
    unit = (enMatch[2] ?? "").toLowerCase();
  }
  if (n === null || !unit) return null;
  const ms = (() => {
    if (unit.startsWith("min") || unit === "m") return n * 60_000;
    if (unit.startsWith("std") || unit === "h" || unit === "hr")
      return n * 3_600_000;
    if (unit.startsWith("tag") || unit === "d") return n * 86_400_000;
    if (unit.startsWith("wo") || unit === "w") return n * 7 * 86_400_000;
    if (unit.startsWith("mo") || unit === "mon") return n * 30 * 86_400_000;
    if (unit.startsWith("jahr") || unit === "j" || unit === "y" || unit === "yr")
      return n * 365 * 86_400_000;
    if (unit === "s") return n * 1000;
    return null;
  })();
  if (ms === null) return null;
  return new Date(now.getTime() - ms);
}

// ---- In-page extractor --------------------------------------------------
//
// SELECTOR-FRAGILE: update on next LinkedIn UI shift. The selectors
// below match the feed DOM that LinkedIn was shipping at L2 build
// time. They will silently produce empty arrays when LinkedIn ships
// a renamed class; the scrape will still succeed (just empty) so we
// don't crash, but downstream phases will report 0 new posts.
//
// The function runs in the page context via `executeJavaScript`. It
// receives no closure — everything must be inline.

const EXTRACTOR_SCRIPT = `
(function () {
  function txt(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
  }
  function pickAttr(el, attr) {
    return el && el.getAttribute ? el.getAttribute(attr) : null;
  }
  function urnFromHref(href) {
    if (!href) return null;
    var m = href.match(/in\\/([^/?#]+)/);
    if (m) return "urn:li:profile:" + m[1];
    return null;
  }
  function extractActor(scope) {
    if (!scope) return null;
    var link = scope.querySelector('a[href*="/in/"]');
    var nameEl = scope.querySelector(
      ".update-components-actor__title span[aria-hidden='true'], .update-components-actor__title, .update-components-actor__name"
    );
    var headlineEl = scope.querySelector(
      ".update-components-actor__description"
    );
    var href = link ? link.getAttribute("href") : null;
    var profileUrl = href ? new URL(href, location.origin).toString().split('?')[0] : null;
    var actorUrn = urnFromHref(href);
    var displayName = txt(nameEl) || txt(link);
    if (!displayName && !actorUrn) return null;
    return {
      actorUrn: actorUrn || ("urn:li:anon:" + (profileUrl || displayName || Math.random())),
      displayName: displayName || "Unbekannt",
      headline: txt(headlineEl) || null,
      profileUrl: profileUrl,
    };
  }

  var posts = [];
  var nodes = document.querySelectorAll(
    'div.feed-shared-update-v2[data-urn], div[data-urn^="urn:li:activity:"], div[data-urn^="urn:li:share:"]'
  );

  nodes.forEach(function (node) {
    try {
      var postUrn = node.getAttribute("data-urn");
      if (!postUrn) return;

      var actorScope = node.querySelector(".update-components-actor");
      var author = extractActor(actorScope);
      if (!author) return;

      var bodyEl = node.querySelector(
        ".feed-shared-update-v2__commentary, .update-components-text"
      );
      var text = txt(bodyEl);

      // Best-effort posted-at relative
      var subEl = node.querySelector(
        ".update-components-actor__sub-description, .update-components-actor__sub-description-link"
      );
      var postedAtRelative = txt(subEl) || null;

      // Media
      var mediaUrls = [];
      node.querySelectorAll(".update-components-image img[src]").forEach(function (img) {
        var src = pickAttr(img, "src");
        if (src && src.indexOf("http") === 0) {
          mediaUrls.push({ kind: "image", url: src });
        }
      });
      node.querySelectorAll(".update-components-video video[src], .update-components-video source[src]").forEach(function (v) {
        var src = pickAttr(v, "src");
        if (src && src.indexOf("http") === 0) {
          mediaUrls.push({ kind: "video", url: src });
        }
      });
      node.querySelectorAll(".update-components-document a[href], .update-components-article a[href]").forEach(function (a) {
        var href = pickAttr(a, "href");
        if (href && href.indexOf("http") === 0) {
          mediaUrls.push({ kind: "document", url: href });
        }
      });

      // Article/external link: the article card
      var externalUrl = null;
      var articleLink = node.querySelector(".update-components-article a[href], .feed-shared-article__link-container a[href]");
      if (articleLink) {
        var ah = pickAttr(articleLink, "href");
        if (ah && ah.indexOf("http") === 0) externalUrl = ah;
      }

      // Permalink
      var permalink = null;
      var permaCandidate = node.querySelector('a[href*="/feed/update/"]');
      if (permaCandidate) {
        var ph = pickAttr(permaCandidate, "href");
        if (ph) permalink = new URL(ph, location.origin).toString().split('?')[0];
      }
      if (!permalink) {
        permalink = "https://www.linkedin.com/feed/update/" + encodeURIComponent(postUrn) + "/";
      }

      // Post kind
      var postKind = "text";
      if (mediaUrls.some(function (m) { return m.kind === "video"; })) postKind = "video";
      else if (mediaUrls.some(function (m) { return m.kind === "image"; })) postKind = "image";
      else if (externalUrl) postKind = "article";
      else if (mediaUrls.some(function (m) { return m.kind === "document"; })) postKind = "document";
      if (node.querySelector(".feed-shared-update-v2__update-content-wrapper .feed-shared-update-v2[data-urn]")) postKind = "repost";

      // Surfaced interactions: the "X liked / commented / reposted" header
      var surfaced = [];
      var headerWrapper = node.querySelector(".update-components-header__text-wrapper, .feed-shared-header");
      if (headerWrapper) {
        var headerText = txt(headerWrapper).toLowerCase();
        var actorLink = headerWrapper.querySelector('a[href*="/in/"]');
        if (actorLink) {
          var headerActor = extractActor({
            querySelector: function (sel) {
              if (sel.indexOf('a[href*="/in/"]') >= 0) return actorLink;
              return null;
            },
          });
          if (!headerActor) {
            var hHref = actorLink.getAttribute("href");
            headerActor = {
              actorUrn: urnFromHref(hHref) || "urn:li:anon:" + (hHref || ""),
              displayName: txt(actorLink) || "Unbekannt",
              headline: null,
              profileUrl: hHref ? new URL(hHref, location.origin).toString().split('?')[0] : null,
            };
          }
          var kind = "like";
          if (/kommentier|comment/.test(headerText)) kind = "comment";
          else if (/teilte|geteilt|share|reposted|repostet/.test(headerText)) kind = "share";
          surfaced.push({ actor: headerActor, kind: kind, commentText: null });
        }
      }

      // Cap raw HTML to 64 KB
      var rawHtml = node.outerHTML || "";
      if (rawHtml.length > 64000) rawHtml = rawHtml.slice(0, 64000);

      posts.push({
        postUrn: postUrn,
        postKind: postKind,
        postedAtRelative: postedAtRelative,
        permalink: permalink,
        externalUrl: externalUrl,
        text: text,
        rawHtml: rawHtml,
        author: author,
        mediaUrls: mediaUrls,
        surfacedInteractions: surfaced,
      });
    } catch (err) {
      // swallow per-post extraction errors so one broken post doesn't
      // sink the whole scrape
    }
  });

  // De-duplicate by postUrn (LinkedIn occasionally renders a card twice
  // when surfacing reactions).
  var seen = {};
  var dedup = [];
  posts.forEach(function (p) {
    if (seen[p.postUrn]) return;
    seen[p.postUrn] = true;
    dedup.push(p);
  });
  return dedup;
})()
`;

// ---- Main scan flow -----------------------------------------------------

export async function runScan(opts: ScanOptions): Promise<LinkedInScanResult> {
  if (running) {
    return {
      runId: "",
      outcome: "error",
      postsSeen: 0,
      postsNew: 0,
      interactionsNew: 0,
      mediaNew: 0,
      errorMessage: "Scan läuft bereits.",
      finishedAt: Date.now(),
    };
  }

  const settings = readSettings();

  if (!settings.enabled || !settings.consentAcceptedAt) {
    return {
      runId: "",
      outcome: "error",
      postsSeen: 0,
      postsNew: 0,
      interactionsNew: 0,
      mediaNew: 0,
      errorMessage: "LinkedIn-Beobachter ist nicht aktiviert.",
      finishedAt: Date.now(),
    };
  }
  if (!settings.fingerprint) {
    return {
      runId: "",
      outcome: "error",
      postsSeen: 0,
      postsNew: 0,
      interactionsNew: 0,
      mediaNew: 0,
      errorMessage: "Browser-Fingerprint fehlt. Bitte Einstellungen erneut öffnen.",
      finishedAt: Date.now(),
    };
  }
  if (!hasStoredSession()) {
    return {
      runId: "",
      outcome: "login_required",
      postsSeen: 0,
      postsNew: 0,
      interactionsNew: 0,
      mediaNew: 0,
      finishedAt: Date.now(),
    };
  }

  running = true;
  activeAbort = new AbortController();
  const externalSignal = opts.signal;
  if (externalSignal) {
    if (externalSignal.aborted) activeAbort.abort();
    else
      externalSignal.addEventListener(
        "abort",
        () => activeAbort?.abort(),
        { once: true },
      );
  }
  const signal = activeAbort.signal;

  const db = await getDb();
  const aggressiveMode = settings.aggressiveMode === true;
  const runId = await startScanRun(db, {
    userAgent: settings.fingerprint?.userAgent ?? null,
    aggressiveMode,
  });

  let postsSeen = 0;
  let postsNew = 0;
  let interactionsNew = 0;
  let mediaNew = 0;
  let outcome: LinkedInScanOutcome = "success";
  let errorMessage: string | undefined;
  let win: BrowserWindow | null = null;

  try {
    const fp = settings.fingerprint;
    win = new BrowserWindow({
      show: false,
      width: fp.viewport.width,
      height: fp.viewport.height,
      webPreferences: {
        partition: "persist:linkedin",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        offscreen: false,
      },
    });
    win.webContents.setUserAgent(fp.userAgent);
    win.webContents.session.setUserAgent(fp.userAgent);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    // L7: WebRTC IP leak prevention. The local IP would otherwise
    // surface in ICE candidates and let LinkedIn correlate the
    // session even after a UA rotation.
    try {
      const sess = win.webContents.session as Electron.Session & {
        setWebRTCIPHandlingPolicy?: (p: string) => void;
        setLocale?: (l: string) => void;
      };
      sess.setWebRTCIPHandlingPolicy?.(
        "default_public_interface_only",
      );
      sess.setLocale?.(fp.locale);
    } catch (err) {
      // Older Electron may not expose these — non-fatal.
      console.warn(
        "[linkedin/scraper] webrtc/locale setup skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // L7: stable Accept-Language header on linkedin.com requests.
    try {
      const acceptLang = `${fp.locale}, en-US;q=0.9, en;q=0.8`;
      win.webContents.session.webRequest.onBeforeSendHeaders(
        { urls: ["*://*.linkedin.com/*"] },
        (details, callback) => {
          const headers = { ...details.requestHeaders };
          headers["Accept-Language"] = acceptLang;
          callback({ requestHeaders: headers });
        },
      );
    } catch (err) {
      console.warn(
        "[linkedin/scraper] Accept-Language hook skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // L7: anti-detection JS must land BEFORE LinkedIn's scripts. We
    // do that by first parking on about:blank, dom-ready'ing the
    // override, THEN navigating to linkedin.com — so the moment
    // LinkedIn's bundles start running, our overrides are already in
    // place on the page's prototype chain.
    const stealthJs = buildStealthInjection(fp);
    await win.loadURL("about:blank");
    await win.webContents.executeJavaScript(stealthJs, false);

    // Multi-stage navigation in aggressive mode: land on the
    // homepage, dwell, then click the Home/feed link instead of
    // navigating directly to /feed/. Falls back to direct nav if
    // the selector misses.
    if (aggressiveMode) {
      await win.loadURL("https://www.linkedin.com/");
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      await sleep(jitter(3000, 6000), signal);
      const clicked = await win.webContents
        .executeJavaScript(
          `(() => {
            var a = document.querySelector('a[href="/feed/"]') ||
                    document.querySelector('a[href*="/feed/"]');
            if (a) { a.click(); return true; }
            return false;
          })()`,
          true,
        )
        .catch(() => false);
      if (!clicked) {
        await win.loadURL("https://www.linkedin.com/feed/");
      } else {
        // Give the SPA route a moment to settle.
        await sleep(jitter(2000, 4000), signal);
      }
    } else {
      await win.loadURL("https://www.linkedin.com/feed/");
    }
    if (signal.aborted) throw new DOMException("aborted", "AbortError");

    // Login redirect detection
    const url = win.webContents.getURL();
    if (/\/login|\/checkpoint\//.test(url)) {
      outcome = "login_required";
    } else {
      // Hydration delay
      await sleep(jitter(2000, 4000), signal);

      // L7 aggressive-mode pre-feed dwell: 6-12s with a couple of
      // mouse-move events sprinkled in so the session looks like it
      // started reading the top of the feed before scrolling.
      if (aggressiveMode) {
        const dwellEnd = Date.now() + jitter(6000, 12000);
        while (Date.now() < dwellEnd) {
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          await sleep(jitter(800, 1800), signal);
          try {
            win.webContents.sendInputEvent({
              type: "mouseMove",
              x: Math.floor(fp.viewport.width / 2) + jitter(-150, 150),
              y: Math.floor(fp.viewport.height / 2) + jitter(-150, 150),
            } as unknown as Electron.MouseInputEvent);
          } catch {
            // ignore — non-fatal
          }
        }
      }

      // Scroll loop. Aggressive mode scrolls fewer times and waits
      // longer between scrolls; the bias is fewer posts per session,
      // tighter pattern.
      const maxPosts = Math.max(1, Math.min(opts.maxPosts ?? 30, 200));
      const scrolls = aggressiveMode
        ? Math.ceil(maxPosts / 4)
        : Math.ceil(maxPosts / 3) + 2;
      const scrollMin = aggressiveMode ? 4000 : 2500;
      const scrollMax = aggressiveMode ? 9000 : 5500;
      const viewportCenterX = Math.floor(fp.viewport.width / 2);
      const viewportCenterY = Math.floor(fp.viewport.height / 2);
      for (let i = 0; i < scrolls; i++) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");

        // L7: mouse-movement pre-roll. 3-5 small moves tracing a
        // slight curve toward the viewport centre, 30-80ms apart.
        // Skipped on the very first scroll — page just loaded, no
        // mouse activity is also normal.
        if (i > 0) {
          const moves = 3 + Math.floor(Math.random() * 3);
          const startX = viewportCenterX + jitter(-180, 180);
          const startY = viewportCenterY + jitter(-180, 180);
          const endX = viewportCenterX + jitter(-60, 60);
          const endY = viewportCenterY + jitter(-60, 60);
          for (let m = 0; m < moves; m++) {
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            const t = (m + 1) / (moves + 1);
            // Tiny perpendicular curve so the path isn't a straight line.
            const curve = Math.sin(t * Math.PI) * 25;
            try {
              win.webContents.sendInputEvent({
                type: "mouseMove",
                x: Math.round(startX + (endX - startX) * t + curve),
                y: Math.round(startY + (endY - startY) * t + curve),
              } as unknown as Electron.MouseInputEvent);
            } catch {
              // ignore
            }
            await sleep(jitter(30, 80), signal);
          }
        }

        try {
          win.webContents.sendInputEvent({
            type: "mouseWheel",
            x: viewportCenterX,
            y: viewportCenterY,
            deltaX: 0,
            deltaY: -800,
            wheelTicksX: 0,
            wheelTicksY: -1,
            phase: "began",
            momentumPhase: "none",
            canScroll: true,
          } as unknown as Electron.MouseWheelInputEvent);
        } catch {
          // some platforms reject some wheel fields — fall back to JS
          // scroll, which is detectable but rarely punished.
          await win.webContents
            .executeJavaScript("window.scrollBy(0, 800)", true)
            .catch(() => undefined);
        }
        await sleep(jitter(scrollMin, scrollMax), signal);
      }
      // Extra settle for lazy media
      await sleep(3000, signal);

      // Extract
      const raw = (await win.webContents.executeJavaScript(
        EXTRACTOR_SCRIPT,
        true,
      )) as RawPostExtract[];
      postsSeen = Array.isArray(raw) ? raw.length : 0;

      const now = new Date();

      for (const p of raw.slice(0, maxPosts)) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        const postedAt =
          parseRelativeGerman(p.postedAtRelative, now) ??
          new Date(now.getTime() - 60_000);

        // Persist actor + post + interactions inside one transaction
        // so partial failure leaves no half-state.
        try {
          await db.exec("BEGIN");
          await upsertActor(db, p.author);
          const wasNew = await upsertPost(db, {
            postUrn: p.postUrn,
            authorUrn: p.author.actorUrn,
            postedAt,
            text: p.text,
            postKind: p.postKind,
            externalUrl: p.externalUrl,
            permalink: p.permalink,
            rawHtml: p.rawHtml,
          });
          if (wasNew) postsNew += 1;
          // L3: queue for signal extraction. Idempotent — DO NOTHING on
          // conflict — so re-scrapes don't reset already-extracted rows.
          await enqueueSignal(db, p.postUrn);

          for (const surf of p.surfacedInteractions) {
            await upsertActor(db, surf.actor);
            const inserted = await upsertInteraction(db, {
              postUrn: p.postUrn,
              actorUrn: surf.actor.actorUrn,
              kind: surf.kind,
              commentText: surf.commentText,
              createdAt: null,
            });
            if (inserted) interactionsNew += 1;
          }
          await db.exec("COMMIT");
        } catch (err) {
          await db.exec("ROLLBACK").catch(() => undefined);
          console.warn(
            "[linkedin/scraper] post persist failed:",
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }

        // Media downloads happen outside the transaction — they're
        // expensive and we don't want to hold a transaction open
        // while waiting on the network. Each row is independent.
        for (const m of p.mediaUrls) {
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          const dl = await downloadMedia(m.url, m.kind, p.postUrn, signal);
          if (!dl) continue;
          // localPath stored relative to userData/linkedin/media/ for
          // future relocation flexibility; we still record the absolute
          // path on disk inside the row to make L4 lookups trivial.
          const inserted = await insertMedia(db, {
            mediaId: dl.id,
            postUrn: p.postUrn,
            kind: m.kind,
            sourceUrl: m.url,
            localPath: dl.localPath,
            bytes: dl.bytes,
          });
          if (inserted) mediaNew += 1;
          // L4: enqueue for vision analysis. Images only — videos and
          // documents have their own (future) lanes. Idempotent.
          if (m.kind === "image") {
            await enqueueImageAnalysis(db, dl.id);
          }
        }
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      outcome = "cancelled";
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      // Heuristic: net::ERR_INTERNET_DISCONNECTED, ERR_NAME_NOT_RESOLVED
      // etc. all surface as "ERR_" strings on Electron's loadURL.
      if (/ERR_/.test(msg) || /ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(msg)) {
        outcome = "network_error";
      } else {
        outcome = "error";
      }
      errorMessage = msg;
      console.warn("[linkedin/scraper] scan failed:", msg);
    }
  } finally {
    try {
      win?.destroy();
    } catch {
      // ignore
    }
    win = null;
    activeAbort = null;
    running = false;
  }

  await finishScanRun(db, {
    runId,
    outcome,
    postsSeen,
    postsNew,
    interactionsNew,
    mediaNew,
    errorMessage,
  });

  if (outcome === "success" || outcome === "cancelled") {
    writeSettings({ lastScanAt: Date.now() });
  }

  // L3: kick the signal extractor in the background. Fire-and-forget —
  // the manual scan returns to the user as soon as scrape is done.
  if (outcome === "success") {
    void drainQueue().catch((err) => {
      console.warn(
        "[linkedin/scraper] post-scan drainQueue failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  return {
    runId,
    outcome,
    postsSeen,
    postsNew,
    interactionsNew,
    mediaNew,
    errorMessage,
    finishedAt: Date.now(),
  };
}

/** Convenience: status snapshot for the IPC poll endpoint. */
export async function scanStatusSnapshot(): Promise<{
  running: boolean;
  lastRun: LinkedInScanResult | null;
  lastRunAt: number | null;
}> {
  if (!hasStoredSession() && !running) {
    // Avoid spinning up the DB just to confirm "no runs yet" when the
    // user hasn't even connected — but only when we know we're idle.
    return { running: false, lastRun: null, lastRunAt: null };
  }
  const db = await getDb();
  const last = await latestScanRun(db);
  return {
    running,
    lastRun: last,
    lastRunAt: last?.finishedAt ?? null,
  };
}

/** Convenience: counts snapshot. */
export async function feedCountsSnapshot(): Promise<
  Awaited<ReturnType<typeof feedCounts>>
> {
  const db = await getDb();
  return await feedCounts(db);
}

/** App-quit hook. */
export async function shutdownScraper(): Promise<void> {
  cancelActiveScan();
  await closeDb();
}
