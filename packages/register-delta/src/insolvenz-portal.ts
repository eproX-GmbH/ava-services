// Insolvenz-Delta I3 — Insolvenzportal per Selenium (gleiche Haertung wie
// RegisterPortal): Suche ueber den Registereintrag, Trefferliste, Text je
// Zeile ueber das versteckte Feld frm_text:ihd_text (Popup stillgelegt).
// Selektoren aus master-data/scripts/de/insolvenz_delta.ipynb.

import { Builder, By, type WebDriver } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome";
import { findeChrome, type PortalOptionen } from "./portal";
import { insolvenzPortalGericht, parseTrefferliste, type InsolvenzRohZeile, type InsolvenzZeile } from "./insolvenz-parser";

export const INSOLVENZ_URL = "https://neu.insolvenzbekanntmachungen.de/ap/suche.jsf";

export type InsolvenzSuchergebnis = { gesperrt: boolean; fehler: string; zeilen: InsolvenzZeile[]; dauerMs: number };

const SPERR_RE = /zu viele Anfragen|Too Many Requests|\b429\b|vorübergehend gesperrt/i;

const FORMULAR_SKRIPT = `
  const [gericht, art, nummer] = arguments;
  function setSel(id, text){ const s=document.getElementById(id); if(!s) return 'fehlt '+id; const o=[...s.options].find(o=>o.text.trim()===text); if(!o) return 'option fehlt '+text; s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; }
  const r = [setSel('frm_suche:ir_registereintrag:som_registergericht:mysom', gericht), setSel('frm_suche:ir_registereintrag:som_registerart:mysom', art)];
  const n = document.getElementById('frm_suche:ir_registereintrag:itx_registernummer'); if(!n) return ['nummernfeld fehlt']; n.value = nummer; n.dispatchEvent(new Event('input',{bubbles:true}));
  for (const d of document.querySelectorAll('input[type=date]')) { d.value=''; d.dispatchEvent(new Event('change',{bubbles:true})); }
  const b=[...document.querySelectorAll('button[type=submit], input[type=submit]')].find(x=>/Suchen/.test(x.textContent||x.value||''));
  if(!b) return ['suchen-knopf fehlt']; b.click(); return r;`;

const ZEILEN_SKRIPT = `
  const t = document.getElementById('tbl_ergebnis'); if (!t) return [];
  return [...t.querySelectorAll('tbody tr')].map((tr, i) => ({ index: i, zellen: [...tr.querySelectorAll('td')].map(td => td.textContent) }));`;

export class InsolvenzPortal {
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
    options.addArguments("--lang=de-DE", "--window-size=1400,1000", "--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox");
    options.setUserPreferences({ download_restrictions: 3, "download.prompt_for_download": true, "safebrowsing.enabled": true, "intl.accept_languages": "de-DE,de" });
    this.driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
    await this.driver.manage().setTimeouts({ pageLoad: 60_000 });
  }

  private d(): WebDriver {
    if (!this.driver) throw new Error("Insolvenzportal nicht geoeffnet");
    return this.driver;
  }

  /** Suche ueber Registergericht (Bestandsschreibweise), Art und Nummer; Datum leer = gesamte Laufzeit. */
  async sucheRegistereintrag(gerichtBestand: string, art: string, nummer: number | string): Promise<InsolvenzSuchergebnis> {
    const d = this.d();
    const t0 = Date.now();
    await d.get(INSOLVENZ_URL);
    const r = (await d.executeScript(FORMULAR_SKRIPT, insolvenzPortalGericht(gerichtBestand), art, String(nummer))) as string[];
    if (r.some((x) => x !== "ok")) throw new Error(`Insolvenzportal-Formular: ${r.join(", ")} (${gerichtBestand} ${art} ${nummer})`);
    this.anfragen++;
    await d.wait(async () => {
      const title = await d.getTitle();
      if (title.includes("Suchergebnis")) return true;
      const err = (await d.executeScript("return (document.getElementById('msgs_err')||{}).innerText||''")) as string;
      return err.trim().length > 0;
    }, 60_000);
    await schlafen(800);
    const fehler = ((await d.executeScript("return (document.getElementById('msgs_err')||{}).innerText||''")) as string).trim();
    const text = (await d.executeScript("return document.body.innerText")) as string;
    if (SPERR_RE.test(fehler) || (SPERR_RE.test(text) && !(await d.getTitle()).includes("Suchergebnis"))) {
      this.log(`Insolvenzportal: Sperre nach ${this.anfragen} Anfragen`);
      return { gesperrt: true, fehler, zeilen: [], dauerMs: Date.now() - t0 };
    }
    const roh = (await d.executeScript(ZEILEN_SKRIPT)) as InsolvenzRohZeile[];
    return { gesperrt: false, fehler, zeilen: parseTrefferliste(roh), dauerMs: Date.now() - t0 };
  }

  /** Veroeffentlichungstext (HTML) der Zeile i der aktuell angezeigten Trefferliste; "" wenn keiner kommt. */
  async ladeText(index: number): Promise<string> {
    const d = this.d();
    await d.executeScript(`window.open = function(){ return { closed:false, document:{ body:{ innerHTML:'' }, write(){}, close(){} }, focus(){}, close(){} }; };
      const f=document.getElementById('frm_text:ihd_text'); if(f) f.value='';`);
    const btn = await d.findElements(By.css(`form[id='tbl_ergebnis:${index}:frm_detail'] input[type=image]`));
    if (btn.length === 0) return "";
    await d.executeScript("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", btn[0]);
    this.anfragen++;
    try {
      await d.wait(async () => ((await d.executeScript("return (document.getElementById('frm_text:ihd_text')||{}).value||''")) as string) !== "", 30_000);
    } catch {
      return "";
    }
    return (await d.executeScript("return document.getElementById('frm_text:ihd_text').value")) as string;
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

function schlafen(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
