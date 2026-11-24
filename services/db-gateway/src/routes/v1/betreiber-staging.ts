// Staging/UAT (docs/PLAN_STAGING.md ST1): Betreiber steuert Konten, Test-Adressen, Weiche und
// Freigaben; jedes Konto liest seinen Kanal (Desktop-Kopfzeile, Update-Feed). Nur Betreiber
// (sonst 404) für alles unter /betreiber/staging und /betreiber/releases.
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { getGatewayPool } from "../../lib/producer-pools";
import { istBetreiber, type AuthContext } from "../../middleware/auth";
import { gatewayRolle, kanalLaden, kanalVon, routingAktiv, testZahlungFuer, versionVergleich, zugangVon, zahlungsmodusTest } from "../../lib/kanal";

export const betreiberStagingRouter = new OpenAPIHono();

const auth = (c: { get: (k: "auth") => unknown }) => c.get("auth") as AuthContext;
function nurBetreiber(c: { get: (k: "auth") => unknown }): AuthContext {
  const a = auth(c);
  if (!istBetreiber(a)) throw new HTTPException(404, { message: "not_found" });
  return a;
}
async function body<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) throw new HTTPException(400, { message: r.error.issues.map((i) => i.message).join("; ") });
  return r.data;
}

/** Kanal des eigenen Kontos (Desktop-Kopfzeile, App, Update-Feed). */
betreiberStagingRouter.get("/kanal", async (c) => {
  const a = auth(c);
  const pool = getGatewayPool();
  const r = await pool.query<{ version: string; status: string }>(`SELECT version, status FROM "AvaRelease" WHERE status <> 'verworfen'`);
  const frei = r.rows.filter((x) => x.status === "freigegeben").map((x) => x.version).sort(versionVergleich).at(-1) ?? null;
  const kandidat = r.rows.map((x) => x.version).sort(versionVergleich).at(-1) ?? null;
  const kanal = kanalVon(a.actorId);
  return c.json({
    kanal,
    gateway: gatewayRolle(),
    testZahlung: kanal === "staging" && testZahlungFuer(a.actorId),
    version: { prod: frei, staging: kandidat },
  });
});

/** Alles für die Konsolen-Seite „Staging“ in einem Abruf. */
betreiberStagingRouter.get("/betreiber/staging", async (c) => {
  nurBetreiber(c);
  const pool = getGatewayPool();
  const [konten, muster, releases, schalter, test] = await Promise.all([
    pool.query(
      `SELECT k."actorId", k.kanal, k."testZahlung", COALESCE(m.email, k.email) AS email, m.name, k.notiz, k.von, k."createdAt"
         FROM "KanalZugang" k LEFT JOIN "TenantMember" m ON m."actorId" = k."actorId" ORDER BY k."createdAt" DESC`,
    ),
    pool.query(`SELECT muster, notiz, von, "createdAt" FROM "TestAdressMuster" ORDER BY "createdAt" DESC`),
    pool.query(`SELECT version, status, commit, komponenten, notiz, von, "freigegebenAt", "createdAt" FROM "AvaRelease"`),
    pool.query<{ routing: boolean; von: string | null; updatedAt: Date }>(`SELECT routing, von, "updatedAt" FROM "StagingSchalter" WHERE id = 1`),
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "TenantBilling" WHERE "stripeModus" = 'test'`),
  ]);
  const rel = releases.rows.sort((x: { version: string }, y: { version: string }) => versionVergleich(y.version, x.version)).slice(0, 15);
  return c.json({
    schalter: { routing: schalter.rows[0]?.routing ?? false, wirksam: routingAktiv(), von: schalter.rows[0]?.von ?? null, seit: schalter.rows[0]?.updatedAt ?? null, stagingGateway: gatewayRolle() === "staging" || !!process.env.STAGING_GATEWAY_URL },
    konten: konten.rows,
    muster: muster.rows,
    releases: rel,
    testOrganisationen: Number(test.rows[0]?.n ?? 0),
  });
});

const KontoSchema = z.object({
  email: z.string().email().max(200).optional(),
  actorId: z.string().min(1).max(80).optional(),
  testZahlung: z.boolean().default(false),
  notiz: z.string().max(300).optional(),
}).refine((x) => x.email || x.actorId, { message: "email oder actorId angeben" });

betreiberStagingRouter.put("/betreiber/staging/konten", async (c) => {
  const a = nurBetreiber(c);
  const b = await body(c, KontoSchema);
  const pool = getGatewayPool();
  let actorId = b.actorId ?? null;
  let email = b.email ?? null;
  if (!actorId) {
    const r = await pool.query<{ actorId: string; email: string | null }>(`SELECT "actorId", email FROM "TenantMember" WHERE lower(email) = lower($1)`, [email]);
    if (r.rows.length > 1) throw new HTTPException(409, { message: "Adresse mehrdeutig" });
    if (r.rows[0]) {
      actorId = r.rows[0].actorId;
      email = r.rows[0].email;
    } else {
      // Registriert, aber noch nie in AVA angemeldet: Konto direkt in Keycloak nachsehen. Das
      // Testkonto ist dann ab seiner ersten Anmeldung im Staging.
      const { kontoNachEmail } = await import("../../lib/keycloak-admin");
      const k = await kontoNachEmail(email ?? "").catch(() => null);
      if (!k) throw new HTTPException(404, { message: "Kein Konto mit dieser Adresse (erst registrieren)" });
      actorId = k.id;
      email = k.email;
    }
  }
  await pool.query(
    `INSERT INTO "KanalZugang" ("actorId", kanal, "testZahlung", email, notiz, von) VALUES ($1, 'staging', $2, $3, $4, $5)
     ON CONFLICT ("actorId") DO UPDATE SET kanal = 'staging', "testZahlung" = $2, email = COALESCE($3, "KanalZugang".email),
       notiz = COALESCE($4, "KanalZugang".notiz), von = $5, "updatedAt" = now()`,
    [actorId, b.testZahlung, email, b.notiz ?? null, a.actorId],
  );
  await kanalLaden(pool);
  return c.json({ actorId, zugang: zugangVon(actorId!) });
});

betreiberStagingRouter.delete("/betreiber/staging/konten/:actorId", async (c) => {
  nurBetreiber(c);
  const pool = getGatewayPool();
  await pool.query(`DELETE FROM "KanalZugang" WHERE "actorId" = $1`, [c.req.param("actorId")]);
  await kanalLaden(pool);
  return c.json({ ok: true });
});

const MusterSchema = z.object({
  muster: z.string().min(3).max(200).regex(/^[^\s@]+@[^\s@]+$/, "Muster wie name+*@firma.de").refine((m) => !/^\*+@/.test(m), "Muster muss mit festem Text beginnen"),
  notiz: z.string().max(300).optional(),
});

betreiberStagingRouter.put("/betreiber/staging/muster", async (c) => {
  const a = nurBetreiber(c);
  const b = await body(c, MusterSchema);
  const pool = getGatewayPool();
  await pool.query(
    `INSERT INTO "TestAdressMuster" (muster, notiz, von) VALUES (lower($1), $2, $3) ON CONFLICT (muster) DO UPDATE SET notiz = $2, von = $3`,
    [b.muster.trim(), b.notiz ?? null, a.actorId],
  );
  await kanalLaden(pool);
  return c.json({ ok: true });
});

betreiberStagingRouter.delete("/betreiber/staging/muster", async (c) => {
  nurBetreiber(c);
  const muster = c.req.query("muster") ?? "";
  const pool = getGatewayPool();
  await pool.query(`DELETE FROM "TestAdressMuster" WHERE muster = lower($1)`, [muster]);
  await kanalLaden(pool);
  return c.json({ ok: true });
});

/** Weiche: an = Staging-Konten laufen über das Staging-Gateway; aus = alle über Prod (Notschalter). */
betreiberStagingRouter.put("/betreiber/staging/schalter", async (c) => {
  const a = nurBetreiber(c);
  const b = await body(c, z.object({ routing: z.boolean() }));
  if (b.routing && !process.env.STAGING_GATEWAY_URL && gatewayRolle() === "prod") {
    throw new HTTPException(409, { message: "Staging-Gateway ist noch nicht eingerichtet (STAGING_GATEWAY_URL fehlt)." });
  }
  const pool = getGatewayPool();
  await pool.query(`UPDATE "StagingSchalter" SET routing = $1, von = $2, "updatedAt" = now() WHERE id = 1`, [b.routing, a.actorId]);
  await kanalLaden(pool);
  return c.json({ routing: routingAktiv() });
});

/** Organisation auf Stripe-Testmodus (nur ohne Stripe-Kunde/-Abo). */
betreiberStagingRouter.put("/betreiber/staging/organisationen/:tenantId/testmodus", async (c) => {
  nurBetreiber(c);
  const ok = await zahlungsmodusTest(getGatewayPool(), c.req.param("tenantId"));
  if (!ok) throw new HTTPException(409, { message: "Die Organisation hat schon einen Stripe-Kunden oder ein Abo; Testmodus nicht möglich." });
  return c.json({ ok: true });
});

const FreigabeSchema = z.object({ notiz: z.string().max(500).optional() });

/** Kandidat für Produktion freigeben bzw. verwerfen. Die Auslieferung stößt ST6 an. */
betreiberStagingRouter.post("/betreiber/releases/:version/:aktion{freigeben|verwerfen}", async (c) => {
  const a = nurBetreiber(c);
  const version = c.req.param("version").replace(/^v/, "");
  const aktion = c.req.param("aktion");
  const b = await body(c, FreigabeSchema);
  const pool = getGatewayPool();
  const r = await pool.query<{ status: string }>(`SELECT status FROM "AvaRelease" WHERE version = $1`, [version]);
  if (!r.rows[0]) throw new HTTPException(404, { message: "Unbekannte Version" });
  if (r.rows[0].status !== "kandidat") throw new HTTPException(409, { message: `Version ist bereits ${r.rows[0].status}.` });
  // Vor dem Freigeben: Nähme der Prod-Deploy aus dem Tag neueren Gateway-Code zurück? Dann gar
  // nicht erst freigeben (sonst zögen Kunden-Server und Desktop nach, das Gateway aber zurück).
  if (aktion === "freigeben") {
    const { freigabePruefen } = await import("../../lib/freigabe");
    const p = await freigabePruefen(version);
    if (!p.ok) throw new HTTPException(409, { message: p.grund });
  }
  await pool.query(
    `UPDATE "AvaRelease" SET status = $2, von = $3, notiz = COALESCE($4, notiz), "freigegebenAt" = CASE WHEN $2 = 'freigegeben' THEN now() ELSE NULL END, "updatedAt" = now() WHERE version = $1`,
    [version, aktion === "freigeben" ? "freigegeben" : "verworfen", a.actorId, b.notiz ?? null],
  );
  let auslieferung: unknown = null;
  if (aktion === "freigeben") {
    const { freigabeAusliefern } = await import("../../lib/freigabe");
    auslieferung = await freigabeAusliefern(version, a.actorId).catch((err) => ({ ok: false, fehler: err instanceof Error ? err.message : String(err) }));
  }
  return c.json({ version, status: aktion === "freigeben" ? "freigegeben" : "verworfen", auslieferung });
});
