// M4 (docs/PLAN_EMAIL_MUSTER.md) — Hintergrund-Job "im Hinterkopf": alle
// 15 Minuten EINE Firma des Nutzers pruefen, ob sich aus bekannten
// Personen-E-Mails das Adressmuster ableiten und fuer Kontakte ohne Adresse
// per SMTP verifizieren laesst. Laeuft lokal, pausiert bei Chat-Turns und im
// Akkubetrieb. Der Server speichert nur (EmailPattern, derived-email).
//
// Stufe 2 (docs/PLAN_EMAIL_MUSTER_2.md, 2026-10-07):
//  - Firmenadressen (pdettlev@…) werden per Namensabgleich/KI-Urteil der
//    Person zugeordnet (zuordnung.ts) und zaehlen dann als Beleg.
//  - Fehlt ein Katalogmuster, fragt ein KI-Urteil nach der Vorlage.
//  - JEDE Person bekommt eine abgeleitete Adresse, auch wenn die Pruefung
//    in diesem Netz nicht moeglich ist (Port 25) oder der Server ablehnt —
//    dann klar als "abgeleitet · unverifiziert" bzw. "abgelehnt" mit
//    Verweis auf die Baseline. Offene Adressen werden spaeter nachgeprueft.
//
// Nachzuegler-Rolle (docs/PLAN_EMAIL_VERIFIZIERUNG.md, V4, 2026-10-11): Der
// Haupttreiber ist jetzt der Producer company-email direkt nach dem Contact
// Producer. Dieser Job holt nach, was dort nicht pruefbar war (Port 25
// gesperrt, 4xx, Deckel erreicht, offene Adressen) und frischt periodisch auf.
//  - Ein gemeinsamer Tages-Deckel mit dem Producer (TagesBudget, Datei
//    email-budget.json): Reputation ist geraeteweit.
//  - Domains, die der Producer in den letzten LIVE_SCHONFRIST_MS bearbeitet
//    hat (EmailPattern.stats.quelle = "live"), fasst der Job nicht an —
//    keine Doppelpruefung derselben Firma.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { domainVon, erkenneMuster, type MusterBeleg } from "./pattern";
import { firmenDomain } from "./domain";
import { bildeAdresseAllgemein, ordneFirmenadressen, type Urteil } from "./zuordnung";
import { ermittleFirmenAdressen, type AbgeleiteteAdresse, type ServerMuster, type SpeicherErgebnis } from "./ableitung";
import { VERLAUF_MAX, type EmailMusterConfig, type VerlaufEintrag, type Vorschau } from "../../../shared/email-muster-types";
export type { EmailMusterConfig, Vorschau } from "../../../shared/email-muster-types";
import { pruefeAdressen, pruefePort25, zufallsAdresse, type PruefErgebnis } from "./smtp-verify";
import { kontakteAusAntwort, type FirmenKontakte, type KontakteAntwort, type PersonInfo } from "./kontakte";
import { BUDGET_DATEI, TagesBudget } from "./budget";

const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 5 * 60_000;
const NETZ_RECHECK_MS = 6 * 3600_000;
const DOMAIN_RECHECK_MS = 30 * 86_400_000;
const CATCHALL_RECHECK_MS = 90 * 86_400_000;
const TAGES_DECKEL = 50;
/** V4: so lange nach einem Live-Lauf des Producers company-email bleibt die Domain dem Producer ueberlassen. */
const LIVE_SCHONFRIST_MS = 24 * 3600_000;
const MAX_FIRMEN_JE_TICK = 25;
/** Offene (unverifizierte) Adressen: hoechstens 3 Nachpruefungen, Abstand 24 h. */
const OFFEN_MAX_VERSUCHE = 3;
const OFFEN_ABSTAND_MS = 24 * 3600_000;

const DEFAULT: EmailMusterConfig = {
  enabled: true,
  zuordnungAktiv: true,
  ungeprueftAnzeigen: true,
  offen: {},
  lastRunAt: null,
  lastOutcome: null,
  netz: null,
  tag: { day: "", count: 0 },
  domains: {},
  stats: { firmen: 0, geprueft: 0, verifiziert: 0, unbestaetigt: 0, abgelehnt: 0, unbekannt: 0, catchAll: 0, zugeordnet: 0 },
  verlauf: [],
};

export interface EmailMusterDeps {
  gatewayRequest: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  isSignedIn: () => boolean;
  isLlmBusy: () => boolean;
  isOnBattery: () => boolean;
  audit: (entry: { summary: string; severity: "info" | "warning"; metadata: Record<string, unknown> }) => void;
  log: (msg: string) => void;
  onChanged?: (cfg: EmailMusterConfig) => void;
  /** Stufe 2: KI-Urteil (Hintergrund-Kanal). null/Fehler = ohne Urteil weiterarbeiten. */
  urteil?: Urteil | null;
}

export class EmailMusterSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cfg: EmailMusterConfig | null = null;
  private readonly path: string;

  /** V4: Tages-Deckel geteilt mit dem Producer company-email. */
  private readonly budget: TagesBudget;

  constructor(private readonly deps: EmailMusterDeps, dir: string) {
    this.path = join(dir, "email-muster.json");
    this.budget = new TagesBudget(join(dir, BUDGET_DATEI), TAGES_DECKEL);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), FIRST_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getConfig(): EmailMusterConfig {
    if (this.cfg) return this.cfg;
    try {
      const raw = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Partial<EmailMusterConfig>) : {};
      this.cfg = { ...DEFAULT, ...raw, tag: raw.tag ?? DEFAULT.tag, domains: raw.domains ?? {}, offen: raw.offen ?? {}, stats: { ...DEFAULT.stats, ...(raw.stats ?? {}) }, verlauf: Array.isArray(raw.verlauf) ? raw.verlauf : [] };
    } catch {
      this.cfg = { ...DEFAULT };
    }
    return this.cfg;
  }

  setConfig(patch: Partial<Pick<EmailMusterConfig, "enabled" | "zuordnungAktiv" | "ungeprueftAnzeigen">>): EmailMusterConfig {
    const next = { ...this.getConfig(), ...patch };
    this.cfg = next;
    this.persist();
    return next;
  }

  private persist(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.cfg ?? DEFAULT, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
    if (this.cfg) this.deps.onChanged?.(this.cfg);
  }

  status(): EmailMusterConfig & { laeuft: boolean } {
    return { ...this.getConfig(), laeuft: this.running };
  }

  /** Verlauf der Adresspruefungen, juengste zuerst; optional gefiltert. */
  verlauf(opts: { nur?: VerlaufEintrag["ergebnis"] | "gespeichert"; companyId?: string; limit?: number } = {}): VerlaufEintrag[] {
    let rows = this.getConfig().verlauf;
    if (opts.companyId) rows = rows.filter((r) => r.companyId === opts.companyId);
    if (opts.nur === "gespeichert") rows = rows.filter((r) => r.gespeichert);
    else if (opts.nur) rows = rows.filter((r) => r.ergebnis === opts.nur);
    return rows.slice(0, Math.max(1, Math.min(opts.limit ?? 100, VERLAUF_MAX)));
  }

  private merke(cfg: EmailMusterConfig, e: VerlaufEintrag): void {
    cfg.verlauf = [e, ...cfg.verlauf].slice(0, VERLAUF_MAX);
  }

  /** Manuell ausloesen (Einstellungen/Chat): ein Tick ohne Pausen-Ruecksicht. */
  async runNow(): Promise<string> {
    return this.tick(true);
  }

  // ---- Datenzugriff ----------------------------------------------------------

  private async firmen(): Promise<Array<{ companyId: string; name?: string }>> {
    const out: Array<{ companyId: string; name?: string }> = [];
    for (let page = 1; page <= 5; page++) {
      const r = await this.deps.gatewayRequest<{ companies?: Array<{ companyId: string; name?: string }> }>(`/v1/companies/matrix?pageNumber=${page}&pageSize=100`);
      const rows = r.companies ?? [];
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  }

  /**
   * V5 (docs/PLAN_CHAT_DATEIEN_KONTEXT.md, 2026-09-30): frei gewaehlte
   * Lokalteile (rechnung, buchhaltung, invoice) an der Firmendomain
   * pruefen. Nichts wird gespeichert; Funktionsadressen sind keine Personen.
   */
  async pruefeLokalteile(companyId: string, lokalteile: string[]): Promise<{ domain: string | null; ergebnisse: Array<{ email: string; ergebnis: PruefErgebnis; antwort: string | null }>; hinweis?: string }> {
    const { name, websiteUrl, personen, firmenEmails } = await this.kontakte(companyId);
    const fd = await this.firmenDomainVon({ name, websiteUrl, firmenEmails, personen }, false);
    const domain = fd?.domain ?? null;
    if (!domain) return { domain: null, ergebnisse: [], hinweis: "Keine Domain der Firma bekannt (weder Website noch Firmenadresse). Erst die Website der Firma ermitteln." };
    const adressen = [...new Set(lokalteile.map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z0-9._+-]{1,40}$/.test(l)))].slice(0, 10).map((l) => `${l}@${domain}`);
    if (adressen.length === 0) return { domain, ergebnisse: [], hinweis: "Keine gueltigen Lokalteile." };
    const r = await pruefeAdressen(domain, adressen, { catchAllProbe: zufallsAdresse(domain), log: this.deps.log });
    const ergebnisse = adressen.map((email) => ({ email, ergebnis: r.get(email)?.ergebnis ?? "unbekannt", antwort: r.get(email)?.antwort ?? null }));
    const catchAll = ergebnisse.some((e) => e.ergebnis === "catch_all");
    const gesperrt = ergebnisse.some((e) => e.ergebnis === "gesperrt");
    return {
      domain,
      ergebnisse,
      ...(catchAll ? { hinweis: "Der Mailserver nimmt jede Adresse an (Catch-all); ein 'catch_all' belegt die Adresse nicht. Dem Nutzer als unbestaetigt nennen." } : {}),
      ...(gesperrt ? { hinweis: "Der Mailserver blockt Pruefanfragen; keine Aussage moeglich." } : {}),
    };
  }

  private async kontakte(companyId: string): Promise<FirmenKontakte> {
    const r = await this.deps.gatewayRequest<KontakteAntwort>(`/v1/companies/${encodeURIComponent(companyId)}/contacts`);
    return kontakteAusAntwort(companyId, r);
  }

  /** Domain der Firma (domain.ts): Website, Firmenadresse oder bestätigter Alias; nie die Adresse einer anderen Firma. */
  private firmenDomainVon(k: { name: string; websiteUrl: string | null; firmenEmails: string[]; personen: PersonInfo[] }, mitUrteil: boolean) {
    return firmenDomain({ firmenname: k.name, websiteUrl: k.websiteUrl, firmenEmails: k.firmenEmails, personen: k.personen, urteil: mitUrteil ? (this.deps.urteil ?? null) : null });
  }

  /** Trockenlauf ohne Netzverkehr (Chat-Tool, Einstellungen). Zuordnung nur deterministisch, kein KI-Urteil. */
  async vorschau(companyId: string): Promise<Vorschau> {
    const { name, websiteUrl, personen, firmenEmails } = await this.kontakte(companyId);
    const fd = await this.firmenDomainVon({ name, websiteUrl, firmenEmails, personen }, false);
    const domain = fd?.domain ?? null;
    if (!domain) return { companyId, domain: null, befund: null, kandidaten: [], personenMitMail: 0, personenOhneMail: personen.length, hinweis: "Keine Domain der Firma bekannt (weder Website noch Firmenadresse)." };
    const z = this.getConfig().zuordnungAktiv !== false ? await ordneFirmenadressen({ firmenEmails: firmenEmails.filter((e) => domainVon(e) === domain), personen: personen.filter((p) => p.emails.length === 0), firmenname: name, urteil: null }) : null;
    const zugeordnet = new Map((z?.zuordnungen ?? []).map((x) => [x.personId, x.email]));
    const belege: MusterBeleg[] = personen.flatMap((p) => [...p.emails, ...(zugeordnet.has(p.personId) ? [zugeordnet.get(p.personId)!] : [])].map((email) => ({ fullName: p.fullName, email })));
    const befund = erkenneMuster(domain, belege);
    const ohne = personen.filter((p) => p.emails.length === 0 && !zugeordnet.has(p.personId));
    const kandidaten = befund.muster
      ? ohne.map((p) => ({ personId: p.personId, fullName: p.fullName, email: bildeAdresseAllgemein(befund.muster!, p.fullName, domain) ?? "" })).filter((k) => k.email)
      : [];
    return {
      companyId,
      domain,
      befund,
      kandidaten,
      zuordnungen: (z?.zuordnungen ?? []).map((x) => ({ personId: x.personId, fullName: x.fullName, email: x.email, begruendung: x.begruendung })),
      baseline: befund.belege[0]?.email ?? null,
      personenMitMail: personen.length - ohne.length,
      personenOhneMail: ohne.length,
      hinweis: befund.muster ? null : befund.unerklaert.length > 0 ? "Kein eindeutiges Muster (Belege widersprechen sich); der Hintergrund-Job fragt ein KI-Urteil." : "Keine personengebundene E-Mail als Beleg vorhanden.",
    };
  }

  // ---- Tick ------------------------------------------------------------------

  private async tick(manuell = false): Promise<string> {
    const cfg = this.getConfig();
    if (this.running) return "laeuft bereits";
    if (!cfg.enabled && !manuell) return "aus";
    if (!this.deps.isSignedIn()) return "nicht angemeldet";
    if (!manuell && (this.deps.isLlmBusy() || this.deps.isOnBattery())) return "pausiert (Chat aktiv oder Akkubetrieb)";
    const heute = new Date().toISOString().slice(0, 10);
    if (cfg.tag.day !== heute) cfg.tag = { day: heute, count: 0 };
    // Uebergang: der bisherige Zaehler des Tages geht ins gemeinsame Budget ein.
    if (cfg.tag.count > this.budget.verbraucht()) this.budget.verbrauche(cfg.tag.count - this.budget.verbraucht());
    cfg.tag.count = this.budget.verbraucht();
    if (this.budget.frei() <= 0 && !manuell) return `Tages-Deckel (${TAGES_DECKEL}) erreicht (gemeinsam mit dem Producer company-email)`;
    this.running = true;
    let outcome = "nichts zu tun";
    try {
      // Netz: Port 25 erreichbar?
      if (!cfg.netz || Date.now() - Date.parse(cfg.netz.at) > NETZ_RECHECK_MS || manuell) {
        const n = await pruefePort25();
        cfg.netz = { ...n, at: new Date().toISOString() };
        this.persist();
      }
      if (!cfg.netz.erreichbar && cfg.ungeprueftAnzeigen === false) {
        outcome = `Mail-Pruefung in diesem Netz nicht moeglich (Port 25 gesperrt: ${cfg.netz.grund})`;
        return outcome;
      }
      const alle = await this.firmen();
      for (let i = alle.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [alle[i], alle[j]] = [alle[j]!, alle[i]!];
      }
      let angesehen = 0;
      for (const firma of alle) {
        if (angesehen >= MAX_FIRMEN_JE_TICK) break;
        angesehen++;
        const ergebnis = await this.pruefeFirma(firma.companyId, cfg, manuell);
        if (ergebnis) {
          outcome = ergebnis;
          break;
        }
      }
      return outcome;
    } catch (err) {
      outcome = `Fehler: ${err instanceof Error ? err.message : String(err)}`;
      return outcome;
    } finally {
      this.running = false;
      cfg.lastRunAt = new Date().toISOString();
      cfg.lastOutcome = outcome;
      this.persist();
    }
  }

  /** Liefert eine Zusammenfassung, wenn fuer diese Firma gearbeitet wurde; sonst null (naechste Firma). */
  private async pruefeFirma(companyId: string, cfg: EmailMusterConfig, manuell: boolean): Promise<string | null> {
    const k = await this.kontakte(companyId);
    const { personen } = k;
    const name = k.name;
    if (personen.length === 0) return null;
    const fd = await this.firmenDomainVon(k, true);
    if (!fd) return null;
    const domain = fd.domain;
    const netzOk = cfg.netz?.erreichbar === true;
    const jetzt = () => new Date().toISOString();

    // Personen ohne belastbare Adresse; "offene" Ableitungen zaehlen als nachpruefbar.
    const ohne = personen.filter((p) => p.emails.length === 0);
    const nachpruefbar = ohne.filter((p) => p.offeneEmails.length > 0 && netzOk && p.offeneEmails.some((e) => this.offenFaellig(cfg, e)));
    const unversorgt = ohne.filter((p) => p.offeneEmails.length === 0);
    if (unversorgt.length === 0 && nachpruefbar.length === 0) return null;

    // V4: Muster/Befund vom Gateway — auch, um frische Live-Laeufe des Producers zu erkennen.
    const server = await this.holeMuster(domain);
    if (!manuell && server?.stats?.quelle === "live" && Date.now() - Date.parse(server.checkedAt ?? "") < LIVE_SCHONFRIST_MS) return null;

    const teile: string[] = [];

    // ---- A. Nachpruefung offener Adressen (nur dieser Job macht das) ----------
    if (nachpruefbar.length > 0) {
      const kandidaten = nachpruefbar
        .map((p) => ({ p, email: p.offeneEmails.find((e) => this.offenFaellig(cfg, e)) ?? "" }))
        .filter((x) => x.email)
        .slice(0, 5);
      const r = await pruefeAdressen(domain, kandidaten.map((x) => x.email), { catchAllProbe: zufallsAdresse(domain), log: this.deps.log });
      let verifiziert = 0, abgelehnt = 0, unbestaetigt = 0, weiterOffen = 0;
      for (const { p, email } of kandidaten) {
        const d = r.get(email);
        const e: PruefErgebnis = d?.ergebnis ?? "unbekannt";
        if (d?.mx && e !== "gesperrt") {
          this.zaehle(cfg);
          cfg.stats.geprueft++;
        }
        const art = e === "existiert" ? "smtp" : e === "catch_all" ? "catchall" : e === "existiert_nicht" ? "abgelehnt" : "offen";
        const eintrag: VerlaufEintrag = { at: jetzt(), companyId, firma: name, domain, personId: p.personId, fullName: p.fullName, email, muster: server?.muster ?? "nachpruefung", ergebnis: e === "existiert" ? "verifiziert" : e === "catch_all" ? "catch_all" : e === "existiert_nicht" ? "abgelehnt" : e === "gesperrt" ? "gesperrt" : "unklar", gespeichert: false, smtpCode: d?.code ?? undefined, mx: d?.mx ?? null };
        if (art === "offen") {
          // Offen bleibt offen: Versuch zaehlen, nichts erneut speichern.
          weiterOffen++;
          cfg.stats.unbekannt++;
          this.offenMerken(cfg, email);
          if (e === "gesperrt" && netzOk) cfg.netz = { erreichbar: false, grund: d?.antwort ?? "Verbindung zum Mailserver nicht moeglich", at: jetzt() };
        } else {
          try {
            await this.speichereAdresse(companyId, { personId: p.personId, email, muster: server?.muster ?? "nachpruefung", beleg: email, baseline: email, herkunft: "muster", art, domainQuelle: fd.quelle, mx: d?.mx ?? null, checkedAt: eintrag.at, ...(d?.code != null ? { smtpCode: d.code } : {}) });
            eintrag.gespeichert = true;
          } catch (err) {
            eintrag.fehler = `Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`;
            this.deps.log(`[email-muster] speichern fehlgeschlagen ${email}: ${eintrag.fehler}`);
          }
          this.offenVergessen(cfg, email);
          if (art === "smtp") {
            verifiziert++;
            cfg.stats.verifiziert++;
          } else if (art === "catchall") {
            unbestaetigt++;
            cfg.stats.unbestaetigt++;
          } else {
            abgelehnt++;
            cfg.stats.abgelehnt++;
          }
        }
        this.merke(cfg, eintrag);
      }
      if (verifiziert + abgelehnt + unbestaetigt + weiterOffen > 0) {
        teile.push(`Nachpruefung: ${[verifiziert > 0 ? `${verifiziert} verifiziert` : "", unbestaetigt > 0 ? `${unbestaetigt} unbestaetigt (Catch-all)` : "", abgelehnt > 0 ? `${abgelehnt} vom Server abgelehnt` : "", weiterOffen > 0 ? `${weiterOffen} weiter offen` : ""].filter(Boolean).join(", ")}`);
      }
    }

    // ---- B. Unversorgte Personen: dieselbe Ableitung wie der Producer ----------
    if (unversorgt.length > 0) {
      // Regel (Operator 2026-09-10): eine Domain erst nach Ablauf der Frist erneut
      // anfassen, ausser es gibt neue Belege oder sie blieb ausdruecklich offen.
      const belegeAnzahl = personen.reduce((n, p) => n + p.emails.filter((e) => domainVon(e) === domain).length, 0);
      const stand = cfg.domains[domain];
      let faellig = true;
      if (stand && !manuell) {
        const alter = Date.now() - Date.parse(stand.at);
        const frist = stand.catchAll ? CATCHALL_RECHECK_MS : DOMAIN_RECHECK_MS;
        if (alter < frist && stand.belege === belegeAnzahl && stand.offen !== true) faellig = false;
      }
      if (faellig) {
        let offenGespeichert = 0;
        const r = await ermittleFirmenAdressen(companyId, k, {
          netzOk: () => cfg.netz?.erreichbar === true,
          netzGesperrt: (grund) => {
            cfg.netz = { erreichbar: false, grund, at: jetzt() };
          },
          netzPruefe: async () => {
            const n = await pruefePort25();
            cfg.netz = { ...n, at: jetzt() };
            return n.erreichbar;
          },
          budget: { frei: () => this.budget.frei(), verbrauche: (n) => this.verbuche(cfg, n) },
          urteil: this.deps.urteil ?? null,
          holeMuster: () => Promise.resolve(server),
          speichereMuster: (dom, body) => this.deps.gatewayRequest(`/v1/email-patterns/${encodeURIComponent(dom)}`, { method: "PUT", body: { ...body, stats: { ...(body.stats ?? {}), quelle: "nachzuegler" } } }).then(() => undefined),
          speichereAdresse: (a) => this.speichereAdresse(companyId, a),
          log: (m) => this.deps.log(`[email-muster] ${m}`),
          zuordnungAktiv: cfg.zuordnungAktiv !== false,
          ungeprueftSpeichern: cfg.ungeprueftAnzeigen !== false,
          protokoll: (e) => {
            const a = e.adresse;
            const ergebnis: VerlaufEintrag["ergebnis"] = a.herkunft === "zuordnung" ? "zugeordnet" : a.art === "smtp" ? "verifiziert" : a.art === "catchall" ? "catch_all" : a.art === "abgelehnt" ? "abgelehnt" : e.smtp === "gesperrt" ? "gesperrt" : "unklar";
            const p = personen.find((x) => x.personId === a.personId);
            this.merke(cfg, { at: a.checkedAt, companyId, firma: name, domain, personId: a.personId, fullName: p?.fullName ?? "", email: a.email, muster: a.muster, ergebnis, gespeichert: e.ergebnis === "gespeichert", baseline: a.baseline, ...(a.smtpCode != null ? { smtpCode: a.smtpCode } : {}), mx: a.mx ?? null, ...(e.fehler ? { fehler: e.fehler } : {}) });
            if (e.ergebnis === "gespeichert") {
              if (a.herkunft === "zuordnung") cfg.stats.zugeordnet = (cfg.stats.zugeordnet ?? 0) + 1;
              else if (a.art === "smtp") cfg.stats.verifiziert++;
              else if (a.art === "catchall") cfg.stats.unbestaetigt++;
              else if (a.art === "abgelehnt") cfg.stats.abgelehnt++;
              else cfg.stats.unbekannt++;
              // Offene Adressen spaeter nachpruefen (Rolle dieses Jobs).
              if (a.art === "offen") {
                this.offenMerken(cfg, a.email);
                offenGespeichert++;
              }
            }
          },
        });
        if (r.urteil === "catchall") cfg.stats.catchAll++;
        if (r.status === "fertig" || r.status === "fehler") cfg.stats.firmen++;
        if (r.status !== "nichts_zu_tun" && r.status !== "keine_domain") {
          cfg.domains[domain] = { at: jetzt(), muster: r.muster, belege: belegeAnzahl, catchAll: r.urteil === "catchall", offen: r.status === "fehler" || r.gespeichert + r.vorhanden < unversorgt.length, ...(r.status === "fehler" ? { grund: r.letzterFehler ?? "Speichern fehlgeschlagen" } : {}) };
          teile.push(r.zusammenfassung.replace(/^[^:]*: /, ""));
          this.deps.log(`[email-muster] ${r.zusammenfassung}${offenGespeichert > 0 ? ` (${offenGespeichert} zur Nachpruefung vorgemerkt)` : ""}`);
        }
      }
    }

    if (teile.length === 0) return null;
    const zusammenfassung = `${name}: ${teile.join("; ")}`;
    this.deps.audit({ summary: `E-Mail-Ableitung (Nachzuegler) — ${zusammenfassung}`, severity: "info", metadata: { companyId, domain } });
    return zusammenfassung;
  }

  private async holeMuster(domain: string): Promise<ServerMuster | null> {
    try {
      const r = await this.deps.gatewayRequest<{ muster: string | null; konfidenz: number; belege?: MusterBeleg[]; catchAllAt: string | null; checkedAt?: string; stats?: Record<string, unknown> }>(`/v1/email-patterns/${encodeURIComponent(domain)}`);
      return { muster: r.muster, konfidenz: r.konfidenz, belege: r.belege, catchAllAt: r.catchAllAt, checkedAt: r.checkedAt ?? "", stats: r.stats };
    } catch {
      return null;
    }
  }

  /** POST derived-email; 409 = schon vorhanden, andere 4xx = vom Gateway abgewiesen, sonst Fehler. */
  private async speichereAdresse(companyId: string, a: AbgeleiteteAdresse): Promise<SpeicherErgebnis> {
    try {
      await this.deps.gatewayRequest(`/v1/companies/${encodeURIComponent(companyId)}/contacts/derived-email`, { method: "POST", body: a });
      return "gespeichert";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /\b(4\d\d)\b/.exec(msg)?.[1];
      if (status === "409") return "vorhanden";
      if (status) return "abgewiesen";
      throw err;
    }
  }

  /** n SMTP-Anfragen im gemeinsamen Tages-Deckel verbuchen. */
  private verbuche(cfg: EmailMusterConfig, n: number): void {
    this.budget.verbrauche(n);
    cfg.tag.count = this.budget.verbraucht();
    cfg.stats.geprueft += n;
  }

  /** Eine SMTP-Anfrage im gemeinsamen Tages-Deckel verbuchen (V4). */
  private zaehle(cfg: EmailMusterConfig): void {
    this.budget.verbrauche(1);
    cfg.tag.count = this.budget.verbraucht();
  }

  // ---- Offene Adressen (Nachpruefung) ----------------------------------------

  private offenFaellig(cfg: EmailMusterConfig, email: string): boolean {
    const o = cfg.offen?.[email];
    if (!o) return true;
    return o.versuche < OFFEN_MAX_VERSUCHE && Date.now() - Date.parse(o.at) > OFFEN_ABSTAND_MS;
  }

  private offenMerken(cfg: EmailMusterConfig, email: string): void {
    cfg.offen = cfg.offen ?? {};
    const o = cfg.offen[email];
    cfg.offen[email] = { versuche: (o?.versuche ?? 0) + 1, at: new Date().toISOString() };
    // Deckel gegen Wachstum: aelteste Eintraege verwerfen.
    const keys = Object.keys(cfg.offen);
    if (keys.length > 2000) for (const k of keys.sort((a, b) => Date.parse(cfg.offen![a]!.at) - Date.parse(cfg.offen![b]!.at)).slice(0, keys.length - 2000)) delete cfg.offen[k];
  }

  private offenVergessen(cfg: EmailMusterConfig, email: string): void {
    if (cfg.offen?.[email]) delete cfg.offen[email];
  }
}
