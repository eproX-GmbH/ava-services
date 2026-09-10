// M4 (docs/PLAN_EMAIL_MUSTER.md) — Hintergrund-Job "im Hinterkopf": alle
// 15 Minuten EINE Firma des Nutzers pruefen, ob sich aus bekannten
// Personen-E-Mails das Adressmuster ableiten und fuer Kontakte ohne Adresse
// per SMTP verifizieren laesst. Laeuft lokal, pausiert bei Chat-Turns und im
// Akkubetrieb, respektiert Port-25-Sperren (Mail-Pruefung nicht moeglich).
// Der Server speichert nur (EmailPattern, derived-email).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bildeAdresse, domainVon, erkenneMuster, type MusterBeleg } from "./pattern";
import { VERLAUF_MAX, type EmailMusterConfig, type VerlaufEintrag, type Vorschau } from "../../../shared/email-muster-types";
export type { EmailMusterConfig, Vorschau } from "../../../shared/email-muster-types";
import { pruefeAdressen, pruefePort25, zufallsAdresse, type PruefErgebnis } from "./smtp-verify";

const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 5 * 60_000;
const NETZ_RECHECK_MS = 6 * 3600_000;
const DOMAIN_RECHECK_MS = 30 * 86_400_000;
const CATCHALL_RECHECK_MS = 90 * 86_400_000;
const TAGES_DECKEL = 50;
const MAX_JE_FIRMA = 5;
const MAX_FIRMEN_JE_TICK = 25;

const DEFAULT: EmailMusterConfig = {
  enabled: true,
  lastRunAt: null,
  lastOutcome: null,
  netz: null,
  tag: { day: "", count: 0 },
  domains: {},
  stats: { firmen: 0, geprueft: 0, verifiziert: 0, abgelehnt: 0, unbekannt: 0, catchAll: 0 },
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
}

interface PersonInfo {
  personId: string;
  fullName: string;
  emails: string[];
}

export class EmailMusterSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cfg: EmailMusterConfig | null = null;
  private readonly path: string;

  constructor(private readonly deps: EmailMusterDeps, dir: string) {
    this.path = join(dir, "email-muster.json");
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
      this.cfg = { ...DEFAULT, ...raw, tag: raw.tag ?? DEFAULT.tag, domains: raw.domains ?? {}, stats: { ...DEFAULT.stats, ...(raw.stats ?? {}) }, verlauf: Array.isArray(raw.verlauf) ? raw.verlauf : [] };
    } catch {
      this.cfg = { ...DEFAULT };
    }
    return this.cfg;
  }

  setConfig(patch: Partial<Pick<EmailMusterConfig, "enabled">>): EmailMusterConfig {
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

  private async kontakte(companyId: string): Promise<{ websiteUrl: string | null; personen: PersonInfo[] }> {
    const r = await this.deps.gatewayRequest<{ websiteUrl?: string | null; companyFacts?: Array<Record<string, unknown>>; employments?: Array<Record<string, unknown>> }>(
      `/v1/companies/${encodeURIComponent(companyId)}/contacts`,
    );
    const byPerson = new Map<string, PersonInfo>();
    const inFirma = new Set((r.employments ?? []).map((e) => String(e.personId ?? "")).filter(Boolean));
    for (const f of r.companyFacts ?? []) {
      if (f.entityType !== "PERSON" || f.status !== "ACTIVE") continue;
      const pid = String(f.personId ?? f.entityId ?? "");
      if (!pid || (inFirma.size > 0 && !inFirma.has(pid))) continue;
      const p = byPerson.get(pid) ?? { personId: pid, fullName: "", emails: [] };
      if (f.field === "fullName" && typeof f.value === "string" && !p.fullName) p.fullName = f.value;
      if (f.field === "email" && typeof f.value === "string") p.emails.push(f.value.toLowerCase());
      byPerson.set(pid, p);
    }
    return { websiteUrl: (r.websiteUrl as string | null) ?? null, personen: [...byPerson.values()].filter((p) => p.fullName) };
  }

  private domainAus(websiteUrl: string | null, personen: PersonInfo[]): string | null {
    let web: string | null = null;
    if (websiteUrl) {
      try {
        web = new URL(websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        web = null;
      }
    }
    const zaehler = new Map<string, number>();
    for (const p of personen) for (const e of p.emails) zaehler.set(domainVon(e), (zaehler.get(domainVon(e)) ?? 0) + 1);
    const haeufigste = [...zaehler.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (web && (zaehler.has(web) || !haeufigste)) return web;
    return haeufigste ?? web;
  }

  /** Trockenlauf ohne Netzverkehr (Chat-Tool, Einstellungen). */
  async vorschau(companyId: string): Promise<Vorschau> {
    const { websiteUrl, personen } = await this.kontakte(companyId);
    const domain = this.domainAus(websiteUrl, personen);
    if (!domain) return { companyId, domain: null, befund: null, kandidaten: [], personenMitMail: 0, personenOhneMail: personen.length, hinweis: "Keine Domain bekannt (weder Website noch E-Mails)." };
    const belege: MusterBeleg[] = personen.flatMap((p) => p.emails.map((email) => ({ fullName: p.fullName, email })));
    const befund = erkenneMuster(domain, belege);
    const ohne = personen.filter((p) => p.emails.length === 0);
    const kandidaten = befund.muster
      ? ohne.map((p) => ({ personId: p.personId, fullName: p.fullName, email: bildeAdresse(befund.muster!, p.fullName, domain) ?? "" })).filter((k) => k.email)
      : [];
    return {
      companyId,
      domain,
      befund,
      kandidaten,
      personenMitMail: personen.length - ohne.length,
      personenOhneMail: ohne.length,
      hinweis: befund.muster ? null : befund.unerklaert.length > 0 ? "Kein eindeutiges Muster (Belege widersprechen sich)." : "Keine personengebundene E-Mail als Beleg vorhanden.",
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
    if (cfg.tag.count >= TAGES_DECKEL && !manuell) return `Tages-Deckel (${TAGES_DECKEL}) erreicht`;
    this.running = true;
    let outcome = "nichts zu tun";
    try {
      // Netz: Port 25 erreichbar?
      if (!cfg.netz || Date.now() - Date.parse(cfg.netz.at) > NETZ_RECHECK_MS || manuell) {
        const n = await pruefePort25();
        cfg.netz = { ...n, at: new Date().toISOString() };
        this.persist();
      }
      if (!cfg.netz.erreichbar) {
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
        const ergebnis = await this.pruefeFirma(firma.companyId, firma.name ?? firma.companyId, cfg, manuell);
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
  private async pruefeFirma(companyId: string, name: string, cfg: EmailMusterConfig, manuell: boolean): Promise<string | null> {
    const { websiteUrl, personen } = await this.kontakte(companyId);
    if (personen.length === 0) return null;
    const domain = this.domainAus(websiteUrl, personen);
    if (!domain) return null;
    const ohne = personen.filter((p) => p.emails.length === 0);
    if (ohne.length === 0) return null;
    const belege: MusterBeleg[] = personen.flatMap((p) => p.emails.map((email) => ({ fullName: p.fullName, email })));
    const stand = cfg.domains[domain];
    const belegeAnzahl = belege.filter((b) => domainVon(b.email) === domain).length;
    if (stand && !manuell) {
      const alter = Date.now() - Date.parse(stand.at);
      const frist = stand.catchAll ? CATCHALL_RECHECK_MS : DOMAIN_RECHECK_MS;
      // Regel (Operator 2026-09-10): erneut nur, wenn die Frist ablief ODER neue
      // Belege auftauchten (moeglicher Formatwechsel der Firma).
      if (alter < frist && stand.belege === belegeAnzahl) return null;
    }
    const befund = erkenneMuster(domain, belege);
    // Geteilten Serverstand einbeziehen: Muster/Catch-all anderer Nutzer.
    let server: { muster: string | null; konfidenz: number; catchAllAt: string | null } | null = null;
    try {
      server = await this.deps.gatewayRequest<{ muster: string | null; konfidenz: number; catchAllAt: string | null }>(`/v1/email-patterns/${encodeURIComponent(domain)}`);
    } catch {
      server = null;
    }
    if (server?.catchAllAt && Date.now() - Date.parse(server.catchAllAt) < CATCHALL_RECHECK_MS && !manuell) {
      cfg.domains[domain] = { at: new Date().toISOString(), muster: server.muster, belege: belegeAnzahl, catchAll: true };
      return null;
    }
    const muster = befund.muster ?? server?.muster ?? null;
    if (!muster) {
      cfg.domains[domain] = { at: new Date().toISOString(), muster: null, belege: belegeAnzahl, catchAll: false };
      return null;
    }
    if (befund.muster && (befund.muster !== server?.muster || (befund.konfidenz > (server?.konfidenz ?? 0)))) {
      await this.deps.gatewayRequest(`/v1/email-patterns/${encodeURIComponent(domain)}`, { method: "PUT", body: { muster: befund.muster, konfidenz: befund.konfidenz, belege: befund.belege.slice(0, 20), stats: { firma: companyId } } }).catch(() => undefined);
    }
    const kandidaten = ohne.map((p) => ({ personId: p.personId, fullName: p.fullName, email: bildeAdresse(muster, p.fullName, domain) ?? "" })).filter((k) => k.email).slice(0, MAX_JE_FIRMA);
    if (kandidaten.length === 0) {
      cfg.domains[domain] = { at: new Date().toISOString(), muster, belege: belegeAnzahl, catchAll: false };
      return null;
    }
    cfg.stats.firmen++;
    this.deps.log(`[email-muster] ${name} (${domain}): Muster ${muster}, ${kandidaten.length} Kandidaten`);
    const ergebnisse = await pruefeAdressen(domain, kandidaten.map((k) => k.email), { catchAllProbe: zufallsAdresse(domain), log: this.deps.log });
    let verifiziert = 0, abgelehnt = 0, unbekannt = 0, catchAll = false, gesperrt = false;
    for (const k of kandidaten) {
      const r = ergebnisse.get(k.email);
      const e: PruefErgebnis = r?.ergebnis ?? "unbekannt";
      cfg.tag.count++;
      cfg.stats.geprueft++;
      const eintrag: VerlaufEintrag = {
        at: new Date().toISOString(),
        companyId,
        firma: name,
        domain,
        personId: k.personId,
        fullName: k.fullName,
        email: k.email,
        muster,
        ergebnis: "unklar",
        gespeichert: false,
        smtpCode: r?.code ?? undefined,
        mx: r?.mx ?? null,
      };
      if (e === "catch_all") {
        catchAll = true;
        this.merke(cfg, { ...eintrag, ergebnis: "catch_all" });
        break;
      }
      if (e === "gesperrt") {
        gesperrt = true;
        this.merke(cfg, { ...eintrag, ergebnis: "gesperrt" });
        break;
      }
      if (e === "existiert") {
        eintrag.ergebnis = "verifiziert";
        try {
          await this.deps.gatewayRequest(`/v1/companies/${encodeURIComponent(companyId)}/contacts/derived-email`, {
            method: "POST",
            body: { personId: k.personId, email: k.email, muster, beleg: befund.belege[0]?.email ?? kandidaten[0]!.email, mx: r?.mx ?? null, checkedAt: eintrag.at, smtpCode: r?.code ?? undefined },
          });
          eintrag.gespeichert = true;
          verifiziert++;
          cfg.stats.verifiziert++;
        } catch (err) {
          eintrag.fehler = `Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`;
          this.deps.log(`[email-muster] speichern fehlgeschlagen ${k.email}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (e === "existiert_nicht") {
        eintrag.ergebnis = "abgelehnt";
        abgelehnt++;
        cfg.stats.abgelehnt++;
      } else {
        unbekannt++;
        cfg.stats.unbekannt++;
      }
      this.merke(cfg, eintrag);
    }
    if (gesperrt) {
      cfg.netz = { erreichbar: false, grund: "Verbindung zum Mailserver nicht moeglich", at: new Date().toISOString() };
      return "Mail-Pruefung in diesem Netz nicht moeglich (Port 25 gesperrt)";
    }
    if (catchAll) {
      cfg.stats.catchAll++;
      await this.deps.gatewayRequest(`/v1/email-patterns/${encodeURIComponent(domain)}`, { method: "PUT", body: { muster, konfidenz: befund.konfidenz, belege: befund.belege.slice(0, 20), catchAll: true } }).catch(() => undefined);
    }
    cfg.domains[domain] = { at: new Date().toISOString(), muster, belege: belegeAnzahl, catchAll };
    const zusammenfassung = catchAll
      ? `${name}: Domain ${domain} nimmt alle Adressen an (Catch-all) — keine Adresse verifizierbar`
      : `${name}: ${verifiziert} Adresse(n) abgeleitet und verifiziert, ${abgelehnt} abgelehnt, ${unbekannt} unklar (Muster ${muster})`;
    this.deps.audit({ summary: `E-Mail-Ableitung — ${zusammenfassung}`, severity: "info", metadata: { companyId, domain, muster, verifiziert, abgelehnt, unbekannt, catchAll } });
    return zusammenfassung;
  }
}
