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

// --- Profilverzeichnis als Erkennungsmerkmal (2026-09-18) --------------------
// Jeder AVA-Browser traegt seit v0.1.680 ein eigenes Profil unterhalb von
// ava-chrome-. Das muss reichen, auch wenn die Besitzerkennung fehlt, und darf
// den Browser der Person nie erfassen — auch dann nicht, wenn diese selbst mit
// einem eigenen Profil arbeitet.
const mitProfil = [
  p(1, 0, "/sbin/launchd"),
  p(100, 1, "/Applications/AVA.app/Contents/MacOS/AVA"),
  // AVA-Browser, Besitzer tot: muss weg
  p(600, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --ava-browser --ava-owner=999 --user-data-dir=/var/folders/ab/ava-chrome-Xy12"),
  p(601, 600, "Google Chrome Helper --type=renderer --ava-browser --user-data-dir=/var/folders/ab/ava-chrome-Xy12"),
  // AVA-Browser ohne Besitzerkennung: trotzdem zweifelsfrei unserer
  p(610, 1, "Google Chrome --headless=new --ava-browser --user-data-dir=/var/folders/ab/ava-chrome-Zz99"),
  // Browser der Person mit EIGENEM Profil: niemals anfassen
  p(700, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/mein-profil"),
  p(701, 700, "Google Chrome Helper --type=renderer"),
  // Browser der Person, dessen Profilpfad zufaellig wie unserer heisst: kein
  // Treffer. Genau deshalb ist der Schalter das Merkmal und nicht der Pfad.
  p(800, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/ava-chrome-notizen-projekt"),
];
r = waehleVerwaiste(mitProfil, { eigenePid: 100 }).sort((a, b) => a - b);
assert.deepEqual(r, [600, 601, 610], "AVA-Profil erkannt, Profile der Person unberuehrt");
console.log("  ok   Schalter erkennt AVA-Browser auch ohne Besitzerkennung; aehnlicher Profilpfad der Person nicht");

// Lebender Besitzer: im laufenden Betrieb bleibt der Browser, beim App-Ende geht er.
const lebt = [
  p(1, 0, "/sbin/launchd"),
  p(100, 1, "/Applications/AVA.app/Contents/MacOS/AVA"),
  p(200, 100, "node producer sc"),
  p(620, 200, "Google Chrome --headless=new --ava-browser --ava-owner=200 --user-data-dir=/var/folders/ab/ava-chrome-Aa11"),
];
assert.deepEqual(waehleVerwaiste(lebt, { eigenePid: 100 }), [], "laufender Browser eines lebenden Producers bleibt");
assert.deepEqual(waehleVerwaiste(lebt, { eigenePid: 100, alle: true }), [620], "beim App-Ende geht auch er");
console.log("  ok   lebender Besitzer bleibt im Betrieb, geht beim App-Ende");

// Der Browser der Person darf NIE erfasst werden, in keiner Betriebsart.
const nurNutzer = [
  p(1, 0, "/sbin/launchd"),
  p(500, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  p(501, 500, "Google Chrome Helper --type=renderer"),
  p(502, 500, "Google Chrome Helper --type=gpu-process"),
  p(700, 1, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/mein-profil"),
];
for (const alle of [false, true]) {
  assert.deepEqual(waehleVerwaiste(nurNutzer, { eigenePid: 9, alle }), [], `Nutzer-Chrome unberuehrt (alle=${alle})`);
}
console.log("  ok   Browser der Person bleibt in jeder Betriebsart unberuehrt");

console.log("Browser-Sweep-Tests ok");
