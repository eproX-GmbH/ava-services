// Server-Instanzen aus der Konsole aktualisieren (docs/PLAN_AVA_CLOUD.md §14.5):
// nur vom Operator vorgesehene Apps, Versionsvergleich, kein Token → nicht eingerichtet.
import { readFileSync } from "node:fs";
for (const datei of ["../.env", "../.env.example"]) {
  let text = "";
  try { text = readFileSync(new URL(datei, import.meta.url), "utf8"); } catch { continue; }
  for (const z of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(z.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
process.env.ROUTER_ZUORDNUNG = "headless-ava=headless-ava";
delete process.env.FLY_API_TOKEN;
const m = await import("../src/lib/instanz-update.ts");
const { appVorgesehen, flyAppVon, versionNeuer, updateEingerichtet, aktualisieren } = m.default ?? m;
let fehler = 0;
const ok = (b, t) => { console.log(`${b ? "✓" : "✗"} ${t}`); if (!b) fehler++; };

ok(appVorgesehen("ava-i-zimmer") && appVorgesehen("headless-ava"), "Kunden-Apps und ROUTER_ZUORDNUNG sind vorgesehen");
ok(!appVorgesehen("ava-db-gateway") && !appVorgesehen("ava-i-zimmer-ollama") && !appVorgesehen("ava-server-image"), "Gateway, Ollama-Beiwagen und Image-App nie");
ok(flyAppVon(null, "Server headless-ava") === "headless-ava", "ältere AVA: App aus dem Standardnamen");
ok(flyAppVon("ava-db-gateway", "Server ava-i-x") === null, "gemeldete fremde App wird nicht übernommen");
ok(flyAppVon(null, "Mein Server") === null, "umbenannte ältere Instanz ohne Meldung: nicht aktualisierbar");
ok(versionNeuer("0.1.803", "0.1.797") && !versionNeuer("0.1.797", "0.1.797") && versionNeuer("0.2.0", "0.1.999"), "Versionsvergleich numerisch");
ok(!updateEingerichtet(), "ohne FLY_API_TOKEN nicht eingerichtet");
let e = null;
try { await aktualisieren("headless-ava", "0.1.797", "0.1.803", ["a@b.de"]); } catch (err) { e = err.message; }
ok(e?.includes("nicht eingerichtet"), "Aktualisieren ohne Token lehnt ab");

console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
