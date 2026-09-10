const load = async (p) => { const m = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const P = await load("../src/main/contacts/email-muster/pattern.ts");
let fails = 0;
const check = (c, msg) => { if (!c) { fails++; console.log("  FAIL", msg); } else console.log("  ok  ", msg); };

console.log("Funktionsadressen");
check(P.istFunktionsadresse("info@example.de") && P.istFunktionsadresse("hr@mutares.com") && P.istFunktionsadresse("ir@mutares.com") && P.istFunktionsadresse("hello@conventic.com"), "info/hr/ir/hello erkannt");
check(!P.istFunktionsadresse("joyce@quikk.de") && !P.istFunktionsadresse("anna.meier@firma.de"), "Personen nicht als Funktion");

console.log("Namensvarianten");
const v = P.nameVarianten("Dr. Jürgen Müller-Lüdenscheid");
check(v.some((n) => n.vorname === "juergen" && n.nachname === "mueller-luedenscheid"), "Umlaute ausgeschrieben + Bindestrich: " + JSON.stringify(v.slice(0, 2)));
check(v.some((n) => n.nachname === "muellerluedenscheid"), "Bindestrich-freie Variante");
check(v.some((n) => n.vorname === "jurgen"), "Diakritika-Variante");
const vv = P.nameVarianten("Anna Maria von der Leyen");
check(vv.some((n) => n.vorname === "anna" && n.nachname === "leyen") && vv.some((n) => n.nachname === "vonderleyen"), "Partikel mit/ohne: " + JSON.stringify(vv.map((n) => n.nachname)));
check(P.nameVarianten("Madonna").length === 0, "Einwort-Name → keine Varianten");

console.log("Muster erkennen");
const b1 = P.erkenneMuster("example.de", [{ fullName: "John Doe", email: "john.doe@example.de" }, { fullName: "Anna Meier", email: "anna.meier@example.de" }, { fullName: "Info", email: "info@example.de" }]);
check(b1.muster === "vorname.nachname" && b1.konfidenz === 0.85 && b1.belege.length === 2 && b1.funktionsadressen.length === 1, `vorname.nachname aus 2 Belegen: ${JSON.stringify({ m: b1.muster, k: b1.konfidenz, f: b1.funktionsadressen })}`);
const b2 = P.erkenneMuster("quikk.de", [{ fullName: "Joyce Marvin Rafflenbeul", email: "joyce@quikk.de" }]);
check(b2.muster === "vorname" && b2.konfidenz === 0.6, `vorname aus 1 Beleg (mehrere Vornamen): ${b2.muster} ${b2.konfidenz}`);
const b3 = P.erkenneMuster("x.de", [{ fullName: "Jürgen Müller", email: "j.mueller@x.de" }, { fullName: "Anna Meier", email: "a.meier@x.de" }, { fullName: "Hans Schmidt", email: "h.schmidt@x.de" }]);
check(b3.muster === "v.nachname" && b3.konfidenz === 0.95, `v.nachname mit Umlaut-Beleg, 3 Belege: ${b3.muster} ${b3.konfidenz}`);
const b4 = P.erkenneMuster("y.de", [{ fullName: "John Doe", email: "john.doe@y.de" }, { fullName: "Anna Meier", email: "ameier@y.de" }]);
check(b4.muster === null && b4.unerklaert.length === 2, `Widerspruch → kein Muster: ${b4.muster}`);
const b5 = P.erkenneMuster("z.de", [{ fullName: "John Doe", email: "john.doe@z.de" }, { fullName: "Anna Meier", email: "anna.meier@z.de" }, { fullName: "Alexander Groß", email: "alex@z.de" }]);
check(b5.muster === "vorname.nachname" && b5.konfidenz === 0.7 && b5.unerklaert.length === 1, `Teilmuster (2 von 3, Spitzname): ${b5.muster} ${b5.konfidenz}`);
const b6 = P.erkenneMuster("m.de", [{ fullName: "Bernd Maurer", email: "hello@m.de" }]);
check(b6.muster === null && b6.funktionsadressen.length === 1, "nur Funktionsadresse → kein Muster");
check(P.erkenneMuster("a.de", [{ fullName: "John Doe", email: "john.doe@b.de" }]).muster === null, "fremde Domain ignoriert");

console.log("Adressen bilden");
check(P.bildeAdresse("vorname.nachname", "Jürgen Müller", "example.de") === "juergen.mueller@example.de", "Umlaute ausgeschrieben");
check(P.bildeAdresse("v.nachname", "Anna-Lena Schmidt", "example.de") === "a.schmidt@example.de", "Bindestrich-Vorname → Initial");
check(P.bildeAdresse("vorname.nachname", "Prof. Dr. Klaus von Berg", "example.de") === "klaus.berg@example.de", "Titel weg, Partikel weg (Kurzform zuerst)");
check(P.bildeAdresse("vorname.nachname", "Madonna", "example.de") === null, "Einwort-Name → null");

console.log("Rueckmeldung (Bounce/Antwort)");
const R = await load("../src/main/contacts/email-muster/rueckmeldung.ts");
const bounce = R.bounceAdressen({ from: { address: "MAILER-DAEMON@mx.example.de", name: null }, subject: "Undelivered Mail Returned to Sender", bodyText: "The following address failed: a.tepe@basecom.de\nReporting-MTA: mx.example.de" }, new Set(["joyce@quikk.de"]));
check(bounce.length === 1 && bounce[0] === "a.tepe@basecom.de", "Bounce: betroffene Adresse aus Body: " + JSON.stringify(bounce));
const bounce2 = R.bounceAdressen({ from: { address: "postmaster@firma.de", name: null }, subject: "Zustellung fehlgeschlagen", bodyText: "An: joyce@quikk.de — Empfaenger m.muster@firma.de unbekannt" }, new Set(["joyce@quikk.de"]));
check(bounce2.length === 1 && bounce2[0] === "m.muster@firma.de", "Bounce (deutsch): eigene Adresse ausgeschlossen: " + JSON.stringify(bounce2));
check(R.bounceAdressen({ from: { address: "anna@firma.de", name: "Anna" }, subject: "Re: Termin", bodyText: "Hallo, gerne. anna@firma.de" }).length === 0, "normale Antwort ist kein Bounce");
const calls = [];
await R.meldeAbgeleiteteAdressen({ from: { address: "Anna.Meier@firma.de", name: null }, to: [{ address: "joyce@quikk.de", name: null }], subject: "Re: Termin", bodyText: "ok" }, async (path, opts) => { calls.push({ path, body: opts?.body }); return { gefunden: true, aktion: "bestaetigt" }; });
check(calls.length === 1 && calls[0].body.ergebnis === "antwort" && calls[0].body.email === "anna.meier@firma.de", "Antwort → feedback antwort (kleingeschrieben)");
calls.length = 0;
await R.meldeAbgeleiteteAdressen({ from: { address: "noreply@shop.de", name: null }, to: [{ address: "joyce@quikk.de", name: null }], subject: "Bestellung", bodyText: "x" }, async (path, opts) => { calls.push(1); return { gefunden: false, aktion: "keine" }; });
check(calls.length === 0, "noreply-Absender loest keine Rueckmeldung aus");

const S = await load("../src/main/contacts/email-muster/smtp-verify.ts");
console.log("SMTP-Hilfen");
check(/^ava-[a-z0-9]{10,}@example\.de$/.test(S.zufallsAdresse("example.de")), "Zufallsadresse fuer Catch-all-Test");

if (fails > 0) { console.log(`\n${fails} Fehler`); process.exit(1); }
console.log("\nE-Mail-Muster-Tests ok");
