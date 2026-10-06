// Kunden und Referenzen einer Firma (docs/PLAN_KUNDEN.md, K2).
//
//   GET  /companies/{companyId}/kunden
//   POST /kunden/suche            Umkehrsuche: wer nennt X als Kunden?
//
// Liest die vom Kontakt-Producer erkannten Kunden/Partner und gleicht sie
// gegen die Stammdaten ab — mit demselben Weg wie das Firmenradar: Dry-Run
// der Data-Care-Zuordnung (unscharf) in master-data. Das Ergebnis wird je
// Zeile gespeichert und nach 30 Tagen erneut geprueft; so kostet der Abgleich
// nur beim ersten Lesen etwas. Hoechstens 40 ungepruefte Namen je Aufruf.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { listeKunden, listeNennungen, setzeMatch, type KundeRow } from "../../lib/kunden";
import { buildXlsx } from "../../lib/xlsx-mini";
import { callUpstreamBinaryExpectJson } from "../../lib/upstream";
import { logger } from "../../lib/logger";
import { ErrorShape } from "./schemas";

export const companiesKundenRouter = new OpenAPIHono();
companiesKundenRouter.use("*", requireScope("company:read"));

const tag = "companies";
const PRUEFUNG_GUELTIG_MS = 30 * 86_400_000;
const MAX_ABGLEICH = 40;

const KundeShape = z.object({
  id: z.string(),
  name: z.string(),
  art: z.enum(["kunde", "partner", "referenzprojekt"]),
  beleg: z.string().nullable(),
  quelle: z.string().nullable(),
  konfidenz: z.string().nullable(),
  erstGesehen: z.string(),
  zuletztGesehen: z.string(),
  match: z.object({ companyId: z.string(), name: z.string(), location: z.string().nullable() }).nullable(),
});

const route = createRoute({
  method: "get",
  path: "/companies/{companyId}/kunden",
  tags: [tag],
  summary: "Kunden, Partner und Referenzprojekte laut Website, mit Stammdaten-Abgleich",
  request: {
    params: z.object({ companyId: z.string().min(1).openapi({ param: { name: "companyId", in: "path" } }) }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(KundeShape) }) } }, description: "ok" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
    403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  },
});

type Treffer = { companyId: string; name: string; location: string | null };

/** Vergleichsform ohne Rechtsform: „AUDI AG“ und „Audi“ treffen sich. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|ag|se|b\.?v|s\.?a|corp|co|kg|mbh|ohg|e\.?v)\b\.?/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Abgleich wie im Radar: Dry-Run der unscharfen Zuordnung in master-data.
 * `matched` sind exakte Treffer (Name + Ort); ohne Ort landet fast alles in
 * `unmatched` mit Kandidaten nach Suchtreffer. Ein Kandidat gilt, wenn sein
 * Name (ohne Rechtsform) mit dem genannten Kunden beginnt — „Audi“ findet
 * „AUDI AG“, aber nicht „Audio Service GmbH“ wegen des Wortendes.
 */
async function gleicheAb(
  c: Parameters<typeof callUpstreamBinaryExpectJson>[0],
  zeilen: KundeRow[],
): Promise<Map<string, Treffer | null>> {
  const out = new Map<string, Treffer | null>();
  if (zeilen.length === 0) return out;
  try {
    const xlsx = buildXlsx({ headers: ["company", "city"], rows: zeilen.map((z) => [z.name, ""]) });
    const { body } = await callUpstreamBinaryExpectJson(c, "masterData", "/api/v1/data-care", xlsx, {
      contentType: "application/octet-stream",
      query: { companyNameIdentifiers: "company", isFuzzy: "true", dryRun: "true" },
    });
    const preview = body as {
      matched?: Array<{ name: string; location: string; companyId: string }>;
      unmatched?: Array<{
        name: string;
        location: string;
        candidates: Array<{ companyId: string; name: string; location: string; score: number }>;
      }>;
    };
    const exakt = new Map<string, Treffer>();
    for (const m of preview.matched ?? []) {
      exakt.set(norm(m.name), { companyId: m.companyId, name: m.name, location: m.location ?? null });
    }
    const kandidaten = new Map<string, Treffer | null>();
    for (const u of preview.unmatched ?? []) {
      const n = norm(u.name);
      const passend = (u.candidates ?? []).find((k) => {
        const kn = norm(k.name);
        // Wortgrenze: nach dem Kundennamen muss der Kandidat enden oder ein
        // Wort beginnen (im Original), sonst ist „Audi“ auch „Audio …“.
        if (kn === n) return true;
        if (!kn.startsWith(n) || n.length < 3) return false;
        const rest = k.name.slice(k.name.toLowerCase().indexOf(u.name.toLowerCase()) + u.name.length);
        return /^[\s\-–,.&(]/.test(rest) || rest.length === 0;
      });
      kandidaten.set(n, passend ? { companyId: passend.companyId, name: passend.name, location: passend.location ?? null } : null);
    }
    for (const z of zeilen) {
      const n = norm(z.name);
      out.set(z.id, exakt.get(n) ?? kandidaten.get(n) ?? null);
    }
  } catch (err) {
    logger.warn({ err }, "kunden: stammdaten-abgleich fehlgeschlagen (best-effort)");
  }
  return out;
}

companiesKundenRouter.openapi(route, async (c) => {
  const { companyId } = c.req.valid("param");
  const zeilen = await listeKunden(companyId);
  const jetzt = Date.now();
  const offen = zeilen
    .filter((z) => !z.matchGeprueftAt || jetzt - new Date(z.matchGeprueftAt).getTime() > PRUEFUNG_GUELTIG_MS)
    .slice(0, MAX_ABGLEICH);
  if (offen.length > 0) {
    const ergebnisse = await gleicheAb(c, offen);
    for (const z of offen) {
      // Abgleich ausgefallen: nicht als geprueft markieren, naechstes Mal erneut.
      if (!ergebnisse.has(z.id)) continue;
      const m = ergebnisse.get(z.id) ?? null;
      z.match = m;
      try {
        await setzeMatch(z.id, m);
      } catch (err) {
        logger.warn({ err, id: z.id }, "kunden: match speichern fehlgeschlagen");
      }
    }
  }
  return c.json(
    {
      items: zeilen.map((z) => ({
        id: z.id,
        name: z.name,
        art: z.art,
        beleg: z.beleg,
        quelle: z.quelle,
        konfidenz: z.konfidenz,
        erstGesehen: z.erstGesehen,
        zuletztGesehen: z.zuletztGesehen,
        match: z.match,
      })),
    },
    200,
  );
});

// ---- Umkehrsuche --------------------------------------------------------------
//
// „Wer nennt X als Kunden?“ ueber die Firmenliste des Aufrufers (seine
// eigenen Firmen, wie beim Neuheiten-Endpunkt). Trifft ueber den
// Stammdaten-Treffer oder den genannten Namen.

const SucheBody = z.object({
  companyIds: z.array(z.string().min(1)).min(1).max(500),
  name: z.string().trim().min(2).max(120).optional(),
  zielCompanyId: z.string().min(1).optional(),
});

const NennungShape = KundeShape.extend({ companyId: z.string() });

const sucheRoute = createRoute({
  method: "post",
  path: "/kunden/suche",
  tags: [tag],
  summary: "Umkehrsuche: welche Firmen nennen eine Firma als Kunde, Partner oder Referenz",
  request: { body: { content: { "application/json": { schema: SucheBody } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ items: z.array(NennungShape) }) } }, description: "ok" },
    400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
    403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  },
});

companiesKundenRouter.openapi(sucheRoute, async (c) => {
  const { companyIds, name, zielCompanyId } = c.req.valid("json");
  if (!name && !zielCompanyId) {
    return c.json({ error: "bad_request", message: "name oder zielCompanyId angeben" }, 400);
  }
  const zeilen = await listeNennungen({ companyIds: Array.from(new Set(companyIds)), name, zielCompanyId });
  return c.json(
    {
      items: zeilen.map((z) => ({
        id: z.id,
        companyId: z.companyId,
        name: z.name,
        art: z.art,
        beleg: z.beleg,
        quelle: z.quelle,
        konfidenz: z.konfidenz,
        erstGesehen: z.erstGesehen,
        zuletztGesehen: z.zuletztGesehen,
        match: z.match,
      })),
    },
    200,
  );
});
