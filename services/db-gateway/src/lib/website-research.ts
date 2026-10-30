// Stellen, Karriereseite und Expansionen/Ausschreibungen einer Firma aus der
// Website-DB (docs/PLAN_RECHERCHE_PERSIST.md). Uebergang: liegt in der Website-DB
// nichts, wird einmal in der Evaluation-DB nachgesehen (Altbestand bis zur
// Migration R5b) — danach entfaellt der Rueckfall samt Evaluation-Pool.
import type pg from "pg";
import { getProducerPool } from "./producer-pools";
import { logger as basisLogger } from "./logger";

export type RechercheStelle = {
  id: string;
  title: string;
  location: string | null;
  workingModel: string | null;
  description: string | null;
  requirements: string[];
  technologies: string[];
  benefits: string[];
  sourceUrl: string;
  releaseDate: string | null;
  createdAt: string;
  updatedAt: string;
};
export type RechercheExpansion = {
  id: string;
  type: string;
  title: string;
  company: string | null;
  country: string | null;
  value: string | null;
  date: string | null;
  url: string;
  citations: string[];
  createdAt: string;
  updatedAt: string;
};
export type RechercheKarriere = { benefits: string[]; quelleUrl: string | null; auszug: string | null; updatedAt: string };
export type WebsiteRecherche = {
  jobPostings: RechercheStelle[];
  deepResearches: RechercheExpansion[];
  karriere: RechercheKarriere | null;
  /** "website" oder "evaluation" (Altbestand) — nur fuer Logs. */
  quelle: "website" | "evaluation" | "leer";
};

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

async function lese(pool: pg.Pool, companyId: string): Promise<Omit<WebsiteRecherche, "quelle">> {
  const jobs = await pool
    .query<Record<string, unknown>>(
      `SELECT id, title, location, "workingModel", description, requirements, technologies,
              COALESCE(benefits, ARRAY[]::text[]) AS benefits, "sourceUrl", "releaseDate", "createdAt", "updatedAt"
         FROM "JobPosting" WHERE "companyId" = $1 ORDER BY "releaseDate" DESC NULLS LAST, "createdAt" DESC LIMIT 50`,
      [companyId],
    )
    .catch(() => ({ rows: [] as Record<string, unknown>[] }));
  const expansion = await pool
    .query<Record<string, unknown>>(
      `SELECT id, type::text AS type, title, company, country, value, date, url, citations, "createdAt", "updatedAt"
         FROM "DeepResearch" WHERE "companyId" = $1 AND type::text <> 'NONE' ORDER BY "createdAt" DESC LIMIT 50`,
      [companyId],
    )
    .catch(() => ({ rows: [] as Record<string, unknown>[] }));
  const karriere = await pool
    .query<{ benefits: string[]; quelleUrl: string | null; auszug: string | null; updatedAt: Date }>(
      `SELECT benefits, "quelleUrl", auszug, "updatedAt" FROM "CompanyKarriere" WHERE "companyId" = $1`,
      [companyId],
    )
    .catch(() => ({ rows: [] as Array<{ benefits: string[]; quelleUrl: string | null; auszug: string | null; updatedAt: Date }> }));
  const k = karriere.rows[0];
  return {
    jobPostings: jobs.rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ""),
      location: (r.location as string | null) ?? null,
      workingModel: (r.workingModel as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      requirements: (r.requirements as string[] | null) ?? [],
      technologies: (r.technologies as string[] | null) ?? [],
      benefits: (r.benefits as string[] | null) ?? [],
      sourceUrl: String(r.sourceUrl ?? ""),
      releaseDate: iso(r.releaseDate),
      createdAt: iso(r.createdAt) ?? "",
      updatedAt: iso(r.updatedAt) ?? "",
    })),
    deepResearches: expansion.rows.map((r) => ({
      id: String(r.id),
      type: String(r.type ?? ""),
      title: String(r.title ?? ""),
      company: (r.company as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      value: (r.value as string | null) ?? null,
      date: (r.date as string | null) ?? null,
      url: String(r.url ?? ""),
      citations: (r.citations as string[] | null) ?? [],
      createdAt: iso(r.createdAt) ?? "",
      updatedAt: iso(r.updatedAt) ?? "",
    })),
    karriere: k ? { benefits: k.benefits ?? [], quelleUrl: k.quelleUrl, auszug: k.auszug, updatedAt: k.updatedAt.toISOString() } : null,
  };
}

export async function ladeWebsiteRecherche(companyId: string, logger: typeof basisLogger = basisLogger): Promise<WebsiteRecherche> {
  const aktuell = await lese(getProducerPool("website"), companyId);
  if (aktuell.jobPostings.length || aktuell.deepResearches.length || aktuell.karriere) return { ...aktuell, quelle: "website" };
  // Uebergang (bis R5b): Altbestand in der Evaluation-DB.
  try {
    const alt = await lese(getProducerPool("company-evaluation"), companyId);
    if (alt.jobPostings.length || alt.deepResearches.length || alt.karriere) return { ...alt, quelle: "evaluation" };
  } catch (err) {
    logger.warn({ companyId, err: err instanceof Error ? err.message : String(err) }, "[website-research] Altbestand nicht lesbar");
  }
  return { ...aktuell, quelle: "leer" };
}
