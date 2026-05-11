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
import { clearStoredSession, hasStoredSession } from "./session";
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
import { beginRun, type RunMetadata, type RunRecorder } from "./runs";
import { buildStealthInjection } from "./stealth";

export interface ScanOptions {
  manual: boolean;
  /** Default 30. */
  maxPosts?: number;
  signal?: AbortSignal;
}

// v0.1.113 — LinkedIn dropped `data-urn` from feed wrappers and now
// ships hash-suffixed per-build CSS classes. The new stable anchor is
// `componentkey="expanded<POST_KEY>FeedType_..."` on a
// `div[role="listitem"]`. We extract that POST_KEY substring and use
// it as the dedup key. The DB column is still `post_urn` and the
// in-memory field is still `postUrn` to minimise churn for one release;
// the VALUE is now a postKey (no `urn:li:` prefix), and we keep
// `postKey` as a sibling alias so downstream consumers can migrate at
// their own pace.
interface RawPostExtract {
  postUrn: string;
  /** v0.1.113 alias for `postUrn` — same value, clearer name. */
  postKey: string;
  postKind:
    | "text"
    | "image"
    | "video"
    | "article"
    | "document"
    | "repost"
    | "event";
  postedAtRelative: string | null;
  /** v0.1.113: most posts no longer expose a real permalink in the
   *  DOM (LinkedIn keeps it in React state). null means "we couldn't
   *  read one — render the actor profile URL as a fallback". */
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
  /** v0.1.113. `"feed"` = normal post; `"suggested"` = LinkedIn's
   *  "Suggested" pill above the actor block; `"promoted"` =
   *  Promoted/Sponsored ad card. */
  feedSlot: "feed" | "suggested" | "promoted";
  /** v0.1.113. Present when a "X commented on this" / "X likes this"
   *  attribution header sits above the original post. The post itself
   *  is still authored by `author`; this just surfaces who pulled it
   *  into our feed. */
  attribution: {
    actor: string;
    kind: "commented" | "liked" | "followed" | "reposted";
  } | null;
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

// v0.1.113 — exported so unit tests / future tooling can derive the
// postKey from a componentkey string without re-implementing the regex.
// Example input:
//   expandedScddZhqpBnn5BII3yX2bgZ7KmXK3I7LDYgchkDgXxWQFeedType_MAIN_FEED_RELEVANCE
// Example output:
//   ScddZhqpBnn5BII3yX2bgZ7KmXK3I7LDYgchkDgXxWQ
export const COMPONENTKEY_POSTKEY_REGEX =
  /^expanded(.+?)FeedType_[A-Z_]+$/;

export function postKeyFromComponentKey(
  componentKey: string | null | undefined,
): string | null {
  if (!componentKey) return null;
  const m = componentKey.match(COMPONENTKEY_POSTKEY_REGEX);
  return m ? m[1] ?? null : null;
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
// SELECTOR-FRAGILE: update on next LinkedIn UI shift.
//
// v0.1.113 rewrite. LinkedIn now ships hash-suffixed per-build CSS
// classes (`_3198bc31`, `_9cb66104`, ...) and dropped `data-urn` from
// feed wrappers entirely. The new stable anchors are:
//
//   - `role="listitem"` on the wrapper
//   - `componentkey="expanded<POST_KEY>FeedType_..."` on the wrapper
//   - `componentkey="feed-commentary_..."` on the body paragraph
//   - `data-testid="expandable-text-box"` on the body span
//   - `<h2><span class="e94a47cd">Feed post</span></h2>` sentinel that
//     distinguishes a real post from a composer / promo / suggestion
//     carousel card
//
// Permalinks: most `<a href>` inside posts point at the placeholder
// `/feed/` href because LinkedIn keeps the real permalink in React
// state, not the DOM. We therefore set permalink to null in most
// cases — the renderer falls back to the actor profile URL.
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
  function urnFromProfileHref(href) {
    // v0.1.113. Profile URLs survive — \`/in/<slug>\` is still the
    // canonical link. We synthesise an actorUrn from the slug so the
    // DB unique constraint keeps working.
    if (!href) return null;
    var mIn = href.match(/in\\/([^/?#]+)/);
    if (mIn) return "urn:li:profile:" + mIn[1];
    var mCo = href.match(/company\\/([^/?#]+)/);
    if (mCo) return "urn:li:company:" + mCo[1];
    return null;
  }
  // Derive postKey from a componentkey value. See
  // \`postKeyFromComponentKey\` in scraper.ts for the canonical regex —
  // this is a JS twin that runs in-page.
  function postKeyFromComponentKey(ck) {
    if (!ck) return null;
    var m = ck.match(/^expanded(.+?)FeedType_[A-Z_]+$/);
    return m ? m[1] : null;
  }

  // LinkedIn renders TWO anchors per actor with the same href: one
  // around the avatar (figure/img only, empty textContent) and one
  // around the info block (name + headline <p>s). querySelectorAll
  // returns both in DOM order, which means \`profileLinks[0]\` is often
  // the avatar — useless for name extraction. Dedupe by href and keep
  // the anchor with the richest textContent.
  function dedupeByHref(nodes) {
    var byHref = new Map();
    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      var href = a.getAttribute("href") || "";
      if (!href) continue;
      var prev = byHref.get(href);
      if (!prev || (a.textContent || "").length > (prev.textContent || "").length) {
        byHref.set(href, a);
      }
    }
    return Array.from(byHref.values());
  }

  // Build an actor record from a single anchor (\`a[href*="/in/"]\` or
  // \`a[href*="/company/"]\`). The anchor wraps a few \`<p>\` elements;
  // the first is typically the name, the second is the headline.
  function actorFromLink(link) {
    if (!link) return null;
    var href = link.getAttribute("href") || null;
    var profileUrl = href
      ? new URL(href, location.origin).toString().split('?')[0]
      : null;
    var actorUrn = urnFromProfileHref(href);
    // Prefer aria-label on the link itself (full name), fall back to
    // the first <p> text, then the link's own text content.
    var aria = link.getAttribute("aria-label") || "";
    var ps = link.querySelectorAll("p");
    var nameText = "";
    var headlineText = "";
    if (ps.length > 0) nameText = txt(ps[0]);
    if (ps.length > 1) headlineText = txt(ps[1]);
    var displayName = nameText || aria || txt(link) || "";
    // Defensive: strip ARIA suffixes like ", profile" / ", company".
    displayName = displayName.replace(/,\\s*(profile|company|page).*/i, "").trim();
    // Fallback: parse the LinkedIn img-alt / svg-aria patterns. The
    // avatar anchor wraps only a <figure>/<img>/<svg>, so all the
    // text-based extractors above yield nothing. The alt text follows
    // a small set of localised patterns we can recover.
    if (!displayName) {
      var imgAlt = "";
      var img = link.querySelector("img[alt]");
      if (img) imgAlt = img.getAttribute("alt") || "";
      if (!imgAlt) {
        var svgAria = link.querySelector("svg[aria-label]");
        if (svgAria) imgAlt = svgAria.getAttribute("aria-label") || "";
      }
      // Patterns: "View Foo Bar's profile" / "View company: Foo GmbH" /
      //           "Foto von Foo Bar anzeigen" / "Foo Bar anzeigen"
      var m =
        imgAlt.match(/^View\\s+(.+?)['\\u2019]s\\s+(?:profile|photo|page)\\s*$/i) ||
        imgAlt.match(/^View\\s+company:\\s+(.+)$/i) ||
        imgAlt.match(/^Foto\\s+von\\s+(.+?)\\s+anzeigen\\s*$/i) ||
        imgAlt.match(/^(.+?)\\s+anzeigen\\s*$/i);
      if (m && m[1]) displayName = m[1].trim();
    }
    if (!displayName && !actorUrn) return null;
    return {
      actorUrn:
        actorUrn ||
        "urn:li:anon:" + (profileUrl || displayName || String(Math.random())),
      displayName: displayName || "Unbekannt",
      headline: headlineText || null,
      profileUrl: profileUrl,
    };
  }

  // v0.1.113 wrapper selector. We accept a single primary selector
  // here, then verify the sentinel inside the loop. Promo / composer /
  // suggestion-carousel cards lack the sentinel and get skipped.
  var WRAPPER_SELECTOR =
    'div[role="listitem"][componentkey^="expanded"][componentkey*="FeedType_"]';

  var candidateCounts = {
    wrapper: 0,
    wrapper_with_sentinel: 0,
    body_text_found: 0,
    actor_link_found: 0,
    image_found: 0,
    document_found: 0,
    promoted: 0,
    suggested: 0,
  };

  var wrappers;
  try {
    wrappers = document.querySelectorAll(WRAPPER_SELECTOR);
  } catch (e) {
    wrappers = [];
  }
  candidateCounts.wrapper = wrappers.length;

  var posts = [];

  Array.prototype.forEach.call(wrappers, function (node) {
    try {
      // ---- Sentinel check ------------------------------------------
      // Real posts have <h2><span class="e94a47cd">Feed post</span></h2>.
      // Promo cards / suggestion carousels lack it.
      var sentinel = null;
      var h2spans = node.querySelectorAll('h2 span');
      for (var i = 0; i < h2spans.length; i++) {
        var s = txt(h2spans[i]);
        if (s === "Feed post" || s === "Feed-Beitrag") {
          sentinel = h2spans[i];
          break;
        }
      }
      if (!sentinel) return;
      candidateCounts.wrapper_with_sentinel += 1;

      // ---- postKey -------------------------------------------------
      var componentkey = node.getAttribute("componentkey") || "";
      var postKey = postKeyFromComponentKey(componentkey);
      if (!postKey) return;

      // ---- Attribution header detection ----------------------------
      // A <p> with verbatim "commented on this" / "likes this" /
      // "reposted this" / "follow ..." somewhere up top. The original
      // post's content sits below; the FIRST profile/company link
      // belongs to the attributor, the SECOND belongs to the real
      // post author.
      var attribution = null;
      var allParas = node.querySelectorAll("p");
      for (var p = 0; p < allParas.length; p++) {
        var pt = txt(allParas[p]);
        if (!pt) continue;
        var attrKind = null;
        if (/commented on this$/i.test(pt) || /hat dies kommentiert$/i.test(pt))
          attrKind = "commented";
        else if (/likes this$/i.test(pt) || /gefällt das$/i.test(pt))
          attrKind = "liked";
        else if (/reposted this$/i.test(pt) || /hat dies erneut geteilt$/i.test(pt))
          attrKind = "reposted";
        else if (/\\bfollow(s|ing)?\\b/i.test(pt) || /\\bfolgt\\b/i.test(pt))
          attrKind = "followed";
        if (attrKind) {
          var attrLink = allParas[p].querySelector('a[href*="/in/"], a[href*="/company/"]');
          var attrName = attrLink ? txt(attrLink) : pt.split(/\\s/).slice(0, 2).join(" ");
          attribution = { actor: attrName || "Unbekannt", kind: attrKind };
          break;
        }
      }

      // ---- "Suggested" pill ---------------------------------------
      var suggestedPill = false;
      for (var sp = 0; sp < allParas.length; sp++) {
        var spt = txt(allParas[sp]);
        if (spt === "Suggested" || spt === "Vorgeschlagen") {
          suggestedPill = true;
          break;
        }
      }

      // ---- Promoted flag ------------------------------------------
      // A <p> containing the exact text "Promoted" or "Sponsored"
      // (Gesponsert in DE).
      var promoted = false;
      for (var pr = 0; pr < allParas.length; pr++) {
        var prt = txt(allParas[pr]);
        if (prt === "Promoted" || prt === "Sponsored" || prt === "Gesponsert") {
          promoted = true;
          break;
        }
      }

      var feedSlot = promoted ? "promoted" : suggestedPill ? "suggested" : "feed";
      if (feedSlot === "promoted") candidateCounts.promoted += 1;
      if (feedSlot === "suggested") candidateCounts.suggested += 1;

      // ---- Body text ----------------------------------------------
      var bodyEl = node.querySelector(
        'p[componentkey^="feed-commentary_"] span[data-testid="expandable-text-box"]'
      );
      if (!bodyEl) {
        // Fallback: any data-testid="expandable-text-box" anywhere.
        bodyEl = node.querySelector('[data-testid="expandable-text-box"]');
      }
      var text = txt(bodyEl);
      // Strip the trailing "…more" / "…mehr anzeigen" button text.
      text = text
        .replace(/…\\s*(more|mehr( anzeigen)?|weiterlesen)\\s*$/i, "")
        .replace(/\\.\\.\\.\\s*(more|mehr( anzeigen)?|weiterlesen)\\s*$/i, "")
        .trim();
      if (text) candidateCounts.body_text_found += 1;

      // ---- Actor link ---------------------------------------------
      // Collect /in/ and /company/ links inside the post. If there's
      // an attribution header, skip the FIRST one (it belongs to the
      // attributor) and pick the second.
      var profileLinks = dedupeByHref(node.querySelectorAll('a[href*="/in/"]'));
      var companyLinks = dedupeByHref(node.querySelectorAll('a[href*="/company/"]'));
      var actor = null;
      var skipIndex = attribution ? 1 : 0;
      if (profileLinks.length > skipIndex) {
        actor = actorFromLink(profileLinks[skipIndex]);
      }
      if (!actor && companyLinks.length > skipIndex) {
        actor = actorFromLink(companyLinks[skipIndex]);
      }
      // Last-ditch: any actor link at all.
      if (!actor && profileLinks.length > 0) {
        actor = actorFromLink(profileLinks[0]);
      }
      if (!actor && companyLinks.length > 0) {
        actor = actorFromLink(companyLinks[0]);
      }
      if (actor) candidateCounts.actor_link_found += 1;

      // ---- Posted-at relative -------------------------------------
      // The relative-time <p> contains a globe SVG. We strip the SVG
      // text and keep just the leading "3d • Edited •" prefix.
      var postedAtRelative = null;
      var globeSvg = node.querySelector(
        'svg[id="globe-americas-small"], svg[id^="globe-"]'
      );
      if (globeSvg) {
        var globePara = globeSvg.closest("p");
        if (globePara) {
          // Clone, remove SVGs, read text.
          var cloned = globePara.cloneNode(true);
          var svgs = cloned.querySelectorAll("svg");
          for (var sv = 0; sv < svgs.length; sv++) svgs[sv].remove();
          postedAtRelative = txt(cloned) || null;
        }
      }

      // ---- Media: images ------------------------------------------
      var mediaUrls = [];
      var imageNodes = node.querySelectorAll('img[alt="View image"], img[alt="Bild anzeigen"]');
      for (var ii = 0; ii < imageNodes.length; ii++) {
        var fig = imageNodes[ii].closest("figure");
        var src = pickAttr(imageNodes[ii], "src");
        if (fig && src && src.indexOf("http") === 0) {
          mediaUrls.push({ kind: "image", url: src });
        }
      }
      if (mediaUrls.some(function (m) { return m.kind === "image"; })) {
        candidateCounts.image_found += 1;
      }

      // ---- Media: document slides (PDF carousel) ------------------
      var docNodes = node.querySelectorAll('img[src*="feedshare-document-images"]');
      var documentPages = 0;
      for (var di = 0; di < docNodes.length; di++) {
        var dsrc = pickAttr(docNodes[di], "src");
        if (dsrc && dsrc.indexOf("http") === 0) {
          mediaUrls.push({ kind: "document", url: dsrc });
          documentPages += 1;
        }
      }
      if (documentPages > 0) candidateCounts.document_found += 1;

      // ---- Media: video -------------------------------------------
      var videoEl = node.querySelector('video[src*="blob:"], video[src^="blob:"]');
      var hasVideo = !!videoEl;
      if (hasVideo) {
        var posterImg = node.querySelector('.vjs-poster img, video[poster]');
        var posterSrc = null;
        if (posterImg) {
          posterSrc =
            pickAttr(posterImg, "src") || pickAttr(posterImg, "poster");
        }
        if (posterSrc && posterSrc.indexOf("http") === 0) {
          mediaUrls.push({ kind: "video", url: posterSrc });
        }
      }

      // ---- External / article link -------------------------------
      var externalUrl = null;
      var articleLink = node.querySelector('a[href*="/pulse/"], a[data-testid*="article"]');
      if (articleLink) {
        var ah = articleLink.getAttribute("href");
        if (ah && ah.indexOf("http") === 0) externalUrl = ah;
      }

      // ---- Permalink (mostly null in the new DOM) ----------------
      // We accept a permalink only if it's a real post URL, NOT the
      // \`/feed/\` placeholder. Otherwise null; the renderer falls back
      // to the actor profile URL.
      var permalink = null;
      var permaCandidates = node.querySelectorAll(
        'a[href*="/feed/update/"], a[href*="/posts/"]'
      );
      for (var pc = 0; pc < permaCandidates.length; pc++) {
        var ph = permaCandidates[pc].getAttribute("href");
        if (!ph) continue;
        if (ph === "/feed/" || ph === "https://www.linkedin.com/feed/") continue;
        try {
          permalink = new URL(ph, location.origin).toString().split('?')[0];
          break;
        } catch (e) { /* ignore */ }
      }

      // ---- Post kind ---------------------------------------------
      var postKind = "text";
      if (hasVideo) postKind = "video";
      else if (mediaUrls.some(function (m) { return m.kind === "image"; })) postKind = "image";
      else if (documentPages > 0) postKind = "document";
      else if (externalUrl) postKind = "article";
      if (attribution && attribution.kind === "reposted") postKind = "repost";

      // ---- Surfaced interactions (reactions / comments counts) ---
      // The new DOM only exposes counts as plain text spans, not
      // per-actor lists. We don't synthesise fake interactions from
      // those — the surfacedInteractions array becomes whatever the
      // attribution header gives us (commented/liked/etc.).
      var surfaced = [];
      if (attribution && attribution.actor) {
        var attrProfileLink = profileLinks.length > 0 ? profileLinks[0] : null;
        var attrActor = attrProfileLink
          ? actorFromLink(attrProfileLink)
          : null;
        if (!attrActor) {
          attrActor = {
            actorUrn: "urn:li:anon:" + attribution.actor,
            displayName: attribution.actor,
            headline: null,
            profileUrl: null,
          };
        }
        var mappedKind =
          attribution.kind === "commented" ? "comment" :
          attribution.kind === "reposted" ? "share" :
          "like";
        surfaced.push({ actor: attrActor, kind: mappedKind, commentText: null });
      }

      // ---- Required-field policy (v0.1.113) ----------------------
      // Accept if postKey AND (body OR image OR document OR video).
      // Actor link is required EXCEPT for promoted posts where a
      // company link in the second slot will do.
      var hasBody = !!text;
      var hasImage = mediaUrls.some(function (m) { return m.kind === "image"; });
      var hasDocument = documentPages > 0;
      var hasContent = hasBody || hasImage || hasDocument || hasVideo;
      if (!hasContent) return;
      if (!actor && !(feedSlot === "promoted" && companyLinks.length > 0)) return;
      // Fallback synthetic actor for promoted-with-company case.
      if (!actor) {
        actor = actorFromLink(companyLinks[companyLinks.length - 1]) ||
          {
            actorUrn: "urn:li:anon:promoted-" + postKey,
            displayName: "Gesponsert",
            headline: null,
            profileUrl: null,
          };
      }

      // ---- Raw HTML (capped at 64 KB) ----------------------------
      var rawHtml = node.outerHTML || "";
      if (rawHtml.length > 64000) rawHtml = rawHtml.slice(0, 64000);

      posts.push({
        postUrn: postKey,
        postKey: postKey,
        postKind: postKind,
        postedAtRelative: postedAtRelative,
        permalink: permalink,
        externalUrl: externalUrl,
        text: text,
        rawHtml: rawHtml,
        author: actor,
        feedSlot: feedSlot,
        attribution: attribution,
        mediaUrls: mediaUrls,
        surfacedInteractions: surfaced,
      });
    } catch (err) {
      // Swallow per-post errors so one broken card doesn't sink the
      // whole scrape.
    }
  });

  // De-duplicate by postKey.
  var seen = {};
  var dedup = [];
  posts.forEach(function (p) {
    if (seen[p.postKey]) return;
    seen[p.postKey] = true;
    dedup.push(p);
  });

  return {
    posts: dedup,
    diagnostic: {
      candidateCounts: candidateCounts,
      finalCount: dedup.length,
    },
  };
})()
`;

// v0.1.112: small inline script that returns the feed container's
// outerHTML capped to 2MB, so we can grep selector candidates offline
// when extraction returns 0 posts. Wrapped in try/catch via the
// caller; this script itself never throws.
const FEED_HTML_DUMP_SCRIPT = `
(function () {
  try {
    var el = document.querySelector('main[id="main"], main[role="main"], .scaffold-finite-scroll, .scaffold-layout__main');
    var html = (el && el.outerHTML) ? el.outerHTML : document.body.outerHTML;
    if (!html) return "";
    if (html.length > 2000000) html = html.slice(0, 2000000);
    return html;
  } catch (e) {
    return "";
  }
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
  // v0.1.109: per-run diagnostic recorder (screenshots + run.json).
  // Screenshot failures are swallowed inside the recorder; the
  // recorder itself never throws so the scrape path is unaffected.
  const recorder: RunRecorder = beginRun({
    userAgent: settings.fingerprint?.userAgent ?? null,
  });

  try {
    const fp = settings.fingerprint;
    // v0.1.110 hardening item 1: stop hiding the window like a bot.
    // A `show: false` BrowserWindow has 0x0 outer dimensions and never
    // paints — both signals are trivially detected by anti-bot JS. We
    // instead create a real, visible window off-screen with full
    // transparency and no taskbar entry, so the page sees a normal
    // window from a fingerprint standpoint while the user sees nothing.
    //
    // Env override `AVA_LINKEDIN_DEBUG_WINDOW=1` shows the window in
    // its natural position so a developer (or the user, when v0.1.110
    // doesn't pan out) can watch the scrape live.
    const debugWindow = process.env.AVA_LINKEDIN_DEBUG_WINDOW === "1";
    win = new BrowserWindow({
      show: true,
      width: fp.viewport.width,
      height: fp.viewport.height,
      x: debugWindow ? undefined : -2000,
      y: debugWindow ? undefined : -2000,
      skipTaskbar: !debugWindow,
      focusable: debugWindow,
      // `frame: false` keeps the off-screen window from briefly
      // flashing a title bar on creation. In debug mode we keep the
      // frame so the developer can drag/close it.
      frame: debugWindow,
      webPreferences: {
        partition: "persist:linkedin",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        offscreen: false,
      },
    });
    if (!debugWindow) {
      try {
        win.setOpacity(0);
      } catch {
        // ignore
      }
    }
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

    // L7 / v0.1.110: anti-detection JS must land BEFORE LinkedIn's
    // scripts run, on EVERY navigation (including the SPA-style
    // route changes the homepage->/feed/ click triggers). We hook
    // `did-start-navigation` to (re)inject the stealth payload into
    // the renderer the moment a new document begins parsing, before
    // any LinkedIn JS executes. The await on executeJavaScript is
    // fire-and-forget — we don't gate navigation on it — but in
    // practice Electron resolves it well before the page's scripts
    // start to run.
    const stealthJs = buildStealthInjection(fp);
    const reinjectStealth = (): void => {
      win?.webContents
        .executeJavaScript(stealthJs, false)
        .catch(() => undefined);
    };
    win.webContents.on("did-start-navigation", reinjectStealth);
    // Belt-and-braces: also inject on dom-ready so the override is
    // present even if did-start-navigation lost a race against the
    // first inline <script>.
    win.webContents.on("dom-ready", reinjectStealth);
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

    // v0.1.109: capture initial screenshot once we've landed on the
    // feed URL, before any further interaction.
    await recorder.capture(win, "01_initial");

    // Login redirect detection
    const url = win.webContents.getURL();
    recorder.updateMeta({ url });
    if (/\/login|\/checkpoint\//.test(url)) {
      outcome = "login_required";
      // v0.1.99 — drop the stale session cookies the moment we know
      // they're invalid. Without this, hasStoredSession() keeps
      // returning true (the cookie file is still on disk), so the
      // Settings UI shows "Verbunden" and the only button visible is
      // "Verbindung trennen". User has no way to reach the connect
      // flow without first manually disconnecting. Clearing here lets
      // the next auth-status refresh in the renderer flip the UI to
      // "Nicht verbunden" with a "Mit LinkedIn verbinden" button
      // visible immediately.
      clearStoredSession();
      await recorder.capture(win, "02_after_auth_check");
    } else {
      await recorder.capture(win, "02_after_auth_check");
      // Hydration delay
      await sleep(jitter(2000, 4000), signal);
      await recorder.capture(win, "03_feed_loaded");

      // v0.1.110 hardening item 6: human warmup. Before the scroll
      // loop starts we wait 2-4s, synthesize a couple of mouse moves
      // and a tiny wheel nudge so anti-bot heuristics see "user
      // arrived, glanced around, started reading" rather than the
      // bot pattern of "page paints, scroll fires 300ms later".
      await sleep(jitter(2000, 4000), signal);
      try {
        const cx = Math.floor(fp.viewport.width / 2);
        const cy = Math.floor(fp.viewport.height / 2);
        for (let m = 0; m < 2; m++) {
          win.webContents.sendInputEvent({
            type: "mouseMove",
            x: cx + jitter(-200, 200),
            y: cy + jitter(-200, 200),
          } as unknown as Electron.MouseInputEvent);
          await sleep(jitter(150, 350), signal);
        }
        win.webContents.sendInputEvent({
          type: "mouseWheel",
          x: cx,
          y: cy,
          deltaX: 0,
          deltaY: -200,
          wheelTicksX: 0,
          wheelTicksY: -1,
          phase: "began",
          momentumPhase: "none",
          canScroll: true,
        } as unknown as Electron.MouseWheelInputEvent);
      } catch {
        // non-fatal
      }
      await sleep(jitter(900, 1400), signal);

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

        // v0.1.110 hardening item 3: trusted-input scroll with jitter.
        // Untrusted JS scrolls (window.scrollBy) carry an `isTrusted=false`
        // signal that anti-bot heuristics can flag, so we always try
        // sendInputEvent first. The previous JS fallback has been
        // removed; if the wheel event throws we retry with a simpler
        // payload before giving up for the cycle.
        const deltaY = -jitter(500, 850);
        // ~30% of cycles, nudge the mouse to a random point first.
        if (i > 0 && Math.random() < 0.3) {
          try {
            win.webContents.sendInputEvent({
              type: "mouseMove",
              x: viewportCenterX + jitter(-220, 220),
              y: viewportCenterY + jitter(-220, 220),
            } as unknown as Electron.MouseInputEvent);
            await sleep(jitter(80, 220), signal);
          } catch {
            // ignore
          }
        }
        try {
          win.webContents.sendInputEvent({
            type: "mouseWheel",
            x: viewportCenterX + jitter(-30, 30),
            y: viewportCenterY + jitter(-30, 30),
            deltaX: 0,
            deltaY,
            wheelTicksX: 0,
            wheelTicksY: -1,
            phase: "began",
            momentumPhase: "none",
            canScroll: true,
          } as unknown as Electron.MouseWheelInputEvent);
        } catch {
          try {
            win.webContents.sendInputEvent({
              type: "mouseWheel",
              x: viewportCenterX,
              y: viewportCenterY,
              deltaX: 0,
              deltaY,
            } as unknown as Electron.MouseWheelInputEvent);
          } catch {
            // Both wheel attempts failed; skip the JS fallback —
            // an untrusted scroll is worse than no scroll this cycle.
          }
        }
        // Jitter between scrolls: random 400-1200ms on top of the
        // existing scrollMin/scrollMax dwell, so consecutive scroll
        // intervals never form an arithmetic series.
        await sleep(jitter(scrollMin, scrollMax) + jitter(400, 1200), signal);
        // v0.1.109: per-scroll diagnostic capture. Numbered from 1.
        await recorder.capture(win, `04_scroll_${i + 1}`);
      }
      // Extra settle for lazy media
      await sleep(3000, signal);

      await recorder.capture(win, "05_before_extraction");

      // v0.1.112: dump the feed container's outerHTML (≤ 2MB) so we
      // can diagnose selector drift offline when extraction returns 0
      // posts. Best-effort — mirrors recorder.capture()'s contract.
      try {
        const feedHtml = (await win.webContents.executeJavaScript(
          FEED_HTML_DUMP_SCRIPT,
          true,
        )) as string;
        if (typeof feedHtml === "string" && feedHtml.length > 0) {
          try {
            writeFileSync(join(recorder.dir, "05_feed_html.html"), feedHtml);
          } catch (err) {
            console.warn(
              "[linkedin/scraper] feed HTML write failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      } catch (err) {
        console.warn(
          "[linkedin/scraper] feed HTML dump failed:",
          err instanceof Error ? err.message : String(err),
        );
      }

      // Extract. v0.1.112: extractor now returns { posts, diagnostic }.
      const extractResult = (await win.webContents.executeJavaScript(
        EXTRACTOR_SCRIPT,
        true,
      )) as {
        posts: RawPostExtract[];
        diagnostic: {
          candidateCounts: Record<string, number>;
          finalCount: number;
        };
      };
      const raw: RawPostExtract[] = Array.isArray(extractResult?.posts)
        ? extractResult.posts
        : [];
      const diagnostic =
        extractResult && typeof extractResult === "object"
          ? extractResult.diagnostic ?? null
          : null;
      postsSeen = raw.length;

      if (diagnostic) {
        console.info(
          "[linkedin/scraper] extraction diagnostic:",
          JSON.stringify(diagnostic),
        );
        recorder.updateMeta({ extractionDiagnostic: diagnostic });
      }

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
    // v0.1.109: capture whatever the page looked like at failure.
    await recorder.capture(win, "99_error");
  } finally {
    try {
      win?.destroy();
    } catch {
      // ignore
    }
    win = null;
    activeAbort = null;
    running = false;
    // v0.1.109: finalise the run.json sidecar with all known fields.
    // `no_posts` is a UI-only refinement so the "Letzte Läufe" panel
    // can flag the 0-posts-seen case loudly.
    const metaOutcome: RunMetadata["outcome"] =
      outcome === "success" && postsSeen === 0 ? "no_posts" : outcome;
    recorder.updateMeta({
      outcome: metaOutcome,
      postsSeen,
      signalsLinked: postsNew,
      errorMessage: errorMessage ?? null,
      finishedAt: new Date().toISOString(),
    });
    recorder.finalize();
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
