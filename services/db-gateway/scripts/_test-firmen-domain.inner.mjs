// Gehoert eine Adresse zur Firma? (Befund 2026-10-10: joyce@quikk.de bei Strategic IT)
const m = await import("../src/lib/firmen-domain.ts");
const { registrierbar, passtZurFirma } = m.default ?? m;
let fehler = 0;
const ok = (b, t) => { console.log(`${b ? "✓" : "✗"} ${t}`); if (!b) fehler++; };
ok(registrierbar("https://www.strategic-it.de/") === "strategic-it.de" && registrierbar("shop.firma.co.uk") === "firma.co.uk", "registrierbare Domain");
ok(passtZurFirma("sven@strategic-it.de", "https://www.strategic-it.de") === true, "eigene Domain passt");
ok(passtZurFirma("sven@mail.strategic-it.de", "strategic-it.de") === true, "Subdomain passt");
ok(passtZurFirma("joyce@quikk.de", "https://www.strategic-it.de") === false, "fremde Domain passt nicht");
ok(passtZurFirma("joyce@quikk.de", null) === null, "ohne Website unentscheidbar");
console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
