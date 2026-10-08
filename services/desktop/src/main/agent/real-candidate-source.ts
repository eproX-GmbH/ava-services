import type { GatewayClient } from "./gateway-client";
import type { CandidateSource, HeartbeatCandidate } from "./heartbeat";

// Kandidatenquelle des Heartbeats (2026-10-05, Neufassung).
//
// Vorher: 20 juengste Transaktionen → deren Firmen → je Firma drei
// Einzelabfragen. Befund bei Patrick: die 20 juengsten Transaktionen
// (Verflechtungen, Einzelrecherchen) deckten 7 von 43 Firmen; fuer 36
// Firmen konnte es nie einen Alarm geben. Dieselbe Luecke hatte die
// Auffrischung (v0.1.748) — jetzt gehen beide ueber die Firmenliste.
//
// Jetzt: Firmenliste des Nutzers (/v1/companies/matrix, seitenweise) →
// POST /v1/alerts/neuheiten in Buendeln → EIN Antwortstrom mit allem,
// was sich seit dem letzten Takt getan hat:
//
//   profile-change   Geschaeftsfuehrer, Name, Rechtsform, Adresse,
//                    Stammkapital, Gegenstand (aus dem Register)
//   publication      neu eingegangene Jahresabschluesse/Publikationen
//   contact-change   Stellenwechsel, Arbeitgeberwechsel, geaenderte
//                    Firmen-Telefon/-E-Mail (Kontakt-Signale)
//   new-contacts     neue Ansprechpartner je Firma, gebuendelt
//
// Bewertet wird weiterhin lokal durch den Alarm-Judge mit dem Profil des
// Nutzers ("Was koennte ihn interessieren?"). Hier wird nur eingesammelt
// und in die Kandidatenform gebracht. Ohne `since` (erster Takt nach dem
// Start) deckelt das Gateway auf 30 Tage; Dedup ueber sourceRef faengt
// Wiederholungen ab.

const MATRIX_SEITE = 200;
const MAX_MATRIX_SEITEN = 50;
const BUENDEL = 300;
/** Obergrenze je Takt; der Heartbeat sortiert nach Relevanz und kappt
 *  weiter (maxPerTick). Was hier abgeschnitten wird, kommt im naechsten
 *  Takt wieder, solange das 30-Tage-Fenster es traegt. */
const MAX_CANDIDATES = 200;

interface MatrixZeile {
  companyId: string;
  name?: string | null;
  held?: boolean;
}

interface VolumeShape {
  value?: number | null;
  currency?: string | null;
}

type Neuheit =
  | {
      art: "profile-change";
      id: string;
      companyId: string;
      kind: string;
      added: Array<Record<string, unknown>>;
      removed: Array<Record<string, unknown>>;
      occurredAt: string;
      bestandVon?: string | null;
    }
  | {
      art: "publication";
      id: string;
      companyId: string;
      name: string | null;
      year: number | null;
      begin: string | null;
      end: string | null;
      employeeCount: number | null;
      revenueVolume: VolumeShape | null;
      salesVolume: VolumeShape | null;
      totalAssetsVolume: VolumeShape | null;
      stateOfAffairs: { value: string } | null;
      createdAt: string;
      updatedAt: string;
    }
  | {
      art: "contact-change";
      id: string;
      companyId: string;
      typ: "job-changed" | "employer-changed" | "company-phone-changed" | "company-email-changed";
      personName: string | null;
      title: string | null;
      before: string | null;
      after: string | null;
      occurredAt: string;
      seit?: string | null;
      bekanntSeit?: string | null;
      vorherGesehenAm?: string | null;
    }
  | {
      art: "new-customers";
      id: string;
      companyId: string;
      anzahl: number;
      kunden: Array<{ name: string; art: string; match: { companyId: string; name: string; location: string | null } | null }>;
      occurredAt: string;
    }
  | {
      art: "new-contacts";
      id: string;
      companyId: string;
      anzahl: number;
      personen: Array<{ name: string; title: string | null; seit?: string | null }>;
      occurredAt: string;
    };

/** „seit 2009“ / „seit 03/2026“ aus einem ISO-Datum. */
function seitText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Der Gateway-Persist legt „2009“ als 1. Januar ab; nur ein anderer
  // Monat ist wirklich belegt.
  const m = d.getUTCMonth() + 1;
  return m !== 1 ? `${String(m).padStart(2, "0")}/${d.getUTCFullYear()}` : String(d.getUTCFullYear());
}

/** Zeitfenster „zwischen A und B“ fuer den Judge, tagesgenau. */
function fensterText(von: string | null | undefined, bis: string): string {
  const b = bis.slice(0, 10);
  return von ? `zwischen ${von.slice(0, 10)} und ${b}` : `bis ${b}, Beginn unbekannt`;
}

export function buildRealCandidateSource(
  gateway: GatewayClient,
): CandidateSource {
  return async (since: Date | null) => {
    const firmen = await ladeFirmenliste(gateway);
    if (firmen.size === 0) return [];
    const ids = [...firmen.keys()];
    const out: HeartbeatCandidate[] = [];
    for (let i = 0; i < ids.length && out.length < MAX_CANDIDATES; i += BUENDEL) {
      const teil = ids.slice(i, i + BUENDEL);
      let items: Neuheit[] = [];
      try {
        const r = await gateway.request<{ items?: Neuheit[] }>("/v1/alerts/neuheiten", {
          method: "POST",
          body: { companyIds: teil, since: since ? since.toISOString() : null },
        });
        items = r.items ?? [];
      } catch (err) {
        console.warn(
          `[real-source] neuheiten-buendel ${i / BUENDEL + 1} fehlgeschlagen:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      for (const n of items) {
        if (out.length >= MAX_CANDIDATES) break;
        const name = firmen.get(n.companyId) ?? `${n.companyId.slice(0, 12)}…`;
        const c = kandidatAus(n, name, firmen);
        if (c) out.push(c);
      }
    }
    return out;
  };
}

/**
 * Firmenliste des Nutzers: companyId → Name. Gehaltene (held) Firmen
 * bleiben drin — Alarme sind kein Verarbeitungsschritt.
 */
export async function ladeFirmenliste(gateway: GatewayClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let seite = 1; seite <= MAX_MATRIX_SEITEN; seite++) {
    const r = await gateway.request<{ companies?: MatrixZeile[] }>(
      "/v1/companies/matrix",
      { query: { pageNumber: seite, pageSize: MATRIX_SEITE } },
    );
    const teil = r.companies ?? [];
    for (const z of teil) {
      if (!z.companyId) continue;
      out.set(z.companyId, (z.name ?? "").trim() || z.companyId);
    }
    if (teil.length < MATRIX_SEITE) break;
  }
  return out;
}

/**
 * v0.1.479 — Firmen des Nutzers einsammeln (Watchlist-Bestands-Rotation).
 * Seit 2026-10-05 aus der Firmenliste statt aus Transaktionen.
 */
export async function collectTenantCompanyIds(
  gateway: GatewayClient,
  maxCompanies = 200,
): Promise<string[]> {
  const firmen = await ladeFirmenliste(gateway);
  return [...firmen.keys()].slice(0, maxCompanies);
}

// ---- Kandidatenform --------------------------------------------------------

const PROFIL_KIND_TEXT: Record<string, string> = {
  name: "Firmenname",
  "legal-form": "Rechtsform",
  address: "Anschrift",
  "share-capital": "Stammkapital",
  purpose: "Unternehmensgegenstand",
};

export function kandidatAus(
  n: Neuheit,
  companyName: string,
  /** companyId → Name der eigenen Firmenliste; ein neuer Kunde, der selbst
   *  eine eigene Firma ist, wiegt im Vertrieb besonders (Wettbewerber oder
   *  Partner bedient den eigenen Kunden). */
  eigeneFirmen?: Map<string, string>,
): HeartbeatCandidate | null {
  switch (n.art) {
    case "new-customers": {
      const liste = n.kunden
        .map((k) => {
          const eigene = k.match && eigeneFirmen?.has(k.match.companyId);
          const zusatz = [k.art !== "kunde" ? k.art : null, eigene ? "in deinen Firmen" : null].filter(Boolean).join(", ");
          return zusatz ? `${k.name} (${zusatz})` : k.name;
        })
        .join(", ");
      const rest = n.anzahl - n.kunden.length;
      const eigeneTreffer = n.kunden.filter((k) => k.match && eigeneFirmen?.has(k.match.companyId)).map((k) => k.match!.companyId);
      return {
        kind: "customer-change",
        companyId: n.companyId,
        companyName,
        sourceRef: `new-customers:${n.id}`,
        occurredAt: n.occurredAt,
        summary: `${companyName} nennt ${n.anzahl} neue Kunden/Referenzen auf der Website: ${liste}${rest > 0 ? ` und ${rest} weitere` : ""}.`,
        payload: {
          typ: "new-customers",
          anzahl: n.anzahl,
          kunden: n.kunden,
          eigeneFirmenDarunter: eigeneTreffer,
          source: "website",
        },
      };
    }
    case "profile-change": {
      if (n.kind.startsWith("managing-directors")) {
        // K4: kind "managing-directors:konzernabschluss 2023" = Abgleich des
        // Konzernabschlusses gegen das Register (Namen, die der Abschluss
        // nennt und das Register nicht kennt, bzw. Austritte laut Abschluss).
        const ausAbschluss = n.kind.startsWith("managing-directors:konzernabschluss");
        const quelleText = ausAbschluss ? `laut ${n.kind.slice("managing-directors:".length)}` : "laut Handelsregister";
        const fmt = (list: Array<Record<string, unknown>>): string[] =>
          list
            .map((p) => `${String(p.firstName ?? "")} ${String(p.lastName ?? "")}`.trim())
            .filter((x) => x.length > 0);
        const added = fmt(n.added);
        const removed = fmt(n.removed);
        if (added.length === 0 && removed.length === 0) return null;
        const parts: string[] = [];
        if (added.length > 0) parts.push(`neu: ${added.join(", ")}`);
        if (removed.length > 0) parts.push(`ausgeschieden: ${removed.join(", ")}`);
        return {
          kind: "profile-change",
          companyId: n.companyId,
          companyName,
          sourceRef: `profile-change:${n.id}`,
          occurredAt: n.occurredAt,
          summary: ausAbschluss
            ? `Geschäftsführung ${quelleText} bei ${companyName} weicht vom Handelsregister ab — ${parts.join("; ")}. Bitte im Register gegenprüfen.`
            : `Geschäftsführer-Wechsel laut Handelsregister bei ${companyName} — ${parts.join("; ")}. Eingetreten ${fensterText(n.bestandVon, n.occurredAt)}.`,
          payload: { aenderung: "managing-directors", added, removed, source: ausAbschluss ? "konzernabschluss" : "handelsregister", zeitfenster: fensterText(n.bestandVon, n.occurredAt) },
        };
      }
      const feld = PROFIL_KIND_TEXT[n.kind] ?? n.kind;
      const vorher = String(n.removed[0]?.value ?? "");
      const nachher = String(n.added[0]?.value ?? "");
      if (!nachher) return null;
      return {
        kind: "profile-change",
        companyId: n.companyId,
        companyName,
        sourceRef: `profile-change:${n.id}`,
        occurredAt: n.occurredAt,
        summary: `${feld} von ${companyName} laut Handelsregister geändert: „${vorher}“ → „${nachher}“. Eingetreten ${fensterText(n.bestandVon, n.occurredAt)}.`,
        payload: { aenderung: n.kind, vorher, nachher, source: "handelsregister", zeitfenster: fensterText(n.bestandVon, n.occurredAt) },
      };
    }
    case "publication": {
      const occurred = pickOccurredAt(n);
      if (!occurred) return null;
      return {
        kind: "publication",
        companyId: n.companyId,
        companyName,
        sourceRef: stableSourceRef(n.companyId, n),
        occurredAt: occurred.toISOString(),
        summary: summarisePublication(companyName, n),
        payload: {
          year: n.year ?? null,
          revenue: n.revenueVolume ?? null,
          sales: n.salesVolume ?? null,
          totalAssets: n.totalAssetsVolume ?? null,
          employees: n.employeeCount ?? null,
          stateOfAffairs: n.stateOfAffairs ?? null,
          period: n.begin && n.end ? `${n.begin} → ${n.end}` : null,
          eingegangenAm: n.createdAt,
        },
      };
    }
    case "contact-change": {
      const person = n.personName ?? "Eine Kontaktperson";
      let summary: string;
      switch (n.typ) {
        case "job-changed":
          summary = `${person} bei ${companyName} hat eine neue Funktion: „${n.before ?? "?"}“ → „${n.after ?? "?"}“.`;
          break;
        case "employer-changed":
          summary = `${person} (${n.title ?? "Funktion unbekannt"}) hat den Arbeitgeber gewechselt; ${companyName} ist betroffen.`;
          break;
        case "company-phone-changed":
          summary = `Zentrale Telefonnummer von ${companyName} geändert: ${n.before ?? "?"} → ${n.after ?? "?"}.`;
          break;
        default:
          summary = `Zentrale E-Mail-Adresse von ${companyName} geändert: ${n.before ?? "?"} → ${n.after ?? "?"}.`;
      }
      const seit = seitText(n.seit);
      const zeit =
        seit
          ? `Position belegt seit ${seit}.`
          : `Wechsel bemerkt ${fensterText(n.vorherGesehenAm, n.occurredAt)}.`;
      return {
        kind: "contact-change",
        companyId: n.companyId,
        companyName,
        sourceRef: `contact-change:${n.id}`,
        occurredAt: n.occurredAt,
        summary: `${summary} ${zeit}`,
        payload: {
          typ: n.typ, person: n.personName, title: n.title, vorher: n.before, nachher: n.after, source: "website",
          seit, bekanntSeit: n.bekanntSeit?.slice(0, 10) ?? null, zeitfenster: fensterText(n.vorherGesehenAm, n.occurredAt),
        },
      };
    }
    case "new-contacts": {
      const liste = n.personen
        .map((p) => {
          const s = seitText(p.seit);
          const t = [p.title, s ? `seit ${s}` : null].filter(Boolean).join(", ");
          return t ? `${p.name} (${t})` : p.name;
        })
        .join(", ");
      const rest = n.anzahl - n.personen.length;
      return {
        kind: "contact-change",
        companyId: n.companyId,
        companyName,
        sourceRef: `new-contacts:${n.id}`,
        occurredAt: n.occurredAt,
        summary: `${n.anzahl} neue Ansprechpartner bei ${companyName} erkannt: ${liste}${rest > 0 ? ` und ${rest} weitere` : ""}.`,
        payload: { typ: "new-contacts", anzahl: n.anzahl, personen: n.personen, source: "website" },
      };
    }
    default:
      return null;
  }
}

// ---- Helpers --------------------------------------------------------------

interface PubLike {
  name?: string | null;
  year: number | null;
  begin: string | null;
  end: string | null;
  createdAt: string;
  updatedAt: string;
  employeeCount: number | null;
  revenueVolume: VolumeShape | null;
  salesVolume: VolumeShape | null;
  totalAssetsVolume: VolumeShape | null;
  stateOfAffairs: { value: string } | null;
}

/** Berichtsperioden-Ende, sonst Jahr (31.12.), sonst Eingang. */
function pickOccurredAt(p: PubLike): Date | null {
  for (const v of [p.end, p.updatedAt, p.createdAt]) {
    if (typeof v === "string" && v.length > 0) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (typeof p.year === "number" && Number.isFinite(p.year)) {
    return new Date(Date.UTC(p.year, 11, 31));
  }
  return null;
}

/** Stabil ueber Takte hinweg (Dedup); unveraendert zur alten Quelle. */
function stableSourceRef(companyId: string, p: PubLike): string {
  return [
    "publication",
    companyId,
    String(p.year ?? "?"),
    p.begin ?? "",
    p.end ?? "",
    !p.begin && !p.end ? p.createdAt : "",
  ].join(":");
}

function summarisePublication(companyName: string, p: PubLike): string {
  const lines: string[] = [];
  const period =
    p.year != null
      ? `Geschäftsjahr ${p.year}`
      : p.begin && p.end
        ? `Berichtsperiode ${p.begin} → ${p.end}`
        : "Publikation";
  lines.push(`${period} – ${companyName}.`);
  // K1: Konzernabschluss benennen; Kennzahlen darin sind Angaben zur Muttergesellschaft.
  if (/konzern/i.test(p.name ?? "")) lines.push("Konzernabschluss (Kennzahlen der Muttergesellschaft, Konzernsummen nur im Lagebericht).");
  if (p.revenueVolume?.value != null) lines.push(`Umsatz: ${fmtMoney(p.revenueVolume)}.`);
  else if (p.salesVolume?.value != null) lines.push(`Erlöse: ${fmtMoney(p.salesVolume)}.`);
  if (p.totalAssetsVolume?.value != null) lines.push(`Bilanzsumme: ${fmtMoney(p.totalAssetsVolume)}.`);
  if (p.employeeCount != null) lines.push(`Beschäftigte: ${p.employeeCount}.`);
  if (p.stateOfAffairs?.value) lines.push(`Lage: ${p.stateOfAffairs.value}.`);
  return lines.join(" ");
}

function fmtMoney(v: VolumeShape): string {
  if (v.value == null || !Number.isFinite(v.value)) return "";
  const formatted = new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(v.value);
  return `${formatted} ${v.currency ?? "EUR"}`;
}
