import assert from "node:assert/strict";
const { waehleVerwaiste } = await import("../src/main/browser-sweep.ts");
const p = (pid, ppid, args) => ({ pid, ppid, args });
const liste = [
  p(1, 0, "/sbin/launchd"),
  p(100, 1, "/Applications/AVA.app/Contents/MacOS/AVA"),
  p(200, 100, "node producer sc"), // lebender Producer
  p(201, 200, "/Users/x/.cache/selenium/chromedriver --port=1"),
  p(202, 201, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --ava-owner=200"),
  p(203, 202, "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper --type=renderer --ava-owner=200"),
  p(300, 1, "/Users/x/.cache/selenium/chromedriver --port=2"), // verwaist
  p(301, 300, "Google Chrome --headless=new --ava-owner=999"), // Besitzer tot
  p(302, 301, "Google Chrome Helper --type=gpu-process --ava-owner=999"),
  p(400, 1, "Google Chrome --headless=new --user-data-dir=/tmp/x"), // Altbestand ohne Marker
  p(401, 400, "Google Chrome Helper --type=renderer"),
  p(500, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), // Browser des Nutzers: sichtbar, kein Marker
  p(501, 500, "Google Chrome Helper --type=renderer"),
];
let r = waehleVerwaiste(liste, { eigenePid: 100 }).sort((a, b) => a - b);
assert.deepEqual(r, [300, 301, 302, 400, 401], "nur Waisen, samt Kindern; lebender Producer und Nutzer-Chrome bleiben");
console.log("  ok   Waisen: chromedriver ohne Eltern, toter Besitzer, Altbestand headless; Nutzer-Chrome unberuehrt");
r = waehleVerwaiste(liste, { eigenePid: 100, alle: true }).sort((a, b) => a - b);
assert.deepEqual(r, [202, 203, 300, 301, 302, 400, 401], "beim App-Ende auch markierte Browser lebender Producer");
console.log("  ok   App-Ende: alle markierten Browser, chromedriver des lebenden Producers erst nach dessen Ende");
assert.deepEqual(waehleVerwaiste([p(1, 0, "launchd"), p(500, 1, "Google Chrome"), p(501, 500, "Google Chrome Helper --type=renderer")]), [], "nichts zu tun");
console.log("  ok   ohne AVA-Browser nichts");
console.log("Browser-Sweep-Tests ok");
