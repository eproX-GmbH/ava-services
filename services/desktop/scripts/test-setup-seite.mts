// Setup-Seite des Servers (src/server/setup-seite.ts) und Fehlertexte der ChatGPT-Anmeldung
// ohne Fenster (siwc-headless.ts). Prueft Zustaende, Formularziele und Feldnamen gegen
// setupPost in main.ts, Ausblenden gesperrter Bereiche, Escaping und Jargon.
//   ../../node_modules/.bin/tsx scripts/test-setup-seite.mts
const load = async (p: string) => { const m: any = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const { setupSeiteHtml, linkAbgelaufenHtml } = await load("../src/server/setup-seite.ts");
const { siwcTauschFehlerText } = await load("../src/main/auth/siwc-headless.ts");
let fails = 0;
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(`${ok ? "  ok" : "  FAIL"} ${msg}`); };

// ---- Fehlertexte der ChatGPT-Anmeldung ----
const httpFehler = (status: number, detail: string) => Object.assign(new Error(`ChatGPT-Token-Tausch antwortete mit HTTP ${status}: ${detail}`), { status, detail });
const ig = siwcTauschFehlerText(httpFehler(400, '{"error":"invalid_grant","error_description":"Invalid authorization code"}'));
check(/abgelaufen oder wurde schon verwendet/.test(ig) && !/invalid_grant|HTTP/.test(ig), "invalid_grant → verständlicher Satz ohne Rohtext (Befund 2026-11-24)");
check(/Plus oder Pro/.test(siwcTauschFehlerText(httpFehler(403, "forbidden"))), "403 → Hinweis auf Plus/Pro");
check(/nicht erreichbar/.test(siwcTauschFehlerText(httpFehler(503, "down"))), "5xx → OpenAI nicht erreichbar");
const f400 = siwcTauschFehlerText(httpFehler(400, '{"error":"invalid_request"}'));
check(/Fehler 400/.test(f400) && !/invalid_request/.test(f400), "anderer 4xx → kurzer Satz mit Code, ohne Rohantwort");

// ---- Seite ----
const jetzt = Date.parse("2026-11-24T13:00:00Z");
const anbieter = ["openai", "google", "mistral"].map((kind) => ({ kind, name: kind === "openai" ? "OpenAI" : kind, quelle: null }));
const basis = {
  version: "0.1.980", instanzName: "Server <b>X</b>", t: "tok_123-ABC", jetzt, meldung: null, bereit: true, phase: "laeuft",
  anmeldung: { zustand: "angemeldet", konto: "a@b.de" },
  modell: { aktiv: { art: "keins" }, verschluesselt: true, vorgabe: null, anbieter, abo: { verbunden: false, email: null, planScope: false, link: null, linkBis: null } },
  telegram: { zustand: "ohne_bot", verschluesselt: true },
  mail: { zustand: "neu", entwurf: null },
  instanzen: { liste: [
    { id: "eins", name: "Server", art: "server", version: "0.1.980", verbunden: true, eigen: true, telegram: null, radar: null, mcp: "beantwortet", umziehbar: false },
    { id: "zwei&drei", name: "Mac <i>", art: "desktop", version: "0.1.979", verbunden: true, eigen: false, telegram: "@bot", radar: true, mcp: "bereit", umziehbar: true },
  ], umzug: null },
};
const seite = (patch: Record<string, unknown>) => setupSeiteHtml({ ...basis, ...patch }) as string;
const abschnitt = (html: string, id: string) => { const a = html.indexOf(`<section class="karte" id="${id}"`); if (a < 0) return ""; const e = html.indexOf("</section>", a); return html.slice(a, e); };

const leer = seite({});
check(/Noch kein KI-Modell eingerichtet/.test(leer), "ohne Modell: deutliche Warnung");
check(leer.includes('action="/setup/key?t=tok_123-ABC"') && leer.includes('name="anbieter"') && leer.includes('name="schluessel"'), "Schlüssel-Formular: Ziel und Feldnamen wie setupPost");
check(/action="\/setup\/chatgpt\/start\?t=tok_123-ABC&amp;direkt=1" target="_blank"/.test(leer), "ChatGPT-Anmeldung startet direkt im neuen Tab");
check(!leer.includes('name="adresse"'), "ohne laufenden Link kein Eingabefeld für die Adresse");
check(/Plus oder Pro/.test(abschnitt(leer, "modell")) && /kostenlosen/.test(abschnitt(leer, "modell")), "Hinweis vorab: Plus/Pro nötig, Free reicht nicht");
check(!/settings_set_api_key|Producer|Aktiver Anbieter|Werkzeug/.test(leer), "kein Jargon");
check(leer.includes("Server &lt;b&gt;X&lt;/b&gt;") && leer.includes("Mac &lt;i&gt;") && !leer.includes("<b>X</b>"), "Namen werden escaped");
check(leer.includes("id=zwei%26drei"), "Umzug-Ziel-ID im Formularziel kodiert");
check(!/<body[^>]*data-zustand/.test(leer), "angemeldet und bereit: keine Statusabfrage");
check(/class="kachel" href="#telegram"/.test(leer) && /class="kachel" href="#mail"/.test(leer), "Übersicht mit Kacheln für alle Bereiche");
check(/Fragen\? Schreib uns an <a href="mailto:info@eprox-gmbh\.de">/.test(leer), "Kontakt info@eprox-gmbh.de im Fuß");

const link = "https://auth.openai.com/oauth/authorize?a=1&state=x";
const mitLink = seite({ modell: { ...basis.modell, abo: { ...basis.modell.abo, link, linkBis: jetzt + 15 * 60_000 } } });
check(mitLink.includes('name="adresse"') && mitLink.includes('action="/setup/chatgpt/callback?t=tok_123-ABC"'), "laufender Link: Eingabefeld und Ziel /setup/chatgpt/callback");
check(mitLink.includes('href="https://auth.openai.com/oauth/authorize?a=1&amp;state=x"'), "Anmeldelink escaped im href");
check(/Gültig bis 14:15 Uhr/.test(mitLink), "Gültigkeit in Berliner Zeit");

check(!/ChatGPT-Abo<\/h3>/.test(seite({ modell: { ...basis.modell, abo: null } })), "Abo nicht erlaubt: Weg ganz ausgeblendet");
const vorgabe = seite({ modell: { ...basis.modell, vorgabe: "OpenAI", aktiv: { art: "schluessel", anbieter: "OpenAI", organisation: true } } });
check(!vorgabe.includes("/setup/key?") && /gibt das KI-Modell vor/.test(vorgabe), "Anbieter-Sperre: kein Schlüssel-Formular, Hinweis auf Vorgabe");
check(/dem Schlüssel eurer Organisation/.test(vorgabe), "aktiver Weg: Schlüssel der Organisation");
check(!seite({ modell: { ...basis.modell, verschluesselt: false } }).includes('name="schluessel"'), "ohne Verschlüsselung kein Schlüssel-Formular");

const ohneBereiche = seite({ telegram: null, mail: null });
check(!ohneBereiche.includes('id="telegram"') && !ohneBereiche.includes('href="#telegram"') && !ohneBereiche.includes('id="mail"'), "abgeschaltete Bereiche komplett ausgeblendet");

const meldung = seite({ meldung: { art: "fehler", text: "Kaputt <x>", bereich: "modell" } });
check(abschnitt(meldung, "modell").includes("Kaputt &lt;x&gt;") && !abschnitt(meldung, "anmeldung").includes("Kaputt"), "Meldung erscheint in der Karte ihres Bereichs");
check(seite({ meldung: { art: "ok", text: "Oben" } }).indexOf("Oben") < seite({ meldung: { art: "ok", text: "Oben" } }).indexOf('id="anmeldung"'), "Meldung ohne Bereich steht oben");

const code = seite({ phase: "anmeldung", anmeldung: { zustand: "code", link: "https://auth.ava.bi/device?user_code=AB-CD", adresse: "auth.ava.bi/device", code: "AB-CD", bis: jetzt + 600_000, hinweis: null, gebunden: "a@b.de" } });
check(code.includes('data-zustand="anmeldung|false|true"') && code.includes(`data-neu-ab="${jetzt + 602_000}"`), "Code: Statusabfrage und Neuladen nach Ablauf");
check(code.includes('data-kopieren="AB-CD"') && /nur dieses Konto/.test(code), "Code kopierbar, gebundenes Konto genannt");
const warten = seite({ phase: "anmeldung", anmeldung: { zustand: "wartet", phase: "anmeldung", fehler: "fetch failed", gebunden: null } });
check(/Anmeldedienst antwortet gerade nicht/.test(warten) && warten.includes('data-zustand="anmeldung|false|false"'), "Anmeldedienst weg: klarer Hinweis, Seite wartet");
const start = seite({ bereit: false, phase: "komposition", anmeldung: { zustand: "wartet", phase: "komposition", fehler: null, gebunden: null }, modell: null, telegram: null, mail: null, instanzen: null });
check(!start.includes('class="uebersicht"') && /AVA startet gerade/.test(start), "Start: nur Anmeldung, keine Kacheln");

const konto = { address: "ava@x.de", displayName: "AVA", imap: { host: "imap.x.de", port: 993, secure: true, user: "ava@x.de" }, smtp: { host: "smtp.x.de", port: 465, secure: true, user: "ava@x.de" }, outboundEnabled: true, autoTriageEnabled: false, pollIntervalMinutes: 15, lastSyncAt: null, lastErrorAt: null, lastErrorMessage: null };
const mail = seite({ mail: { zustand: "eingerichtet", konto, verbindung: "idling", allowlist: [{ id: "e1", pattern: "*@kunde.de", label: "Kunde" }], entwurf: null } });
for (const ziel of ["mail/schalten", "mail/allowlist", "mail/allowlist-entfernen", "mail/trennen", "mail/speichern"]) check(mail.includes(`action="/setup/${ziel}?t=tok_123-ABC"`), `Mail-Formular ${ziel}`);
for (const name of ["address", "displayName", "imapHost", "imapPort", "imapUser", "imapPassword", "imapSecure", "smtpHost", "smtpPort", "smtpUser", "smtpPassword", "smtpSecure", "pollIntervalMinutes", "outboundEnabled", "autoTriageEnabled", "pattern", "label", "id"]) check(mail.includes(`name="${name}"`), `Mail-Feld ${name}`);
const entwurf = seite({ mail: { zustand: "neu", entwurf: { address: "neu@x.de", imapHost: "imap.neu.de", imapSecure: "on" } } });
check(entwurf.includes('value="neu@x.de"') && entwurf.includes('value="imap.neu.de"') && entwurf.includes('<details class="aufklapp" open>'), "fehlgeschlagener Versuch: Formular offen und vorausgefüllt");
check(!/name="imapPassword"[^>]*value="[^"]+"/.test(entwurf), "Passwörter nie vorausgefüllt");

const tg = seite({ telegram: { zustand: "verbunden", bot: "mein_bot", andere: ["Mac"], meldungen: true, eingang: false, schwelle: "urgent", ruhezeiten: false } });
for (const ziel of ["telegram/schalten", "telegram/test", "telegram/trennen"]) check(tg.includes(`action="/setup/${ziel}?t=tok_123-ABC"`), `Telegram-Formular ${ziel}`);
check(tg.includes('name="enabled" checked') && tg.includes('name="inbound" >'), "Telegram-Schalter mit Zustand");
check(/nur dringende Meldungen/.test(tg) && /hängt auch an Mac/.test(tg), "Schwelle auf Deutsch, doppelter Bot gemeldet");
check(seite({ telegram: { zustand: "ohne_bot", verschluesselt: true } }).includes('action="/setup/telegram/token?t=tok_123-ABC"'), "Telegram: Token-Formular");
check(seite({ telegram: { zustand: "ohne_chat", bot: "mein_bot", andere: [] } }).includes('action="/setup/telegram/chat?t=tok_123-ABC"'), "Telegram: Chat verknüpfen");

check(/Dieser Link gilt nicht mehr/.test(linkAbgelaufenHtml()) && /Deine AVA/.test(linkAbgelaufenHtml()), "abgelaufener Link: Weg zum neuen Link");

if (fails > 0) { console.log(`\n${fails} Fehler`); process.exit(1); }
console.log("\nSetup-Seite ok");
