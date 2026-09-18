import assert from "node:assert/strict";
const { entscheide } = await import("../src/main/externe-links.ts");

const PAKET = "file:///Applications/AVA.app/Contents/Resources/app.asar/out/renderer/index.html";
const DEV = "http://localhost:5173/";

// Der eigentliche Fehler: ein gewoehnlicher Anker auf eine Firmenseite
// ersetzte die App durch die Seite.
for (const start of [PAKET, DEV]) {
  assert.equal(entscheide("https://www.picuscap.com/team", start), "nach-aussen");
  assert.equal(entscheide("http://example.org", start), "nach-aussen");
  assert.equal(entscheide("https://www.linkedin.com/in/jemand", start), "nach-aussen");
}
console.log("  ok   Webseiten gehen nach draussen, im Paket wie im Entwicklungsbetrieb");

// Mail und Telefon gehoeren ins Mail-Programm bzw. an das Telefon —
// im Fenster wuerden sie nur eine leere Seite ergeben.
assert.equal(entscheide("mailto:anthony@example.com", PAKET), "nach-aussen");
assert.equal(entscheide("tel:+493012345", PAKET), "nach-aussen");
console.log("  ok   mailto und tel gehen an das Betriebssystem");

// Die App selbst darf navigieren, sonst waere die Oberflaeche tot.
assert.equal(entscheide(PAKET, PAKET), "im-fenster");
assert.equal(entscheide(PAKET + "#/companies/DE123", PAKET), "im-fenster");
assert.equal(entscheide("file:///Applications/AVA.app/Contents/Resources/app.asar/out/renderer/unter/seite.html", PAKET), "im-fenster");
assert.equal(entscheide("http://localhost:5173/index.html", DEV), "im-fenster");
console.log("  ok   die App selbst darf im Fenster navigieren");

// Ein Link aus fremdem Inhalt (Website-Text, Agent-Antwort, Registerauszug)
// darf NICHT bestimmen, was das Betriebssystem oeffnet.
for (const boese of [
  "javascript:alert(1)",
  "file:///etc/passwd",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "smb://server/freigabe",
  "nicht-mal-eine-url",
  "",
]) {
  assert.equal(entscheide(boese, DEV), "verwerfen", `haette verworfen werden muessen: ${boese}`);
}
console.log("  ok   javascript:, data:, fremde Schemata und Unsinn werden verworfen");

// file: aus dem Entwicklungsbetrieb heraus ist NICHT die App.
assert.equal(entscheide("file:///etc/passwd", DEV), "verwerfen");
// Und auch aus dem Paket heraus nicht: "beides file:" genuegt nicht, sonst
// zeigte das Fenster jede Datei der Platte an.
assert.equal(entscheide("file:///etc/passwd", PAKET), "verwerfen");
assert.equal(entscheide("file:///Users/mac/.ssh/id_rsa", PAKET), "verwerfen");
assert.equal(entscheide("file:///Applications/AVA.app/Contents/Resources/anderswo.html", PAKET), "verwerfen");
// Eine andere Herkunft im Entwicklungsbetrieb ist aussen, nicht innen.
assert.equal(entscheide("http://localhost:5174/", DEV), "nach-aussen");
assert.equal(entscheide("https://localhost:5173/", DEV), "nach-aussen");
console.log("  ok   fremde Herkunft bleibt aussen, auch bei aehnlicher Adresse");

console.log("Externe-Links-Tests ok");
