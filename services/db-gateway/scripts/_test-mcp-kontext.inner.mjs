// ava_kontext: persoenliche Abschnitte kommen von der AVA, die sie hat (Server ohne
// Profil, Desktop mit Profil und Gedaechtnis).
import { readFileSync } from "node:fs";
for (const datei of ["../.env", "../.env.example"]) {
  let t = ""; try { t = readFileSync(new URL(datei, import.meta.url), "utf8"); } catch { continue; }
  for (const z of t.split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(z.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
}
const m = await import("../src/lib/mcp-kontext.ts");
const { zusammenfuehren } = m.default ?? m;
let fehler = 0;
const ok = (b, t) => { console.log(`${b ? "✓" : "✗"} ${t}`); if (!b) fehler++; };

const server = "## Über den Nutzer\nNoch kein Profil hinterlegt. Wenn es für die Aufgabe hilft, frag kurz …\n\n## Idealkundenprofil (ICP)\nMaschinenbau OWL\n\n## Was diese AVA kann\n- firmen\n\n## Lage\n- Instanz: Server headless-ava";
const desktop = "## Über den Nutzer\nQUIKK unterstützt B2B …\n- Regionen: Herford, Minden\n\n## Idealkundenprofil (ICP)\nAnderes ICP\n\n## Was AVA sich über den Nutzer gemerkt hat\n- duzt gern\n\n## Lage\n- Instanz: Desktop Mac";
const z = zusammenfuehren(server, [{ instanz: "Desktop Mac", text: desktop }]);
ok(z.includes("QUIKK unterstützt") && z.includes("(aus Desktop Mac)") && !z.includes("Noch kein Profil"), "Profil kommt von der Desktop-AVA, wenn der Server keins hat");
ok(z.includes("Maschinenbau OWL") && !z.includes("Anderes ICP"), "vorhandener ICP des MCP-Ziels bleibt");
ok(z.includes("- duzt gern") && z.indexOf("gemerkt hat") < z.indexOf("## Lage"), "Gedächtnis wird vor „Lage“ ergänzt");
ok(z.includes("Server headless-ava") && !z.includes("Desktop Mac\n- Instanz"), "Lage bleibt die des MCP-Ziels");
ok(zusammenfuehren(desktop, []) === desktop, "ohne andere AVAs unverändert");

console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
