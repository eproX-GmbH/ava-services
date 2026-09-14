// v0.1.646 (docs/PLAN_CHAT_VORSCHLAEGE.md, V1) — Nutzerstand aus den Stores.
// Deterministisch, ohne LLM, mit 60-s-Cache. Netzabrufe nur best-effort
// (Firmenzahl aus der Gateway-Matrix, Name des Top-Radar-Treffers).

import type { Nutzerstand, Verbindung } from "../../shared/nutzerstand-types";

export interface NutzerstandDeps {
  angemeldet: () => boolean;
  gatewayRequest: <T>(path: string) => Promise<T>;
  mailVerbunden: () => Promise<boolean>;
  telegramVerbunden: () => boolean;
  crmStatus: () => Array<{ provider: string; connected: boolean }>;
  knowledgeStatus: () => Array<{ kind: string; connected: boolean }>;
  linkedinAktiv: () => boolean;
  icp: () => { gesetzt: boolean; vollstaendig: boolean };
  radarConfig: () => { enabled: boolean; lastRunAt: string | null };
  matches: () => Record<string, { score: number }>;
  workflows: () => Array<{ lastRun?: { startedAt: string } | null }>;
  skillsEigene: () => number;
  watchlistAnzahl: () => Promise<number>;
  emailAbleitungAktiv: () => boolean;
  modell: () => { ready: boolean; kind: string | null; model: string | null; sStufe: boolean };
  tier: () => string | null;
  featureAn: (key: string) => boolean;
  featureKeys: () => string[];
  organisation: () => boolean;
}

const CACHE_MS = 60_000;
const HOT_SCORE = 70;

export class NutzerstandService {
  private cache: { at: number; wert: Nutzerstand } | null = null;
  private readonly topName = new Map<string, string | null>();

  constructor(private readonly deps: NutzerstandDeps) {}

  invalidate(): void {
    this.cache = null;
  }

  async get(opts: { frisch?: boolean } = {}): Promise<Nutzerstand> {
    if (!opts.frisch && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.wert;
    const wert = await this.build();
    this.cache = { at: Date.now(), wert };
    return wert;
  }

  private verbindung(feature: string | null, verbunden: boolean): Verbindung {
    if (feature && !this.deps.featureAn(feature)) return "gesperrt";
    return verbunden ? "verbunden" : "offen";
  }

  private async build(): Promise<Nutzerstand> {
    const d = this.deps;
    const angemeldet = d.angemeldet();
    const gesperrteModule = d.featureKeys().filter((k) => !d.featureAn(k));
    const crm = d.crmStatus();
    const wissen = d.knowledgeStatus();
    const icp = d.icp();
    const rc = d.radarConfig();
    const matches = Object.entries(d.matches());
    const top = [...matches].sort((a, b) => b[1].score - a[1].score)[0] ?? null;
    const wfs = d.workflows();
    const modell = d.modell();
    const tierRaw = d.tier();
    const plan = tierRaw === "free" || tierRaw === "starter" || tierRaw === "pro" || tierRaw === "enterprise" ? tierRaw : "unbekannt";

    let mail = false;
    try {
      mail = await d.mailVerbunden();
    } catch {
      /* best-effort */
    }
    let watchlist = 0;
    try {
      watchlist = await d.watchlistAnzahl();
    } catch {
      /* best-effort */
    }
    let importiert: number | null = null;
    if (angemeldet) {
      try {
        const r = await d.gatewayRequest<{ count?: number }>("/v1/companies/matrix?pageNumber=1&pageSize=1");
        importiert = typeof r.count === "number" ? r.count : null;
      } catch {
        importiert = null;
      }
    }
    let topTreffer: Nutzerstand["radar"]["topTreffer"] = null;
    if (top && top[1].score >= HOT_SCORE) {
      const [discoveryId, e] = top;
      let name = this.topName.get(discoveryId) ?? null;
      if (!this.topName.has(discoveryId) && angemeldet) {
        try {
          const r = await d.gatewayRequest<{ candidates: Array<{ discoveryId: string; name: string }> }>("/v1/discovery/candidates?limit=200");
          name = r.candidates.find((c) => c.discoveryId === discoveryId)?.name ?? null;
        } catch {
          name = null;
        }
        this.topName.set(discoveryId, name);
      }
      topTreffer = { discoveryId, score: e.score, name };
    }
    const letzterWfLauf = wfs.map((w) => w.lastRun?.startedAt ?? null).filter((x): x is string => !!x).sort().at(-1) ?? null;

    return {
      erzeugtAt: new Date().toISOString(),
      angemeldet,
      verbindungen: {
        mail: this.verbindung("mail", mail),
        telegram: this.verbindung("telegram", d.telegramVerbunden()),
        hubspot: this.verbindung(null, crm.some((c) => c.provider === "hubspot" && c.connected)),
        notion: this.verbindung(null, wissen.some((w) => w.kind === "notion" && w.connected)),
        obsidian: this.verbindung(null, wissen.some((w) => w.kind === "obsidian" && w.connected)),
        linkedin: this.verbindung("linkedin.beobachter", d.linkedinAktiv()),
      },
      icp: !icp.gesetzt ? "fehlt" : icp.vollstaendig ? "vollstaendig" : "unvollstaendig",
      radar: {
        automatik: rc.enabled,
        bewertet: matches.length,
        heisseTreffer: matches.filter(([, e]) => e.score >= HOT_SCORE).length,
        topTreffer,
        letzterLaufAt: rc.lastRunAt,
      },
      firmen: { importiert },
      workflows: { anzahl: wfs.length, letzterLaufAt: letzterWfLauf },
      skills: { eigene: d.skillsEigene() },
      watchlist: { personen: watchlist },
      emailAbleitung: { aktiv: d.emailAbleitungAktiv() },
      modell: { bereit: modell.ready, anbieter: modell.kind, modell: modell.model, sStufe: modell.sStufe },
      plan,
      organisation: { mitglied: d.organisation() },
      gesperrteModule,
    };
  }
}

/** Kompakte Textform fuer den Prompt (rund 120 Token). */
export function nutzerstandText(s: Nutzerstand): string {
  const v = s.verbindungen;
  const verb = (Object.keys(v) as Array<keyof typeof v>).map((k) => `${k}=${v[k]}`).join(", ");
  const zeilen = [
    `Verbindungen: ${verb}`,
    `ICP: ${s.icp}`,
    `Radar: Automatik ${s.radar.automatik ? "an" : "aus"}, ${s.radar.bewertet} bewertet, ${s.radar.heisseTreffer} heisse Treffer${s.radar.topTreffer?.name ? `, Top: ${s.radar.topTreffer.name} (${s.radar.topTreffer.score})` : ""}`,
    `Firmen importiert: ${s.firmen.importiert ?? "unbekannt"}`,
    `Workflows: ${s.workflows.anzahl}${s.workflows.letzterLaufAt ? `, zuletzt ${s.workflows.letzterLaufAt.slice(0, 10)}` : ""}`,
    `Skills eigene: ${s.skills.eigene}; Watchlist: ${s.watchlist.personen}; E-Mail-Ableitung: ${s.emailAbleitung.aktiv ? "an" : "aus"}`,
    `Modell: ${s.modell.bereit ? `${s.modell.anbieter}/${s.modell.modell}${s.modell.sStufe ? " (S-Stufe)" : ""}` : "keins bereit"}; Plan: ${s.plan}; Organisation: ${s.organisation.mitglied ? "ja" : "nein"}`,
  ];
  if (s.gesperrteModule.length > 0) zeilen.push(`Gesperrt: ${s.gesperrteModule.join(", ")}`);
  return zeilen.join("\n");
}
