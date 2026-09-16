// Registerportal (handelsregister.de) per Selenium: Erweiterte Suche mit
// exakter Registernummer und die Seite der Registerbekanntmachungen.
// Selektoren aus dem Notebook (JSF-Formular "form:*"). Sicherheitsregeln
// (docs/SICHERHEIT_HINTERGRUND_BROWSER.md): headless, Downloads hart
// gesperrt (download_restrictions 3), keine anderen Domains.

import fs from "node:fs";
import { Builder, By, until, type WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome";
import { portalGericht } from "./ids";
import { parseErgebnis, SPERR_RE, trefferzahl, type RohZeile, type Treffer } from "./parser";

export const PORTAL_URL = "https://www.handelsregister.de/rp_web/welcome.xhtml";

export type PortalOptionen = {
  chromeBinaryPath?: string;
  headless?: boolean;
  /** Hook fuer Protokollzeilen (Desktop: Producer-Log). */
  log?: (zeile: string) => void;
};

export type Suchergebnis = {
  gesperrt: boolean;
  treffer: Treffer[];
  trefferRoh: number | null;
  dauerMs: number;
};

const CHROME_KANDIDATEN = [
  process.env.CHROME_BIN,
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean) as string[];

export function findeChrome(explizit?: string): string | undefined {
  for (const p of [explizit, ...CHROME_KANDIDATEN]) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* weiter */
    }
  }
  return undefined;
}

const ZEILEN_SKRIPT = `
  return [...document.querySelectorAll('tr[data-ri]')].map(tr => {
    const head = tr.querySelector('td.fontTableNameSize');
    if (!head) return null;
    const sitz = tr.querySelector('td.sitzSuchErgebnisse');
    const sitzSpans = sitz ? new Set(sitz.querySelectorAll('span')) : new Set();
    const statusTexte = [...tr.querySelectorAll('span.verticalText')].filter(s => !sitzSpans.has(s)).map(s => s.textContent.trim()).filter(Boolean);
    const walker = document.createTreeWalker(tr, NodeFilter.SHOW_TEXT);
    const texte = []; let n;
    while ((n = walker.nextNode())) { const t = n.textContent.replace(/\\s+/g, ' ').trim(); if (t) texte.push(t); }
    const name = tr.querySelector('span.marginLeft20');
    return { kopf: head.textContent, name: name ? name.textContent : null, sitz: sitz ? sitz.textContent : null, statusTexte, texte };
  }).filter(Boolean);`;

const SUCHE_SKRIPT = `
  const [gericht, art, nummer, geschlossene] = arguments;
  function setSel(id, text){ const s=document.getElementById(id); if(!s) return false; const o=[...s.options].find(o=>o.text.trim()===text); if(!o) return false; s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); return true; }
  const a = setSel('form:registergericht_input', gericht); const b = setSel('form:registerArt_input', art); setSel('form:ergebnisseProSeite_input','100');
  const cb = document.getElementById('form:auchGeloeschte_input'); if (cb && cb.checked !== geschlossene) cb.click();
  const n = document.getElementById('form:registerNummer'); n.value = nummer; n.dispatchEvent(new Event('input',{bubbles:true}));
  if (a && b) document.getElementById('form:btnSuche').click();
  return {gericht: a, art: b};`;

export class RegisterPortal {
  private driver: WebDriver | null = null;
  anfragen = 0;
  private readonly log: (z: string) => void;

  constructor(private readonly opt: PortalOptionen = {}) {
    this.log = opt.log ?? (() => {});
  }

  async oeffnen(): Promise<void> {
    if (this.driver) return;
    const options = new chrome.Options();
    const bin = findeChrome(this.opt.chromeBinaryPath);
    if (bin) options.setChromeBinaryPath(bin);
    if (this.opt.headless !== false) options.addArguments("--headless=new");
    options.addArguments(`--ava-owner=${process.pid}`, "--lang=de-DE", "--window-size=1400,1000", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox");
    // Sprache erzwingen: auf Fly (kein Systemlocale) lieferte das Portal Englisch
    // ("Register announcements", Cookie-Knopf "Okay"), die Parser erwarten Deutsch.
    options.setUserPreferences({
      download_restrictions: 3,
      "download.prompt_for_download": true,
      "safebrowsing.enabled": true,
      "intl.accept_languages": "de-DE,de",
    });
    this.driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
    await this.driver.manage().setTimeouts({ pageLoad: 45_000 });
    await this.startseite();
  }

  private async startseite(): Promise<void> {
    const d = this.d();
    await d.get(PORTAL_URL);
    await this.pruefeStoerung();
    try {
      const btn = await d.wait(
        until.elementLocated(By.xpath("//button[contains(., 'Verstanden') or contains(., 'Okay')] | //a[contains(., 'Verstanden') or contains(., 'Okay')]")),
        6_000,
      );
      await btn.click();
      await schlafen(500);
    } catch {
      /* kein Cookie-Hinweis */
    }
    await this.erzwingeDeutsch();
  }

  /** Zeigt das Portal Englisch, auf den Sprachumschalter "DE" klicken. */
  private async erzwingeDeutsch(): Promise<void> {
    const d = this.d();
    const englisch = (await d.executeScript("return /Common register portal|Register announcements|Advanced search/.test(document.body.innerText)")) as boolean;
    if (!englisch) return;
    const geklickt = (await d.executeScript(`const el=[...document.querySelectorAll('a,button,span,li')].find(e=>e.children.length===0 && e.textContent.trim()==='DE'); if(!el) return false; el.click(); return true;`)) as boolean;
    this.log(`Portal auf Englisch, Umschalter DE ${geklickt ? "geklickt" : "nicht gefunden"}`);
    await schlafen(1500);
    const nochEnglisch = (await d.executeScript("return /Common register portal|Register announcements/.test(document.body.innerText)")) as boolean;
    if (nochEnglisch) throw new Error("Portal bleibt auf Englisch, Sprachumschalter wirkungslos");
  }

  private d(): WebDriver {
    if (!this.driver) throw new Error("Portal nicht geoeffnet");
    return this.driver;
  }

  /** Wartet auf eine Bedingung; bei Zeitueberschreitung Titel und Textanfang der Seite im Fehler (Diagnose auf Fly). */
  private async warteAuf(bedingung: () => Promise<boolean>, timeoutMs: number, was: string): Promise<void> {
    const d = this.d();
    try {
      await d.wait(bedingung, timeoutMs);
    } catch (err) {
      let title = "";
      let text = "";
      try {
        title = await d.getTitle();
        text = ((await d.executeScript("return document.body ? document.body.innerText : ''")) as string).replace(/\s+/g, " ").slice(0, 300);
      } catch {
        /* Browser weg */
      }
      throw new Error(`${was}: ${err instanceof Error ? err.message : String(err)} | Titel: "${title}" | Text: "${text}"`);
    }
  }

  /** Fehlertitel oder fehlende Suche = Stoerung; ein Statushinweis "Wartungsarbeiten" allein nicht (structured-content v1.2.2). */
  private async pruefeStoerung(): Promise<void> {
    const title = await this.d().getTitle();
    if (/nicht erreichbar|vorübergehend nicht|temporarily unavailable|Service Unavailable|Gateway Time-?out|\b50[234]\b/i.test(title)) {
      throw new PortalStoerung(`Portal meldet Stoerung: ${title}`);
    }
  }

  private async erweiterteSuche(): Promise<void> {
    const d = this.d();
    await d.executeScript(`const a=[...document.querySelectorAll('a')].find(x=>/erweiterteSucheLink/.test(x.getAttribute('onclick')||''));
      if(!a) throw new Error('erweiterteSucheLink fehlt'); a.click();`);
    await this.warteAuf(async () => (await d.findElements(By.id("form:registerNummer"))).length > 0, 20_000, "Erweiterte Suche");
  }

  /** Exakte Nummernsuche; mit "auch geloeschte" kommen alle Zusatz- und Altgerichts-Varianten mit. */
  async suche(gericht: string, art: string, nummer: number | string, auchGeschlossene = true): Promise<Suchergebnis> {
    const d = this.d();
    const t0 = Date.now();
    try {
      await this.erweiterteSuche();
    } catch {
      await this.startseite();
      await this.erweiterteSuche();
    }
    const ok = (await d.executeScript(SUCHE_SKRIPT, portalGericht(gericht), art, String(nummer), auchGeschlossene)) as { gericht: boolean; art: boolean };
    if (!ok.gericht || !ok.art) throw new Error(`Gericht/Art nicht im Portal-Select: ${gericht} / ${art}`);
    this.anfragen++;
    await this.warteAuf(async () => {
      const title = await d.getTitle();
      if (title.includes("Suchergebnis")) return true;
      const text = (await d.executeScript("return document.body.innerText")) as string;
      return SPERR_RE.test(text);
    }, 40_000, `Suche ${gericht} ${art} ${nummer}`);
    await schlafen(800);
    const title = await d.getTitle();
    const text = (await d.executeScript("return document.body.innerText")) as string;
    if (!title.includes("Suchergebnis") && SPERR_RE.test(text)) {
      this.log(`SPERRE nach ${this.anfragen} Anfragen: ${gericht} ${art} ${nummer}`);
      return { gesperrt: true, treffer: [], trefferRoh: null, dauerMs: Date.now() - t0 };
    }
    const zeilen = (await d.executeScript(ZEILEN_SKRIPT)) as RohZeile[];
    return { gesperrt: false, treffer: parseErgebnis(zeilen), trefferRoh: trefferzahl(text), dauerMs: Date.now() - t0 };
  }

  /** Seitentext der Registerbekanntmachungen (alle Tage des Fensters, ein Aufruf). */
  async bekanntmachungenText(): Promise<{ gesperrt: boolean; text: string }> {
    const d = this.d();
    await this.startseite();
    // Grosse Seite (fast 2 MB Text): auf kleinen Maschinen (Fly shared-cpu)
    // dauert das Rendern laenger als die 45 s Standard-Ladezeit.
    await d.manage().setTimeouts({ pageLoad: 180_000 });
    try {
      await d.executeScript(`const a=document.querySelector('[id$="bekanntmachungenLink"]'); if(!a) throw new Error('bekanntmachungenLink fehlt'); a.click();`);
      this.anfragen++;
      await this.warteAuf(async () => (await d.getTitle()).includes("Registerbekanntmachungen"), 150_000, "Bekanntmachungen");
      await schlafen(2000);
    } finally {
      await d.manage().setTimeouts({ pageLoad: 45_000 }).catch(() => undefined);
    }
    const text = (await d.executeScript("return document.body.innerText")) as string;
    if (SPERR_RE.test(text) && text.length < 2000) return { gesperrt: true, text: "" };
    return { gesperrt: false, text };
  }

  async schliessen(): Promise<void> {
    const d = this.driver;
    this.driver = null;
    if (d) {
      try {
        await d.quit();
      } catch {
        /* egal */
      }
    }
  }
}

export class PortalStoerung extends Error {}

function schlafen(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
