// Einmalige Bereinigung (2026-10-10): abgeleitete E-Mail-Adressen (Quelle pattern:* /
// zuordnung:*), deren Domain nicht zur Website ihrer Firma passt, auf INACTIVE setzen –
// wie nach einer Unzustellbarkeit. Ursache: AVA nahm die Domain einer anderen Firma
// derselben Person als Muster (vorname@quikk.de bei Strategic IT). Danach leitet die
// korrigierte AVA (v0.1.807) neu ab.
//
// Auf der Gateway-Maschine (nutzt DATABASE_URL, nur Datenbanken des Clusters):
//   fly ssh console -a ava-db-gateway -C "sh -c 'cat > /app/_b.cjs && cd /app && node _b.cjs [--anwenden]; rm -f /app/_b.cjs'" < diese-datei
// Ohne --anwenden: nur Liste (Trockenlauf).
const { Client } = require("pg");
const ANWENDEN = process.argv.includes("--anwenden");
/** Bestaetigte Aliasdomains je Website-Domain (stimmen inhaltlich). */
const ALIAS = { "frankfurt.de": ["stadt-frankfurt.de"] };
const db = (n) => { const u = new URL(process.env.DATABASE_URL); u.pathname = "/" + n; return new Client({ connectionString: u.toString() }); };
const reg = (h) => { if (!h) return null; try { h = h.includes("/") || h.includes(":") ? new URL(h.startsWith("http") ? h : "https://" + h).hostname : h; } catch { return null; } const t = h.toLowerCase().replace(/^www\./, "").split("."); return t.length < 2 ? null : t.slice(-2).join("."); };
(async () => {
  const c = db("ava_company_contact"), p = db("ava_company_profile");
  await c.connect(); await p.connect();
  const r = await c.query(`SELECT f.id, f.value, o."companyId", co.name, co."websiteUrl", o.source FROM "Fact" f JOIN "Observation" o ON o.id = f."lastObsId" JOIN "Company" co ON co.id = o."companyId" WHERE f.field = 'email' AND f.status = 'ACTIVE' AND (o.source LIKE 'pattern:%' OR o.source LIKE 'zuordnung:%')`);
  const prof = await p.query(`SELECT id, url FROM "CompanyProfile" WHERE id = ANY($1::text[])`, [[...new Set(r.rows.map((x) => x.companyId))]]);
  const url = new Map(prof.rows.map((x) => [x.id, x.url]));
  const weg = r.rows.filter((x) => {
    const w = reg(x.websiteUrl) ?? reg(url.get(x.companyId)), d = reg(x.value.split("@")[1]);
    return w && d !== w && !(ALIAS[w] ?? []).includes(d);
  });
  for (const x of weg) console.log(`${ANWENDEN ? "deaktiviert" : "würde deaktivieren"}: ${x.name} · ${x.value} (${x.source})`);
  if (ANWENDEN && weg.length) {
    await c.query("BEGIN");
    const u = await c.query(`UPDATE "Fact" SET status = 'INACTIVE' WHERE id = ANY($1::text[]) AND status = 'ACTIVE'`, [weg.map((x) => x.id)]);
    await c.query("COMMIT");
    console.log(`\n${u.rowCount} Adressen deaktiviert.`);
  } else console.log(`\n${weg.length} Adressen betroffen (Trockenlauf, nichts geändert).`);
  await c.end(); await p.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
