import assert from "node:assert/strict";
import { test } from "node:test";
import { waehleLecks, waehleVerwaiste, waehleVerwaisteProfile, type Prozess } from "./waisen";

const P = (pid: number, ppid: number, args: string): Prozess => ({ pid, ppid, args });

test("Browser mit totem Besitzer wird samt Kindern gewaehlt, lebender bleibt", () => {
  const prozesse = [
    P(1, 0, "init"),
    P(634, 1, "node dist/cli.js"),
    P(700, 634, "/usr/bin/chromedriver --port=1"),
    P(701, 700, "/usr/lib/chromium/chromium --ava-browser --ava-owner=634 --user-data-dir=/tmp/ava-chrome-aaa"),
    P(702, 701, "/usr/lib/chromium/chromium --type=renderer --user-data-dir=/tmp/ava-chrome-aaa"),
    P(800, 1, "/usr/lib/chromium/chromium --ava-browser --ava-owner=500 --user-data-dir=/tmp/ava-chrome-tot"),
    P(801, 800, "/usr/lib/chromium/chromium --type=utility --user-data-dir=/tmp/ava-chrome-tot"),
    P(802, 1, "/usr/lib/chromium/chromium --type=utility --utility-sub-type=on_device_model --user-data-dir=/tmp/ava-chrome-tot --ava-owner=500"),
    P(900, 1, "/usr/lib/chromium/chrome_crashpad_handler --monitor-self"),
    P(950, 1, "/usr/bin/chromedriver --port=2"),
  ];
  const gewaehlt = new Set(waehleVerwaiste(prozesse, 634));
  assert.deepEqual([...gewaehlt].sort((a, b) => a - b), [800, 801, 802, 900, 950]);
});

test("Profile ohne Nennung und alt genug werden gewaehlt", () => {
  const prozesse = [P(701, 700, "chromium --ava-browser --user-data-dir=/tmp/ava-chrome-aaa")];
  const alle = [
    { pfad: "/tmp/ava-chrome-aaa", alterMs: 10 * 3_600_000 },
    { pfad: "/tmp/ava-chrome-alt", alterMs: 10 * 3_600_000 },
    { pfad: "/tmp/ava-chrome-neu", alterMs: 5_000 },
  ];
  assert.deepEqual(waehleVerwaisteProfile(alle, prozesse, 60_000), ["/tmp/ava-chrome-alt"]);
});

// Befund 2026-11-25 (ava-register-worker): Lecks am LEBENDEN Worker, die waehleVerwaiste nie sieht.
test("Leck-Wache: Browser des offenen Portals bleibt, liegengebliebene eigene Browser und Treiber gehen", () => {
  const prozesse = [
    P(1, 0, "init"),
    P(596, 1, "node dist/cli.js"),
    // offenes Portal: Treiber, Browser, Helfer (Helfer ohne Profilangabe)
    P(700, 596, "/usr/bin/chromedriver --port=41557"),
    P(701, 700, "/usr/lib/chromium/chromium --ava-browser --ava-owner=596 --user-data-dir=/tmp/ava-chrome-offen"),
    P(702, 701, "/usr/lib/chromium/chromium --type=renderer --ava-owner=596"),
    // Leck 1: Portal beim Oeffnen gescheitert, Browser nirgends referenziert
    P(710, 596, "/usr/bin/chromedriver --port=37729"),
    P(711, 710, "/usr/lib/chromium/chromium --ava-browser --ava-owner=596 --user-data-dir=/tmp/ava-chrome-alt"),
    P(712, 711, "/usr/lib/chromium/chromium --type=gpu-process"),
    // Leck 2: build() gescheitert, chromedriver ohne Browser
    P(720, 596, "/usr/bin/chromedriver --port=36869"),
    // fremder Prozess bleibt
    P(730, 1, "/usr/lib/chromium/chromium --ava-browser --ava-owner=999 --user-data-dir=/tmp/ava-chrome-fremd"),
  ];
  const gewaehlt = waehleLecks(prozesse, 596, ["/tmp/ava-chrome-offen", "/tmp/ava-register-delta-si-x"]).sort((a, b) => a - b);
  assert.deepEqual(gewaehlt, [710, 711, 712, 720]);
});

test("Leck-Wache: ohne offenes Portal gehen alle eigenen Browser, nie der Worker selbst", () => {
  const prozesse = [
    P(1, 0, "init"),
    P(596, 1, "node dist/cli.js"),
    P(700, 596, "/usr/bin/chromedriver --port=1"),
    P(701, 700, "/usr/lib/chromium/chromium --ava-browser --ava-owner=596 --user-data-dir=/tmp/ava-chrome-a"),
    P(800, 596, "/bin/sh -c ps"),
  ];
  assert.deepEqual(waehleLecks(prozesse, 596, []).sort((a, b) => a - b), [700, 701]);
});
