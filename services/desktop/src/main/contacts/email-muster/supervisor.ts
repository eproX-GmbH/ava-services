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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { domainVon, erkenneMuster, type MusterBeleg } from "./pattern";
import { firmenDomain } from "./domain";
import { beurteileMuster, bildeAdresseAllgemein, ordneFirmenadressen, type Urteil, type Zuordnung } from "./zuordnung";
import { VERLAUF_MAX, type EmailMusterConfig, type VerlaufEintrag, type Vorschau } from "../../../shared/email-muster-types";
export type { EmailMusterConfig, Vorschau } from "../../../shared/email-muster-types";
import { pruefeAdressen, pruefePort25, zufallsAdresse, type PruefErgebnis } from "./smtp-verify";

const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 5 * 60_000;
const NETZ_RECHECK_MS = 6 * 3600_000;
const DOMAIN_RECHECK_MS = 30 * 86_400_000;
const CATCHALL_RECHECK_MS = 90 * 86_400_000;
const TAGES_DECKEL = 50;
const MAX_JE_FIRMA = 10;
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

interface PersonInfo {
  personId: string;
  fullName: string;
  title?: string | null;
  /** Belastbare Adressen (gefunden, verifiziert, zugeordnet, Catch-all). */
  emails: string[];
  /** Stufe 2: unverifizierte/abgelehnte Ableitungen — kein Beleg, nachpruefbar. */
  offeneEmails: string[];
}

interface FirmenKontakte {
  name: string;
  websiteUrl: string | null;
  personen: PersonInfo[];
  /** Firmenweite E-Mail-Adressen (COMPANY-Fakten). */
  firmenEmails: string[];
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
    const r = await this.deps.gatewayRequest<{
      companyName?: string | null;
      websiteUrl?: string | null;
      companyFacts?: Array<Record<string, unknown>>;
      companyObservations?: Array<Record<string, unknown>>;
      employments?: Array<Record<string, unknown>>;
    }>(`/v1/companies/${encodeURIComponent(companyId)}/contacts`);
    // Quelle je Beobachtung: unverifizierte Ableitungen sind keine Belege.
    const quelle = new Map<string, string>();
    for (const o of r.companyObservations ?? []) if (typeof o.id === "string" && typeof o.source === "string") quelle.set(o.id, o.source);
    const istOffen = (f: Record<string, unknown>): boolean => /^(pattern|zuordnung):(offen|abgelehnt)$/.test(quelle.get(String(f.lastObsId ?? "")) ?? "");
    const byPerson = new Map<string, PersonInfo>();
    const inFirma = new Set((r.employments ?? []).map((e) => String(e.personId ?? "")).filter(Boolean));
    const firmenEmails = new Set<string>();
    for (const f of r.companyFacts ?? []) {
      if (f.status !== "ACTIVE") continue;
      if (f.entityType === "COMPANY") {
        if (f.field === "email" && typeof f.value === "string" && f.value.includes("@")) firmenEmails.add(f.value.toLowerCase().trim());
        continue;
      }
      if (f.entityType !== "PERSON") continue;
      const pid = String(f.personId ?? f.entityId ?? "");
      if (!pid || (inFirma.size > 0 && !inFirma.has(pid))) continue;
      const p = byPerson.get(pid) ?? { personId: pid, fullName: "", emails: [], offeneEmails: [] };
      if (f.field === "fullName" && typeof f.value === "string" && !p.fullName) p.fullName = f.value;
      if (f.field === "jobTitle" && typeof f.value === "string" && !p.title) p.title = f.value;
      if (f.field === "email" && typeof f.value === "string") (istOffen(f) ? p.offeneEmails : p.emails).push(f.value.toLowerCase());
      byPerson.set(pid, p);
    }
    return {
      name: (r.companyName as string | null) ?? companyId,
      websiteUrl: (r.websiteUrl as string | null) ?? null,
      personen: [...byPerson.values()].filter((p) => p.fullName),
      firmenEmails: [...firmenEmails],
    };
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
    const { personen, firmenEmails } = k;
    const name = k.name;
    if (personen.length === 0) return null;
    const fd = await this.firmenDomainVon(k, true);
    if (!fd) return null;
    const domain = fd.domain;
    const domainQuelle = fd.quelle;
    const netzOk = cfg.netz?.erreichbar === true;
    const ungeprueft = cfg.ungeprueftAnzeigen !== false;
    const jetzt = () => new Date().toISOString();
    const derived = (body: Record<string, unknown>) => this.deps.gatewayRequest(`/v1/companies/${encodeURIComponent(companyId)}/contacts/derived-email`, { method: "POST", body });

    // Personen ohne belastbare Adresse; "offene" Ableitungen zaehlen als nachpruefbar.
    const ohne = personen.filter((p) => p.emails.length === 0);
    const nachpruefbar = ohne.filter((p) => p.offeneEmails.length > 0 && netzOk && p.offeneEmails.some((e) => this.offenFaellig(cfg, e)));
    const unversorgt = ohne.filter((p) => p.offeneEmails.length === 0);
    if (unversorgt.length === 0 && nachpruefbar.length === 0) return null;

    // ---- E1 Zuordnung: Firmenadressen mit Namen → Person -----------------------
    let zugeordnet = 0;
    const zuordnungen: Zuordnung[] = [];
    if (cfg.zuordnungAktiv !== false && unversorgt.length > 0) {
      const kandidatenAdressen = firmenEmails.filter((e) => domainVon(e) === domain);
      if (kandidatenAdressen.length > 0) {
        const z = await ordneFirmenadressen({ firmenEmails: kandidatenAdressen, personen: unversorgt, firmenname: name, urteil: this.deps.urteil ?? null });
        zuordnungen.push(...z.zuordnungen);
      }
    }
    for (const z of zuordnungen) {
      const p = unversorgt.find((x) => x.personId === z.personId)!;
      const r = netzOk ? (await pruefeAdressen(domain, [z.email], { catchAllProbe: zufallsAdresse(domain), log: this.deps.log })).get(z.email) : undefined;
      if (netzOk) {
        cfg.tag.count++;
        cfg.stats.geprueft++;
      }
      const e: PruefErgebnis = r?.ergebnis ?? "unbekannt";
      const art = e === "existiert" ? "smtp" : e === "catch_all" ? "catchall" : e === "existiert_nicht" ? "abgelehnt" : "offen";
      const eintrag: VerlaufEintrag = { at: jetzt(), companyId, firma: name, domain, personId: p.personId, fullName: p.fullName, email: z.email, muster: "zuordnung", ergebnis: "zugeordnet", gespeichert: false, baseline: z.email, smtpCode: r?.code ?? undefined, mx: r?.mx ?? null };
      if (art === "abgelehnt") {
        // Eine Firmenadresse, die der Server ablehnt, ist ein Widerspruch — nicht zuordnen.
        this.merke(cfg, { ...eintrag, ergebnis: "abgelehnt" });
        continue;
      }
      try {
        await derived({ personId: p.personId, email: z.email, muster: "zuordnung", beleg: z.email, baseline: z.email, herkunft: "zuordnung", art, domainQuelle, hinweis: z.begruendung.slice(0, 300), mx: r?.mx ?? null, checkedAt: eintrag.at, smtpCode: r?.code ?? undefined });
        eintrag.gespeichert = true;
        zugeordnet++;
        cfg.stats.zugeordnet = (cfg.stats.zugeordnet ?? 0) + 1;
        p.emails.push(z.email);
        if (art === "offen") this.offenMerken(cfg, z.email);
      } catch (err) {
        eintrag.fehler = `Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`;
        this.deps.log(`[email-muster] zuordnung fehlgeschlagen ${z.email}: ${eintrag.fehler}`);
      }
      this.merke(cfg, eintrag);
    }

    // ---- Muster bestimmen (Katalog, Server, KI-Urteil) ------------------------
    const belege: MusterBeleg[] = personen.flatMap((p) => p.emails.map((email) => ({ fullName: p.fullName, email })));
    const stand = cfg.domains[domain];
    const belegeAnzahl = belege.filter((b) => domainVon(b.email) === domain).length;
    const restOhne = personen.filter((p) => p.emails.length === 0);
    if (stand && !manuell && restOhne.length > 0) {
      const alter = Date.now() - Date.parse(stand.at);
      const frist = stand.catchAll ? CATCHALL_RECHECK_MS : DOMAIN_RECHECK_MS;
      // Regel (Operator 2026-09-10): erneut nur, wenn die Frist ablief ODER neue
      // Belege auftauchten. Stufe 2: solange Personen unversorgt sind oder offene
      // Adressen nachpruefbar, bleibt die Domain "offen" (kein Warten).
      const bleibtOffen = (!!stand.muster && (unversorgt.length > 0 || nachpruefbar.length > 0)) || stand.offen === true;
      if (alter < frist && stand.belege === belegeAnzahl && !bleibtOffen) return zugeordnet > 0 ? `${name}: ${zugeordnet} Firmenadresse(n) Personen zugeordnet` : null;
    }
    const befund = erkenneMuster(domain, belege);
    let server: { muster: string | null; konfidenz: number; catchAllAt: string | null } | null = null;
    try {
      server = await this.deps.gatewayRequest<{ muster: string | null; konfidenz: number; catchAllAt: string | null }>(`/v1/email-patterns/${encodeURIComponent(domain)}`);
    } catch {
      server = null;
    }
    const catchAllBekannt = !!server?.catchAllAt && Date.now() - Date.parse(server.catchAllAt) < CATCHALL_RECHECK_MS && !manuell;
    let muster = befund.muster ?? server?.muster ?? null;
    let musterQuelle: "katalog" | "judge" = "katalog";
    let baseline = befund.belege[0]?.email ?? belege.find((b) => domainVon(b.email) === domain)?.email ?? null;
    // E2: Kein (eindeutiges) Katalogmuster, aber Belege → KI-Urteil mit Reproduktionspruefung.
    const musterBelege = belege.filter((b) => domainVon(b.email) === domain);
    if (this.deps.urteil && musterBelege.length > 0 && (!muster || (befund.belege.length <= 1 && befund.alternativen.length > 1))) {
      const u = await beurteileMuster({ domain, belege: musterBelege, alternativen: befund.alternativen, urteil: this.deps.urteil });
      if (u) {
        muster = u.muster;
        musterQuelle = "judge";
        baseline = u.baseline;
        this.deps.log(`[email-muster] ${name} (${domain}): Muster per Urteil ${u.muster} (${u.begruendung})`);
      }
    }
    if (!muster || !baseline) {
      const anzahl = befund.belege.length + befund.unerklaert.length;
      const grund =
        anzahl === 0
          ? `keine personengebundene Adresse als Beleg (${befund.funktionsadressen.length} Funktionsadressen, z. B. ${befund.funktionsadressen[0] ?? "–"})`
          : `${anzahl} personengebundene Belege passen zu keinem gemeinsamen Muster (z. B. ${befund.unerklaert
              .slice(0, 3)
              .map((u) => `${u.fullName} → ${u.email}`)
              .join("; ")})`;
      cfg.domains[domain] = { at: jetzt(), muster: null, belege: belegeAnzahl, catchAll: false, grund };
      return zugeordnet > 0 ? `${name}: ${zugeordnet} Firmenadresse(n) Personen zugeordnet, kein Adressmuster erkennbar` : null;
    }
    const musterKonfidenz = musterQuelle === "judge" ? Math.max(0.5, befund.konfidenz) : befund.konfidenz;
    if ((befund.muster && (befund.muster !== server?.muster || befund.konfidenz > (server?.konfidenz ?? 0))) || (musterQuelle === "judge" && muster !== server?.muster)) {
      await this.deps.gatewayRequest(`/v1/email-patterns/${encodeURIComponent(domain)}`, { method: "PUT", body: { muster, konfidenz: musterKonfidenz, belege: musterBelege.slice(0, 20), stats: { firma: companyId, quelle: musterQuelle } } }).catch(() => undefined);
    }

    // ---- E3 Kandidaten: unversorgte Personen + faellige Nachpruefungen ----------
    const kandidaten = [
      ...restOhne.filter((p) => p.offeneEmails.length === 0).map((p) => ({ personId: p.personId, fullName: p.fullName, email: bildeAdresseAllgemein(muster!, p.fullName, domain) ?? "", nachpruefung: false })),
      ...(netzOk ? nachpruefbar.map((p) => ({ personId: p.personId, fullName: p.fullName, email: p.offeneEmails.find((e) => this.offenFaellig(cfg, e)) ?? "", nachpruefung: true })) : []),
    ]
      .filter((k) => k.email)
      .slice(0, MAX_JE_FIRMA);
    const rest = restOhne.filter((p) => p.offeneEmails.length === 0).length - kandidaten.filter((k) => !k.nachpruefung).length;
    if (kandidaten.length === 0) {
      cfg.domains[domain] = { at: jetzt(), muster, belege: belegeAnzahl, catchAll: stand?.catchAll ?? false, offen: false };
      return zugeordnet > 0 ? `${name}: ${zugeordnet} Firmenadresse(n) Personen zugeordnet` : null;
    }
    cfg.stats.firmen++;
    this.deps.log(`[email-muster] ${name} (${domain}): Muster ${muster}, ${kandidaten.length} Kandidaten${catchAllBekannt ? " (Catch-all bekannt)" : ""}${netzOk ? "" : " (ohne Mail-Pruefung)"}`);
    const ergebnisse = catchAllBekannt
      ? new Map(kandidaten.map((k) => [k.email, { ergebnis: "catch_all" as PruefErgebnis, mx: null, code: null, antwort: null, dauerMs: 0 }]))
      : netzOk
        ? await pruefeAdressen(domain, kandidaten.map((k) => k.email), { catchAllProbe: zufallsAdresse(domain), log: this.deps.log })
        : new Map();
    let verifiziert = 0, abgelehnt = 0, unbekannt = 0, unbestaetigt = 0, catchAll = false, gesperrt = false;
    for (const k of kandidaten) {
      const r = ergebnisse.get(k.email);
      let e: PruefErgebnis = r?.ergebnis ?? (netzOk && !gesperrt ? "unbekannt" : "gesperrt");
      if (gesperrt) e = "gesperrt";
      if (netzOk && !gesperrt && !catchAllBekannt) {
        cfg.tag.count++;
        cfg.stats.geprueft++;
      }
      if (e === "gesperrt") gesperrt = true;
      const eintrag: VerlaufEintrag = { at: jetzt(), companyId, firma: name, domain, personId: k.personId, fullName: k.fullName, email: k.email, muster, ergebnis: "unklar", gespeichert: false, baseline, smtpCode: r?.code ?? undefined, mx: r?.mx ?? null };
      const art = e === "existiert" ? "smtp" : e === "catch_all" ? "catchall" : e === "existiert_nicht" ? "abgelehnt" : "offen";
      eintrag.ergebnis = e === "existiert" ? "verifiziert" : e === "catch_all" ? "catch_all" : e === "existiert_nicht" ? "abgelehnt" : e === "gesperrt" ? "gesperrt" : "unklar";
      if (e === "catch_all") catchAll = true;
      // Speichern: smtp/catchall immer; offen/abgelehnt nur mit Freigabe (Standard an).
      // Nachpruefung ohne neues Ergebnis (offen bleibt offen) wird nicht erneut gespeichert.
      const speichern = art === "smtp" || art === "catchall" || (ungeprueft && !(k.nachpruefung && art === "offen"));
      if (speichern) {
        try {
          await derived({
            personId: k.personId,
            email: k.email,
            muster,
            beleg: baseline,
            baseline,
            musterQuelle,
            herkunft: "muster",
            art,
            domainQuelle,
            belegAnzahl: musterBelege.length,
            mx: r?.mx ?? null,
            checkedAt: eintrag.at,
            smtpCode: r?.code ?? undefined,
            ...(art === "offen" ? { hinweis: e === "gesperrt" ? "Mail-Pruefung in diesem Netz nicht moeglich" : "Mailserver ohne eindeutige Antwort" } : {}),
          });
          eintrag.gespeichert = true;
        } catch (err) {
          eintrag.fehler = `Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`;
          this.deps.log(`[email-muster] speichern fehlgeschlagen ${k.email}: ${eintrag.fehler}`);
        }
      }
      if (art === "smtp") {
        verifiziert++;
        cfg.stats.verifiziert++;
        this.offenVergessen(cfg, k.email);
      } else if (art === "catchall") {
        unbestaetigt++;
        cfg.stats.unbestaetigt++;
        this.offenVergessen(cfg, k.email);
      } else if (art === "abgelehnt") {
        abgelehnt++;
        cfg.stats.abgelehnt++;
        this.offenVergessen(cfg, k.email);
      } else {
        unbekannt++;
        cfg.stats.unbekannt++;
        if (eintrag.gespeichert || k.nachpruefung) this.offenMerken(cfg, k.email);
      }
      this.merke(cfg, eintrag);
    }
    if (gesperrt && netzOk) cfg.netz = { erreichbar: false, grund: "Verbindung zum Mailserver nicht moeglich", at: jetzt() };
    if (catchAll && !catchAllBekannt) {
      cfg.stats.catchAll++;
      await this.deps.gatewayRequest(`/v1/email-patterns/${encodeURIComponent(domain)}`, { method: "PUT", body: { muster, konfidenz: musterKonfidenz, belege: musterBelege.slice(0, 20), catchAll: true } }).catch(() => undefined);
    }
    cfg.domains[domain] = { at: jetzt(), muster, belege: belegeAnzahl, catchAll, offen: rest > 0 };
    const teile = [
      zugeordnet > 0 ? `${zugeordnet} Firmenadresse(n) zugeordnet` : "",
      verifiziert > 0 ? `${verifiziert} verifiziert` : "",
      unbestaetigt > 0 ? `${unbestaetigt} unbestaetigt (Catch-all)` : "",
      unbekannt > 0 ? `${unbekannt} unverifiziert${netzOk ? "" : " (Mail-Pruefung in diesem Netz nicht moeglich)"}` : "",
      abgelehnt > 0 ? `${abgelehnt} vom Server abgelehnt` : "",
      rest > 0 ? `${rest} weitere folgen` : "",
    ].filter(Boolean);
    const zusammenfassung = `${name}: ${teile.join(", ")} (Muster ${muster}${musterQuelle === "judge" ? " per KI-Urteil" : ""}, Baseline ${baseline})`;
    this.deps.audit({ summary: `E-Mail-Ableitung — ${zusammenfassung}`, severity: "info", metadata: { companyId, domain, muster, musterQuelle, baseline, zugeordnet, verifiziert, unbestaetigt, abgelehnt, unbekannt, catchAll, rest } });
    return zusammenfassung;
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
