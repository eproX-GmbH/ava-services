// Startsperre waehrend eines laufenden Updates (update-start-sperre.ts).
//   ../../node_modules/.bin/tsx scripts/test-update-sperre.mts
const load = async (p: string) => { const m: any = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const { updateSperrtStart } = await load("../src/main/update-start-sperre.ts");
let fails = 0;
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(`${ok ? "  ok" : "  FAIL"} ${msg}`); };
const jetzt = Date.parse("2026-11-10T07:28:47Z");
const flag = (version: string, vorMin: number) => JSON.stringify({ ts: jetzt - vorMin * 60_000, version });

check(updateSperrtStart({ flagInhalt: flag("0.1.959", 1), version: "0.1.959", shipItLaeuft: true, jetzt }), "alte Version startet waehrend der Installation → gesperrt (Fall 2026-11-10)");
check(!updateSperrtStart({ flagInhalt: flag("0.1.959", 1), version: "0.1.961", shipItLaeuft: true, jetzt }), "frisch aktualisierte Version darf starten, auch wenn ShipIt noch kurz lebt");
check(!updateSperrtStart({ flagInhalt: flag("0.1.959", 1), version: "0.1.959", shipItLaeuft: false, jetzt }), "ShipIt laeuft nicht mehr → normal starten");
check(!updateSperrtStart({ flagInhalt: flag("0.1.959", 20), version: "0.1.959", shipItLaeuft: true, jetzt }), "Flag aelter als 15 Minuten → normal starten");
check(!updateSperrtStart({ flagInhalt: String(jetzt), version: "0.1.959", shipItLaeuft: true, jetzt }), "altes Flag ohne Version → nie sperren");
check(!updateSperrtStart({ flagInhalt: null, version: "0.1.959", shipItLaeuft: true, jetzt }), "kein Flag → normal starten");

if (fails > 0) { console.log(`\n${fails} Fehler`); process.exit(1); }
console.log("\nUpdate-Startsperre ok");
