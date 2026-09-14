// v0.1.647 (docs/PLAN_CHAT_VORSCHLAEGE.md, V2) — Chips fuer die Chat-Startseite.
//
// Ein Chip ist ein Anstoss in Nutzersprache ("HubSpot verbinden", "Firmen-
// Radar fuer meine Region starten"). Klick sendet den Auftrag als Nachricht;
// AVA plant die Tool-Kette danach selbst. Die Erzeugung laeuft ueber den
// Hintergrundkanal (guenstiges Modell, nie das Chat-Modell) und wird gecacht,
// bis sich der Nutzerstand aendert oder der Tag wechselt.
//
// Zwei Schranken gegen Erfindungen: Das Modell sieht nur die Faehigkeits-
// gruppen (weich); der Code verwirft Chips, deren Gruppe nicht verfuegbar ist
// oder die eine unbekannte/gesperrte Integration nennen (hart).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yup from "yup";
import type { LlmProviderManager } from "../agent/providers";
import { buildMessages, parseJsonObject, streamToText } from "../link-monitor/llm";
import type { Faehigkeit, Nutzerstand } from "../../shared/nutzerstand-types";
import type { Chip, StartseitenChips } from "../../shared/nutzerstand-types";
import { faehigkeitenText, verfuegbareFaehigkeiten } from "./faehigkeiten";
import { nutzerstandText } from "./nutzerstand";

const MAX_CHIPS = 4;
const MAX_CHIPS_GESPRAECH = 3;
const TIMEOUT_MS = 8_000;

/** Integrationen, die es NICHT gibt — ein Chip, der sie nennt, ist falsch. */
const UNBEKANNTE_INTEGRATIONEN = [
  "facebook", "instagram", "whatsapp", "slack", "microsoft teams", "ms teams", "salesforce", "dynamics", "pipedrive", "zoho", "salesloft",
  "outreach", "apollo", "lusha", "zoominfo", "gmail-api", "google sheets", "sharepoint", "trello", "asana", "jira", "monday", "airtable",
  "twitter", "tiktok", "youtube", "sap", "datev", "lexoffice", "sevdesk", "xing-api",
];

const chipSchema = yup.object({
  titel: yup.string().trim().min(3).max(60).required(),
  auftrag: yup.string().trim().min(5).max(220).required(),
  gruppe: yup.string().trim().required(),
  aktion: yup.string().trim().max(16).optional(),
  stufe: yup.number().integer().min(1).max(3).optional(),
});
const antwortSchema = yup.object({ chips: yup.array().of(chipSchema).max(8).required() });

export interface ErzeugungDeps {
  providers: LlmProviderManager;
  nutzerstand: () => Promise<Nutzerstand>;
  toolNamen: () => string[];
  dir: string;
  log?: (m: string) => void;
}

interface CacheDatei {
  key: string;
  at: string;
  chips: Chip[];
}

export function harteSchranke(chips: Chip[], faehigkeiten: Faehigkeit[], stand: Nutzerstand): Chip[] {
  const ids = new Set(faehigkeiten.filter((f) => !f.verwaltung).map((f) => f.id));
  const gesperrt = new Set(stand.gesperrteModule);
  const gesperrteWorte = [
    ...(gesperrt.has("mail") ? ["mail", "postfach", "e-mail-konto"] : []),
    ...(gesperrt.has("telegram") ? ["telegram"] : []),
    ...(gesperrt.has("workflows") ? ["workflow"] : []),
    ...(gesperrt.has("linkedin.beobachter") ? ["linkedin-beobachter", "linkedin verbinden"] : []),
    ...(gesperrt.has("linkedin.watchlist") ? ["watchlist"] : []),
    ...(gesperrt.has("linkedin.radar") ? ["personen-radar"] : []),
    ...(gesperrt.has("kontakte") ? ["kontakt-recherche", "e-mail-adressen ableiten"] : []),
  ];
  const erledigt: Array<[boolean, RegExp]> = [
    [stand.verbindungen.hubspot === "verbunden", /hubspot\s+verbind/i],
    [stand.verbindungen.telegram === "verbunden", /telegram\s+verbind/i],
    [stand.verbindungen.mail === "verbunden", /(postfach|mail-?konto|e-?mail)\s+verbind/i],
    [stand.verbindungen.notion === "verbunden", /notion\s+verbind/i],
    [stand.verbindungen.obsidian === "verbunden", /obsidian\s+verbind/i],
    [stand.verbindungen.linkedin === "verbunden", /linkedin(-beobachter)?\s+(verbind|aktivier)/i],
    [stand.icp === "vollstaendig", /\bicp\b.*(erstell|anleg|festleg)|idealkundenprofil.*(erstell|anleg|festleg)/i],
    [stand.radar.automatik, /radar-?automatik\s+(einschalt|aktivier)/i],
    [stand.emailAbleitung.aktiv, /e-?mail-ableitung\s+(einschalt|aktivier)/i],
  ];
  const out: Chip[] = [];
  const gesehen = new Set<string>();
  for (const c of chips) {
    const text = `${c.titel} ${c.auftrag}`.toLowerCase();
    if (!ids.has(c.gruppe)) continue;
    if (UNBEKANNTE_INTEGRATIONEN.some((w) => text.includes(w))) continue;
    if (gesperrteWorte.some((w) => text.includes(w))) continue;
    if (erledigt.some(([ist, re]) => ist && re.test(text))) continue;
    if (!stand.modell.sStufe && /workflow.*(anleg|erstell|speicher)/i.test(text)) continue;
    const k = c.titel.toLowerCase();
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    out.push(c);
    if (out.length >= MAX_CHIPS) break;
  }
  return out;
}

/** Feste Rueckfalliste (kein Modell, Fehler, Organisation hat Vorschlaege aus). */
export function festeChips(stand: Nutzerstand, faehigkeiten: Faehigkeit[]): Chip[] {
  const ids = new Set(faehigkeiten.map((f) => f.id));
  const kandidaten: Array<{ chip: Chip; wenn: boolean }> = [
    { chip: { titel: "KI-Modell einrichten", auftrag: "Hilf mir, ein KI-Modell einzurichten: lokal mit Ollama oder mit meinem eigenen Schlüssel.", gruppe: "lokales_modell", aktion: "Einrichten", stufe: 1 }, wenn: !stand.modell.bereit && ids.has("lokales_modell") },
    { chip: { titel: "HubSpot verbinden", auftrag: "Verbinde AVA mit meinem HubSpot-Konto.", gruppe: "hubspot", aktion: "Verbinden", stufe: 1 }, wenn: stand.verbindungen.hubspot === "offen" && ids.has("hubspot") },
    { chip: { titel: "Telegram verbinden", auftrag: "Richte Telegram ein, damit ich Meldungen und Freigaben aufs Handy bekomme.", gruppe: "telegram", aktion: "Verbinden", stufe: 1 }, wenn: stand.verbindungen.telegram === "offen" && ids.has("telegram") },
    { chip: { titel: "Mail-Postfach verbinden", auftrag: "Verbinde mein Mail-Postfach mit AVA.", gruppe: "mail", aktion: "Verbinden", stufe: 1 }, wenn: stand.verbindungen.mail === "offen" && ids.has("mail") },
    { chip: { titel: "Idealkundenprofil erstellen", auftrag: "Lass uns mein Idealkundenprofil (ICP) festlegen. Ich nenne dir meine Website und die Websites meiner besten Kunden.", gruppe: "icp", aktion: "Starten", stufe: 2 }, wenn: stand.icp !== "vollstaendig" && ids.has("icp") },
    { chip: { titel: "Firmen-Radar starten", auftrag: "Starte den Firmen-Radar für meine Region und zeig mir die besten Treffer.", gruppe: "radar", aktion: "Starten", stufe: 2 }, wenn: stand.icp === "vollstaendig" && stand.radar.bewertet === 0 && ids.has("radar") },
    { chip: { titel: "Firmen aus HubSpot importieren", auftrag: "Importiere meine Firmen aus HubSpot und reichere sie an.", gruppe: "import", aktion: "Importieren", stufe: 2 }, wenn: stand.verbindungen.hubspot === "verbunden" && (stand.firmen.importiert ?? 0) === 0 && ids.has("import") },
    { chip: { titel: "Excel-Liste importieren", auftrag: "Ich möchte eine Excel-Liste mit Firmen importieren und anreichern lassen.", gruppe: "import", aktion: "Importieren", stufe: 2 }, wenn: (stand.firmen.importiert ?? 0) === 0 && ids.has("import") },
    { chip: { titel: "Radar-Automatik einschalten", auftrag: "Schalte die Radar-Automatik ein, damit täglich neue Firmen gesucht werden.", gruppe: "radar", aktion: "Einschalten", stufe: 2 }, wenn: stand.icp === "vollstaendig" && !stand.radar.automatik && stand.plan !== "free" && ids.has("radar") },
    { chip: { titel: stand.radar.topTreffer?.name ? `Analyse zu ${stand.radar.topTreffer.name}` : "Heißesten Radar-Treffer analysieren", auftrag: stand.radar.topTreffer?.name ? `Erstelle eine ICP- und Marktanalyse zu ${stand.radar.topTreffer.name} mit allem, was du über die Firma weißt.` : "Erstelle eine ICP- und Marktanalyse zu meinem heißesten Radar-Treffer.", gruppe: "radar", aktion: "Analysieren", stufe: 3 }, wenn: stand.radar.heisseTreffer > 0 && ids.has("radar") },
    { chip: { titel: "Ersten Workflow anlegen", auftrag: "Hilf mir, einen ersten Workflow anzulegen, zum Beispiel ein Kurzprofil per Telegram bei jedem neuen heißen Radar-Treffer.", gruppe: "workflows", aktion: "Anlegen", stufe: 3 }, wenn: stand.workflows.anzahl === 0 && stand.modell.sStufe && ids.has("workflows") },
    { chip: { titel: "Best-Match über meine Firmen", auftrag: "Welche meiner Firmen passen am besten zu meinem Angebot? Mach ein Best-Match-Ranking.", gruppe: "best_match", aktion: "Starten", stufe: 3 }, wenn: (stand.firmen.importiert ?? 0) >= 2 && ids.has("best_match") },
  ];
  return kandidaten.filter((k) => k.wenn).map((k) => k.chip).slice(0, MAX_CHIPS);
}

function cacheKey(stand: Nutzerstand, faehigkeiten: Faehigkeit[]): string {
  const tag = new Date().toISOString().slice(0, 10);
  const basis = `${tag}\n${nutzerstandText(stand)}\n${faehigkeiten.map((f) => f.id).join(",")}`;
  return createHash("sha1").update(basis).digest("hex");
}

export class ChipErzeugung {
  private readonly path: string;
  private laufend: Promise<StartseitenChips> | null = null;

  constructor(private readonly deps: ErzeugungDeps) {
    this.path = join(deps.dir, "suggestions-cache.json");
  }

  private leseCache(): CacheDatei | null {
    try {
      return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as CacheDatei) : null;
    } catch {
      return null;
    }
  }

  private schreibeCache(c: CacheDatei): void {
    try {
      mkdirSync(this.deps.dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(c), "utf8");
    } catch {
      /* best-effort */
    }
  }

  async startseite(opts: { frisch?: boolean; ohneModell?: boolean } = {}): Promise<StartseitenChips> {
    if (this.laufend) return this.laufend;
    this.laufend = this.startseiteInner(opts).finally(() => {
      this.laufend = null;
    });
    return this.laufend;
  }

  private async startseiteInner(opts: { frisch?: boolean; ohneModell?: boolean }): Promise<StartseitenChips> {
    const stand = await this.deps.nutzerstand();
    const faehigkeiten = verfuegbareFaehigkeiten(this.deps.toolNamen(), stand.gesperrteModule);
    const key = cacheKey(stand, faehigkeiten);
    if (!opts.frisch) {
      const c = this.leseCache();
      if (c && c.key === key && c.chips.length > 0) return { chips: c.chips, quelle: "cache", erzeugtAt: c.at };
    }
    if (opts.ohneModell || !stand.modell.bereit) {
      return { chips: festeChips(stand, faehigkeiten), quelle: "fest", erzeugtAt: new Date().toISOString() };
    }
    try {
      const roh = await this.erzeuge(stand, faehigkeiten);
      const chips = harteSchranke(roh, faehigkeiten, stand);
      if (chips.length === 0) throw new Error("keine gueltigen Chips");
      const at = new Date().toISOString();
      this.schreibeCache({ key, at, chips });
      return { chips, quelle: "ki", erzeugtAt: at };
    } catch (err) {
      this.deps.log?.(`[vorschlaege] Startseite: Rueckfall auf feste Liste (${err instanceof Error ? err.message : String(err)})`);
      return { chips: festeChips(stand, faehigkeiten), quelle: "fest", erzeugtAt: new Date().toISOString() };
    }
  }

  /** v0.1.649 (V4) — Urteil nach einem Turn: 0 bis 3 Chips, Standard leer. */
  async gespraech(ctx: { nutzerText: string; antwortText: string; toolNamen: string[] }): Promise<Chip[]> {
    const stand = await this.deps.nutzerstand();
    if (!stand.modell.bereit) return [];
    const faehigkeiten = verfuegbareFaehigkeiten(this.deps.toolNamen(), stand.gesperrteModule, { mitVerwaltung: true });
    const system =
      "Du bist AVA. Der Nutzer hat gerade eine Antwort bekommen. Entscheide, ob sich aus DIESEM Gespraech ein offensichtlicher naechster Schritt ergibt, " +
      "den du per Chip anbieten sollst. Standard ist: KEIN Vorschlag. Nur wenn der naechste Schritt aus Frage und Antwort klar folgt (z. B. Firma recherchiert → " +
      "Ansprechpartner finden, Radar-Treffer besprochen → importieren oder analysieren, Nutzer erwaehnt Abo/Abrechnung → Abrechnung), schlage 1 bis 3 vor.\n\n" +
      "REGELN: nur Faehigkeiten aus der Liste; nichts Erledigtes; Verwaltung (organisation, einstellungen, konto, system) nur, wenn der Nutzer sie selbst anspricht; " +
      "Auftrag in Du-Form, ein Satz, konkret mit Namen aus dem Gespraech; kein Geviertstrich, keine Emojis.\n\n" +
      'Antworte NUR als JSON: {"chips":[{"titel":"max 6 Woerter","auftrag":"1 Satz","gruppe":"<id>","aktion":"Starten|Anlegen|Analysieren|Importieren|Verbinden|Oeffnen"}]} oder {"chips":[]}.';
    const user =
      `NUTZERSTAND:
${nutzerstandText(stand)}

FAEHIGKEITEN:
${faehigkeitenText(faehigkeiten)}

` +
      `LETZTE NUTZERNACHRICHT:
${ctx.nutzerText.slice(0, 1200)}

LETZTE ANTWORT (gekuerzt):
${ctx.antwortText.slice(0, 1600)}

` +
      `WERKZEUGE IN DIESEM TURN: ${ctx.toolNamen.length ? ctx.toolNamen.join(", ") : "keine"}`;
    try {
      const raw = await streamToText(this.deps.providers, buildMessages(system, user, "vorschlaege-turn"), {
        timeoutMs: TIMEOUT_MS,
        ...(this.deps.providers.getProducerModelOverride() ? { modelOverride: this.deps.providers.getProducerModelOverride() } : {}),
      });
      const parsed = parseJsonObject(raw);
      if (!parsed) return [];
      const valid = antwortSchema.validateSync(parsed, { abortEarly: true, stripUnknown: true });
      const roh = valid.chips.map((c) => ({ titel: c.titel, auftrag: c.auftrag, gruppe: c.gruppe, aktion: c.aktion ?? undefined, stufe: c.stufe ?? undefined }));
      // Im Gespraech darf Verwaltung vorkommen, wenn das Modell sie fuer angesprochen haelt:
      // Schranke daher mit Verwaltungsgruppen, aber nur, wenn der Nutzer das Thema nannte.
      const nutzer = ctx.nutzerText.toLowerCase();
      const verwaltungErlaubt = /abo|abrechnung|rechnung|plan|tarif|schl[uü]ssel|api-key|anbieter|modell|organisation|mitglied|konto|update|version/.test(nutzer);
      const zulaessig = faehigkeiten.filter((f) => !f.verwaltung || verwaltungErlaubt);
      return harteSchranke(roh, zulaessig.map((f) => ({ ...f, verwaltung: false })), stand).slice(0, MAX_CHIPS_GESPRAECH);
    } catch (err) {
      this.deps.log?.(`[vorschlaege] Gespraech: kein Urteil (${err instanceof Error ? err.message : String(err)})`);
      return [];
    }
  }

  private async erzeuge(stand: Nutzerstand, faehigkeiten: Faehigkeit[]): Promise<Chip[]> {
    const system =
      "Du bist AVA, Assistentin fuer B2B-Vertrieb. Du schlaegst dem Nutzer auf der Chat-Startseite bis zu vier konkrete naechste Schritte vor. " +
      "Ein Vorschlag ist ein kurzer Auftrag in Du-Form, den der Nutzer per Klick an dich schickt; du fuehrst ihn danach mit deinen Werkzeugen aus.\n\n" +
      "REGELN:\n" +
      "1. Schlage NUR vor, was mit den unten gelisteten Faehigkeiten wirklich geht. Nenne keine Integration oder Funktion, die dort nicht steht.\n" +
      "2. Schlage NICHTS vor, was laut Nutzerstand schon erledigt ist (verbunden, vollstaendig, an) oder keinen Nutzen haette.\n" +
      "3. Reihenfolge nach Stufen: Stufe 1 Anschluss (Verbindungen, Modell), Stufe 2 Aufbau (ICP, Radar, Import), Stufe 3 Routine (Workflows, Analysen, Best-Match). " +
      "Zuerst die niedrigste offene Stufe, dazu genau ein Ausblick auf die naechste Stufe.\n" +
      "4. Keine Verwaltung (Abrechnung, Konto, Schluessel, Organisation verwalten).\n" +
      "5. Nutze konkrete Namen aus dem Nutzerstand (z. B. den Top-Radar-Treffer) statt Platzhaltern.\n" +
      "6. Kein Geviertstrich, keine Emojis, keine Superlative.\n\n" +
      'Antworte NUR als JSON: {"chips":[{"titel":"max 6 Woerter","auftrag":"der vollstaendige Auftrag in Du-Form, 1 Satz","gruppe":"<id aus der Faehigkeitsliste>","aktion":"Verbinden|Starten|Anlegen|Importieren|Analysieren|Einschalten","stufe":1|2|3}]}';
    const user = `NUTZERSTAND:\n${nutzerstandText(stand)}\n\nFAEHIGKEITEN (id: Beschreibung):\n${faehigkeitenText(faehigkeiten)}`;
    const raw = await streamToText(this.deps.providers, buildMessages(system, user, "vorschlaege"), {
      timeoutMs: TIMEOUT_MS,
      ...(this.deps.providers.getProducerModelOverride() ? { modelOverride: this.deps.providers.getProducerModelOverride() } : {}),
    });
    const parsed = parseJsonObject(raw);
    if (!parsed) throw new Error("Antwort ohne JSON");
    const valid = antwortSchema.validateSync(parsed, { abortEarly: true, stripUnknown: true });
    return valid.chips.map((c) => ({ titel: c.titel, auftrag: c.auftrag, gruppe: c.gruppe, aktion: c.aktion ?? undefined, stufe: c.stufe ?? undefined }));
  }
}
