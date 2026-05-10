// LinkedIn-Beobachter stealth injection (Phase L7).
//
// Single string of JS that runs INSIDE the linkedin.com page context
// BEFORE LinkedIn's own scripts. The point of every override here is
// the same: make the headless-Electron BrowserWindow fingerprint match
// a stock Chrome install, so the cheapest tier of LinkedIn's bot
// detection (navigator.webdriver, plugin list emptiness, the missing
// `chrome.runtime` field, default WebGL strings) doesn't single us out.
//
// Compliance posture (Phase L0): none of this bypasses an access
// control. We don't forge auth cookies. We don't lie about the
// authenticated user. We just dampen the most-public bot signals so
// the user's own legitimate session doesn't get flagged for using
// Electron instead of stock Chrome. The Settings UI continues to warn
// that activating LinkedIn-Beobachter puts the account at risk
// regardless of these defences.
//
// The recipes below are the ones documented across the public web
// (puppeteer-extra-plugin-stealth, playwright-stealth, etc.). They
// are intentionally NOT clever — every line is something a LinkedIn
// engineer reading this file would already know about.
//
// IMPORTANT: this string is wrapped in a try/catch IIFE so a single
// throwing override doesn't abort the rest. If LinkedIn ships a
// frozen `navigator.webdriver` getter and our redefine throws, we
// still get the plugin spoof, the WebGL spoof, and the rest.

import type { LinkedInFingerprint } from "../../shared/types";

/** Build the stealth-injection JS string for the given fingerprint.
 *  We inline the locale here so `navigator.languages` is stable per
 *  install and matches the Accept-Language header set on the session. */
export function buildStealthInjection(fp: LinkedInFingerprint): string {
  const locale = JSON.stringify(fp.locale);
  return `
(function () {
  function safe(label, fn) {
    try { fn(); } catch (err) {
      // Swallow per-override errors; we don't want one frozen
      // descriptor to abort the rest of the spoofing.
      try { console.debug("[stealth] " + label + " skipped"); } catch (_) {}
    }
  }

  // 1) navigator.webdriver -> undefined
  safe("webdriver", function () {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      configurable: true,
      get: function () { return undefined; },
    });
  });

  // 2) navigator.plugins / mimeTypes — three plausible entries.
  // Standard public spoof recipe (Chrome PDF Viewer, Chromium PDF
  // Viewer, Native Client). LinkedIn's heuristics flag empty arrays.
  safe("plugins", function () {
    var fakePdfMime = {
      type: "application/pdf",
      suffixes: "pdf",
      description: "Portable Document Format",
    };
    function makePlugin(name, filename, description) {
      var p = Object.create(Plugin.prototype);
      Object.defineProperties(p, {
        name: { value: name },
        filename: { value: filename },
        description: { value: description },
        length: { value: 1 },
        0: { value: fakePdfMime },
      });
      return p;
    }
    var plugins = [
      makePlugin("Chrome PDF Viewer", "internal-pdf-viewer", "Portable Document Format"),
      makePlugin("Chromium PDF Viewer", "internal-pdf-viewer", "Portable Document Format"),
      makePlugin("Native Client", "internal-nacl-plugin", ""),
    ];
    var pluginArray = Object.create(PluginArray.prototype);
    plugins.forEach(function (p, i) {
      Object.defineProperty(pluginArray, i, { value: p, enumerable: true });
      Object.defineProperty(pluginArray, p.name, { value: p });
    });
    Object.defineProperty(pluginArray, "length", { value: plugins.length });
    Object.defineProperty(Navigator.prototype, "plugins", {
      configurable: true,
      get: function () { return pluginArray; },
    });

    var mimeTypes = Object.create(MimeTypeArray.prototype);
    Object.defineProperty(mimeTypes, 0, { value: fakePdfMime, enumerable: true });
    Object.defineProperty(mimeTypes, "length", { value: 1 });
    Object.defineProperty(mimeTypes, "application/pdf", { value: fakePdfMime });
    Object.defineProperty(Navigator.prototype, "mimeTypes", {
      configurable: true,
      get: function () { return mimeTypes; },
    });
  });

  // 3) navigator.languages — stable per install.
  safe("languages", function () {
    Object.defineProperty(Navigator.prototype, "languages", {
      configurable: true,
      get: function () { return [${locale}, "en-US", "en"]; },
    });
  });

  // 4) window.chrome — Electron sometimes ships only window.chrome
  // without window.chrome.runtime. LinkedIn checks for the runtime
  // sub-property; install a no-op shim if absent.
  safe("chrome.runtime", function () {
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", {
        configurable: true,
        writable: true,
        value: {},
      });
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        // No-ops — extension API surface that LinkedIn only
        // existence-checks, never actually invokes.
        connect: function () { return undefined; },
        sendMessage: function () { return undefined; },
        onMessage: { addListener: function () {} },
        id: undefined,
      };
    }
  });

  // 5) WebGL vendor + renderer.
  // Patches WebGLRenderingContext.prototype.getParameter so the
  // UNMASKED_VENDOR_WEBGL (37445) and UNMASKED_RENDERER_WEBGL (37446)
  // parameters return plausible Intel-integrated-graphics strings.
  // NOTE: we ship a single fixed pair regardless of the actual host
  // GPU. This is intentional — stable per install.
  safe("webgl", function () {
    var getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return "Intel Inc.";
      if (parameter === 37446) return "Intel Iris Pro Graphics";
      return getParam.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== "undefined") {
      var getParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return "Intel Inc.";
        if (parameter === 37446) return "Intel Iris Pro Graphics";
        return getParam2.apply(this, arguments);
      };
    }
  });

  // 6) Notification.permission -> "default" (instead of "denied"
  // which Electron reports without a permission handler).
  safe("notification", function () {
    if (typeof Notification !== "undefined") {
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: function () { return "default"; },
      });
    }
  });

  // 7) navigator.permissions.query({ name: "notifications" }) ->
  // { state: "default" } so the permission API matches override #6.
  safe("permissions.query", function () {
    if (navigator.permissions && navigator.permissions.query) {
      var orig = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (params) {
        if (params && params.name === "notifications") {
          return Promise.resolve({
            state: "default",
            onchange: null,
            addEventListener: function () {},
            removeEventListener: function () {},
            dispatchEvent: function () { return false; },
          });
        }
        return orig(params);
      };
    }
  });
})();
`;
}
