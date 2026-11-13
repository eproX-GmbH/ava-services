// Nur lesend: Zustimmung, Versandprotokoll und App-Aktivitaet fuer die Neuigkeiten-Mail
// (Burggraben 2, docs/PLAN_BURGGRABEN.md). Laeuft auf der Gateway-Maschine:
//   B64=$(base64 < scripts/mail-stand.readonly.js | tr -d '\n')
//   fly ssh console -a ava-db-gateway -C "sh -c 'cd /app && echo $B64 | base64 -d > /tmp/q.js && node /tmp/q.js'"
// Optional: MAIL_STAND_EMAIL=... (Standard: joyce@%).
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, application_name: "mail-stand-readonly" });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  const muster = process.env.MAIL_STAND_EMAIL || "joyce@%";
  const konto = await c.query(
    `SELECT me."actorId", me.email, me.neuigkeiten, me."bestaetigtAt", me."abgemeldetAt", me."createdAt" AS "kontoSeit",
            na.geraet, na.version, na."zuletztAt", na."appZuletztAt"
       FROM "MailEinstellung" me LEFT JOIN "NutzerAktivitaet" na ON na."actorId" = me."actorId"
      WHERE me.email ILIKE $1`,
    [muster],
  );
  console.log("KONTO", JSON.stringify(konto.rows));
  const ids = konto.rows.map((r) => r.actorId);
  if (ids.length) {
    const v = await c.query(`SELECT art, status, fehler, "createdAt" FROM "MailVersand" WHERE "actorId" = ANY($1) ORDER BY "createdAt" DESC LIMIT 12`, [ids]);
    console.log("VERSAND", JSON.stringify(v.rows));
  }
  const alle = await c.query(`SELECT count(*)::int AS konten, count(*) FILTER (WHERE neuigkeiten AND "abgemeldetAt" IS NULL)::int AS zugestimmt FROM "MailEinstellung"`);
  const heute = await c.query(`SELECT art, status, count(*)::int AS n FROM "MailVersand" WHERE "createdAt" > NOW() - interval '36 hours' GROUP BY 1, 2`);
  const app = await c.query(`SELECT count(*)::int AS n, count("appZuletztAt")::int AS "mitApp", count(*) FILTER (WHERE "appZuletztAt" > NOW() - interval '24 hours')::int AS "appAktiv24h" FROM "NutzerAktivitaet"`);
  console.log("ALLE", JSON.stringify({ ...alle.rows[0], versand36h: heute.rows, aktivitaet: app.rows[0] }));
  await c.query("ROLLBACK");
  await c.end();
})().catch((e) => { console.error("FEHLER", e.message); process.exit(1); });
