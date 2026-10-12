// E-Mail-Ableitung im Desktop (docs/PLAN_EMAIL_VERIFIZIERUNG.md, §8 Stand 2026-10-12):
// die eigentliche Ableitung und Verifizierung laeuft im Producer company-email
// als Pipeline-Stufe „E-Mail“ je Firma; einen Hintergrund-Job (Nachzuegler,
// 15-Minuten-Takt, Tages-Deckel) gibt es seit 2026-10-12 nicht mehr. Hier
// bleiben nur:
//
//   - die Schalter der Person (email-muster.json; der Producer liest die Datei
//     bei jedem Trigger frisch, AVA_EMAIL_MUSTER_CONFIG),
//   - die Vorschau (Trockenlauf ohne Netz) fuer Chat und Einstellungen,
//   - die Pruefung frei gewaehlter Funktionsadressen (rechnung@, bewerbung@).
//
// Fehlgeschlagene Stufen stoesst die App ueber den Retry-Mechanismus der
// Pipeline selbst wieder an; wer es sofort will, nimmt „neu verarbeiten“.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { domainVon, erkenneMuster, type MusterBeleg } from "./pattern";
import { firmenDomain } from "./domain";
import { bildeAdresseAllgemein, ordneFirmenadressen, type Urteil } from "./zuordnung";
import type { EmailMusterConfig, Vorschau } from "../../../shared/email-muster-types";
export type { EmailMusterConfig, Vorschau } from "../../../shared/email-muster-types";
import { pruefeAdressen, zufallsAdresse, type PruefErgebnis } from "./smtp-verify";
import { pruefungenJeStunde } from "../../../../../../packages/email-muster/src/takt";
import { kontakteAusAntwort, type FirmenKontakte, type KontakteAntwort, type PersonInfo } from "./kontakte";

const DEFAULT: EmailMusterConfig = { enabled: true, zuordnungAktiv: true, ungeprueftAnzeigen: true, pruefungenJeStunde: pruefungenJeStunde(undefined) };

export interface EmailMusterDeps {
  gatewayRequest: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  log: (msg: string) => void;
  onChanged?: (cfg: EmailMusterConfig) => void;
  /** KI-Urteil (Hintergrund-Kanal) fuer die Firmendomain; null = ohne Urteil. */
  urteil?: Urteil | null;
}

export class EmailMusterDienst {
  private cfg: EmailMusterConfig | null = null;
  private readonly path: string;

  constructor(private readonly deps: EmailMusterDeps, dir: string) {
    this.path = join(dir, "email-muster.json");
  }

  getConfig(): EmailMusterConfig {
    if (this.cfg) return this.cfg;
    try {
      // Aeltere Dateien tragen noch Verlauf/Statistik des frueheren Hintergrund-Jobs; nur die Schalter zaehlen.
      const raw = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Partial<EmailMusterConfig>) : {};
      this.cfg = { enabled: raw.enabled !== false, zuordnungAktiv: raw.zuordnungAktiv !== false, ungeprueftAnzeigen: raw.ungeprueftAnzeigen !== false, pruefungenJeStunde: pruefungenJeStunde(raw.pruefungenJeStunde) };
    } catch {
      this.cfg = { ...DEFAULT };
    }
    return this.cfg;
  }

  setConfig(patch: Partial<EmailMusterConfig>): EmailMusterConfig {
    const next = { ...this.getConfig(), ...patch };
    if (patch.pruefungenJeStunde !== undefined) next.pruefungenJeStunde = pruefungenJeStunde(patch.pruefungenJeStunde);
    this.cfg = next;
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify(next, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
    this.deps.onChanged?.(next);
    return next;
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

  /** Domain der Firma (domain.ts): Website, Firmenadresse oder bestaetigter Alias; nie die Adresse einer anderen Firma. */
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
      hinweis: befund.muster ? null : befund.unerklaert.length > 0 ? "Kein eindeutiges Muster (Belege widersprechen sich); der Producer fragt beim Lauf ein KI-Urteil." : "Keine personengebundene E-Mail als Beleg vorhanden.",
    };
  }
}
