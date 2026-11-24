// Onboarding O5 (docs/PLAN_ONBOARDING.md): E-Mail-Vorlagen fuer Nutzer.
// Tabellen-Layout mit Inline-Styles (Outlook/Gmail), 600 px, Markenfarben
// #F2F7F6 / #00C0A7 / #0A1F2A. Links in die App gehen NUR auf eine konkrete Firma in
// der Web-App (app.ava.bi/firmen/<companyId>, Joyce 2026-11-08): ob die Desktop-App
// aufgeht, ist nicht sicher, die Firmenseite der Web-App schon. Das Logo kommt als Inline-Anhang (cid:ava-logo.png),
// damit keine Bildquelle im Netz noetig ist. Jede Mail hat eine Textfassung.

const FARBE = { grund: "#F2F7F6", akzent: "#00C0A7", akzentDunkel: "#009C88", text: "#0A1F2A", leise: "#5B6B73", linie: "#DCE7E5", karte: "#FFFFFF" };
const SCHRIFT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface Mail { betreff: string; html: string; text: string }

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function knopf(text: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px 0;"><tr><td align="center" bgcolor="${FARBE.akzent}" style="border-radius:8px;">
<a href="${esc(url)}" style="display:inline-block;padding:13px 26px;font-family:${SCHRIFT};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">${esc(text)}</a></td></tr></table>`;
}

function absatz(html: string): string {
  return `<p style="margin:0 0 14px 0;font-family:${SCHRIFT};font-size:15px;line-height:23px;color:${FARBE.text};">${html}</p>`;
}

function ueberschrift(text: string): string {
  return `<h1 style="margin:0 0 16px 0;font-family:${SCHRIFT};font-size:22px;line-height:29px;font-weight:700;color:${FARBE.text};">${esc(text)}</h1>`;
}

function zwischentitel(text: string): string {
  return `<p style="margin:22px 0 8px 0;font-family:${SCHRIFT};font-size:12px;letter-spacing:0.06em;text-transform:uppercase;font-weight:700;color:${FARBE.akzentDunkel};">${esc(text)}</p>`;
}

/** Hellgruener Kasten fuer Kerninhalte (ICP, Firmenliste). */
function kasten(inhalt: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px 0;"><tr><td style="background:${FARBE.grund};border-left:4px solid ${FARBE.akzent};border-radius:6px;padding:16px 18px;">${inhalt}</td></tr></table>`;
}

function chips(werte: string[]): string {
  return werte
    .map((w) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border-radius:999px;background:#FFFFFF;border:1px solid ${FARBE.linie};font-family:${SCHRIFT};font-size:13px;color:${FARBE.text};">${esc(w)}</span>`)
    .join("");
}

function rahmen(e: { vorschau: string; inhalt: string; fusszeile?: string }): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>AVA</title></head>
<body style="margin:0;padding:0;background:${FARBE.grund};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${FARBE.grund};">${esc(e.vorschau)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${FARBE.grund};"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 4px 18px 4px;"><img src="cid:ava-logo.png" width="69" height="36" alt="AVA" style="display:block;border:0;"></td></tr>
<tr><td style="background:${FARBE.karte};border-radius:14px;padding:32px 32px 26px 32px;border:1px solid ${FARBE.linie};">${e.inhalt}</td></tr>
<tr><td style="padding:18px 8px 0 8px;font-family:${SCHRIFT};font-size:12px;line-height:18px;color:${FARBE.leise};text-align:center;">
${e.fusszeile ? `${e.fusszeile}<br>` : ""}AVA ist ein Produkt der eproX GmbH · <a href="https://www.ava.bi/impressum" style="color:${FARBE.leise};">Impressum</a> · <a href="https://www.ava.bi/datenschutz" style="color:${FARBE.leise};">Datenschutz</a>
</td></tr></table></td></tr></table></body></html>`;
}

function abmelden(url: string): string {
  return `Du bekommst diese Mail, weil du dich bei AVA registriert hast. <a href="${esc(url)}" style="color:${FARBE.leise};">Keine Mails mehr von AVA</a>`;
}

// ---- 1. Willkommen ------------------------------------------------------------

export interface WillkommenDaten {
  vorname: string | null;
  domain: string;
  firma: string | null;
  angebot: string;
  beschreibung: string;
  branchen: string[];
  region: string | null;
  referenzen: Array<{ name: string; branche?: string }>;
  downloadUrl: string;
  bestaetigenUrl: string;
  abmeldenUrl: string;
}

export function willkommenMail(d: WillkommenDaten): Mail {
  const hallo = d.vorname ? `Hallo ${d.vorname},` : "Hallo,";
  const wer = d.firma ? `<strong>${esc(d.firma)}</strong> (${esc(d.domain)})` : `<strong>${esc(d.domain)}</strong>`;
  const refs = d.referenzen.slice(0, 5);
  const inhalt =
    ueberschrift("Ich habe mir deine Firma schon angesehen") +
    absatz(esc(hallo)) +
    absatz(`schön, dass du da bist. Während du dich registriert hast, habe ich mir die Website von ${wer} angesehen und daraus dein Idealkundenprofil abgeleitet. So kann ich dir gleich beim ersten Start passende Firmen zeigen.`) +
    zwischentitel("Was ihr anbietet") +
    absatz(esc(d.angebot)) +
    zwischentitel("Deine idealen Kunden") +
    kasten(
      `<p style="margin:0 0 12px 0;font-family:${SCHRIFT};font-size:15px;line-height:23px;color:${FARBE.text};">${esc(d.beschreibung)}</p>` +
        (d.branchen.length ? chips(d.branchen) : "") +
        (d.region ? `<p style="margin:8px 0 0 0;font-family:${SCHRIFT};font-size:13px;color:${FARBE.leise};">Region: ${esc(d.region)}</p>` : ""),
    ) +
    (refs.length
      ? zwischentitel("Eure Referenzen") +
        absatz(`Auf eurer Website habe ich ${refs.length === 1 ? "einen Referenzkunden" : `${refs.length} Referenzkunden`} gefunden und mir angesehen: ${refs.map((r) => `${esc(r.name)}${r.branche ? ` <span style="color:${FARBE.leise};">(${esc(r.branche)})</span>` : ""}`).join(", ")}. Firmen wie diese suche ich für dich bevorzugt.`)
      : "") +
    knopf("AVA herunterladen und loslegen", d.downloadUrl) +
    `<p style="margin:22px 0 0 0;padding-top:18px;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};font-size:14px;line-height:21px;color:${FARBE.text};">Soll ich dir Neuigkeiten zu deinen Firmen auch per E-Mail schicken, etwa einen neuen Geschäftsführer oder eine passende neue Firma in deiner Region? <a href="${esc(d.bestaetigenUrl)}" style="color:${FARBE.akzentDunkel};font-weight:600;">Ja, Neuigkeiten per E-Mail erhalten</a></p>`;
  const text = [
    hallo, "",
    `schön, dass du da bist. Während du dich registriert hast, habe ich mir die Website von ${d.firma ? `${d.firma} (${d.domain})` : d.domain} angesehen und daraus dein Idealkundenprofil abgeleitet.`, "",
    "WAS IHR ANBIETET", d.angebot, "",
    "DEINE IDEALEN KUNDEN", d.beschreibung,
    d.branchen.length ? `Branchen: ${d.branchen.join(", ")}` : "",
    d.region ? `Region: ${d.region}` : "",
    refs.length ? `\nEURE REFERENZEN\n${refs.map((r) => r.name).join(", ")}` : "", "",
    `AVA herunterladen: ${d.downloadUrl}`, "",
    `Neuigkeiten per E-Mail erhalten: ${d.bestaetigenUrl}`, "",
    `Keine Mails mehr von AVA: ${d.abmeldenUrl}`,
  ].filter((z) => z !== null).join("\n");
  return { betreff: d.firma ? `Dein Start mit AVA: So sehe ich ${d.firma}` : "Dein Start mit AVA", html: rahmen({ vorschau: `Dein Idealkundenprofil ist fertig: ${d.beschreibung.slice(0, 90)}`, inhalt, fusszeile: abmelden(d.abmeldenUrl) }), text };
}

// ---- 2. Deine Top 10 ----------------------------------------------------------

/** Firmenseite in der Web-App. */
export function firmenLink(appBasis: string, companyId: string): string {
  return `${appBasis.replace(/\/+$/, "")}/firmen/${encodeURIComponent(companyId)}`;
}

export interface Top10Daten {
  vorname: string | null;
  firmen: Array<{ name: string; ort: string | null; branche: string | null; score: number; grund: string; companyId?: string | null }>;
  appBasis: string;
  abmeldenUrl: string;
}

export function top10Mail(d: Top10Daten): Mail {
  const zeilen = d.firmen.slice(0, 10).map((f, i) => `<tr>
<td valign="top" style="padding:12px 10px 12px 0;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};font-size:13px;font-weight:700;color:${FARBE.akzentDunkel};width:22px;">${i + 1}</td>
<td valign="top" style="padding:12px 0;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};">
<div style="font-size:15px;font-weight:600;color:${FARBE.text};">${f.companyId ? `<a href="${esc(firmenLink(d.appBasis, f.companyId))}" style="color:${FARBE.text};text-decoration:underline;text-decoration-color:${FARBE.akzent};">${esc(f.name)}</a>` : esc(f.name)}</div>
<div style="font-size:13px;color:${FARBE.leise};margin:2px 0 4px 0;">${esc([f.branche, f.ort].filter(Boolean).join(" · "))}</div>
<div style="font-size:14px;line-height:20px;color:${FARBE.text};">${esc(f.grund)}</div></td>
<td valign="top" align="right" style="padding:12px 0 12px 10px;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};white-space:nowrap;">
<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${FARBE.grund};font-size:13px;font-weight:700;color:${FARBE.akzentDunkel};">${Math.round(f.score)}</span></td></tr>`).join("");
  const inhalt =
    ueberschrift(`Deine ${d.firmen.length === 10 ? "Top 10" : `${d.firmen.length} besten Treffer`}`) +
    absatz(esc(d.vorname ? `Hallo ${d.vorname},` : "Hallo,")) +
    absatz(`der Firmen-Radar ist zum ersten Mal durchgelaufen. Diese Firmen passen am besten zu deinem Idealkundenprofil. Ich habe sie in <strong>Meine Firmen</strong> übernommen und behalte sie ab jetzt für dich im Blick.`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px 0;">${zeilen}</table>` +
    absatz(`<span style="color:${FARBE.leise};font-size:13px;">Ein Klick auf den Namen öffnet die Firma in der AVA-App. Die Zahl ist die Passung zu deinem Profil (0 bis 100). Ändert sich bei einer dieser Firmen etwas Wichtiges, melde ich mich.</span>`);
  const text = [
    d.vorname ? `Hallo ${d.vorname},` : "Hallo,", "",
    "der Firmen-Radar ist zum ersten Mal durchgelaufen. Diese Firmen passen am besten zu deinem Idealkundenprofil und sind jetzt in Meine Firmen:", "",
    ...d.firmen.slice(0, 10).map((f, i) => `${i + 1}. ${f.name}${f.ort ? `, ${f.ort}` : ""} (${Math.round(f.score)}) – ${f.grund}${f.companyId ? `\n   ${firmenLink(d.appBasis, f.companyId)}` : ""}`), "",
    `Keine Mails mehr von AVA: ${d.abmeldenUrl}`,
  ].join("\n");
  return { betreff: `Deine Top ${Math.min(10, d.firmen.length)}: Diese Firmen passen zu dir`, html: rahmen({ vorschau: `${d.firmen[0]?.name ?? ""} und weitere passende Firmen`, inhalt, fusszeile: abmelden(d.abmeldenUrl) }), text };
}

// ---- 3. Neuigkeiten -----------------------------------------------------------

export interface NeuigkeitenDaten {
  vorname: string | null;
  meldungen: Array<{ firma: string; titel: string; text: string; art: string; quelleUrl: string | null; companyId?: string | null }>;
  /** Burggraben 4: Beitrag des Rechners beim Mithelfen (Vormonat), hoechstens einmal im Monat. */
  beitrag?: { monat: string; abfragen: number; aenderungen: number } | null;
  appBasis: string;
  abmeldenUrl: string;
}

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export function monatsName(kennung: string): string {
  const m = Number(kennung.slice(5, 7));
  return MONATE[m - 1] ?? kennung;
}
const zahl = (n: number) => n.toLocaleString("de-DE");
export function beitragSatz(b: { monat: string; abfragen: number; aenderungen: number }): string {
  const aend = b.aenderungen === 1 ? "eine Änderung" : `${zahl(b.aenderungen)} Änderungen`;
  return `Dein Rechner hat im ${monatsName(b.monat)} ${zahl(b.abfragen)} Register-Abfragen beigetragen, daraus ${aend} für alle AVA-Nutzer. Danke fürs Mithelfen.`;
}

export function neuigkeitenMail(d: NeuigkeitenDaten): Mail {
  const eintraege = d.meldungen.slice(0, 12).map((m) => `<tr><td style="padding:14px 0;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};">
<div style="font-size:12px;letter-spacing:0.05em;text-transform:uppercase;font-weight:700;color:${FARBE.akzentDunkel};margin-bottom:3px;">${esc(m.art)}</div>
<div style="font-size:15px;font-weight:600;color:${FARBE.text};">${esc(m.firma)}: ${esc(m.titel)}</div>
<div style="font-size:14px;line-height:20px;color:${FARBE.text};margin-top:3px;">${esc(m.text)}</div>
${m.quelleUrl || m.companyId ? `<div style="margin-top:5px;font-size:13px;">${[m.companyId ? `<a href="${esc(firmenLink(d.appBasis, m.companyId))}" style="color:${FARBE.akzentDunkel};">Firma in AVA öffnen</a>` : "", m.quelleUrl ? `<a href="${esc(m.quelleUrl)}" style="color:${FARBE.akzentDunkel};">Quelle ansehen</a>` : ""].filter(Boolean).join(" &nbsp;·&nbsp; ")}</div>` : ""}</td></tr>`).join("");
  const n = d.meldungen.length;
  const inhalt =
    ueberschrift(n === 1 ? "Eine Neuigkeit zu deinen Firmen" : `${n} Neuigkeiten zu deinen Firmen`) +
    absatz(esc(d.vorname ? `Hallo ${d.vorname},` : "Hallo,")) +
    absatz("das hat sich seit meiner letzten Mail bei deinen Firmen getan:") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${eintraege}</table>` +
    (d.beitrag && d.beitrag.abfragen > 0 ? absatz(`<span style="color:${FARBE.leise};font-size:13px;">${esc(beitragSatz(d.beitrag))}</span>`) : "");
  const text = [
    d.vorname ? `Hallo ${d.vorname},` : "Hallo,", "", "das hat sich seit meiner letzten Mail bei deinen Firmen getan:", "",
    ...d.meldungen.slice(0, 12).map((m) => `- ${m.firma}: ${m.titel}\n  ${m.text}${m.companyId ? `\n  In AVA: ${firmenLink(d.appBasis, m.companyId)}` : ""}${m.quelleUrl ? `\n  Quelle: ${m.quelleUrl}` : ""}`), "",
    ...(d.beitrag && d.beitrag.abfragen > 0 ? [beitragSatz(d.beitrag), ""] : []),
    `Keine Mails mehr von AVA: ${d.abmeldenUrl}`,
  ].join("\n");
  return { betreff: n === 1 ? `${d.meldungen[0]!.firma}: ${d.meldungen[0]!.titel}` : `${n} Neuigkeiten zu deinen Firmen`, html: rahmen({ vorschau: d.meldungen.map((m) => m.firma).slice(0, 3).join(", "), inhalt, fusszeile: abmelden(d.abmeldenUrl) }), text };
}

// ---- 3b. Bestaetigung (Neuigkeiten im Chat eingeschaltet, Double-Opt-in) ------

export function bestaetigungMail(d: { vorname: string | null; bestaetigenUrl: string }): Mail {
  const inhalt =
    ueberschrift("Neuigkeiten per E-Mail bestätigen") +
    absatz(esc(d.vorname ? `Hallo ${d.vorname},` : "Hallo,")) +
    absatz("du möchtest Neuigkeiten zu deinen Firmen auch per E-Mail bekommen. Bitte bestätige das mit einem Klick. Danach schicke ich dir höchstens eine Mail am Tag, und abmelden kannst du dich in jeder Mail.") +
    knopf("Ja, Neuigkeiten per E-Mail erhalten", d.bestaetigenUrl) +
    absatz(`<span style="color:${FARBE.leise};font-size:13px;">Hast du das nicht angefordert, ignoriere diese Mail einfach. Ohne Bestätigung bekommst du keine Neuigkeiten.</span>`);
  const text = [
    d.vorname ? `Hallo ${d.vorname},` : "Hallo,", "",
    "du möchtest Neuigkeiten zu deinen Firmen auch per E-Mail bekommen. Bitte bestätige das:", d.bestaetigenUrl, "",
    "Hast du das nicht angefordert, ignoriere diese Mail einfach.",
  ].join("\n");
  return { betreff: "Bitte bestätigen: Neuigkeiten von AVA per E-Mail", html: rahmen({ vorschau: "Ein Klick, dann bekommst du Neuigkeiten zu deinen Firmen", inhalt }), text };
}

// ---- 4. Beitrittsanfrage (an Owner/Admins, O11) --------------------------------

export interface BeitrittDaten {
  vorname: string | null;
  organisation: string;
  wer: string;
  email: string | null;
  quelle: "link" | "domain";
  konsoleUrl: string;
}

export function beitrittsanfrageMail(d: BeitrittDaten): Mail {
  const wie = d.quelle === "domain" ? "über eure Firmen-Domain (gleiche E-Mail-Domain wie eure Mitglieder)" : "über euren Einladungslink";
  const inhalt =
    ueberschrift("Neue Beitrittsanfrage") +
    absatz(esc(d.vorname ? `Hallo ${d.vorname},` : "Hallo,")) +
    absatz(`<strong>${esc(d.wer)}</strong>${d.email ? ` (${esc(d.email)})` : ""} möchte ${wie} der Organisation <strong>${esc(d.organisation)}</strong> beitreten.`) +
    absatz("Bitte prüfe, ob du die Person kennst. Erst nach deiner Freigabe sieht sie eure Firmen und nutzt eure Schlüssel. Kennst du sie nicht, lehne die Anfrage ab.") +
    knopf("Anfrage in der AVA Konsole ansehen", d.konsoleUrl);
  const text = [
    d.vorname ? `Hallo ${d.vorname},` : "Hallo,", "",
    `${d.wer}${d.email ? ` (${d.email})` : ""} möchte ${wie} der Organisation ${d.organisation} beitreten.`,
    "Erst nach deiner Freigabe sieht die Person eure Firmen und nutzt eure Schlüssel. Kennst du sie nicht, lehne die Anfrage ab.", "",
    `Zur Anfrage: ${d.konsoleUrl}`,
  ].join("\n");
  return { betreff: `Beitrittsanfrage für ${d.organisation}: ${d.wer}`, html: rahmen({ vorschau: `${d.wer} möchte ${d.organisation} beitreten`, inhalt, fusszeile: "Du bekommst diese Mail als Owner oder Admin der Organisation." }), text };
}

// ---- 6. AVA-Server (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §10.4, Z3) -------------------
// Dienstmails zum gebuchten Server: kein Abmelden (Vertragskommunikation), keine Fachbegriffe
// wie Instanz/Maschine. Ein Knopf je Mail.

function serverFuss(): string {
  return "Du bekommst diese Mail, weil für dich ein AVA-Server gebucht ist.";
}

const datum = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" });

export interface ServerMailBasis { vorname: string | null; appUrl: string }

/** M1: Zahlung erhalten, AVA wird eingerichtet. */
export function serverBezahltMail(d: ServerMailBasis): Mail {
  const hallo = d.vorname ? `Hallo ${d.vorname},` : "Hallo,";
  const link = `${d.appUrl.replace(/\/+$/, "")}/mehr`;
  const inhalt =
    ueberschrift("Danke! Deine AVA wird jetzt eingerichtet") +
    absatz(esc(hallo)) +
    absatz("deine Zahlung ist eingegangen. Ich richte gerade deinen AVA-Server ein, das dauert meist nur ein bis drei Minuten. Danach arbeite ich rund um die Uhr für dich, auch wenn dein Rechner aus ist.") +
    absatz("Sobald ich bereit bin, bekommst du eine zweite Mail. Mit einem Klick darin bestätigst du, dass ich für dich arbeiten darf. Den Stand siehst du jederzeit in der AVA-App.") +
    knopf("Stand ansehen", link);
  const text = [hallo, "", "deine Zahlung ist eingegangen. Ich richte gerade deinen AVA-Server ein (meist 1–3 Minuten).", "Sobald ich bereit bin, bekommst du eine zweite Mail; mit einem Klick darin bestätigst du, dass ich für dich arbeiten darf.", "", `Stand ansehen: ${link}`].join("\n");
  return { betreff: "Zahlung erhalten – deine AVA wird eingerichtet", html: rahmen({ vorschau: "Meist in 1–3 Minuten bereit", inhalt, fusszeile: serverFuss() }), text };
}

/** M8: Zahlung offen (Stufe 0 = gerade fehlgeschlagen, 3 = Erinnerung, 6 = morgen wird pausiert). */
export function serverZahlungOffenMail(d: ServerMailBasis & { stufe: 0 | 3 | 6; pauseAm: string; zahlungUrl: string }): Mail {
  const hallo = d.vorname ? `Hallo ${d.vorname},` : "Hallo,";
  const am = datum(d.pauseAm);
  const titel = d.stufe === 6 ? "Morgen pausiere ich deinen AVA-Server" : d.stufe === 3 ? "Erinnerung: Die Zahlung für AVA ist noch offen" : "Die Zahlung für AVA hat nicht geklappt";
  const kern = d.stufe === 6
    ? `die Zahlung für AVA ist weiterhin offen. Wenn sie bis morgen nicht eingeht, pausiere ich deinen AVA-Server am ${esc(am)}. Deine Daten bleiben dabei erhalten.`
    : `die letzte Zahlung für AVA ist nicht eingegangen. Deine AVA läuft vorerst normal weiter. Bitte prüfe dein Zahlungsmittel bis zum ${esc(am)}; sonst pausiere ich deinen AVA-Server an diesem Tag. Deine Daten bleiben dabei erhalten.`;
  const inhalt = ueberschrift(titel) + absatz(esc(hallo)) + absatz(kern) + absatz("Meist reicht es, die Karte zu aktualisieren. Sobald die Zahlung eingeht, läuft alles ohne Unterbrechung weiter.") + knopf("Zahlungsmittel prüfen", d.zahlungUrl);
  const text = [hallo, "", kern.replace(/&[a-z]+;/g, ""), "", `Zahlungsmittel prüfen: ${d.zahlungUrl}`].join("\n");
  return { betreff: titel, html: rahmen({ vorschau: `Bitte bis ${am} prüfen`, inhalt, fusszeile: serverFuss() }), text };
}

/** M9: AVA pausiert (Grund in Nutzersprache, Daten bis … erhalten). */
export function serverPausiertMail(d: ServerMailBasis & { grund: "zahlung" | "kuendigung" | "abbestellt" | "admin"; loeschenAb: string; zahlungUrl: string }): Mail {
  const hallo = d.vorname ? `Hallo ${d.vorname},` : "Hallo,";
  const bis = datum(d.loeschenAb);
  const warum = {
    zahlung: "die Zahlung für AVA ist nicht eingegangen. Deshalb habe ich deinen AVA-Server pausiert.",
    kuendigung: "das Abo deiner Organisation ist beendet. Deshalb habe ich deinen AVA-Server pausiert.",
    abbestellt: "der AVA-Server wurde zum Ende des Abrechnungszeitraums abbestellt. Deshalb habe ich ihn jetzt pausiert.",
    admin: "deine Organisation hat deinen AVA-Server pausiert.",
  }[d.grund];
  const knopfText = d.grund === "zahlung" ? "Zahlung aktualisieren" : "AVA öffnen";
  const knopfUrl = d.grund === "zahlung" ? d.zahlungUrl : `${d.appUrl.replace(/\/+$/, "")}/mehr`;
  const inhalt =
    ueberschrift("Deine AVA ist pausiert") +
    absatz(esc(hallo)) +
    absatz(esc(warum)) +
    absatz(`Deine Daten bleiben bis zum ${esc(bis)} erhalten. Bis dahin kannst du jederzeit weitermachen – dann läuft alles genau dort weiter, wo es aufgehört hat. Die Desktop-App kannst du unabhängig davon weiter nutzen.`) +
    knopf(knopfText, knopfUrl);
  const text = [hallo, "", warum, `Deine Daten bleiben bis zum ${bis} erhalten.`, "", `${knopfText}: ${knopfUrl}`].join("\n");
  return { betreff: "Deine AVA ist pausiert", html: rahmen({ vorschau: `Deine Daten bleiben bis ${bis} erhalten`, inhalt, fusszeile: serverFuss() }), text };
}

/** M10: AVA läuft wieder (nach Pause). */
export function serverLaeuftWiederMail(d: ServerMailBasis): Mail {
  const hallo = d.vorname ? `Hallo ${d.vorname},` : "Hallo,";
  const link = `${d.appUrl.replace(/\/+$/, "")}/mehr`;
  const inhalt =
    ueberschrift("Deine AVA läuft wieder") +
    absatz(esc(hallo)) +
    absatz("dein AVA-Server läuft wieder. Alles ist da, wo du es gelassen hast, und ich arbeite wieder rund um die Uhr für dich.") +
    knopf("AVA öffnen", link);
  const text = [hallo, "", "dein AVA-Server läuft wieder. Alles ist da, wo du es gelassen hast.", "", `AVA öffnen: ${link}`].join("\n");
  return { betreff: "Deine AVA läuft wieder", html: rahmen({ vorschau: "Alles ist da, wo du es gelassen hast", inhalt, fusszeile: serverFuss() }), text };
}

// ---- 6b. AVA-Server: Verbindung, Ausfall, Löschung (§10.4, Z4) --------------------------

const uhrzeit = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const appMehr = (appUrl: string) => `${appUrl.replace(/\/+$/, "")}/mehr`;
const hallo = (vorname: string | null) => (vorname ? `Hallo ${vorname},` : "Hallo,");

/** „etwa 25 Minuten“, „etwa 3 Stunden“, „etwa 2 Tage“ */
export function dauerText(minuten: number): string {
  const m = Math.max(1, Math.round(minuten));
  if (m < 60) return m === 1 ? "etwa eine Minute" : `etwa ${m} Minuten`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? "etwa eine Stunde" : `etwa ${h} Stunden`;
  return `etwa ${Math.round(h / 24)} Tage`;
}

/** M2: Die AVA ist eingerichtet und mit dem Konto verbunden. */
export function serverLaeuftMail(d: ServerMailBasis): Mail {
  const link = d.appUrl.replace(/\/+$/, "");
  const kern = "dein AVA-Server ist eingerichtet und mit deinem Konto verbunden. Ab jetzt arbeite ich rund um die Uhr für dich, auch wenn dein Rechner aus ist.";
  const weiter = "Als Nächstes wählst du in der App, mit welchem KI-Modell ich arbeite. Wenn du magst, verbindest du auch Telegram, dann erreichst du mich unterwegs. Die Desktop-App brauchst du dafür nicht.";
  const inhalt = ueberschrift("Deine AVA läuft") + absatz(esc(hallo(d.vorname))) + absatz(esc(kern)) + absatz(esc(weiter)) + knopf("AVA öffnen", link);
  const text = [hallo(d.vorname), "", kern, "", weiter, "", `AVA öffnen: ${link}`].join("\n");
  return { betreff: "Deine AVA läuft", html: rahmen({ vorschau: "Ab jetzt rund um die Uhr für dich da", inhalt, fusszeile: serverFuss() }), text };
}

/** M3: Server ist eingerichtet und wartet auf die Bestätigung (sofort; Erinnerung nach 24 Stunden). */
export function serverBestaetigenMail(d: ServerMailBasis & { stufe: "bereit" | "24h"; bestaetigenUrl: string }): Mail {
  const titel = d.stufe === "24h" ? "Erinnerung: Deine AVA wartet auf deine Bestätigung" : "Fast fertig: Bestätige deine AVA";
  const kern = d.stufe === "24h"
    ? "dein AVA-Server läuft, wartet aber noch auf deine Bestätigung, dass er für dich arbeiten darf. Das ist ein Klick: Du landest auf der Anmeldeseite von AVA und bestätigst dort."
    : "dein AVA-Server ist eingerichtet. Ein Schritt fehlt noch: Bestätige, dass er für dich arbeiten darf. Das ist ein Klick: Du landest auf der Anmeldeseite von AVA und bestätigst dort.";
  const sicher = "Nur dein eigenes Konto kann diese AVA bestätigen. Der Link gilt sieben Tage.";
  const inhalt = ueberschrift(titel) + absatz(esc(hallo(d.vorname))) + absatz(esc(kern)) + knopf("Jetzt bestätigen", d.bestaetigenUrl) + absatz(`<span style="font-size:13px;color:${FARBE.leise};">${esc(sicher)}</span>`);
  const text = [hallo(d.vorname), "", kern, "", `Jetzt bestätigen: ${d.bestaetigenUrl}`, "", sicher].join("\n");
  return { betreff: titel, html: rahmen({ vorschau: "Ein Klick, dann arbeite ich für dich", inhalt, fusszeile: serverFuss() }), text };
}

/** M4: Die AVA ist seit mindestens 10 Minuten nicht erreichbar. */
export function serverNichtErreichbarMail(d: ServerMailBasis & { seit: string }): Mail {
  const kern = `seit ${uhrzeit(d.seit)} Uhr ist dein AVA-Server nicht erreichbar. Wir sind informiert und kümmern uns darum. Deine Daten sind davon nicht betroffen.`;
  const weiter = "Sobald ich wieder laufe, bekommst du eine kurze Nachricht. Du musst nichts tun.";
  const inhalt = ueberschrift("Deine AVA ist gerade nicht erreichbar") + absatz(esc(hallo(d.vorname))) + absatz(esc(kern)) + absatz(esc(weiter)) + knopf("Stand ansehen", appMehr(d.appUrl));
  const text = [hallo(d.vorname), "", kern, weiter, "", `Stand ansehen: ${appMehr(d.appUrl)}`].join("\n");
  return { betreff: "Deine AVA ist gerade nicht erreichbar", html: rahmen({ vorschau: "Wir kümmern uns darum, du musst nichts tun", inhalt, fusszeile: serverFuss() }), text };
}

/** M5: Nach einer Ausfallmail wieder stabil erreichbar. */
export function serverWiederErreichbarMail(d: ServerMailBasis & { dauerMin: number }): Mail {
  const kern = `dein AVA-Server ist wieder erreichbar. Die Unterbrechung dauerte ${dauerText(d.dauerMin)}. Deine Daten sind vollständig da.`;
  const inhalt = ueberschrift("Deine AVA ist wieder da") + absatz(esc(hallo(d.vorname))) + absatz(esc(kern)) + absatz("Danke für deine Geduld.");
  const text = [hallo(d.vorname), "", kern, "", "Danke für deine Geduld."].join("\n");
  return { betreff: "Deine AVA ist wieder da", html: rahmen({ vorschau: `Unterbrechung: ${dauerText(d.dauerMin)}`, inhalt, fusszeile: serverFuss() }), text };
}

/** M11: Die Daten einer pausierten AVA werden in 7 Tagen gelöscht. */
export function serverLoeschungMail(d: ServerMailBasis & { grund: "zahlung" | "kuendigung" | "abbestellt" | "admin"; loeschenAm: string; zahlungUrl: string; fuerAdmin: boolean }): Mail {
  const am = datum(d.loeschenAm);
  const kern = `dein AVA-Server ist seit einiger Zeit pausiert. Am ${am} lösche ich ihn mitsamt seinen Daten endgültig.`;
  let tun: string; let knopfText: string; let knopfUrl: string;
  if (d.grund === "admin" && !d.fuerAdmin) {
    tun = "Deine Organisation hat den Server pausiert. Wenn du die Daten noch brauchst, sprich bitte vorher mit ihr.";
    knopfText = "AVA öffnen"; knopfUrl = appMehr(d.appUrl);
  } else if ((d.grund === "zahlung" || d.grund === "kuendigung") && d.fuerAdmin) {
    tun = "Wenn du die Daten behalten willst: Sobald die Zahlung bzw. das Abo wieder läuft, startet AVA von selbst und alles ist wieder da.";
    knopfText = "Zahlung aktualisieren"; knopfUrl = d.zahlungUrl;
  } else {
    tun = "Wenn du die Daten behalten willst, starte deine AVA vorher wieder. Danach kannst du sie auch auf die Desktop-App holen.";
    knopfText = "AVA öffnen"; knopfUrl = appMehr(d.appUrl);
  }
  const nichts = "Wenn du AVA nicht mehr brauchst, musst du nichts tun.";
  const inhalt = ueberschrift("Deine Daten werden in 7 Tagen gelöscht") + absatz(esc(hallo(d.vorname))) + absatz(esc(kern)) + absatz(esc(tun)) + absatz(esc(nichts)) + knopf(knopfText, knopfUrl);
  const text = [hallo(d.vorname), "", kern, tun, nichts, "", `${knopfText}: ${knopfUrl}`].join("\n");
  return { betreff: "Deine Daten werden in 7 Tagen gelöscht", html: rahmen({ vorschau: `Löschung am ${am}`, inhalt, fusszeile: serverFuss() }), text };
}

/** M12: Server und Daten sind gelöscht. */
export function serverGeloeschtMail(d: ServerMailBasis): Mail {
  const kern = "wie angekündigt habe ich deinen AVA-Server mitsamt seinen Daten gelöscht. Auch die letzten Sicherungen verschwinden innerhalb eines Tages.";
  const weiter = "Du kannst jederzeit neu anfangen: kostenlos mit der Desktop-App oder mit einem neuen Server.";
  const inhalt = ueberschrift("Deine Daten wurden gelöscht") + absatz(esc(hallo(d.vorname))) + absatz(esc(kern)) + absatz(esc(weiter)) + knopf("AVA öffnen", appMehr(d.appUrl));
  const text = [hallo(d.vorname), "", kern, weiter, "", `AVA öffnen: ${appMehr(d.appUrl)}`].join("\n");
  return { betreff: "Deine Daten wurden gelöscht", html: rahmen({ vorschau: "Server und Daten sind entfernt", inhalt, fusszeile: "Du bekommst diese Mail, weil für dich ein AVA-Server gebucht war." }), text };
}

/** Mitglied ohne Admin-Rechte fragt einen AVA-Server an (an Owner/Admins). */
export function serverAnfrageMail(d: { vorname: string | null; wer: string; email: string | null; organisation: string; konsoleUrl: string }): Mail {
  const kern = `${d.wer}${d.email ? ` (${d.email})` : ""} möchte einen AVA-Server. Damit arbeitet AVA rund um die Uhr, auch wenn der eigene Rechner aus ist, und ist überall in der AVA-App erreichbar.`;
  const tun = "Du kannst den Server in der AVA Konsole bei den Mitgliedern einschalten. Er wird mit dem Abo der Organisation abgerechnet.";
  const inhalt = ueberschrift("Anfrage: AVA-Server") + absatz(esc(hallo(d.vorname))) + absatz(esc(kern)) + absatz(esc(tun)) + knopf("Mitglieder in der AVA Konsole öffnen", d.konsoleUrl);
  const text = [hallo(d.vorname), "", kern, tun, "", `Mitglieder öffnen: ${d.konsoleUrl}`].join("\n");
  return { betreff: `${d.wer} möchte einen AVA-Server`, html: rahmen({ vorschau: `Anfrage aus ${d.organisation}`, inhalt, fusszeile: "Du bekommst diese Mail als Owner oder Admin der Organisation." }), text };
}

// ---- 6c. AVA-Server: Updates (§10.4 M6/M7, Z7) — abbestellbar ---------------------------

function updateFuss(abmeldenUrl: string): string {
  return `Du bekommst diese Mail, weil für dich ein AVA-Server gebucht ist. <a href="${esc(abmeldenUrl)}" style="color:${FARBE.leise};">Keine Update-Mails und Neuigkeiten mehr</a>`;
}

/** M6: Am Vorabend eines Updates mit spürbarer Änderung (nur mit Hinweistext des Betreibers). */
export function serverUpdateHinweisMail(d: ServerMailBasis & { hinweis: string; abmeldenUrl: string }): Mail {
  const kern = "heute Nacht zwischen 2 und 5 Uhr bekommt dein AVA-Server ein Update. Er ist dabei ein paar Minuten nicht erreichbar; du musst nichts tun.";
  const inhalt = ueberschrift("Heute Nacht bekommt deine AVA ein Update") + absatz(esc(hallo(d.vorname))) + absatz(esc(kern)) + zwischentitel("Was ist neu") + kasten(absatz(esc(d.hinweis))) + knopf("AVA öffnen", d.appUrl.replace(/\/+$/, ""));
  const text = [hallo(d.vorname), "", kern, "", "Was ist neu:", d.hinweis, "", `AVA öffnen: ${d.appUrl}`, "", `Keine Update-Mails mehr: ${d.abmeldenUrl}`].join("\n");
  return { betreff: "Heute Nacht bekommt deine AVA ein Update", html: rahmen({ vorschau: d.hinweis.slice(0, 90), inhalt, fusszeile: updateFuss(d.abmeldenUrl) }), text };
}

/** M7: Update erfolgreich (gesammelt, höchstens 1 je Woche). */
export function serverAktualisiertMail(d: ServerMailBasis & { hinweis: string | null; abmeldenUrl: string }): Mail {
  const kern = "dein AVA-Server ist auf dem neuesten Stand. Alles läuft wie gewohnt weiter, deine Daten sind vollständig da.";
  const inhalt = ueberschrift("Deine AVA ist auf dem neuesten Stand") + absatz(esc(hallo(d.vorname))) + absatz(esc(kern))
    + (d.hinweis ? zwischentitel("Was ist neu") + kasten(absatz(esc(d.hinweis))) : "") + knopf("AVA öffnen", d.appUrl.replace(/\/+$/, ""));
  const text = [hallo(d.vorname), "", kern, ...(d.hinweis ? ["", "Was ist neu:", d.hinweis] : []), "", `AVA öffnen: ${d.appUrl}`, "", `Keine Update-Mails mehr: ${d.abmeldenUrl}`].join("\n");
  return { betreff: "Deine AVA ist auf dem neuesten Stand", html: rahmen({ vorschau: d.hinweis?.slice(0, 90) ?? "Alles läuft wie gewohnt weiter", inhalt, fusszeile: updateFuss(d.abmeldenUrl) }), text };
}
