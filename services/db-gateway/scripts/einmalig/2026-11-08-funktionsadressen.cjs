// Einmalige Bereinigung (2026-11-08, PM-2026-0010): abgeleitete Personenadressen
// (Quelle pattern:* / zuordnung:*), die eine Funktionsadresse sind (info@, kontakt@ …)
// oder in derselben Firma bei mehreren Personen gleich lauten, auf INACTIVE setzen.
// Dazu geteilte Adressmuster ohne Namensbezug ("info") leeren. Ursache: das KI-Urteil
// bekam info@ontras.com als Beleg und lieferte die Vorlage "info" — damit bekam jede
// Person der Firma info@ontras.com. Der Fix (2ac245fd) verhindert das kuenftig; die
// naechste Verarbeitung leitet fuer die Personen neu ab.
//
// Auf der Gateway-Maschine (nutzt DATABASE_URL, nur Datenbanken des Clusters):
//   fly ssh console -a ava-db-gateway -C "sh -c 'cat > /app/_b.cjs && cd /app && node _b.cjs [--anwenden]; rm -f /app/_b.cjs'" < diese-datei
// Ohne --anwenden: nur Liste (Trockenlauf).
const { Client } = require("pg");
const ANWENDEN = process.argv.includes("--anwenden");
// Spiegel von packages/email-muster/src/pattern.ts (FUNKTIONS_LOCALS, MUSTER-Ids).
const FUNKTION = new Set(["info", "kontakt", "contact", "hello", "hallo", "office", "mail", "post", "hr", "ir", "pr", "presse", "press", "vertrieb", "sales", "support", "service", "kundenservice", "buchhaltung", "rechnung", "invoice", "bewerbung", "jobs", "karriere", "career", "careers", "marketing", "team", "admin", "webmaster", "postmaster", "noreply", "no-reply", "newsletter", "anfrage", "anfragen", "zentrale", "empfang", "verwaltung", "datenschutz", "privacy", "legal", "recht", "einkauf", "purchasing", "export", "import", "shop", "bestellung", "order", "orders", "welcome"]);
const MUSTER_IDS = new Set(["vorname.nachname", "v.nachname", "vnachname", "vorname", "nachname", "vorname_nachname", "vornamenachname", "nachname.vorname", "v-nachname", "vorname-nachname", "nachname.v", "nachnamev", "nachname_vorname", "vn"]);
const istFunktion = (email) => { const l = (email.split("@")[0] || "").toLowerCase().trim(); return !l || FUNKTION.has(l) || /^(info|kontakt|office|mail|service|support|vertrieb|sales|hr|presse|jobs|karriere)[-_.]/.test(l); };
const musterOk = (m) => MUSTER_IDS.has(m) || /\{(vorname|nachname)\}/i.test(m);
const db = (n) => { const u = new URL(process.env.DATABASE_URL); if (n) u.pathname = "/" + n; return new Client({ connectionString: u.toString() }); };
(async () => {
  const c = db("ava_company_contact"), g = db(null);
  await c.connect(); await g.connect();
  const r = await c.query(
    `SELECT f.id, f.value, f."personId", f."scopeCompanyId", co.name, o.source
       FROM "Fact" f JOIN "Observation" o ON o.id = f."lastObsId" LEFT JOIN "Company" co ON co.id = f."scopeCompanyId"
      WHERE f.field = 'email' AND f.status = 'ACTIVE' AND f."entityType" = 'PERSON'
        AND (o.source LIKE 'pattern:%' OR o.source LIKE 'zuordnung:%')`,
  );
  const jeAdresse = new Map();
  for (const x of r.rows) {
    const k = `${x.scopeCompanyId}|${x.value.toLowerCase()}`;
    jeAdresse.set(k, (jeAdresse.get(k) || new Set()).add(x.personId));
  }
  const weg = r.rows.filter((x) => istFunktion(x.value) || jeAdresse.get(`${x.scopeCompanyId}|${x.value.toLowerCase()}`).size > 1);
  const jeFirma = new Map();
  for (const x of weg) { const k = `${x.name || x.scopeCompanyId} · ${x.value.toLowerCase()}`; jeFirma.set(k, (jeFirma.get(k) || 0) + 1); }
  for (const [k, n] of [...jeFirma.entries()].sort((a, b) => b[1] - a[1])) console.log(`${ANWENDEN ? "deaktiviert" : "würde deaktivieren"}: ${k} — ${n} Person(en)`);

  const m = await g.query(`SELECT "domain", "muster" FROM "EmailPattern" WHERE "muster" IS NOT NULL`);
  const muster = m.rows.filter((x) => !musterOk(x.muster));
  for (const x of muster) console.log(`${ANWENDEN ? "geleert" : "würde leeren"}: Muster ${x.domain} = "${x.muster}"`);

  if (ANWENDEN && (weg.length || muster.length)) {
    await c.query("BEGIN");
    const u = await c.query(`UPDATE "Fact" SET status = 'INACTIVE', "deactivatedAt" = now(), "deactivatedReason" = 'funktionsadresse' WHERE id = ANY($1::text[]) AND status = 'ACTIVE'`, [weg.map((x) => x.id)]);
    await c.query("COMMIT");
    const v = await g.query(`UPDATE "EmailPattern" SET "muster" = NULL, "konfidenz" = 0 WHERE "domain" = ANY($1::text[])`, [muster.map((x) => x.domain)]);
    console.log(`\n${u.rowCount} Adressen deaktiviert, ${v.rowCount} Muster geleert.`);
  } else console.log(`\n${weg.length} Adressen bei ${new Set(weg.map((x) => x.scopeCompanyId)).size} Firmen und ${muster.length} Muster betroffen (Trockenlauf, nichts geändert).`);
  await c.end(); await g.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
