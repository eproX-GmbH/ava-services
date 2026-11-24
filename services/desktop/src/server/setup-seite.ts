// Setup-Seite des Headless-Servers (GET /setup): nur Darstellung.
//
// main.ts baut aus dem laufenden Kern ein Sicht-Objekt (`SetupSicht`) und ruft
// `setupSeiteHtml`. Hier stehen Texte, Aufbau und Gestaltung, ohne Zugriff auf den
// Kern; so laesst sich die Seite in jedem Zustand ohne laufenden Server rendern und
// pruefen (scripts/test-setup-seite.mts). Formularfelder und POST-Ziele muessen zu
// `setupPost` in main.ts passen.
//
// 2026-11-24 neu gestaltet (Befund Joyce: "sehr schlechte UX und UI"): Uebersicht mit
// Status-Kacheln, Karten je Bereich, KI-Modell als ein Bereich mit zwei Wegen,
// ChatGPT-Anmeldung in nummerierten Schritten, Rueckmeldung in der jeweiligen Karte,
// Dunkelmodus, Handy-Breite.

import type { AlertSeverity, MailAccount } from "../shared/types";

export type Bereich = "anmeldung" | "modell" | "telegram" | "mail" | "instanzen";

export interface SetupMeldung {
  art: "ok" | "fehler";
  text: string;
  /** Karte, in der die Meldung erscheint; ohne Bereich steht sie oben. */
  bereich?: Bereich;
}

export type AnmeldungSicht =
  | { zustand: "angemeldet"; konto: string }
  | {
      zustand: "code";
      /** Link mit eingetragenem Code (oder ohne, falls der Anbieter keinen liefert). */
      link: string;
      /** Kurze Adresse fuer die Anzeige. */
      adresse: string;
      code: string;
      bis: number;
      hinweis: { text: string; fehler: boolean } | null;
      gebunden: string | null;
    }
  | { zustand: "wartet"; phase: string; fehler: string | null; gebunden: string | null };

export type ModellAktiv =
  | { art: "abo"; email: string | null; modell: string | null }
  | { art: "schluessel"; anbieter: string; organisation: boolean }
  | { art: "keins" };

export interface ModellSicht {
  aktiv: ModellAktiv;
  verschluesselt: boolean;
  /** Anbieter-Sperre der Organisation: Name des vorgegebenen Anbieters, sonst null. */
  vorgabe: string | null;
  anbieter: Array<{ kind: string; name: string; quelle: "eigen" | "organisation" | null }>;
  /** null = persoenliches ChatGPT-Abo fuer die Organisation nicht erlaubt (Weg entfaellt ganz). */
  abo: {
    verbunden: boolean;
    email: string | null;
    planScope: boolean;
    /** Laufender Anmeldelink (15 Minuten) oder null. */
    link: string | null;
    linkBis: number | null;
  } | null;
}

export type TelegramSicht =
  | { zustand: "ohne_bot"; verschluesselt: boolean }
  | { zustand: "ohne_chat"; bot: string | null; andere: string[] }
  | {
      zustand: "verbunden";
      bot: string | null;
      andere: string[];
      meldungen: boolean;
      eingang: boolean;
      schwelle: AlertSeverity;
      ruhezeiten: boolean;
    };

/** Werte eines fehlgeschlagenen Mail-Formulars (ohne Passwoerter), damit nichts neu getippt werden muss. */
export type MailEntwurf = Record<string, string>;

export type MailSicht =
  | { zustand: "nicht_bereit" }
  | { zustand: "ohne_schluessel" }
  | { zustand: "neu"; entwurf: MailEntwurf | null }
  | {
      zustand: "eingerichtet";
      konto: MailAccount;
      /** connecting | connected | idling | polling | disconnected | error */
      verbindung: string | null;
      allowlist: Array<{ id: string; pattern: string; label: string }>;
      entwurf: MailEntwurf | null;
    };

export interface InstanzSicht {
  id: string;
  name: string;
  art: "desktop" | "server";
  version: string;
  verbunden: boolean;
  eigen: boolean;
  /** "@bot", "eingerichtet" oder null. */
  telegram: string | null;
  radar: boolean | null;
  mcp: "beantwortet" | "bereit" | "aus";
  umziehbar: boolean;
}

export interface SetupSicht {
  version: string;
  instanzName: string | null;
  t: string;
  jetzt: number;
  meldung: SetupMeldung | null;
  /** Laeuft der Kern? Sonst gibt es nur Anmeldung und Startstand. */
  bereit: boolean;
  phase: string;
  anmeldung: AnmeldungSicht;
  modell: ModellSicht | null;
  /** null = ausblenden (Kern nicht bereit oder von der Organisation abgeschaltet). */
  telegram: TelegramSicht | null;
  mail: MailSicht | null;
  instanzen: { liste: InstanzSicht[]; umzug: { fehler: boolean; text: string } | null } | null;
}

// ---- Bausteine -------------------------------------------------------------------

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

const ZEITZONE = "Europe/Berlin";
const uhrzeit = (ms: number): string =>
  new Date(ms).toLocaleTimeString("de-DE", { timeZone: ZEITZONE, hour: "2-digit", minute: "2-digit" });
const datumZeit = (iso: string): string =>
  new Date(iso).toLocaleString("de-DE", { timeZone: ZEITZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const PFADE = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  fehler: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  offen: '<circle cx="12" cy="12" r="9"/>',
  extern: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  kopieren: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  pfeil: '<path d="m9 18 6-6-6-6"/>',
  konto: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  modell: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  telegram: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  instanzen: '<rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01"/><path d="M7 17h.01"/>',
} as const;
type IconName = keyof typeof PFADE;

function icon(name: IconName): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PFADE[name]}</svg>`;
}

type Ton = "ok" | "warn" | "fehler" | "neutral";
const TON_ICON: Record<Ton, IconName> = { ok: "ok", warn: "warn", fehler: "fehler", neutral: "info" };
const BADGE: Record<Ton, string> = { ok: "Erledigt", warn: "Offen", fehler: "Prüfen", neutral: "Optional" };

function hinweis(ton: Ton, inhalt: string, rolle = false): string {
  const r = rolle ? ` role="${ton === "fehler" ? "alert" : "status"}"` : "";
  return `<div class="hinweis ${ton}"${r}>${icon(TON_ICON[ton])}<div>${inhalt}</div></div>`;
}

type KnopfArt = "primaer" | "sekundaer" | "gefahr";

function knopf(text: string, art: KnopfArt = "primaer", iconName?: IconName): string {
  return `<button type="submit" class="knopf ${art}">${iconName ? icon(iconName) : ""}<span>${text}</span></button>`;
}

/** POST-Formular auf /setup/<pfad>?t=… (weitere Query-Parameter in `query`). */
function formular(
  s: SetupSicht,
  pfad: string,
  inhalt: string,
  opt: { query?: Record<string, string>; laedt?: string; bestaetigen?: string; neuerTab?: boolean; klasse?: string; autocompleteAus?: boolean } = {},
): string {
  const q = new URLSearchParams({ t: s.t, ...(opt.query ?? {}) });
  const attrs = [
    `method="post"`,
    `action="${esc(`/setup/${pfad}?${q.toString()}`)}"`,
    opt.klasse ? `class="${opt.klasse}"` : "",
    opt.laedt ? `data-laedt="${esc(opt.laedt)}"` : "",
    opt.bestaetigen ? `data-bestaetigen="${esc(opt.bestaetigen)}"` : "",
    opt.neuerTab ? `target="_blank" rel="noopener"` : "",
    opt.autocompleteAus ? `autocomplete="off"` : "",
  ].filter(Boolean);
  return `<form ${attrs.join(" ")}>${inhalt}</form>`;
}

function feld(name: string, label: string, wert: string | number, typ = "text", extra = ""): string {
  return `<label class="feld"><span>${esc(label)}</span><input name="${name}" type="${typ}" value="${esc(String(wert))}" ${extra}></label>`;
}

function schalter(name: string, an: boolean, titel: string, text: string): string {
  return `<label class="schalter"><input type="checkbox" name="${name}" ${an ? "checked" : ""}><span><strong>${esc(titel)}</strong><span class="klein">${esc(text)}</span></span></label>`;
}

function karte(id: Bereich, iconName: IconName, titel: string, unterzeile: string, ton: Ton, badge: string, inhalt: string, s: SetupSicht): string {
  const m = s.meldung && s.meldung.bereich === id ? hinweis(s.meldung.art === "ok" ? "ok" : "fehler", esc(s.meldung.text), true) : "";
  return `<section class="karte" id="${id}" aria-labelledby="${id}-titel">
<header class="karte-kopf"><span class="karte-icon">${icon(iconName)}</span><div class="karte-titel"><h2 id="${id}-titel">${titel}</h2><p>${unterzeile}</p></div><span class="badge ${ton}">${esc(badge)}</span></header>
${m}<div class="karte-inhalt">${inhalt}</div></section>`;
}

// ---- Lage je Bereich (Kacheln und Badges) ----------------------------------------

interface Lage { ton: Ton; kurz: string; badge: string }

function lageAnmeldung(s: SetupSicht): Lage {
  const a = s.anmeldung;
  if (a.zustand === "angemeldet") return { ton: "ok", kurz: "Angemeldet", badge: BADGE.ok };
  if (a.zustand === "code") return { ton: "warn", kurz: "Code bestätigen", badge: BADGE.warn };
  if (s.phase === "fehler") return { ton: "fehler", kurz: "Startfehler", badge: BADGE.fehler };
  return { ton: "neutral", kurz: "Startet …", badge: "Startet" };
}

function lageModell(m: ModellSicht | null): Lage {
  if (!m) return { ton: "neutral", kurz: "Startet …", badge: "Startet" };
  const a = m.aktiv;
  if (a.art === "abo") return { ton: "ok", kurz: "ChatGPT-Abo", badge: BADGE.ok };
  if (a.art === "schluessel") return { ton: "ok", kurz: a.anbieter, badge: BADGE.ok };
  return { ton: "warn", kurz: "Fehlt noch", badge: "Fehlt" };
}

function lageTelegram(tg: TelegramSicht): Lage {
  if (tg.zustand === "verbunden") return tg.andere.length ? { ton: "fehler", kurz: "Bot doppelt", badge: BADGE.fehler } : { ton: "ok", kurz: "Verbunden", badge: BADGE.ok };
  if (tg.zustand === "ohne_chat") return { ton: "warn", kurz: "Chat verknüpfen", badge: BADGE.warn };
  return { ton: "neutral", kurz: "Optional", badge: BADGE.neutral };
}

function lageMail(m: MailSicht): Lage {
  if (m.zustand === "eingerichtet") {
    if (m.verbindung === "error" || m.verbindung === "disconnected") return { ton: "fehler", kurz: m.verbindung === "error" ? "Fehler" : "Getrennt", badge: BADGE.fehler };
    return { ton: "ok", kurz: "Verbunden", badge: BADGE.ok };
  }
  if (m.zustand === "ohne_schluessel") return { ton: "fehler", kurz: "Nicht möglich", badge: BADGE.fehler };
  if (m.zustand === "nicht_bereit") return { ton: "neutral", kurz: "Startet …", badge: "Startet" };
  return { ton: "neutral", kurz: "Optional", badge: BADGE.neutral };
}

function kachel(id: Bereich, iconName: IconName, titel: string, l: Lage): string {
  return `<a class="kachel" href="#${id}"><span class="kachel-kopf">${icon(iconName)}${esc(titel)}</span><span class="kachel-wert ton-${l.ton}">${icon(l.ton === "neutral" ? "offen" : TON_ICON[l.ton])}<span>${esc(l.kurz)}</span></span></a>`;
}

// ---- Bereiche ----------------------------------------------------------------------

function anmeldungInhalt(s: SetupSicht): string {
  const a = s.anmeldung;
  if (a.zustand === "angemeldet") {
    return `<p class="zeile">${icon("ok")}<span>Angemeldet als <strong>${esc(a.konto)}</strong>. Diese AVA arbeitet mit deinem Konto.</span></p>`;
  }
  const bindung = a.gebunden ? `<p class="klein">Diese AVA ist für <strong>${esc(a.gebunden)}</strong> eingerichtet; nur dieses Konto kann sich anmelden.</p>` : "";
  if (a.zustand === "code") {
    return `${a.hinweis ? hinweis(a.hinweis.fehler ? "fehler" : "neutral", esc(a.hinweis.text)) : ""}
<p>Bestätige die Anmeldung einmal im Browser. Danach geht es hier von selbst weiter.</p>
<div class="code-feld"><span class="code" aria-label="Anmeldecode">${esc(a.code)}</span><button type="button" class="knopf sekundaer" data-kopieren="${esc(a.code)}">${icon("kopieren")}<span>Code kopieren</span></button></div>
<div class="aktionen"><a class="knopf primaer" href="${esc(a.link)}" target="_blank" rel="noopener">${icon("extern")}<span>Anmeldung öffnen</span></a></div>
<p class="klein">Öffnet ${esc(a.adresse)}. Der Code gilt bis ${uhrzeit(a.bis)} Uhr; danach erscheint hier automatisch ein neuer.</p>${bindung}`;
  }
  const text =
    a.phase === "fehler"
      ? hinweis("fehler", `AVA konnte nicht starten.${a.fehler ? `<br><span class="klein">${esc(a.fehler)}</span>` : ""}`)
      : a.phase === "beenden"
        ? hinweis("neutral", "AVA fährt gerade herunter.")
        : a.phase === "anmeldung" && a.fehler
          ? hinweis("warn", `Der Anmeldedienst antwortet gerade nicht. AVA versucht es von selbst wieder; die Seite aktualisiert sich, sobald ein Code da ist.<br><span class="klein">${esc(a.fehler)}</span>`)
          : hinweis("neutral", "AVA startet gerade. Sobald der Anmeldecode bereitsteht, erscheint er hier; die Seite aktualisiert sich von selbst.");
  return text + bindung;
}

function aboWeg(s: SetupSicht, m: ModellSicht): string {
  const abo = m.abo;
  if (!abo) return "";
  const aktiv = m.aktiv.art === "abo";
  const laeuft = !!abo.link;
  let kopf = "";
  if (abo.verbunden && abo.planScope) {
    kopf = `<p class="zeile">${icon("ok")}<span>Verbunden${abo.email ? ` als <strong>${esc(abo.email)}</strong>` : ""}.${aktiv ? "" : " AVA nutzt gerade trotzdem den API-Schlüssel."}</span></p>`;
  } else if (abo.verbunden) {
    kopf = hinweis("warn", `Angemeldet${abo.email ? ` als <strong>${esc(abo.email)}</strong>` : ""}, aber ChatGPT gibt das Abo nicht für AVA frei. Das klappt nur mit ChatGPT Plus oder Pro; mit einem kostenlosen Konto nimm einen API-Schlüssel.`);
  } else {
    kopf = hinweis("neutral", "Du brauchst <strong>ChatGPT Plus oder Pro</strong>. Mit einem kostenlosen ChatGPT-Konto kann AVA das Abo nicht nutzen; nimm dann einen API-Schlüssel.");
  }
  const zeigeSchritte = laeuft || !(abo.verbunden && abo.planScope);
  if (!zeigeSchritte) {
    return `<div class="weg"><div class="weg-kopf"><h3>ChatGPT-Abo</h3><span class="etikett">Plus oder Pro</span></div>${kopf}
<div class="aktionen">${formular(s, "chatgpt/start", knopf("Neu verbinden", "sekundaer", "extern"), { query: { direkt: "1" }, neuerTab: true })}</div></div>`;
  }
  const schritt1 = laeuft
    ? `<p><strong>Bei ChatGPT anmelden.</strong> Der Link öffnet sich in einem neuen Tab.</p>
<div class="aktionen"><a class="knopf primaer" href="${esc(abo.link!)}" target="_blank" rel="noopener">${icon("extern")}<span>Bei ChatGPT anmelden</span></a>${formular(s, "chatgpt/start", knopf("Neuen Link erzeugen", "sekundaer"))}</div>
<p class="klein">Gültig bis ${uhrzeit(abo.linkBis ?? s.jetzt)} Uhr.</p>`
    : `<p><strong>Bei ChatGPT anmelden.</strong> Die Anmeldung öffnet sich in einem neuen Tab.</p>
<div class="aktionen">${formular(s, "chatgpt/start", knopf("Bei ChatGPT anmelden", "primaer", "extern"), { query: { direkt: "1" }, neuerTab: true })}</div>`;
  const schritt2 = `<p><strong>Adresse kopieren.</strong> Nach der Anmeldung zeigt dein Browser „Diese Seite ist nicht erreichbar“, die Adresse beginnt mit <code>127.0.0.1:1456</code>. Das ist richtig so: Kopiere die komplette Adresse aus der Adresszeile.</p>`;
  const schritt3 = laeuft
    ? `<p><strong>Hier einfügen.</strong> Am besten sofort: Der Code in der Adresse gilt nur wenige Minuten und nur einmal.</p>
${formular(
  s,
  "chatgpt/callback",
  `<textarea name="adresse" rows="3" required spellcheck="false" autocapitalize="off" placeholder="http://127.0.0.1:1456/auth/callback?code=…&amp;state=…" aria-describedby="adresse-hinweis"></textarea>
<p id="adresse-hinweis" class="eingabe-hinweis" aria-live="polite"></p>
<div class="aktionen">${knopf("Verbindung abschließen")}</div>`,
  { laedt: "Verbinde …", autocompleteAus: true },
)}`
    : `<p><strong>Hier einfügen.</strong> Das Eingabefeld erscheint, sobald du Schritt 1 gestartet hast.</p>`;
  return `<div class="weg"><div class="weg-kopf"><h3>ChatGPT-Abo</h3><span class="etikett">Plus oder Pro</span></div>${kopf}
<ol class="schritte">
<li><span class="nr">1</span><div class="schritt">${schritt1}</div></li>
<li><span class="nr">2</span><div class="schritt">${schritt2}</div></li>
<li class="${laeuft ? "" : "gedimmt"}"><span class="nr">3</span><div class="schritt">${schritt3}</div></li>
</ol></div>`;
}

function schluesselWeg(s: SetupSicht, m: ModellSicht): string {
  if (m.vorgabe) return "";
  // Nur Anbieter mit Schluessel auflisten; sechs Zeilen "kein Schluessel" sagen nichts.
  const mitSchluessel = m.anbieter.filter((a) => a.quelle);
  const zeilen = mitSchluessel
    .map((a) => `<li><span>${esc(a.name)}</span><span class="pill ok">${a.quelle === "organisation" ? "Schlüssel der Organisation" : "Dein Schlüssel"}</span></li>`)
    .join("");
  const optionen = m.anbieter.map((a) => `<option value="${esc(a.kind)}">${esc(a.name)}</option>`).join("");
  const sperre = m.verschluesselt
    ? ""
    : hinweis("fehler", 'Auf diesem Server fehlt der Schlüssel zum Verschlüsseln, deshalb speichert AVA hier keine Zugangsdaten. <span class="klein">(Technisch: AVA_SECRETS_KEY ist nicht gesetzt.)</span>');
  const form = m.verschluesselt
    ? formular(
        s,
        "key",
        `<div class="raster schluessel-raster"><label class="feld"><span>Anbieter</span><select name="anbieter">${optionen}</select></label>${feld("schluessel", "API-Schlüssel", "", "password", 'required autocomplete="off" spellcheck="false" placeholder="sk-…"')}</div>
<div class="aktionen">${knopf("Schlüssel speichern")}</div>`,
        { laedt: "Speichere …", autocompleteAus: true, klasse: "formular" },
      )
    : "";
  return `<div class="weg"><div class="weg-kopf"><h3>API-Schlüssel</h3><span class="etikett">Abrechnung beim Anbieter</span></div>
${sperre}${zeilen ? `<ul class="liste anbieter">${zeilen}</ul>` : ""}${form}
<p class="klein">Den Schlüssel erzeugst du im Konto des Anbieters, bei OpenAI unter <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>. AVA speichert ihn verschlüsselt auf diesem Server. Hat eure Organisation einen Schlüssel hinterlegt, musst du hier nichts eintragen.</p></div>`;
}

function modellInhalt(s: SetupSicht, m: ModellSicht): string {
  const a = m.aktiv;
  const stand =
    a.art === "abo"
      ? hinweis("ok", `AVA nutzt dein <strong>ChatGPT-Abo</strong>${a.email ? ` (${esc(a.email)})` : ""}${a.modell ? `, Modell ${esc(a.modell)}` : ""}.`)
      : a.art === "schluessel"
        ? hinweis("ok", `AVA nutzt <strong>${esc(a.anbieter)}</strong> mit ${a.organisation ? "dem Schlüssel eurer Organisation" : "deinem API-Schlüssel"}.`)
        : hinweis("warn", "<strong>Noch kein KI-Modell eingerichtet.</strong> Ohne Modell kann AVA nicht antworten. Wähle einen der beiden Wege.");
  const vorgabe = m.vorgabe ? hinweis("neutral", `Eure Organisation gibt das KI-Modell vor (${esc(m.vorgabe)}). Einen eigenen Schlüssel brauchst du nicht.`) : "";
  return stand + vorgabe + aboWeg(s, m) + schluesselWeg(s, m);
}

const SCHWELLE: Record<AlertSeverity, string> = {
  info: "alle Meldungen",
  warn: "wichtige und dringende Meldungen",
  urgent: "nur dringende Meldungen",
};

function telegramInhalt(s: SetupSicht, tg: TelegramSicht): string {
  const andere =
    tg.zustand !== "ohne_bot" && tg.andere.length
      ? hinweis("fehler", `Dieser Bot hängt auch an ${tg.andere.map(esc).join(", ")}. Telegram lässt je Bot nur eine AVA zu; leg für diesen Server einen eigenen Bot an.`)
      : "";
  if (tg.zustand === "ohne_bot") {
    const sperre = tg.verschluesselt ? "" : hinweis("fehler", "Auf diesem Server fehlt der Schlüssel zum Verschlüsseln, deshalb speichert AVA hier keinen Bot.");
    return `${sperre}<p>Über Telegram schickt dir AVA Meldungen aufs Handy, und du kannst ihr unterwegs schreiben. Leg dafür einen <strong>eigenen Bot</strong> für den Server an, nicht den deiner Desktop-App.</p>
<ol class="schritte">
<li><span class="nr">1</span><div class="schritt"><p>Öffne in Telegram <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> und schick <code>/newbot</code>.</p></div></li>
<li><span class="nr">2</span><div class="schritt"><p>Vergib einen Namen. BotFather antwortet mit einem Token wie <code>123456789:AA…</code>.</p></div></li>
<li><span class="nr">3</span><div class="schritt">${formular(
      s,
      "telegram/token",
      `${feld("token", "Bot-Token", "", "password", 'required autocomplete="off" spellcheck="false" placeholder="123456789:AA…"')}<div class="aktionen">${knopf("Bot speichern")}</div>`,
      { laedt: "Prüfe Token …", autocompleteAus: true, klasse: "formular" },
    )}</div></li>
</ol>`;
  }
  const bot = tg.bot ? `@${esc(tg.bot)}` : "Der Bot";
  const entfernen = formular(s, "telegram/trennen", knopf("Bot entfernen", "gefahr"), { bestaetigen: "Bot von diesem Server entfernen? Meldungen kommen dann nicht mehr aufs Handy." });
  if (tg.zustand === "ohne_chat") {
    const oeffnen = tg.bot ? `<a class="knopf sekundaer" href="https://t.me/${esc(tg.bot)}" target="_blank" rel="noopener">${icon("extern")}<span>In Telegram öffnen</span></a>` : "";
    return `${andere}<p class="zeile">${icon("ok")}<span>${bot} ist gespeichert.</span></p>
<ol class="schritte">
<li><span class="nr">1</span><div class="schritt"><p>Schick dem Bot in Telegram <code>/start</code>.</p>${oeffnen ? `<div class="aktionen">${oeffnen}</div>` : ""}</div></li>
<li><span class="nr">2</span><div class="schritt"><p>Verknüpfe dann den Chat mit AVA.</p><div class="aktionen">${formular(s, "telegram/chat", knopf("Chat verknüpfen"), { laedt: "Suche Nachricht …" })}</div></div></li>
</ol>
<div class="aktionen trenner">${entfernen}</div>`;
  }
  const meldungText = `Es kommen ${SCHWELLE[tg.schwelle] ?? "Meldungen"}${tg.ruhezeiten ? ", außerhalb deiner Ruhezeiten" : ""}.`;
  return `${andere}<p class="zeile">${icon("ok")}<span>${bot} ist verbunden, der Chat ist verknüpft.</span></p>
${formular(
  s,
  "telegram/schalten",
  `<div class="schalter-liste">${schalter("enabled", tg.meldungen, "Meldungen aufs Handy", meldungText)}${schalter("inbound", tg.eingang, "Nachrichten an AVA", "Du kannst AVA über Telegram schreiben und Fragen stellen.")}</div>
<div class="aktionen">${knopf("Übernehmen", "sekundaer")}</div>`,
)}
<div class="aktionen trenner">${formular(s, "telegram/test", knopf("Testnachricht senden", "sekundaer"), { laedt: "Sende …" })}${entfernen}</div>`;
}

function mailFormular(s: SetupSicht, a: MailAccount | null, e: MailEntwurf | null): string {
  // Wert aus dem fehlgeschlagenen Versuch, sonst aus dem Konto, sonst Vorgabe.
  const w = (name: string, ausKonto: string | number | undefined, vorgabe: string | number = ""): string | number => e?.[name] ?? ausKonto ?? vorgabe;
  const an = (name: string, ausKonto: boolean | undefined, vorgabe: boolean): boolean => (e ? e[name] === "on" : (ausKonto ?? vorgabe));
  return formular(
    s,
    "mail/speichern",
    `<div class="raster">${feld("address", "AVAs E-Mail-Adresse", w("address", a?.address), "email", "required placeholder=\"ava@firma.de\"")}${feld("displayName", "Anzeigename", w("displayName", a?.displayName, "AVA"))}</div>
<div class="raster">
<fieldset><legend>Posteingang (IMAP)</legend>${feld("imapHost", "Server", w("imapHost", a?.imap.host), "text", 'required placeholder="imap.firma.de"')}${feld("imapPort", "Port", w("imapPort", a?.imap.port, 993), "number", 'min="1" max="65535"')}${feld("imapUser", "Benutzer (leer = Adresse)", w("imapUser", a?.imap.user))}${feld("imapPassword", a ? "Passwort (leer = unverändert)" : "Passwort", "", "password", a ? 'autocomplete="new-password"' : 'required autocomplete="new-password"')}<label class="haken"><input type="checkbox" name="imapSecure" ${an("imapSecure", a?.imap.secure, true) ? "checked" : ""}> TLS direkt (sonst STARTTLS)</label></fieldset>
<fieldset><legend>Versand (SMTP)</legend>${feld("smtpHost", "Server", w("smtpHost", a?.smtp.host), "text", 'required placeholder="smtp.firma.de"')}${feld("smtpPort", "Port", w("smtpPort", a?.smtp.port, 465), "number", 'min="1" max="65535"')}${feld("smtpUser", "Benutzer (leer = Adresse)", w("smtpUser", a?.smtp.user))}${feld("smtpPassword", "Passwort (leer = wie IMAP)", "", "password", 'autocomplete="new-password"')}<label class="haken"><input type="checkbox" name="smtpSecure" ${an("smtpSecure", a?.smtp.secure, true) ? "checked" : ""}> TLS direkt (sonst STARTTLS)</label></fieldset>
</div>
${feld("pollIntervalMinutes", "Abrufintervall in Minuten (nur, wenn der Server kein IMAP IDLE kann)", w("pollIntervalMinutes", a?.pollIntervalMinutes, 15), "number", 'min="1" max="240"')}
<div class="schalter-liste">${schalter("outboundEnabled", an("outboundEnabled", a?.outboundEnabled, true), "AVA darf Mails senden", "Antworten und Mails aus Workflows gehen von dieser Adresse raus.")}${schalter("autoTriageEnabled", an("autoTriageEnabled", a?.autoTriageEnabled, false), "Selbstständig bearbeiten", "Mails von Absendern der Allowlist beantwortet AVA ohne Rückfrage.")}</div>
<div class="aktionen">${knopf(a ? "Prüfen und übernehmen" : "Prüfen und verbinden")}</div>
<p class="klein">Beim Speichern prüft AVA zuerst Posteingang und Versand; klappt eine Verbindung nicht, wird nichts gespeichert. Passwörter liegen verschlüsselt auf dem Server.</p>`,
    { laedt: "Prüfe Verbindung …", autocompleteAus: true, klasse: "formular" },
  );
}

const MAIL_ZUSTAND: Record<string, string> = {
  connecting: "verbindet",
  connected: "verbunden",
  idling: "verbunden, wartet auf neue Mails",
  polling: "verbunden, ruft ab",
  disconnected: "getrennt",
  error: "Fehler",
};

function mailInhalt(s: SetupSicht, m: MailSicht): string {
  if (m.zustand === "nicht_bereit") return hinweis("neutral", "Der Mail-Dienst startet noch. Lade die Seite gleich neu.");
  if (m.zustand === "ohne_schluessel") return hinweis("fehler", "Auf diesem Server fehlt der Schlüssel zum Verschlüsseln, deshalb speichert AVA hier keine Passwörter.");
  if (m.zustand === "neu") {
    return `<p>AVA bekommt ein <strong>eigenes Postfach</strong>, nicht dein persönliches. Dort liest sie eingehende Mails, antwortet Absendern aus der Allowlist und verschickt Mails aus Workflows.</p>
<details class="aufklapp"${m.entwurf ? " open" : ""}><summary>${icon("pfeil")}<span>Postfach verbinden</span></summary>${mailFormular(s, null, m.entwurf)}</details>`;
  }
  const a = m.konto;
  const fehler = a.lastErrorMessage ? hinweis("fehler", `Zuletzt: ${esc(a.lastErrorMessage)}${a.lastErrorAt ? ` <span class="klein">(${datumZeit(a.lastErrorAt)})</span>` : ""}`) : "";
  const zustand = MAIL_ZUSTAND[m.verbindung ?? ""] ?? m.verbindung ?? "unbekannt";
  const allow = m.allowlist.length
    ? `<ul class="liste">${m.allowlist
        .map(
          (e) =>
            `<li><span class="eintrag"><strong>${esc(e.pattern)}</strong>${e.label && e.label !== e.pattern ? `<span class="klein">${esc(e.label)}</span>` : ""}</span>${formular(s, "mail/allowlist-entfernen", `<input type="hidden" name="id" value="${esc(e.id)}">${knopf("Entfernen", "gefahr")}`)}</li>`,
        )
        .join("")}</ul>`
    : `<p class="klein">Noch keine Einträge. Ohne Allowlist zeigt AVA Mails nur an und fragt vor jedem Versand nach.</p>`;
  return `${fehler}<dl class="daten">
<dt>Adresse</dt><dd>${esc(a.address)}${a.displayName ? ` <span class="klein">(${esc(a.displayName)})</span>` : ""}</dd>
<dt>Zustand</dt><dd>${esc(zustand)}${a.lastSyncAt ? `, zuletzt abgerufen ${datumZeit(a.lastSyncAt)}` : ""}</dd>
<dt>Posteingang</dt><dd>${esc(a.imap.host)}:${a.imap.port}</dd>
<dt>Versand</dt><dd>${esc(a.smtp.host)}:${a.smtp.port}</dd>
</dl>
${formular(
  s,
  "mail/schalten",
  `<div class="schalter-liste">${schalter("outboundEnabled", a.outboundEnabled, "AVA darf Mails senden", "Antworten und Mails aus Workflows gehen von dieser Adresse raus.")}${schalter("autoTriageEnabled", a.autoTriageEnabled === true, "Selbstständig bearbeiten", "Mails von Absendern der Allowlist beantwortet AVA ohne Rückfrage.")}</div>
<div class="aktionen">${knopf("Übernehmen", "sekundaer")}</div>`,
)}
<h3 class="unterkopf">Allowlist</h3>
<p class="klein">Absender, denen AVA ohne Rückfrage antworten darf: eine Adresse oder ein Muster wie *@firma.de.</p>
${allow}
${formular(
  s,
  "mail/allowlist",
  `<div class="inline-form"><label class="feld"><span>Adresse oder Muster</span><input name="pattern" required placeholder="*@firma.de"></label><label class="feld"><span>Bezeichnung</span><input name="label" placeholder="Kunde XY"></label>${knopf("Hinzufügen", "sekundaer")}</div>`,
  { klasse: "formular abstand" },
)}
<details class="aufklapp"${m.entwurf ? " open" : ""}><summary>${icon("pfeil")}<span>Zugang ändern</span></summary>${mailFormular(s, a, m.entwurf)}</details>
<div class="aktionen trenner">${formular(s, "mail/trennen", knopf("Konto entfernen", "gefahr"), { bestaetigen: "Mail-Konto von diesem Server entfernen? Gespeicherte Mails bleiben erhalten." })}</div>`;
}

function instanzenInhalt(s: SetupSicht, l: NonNullable<SetupSicht["instanzen"]>): string {
  const umzug = l.umzug ? hinweis(l.umzug.fehler ? "fehler" : "neutral", esc(l.umzug.text)) : "";
  if (l.liste.length === 0) return `${umzug}<p class="klein">Die Liste erscheint, sobald diese AVA angemeldet und mit AVA verbunden ist.</p>`;
  const zeilen = l.liste
    .map((i) => {
      const chips = [
        i.telegram ? `<span class="pill">Telegram ${esc(i.telegram)}</span>` : "",
        i.radar === null ? "" : `<span class="pill">Radar ${i.radar ? "an" : "aus"}</span>`,
        i.mcp === "beantwortet" ? '<span class="pill ok">Beantwortet Anfragen aus Claude &amp; ChatGPT</span>' : "",
      ].join("");
      const knoepfe = i.umziehbar
        ? `<div class="aktionen">${formular(s, "umzug/holen", knopf("Hierher holen", "sekundaer"), { query: { id: i.id }, bestaetigen: `Kompletten Stand von ${i.name} auf diesen Server holen? Der Server wird überschrieben und startet neu; der bisherige Stand bleibt als Sicherung. Anmeldung, Telegram-Bot und Abo-Anmeldungen bleiben.` })}${formular(s, "umzug/senden", knopf("Dorthin senden", "sekundaer"), { query: { id: i.id }, bestaetigen: `Kompletten Stand dieses Servers an ${i.name} senden? ${i.name} wird überschrieben und startet neu.` })}</div>`
        : "";
      return `<li class="instanz"><div class="instanz-kopf"><strong>${esc(i.name)}</strong>${i.eigen ? '<span class="pill ok">Diese AVA</span>' : ""}</div>
<div class="klein instanz-meta"><span class="punkt ${i.verbunden ? "ok" : ""}"></span><span>${i.art === "server" ? "Server" : "Desktop-App"} · Version ${esc(i.version)} · ${i.verbunden ? "verbunden" : "offline"}</span></div>
${chips ? `<div class="chips">${chips}</div>` : ""}${knoepfe}</li>`;
    })
    .join("");
  return `${umzug}<ul class="liste instanzen">${zeilen}</ul>
<p class="klein">Ein Umzug überträgt alles, was AVA lokal hält, und überschreibt das Ziel. Anmeldung, Telegram-Bot und Abo-Anmeldungen bleiben je AVA.</p>`;
}

// ---- Seite -------------------------------------------------------------------------

export function setupSeiteHtml(s: SetupSicht): string {
  const kacheln: string[] = [kachel("anmeldung", "konto", "Anmeldung", lageAnmeldung(s)), kachel("modell", "modell", "KI-Modell", lageModell(s.modell))];
  if (s.telegram) kacheln.push(kachel("telegram", "telegram", "Telegram", lageTelegram(s.telegram)));
  if (s.mail) kacheln.push(kachel("mail", "mail", "E-Mail", lageMail(s.mail)));

  const la = lageAnmeldung(s);
  const teile: string[] = [
    karte("anmeldung", "konto", "Anmeldung", "Mit deinem AVA-Konto", la.ton, la.badge, anmeldungInhalt(s), s),
  ];
  if (s.modell) {
    const lm = lageModell(s.modell);
    teile.push(karte("modell", "modell", "KI-Modell", "Damit AVA antworten und recherchieren kann", lm.ton, lm.badge, modellInhalt(s, s.modell), s));
  }
  if (s.telegram) {
    const lt = lageTelegram(s.telegram);
    teile.push(karte("telegram", "telegram", "Telegram", "Meldungen aufs Handy und Chat unterwegs", lt.ton, lt.badge, telegramInhalt(s, s.telegram), s));
  }
  if (s.mail) {
    const lmail = lageMail(s.mail);
    teile.push(karte("mail", "mail", "E-Mail", "Ein eigenes Postfach für AVA", lmail.ton, lmail.badge, mailInhalt(s, s.mail), s));
  }
  if (s.instanzen) {
    teile.push(karte("instanzen", "instanzen", "Deine AVAs", "Alle AVAs deines Kontos, Umzug zwischen ihnen", "neutral", s.instanzen.liste.length === 0 ? "Keine" : `${s.instanzen.liste.length} ${s.instanzen.liste.length === 1 ? "AVA" : "AVAs"}`, instanzenInhalt(s, s.instanzen), s));
  }

  const oben = s.meldung && !s.meldung.bereich ? hinweis(s.meldung.art === "ok" ? "ok" : "fehler", esc(s.meldung.text), true) : "";
  const angemeldet = s.anmeldung.zustand === "angemeldet";
  // Solange AVA startet oder auf die Anmeldung wartet, fragt die Seite den Stand ab und laedt bei Aenderung neu.
  const warten = !s.bereit || !angemeldet ? ` data-zustand="${esc(`${s.phase}|${angemeldet}|${s.anmeldung.zustand === "code"}`)}"` : "";
  const neuAb = s.anmeldung.zustand === "code" ? ` data-neu-ab="${s.anmeldung.bis + 2000}"` : "";
  const unterzeile = [s.instanzName, `Version ${s.version}`].filter(Boolean).map((x) => esc(String(x))).join(" · ");

  return seitenRahmen(
    "AVA-Server einrichten",
    `<header class="kopf"><span class="logo" aria-hidden="true">AVA</span><div><h1>Server-Einstellungen</h1><p>${unterzeile}</p></div></header>
${s.bereit ? `<nav class="uebersicht" aria-label="Überblick">${kacheln.join("")}</nav>` : ""}
${oben}${teile.join("\n")}
<footer class="fuss">Fragen? Schreib uns an <a href="mailto:info@eprox-gmbh.de">info@eprox-gmbh.de</a>.</footer>`,
    `${warten}${neuAb}`,
  );
}

/** Seite fuer einen fehlenden oder abgelaufenen Link. */
export function linkAbgelaufenHtml(): string {
  return seitenRahmen(
    "AVA-Server",
    `<header class="kopf"><span class="logo" aria-hidden="true">AVA</span><div><h1>Server-Einstellungen</h1></div></header>
<section class="karte"><header class="karte-kopf"><span class="karte-icon">${icon("konto")}</span><div class="karte-titel"><h2>Dieser Link gilt nicht mehr</h2><p>Aus Sicherheitsgründen ist er nur begrenzt gültig.</p></div></header>
<p>Öffne die Server-Einstellungen einfach neu: in der AVA-App unter <strong>Mehr → Deine AVA → „Server-Einstellungen öffnen“</strong>.</p>
<p class="klein">Betreibst du den Server selbst, steht ein dauerhafter Link im Startprotokoll des Servers.</p></section>
<footer class="fuss">Fragen? Schreib uns an <a href="mailto:info@eprox-gmbh.de">info@eprox-gmbh.de</a>.</footer>`,
    "",
  );
}

function seitenRahmen(titel: string, inhalt: string, bodyAttrs: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(titel)}</title><style>${CSS}</style></head><body${bodyAttrs}><main class="seite">${inhalt}</main><script>${SKRIPT}</script></body></html>`;
}

const CSS = `
:root{--bg:#F2F7F6;--karte:#fff;--text:#0A1F2A;--leise:#55716c;--linie:#dbe6e3;--feld:#fff;--feld-linie:#bccdc9;--akzent:#00C0A7;--akzent-hover:#00ad96;--akzent-weich:#dcf5f0;--akzent-tief:#00806f;--link:#007a6a;--marke-bg:#0A1F2A;--marke-text:#00C0A7;--ok:#0a7a64;--ok-bg:#e0f5ef;--warn:#8a5a00;--warn-bg:#fdf1d6;--fehler:#b3261e;--fehler-bg:#fde7e4;--neutral-bg:#edf3f2;--schatten:0 1px 2px rgba(10,31,42,.05),0 6px 20px rgba(10,31,42,.04);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0A1F2A;--karte:#0f2b37;--text:#e6f1ef;--leise:#93b0ab;--linie:#1f4352;--feld:#0b2430;--feld-linie:#2c5464;--akzent-hover:#1fd3bb;--akzent-weich:rgba(0,192,167,.15);--akzent-tief:#3fdac4;--link:#3fdac4;--marke-bg:#00C0A7;--marke-text:#0A1F2A;--ok:#4fd8bf;--ok-bg:rgba(0,192,167,.14);--warn:#f0c35c;--warn-bg:rgba(240,195,92,.13);--fehler:#ff8f80;--fehler-bg:rgba(255,120,100,.14);--neutral-bg:#15343f;--schatten:none;color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.seite{max-width:46rem;margin:0 auto;padding:2rem 1rem 3rem}
a{color:var(--link)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:var(--neutral-bg);padding:.1rem .35rem;border-radius:.3rem;overflow-wrap:anywhere}
p{margin:0 0 .6rem}
.icon{width:1.1rem;height:1.1rem;flex:none}
.kopf{display:flex;align-items:center;gap:.9rem;margin-bottom:1.4rem}
.logo{display:inline-flex;align-items:center;justify-content:center;height:2.7rem;padding:0 .75rem;border-radius:.75rem;background:var(--marke-bg);color:var(--marke-text);font-weight:800;letter-spacing:.08em;font-size:1rem;flex:none}
.kopf h1{margin:0;font-size:1.4rem;line-height:1.2}
.kopf p{margin:.2rem 0 0;color:var(--leise);font-size:.875rem}
.uebersicht{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.6rem;margin-bottom:1.25rem}
@media (max-width:44rem){.uebersicht{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kachel{display:flex;flex-direction:column;gap:.3rem;padding:.75rem .85rem;border-radius:.85rem;background:var(--karte);border:1px solid var(--linie);text-decoration:none;color:inherit;box-shadow:var(--schatten);min-width:0;transition:border-color .15s}
.kachel:hover{border-color:var(--akzent)}
.kachel:focus-visible{outline:2px solid var(--akzent);outline-offset:2px}
.kachel-kopf{display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--leise);font-weight:600}
.kachel-kopf .icon{width:.95rem;height:.95rem}
.kachel-wert{display:flex;align-items:flex-start;gap:.35rem;font-weight:650;font-size:.92rem;line-height:1.3;min-width:0}
.kachel-wert span{min-width:0;overflow-wrap:anywhere}
.kachel-wert .icon{width:1rem;height:1rem;margin-top:.1rem}
.ton-ok{color:var(--ok)}.ton-warn{color:var(--warn)}.ton-fehler{color:var(--fehler)}.ton-neutral{color:var(--leise)}
.karte{background:var(--karte);border:1px solid var(--linie);border-radius:1rem;padding:1.25rem;margin-bottom:1rem;box-shadow:var(--schatten);scroll-margin-top:1rem}
.karte-kopf{display:flex;align-items:flex-start;gap:.75rem;margin-bottom:1rem}
.karte-icon{display:inline-flex;align-items:center;justify-content:center;width:2.3rem;height:2.3rem;border-radius:.65rem;background:var(--akzent-weich);color:var(--akzent-tief);flex:none}
.karte-titel{flex:1;min-width:0}
.karte-titel h2{margin:0;font-size:1.1rem;line-height:1.3}
.karte-titel p{margin:.1rem 0 0;color:var(--leise);font-size:.875rem}
.badge{display:inline-flex;align-items:center;font-size:.75rem;font-weight:650;padding:.22rem .6rem;border-radius:999px;white-space:nowrap;flex:none;margin-top:.15rem}
.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.fehler{background:var(--fehler-bg);color:var(--fehler)}.badge.neutral{background:var(--neutral-bg);color:var(--leise)}
.hinweis{display:flex;gap:.6rem;align-items:flex-start;padding:.7rem .85rem;border-radius:.7rem;margin:0 0 1rem;font-size:.92rem}
.hinweis .icon{margin-top:.15rem}
.hinweis.ok{background:var(--ok-bg)}.hinweis.ok .icon{color:var(--ok)}
.hinweis.warn{background:var(--warn-bg)}.hinweis.warn .icon{color:var(--warn)}
.hinweis.fehler{background:var(--fehler-bg)}.hinweis.fehler .icon{color:var(--fehler)}
.hinweis.neutral{background:var(--neutral-bg)}.hinweis.neutral .icon{color:var(--leise)}
.zeile{display:flex;gap:.5rem;align-items:flex-start}
.zeile>.icon{color:var(--ok);margin-top:.2rem}
.weg{border:1px solid var(--linie);border-radius:.85rem;padding:1rem;margin-top:1rem}
.weg-kopf{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.75rem;flex-wrap:wrap}
.weg h3,.unterkopf{margin:0;font-size:1rem}
.unterkopf{margin-top:1.4rem;margin-bottom:.25rem}
.etikett{font-size:.75rem;font-weight:600;color:var(--leise);background:var(--neutral-bg);border-radius:999px;padding:.18rem .6rem}
.schritte{list-style:none;margin:.9rem 0 0;padding:0;display:grid;gap:1rem}
.schritte>li{display:flex;gap:.75rem;align-items:flex-start}
.nr{display:inline-flex;align-items:center;justify-content:center;width:1.65rem;height:1.65rem;border-radius:50%;background:var(--akzent);color:#0A1F2A;font-weight:700;font-size:.82rem;flex:none}
.gedimmt .nr{background:var(--neutral-bg);color:var(--leise)}
.gedimmt .schritt{color:var(--leise)}
.schritt{flex:1;min-width:0;padding-top:.1rem}
.schritt>p:last-child{margin-bottom:0}
.schritt .aktionen{margin-top:.5rem}
.formular{display:grid;gap:.8rem}
.formular.abstand{margin-top:.8rem}
label.feld{display:grid;gap:.3rem;font-size:.84rem;font-weight:600;min-width:0}
input,select,textarea{font:inherit;font-size:.95rem;padding:.55rem .7rem;border:1px solid var(--feld-linie);border-radius:.55rem;background:var(--feld);color:var(--text);width:100%;min-width:0}
input[type=checkbox]{width:auto}
input:focus,select:focus,textarea:focus{outline:2px solid var(--akzent);outline-offset:0;border-color:var(--akzent)}
textarea{min-height:5.5rem;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;line-height:1.4}
fieldset{border:1px solid var(--linie);border-radius:.75rem;padding:.6rem .85rem .85rem;margin:0;display:grid;gap:.6rem;min-width:0}
legend{font-weight:700;font-size:.86rem;padding:0 .3rem}
.raster{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}
.schluessel-raster{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}
@media (max-width:36rem){.raster,.schluessel-raster{grid-template-columns:minmax(0,1fr)}}
.haken{display:flex;align-items:center;gap:.5rem;font-size:.88rem}
.haken input,.schalter input{accent-color:var(--akzent);width:1.1rem;height:1.1rem;margin:0;flex:none}
.schalter-liste{border:1px solid var(--linie);border-radius:.75rem;padding:0 .85rem}
.schalter{display:flex;gap:.7rem;align-items:flex-start;padding:.7rem 0;border-top:1px solid var(--linie);cursor:pointer}
.schalter:first-child{border-top:0}
.schalter input{margin-top:.2rem}
.schalter strong{display:block;font-size:.92rem}
.schalter .klein{display:block}
.knopf{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;font:inherit;font-size:.92rem;font-weight:600;padding:.55rem 1rem;min-height:2.5rem;border-radius:.6rem;border:1px solid transparent;cursor:pointer;text-decoration:none;line-height:1.2;transition:background-color .15s,border-color .15s}
.knopf .icon{width:1rem;height:1rem}
.knopf.primaer{background:var(--akzent);color:#0A1F2A}
.knopf.primaer:hover{background:var(--akzent-hover);color:#0A1F2A}
.knopf.sekundaer{background:var(--karte);color:var(--text);border-color:var(--feld-linie)}
.knopf.sekundaer:hover{background:var(--neutral-bg);color:var(--text)}
.knopf.gefahr{background:transparent;color:var(--fehler);padding-left:.6rem;padding-right:.6rem}
.knopf.gefahr:hover{background:var(--fehler-bg);color:var(--fehler)}
.knopf:disabled{opacity:.6;cursor:progress}
.knopf:focus-visible{outline:2px solid var(--akzent);outline-offset:2px}
.aktionen{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.9rem}
.aktionen form{margin:0}
.aktionen.trenner{border-top:1px solid var(--linie);padding-top:.9rem;margin-top:1.1rem}
.klein{font-size:.84rem;color:var(--leise)}
p.klein{margin-top:.6rem}
.code-feld{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin:.9rem 0}
.code{font:700 1.75rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;background:var(--neutral-bg);padding:.65rem .95rem;border-radius:.65rem}
.liste{list-style:none;margin:0;padding:0;border:1px solid var(--linie);border-radius:.75rem;overflow:hidden}
.liste>li{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.6rem .85rem;border-top:1px solid var(--linie);min-width:0}
.liste>li:first-child{border-top:0}
.liste form{margin:0}
.anbieter{margin-bottom:.9rem}
.eintrag{display:flex;flex-direction:column;min-width:0;overflow-wrap:anywhere}
.instanzen>li{display:block;padding:.85rem}
.instanz-kopf{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.instanz-meta{display:flex;align-items:center;gap:.45rem;margin-top:.2rem}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.55rem}
.instanzen .aktionen{margin-top:.7rem}
.pill{display:inline-flex;align-items:center;font-size:.75rem;font-weight:600;border-radius:999px;padding:.16rem .6rem;background:var(--neutral-bg);color:var(--leise);white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}
.punkt{width:.5rem;height:.5rem;border-radius:50%;display:inline-block;background:var(--feld-linie);flex:none}
.punkt.ok{background:var(--ok)}
dl.daten{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.35rem 1rem;margin:0 0 1rem;font-size:.92rem}
dl.daten dt{color:var(--leise)}
dl.daten dd{margin:0;overflow-wrap:anywhere}
details.aufklapp{margin-top:1.1rem;border-top:1px solid var(--linie);padding-top:.9rem}
details.aufklapp>summary{cursor:pointer;font-weight:600;color:var(--link);list-style:none;display:inline-flex;align-items:center;gap:.35rem}
details.aufklapp>summary::-webkit-details-marker{display:none}
details.aufklapp>summary .icon{width:1rem;height:1rem;transition:transform .15s}
details.aufklapp[open]>summary .icon{transform:rotate(90deg)}
details.aufklapp>form{margin-top:1rem}
.inline-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:.6rem;align-items:end}
@media (max-width:36rem){.inline-form{grid-template-columns:minmax(0,1fr)}}
.eingabe-hinweis{font-size:.84rem;min-height:1.3em;margin:.4rem 0 0}
.eingabe-hinweis.ok{color:var(--ok)}.eingabe-hinweis.fehler{color:var(--fehler)}
.fuss{margin-top:2rem;text-align:center;color:var(--leise);font-size:.84rem}
@media (max-width:36rem){.seite{padding:1.25rem 1rem 2.5rem}.karte{padding:1rem}.code{font-size:1.45rem}}
`;

// Kleines Skript ohne Abhaengigkeiten: Kopieren, Bestaetigen, Knoepfe beim Senden sperren,
// eingefuegte ChatGPT-Adresse pruefen, Stand abfragen solange AVA startet oder wartet.
const SKRIPT = `(function(){
var b=document.body;
document.querySelectorAll('[data-kopieren]').forEach(function(k){k.addEventListener('click',function(){if(!navigator.clipboard)return;navigator.clipboard.writeText(k.getAttribute('data-kopieren')).then(function(){var s=k.querySelector('span');if(!s)return;var a=s.textContent;s.textContent='Kopiert';setTimeout(function(){s.textContent=a},1600)}).catch(function(){})})});
document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){var frage=f.getAttribute('data-bestaetigen');if(frage&&!window.confirm(frage)){e.preventDefault();return}if(f.target==='_blank'){setTimeout(function(){location.reload()},1500);return}var k=f.querySelector('button[type=submit]');if(k){var s=k.querySelector('span')||k;s.textContent=f.getAttribute('data-laedt')||'Bitte warten …';setTimeout(function(){k.disabled=true},0)}})});
window.addEventListener('pageshow',function(e){if(e.persisted)location.reload()});
var ta=document.querySelector('textarea[name=adresse]'),hw=document.getElementById('adresse-hinweis');
if(ta&&hw){var p=function(){var v=ta.value.trim(),k='',t='';if(v){if(/[?&]code=/.test(v)&&/[?&]state=/.test(v)){k='ok';t='Sieht gut aus. Jetzt \\u201EVerbindung abschlie\\u00DFen\\u201C dr\\u00FCcken.'}else if(/[?&]error=/.test(v)){k='fehler';t='Die Adresse meldet einen Abbruch. Starte die Anmeldung in Schritt 1 neu.'}else{k='fehler';t='Darin fehlt der Code. Kopiere die komplette Adresse aus der Adresszeile; sie beginnt mit http://127.0.0.1:1456/auth/callback?code='}}hw.className='eingabe-hinweis '+k;hw.textContent=t};ta.addEventListener('input',p);p()}
var z=b.getAttribute('data-zustand'),bis=Number(b.getAttribute('data-neu-ab')||0);
if(z){var t=new URLSearchParams(location.search).get('t')||'';setInterval(function(){if(bis&&Date.now()>bis){location.reload();return}fetch('/status?t='+encodeURIComponent(t),{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&(j.phase+'|'+j.angemeldet+'|'+!!j.anmeldecode)!==z)location.reload()}).catch(function(){})},4000)}
})();`;
