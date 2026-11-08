// Onboarding O5 (docs/PLAN_ONBOARDING.md): E-Mail-Vorlagen fuer Nutzer.
// Tabellen-Layout mit Inline-Styles (Outlook/Gmail), 600 px, Markenfarben
// #F2F7F6 / #00C0A7 / #0A1F2A. Das Logo kommt als Inline-Anhang (cid:ava-logo.png),
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

export interface Top10Daten {
  vorname: string | null;
  firmen: Array<{ name: string; ort: string | null; branche: string | null; score: number; grund: string }>;
  appUrl: string;
  abmeldenUrl: string;
}

export function top10Mail(d: Top10Daten): Mail {
  const zeilen = d.firmen.slice(0, 10).map((f, i) => `<tr>
<td valign="top" style="padding:12px 10px 12px 0;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};font-size:13px;font-weight:700;color:${FARBE.akzentDunkel};width:22px;">${i + 1}</td>
<td valign="top" style="padding:12px 0;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};">
<div style="font-size:15px;font-weight:600;color:${FARBE.text};">${esc(f.name)}</div>
<div style="font-size:13px;color:${FARBE.leise};margin:2px 0 4px 0;">${esc([f.branche, f.ort].filter(Boolean).join(" · "))}</div>
<div style="font-size:14px;line-height:20px;color:${FARBE.text};">${esc(f.grund)}</div></td>
<td valign="top" align="right" style="padding:12px 0 12px 10px;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};white-space:nowrap;">
<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${FARBE.grund};font-size:13px;font-weight:700;color:${FARBE.akzentDunkel};">${Math.round(f.score)}</span></td></tr>`).join("");
  const inhalt =
    ueberschrift(`Deine ${d.firmen.length === 10 ? "Top 10" : `${d.firmen.length} besten Treffer`}`) +
    absatz(esc(d.vorname ? `Hallo ${d.vorname},` : "Hallo,")) +
    absatz(`der Firmen-Radar ist zum ersten Mal durchgelaufen. Diese Firmen passen am besten zu deinem Idealkundenprofil. Ich habe sie in <strong>Meine Firmen</strong> übernommen und behalte sie ab jetzt für dich im Blick.`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;">${zeilen}</table>` +
    knopf("In AVA ansehen", d.appUrl) +
    absatz(`<span style="color:${FARBE.leise};font-size:13px;">Die Zahl ist die Passung zu deinem Profil (0 bis 100). Ändert sich bei einer dieser Firmen etwas Wichtiges, melde ich mich.</span>`);
  const text = [
    d.vorname ? `Hallo ${d.vorname},` : "Hallo,", "",
    "der Firmen-Radar ist zum ersten Mal durchgelaufen. Diese Firmen passen am besten zu deinem Idealkundenprofil und sind jetzt in Meine Firmen:", "",
    ...d.firmen.slice(0, 10).map((f, i) => `${i + 1}. ${f.name}${f.ort ? `, ${f.ort}` : ""} (${Math.round(f.score)}) – ${f.grund}`), "",
    `In AVA ansehen: ${d.appUrl}`, "", `Keine Mails mehr von AVA: ${d.abmeldenUrl}`,
  ].join("\n");
  return { betreff: `Deine Top ${Math.min(10, d.firmen.length)}: Diese Firmen passen zu dir`, html: rahmen({ vorschau: `${d.firmen[0]?.name ?? ""} und weitere passende Firmen`, inhalt, fusszeile: abmelden(d.abmeldenUrl) }), text };
}

// ---- 3. Neuigkeiten -----------------------------------------------------------

export interface NeuigkeitenDaten {
  vorname: string | null;
  meldungen: Array<{ firma: string; titel: string; text: string; art: string; quelleUrl: string | null }>;
  appUrl: string;
  abmeldenUrl: string;
}

export function neuigkeitenMail(d: NeuigkeitenDaten): Mail {
  const eintraege = d.meldungen.slice(0, 12).map((m) => `<tr><td style="padding:14px 0;border-top:1px solid ${FARBE.linie};font-family:${SCHRIFT};">
<div style="font-size:12px;letter-spacing:0.05em;text-transform:uppercase;font-weight:700;color:${FARBE.akzentDunkel};margin-bottom:3px;">${esc(m.art)}</div>
<div style="font-size:15px;font-weight:600;color:${FARBE.text};">${esc(m.firma)}: ${esc(m.titel)}</div>
<div style="font-size:14px;line-height:20px;color:${FARBE.text};margin-top:3px;">${esc(m.text)}</div>
${m.quelleUrl ? `<div style="margin-top:5px;font-size:13px;"><a href="${esc(m.quelleUrl)}" style="color:${FARBE.akzentDunkel};">Quelle ansehen</a></div>` : ""}</td></tr>`).join("");
  const n = d.meldungen.length;
  const inhalt =
    ueberschrift(n === 1 ? "Eine Neuigkeit zu deinen Firmen" : `${n} Neuigkeiten zu deinen Firmen`) +
    absatz(esc(d.vorname ? `Hallo ${d.vorname},` : "Hallo,")) +
    absatz("das hat sich seit gestern bei deinen Firmen getan:") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${eintraege}</table>` +
    knopf("Alle Meldungen in AVA", d.appUrl);
  const text = [
    d.vorname ? `Hallo ${d.vorname},` : "Hallo,", "", "das hat sich seit gestern bei deinen Firmen getan:", "",
    ...d.meldungen.slice(0, 12).map((m) => `- ${m.firma}: ${m.titel}\n  ${m.text}${m.quelleUrl ? `\n  Quelle: ${m.quelleUrl}` : ""}`), "",
    `Alle Meldungen: ${d.appUrl}`, "", `Keine Mails mehr von AVA: ${d.abmeldenUrl}`,
  ].join("\n");
  return { betreff: n === 1 ? `${d.meldungen[0]!.firma}: ${d.meldungen[0]!.titel}` : `${n} Neuigkeiten zu deinen Firmen`, html: rahmen({ vorschau: d.meldungen.map((m) => m.firma).slice(0, 3).join(", "), inhalt, fusszeile: abmelden(d.abmeldenUrl) }), text };
}
