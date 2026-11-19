// Zeitachse einer Firma (Firmenhistorie H3, Vorlage: ava-app src/lib/zeitachse.ts):
// neun Quellen des Gateways werden zu einer Liste von Ereignissen, jüngstes zuerst.
// Jede Quelle hat ihre eigene Abfrage (eigener Lade- und Fehlerzustand); die Antworten
// werden mit yup geprüft, bevor sie zu Einträgen werden.
//
//   register   RegisterSnapshot (register-verlauf): früherer Stand + geänderte Felder
//   profil     ProfileChangeEvent (profile-changes): Geschäftsführung, Name, Sitz, Kapital …
//   personal   Personalwechsel (firmen-ereignisse): neu, ausgeschieden, Wechsel der Rolle
//   insolvenz  Veröffentlichungen des Insolvenzportals (insolvency-events)
//   meldung    Neuheiten des Heartbeat-Bündels (alerts/neuheiten, letzte 30 Tage)
//   recherche  manuelle Recherche-Läufe (research/verlauf)
//   notiz      Notizen und Gesprächsprotokolle (notizen)
//   abschluss  Jahresabschlüsse (publications) als Marken auf der Achse
//
// Geschäftsführungswechsel laut Register kommen nur aus profile-changes; aus
// firmen-ereignisse nimmt die Zeitachse deshalb nur neu/verlassen/wechsel.

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import * as yup from "yup";
import { gatewayFetch, GatewayError } from "../api/gateway";
import { fmtShareCapital } from "./format";

// ---- Arten -----------------------------------------------------------------

export const ARTEN = ["notiz", "personal", "register", "profil", "insolvenz", "meldung", "recherche", "abschluss"] as const;
export type Art = (typeof ARTEN)[number];

export const ART_INFO: Record<Art, { label: string; mehrzahl: string }> = {
  notiz: { label: "Notiz", mehrzahl: "Notizen" },
  personal: { label: "Personal", mehrzahl: "Personalwechsel" },
  register: { label: "Register", mehrzahl: "Registeränderungen" },
  profil: { label: "Profil", mehrzahl: "Profiländerungen" },
  insolvenz: { label: "Insolvenz", mehrzahl: "Insolvenz-Ereignisse" },
  meldung: { label: "Meldung", mehrzahl: "Meldungen" },
  recherche: { label: "Recherche", mehrzahl: "Recherche-Läufe" },
  abschluss: { label: "Abschluss", mehrzahl: "Jahresabschlüsse" },
};

export interface Aenderung {
  name: string;
  vorher: string | null;
  nachher: string | null;
}

export interface Eintrag {
  id: string;
  art: Art;
  /** Zeitpunkt des Ereignisses (ISO). */
  datum: string;
  /** Wenn der Zeitpunkt unsicher ist: letzte Bestätigung des alten Stands; das Ereignis liegt dazwischen. */
  von?: string | null;
  /** Ergänzung zum Zeitpunkt im Tooltip (z. B. „laut Profil“). */
  zeitHinweis?: string | null;
  titel: string;
  text?: string | null;
  langtext?: string | null;
  aenderungen?: Aenderung[];
  /** Quelle; ohne URL nur als Text. URLs mit # springen auf einen Reiter. */
  quelle: { text: string; url: string | null };
  /** Frage an AVA, mit Firmenlink vorbelegt. */
  frage: string;
  pille?: string | null;
  /** Marke statt voller Eintrag (Jahresabschluss). */
  marke?: boolean;
  notiz?: { id: string; verfasser: string | null; quelle: string; actorId: string; vorlaeufig?: boolean };
}

// ---- Antwortformen (yup) ----------------------------------------------------

const text = yup.string().nullable();
const liste = <T extends yup.AnySchema>(s: T) => yup.object({ items: yup.array().of(s).default([]) });

const registerSchema = liste(
  yup.object({
    id: yup.string().required(),
    quelle: yup.string().default(""),
    felder: yup.array().of(yup.string().required()).default([]),
    bestandVon: text,
    ersetztAm: yup.string().required(),
    stand: yup.mixed().default({}),
  }),
);
export interface RegisterSnapshot {
  id: string;
  quelle: string;
  felder: string[];
  bestandVon: string | null;
  ersetztAm: string;
  stand: Record<string, unknown>;
}

const profilSchema = liste(
  yup.object({
    id: yup.string().required(),
    kind: yup.string().required(),
    added: yup.array().of(yup.mixed()).default([]),
    removed: yup.array().of(yup.mixed()).default([]),
    createdAt: yup.string().required(),
    bestandVon: text,
  }),
);
export interface Profilaenderung {
  id: string;
  kind: string;
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  createdAt: string;
  bestandVon: string | null;
}

const personalSchema = yup.object({
  items: yup
    .array()
    .of(
      yup.object({
        id: yup.string().required(),
        art: yup.string().required(),
        person: text,
        rolleVorher: text,
        rolle: text,
        gruppeLabel: yup.string().default(""),
        ebene: yup.string().default("mitarbeit"),
        zeitpunkt: yup.string().required(),
        zeitpunktArt: yup.string().default("erstmals_gesehen"),
        quelle: text,
        url: text,
      }),
    )
    .default([]),
});
export interface Personalereignis {
  id: string;
  art: string;
  person: string | null;
  rolleVorher: string | null;
  rolle: string | null;
  gruppeLabel: string;
  ebene: string;
  zeitpunkt: string;
  zeitpunktArt: string;
  quelle: string | null;
  url: string | null;
}

const insolvenzSchema = yup.object({
  insolvencyStatus: yup.string().default(""),
  insolvencyAt: text,
  insolvencyCheckedAt: text,
  events: yup
    .array()
    .of(yup.object({ id: yup.mixed().required(), aktenzeichen: yup.string().default(""), insolvenzgericht: yup.string().default(""), datum: yup.string().required(), gegenstand: yup.string().default(""), text: yup.string().default(""), gesehenAt: text }))
    .default([]),
});
export interface InsolvenzAntwort {
  insolvencyStatus: string;
  insolvencyAt: string | null;
  insolvencyCheckedAt: string | null;
  events: Array<{ id: number | string; aktenzeichen: string; insolvenzgericht: string; datum: string; gegenstand: string; text: string; gesehenAt: string | null }>;
}

const neuheitenSchema = yup.object({
  items: yup.array().of(yup.object({ art: yup.string().required(), id: yup.string().required(), companyId: yup.string().required(), occurredAt: text, createdAt: text })).default([]),
});
export interface Neuheit {
  art: string;
  id: string;
  companyId: string;
  occurredAt?: string | null;
  createdAt?: string | null;
  [k: string]: unknown;
}

const rechercheSchema = liste(
  yup.object({
    id: yup.string().required(),
    feature: yup.string().required(),
    stufe: yup.string().default("standard"),
    state: yup.string().required(),
    ergebnisse: yup.number().nullable(),
    fehler: text,
    gestartetAt: yup.string().required(),
    beendetAt: text,
    eigener: yup.boolean().default(false),
  }),
);
export interface Lauf {
  id: string;
  feature: string;
  stufe: string;
  state: string;
  ergebnisse: number | null;
  fehler: string | null;
  gestartetAt: string;
  beendetAt: string | null;
  eigener: boolean;
}

const notizenSchema = liste(
  yup.object({
    id: yup.string().required(),
    companyId: yup.string().default(""),
    personId: text,
    text: yup.string().required(),
    quelle: yup.string().default("app"),
    datum: text,
    createdAt: yup.string().required(),
    actorId: yup.string().default(""),
    verfasser: text,
  }),
);
export interface Notiz {
  id: string;
  companyId: string;
  personId: string | null;
  text: string;
  quelle: string;
  datum: string | null;
  createdAt: string;
  actorId: string;
  verfasser: string | null;
  vorlaeufig?: boolean;
}

const abschluesseSchema = liste(
  yup.object({ year: yup.number().nullable(), name: text, begin: text, end: text, employeeCount: yup.number().nullable(), art: yup.string().nullable(), createdAt: text }),
);
export interface Abschluss {
  year: number | null;
  name: string | null;
  begin: string | null;
  end: string | null;
  employeeCount: number | null;
  art: string | null;
  createdAt: string | null;
}

/** Aktueller Registerstand (structured-content), für das „nachher“ des jüngsten Snapshots. */
export interface RegisterStandAntwort {
  name?: string | null;
  legalForm?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  zipCode?: string | null;
  city?: string | null;
  foundingYear?: string | number | null;
  corporatePurpose?: string | null;
  shareCapital?: string | null;
  lastRegisterEntry?: string | null;
  lastRegisterModification?: string | null;
  managingDirectors?: Array<{ firstName: string | null; lastName: string | null }>;
}

const pruefen = <T,>(schema: yup.AnySchema, roh: unknown): T => schema.validateSync(roh, { strict: false, abortEarly: true }) as T;

// ---- Abfragen --------------------------------------------------------------

const pfad = (id: string, rest: string) => `/v1/companies/${encodeURIComponent(id)}${rest}`;

/** 404 heißt „noch nichts da“ (oder Route noch nicht ausgeliefert), kein Fehler. */
export const nichtVorhanden = (e: unknown) => e instanceof GatewayError && e.status === 404;

export interface Quellen {
  register: UseQueryResult<RegisterSnapshot[]>;
  stand: UseQueryResult<RegisterStandAntwort | null>;
  profil: UseQueryResult<Profilaenderung[]>;
  personal: UseQueryResult<Personalereignis[]>;
  insolvenz: UseQueryResult<InsolvenzAntwort>;
  meldung: UseQueryResult<Neuheit[]>;
  recherche: UseQueryResult<Lauf[]>;
  notiz: UseQueryResult<Notiz[]>;
  abschluss: UseQueryResult<Abschluss[]>;
}

/**
 * Alle Quellen der Zeitachse, je eine Abfrage. structured-content und publications
 * teilen Schlüssel und Pfad mit der Firmenansicht (kein doppelter Abruf); die übrigen
 * liegen unter eigenen Schlüsseln, weil andere Bereiche dort andere Formen speichern.
 */
export function useZeitachseQuellen(id: string, an: boolean, ohneRegister: boolean): Quellen {
  const allgemein = { enabled: an, retry: false, staleTime: 60_000 } as const;
  const register = useQuery({
    queryKey: ["zeitachse", id, "register-verlauf"],
    queryFn: async () => pruefen<{ items: RegisterSnapshot[] }>(registerSchema, await gatewayFetch(pfad(id, "/register-verlauf"), { query: { limit: 200 } })).items,
    ...allgemein,
    enabled: an && !ohneRegister,
  });
  const stand = useQuery({
    queryKey: ["company", id, "structured"],
    queryFn: () => gatewayFetch<RegisterStandAntwort | null>(pfad(id, "/structured-content")),
    ...allgemein,
    enabled: an && !ohneRegister,
  });
  const profil = useQuery({
    queryKey: ["zeitachse", id, "profile-changes"],
    queryFn: async () => pruefen<{ items: Profilaenderung[] }>(profilSchema, await gatewayFetch(pfad(id, "/profile-changes"))).items,
    ...allgemein,
    enabled: an && !ohneRegister,
  });
  const personal = useQuery({
    queryKey: ["zeitachse", id, "personal"],
    queryFn: async () => {
      try {
        const roh = await gatewayFetch("/v1/firmen-ereignisse", { query: { companyIds: id, arten: "neu,verlassen,wechsel", limit: 300 } });
        return pruefen<{ items: Personalereignis[] }>(personalSchema, roh).items;
      } catch (e) {
        // Ohne die Route (ältere Gegenstelle) bleibt die Quelle still leer.
        if (nichtVorhanden(e)) return [];
        throw e;
      }
    },
    ...allgemein,
  });
  const insolvenz = useQuery({
    queryKey: ["zeitachse", id, "insolvency-events"],
    queryFn: async () => pruefen<InsolvenzAntwort>(insolvenzSchema, await gatewayFetch(pfad(id, "/insolvency-events"))),
    ...allgemein,
    enabled: an && !ohneRegister,
  });
  // Das Heartbeat-Bündel: ohne `since` die letzten 30 Tage (Deckel des Gateways).
  const meldung = useQuery({
    queryKey: ["zeitachse", id, "neuheiten"],
    queryFn: async () =>
      pruefen<{ items: Neuheit[] }>(neuheitenSchema, await gatewayFetch("/v1/alerts/neuheiten", { method: "POST", body: { companyIds: [id], since: null } })).items.filter((x) => x.companyId === id),
    ...allgemein,
  });
  const recherche = useQuery({
    queryKey: ["zeitachse", id, "research-verlauf"],
    queryFn: async () => pruefen<{ items: Lauf[] }>(rechercheSchema, await gatewayFetch(pfad(id, "/research/verlauf"))).items,
    ...allgemein,
    staleTime: 5_000,
  });
  const notiz = useQuery({
    queryKey: ["zeitachse", id, "notizen"],
    queryFn: async () => pruefen<{ items: Notiz[] }>(notizenSchema, await gatewayFetch(pfad(id, "/notizen"), { query: { limit: 200 } })).items,
    ...allgemein,
  });
  const abschluss = useQuery({
    queryKey: ["company", id, "publications"],
    queryFn: () => gatewayFetch<{ items: Abschluss[] }>(pfad(id, "/publications")),
    ...allgemein,
    select: (d: unknown) => pruefen<{ items: Abschluss[] }>(abschluesseSchema, d).items,
  });
  return { register, stand, profil, personal, insolvenz, meldung, recherche, notiz, abschluss } as Quellen;
}

// ---- Notizen schreiben -------------------------------------------------------

/** Notiz anlegen: optimistisch oben einfügen, bei Fehler zurückrollen. */
export function useNotizAnlegen(id: string, actorId: string | null) {
  const qc = useQueryClient();
  const key = ["zeitachse", id, "notizen"] as const;
  return useMutation({
    mutationFn: (eingabe: { text: string }) => gatewayFetch<Notiz>(pfad(id, "/notizen"), { method: "POST", body: { text: eingabe.text, quelle: "app" } }),
    onMutate: async (eingabe) => {
      await qc.cancelQueries({ queryKey: key });
      const vorher = qc.getQueryData<Notiz[]>(key);
      const jetzt = new Date().toISOString();
      const vorlaeufig: Notiz = { id: `vorlaeufig-${jetzt}`, companyId: id, personId: null, text: eingabe.text, quelle: "app", datum: null, createdAt: jetzt, actorId: actorId ?? "", verfasser: null, vorlaeufig: true };
      qc.setQueryData<Notiz[]>(key, [vorlaeufig, ...(vorher ?? [])]);
      return { vorher, vorlaeufigId: vorlaeufig.id };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) qc.setQueryData<Notiz[]>(key, ctx.vorher ?? []);
    },
    onSuccess: (neu, _v, ctx) => {
      qc.setQueryData<Notiz[]>(key, (alt) => [neu, ...(alt ?? []).filter((n) => n.id !== ctx?.vorlaeufigId && n.id !== neu.id)]);
    },
  });
}

/** Notiz löschen (Verfasser oder Admin): sofort aus der Liste nehmen, bei Fehler zurück. */
export function useNotizLoeschen(id: string) {
  const qc = useQueryClient();
  const key = ["zeitachse", id, "notizen"] as const;
  return useMutation({
    mutationFn: (notizId: string) => gatewayFetch<{ ok: true }>(`/v1/notizen/${encodeURIComponent(notizId)}`, { method: "DELETE" }),
    onMutate: async (notizId) => {
      await qc.cancelQueries({ queryKey: key });
      const vorher = qc.getQueryData<Notiz[]>(key);
      qc.setQueryData<Notiz[]>(key, (alt) => (alt ?? []).filter((n) => n.id !== notizId));
      return { vorher };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.vorher) qc.setQueryData<Notiz[]>(key, ctx.vorher);
    },
  });
}

// ---- Einträge bilden ---------------------------------------------------------

const FELD_TEXT: Record<string, string> = {
  name: "Firmenname",
  legalForm: "Rechtsform",
  address: "Sitz",
  foundingYear: "Gründungsjahr",
  corporatePurpose: "Gegenstand",
  shareCapital: "Kapital",
  lastRegisterEntry: "Letzte Eintragung",
  lastRegisterModification: "Letzte Änderung",
  geschaeftsfuehrung: "Geschäftsführung",
};
const KIND_TEXT: Record<string, string> = {
  "managing-directors": "Geschäftsführung",
  name: "Firmenname",
  "legal-form": "Rechtsform",
  address: "Sitz",
  "share-capital": "Kapital",
  purpose: "Gegenstand",
};
const GEGENSTAND: Record<string, string> = {
  EROEFFNUNG: "Eröffnung",
  ABWEISUNG_MANGELS_MASSE: "Abweisung mangels Masse",
  SICHERUNGSMASSNAHME: "Sicherungsmaßnahme",
  AUFHEBUNG: "Aufhebung",
  EINSTELLUNG: "Einstellung",
  ENTSCHEIDUNG: "Entscheidung im Verfahren",
  VERTEILUNG: "Verteilungsverzeichnis",
  INSOLVENZPLAN: "Insolvenzplan",
  SONSTIGES: "Sonstiges",
};
const FEATURE_TEXT: Record<string, string> = { jobs: "Stellenanzeigen", expansion: "Ausschreibungen, Expansion & Beschaffung", themen: "Fokus-Themen" };
const QUELLE_TEXT: Record<string, string> = { app: "App", copilot: "Copilot", claude: "Claude", chatgpt: "ChatGPT", mcp: "MCP", desktop: "Desktop-App" };

const LAND_QUELLEN: Record<string, { register: { text: string; url: string }; insolvenz: { text: string; url: string } }> = {
  DE: { register: { text: "Handelsregister", url: "https://www.handelsregister.de/" }, insolvenz: { text: "Insolvenzbekanntmachungen", url: "https://www.insolvenzbekanntmachungen.de/" } },
  AT: { register: { text: "Firmenbuch", url: "https://justizonline.gv.at/jop/web/firmenbuchabfrage" }, insolvenz: { text: "Ediktsdatei", url: "https://edikte.justiz.gv.at/" } },
  CH: { register: { text: "Handelsregister (Zefix)", url: "https://www.zefix.ch/" }, insolvenz: { text: "SHAB", url: "https://www.shab.ch/" } },
  UK: { register: { text: "Companies House", url: "https://find-and-update.company-information.service.gov.uk/" }, insolvenz: { text: "The Gazette", url: "https://www.thegazette.co.uk/" } },
  NO: { register: { text: "Enhetsregisteret", url: "https://www.brreg.no/" }, insolvenz: { text: "Enhetsregisteret", url: "https://www.brreg.no/" } },
  FI: { register: { text: "Kaupparekisteri", url: "https://www.prh.fi/" }, insolvenz: { text: "Kaupparekisteri", url: "https://www.prh.fi/" } },
};
export const landQuellen = (country: string | null | undefined) => LAND_QUELLEN[country || "DE"] ?? LAND_QUELLEN.DE!;

const s = (v: unknown): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const personenNamen = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v.map((p) => (p && typeof p === "object" ? `${s((p as Record<string, unknown>).firstName)} ${s((p as Record<string, unknown>).lastName)}`.trim() : s(p))).filter(Boolean);
};
const adresse = (st: Record<string, unknown>): string => {
  const strasse = [s(st.street), s(st.houseNumber)].filter(Boolean).join(" ");
  const ort = [s(st.zipCode), s(st.city)].filter(Boolean).join(" ");
  return [strasse, ort].filter(Boolean).join(", ");
};
export const datumKurz = (v: unknown): string => {
  const t = s(v);
  if (!t) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleDateString("de-DE");
};
const kuerzen = (t: string, max = 160) => (t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")} …` : t);

function feldWert(feld: string, st: Record<string, unknown>): string {
  switch (feld) {
    case "address":
      return adresse(st);
    case "shareCapital":
      return fmtShareCapital(st.shareCapital);
    case "lastRegisterEntry":
    case "lastRegisterModification":
      return datumKurz(st[feld]);
    case "corporatePurpose":
      return kuerzen(s(st.corporatePurpose));
    case "geschaeftsfuehrung":
      return personenNamen(st.geschaeftsfuehrung ?? st.managingDirectors).join(", ");
    default:
      return s(st[feld]);
  }
}

function personenDiff(alt: string[], neu: string[]): string {
  const k = (n: string) => n.toLowerCase();
  const altK = new Set(alt.map(k));
  const neuK = new Set(neu.map(k));
  const dazu = neu.filter((n) => !altK.has(k(n)));
  const weg = alt.filter((n) => !neuK.has(k(n)));
  return [...dazu.map((n) => `+ ${n}`), ...weg.map((n) => `− ${n}`)].join(" · ");
}

function standAusAntwort(a: RegisterStandAntwort | null | undefined): Record<string, unknown> | null {
  if (!a) return null;
  return { ...a, geschaeftsfuehrung: a.managingDirectors ?? [] };
}

export function eintraegeRegister(items: RegisterSnapshot[], aktuell: RegisterStandAntwort | null | undefined, country: string | null | undefined, firmaLink: string): Eintrag[] {
  const q = landQuellen(country).register;
  return items.map((sn, i) => {
    // Der Snapshot ist der ALTE Stand; der neue ist der nächstjüngere Snapshot, beim
    // jüngsten der aktuelle Registerstand.
    const nachher = i === 0 ? standAusAntwort(aktuell) : ((items[i - 1]!.stand as Record<string, unknown>) ?? null);
    const alt = (sn.stand as Record<string, unknown>) ?? {};
    const felder = sn.felder.filter((f) => f !== "lastRegisterEntry" && f !== "lastRegisterModification");
    const sichtbar = felder.length > 0 ? felder : sn.felder;
    const aenderungen: Aenderung[] = sichtbar.map((f) => {
      if (f === "geschaeftsfuehrung" && nachher) {
        return { name: FELD_TEXT[f] ?? f, vorher: null, nachher: personenDiff(personenNamen(alt.geschaeftsfuehrung ?? alt.managingDirectors), personenNamen(nachher.geschaeftsfuehrung ?? nachher.managingDirectors)) || null };
      }
      return { name: FELD_TEXT[f] ?? f, vorher: feldWert(f, alt) || null, nachher: nachher ? feldWert(f, nachher) || null : null };
    });
    const namen = sichtbar.map((f) => FELD_TEXT[f] ?? f);
    return {
      id: `register:${sn.id}`,
      art: "register",
      datum: sn.ersetztAm,
      von: sn.bestandVon,
      titel: namen.length > 0 ? `Registerstand geändert: ${namen.join(", ")}` : "Registerstand geändert",
      aenderungen,
      quelle: q,
      frage: `Was bedeutet die Registeränderung vom ${datumKurz(sn.ersetztAm)} (${namen.join(", ")}) bei ${firmaLink} für den Vertrieb?`,
    };
  });
}

function profilAenderung(p: Profilaenderung): Aenderung {
  const was = KIND_TEXT[p.kind] ?? p.kind;
  if (p.kind === "managing-directors") {
    const dazu = personenNamen(p.added);
    const weg = personenNamen(p.removed);
    return { name: "Geschäftsführung", vorher: null, nachher: [...dazu.map((n) => `+ ${n}`), ...weg.map((n) => `− ${n}`)].join(" · ") || null };
  }
  const roh = (l: Array<Record<string, unknown>>) => kuerzen(s(l[0]?.value));
  const schoen = (l: Array<Record<string, unknown>>) => (p.kind === "share-capital" ? fmtShareCapital(l[0]?.value) : roh(l));
  // „25000.00“ → „25000“ sieht formatiert gleich aus; dann die Rohwerte zeigen.
  const gleich = schoen(p.removed) === schoen(p.added);
  return { name: was, vorher: (gleich ? roh(p.removed) : schoen(p.removed)) || null, nachher: (gleich ? roh(p.added) : schoen(p.added)) || null };
}

/** Profiländerungen eines Persists (gleicher Zeitpunkt) werden zu einem Eintrag. */
export function eintraegeProfil(items: Profilaenderung[], country: string | null | undefined, firmaLink: string): Eintrag[] {
  const q = landQuellen(country).register;
  const gruppen: Profilaenderung[][] = [];
  for (const p of items) {
    const letzte = gruppen[gruppen.length - 1];
    const t = Date.parse(p.createdAt);
    if (letzte && Math.abs(Date.parse(letzte[0]!.createdAt) - t) < 120_000 && (letzte[0]!.bestandVon ?? null) === (p.bestandVon ?? null)) letzte.push(p);
    else gruppen.push([p]);
  }
  return gruppen.map((g) => {
    const gf = g.find((p) => p.kind === "managing-directors");
    const namen = g.map((p) => KIND_TEXT[p.kind] ?? p.kind);
    let titel: string;
    if (g.length === 1 && gf) {
      const dazu = personenNamen(gf.added);
      const weg = personenNamen(gf.removed);
      titel = dazu.length > 0 && weg.length > 0 ? "Wechsel in der Geschäftsführung" : dazu.length > 0 ? "Neu in der Geschäftsführung" : "Ausgeschieden aus der Geschäftsführung";
    } else if (g.length === 1) {
      titel = `${namen[0]} geändert`;
    } else {
      titel = `Registerdaten geändert: ${namen.join(", ")}`;
    }
    const sortiert = [...g].sort((a, b) => (a.kind === "managing-directors" ? -1 : 0) - (b.kind === "managing-directors" ? -1 : 0));
    const p0 = g[0]!;
    return {
      id: `profil:${g.map((p) => p.id).join("+")}`,
      art: "profil",
      datum: p0.createdAt,
      von: p0.bestandVon,
      titel,
      aenderungen: sortiert.map(profilAenderung),
      quelle: q,
      frage: `${titel} bei ${firmaLink} (${datumKurz(p0.createdAt)}): Was heißt das für unsere Ansprache?`,
    };
  });
}

/** Personalwechsel aus den zentralen Daten (Profile, Website), ohne Zeitgrenze. */
export function eintraegePersonal(items: Personalereignis[], firmaLink: string): Eintrag[] {
  const aus: Eintrag[] = [];
  for (const e of items) {
    const person = e.person?.trim() || "Unbekannte Person";
    const leitung = e.ebene === "leitung";
    const bereich = e.gruppeLabel ? `${e.gruppeLabel}${leitung ? ", Leitung" : ""}` : null;
    let titel: string;
    let wechsel: string;
    if (e.art === "neu") {
      titel = e.rolle ? `Neu: ${person}, ${e.rolle}` : `Neu: ${person}`;
      wechsel = `neu als ${e.rolle ?? "Mitarbeiter"}`;
    } else if (e.art === "verlassen") {
      titel = e.rolleVorher ? `Ausgeschieden: ${person}, ${e.rolleVorher}` : `Ausgeschieden: ${person}`;
      wechsel = `ausgeschieden${e.rolleVorher ? ` (zuletzt ${e.rolleVorher})` : ""}`;
    } else if (e.art === "wechsel") {
      titel = `Wechsel: ${person}, ${e.rolleVorher ?? "?"} → ${e.rolle ?? "?"}`;
      wechsel = `von ${e.rolleVorher ?? "?"} zu ${e.rolle ?? "?"}`;
    } else {
      continue;
    }
    const lautProfil = e.zeitpunktArt === "laut_profil";
    aus.push({
      id: `personal:${e.id}`,
      art: "personal",
      datum: e.zeitpunkt,
      zeitHinweis: lautProfil ? "Datum laut Profil." : "So hat AVA es bei der Aufbereitung bemerkt; der Wechsel kann einige Wochen früher liegen.",
      titel,
      pille: bereich,
      text: lautProfil ? "Datum laut Profil" : `bemerkt am ${datumKurz(e.zeitpunkt)}`,
      quelle: e.url ? { text: e.quelle ?? "Fundstelle", url: e.url } : { text: e.quelle ?? "Beobachtung von AVA", url: null },
      frage: `Bei ${firmaLink}: ${person} ${wechsel} (${lautProfil ? "laut Profil" : "bemerkt"} am ${datumKurz(e.zeitpunkt)}). Was heißt das für unsere Ansprache?`,
    });
  }
  return aus;
}

export function eintraegeInsolvenz(a: InsolvenzAntwort | undefined, country: string | null | undefined, gerichtPraefix: boolean, firmaLink: string): Eintrag[] {
  if (!a) return [];
  const q = landQuellen(country).insolvenz;
  return a.events.map((e) => {
    const gegenstand = GEGENSTAND[e.gegenstand] ?? e.gegenstand;
    return {
      id: `insolvenz:${e.id}`,
      art: "insolvenz",
      datum: e.datum,
      titel: `Insolvenz: ${gegenstand}`,
      text: [gerichtPraefix && e.insolvenzgericht ? `Amtsgericht ${e.insolvenzgericht}` : e.insolvenzgericht, e.aktenzeichen].filter(Boolean).join(" · ") || null,
      langtext: e.text?.trim() || null,
      quelle: q,
      frage: `Wie ist der Stand des Insolvenzverfahrens bei ${firmaLink} (Veröffentlichung „${gegenstand}“ vom ${datumKurz(e.datum)}), und was heißt das für uns im Vertrieb?`,
    };
  });
}

const CONTACT_TYP: Record<string, string> = { "job-changed": "Stellenwechsel", "employer-changed": "Arbeitgeberwechsel", "company-phone-changed": "Neue Telefonnummer", "company-email-changed": "Neue E-Mail-Adresse" };
const zeichenkette = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const zahl = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const namenListe = (l: unknown, feld: string, max = 4): string => {
  if (!Array.isArray(l)) return "";
  const namen = l.map((x) => zeichenkette((x as Record<string, unknown>)?.[feld])).filter((x): x is string => Boolean(x));
  return namen.length > max ? `${namen.slice(0, max).join(", ")} und ${namen.length - max} weitere` : namen.join(", ");
};

/**
 * Meldungen des Heartbeat-Bündels zu dieser Firma. Profiländerungen und Jahresabschlüsse
 * kommen aus ihren eigenen Quellen und werden hier übersprungen, sonst stünden sie doppelt.
 */
export function eintraegeMeldungen(items: Neuheit[], websiteUrl: string | null, firmaLink: string): Eintrag[] {
  const aus: Eintrag[] = [];
  for (const m of items) {
    const datum = m.occurredAt ?? m.createdAt;
    if (!datum) continue;
    const basis = { id: `meldung:${m.art}:${m.id}`, art: "meldung" as const, datum };
    const web = websiteUrl ? { text: "Website der Firma", url: websiteUrl } : { text: "Beobachtung von AVA", url: null };
    switch (m.art) {
      case "contact-change": {
        const typ = CONTACT_TYP[String(m.typ)] ?? "Kontaktänderung";
        const person = zeichenkette(m.personName);
        const vorher = zeichenkette(m.before);
        const nachher = zeichenkette(m.after);
        const quellen = Array.isArray(m.quellen) ? (m.quellen as Array<{ url?: string; titel?: string }>) : [];
        const q0 = quellen.find((x) => zeichenkette(x.url));
        aus.push({
          ...basis,
          von: zeichenkette(m.vorherGesehenAm),
          titel: person ? `${typ}: ${person}` : typ,
          pille: typ,
          aenderungen: vorher || nachher ? [{ name: m.typ === "job-changed" ? "Position" : m.typ === "employer-changed" ? "Arbeitgeber" : "Wert", vorher, nachher }] : undefined,
          quelle: q0 ? { text: zeichenkette(q0.titel) ?? "Fundstelle", url: q0.url! } : web,
          frage: `${typ}${person ? ` von ${person}` : ""} bei ${firmaLink}${nachher ? ` (jetzt: ${nachher})` : ""}: Was heißt das für unsere Ansprache?`,
        });
        break;
      }
      case "job-postings": {
        const anzahl = zahl(m.anzahl);
        const stellen = Array.isArray(m.stellen) ? (m.stellen as Array<{ title?: string; sourceUrl?: string }>) : [];
        const erste = stellen.find((x) => zeichenkette(x.sourceUrl));
        aus.push({
          ...basis,
          titel: anzahl === 1 ? "Eine neue Stellenanzeige" : `${anzahl} neue Stellenanzeigen`,
          pille: "Stellen",
          text: namenListe(stellen, "title") || null,
          quelle: erste ? { text: "Stellenanzeige", url: erste.sourceUrl! } : web,
          frage: `${firmaLink} hat ${anzahl === 1 ? "eine neue Stellenanzeige" : `${anzahl} neue Stellenanzeigen`} veröffentlicht. Was sagt das über Bedarf und Wachstum, und wie spreche ich das an?`,
        });
        break;
      }
      case "thema-gefunden": {
        const themen = Array.isArray(m.themen) ? (m.themen as Array<{ name?: string; quelleUrl?: string | null; zitat?: string | null }>) : [];
        const erstes = themen.find((t) => zeichenkette(t.quelleUrl));
        const namen = namenListe(themen, "name");
        const zitat = themen.length === 1 ? zeichenkette(themen[0]?.zitat) : null;
        aus.push({
          ...basis,
          titel: themen.length === 1 ? `Fokus-Thema gefunden: ${namen}` : `${themen.length} Fokus-Themen gefunden`,
          pille: "Fokus",
          text: zitat ? `„${kuerzen(zitat)}“` : namen || null,
          quelle: erstes ? { text: "Fundstelle", url: erstes.quelleUrl! } : web,
          frage: `Auf der Website von ${firmaLink} wurde mein Fokus-Thema ${namen} gefunden. Wie nutze ich das für die Ansprache?`,
        });
        break;
      }
      case "new-customers": {
        const kunden = Array.isArray(m.kunden) ? (m.kunden as Array<{ name?: string; quelle?: string | null }>) : [];
        const anzahl = zahl(m.anzahl) || kunden.length;
        const erster = kunden.find((k) => zeichenkette(k.quelle));
        aus.push({
          ...basis,
          titel: anzahl === 1 ? "Neue Referenz laut Website" : `${anzahl} neue Referenzen laut Website`,
          pille: "Referenzen",
          text: namenListe(kunden, "name") || null,
          quelle: erster ? { text: "Referenzseite", url: erster.quelle! } : web,
          frage: `${firmaLink} nennt neue Kunden oder Referenzen (${namenListe(kunden, "name")}). Was heißt das für uns?`,
        });
        break;
      }
      case "new-contacts": {
        const personen = Array.isArray(m.personen) ? (m.personen as Array<{ name?: string; title?: string | null; url?: string | null }>) : [];
        const anzahl = zahl(m.anzahl) || personen.length;
        const erste = personen.find((p) => zeichenkette(p.url));
        aus.push({
          ...basis,
          titel: anzahl === 1 ? "Neuer Ansprechpartner" : `${anzahl} neue Ansprechpartner`,
          pille: "Kontakte",
          text: namenListe(personen, "name") || null,
          quelle: erste ? { text: "Profil", url: erste.url! } : web,
          frage: `Bei ${firmaLink} sind neue Ansprechpartner aufgetaucht (${namenListe(personen, "name")}). Wen davon sollte ich ansprechen?`,
        });
        break;
      }
      default:
        break;
    }
  }
  return aus;
}

const minuten = (a: string, b: string) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

export function eintraegeRecherche(items: Lauf[], firmaLink: string): Eintrag[] {
  return items.map((l) => {
    const was = FEATURE_TEXT[l.feature] ?? l.feature;
    const stand =
      l.state === "laufend"
        ? "läuft noch …"
        : l.state === "fertig"
          ? l.ergebnisse == null
            ? "abgeschlossen"
            : `${l.ergebnisse} ${l.ergebnisse === 1 ? "Ergebnis" : "Ergebnisse"}${l.beendetAt ? ` in ${minuten(l.gestartetAt, l.beendetAt)} Min.` : ""}`
          : l.state === "fehler"
            ? `fehlgeschlagen${l.fehler ? `: ${l.fehler}` : ""}`
            : "keine Rückmeldung";
    return {
      id: `recherche:${l.id}`,
      art: "recherche",
      datum: l.gestartetAt,
      titel: `Recherche: ${was}`,
      pille: l.state === "laufend" ? "läuft" : l.state === "fehler" ? "Fehler" : null,
      text: `${stand}${l.stufe === "deep" ? " · Deep Research" : ""}${l.eigener ? "" : " · von einem Kollegen gestartet"}`,
      quelle: { text: "Gezielte Recherche", url: "#overview" },
      frage: `Was hat die Recherche „${was}“ vom ${datumKurz(l.gestartetAt)} zu ${firmaLink} ergeben, und was folgt daraus?`,
    };
  });
}

export function eintraegeNotizen(items: Notiz[], firmaLink: string): Eintrag[] {
  return items.map((nz) => ({
    id: `notiz:${nz.id}`,
    art: "notiz",
    datum: nz.datum ?? nz.createdAt,
    titel: nz.verfasser ? `Notiz von ${nz.verfasser}` : "Notiz",
    pille: nz.quelle !== "app" ? (QUELLE_TEXT[nz.quelle] ?? nz.quelle) : null,
    langtext: nz.text,
    quelle: { text: `Notiz${nz.quelle !== "app" ? ` über ${QUELLE_TEXT[nz.quelle] ?? nz.quelle}` : ""}`, url: null },
    frage: `Zu ${firmaLink} steht in meinen Notizen: „${kuerzen(nz.text, 400)}“ Was schlägst du als nächsten Schritt vor?`,
    notiz: { id: nz.id, verfasser: nz.verfasser, quelle: nz.quelle, actorId: nz.actorId, vorlaeufig: nz.vorlaeufig },
  }));
}

export function eintraegeAbschluesse(items: Abschluss[], firmaLink: string): Eintrag[] {
  const aus: Eintrag[] = [];
  for (const p of items) {
    if (p.year == null && !p.end) continue;
    const datum = p.end ?? `${p.year}-12-31T00:00:00.000Z`;
    const jahr = p.year ?? new Date(datum).getFullYear();
    const konzern = p.art === "konzern" || /konzern/i.test(p.name ?? "");
    aus.push({
      id: `abschluss:${jahr}:${konzern ? "k" : "e"}`,
      art: "abschluss",
      datum,
      titel: `${konzern ? "Konzernabschluss" : "Jahresabschluss"} ${jahr}`,
      text: p.employeeCount != null ? `${p.employeeCount.toLocaleString("de-DE")} Mitarbeitende` : null,
      quelle: { text: "Finanzen", url: "#financials" },
      frage: `Was sagt der ${konzern ? "Konzernabschluss" : "Jahresabschluss"} ${jahr} von ${firmaLink}? Fasse Lage, Ergebnis und Risiken zusammen.`,
      marke: true,
    });
  }
  return aus;
}

/** Alle Einträge, jüngstes zuerst; gleiche Kennung nur einmal. */
export function zusammenfuehren(listen: Eintrag[][]): Eintrag[] {
  const gesehen = new Set<string>();
  const alle: Eintrag[] = [];
  for (const l of listen) {
    for (const e of l) {
      if (gesehen.has(e.id) || !Number.isFinite(Date.parse(e.datum))) continue;
      gesehen.add(e.id);
      alle.push(e);
    }
  }
  alle.sort((a, b) => Date.parse(b.datum) - Date.parse(a.datum));
  return alle;
}

// ---- Datum -----------------------------------------------------------------

/** „heute“, „gestern“, „vor 3 Tagen“, „vor 2 Wochen“, „vor 3 Monaten“, „vor 2 Jahren“. */
export function relativ(iso: string, jetzt = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const tage = Math.floor((jetzt - t) / 86_400_000);
  if (tage < 0) return `am ${new Date(t).toLocaleDateString("de-DE")}`;
  if (tage === 0) return "heute";
  if (tage === 1) return "gestern";
  if (tage < 14) return `vor ${tage} Tagen`;
  if (tage < 60) return `vor ${Math.round(tage / 7)} Wochen`;
  if (tage < 365) {
    const monate = Math.round(tage / 30.4);
    return monate === 1 ? "vor einem Monat" : `vor ${monate} Monaten`;
  }
  const jahre = Math.round(tage / 365.25);
  return jahre === 1 ? "vor einem Jahr" : `vor ${jahre} Jahren`;
}

/** Genauer Zeitpunkt für den Tooltip; mit `von` als Fenster. */
export function genau(e: Pick<Eintrag, "datum" | "von" | "zeitHinweis">): string {
  const d = new Date(e.datum);
  const hatZeit = /T\d{2}:\d{2}/.test(e.datum) && !/T00:00:00/.test(e.datum);
  const text = hatZeit ? d.toLocaleString("de-DE", { dateStyle: "long", timeStyle: "short" }) : d.toLocaleDateString("de-DE", { dateStyle: "long" });
  if (e.von && Number.isFinite(Date.parse(e.von))) {
    return `Bemerkt am ${text}. Der alte Stand war zuletzt am ${new Date(e.von).toLocaleDateString("de-DE", { dateStyle: "long" })} bestätigt; die Änderung liegt dazwischen.`;
  }
  return e.zeitHinweis ? `${text}. ${e.zeitHinweis}` : text;
}

/** Zwischentitel: die letzten zwölf Monate je Monat, alles davor je Jahr. */
export function gruppe(iso: string, jetzt = Date.now()): { schluessel: string; titel: string } {
  const d = new Date(iso);
  const n = new Date(jetzt);
  const monateHer = (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth());
  if (monateHer < 12) {
    return { schluessel: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, titel: d.toLocaleDateString("de-DE", { month: "long", year: "numeric" }) };
  }
  return { schluessel: String(d.getFullYear()), titel: String(d.getFullYear()) };
}

// ---- Hook für den Reiter ---------------------------------------------------------------

export function useZeitachse(id: string, o: { an: boolean; ohneRegister: boolean; country: string | null | undefined; websiteUrl: string | null; firmaLink: string }) {
  const quellen = useZeitachseQuellen(id, o.an, o.ohneRegister);
  const { register, stand, profil, personal, insolvenz, meldung, recherche, notiz, abschluss } = quellen;
  const gerichtPraefix = !o.country || o.country === "DE";
  const eintraege = useMemo(
    () =>
      zusammenfuehren([
        eintraegeNotizen(notiz.data ?? [], o.firmaLink),
        eintraegePersonal(personal.data ?? [], o.firmaLink),
        eintraegeRegister(register.data ?? [], stand.data, o.country, o.firmaLink),
        eintraegeProfil(profil.data ?? [], o.country, o.firmaLink),
        eintraegeInsolvenz(insolvenz.data, o.country, gerichtPraefix, o.firmaLink),
        eintraegeMeldungen(meldung.data ?? [], o.websiteUrl, o.firmaLink),
        eintraegeRecherche(recherche.data ?? [], o.firmaLink),
        eintraegeAbschluesse(abschluss.data ?? [], o.firmaLink),
      ]),
    [notiz.data, personal.data, register.data, stand.data, profil.data, insolvenz.data, meldung.data, recherche.data, abschluss.data, o.country, o.websiteUrl, o.firmaLink, gerichtPraefix],
  );
  return { quellen, eintraege };
}
