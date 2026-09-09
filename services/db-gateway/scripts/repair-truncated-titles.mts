// Reparatur Altbestand (2026-09-09): Die Titel-Regex in
// contact-extraction/sanitize-person.ts schnitt bis v4f92cc0 Wortanfaenge ab
// ("Managing Director" → "naging Director", "Medizinischer Leiter" →
// "izinischer Leiter"). Rohwerte sind nicht gespeichert (die Observations
// erhielten den bereits bereinigten Wert), daher Rekonstruktion: fehlendes
// Praefix aus der Titel-Liste davorsetzen und nur uebernehmen, wenn das
// erste Wort danach ein bekanntes Berufs-/Funktionswort ist.
//
// Betroffene Tabellen (Datenbank ava_company_contact):
//   Employment.title · Fact(field=jobTitle).value/normalized ·
//   Observation(field=jobTitle).value/normalized/hash
//
// Aufruf (ueber den MPG-Proxy, Passwort NUR per Umgebungsvariable):
//   PGPASSWORD=... node --import tsx scripts/repair-truncated-titles.mts            # Vorschau (nur lesen)
//   PGPASSWORD=... node --import tsx scripts/repair-truncated-titles.mts --apply    # schreiben (eine Transaktion)

import pg from "pg";
import { createHash } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const url =
  process.env.CONTACT_DATABASE_URL ??
  `postgres://fly-user:${encodeURIComponent(process.env.PGPASSWORD ?? "")}@localhost:16380/ava_company_contact`;

const PREFIXES = ["Ma", "Med", "Dr", "Ing", "Ba", "Mag", "Prof", "Jur"];
const WHITELIST = new Set(
  [
    "managing", "management", "manager", "managerin", "marketing", "market", "markt", "material", "materials", "master",
    "machine", "maintenance", "manufacturing", "maschinen", "maschinenbau", "mathematiker", "mathematikerin",
    "medizinischer", "medizinische", "medizinisch", "medizin", "mediziner", "medizinerin", "medien", "media", "medical",
    "bauleiter", "bauleiterin", "bauleitung", "bauingenieur", "bauingenieurin",
    "ingenieur", "ingenieurin", "drucker", "druck", "magister", "professor", "professorin", "professional", "jurist", "juristin",
  ].map((w) => w.toLowerCase()),
);

function rekonstruiere(v: string): string | null {
  if (!/^[a-zäöü]/.test(v)) return null;
  for (const p of PREFIXES) {
    const kandidat = p + v;
    const erstesWort = kandidat.split(/[\s,;/\-]+/)[0]!.toLowerCase();
    if (WHITELIST.has(erstesWort)) return kandidat;
  }
  return null;
}

const normalize = (v: string): string => v.replace(/\s+/g, " ").trim();
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    const emp = await client.query<{ id: string; title: string }>(`SELECT id, title FROM "Employment" WHERE title ~ '^[a-zäöü]' ORDER BY title`);
    const fact = await client.query<{ id: string; value: string }>(`SELECT id, value FROM "Fact" WHERE field = 'jobTitle' AND value ~ '^[a-zäöü]'`);
    const obs = await client.query<{ id: string; value: string; entityType: string; entityId: string; field: string; source: string; evidenceUrl: string | null }>(
      `SELECT id, value, "entityType", "entityId", field, source, "evidenceUrl" FROM "Observation" WHERE field = 'jobTitle' AND value ~ '^[a-zäöü]'`,
    );

    const plan = { emp: [] as Array<{ id: string; alt: string; neu: string }>, fact: [] as Array<{ id: string; alt: string; neu: string }>, obs: [] as Array<{ id: string; alt: string; neu: string; hash: string }> };
    const unklar = new Map<string, number>();
    for (const r of emp.rows) {
      const neu = rekonstruiere(r.title);
      if (neu) plan.emp.push({ id: r.id, alt: r.title, neu });
      else unklar.set(r.title, (unklar.get(r.title) ?? 0) + 1);
    }
    for (const r of fact.rows) {
      const neu = rekonstruiere(r.value);
      if (neu) plan.fact.push({ id: r.id, alt: r.value, neu });
    }
    for (const r of obs.rows) {
      const neu = rekonstruiere(r.value);
      if (!neu) continue;
      const hash = sha256([r.entityType, r.entityId, r.field, normalize(neu), r.source, r.evidenceUrl ?? ""].join("|"));
      plan.obs.push({ id: r.id, alt: r.value, neu, hash });
    }

    const zusammen = new Map<string, { neu: string; n: number }>();
    for (const e of plan.emp) {
      const z = zusammen.get(e.alt) ?? { neu: e.neu, n: 0 };
      z.n++;
      zusammen.set(e.alt, z);
    }
    console.log(`\nVorschau ${APPLY ? "(WIRD ANGEWENDET)" : "(nur lesen)"} — Employment: ${plan.emp.length}, Fact.jobTitle: ${plan.fact.length}, Observation.jobTitle: ${plan.obs.length}\n`);
    for (const [alt, z] of [...zusammen.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(z.n).padStart(3)} × "${alt}"  →  "${z.neu}"`);
    if (unklar.size > 0) {
      console.log(`\nNicht geaendert (kein bekanntes Praefix/Wort — vermutlich korrekt kleingeschrieben):`);
      for (const [v, n] of unklar) console.log(`  ${String(n).padStart(3)} × "${v}"`);
    }
    if (!APPLY) {
      console.log(`\nKeine Aenderung geschrieben. Mit --apply anwenden.`);
      return;
    }
    await client.query("BEGIN");
    for (const e of plan.emp) await client.query(`UPDATE "Employment" SET title = $2 WHERE id = $1`, [e.id, e.neu]);
    // Fact ist eindeutig je (entityType, entityId, field, normalized): Gibt es
    // den korrigierten Wert schon (spaeterer, korrekter Lauf), wird der
    // abgeschnittene Fakt in den bestehenden gemerged (Links umhaengen,
    // Duplikat loeschen) statt eine Kollision zu erzeugen.
    let factGemerged = 0;
    for (const f of plan.fact) {
      const norm = normalize(f.neu);
      const dup = await client.query<{ id: string }>(
        `SELECT g.id FROM "Fact" g JOIN "Fact" f ON f.id = $1 WHERE g.id <> f.id AND g."entityType" = f."entityType" AND g."entityId" = f."entityId" AND g.field = f.field AND g.normalized = $2 LIMIT 1`,
        [f.id, norm],
      );
      const ziel = dup.rows[0]?.id;
      if (ziel) {
        await client.query(`INSERT INTO "FactObservationLink" (id, "factId", "observationId") SELECT gen_random_uuid()::text, $2, "observationId" FROM "FactObservationLink" WHERE "factId" = $1 ON CONFLICT ("factId", "observationId") DO NOTHING`, [f.id, ziel]);
        await client.query(`INSERT INTO "FactSignalLink" (id, "factId", "signalId") SELECT gen_random_uuid()::text, $2, "signalId" FROM "FactSignalLink" WHERE "factId" = $1 ON CONFLICT ("factId", "signalId") DO NOTHING`, [f.id, ziel]);
        await client.query(`DELETE FROM "FactObservationLink" WHERE "factId" = $1`, [f.id]);
        await client.query(`DELETE FROM "FactSignalLink" WHERE "factId" = $1`, [f.id]);
        await client.query(`UPDATE "Fact" SET "firstSeen" = LEAST("firstSeen", (SELECT "firstSeen" FROM "Fact" WHERE id = $1)) WHERE id = $2`, [f.id, ziel]);
        await client.query(`DELETE FROM "Fact" WHERE id = $1`, [f.id]);
        factGemerged++;
      } else {
        await client.query(`UPDATE "Fact" SET value = $2, normalized = $3 WHERE id = $1`, [f.id, f.neu, norm]);
      }
    }
    // Observation ist eindeutig je hash: existiert die korrigierte Beobachtung
    // schon, wird die abgeschnittene geloescht (Links zuerst).
    let obsGeloescht = 0;
    for (const o of plan.obs) {
      const dup = await client.query<{ id: string }>(`SELECT id FROM "Observation" WHERE hash = $1 AND id <> $2 LIMIT 1`, [o.hash, o.id]);
      if (dup.rows[0]) {
        await client.query(`DELETE FROM "FactObservationLink" WHERE "observationId" = $1`, [o.id]);
        await client.query(`DELETE FROM "Observation" WHERE id = $1`, [o.id]);
        obsGeloescht++;
      } else {
        await client.query(`UPDATE "Observation" SET value = $2, normalized = $3, hash = $4 WHERE id = $1`, [o.id, o.neu, normalize(o.neu), o.hash]);
      }
    }
    await client.query("COMMIT");
    console.log(`\nAngewendet: Employment ${plan.emp.length}, Fact ${plan.fact.length} (davon ${factGemerged} in bestehenden korrekten Fakt gemerged), Observation ${plan.obs.length} (davon ${obsGeloescht} Duplikate entfernt).`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
