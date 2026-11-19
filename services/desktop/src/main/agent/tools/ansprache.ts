import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool, ToolContext } from "../types";
import type { IcpProfile } from "../icp-store";
import type { UserProfile } from "../../../shared/types";
import type { GeneralMemoryEntry } from "../general-memory";
import { aufhaengerBilden, anspracheTextPruefen, LAENGE, type Aufhaenger, type Kanal } from "../ansprache-logik";

// Erstansprache (docs/PLAN_ERSTANSPRACHE.md, A2/A3/A5).
//
// Befund Patrick 2026-11-19: Bis eine Ansprache an IEF-Werner alle Daten nutzte, brauchte es acht
// bis zehn Runden, weil das Modell jede Quelle erst holte, wenn der Nutzer sie verlangte.
// `ansprache_vorbereiten` holt in EINEM Aufruf alles, was AVA zu Firma und Ansprechpartner weiss,
// legt das eigene Angebot (Idealkundenprofil: Angebot, Nutzen, Kundenbeispiele) und den
// gemerkten Ansprache-Stil dazu und ordnet die staerksten Aufhaenger. `ansprache_pruefen` prueft
// den Entwurf deterministisch gegen genau diese Aufhaenger.
//
// Die Daten kommen ueber die vorhandenen Werkzeuge (company_get mit Bereichen, firmen_ereignisse,
// alerts_list, buying_center_anzeigen), damit Regeln wie Steckbrief/Ruhend, Kompaktform und
// Rechte an einer Stelle bleiben.

export const STIL_TAG = "ansprache";

export interface AnspracheDeps {
  /** Ein anderes registriertes Werkzeug aufrufen (Argumente werden wie vom Modell geprueft). */
  rufe: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  icp: () => IcpProfile | null;
  profil: () => UserProfile | null;
  /** Gemerkte Stilregeln fuer Ansprachen (Tag „ansprache“). */
  stil: () => GeneralMemoryEntry[];
}

/** Letzte Vorbereitung je Firma, damit ansprache_pruefen ohne erneutes Laden pruefen kann. */
const zuletzt = new Map<string, { aufhaenger: Aufhaenger[]; empfaenger: string | null; kanal: Kanal; zeit: number }>();

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const falten = (s: string) => s.toLocaleLowerCase("de-DE").normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Markdown-Profil zu schlichtem Text, gekuerzt. */
function schlicht(md: string | null, max: number): string | null {
  if (!md) return null;
  const t = md
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")} …` : t;
}

// Rollenbegriff statt Name („an den Vertriebsleiter“): Woerter, die in der Rolle stehen muessen.
const ROLLEN_SUCHE: Array<[RegExp, RegExp]> = [
  [/vertrieb|verkauf|sales|cso|cco|commercial/, /vertrieb|verkauf|sales|cso|cco|commercial|business development/],
  [/einkauf|beschaffung|procurement|purchas|cpo/, /einkauf|beschaffung|procurement|purchas|cpo|supply chain/],
  [/geschaeftsf|ceo|inhaber|vorstand|managing/, /geschaeftsf|ceo|inhaber|vorstand|managing director|geschaeftsleitung/],
  [/marketing|cmo/, /marketing|cmo|kommunikation/],
  [/\bit\b|cio|cto|digital|edv/, /\bit\b|cio|cto|digital|edv|informatik/],
  [/personal|hr\b|chro|people/, /personal|\bhr\b|chro|people|human resources/],
  [/finanz|cfo|kaufmaenn|controlling/, /finanz|cfo|kaufmaenn|controlling/],
  [/technik|produktion|engineering|coo|werk/, /technik|produktion|engineering|coo|werkleit|betriebsleit/],
];
const LEITUNG_WORT = /leit|head|director|direktor|chief|vp|vice president|geschaeftsf|vorstand|ceo|cso|cco|cfo|cio|cto|cmo|cpo|coo/;

/** Personen, deren Rolle zum Rollenbegriff passt; Leitung zuerst. */
function nachRolle(personen: Obj[], begriff: string): Obj[] {
  const b = falten(begriff);
  const paar = ROLLEN_SUCHE.find(([such]) => such.test(b));
  if (!paar) return [];
  const leitungGewollt = LEITUNG_WORT.test(b);
  return personen
    .filter((p) => paar[1].test(falten(String(p["rolle"] ?? ""))))
    .sort((x, y) => {
      const lx = LEITUNG_WORT.test(falten(String(x["rolle"] ?? ""))) ? 1 : 0;
      const ly = LEITUNG_WORT.test(falten(String(y["rolle"] ?? ""))) ? 1 : 0;
      return leitungGewollt ? ly - lx : 0;
    });
}

const ROLLE_WICHTIG = /(geschäftsf|geschaeftsf|vorstand|ceo|inhaber|leiter|leitung|head|director|chief|vertrieb|sales|einkauf|procurement|technik|engineering|it\b|produktion|marketing)/i;

export async function anspracheVorbereiten(
  deps: AnspracheDeps,
  args: { companyId: string; empfaenger?: string; personId?: string; kanal?: Kanal; anlass?: string },
  ctx: ToolContext,
): Promise<Obj> {
  const versuch = async (name: string, a: Obj): Promise<unknown> => {
    try {
      return await deps.rufe(name, a, ctx);
    } catch (err) {
      return { fehler: err instanceof Error ? err.message : String(err) };
    }
  };
  const [firmaRoh, ereignisseRoh, meldungenRoh, bcRoh] = await Promise.all([
    versuch("company_get", { companyId: args.companyId, bereiche: ["profil", "publikationen", "kontakte", "kunden", "stellen", "expansion", "fokus", "crm", "fluktuation", "linkedin"] }),
    versuch("firmen_ereignisse", { companyIds: [args.companyId], seitTage: 365, limit: 40 }),
    versuch("alerts_list", { companyId: args.companyId, sinceMinutes: 90 * 1440, limit: 20 }),
    versuch("buying_center_anzeigen", { companyId: args.companyId }),
  ]);
  const firma = obj(firmaRoh);
  if (firma["zustand"]) {
    // Ruhend oder nicht in der Liste: nur Steckbrief. Der Hinweis sagt dem Modell, was zu tun ist.
    return { companyId: args.companyId, zustand: firma["zustand"], hinweis: firma["hinweis"] ?? "Firma nicht aufbereitet.", steckbrief: firma["steckbrief"] ?? null };
  }
  const b = obj(firma["bereiche"]);
  const profil = obj(b["profil"]);
  const kontakte = obj(b["kontakte"]);
  const personen = arr(kontakte["personen"]);

  // Empfaenger: per personId oder Name (alle Namensteile muessen passen).
  const gesucht = args.empfaenger ? falten(args.empfaenger).split(/\s+/).filter((w) => w.length > 1 && !["herr", "frau", "dr", "dr."].includes(w)) : [];
  const perName =
    personen.find((p) => args.personId && String(p["personId"]) === args.personId) ??
    (gesucht.length ? personen.find((p) => { const n = falten(String(p["name"] ?? "")); return gesucht.every((w) => n.includes(w)); }) : undefined) ??
    null;
  // Kein Name, sondern eine Rolle („Vertriebsleiter“): passende Personen, Leitung zuerst.
  const perRolle = !perName && args.empfaenger ? nachRolle(personen, args.empfaenger) : [];
  const empf = perName ?? perRolle[0] ?? null;
  const empfaengerName = str(empf?.["name"]) ?? (args.empfaenger ?? null);

  const ereignisse = arr(obj(ereignisseRoh)["ereignisse"]).map((e) => ({
    art: String(e["art"] ?? ""), person: str(e["person"]), rolleVorher: str(e["rolleVorher"]), rolle: str(e["rolle"]),
    bereich: str(e["bereich"]), zeitpunkt: String(e["zeitpunkt"] ?? ""), zeitpunktArt: str(e["zeitpunktArt"]), quelle: str(e["quelle"]), url: str(e["url"]),
  })).filter((e) => e.zeitpunkt && e.art !== "geschaeftsfuehrung");
  const meldungen = arr(obj(meldungenRoh)["items"]).map((m) => ({ kind: String(m["kind"] ?? ""), headline: String(m["headline"] ?? ""), createdAt: String(m["createdAt"] ?? ""), url: str(m["url"]) })).filter((m) => m.headline && m.createdAt);
  const pubs = arr(obj(b["publikationen"])["items"]);
  const aufhaenger = aufhaengerBilden({
    heute: new Date(),
    empfaengerName,
    ereignisse,
    meldungen,
    expansion: arr(obj(b["expansion"])["eintraege"]).map((x) => ({ art: str(x["art"]), titel: str(x["titel"]), datum: str(x["datum"]), wert: str(x["wert"]), quelle: str(x["quelle"]) })),
    stellen: { anzahl: Number(obj(b["stellen"])["anzahl"] ?? 0) || 0, titel: arr(obj(b["stellen"])["stellen"]).map((s) => String(s["titel"] ?? "")).filter(Boolean) },
    fokus: arr(obj(b["fokus"])["themen"]).map((t) => ({ thema: String(t["thema"] ?? ""), status: String(t["status"] ?? ""), zitat: str(t["zitat"]), quelle: str(t["quelle"]) })),
    finanzen: pubs.filter((p) => p["art"] !== "konzern" || pubs.every((q) => q["art"] === "konzern")).map((p) => ({ jahr: (p["jahr"] as number | string | null) ?? null, umsatz: str(p["umsatz"]), mitarbeiter: typeof p["mitarbeiter"] === "number" ? (p["mitarbeiter"] as number) : null })),
    fluktuation: (obj(b["fluktuation"])["hinweise"] as string[] | undefined) ?? [],
    kunden: arr(obj(b["kunden"])["kunden"]).map((k) => String(k["name"] ?? "")).filter(Boolean),
    produkte: schlicht(str(profil["profile"]), 400),
    linkedin: arr(obj(b["linkedin"])["items"]).map((p) => ({ authorName: str(p["authorName"]), summary: str(p["summary"]), postedAt: str(p["postedAt"]), permalink: str(p["permalink"]), signalStrength: typeof p["signalStrength"] === "number" ? (p["signalStrength"] as number) : null })),
  });
  const kanal: Kanal = args.kanal ?? "mail";
  zuletzt.set(args.companyId, { aufhaenger, empfaenger: empfaengerName, kanal, zeit: Date.now() });

  // Eigene Seite: Angebot, Nutzen, Kundenbeispiele aus dem Idealkundenprofil (Start-Analyse der
  // eigenen Website), sonst die Bio. Fehlt beides, sagt der Hinweis, was zu tun ist.
  const icp = deps.icp();
  const p = deps.profil();
  const angebot = {
    angebot: str(icp?.angebot) ?? null,
    nutzen: str(icp?.nutzen) ?? null,
    kundenBeispiele: (icp?.kundenBeispiele ?? []).map((k) => k.name || k.domain).filter(Boolean).slice(0, 5),
    ...(str(p?.bio) ? { ueberMich: str(p?.bio) } : {}),
    ...(p?.role ? { rolle: p.role } : {}),
    ...(p?.tone ? { tonfall: p.tone } : {}),
  };
  const ohneAngebot = !angebot.angebot && !angebot.nutzen && !str(p?.bio);

  const stil = deps.stil().map((e) => e.content).slice(0, 12);
  const wichtige = personen
    .filter((x) => x !== empf)
    .sort((a, c) => Number(ROLLE_WICHTIG.test(String(c["rolle"] ?? ""))) - Number(ROLLE_WICHTIG.test(String(a["rolle"] ?? ""))))
    .slice(0, 8)
    .map((x) => ({ name: x["name"], ...(x["rolle"] ? { rolle: x["rolle"] } : {}), ...(x["email"] ? { email: x["email"], emailStatus: x["emailStatus"] } : {}), ...(x["personId"] ? { personId: x["personId"] } : {}) }));
  const bc = obj(bcRoh);
  const crm = b["crm"];
  const crmText = crm && !obj(crm)["fehler"] ? JSON.stringify(crm) : "";

  return {
    companyId: args.companyId,
    firma: {
      name: firma["name"] ?? firma["legalName"] ?? null,
      ort: firma["location"] ?? firma["city"] ?? null,
      ...(firma["statusWarnung"] ? { statusWarnung: firma["statusWarnung"] } : {}),
      profil: schlicht(str(profil["profile"]), 900),
      ...(str(profil["businessPurpose"]) ? { gegenstand: schlicht(str(profil["businessPurpose"]), 300) } : {}),
    },
    empfaenger: empf
      ? { name: empf["name"], ...(empf["rolle"] ? { rolle: empf["rolle"] } : {}), ...(empf["abteilung"] ? { abteilung: empf["abteilung"] } : {}), ...(empf["seit"] ? { seit: empf["seit"] } : {}), ...(empf["email"] ? { email: empf["email"], emailStatus: empf["emailStatus"], ...(empf["emailHerkunft"] ? { emailHerkunft: empf["emailHerkunft"] } : {}) } : {}), ...(empf["linkedin"] ? { linkedin: empf["linkedin"] } : {}), ...(empf["personId"] ? { personId: empf["personId"] } : {}) }
      : args.empfaenger
        ? { name: args.empfaenger, hinweis: "Nicht unter den Kontakten der Firma gefunden; Adresse mit kontakt_suchen oder email_adresse_pruefen klären." }
        : null,
    ...(perRolle.length > 0 ? { empfaengerNachRolle: `Gewählt nach Rolle „${args.empfaenger}“; weitere passende: ${perRolle.slice(1, 4).map((p) => `${p["name"]} (${p["rolle"] ?? "?"})`).join(", ") || "keine"}. Im Antwortsatz nennen, nicht vorher fragen.` } : {}),
    aufhaenger: aufhaenger.map((a) => ({ fakt: a.fakt, quelle: a.quelle, datum: a.datum, staerke: a.staerke, art: a.art })),
    weitereAnsprechpartner: wichtige,
    angebot,
    ...(ohneAngebot ? { angebotFehlt: "Das eigene Angebot ist nicht hinterlegt. EINMAL kurz fragen (was bietet ihr, welcher Nutzen, eine Referenz) und mit icp_set speichern; bis dahin den Nutzen allgemein halten." } : {}),
    ...(stil.length ? { stil } : {}),
    ...(crmText && crmText.length > 2 ? { vorgeschichte: crmText.length > 1200 ? `${crmText.slice(0, 1200)} …` : JSON.parse(crmText) } : {}),
    ...(bc["personen"] || bc["rollen"] ? { buyingCenter: bc } : {}),
    ...(args.anlass ? { anlassDesNutzers: args.anlass } : {}),
    regeln: {
      kanal,
      anrede: "Sie, außer stil oder Gespräch sagen Du; bei Erstansprachen NICHT nach Du/Sie fragen",
      laengeWoerter: `${LAENGE[kanal].min}–${LAENGE[kanal].max}`,
      aufbau: "Anlass (stärkster Aufhänger, konkret) → These (was das für den Empfänger bedeutet) → Nutzen (ein Satz zum eigenen Angebot, Referenz wenn passend) → Vorschlag (klein, konkret) → eine Frage",
      danach: "Entwurf mit ansprache_pruefen prüfen; bei Mängeln EINMAL überarbeiten, dann ausgeben.",
    },
  };
}

export function buildAnspracheTools(deps: AnspracheDeps): Tool[] {
  const vorbereiten = defineTool({
    name: "ansprache_vorbereiten",
    summary: "Holt in einem Aufruf alles für eine Erstansprache (Mail/LinkedIn): Anlässe, Empfänger, Finanzen, Personalwechsel, eigenes Angebot, Stil.",
    category: "ansprache mail outreach akquise vertrieb",
    description:
      "Vorbereitung einer Erstansprache oder Nachfass-Nachricht an eine Firma bzw. Person (Mail oder LinkedIn). IMMER der erste Schritt, bevor du eine Ansprache schreibst, ohne Rueckfrage. " +
      "Liefert in einem Aufruf: firma (Profil, Gegenstand, Status), empfaenger (Rolle, Adresse samt emailStatus), aufhaenger (die 3-5 staerksten Anlaesse nach Frische und Staerke: Personalwechsel, Meldungen, Expansion, Fokus-Themen, Stellen, Finanzen mit Umsatz/Mitarbeitern, Referenzen, Produkte; je mit Quelle und Datum), " +
      "weitereAnsprechpartner, angebot (was der Nutzer anbietet: Angebot, Nutzen, Kundenbeispiele), stil (gemerkte Wuensche des Nutzers fuer Ansprachen), vorgeschichte (CRM), buyingCenter und regeln (Laenge, Aufbau). " +
      "`empfaenger` = Name der Person (z. B. 'Herr Schwer' oder 'Anna Muster'), `kanal` mail (Standard) oder linkedin, `anlass` = was der Nutzer selbst als Anlass nennt.",
    parameters: {
      type: "object",
      required: ["companyId"],
      properties: {
        companyId: { type: "string" },
        empfaenger: { type: "string", description: "Name des Empfaengers, wenn bekannt" },
        personId: { type: "string" },
        kanal: { type: "string", enum: ["mail", "linkedin"] },
        anlass: { type: "string", description: "Anlass in den Worten des Nutzers, falls genannt" },
      },
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(1).required(),
        empfaenger: yup.string().trim().max(120).optional(),
        personId: yup.string().trim().optional(),
        kanal: yup.string().oneOf(["mail", "linkedin"]).optional(),
        anlass: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    run: async (args, c) => anspracheVorbereiten(deps, args as { companyId: string; empfaenger?: string; personId?: string; kanal?: Kanal; anlass?: string }, c),
    preview: (r) => {
      const a = (r as { aufhaenger?: unknown[] }).aufhaenger;
      return Array.isArray(a) ? `${a.length} Aufhänger vorbereitet` : "Firma nicht aufbereitet";
    },
  });

  const pruefen = defineTool({
    name: "ansprache_pruefen",
    summary: "Prüft einen Ansprache-Entwurf gegen die Vorbereitung: Fakten, Bezug im Einstieg, Länge, Floskeln, Platzhalter.",
    category: "ansprache mail outreach",
    description:
      "Prueft einen fertigen Ansprache-Entwurf (nur den Text, mit Anrede und Gruss) gegen die letzte ansprache_vorbereiten-Antwort derselben Firma: mindestens zwei Fakten aus den Aufhaengern, " +
      "konkreter Bezug in den ersten zwei Saetzen, Laenge je Kanal, keine Floskeln, keine Platzhalter, kein Ueberwachungston. Vor JEDER Ausgabe einer Ansprache aufrufen. " +
      "bestanden=false → EINMAL anhand von `maengel` ueberarbeiten und dann ausgeben (nicht erneut pruefen, nicht den Nutzer fragen). `hinweise` sind Empfehlungen.",
    parameters: {
      type: "object",
      required: ["companyId", "text"],
      properties: {
        companyId: { type: "string" },
        text: { type: "string", description: "Der Entwurf als Klartext" },
        betreff: { type: "string" },
      },
    },
    schema: yup
      .object({ companyId: yup.string().trim().min(1).required(), text: yup.string().trim().min(1).max(20_000).required(), betreff: yup.string().trim().max(300).optional() })
      .noUnknown(true),
    run: async (args) => {
      const v = zuletzt.get(args.companyId);
      if (!v || Date.now() - v.zeit > 6 * 3_600_000) {
        return { bestanden: false, maengel: ["Keine aktuelle Vorbereitung zu dieser Firma: zuerst ansprache_vorbereiten aufrufen."], hinweise: [] };
      }
      return anspracheTextPruefen(args.text, v.aufhaenger, { kanal: v.kanal, empfaengerName: v.empfaenger, betreff: args.betreff ?? null });
    },
    preview: (r) => ((r as { bestanden?: boolean }).bestanden ? "Entwurf geprüft: in Ordnung" : `Entwurf geprüft: ${((r as { maengel?: unknown[] }).maengel ?? []).length} Mängel`),
  });

  return [vorbereiten, pruefen];
}
