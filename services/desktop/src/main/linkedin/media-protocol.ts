// Phase L6 — custom protocol that serves LinkedIn media files to the
// renderer. Mirrors the `ava-screenshot://` design: the protocol is
// registered as privileged (standard + secure) before app.whenReady,
// the on-disk handler is wired inside whenReady, path components are
// sanitized to refuse `..` traversal.
//
// URL shape:  ava-linkedin-media://<postDir>/<filename>
// On disk:    <userData>/linkedin/media/<postDir>/<filename>
//
// `postDir` is `encodeURIComponent(postUrn)` (the scraper writes it
// that way). The renderer encodes each path segment again before
// constructing the URL, so the protocol handler sees the
// already-encoded form and decodes it back to the on-disk name.

import { app, net, protocol } from "electron";
import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

function mediaRoot(): string {
  return join(app.getPath("userData"), "linkedin", "media");
}

/** Drop slashes / drive separators / dotdot from a single segment so
 *  path resolution can't escape the media root. */
function sanitizeSegment(s: string): string {
  return s.replace(/[/\\]|\.\./g, "_");
}

/** Register the on-disk handler. Call from inside app.whenReady(). */
export function registerLinkedInMediaProtocol(): void {
  protocol.handle("ava-linkedin-media", async (request) => {
    const url = new URL(request.url);
    const segments = (url.host + url.pathname)
      .split("/")
      .map((s) => decodeURIComponent(s))
      .filter(Boolean)
      .map(sanitizeSegment);
    if (segments.length < 2) {
      return new Response("not found", { status: 404 });
    }
    const fullPath = normalize(join(mediaRoot(), ...segments));
    if (!fullPath.startsWith(mediaRoot() + sep)) {
      return new Response("forbidden", { status: 403 });
    }
    if (!existsSync(fullPath)) {
      return new Response("not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(fullPath).toString());
  });
}
