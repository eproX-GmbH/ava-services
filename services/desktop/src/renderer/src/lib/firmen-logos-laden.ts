// Logos fuer Listen und Chat-Bausteine (docs/PLAN_FIRMENLOGOS.md, LG4): Jede Zeile fragt nach
// "ihrem" Logo, gesammelt wird zu EINER Gateway-Abfrage je Augenblick (statt einer je Zeile).
// Fehlt die Route (aelteres Gateway) oder scheitert der Abruf, bleibt es beim Kuerzel.

import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";
import type { FirmenLogos, LogoAngabe } from "../components/FirmenLogo";

type Abruf = (ids: string[]) => Promise<unknown>;

/** Nur was wie eine Logo-Angabe aussieht, kommt durch (Antwort eines anderen Dienstes). */
function angabe(roh: unknown): LogoAngabe | null {
  if (!roh || typeof roh !== "object") return null;
  const r = roh as Record<string, unknown>;
  if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  const zahl = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return {
    sha256: r.sha256,
    ...(typeof r.mime === "string" ? { mime: r.mime } : {}),
    breite: zahl(r.breite),
    hoehe: zahl(r.hoehe),
    klein: r.klein === true,
    ...(typeof r.stufe === "string" ? { stufe: r.stufe } : {}),
  };
}

export function logosAusAntwort(roh: unknown): Map<string, NonNullable<FirmenLogos>> {
  const out = new Map<string, NonNullable<FirmenLogos>>();
  const logos = roh && typeof roh === "object" ? (roh as { logos?: unknown }).logos : null;
  if (!logos || typeof logos !== "object") return out;
  for (const [id, eintrag] of Object.entries(logos as Record<string, unknown>)) {
    if (!eintrag || typeof eintrag !== "object") continue;
    const zeichen = angabe((eintrag as { zeichen?: unknown }).zeichen);
    const wortmarke = angabe((eintrag as { wortmarke?: unknown }).wortmarke);
    if (zeichen || wortmarke) out.set(id, { ...(zeichen ? { zeichen } : {}), ...(wortmarke ? { wortmarke } : {}) });
  }
  return out;
}

/**
 * Sammelt Einzelanfragen eines Augenblicks zu einer Abfrage (hoechstens `max` Firmen je Abfrage).
 * Nach einem Fehler ruht der Sammler `pauseMs` lang und antwortet solange mit "kein Logo":
 * Ein Gateway ohne die Route soll nicht bei jeder Zeile neu gefragt werden.
 */
export function logoSammler(abruf: Abruf, { warteMs = 20, max = 100, pauseMs = 5 * 60_000, jetzt = () => Date.now() } = {}) {
  let wartend = new Map<string, Array<(l: FirmenLogos) => void>>();
  let zeit: ReturnType<typeof setTimeout> | null = null;
  let ruhtBis = 0;

  async function los() {
    zeit = null;
    const stapel = wartend;
    wartend = new Map();
    const ids = [...stapel.keys()];
    for (let i = 0; i < ids.length; i += max) {
      const teil = ids.slice(i, i + max);
      let gefunden = new Map<string, NonNullable<FirmenLogos>>();
      if (jetzt() >= ruhtBis) {
        try {
          gefunden = logosAusAntwort(await abruf(teil));
        } catch {
          ruhtBis = jetzt() + pauseMs;
        }
      }
      for (const id of teil) for (const fertig of stapel.get(id) ?? []) fertig(gefunden.get(id) ?? null);
    }
  }

  return function logosFuer(companyId: string): Promise<FirmenLogos> {
    if (!companyId || jetzt() < ruhtBis) return Promise.resolve(null);
    return new Promise<FirmenLogos>((fertig) => {
      const liste = wartend.get(companyId) ?? [];
      liste.push(fertig);
      wartend.set(companyId, liste);
      if (!zeit) zeit = setTimeout(() => void los(), warteMs);
    });
  };
}

const sammler = logoSammler((companyIds) =>
  gatewayFetch<unknown>("/v1/companies/logos/batch", { method: "POST", body: { companyIds }, ohneKontingentDialog: true }),
);

/** Firmen, die AVA nicht als eigene Firma kennt (z. B. LinkedIn-Fremdfirmen), haben kein Logo. */
function hatFirmenId(companyId: string | null | undefined): companyId is string {
  return typeof companyId === "string" && companyId.length > 0 && !companyId.includes(":");
}

/**
 * Logos einer Firma fuer Listen und Bausteine. `bekannt` (auch null) erspart die Abfrage.
 * `laedt` gilt nur fuer den allerersten Abruf: Solange bleibt die Flaeche leer, statt erst das
 * Kuerzel und einen Augenblick spaeter das Logo zu zeigen.
 */
export function useFirmenLogos(companyId: string | null | undefined, bekannt?: FirmenLogos): { logos: FirmenLogos; laedt: boolean } {
  const fragen = bekannt === undefined && hatFirmenId(companyId);
  const q = useQuery({
    queryKey: ["firmen-logos", companyId],
    queryFn: () => sammler(companyId as string),
    enabled: fragen,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (bekannt !== undefined) return { logos: bekannt, laedt: false };
  return { logos: q.data ?? null, laedt: fragen && q.isPending };
}
