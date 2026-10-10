// Block pruefen (auch mit rohen Umbruechen), mailto/Webmail, .eml mit Anhang
// und X-Unsent, Telegram-Text und Sprachausgabe ohne JSON.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const load = async (p) => { const m = await import(p); return m.default ?? m; };
const me = await load("../src/shared/mail-entwurf.ts");
const { emlBauen, anhaengeLaden } = await load("../src/main/mail-entwurf/eml.ts");
const { AttachmentStore } = await load("../src/main/agent/attachment-store.ts");
const { markdownZuText } = await load("../src/main/telegram/text.ts");
const { textFuerSprache } = await load("../src/main/sprache/relay.ts");
const { simpleParser } = await import("mailparser");

let fehler = 0;
const ok = (b, t) => { console.log(`${b ? "✓" : "✗"} ${t}`); if (!b) fehler++; };

const roh = '{"an": ["anna.muster@firma.de"], "betreff": "Ihre neue Halle in Bünde", "text": "Sehr geehrte Frau Muster,\n\nich habe gelesen …\n\nMit freundlichen Grüßen\nJoyce"}';
const r = me.mailEntwurfLesen(roh);
ok("entwurf" in r && r.entwurf.text.includes("\n\nich habe") && r.entwurf.cc.length === 0, "rohe Zeilenumbrueche im JSON-String werden toleriert");
ok("fehler" in me.mailEntwurfLesen('{"an": ["keine-adresse"], "text": "x"}'), "ungueltige Adresse wird abgelehnt");
const einzeln = me.mailEntwurfLesen({ an: "a@b.de; c@d.de", text: "Hallo" });
ok("entwurf" in einzeln && einzeln.entwurf.an.length === 2, "Empfaenger als Text mit ; wird zur Liste");
ok("fehler" in me.mailEntwurfLesen("kein json"), "kein JSON → Fehler statt Absturz");

const e = r.entwurf;
const m = me.mailtoUrl(e);
ok(m.startsWith("mailto:anna.muster%40firma.de?subject=") && m.includes("%0D%0A%0D%0Aich") && m.includes("B%C3%BCnde"), "mailto mit CRLF und Umlauten kodiert");
const g = new URL(me.webmailUrl(e, "gmail"));
ok(g.searchParams.get("to") === "anna.muster@firma.de" && g.searchParams.get("su") === e.betreff && g.searchParams.get("body") === e.text, "Gmail-Link traegt an, Betreff, Text");
const o = me.webmailUrl(e, "outlook-web");
ok(o.startsWith("https://outlook.office.com/mail/deeplink/compose?") && !o.includes("+") && new URL(o).searchParams.get("subject") === e.betreff, "Outlook-Web-Link ohne + fuer Leerzeichen");
ok(me.programmIstOutlook("Microsoft Outlook") && !me.programmIstOutlook("Mail"), "Outlook wird erkannt");
ok(me.emlDateiname(e) === "Ihre neue Halle in Bünde.eml", "Dateiname aus dem Betreff");

const store = new AttachmentStore(mkdtempSync(join(tmpdir(), "ava-mailentwurf-")));
const att = store.stage({ filename: "Referenz.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4 test")), conversationId: "c1" });
const mitAnhang = { ...e, anhaenge: [att.id] };
const a = anhaengeLaden(store, mitAnhang, "c1");
ok("anhaenge" in a && a.anhaenge[0].filename === "Referenz.pdf", "Anhang ueber das Handle aufgeloest");
const eml = await emlBauen(mitAnhang, a.anhaenge);
const p = await simpleParser(eml);
ok(p.headers.get("x-unsent") === "1", "X-Unsent: 1 gesetzt (Outlook oeffnet als Entwurf)");
ok(p.subject === e.betreff && p.to?.text.includes("anna.muster@firma.de") && p.text?.includes("ich habe gelesen"), "Betreff, Empfaenger, Text in der .eml");
ok(p.attachments.length === 1 && p.attachments[0].filename === "Referenz.pdf", "Anhang in der .eml");
ok("fehler" in anhaengeLaden(store, { ...e, anhaenge: ["gibt-es-nicht.pdf"] }, "c1"), "unbekannter Anhang → Fehler");

const md = `Hier der Entwurf:\n\n\`\`\`mail-entwurf\n${JSON.stringify(e)}\n\`\`\`\n\n**Bezugspunkt:** Pressemitteilung`;
const tg = markdownZuText(md);
ok(tg.includes("An: anna.muster@firma.de") && tg.includes("Betreff: Ihre neue Halle") && !tg.includes('"betreff"'), "Telegram bekommt lesbaren Entwurf statt JSON");
const sp = textFuerSprache(md);
ok(!sp.includes("{") && sp.includes("Mail-Entwurf an anna.muster@firma.de"), "Sprachausgabe nennt den Entwurf statt JSON vorzulesen");

console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
