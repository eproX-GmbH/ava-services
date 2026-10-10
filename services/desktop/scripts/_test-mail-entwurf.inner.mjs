// Block pruefen (auch mit rohen Umbruechen), mailto/Webmail, .eml mit Anhang
// und X-Unsent, Telegram-Text und Sprachausgabe ohne JSON.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
// Plattform-Schicht wie im Server: Daten in einen Testordner, Geheimnisse mit Testschlüssel.
process.env.AVA_DATA_DIR = mkdtempSync(join(tmpdir(), "ava-mailentwurf-daten-"));
process.env.AVA_SECRETS_KEY = randomBytes(32).toString("hex");
const load = async (p) => { const m = await import(p); return m.default ?? m; };
const me = await load("../src/shared/mail-entwurf.ts");
const plattform = await load("../src/core/platform.ts");
const { createNodePlatform } = await load("../src/core/platform-node.ts");
plattform.setPlatform(createNodePlatform());
const { emlBauen, anhaengeLaden, entwurfInsPostfach } = await load("../src/main/mail-entwurf/eml.ts");
const { FesteAnhaenge } = await load("../src/main/mail-entwurf/feste-anhaenge.ts");
const postfach = await load("../src/main/mail-entwurf/postfach.ts");
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
const a = anhaengeLaden({ chat: store }, mitAnhang, "c1");
ok("anhaenge" in a && a.anhaenge[0].filename === "Referenz.pdf", "Anhang ueber das Handle aufgeloest");
const eml = await emlBauen(mitAnhang, a.anhaenge);
const p = await simpleParser(eml);
ok(p.headers.get("x-unsent") === "1", "X-Unsent: 1 gesetzt (Outlook oeffnet als Entwurf)");
ok(p.subject === e.betreff && p.to?.text.includes("anna.muster@firma.de") && p.text?.includes("ich habe gelesen"), "Betreff, Empfaenger, Text in der .eml");
ok(p.attachments.length === 1 && p.attachments[0].filename === "Referenz.pdf", "Anhang in der .eml");
ok("fehler" in anhaengeLaden({ chat: store }, { ...e, anhaenge: ["gibt-es-nicht.pdf"] }, "c1"), "unbekannter Anhang → Fehler");

// Feste Anhänge (E8)
const fest = new FesteAnhaenge(mkdtempSync(join(tmpdir(), "ava-fest-")));
const profil = fest.hinzufuegen({ name: "Firmenprofil.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF profil v1")), immer: true, beschreibung: "Erstkontakt" });
ok(profil.id.startsWith("fix-") && fest.liste().length === 1, "fester Anhang mit Handle fix-…");
const v2 = fest.hinzufuegen({ name: "firmenprofil.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF profil v2")) });
ok(v2.id === profil.id && fest.liste().length === 1 && v2.immer === true, "gleicher Name ersetzt die alte Fassung, „immer“ bleibt");
const beide = anhaengeLaden({ chat: store, fest }, { ...e, anhaenge: [profil.id, att.id] }, "c1");
ok("anhaenge" in beide && beide.anhaenge.length === 2 && beide.anhaenge[0].content.toString() === "%PDF profil v2", "fester Anhang und Chat-Upload zusammen, neueste Fassung");
ok("fehler" in anhaengeLaden({ fest }, { ...e, anhaenge: ["fix-weg"] }), "entfernter fester Anhang → klarer Fehler");
ok(fest.promptText()?.includes(`${profil.id}: firmenprofil.pdf – Erstkontakt (immer an Outreach-Mails)`), "Prompt-Zeile mit Handle, Beschreibung, immer");
ok(fest.entfernen(profil.id) && fest.liste().length === 0, "fester Anhang entfernt");

// Automatische Wahl (E7)
ok(me.autoWeg("Microsoft Outlook", true, true) === "eml", "Outlook → .eml, auch mit Postfach");
ok(me.autoWeg("Mail", true, true) === "postfach" && me.autoWeg("Mail", true, false) === "mailto", "Apple Mail: mit Anhängen ins Postfach, ohne mailto:");
ok(me.autoWeg(null, true, false) === "postfach" && me.autoWeg(null, false, false) === "keins", "ohne Programm: Postfach, sonst Webmail-Auswahl");

// Entwurfs-Postfach (Stufe 3) mit nachgebautem IMAP-Server
ok(postfach.entwuerfeOrdner([{ path: "INBOX" }, { path: "Entwürfe" }]) === "Entwürfe", "Entwürfe-Ordner über den Namen");
ok(postfach.entwuerfeOrdner([{ path: "INBOX" }, { path: "Concepts", specialUse: "\\Drafts" }]) === "Concepts", "Entwürfe-Ordner über \\Drafts");
const abgelegt = [];
const fabrik = (pass) => async (o) => ({
  connect: async () => { if (o.pass !== pass) throw new Error("Authentication failed"); },
  list: async () => [{ path: "INBOX" }, { path: "Drafts", specialUse: "\\Drafts" }],
  append: async (pfad, inhalt, flags) => { abgelegt.push({ pfad, inhalt, flags }); },
  logout: async () => {},
});
const eingabe = { anbieter: "ionos", host: "imap.ionos.de", port: 993, secure: true, benutzer: "joyce@firma.de", absender: "joyce@firma.de", name: "Joyce R." };
const falsch = await postfach.postfachEinrichten(eingabe, "falsch", fabrik("richtig"));
ok(!falsch.ok && falsch.fehler.includes("Anmeldung abgelehnt") && !postfach.postfachStand().eingerichtet, "falsches Passwort: verständliche Meldung, nichts gespeichert");
const gesperrt = await postfach.postfachEinrichten({ ...eingabe, anbieter: "microsoft" }, "x", fabrik("x"));
ok(!gesperrt.ok, "Microsoft per Passwort wird abgelehnt (Hinweis auf .eml)");
const gut = await postfach.postfachEinrichten(eingabe, "richtig", fabrik("richtig"));
ok(gut.ok && postfach.postfachStand().eingerichtet && postfach.postfachStand().ordner === "Drafts", "Postfach eingerichtet, Ordner gemerkt");
ok(!JSON.stringify(postfach.postfachStand()).includes("richtig"), "Passwort steht nicht im Stand");
const r2 = await entwurfInsPostfach(mitAnhang, { chat: store }, "c1", fabrik("richtig"));
const abl = abgelegt.at(-1);
const geparst = await simpleParser(abl.inhalt);
ok(r2.ordner === "Drafts" && abl.flags.includes("\\Draft") && abl.flags.includes("\\Seen"), "Entwurf mit \\Draft und \\Seen im Entwürfe-Ordner");
ok(geparst.from?.text.includes("joyce@firma.de") && geparst.attachments.length === 1 && !geparst.headers.get("x-unsent"), "Entwurf mit Absender und Anhang, ohne X-Unsent");
postfach.postfachEntfernen();
ok(!postfach.postfachStand().eingerichtet, "Postfach entfernt");

const md = `Hier der Entwurf:\n\n\`\`\`mail-entwurf\n${JSON.stringify(e)}\n\`\`\`\n\n**Bezugspunkt:** Pressemitteilung`;
const tg = markdownZuText(md);
ok(tg.includes("An: anna.muster@firma.de") && tg.includes("Betreff: Ihre neue Halle") && !tg.includes('"betreff"'), "Telegram bekommt lesbaren Entwurf statt JSON");
const sp = textFuerSprache(md);
ok(!sp.includes("{") && sp.includes("Mail-Entwurf an anna.muster@firma.de"), "Sprachausgabe nennt den Entwurf statt JSON vorzulesen");

console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
