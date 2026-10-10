// Doppelte Personen (Befund 2026-10-10 QUIKK: „Christian“ mit linkedin.com/in/christiankrebel
// und „Christian Krebel“ ohne Profil): Regeln, Zusammenführen, Rücknahme gegen PGlite.
import { readFileSync } from "node:fs";
for (const datei of ["../.env", "../.env.example"]) {
  let t = ""; try { t = readFileSync(new URL(datei, import.meta.url), "utf8"); } catch { continue; }
  for (const z of t.split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(z.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
}
const m = await import("../src/lib/contact-extraction/personen-abgleich.ts");
const A = m.default ?? m;
const { PGlite } = await import("@electric-sql/pglite");
let fehler = 0;
const ok = (b, t) => { console.log(`${b ? "✓" : "✗"} ${t}`); if (!b) fehler++; };

// ---- Regeln ----
const t = A.namensTokens;
ok(A.namenVertraeglich(t("Christian"), t("Christian Krebel")) && A.namenVertraeglich(t("Erina B."), t("Erina Buck")), "verträgliche Namen (Vorname, Initiale)");
ok(!A.namenVertraeglich(t("Christian Rolf"), t("Christian Buck")), "verschiedene Nachnamen sind unverträglich");
const P = (id, name, x = {}) => ({ id, fullName: name, createdAt: x.at ?? "2026-01-01", tokens: t(name), profile: x.profile ?? [], slugs: x.slugs ?? [], mailsBelegt: x.mails ?? [], titel: null, abteilung: null, beschreibung: null, quellen: [] });
const christian = P("c1", "Christian", { profile: ["https://www.linkedin.com/in/christiankrebel"], slugs: ["christiankrebel"] });
const krebel = P("c2", "Christian Krebel", { at: "2026-02-01" });
const paar = A.sicherePaare([christian, krebel])[0];
ok(paar?.regel === "profil-name" && paar.behalten.id === "c2" && paar.aufloesen.id === "c1", "QUIKK-Fall: Slug = voller Name → zusammen, voller Name bleibt");
ok(A.sicherePaare([P("a", "Anna Meier", { slugs: ["annameier4a1b2c"], profile: ["x"] }), P("b", "Anna Meier", { at: "2026-03-01" })])[0]?.regel === "profil-name", "Slug mit Kennungsanhang");
ok(A.sicherePaare([P("a", "Christian", { slugs: ["christianrolf"], profile: ["p1"] }), P("b", "Christian Buck", { profile: ["p2"] })]).length === 0, "Slug passt nicht / Profile widersprechen → nichts");
ok(A.sicherePaare([P("a", "Heiko Zimmer", { profile: ["p"] }), P("b", "Dr. Heiko Zimmer", { profile: ["p"] })])[0]?.regel === "gleiches-profil", "gleiches Profil");
ok(A.sicherePaare([P("a", "Nils", { mails: ["nils@firma.de"] }), P("b", "Nils Frohloff", { mails: ["nils@firma.de"] })])[0]?.regel === "gleiche-mail", "gleiche belegte Adresse");
const k1 = A.urteilsKandidaten([P("n", "Niklas"), P("m", "Niklas Meyer"), P("c", "Christoph")]);
ok(k1.length === 1 && k1[0].vorname.id === "n" && k1[0].voll.id === "m", "Stufe 2: Vorname mit genau einem Gegenstück");
ok(A.urteilsKandidaten([P("n", "Niklas"), P("m", "Niklas Meyer"), P("o", "Niklas Otto")]).length === 0, "Stufe 2: zwei Gegenstücke → kein Kandidat");
ok(A.urteilsKandidaten([P("n", "Niklas", { profile: ["p1"] }), P("m", "Niklas Meyer", { profile: ["p2"] })]).length === 0, "Stufe 2: widersprechende Profile → kein Kandidat");

// ---- Zusammenführen gegen PGlite ----
const db = new PGlite();
await db.exec(`
CREATE TABLE "Person" (id text primary key, "fullName" text not null, "createdAt" timestamp default now(), "updatedAt" timestamp default now());
CREATE TABLE "Company" (id text primary key, name text);
CREATE TABLE "Employment" (id text primary key, "personId" text, "companyId" text, title text, department text, "startDate" timestamp, "isCurrent" boolean default true, "lastSeen" timestamp default now(), UNIQUE ("personId", "companyId", title, "startDate"));
CREATE TABLE "EmploymentSource" (id text primary key, "employmentId" text, source text);
CREATE TABLE "Observation" (id text primary key, "entityType" text, "entityId" text, "personId" text, "companyId" text, field text, value text, source text, hash text unique);
CREATE TABLE "Fact" (id text primary key, "entityType" text, "entityId" text, "personId" text, "companyId" text, field text, value text, normalized text, status text default 'ACTIVE', "lastObsId" text, UNIQUE ("entityType", "entityId", field, normalized));
CREATE TABLE "SignalEvent" (id text primary key, "entityType" text, "entityId" text, "personId" text, type text);
INSERT INTO "Company" VALUES ('q', 'QUIKK Software GmbH');
INSERT INTO "Person" VALUES ('c1', 'Christian', '2026-01-01'), ('c2', 'Christian Krebel', '2026-02-01'), ('n1', 'Niklas', '2026-01-01');
INSERT INTO "Employment" VALUES ('e1', 'c1', 'q', 'Frontend & Apps', null, null), ('e2', 'c2', 'q', null, null, null), ('e3', 'n1', 'q', 'Backend & RAG', null, null);
INSERT INTO "EmploymentSource" VALUES ('s1', 'e1', 'search:linkedin_lookup');
INSERT INTO "Observation" VALUES ('o1', 'PERSON', 'c1', 'c1', 'q', 'linkedinUrl', 'https://www.linkedin.com/in/christiankrebel', 'search:linkedin_lookup', 'h1'), ('o2', 'PERSON', 'c2', 'c2', 'q', 'email', 'christian@quikk.de', 'pattern:offen', 'h2');
INSERT INTO "Fact" VALUES
 ('f1', 'PERSON', 'c1', 'c1', 'q', 'fullName', 'Christian', 'christian', 'ACTIVE', 'o1'),
 ('f2', 'PERSON', 'c1', 'c1', 'q', 'linkedinUrl', 'https://www.linkedin.com/in/christiankrebel', 'https://www.linkedin.com/in/christiankrebel', 'ACTIVE', 'o1'),
 ('f3', 'PERSON', 'c1', 'c1', 'q', 'identityKey', 'url:https://www.linkedin.com/in/christiankrebel', 'url:https://www.linkedin.com/in/christiankrebel', 'ACTIVE', 'o1'),
 ('f4', 'PERSON', 'c1', 'c1', 'q', 'jobTitle', 'Frontend & Apps', 'frontend & apps', 'ACTIVE', 'o1'),
 ('f5', 'PERSON', 'c2', 'c2', 'q', 'fullName', 'Christian Krebel', 'christian krebel', 'ACTIVE', 'o2'),
 ('f6', 'PERSON', 'c2', 'c2', 'q', 'email', 'christian@quikk.de', 'christian@quikk.de', 'ACTIVE', 'o2'),
 ('f7', 'PERSON', 'c2', 'c2', 'q', 'jobTitle', 'Frontend & Apps', 'frontend & apps', 'ACTIVE', 'o2'),
 ('f8', 'PERSON', 'n1', 'n1', 'q', 'fullName', 'Niklas', 'niklas', 'ACTIVE', null);
`);
const pool = { query: (s, p) => db.query(s, p), connect: async () => ({ query: (s, p) => db.query(s, p), release: () => {} }) };
const vorher = JSON.stringify((await db.query(`SELECT * FROM "Fact" ORDER BY id`)).rows);
const personen = await A.personenDerFirma(pool, "q");
const p1 = A.sicherePaare(personen);
ok(p1.length === 1 && p1[0].behalten.id === "c2" && p1[0].regel === "profil-name", "aus der Datenbank: Christian ↔ Christian Krebel erkannt");
const r = await A.zusammenfuehren(pool, { companyId: "q", behaltenId: "c2", aufloesenId: "c1", regel: "profil-name", grund: "test" });
const nachher = (await db.query(`SELECT id, "personId", status FROM "Fact" ORDER BY id`)).rows;
const nach = Object.fromEntries(nachher.map((x) => [x.id, x]));
ok(r.behaltenName === "Christian Krebel", "voller Name bleibt");
ok(nach.f2.personId === "c2" && nach.f3.personId === "c2", "Profil und Identitätsschlüssel hängen an der verbleibenden Person");
ok(!nach.f4 && nach.f7.personId === "c2", "doppelte Position gelöscht (gesichert), eine bleibt");
ok(nach.f1.personId === "c2" && nach.f1.status === "INACTIVE", "Kurzname wird inaktiv");
const emp = (await db.query(`SELECT * FROM "Employment" WHERE "companyId" = 'q' ORDER BY id`)).rows;
ok(emp.length === 2 && emp.find((e) => e.id === "e2").title === "Frontend & Apps" && !emp.find((e) => e.id === "e1"), "eine Beschäftigung, Titel übernommen");
ok((await db.query(`SELECT "employmentId" FROM "EmploymentSource" WHERE id = 's1'`)).rows[0].employmentId === "e2", "Quelle der Beschäftigung umgehängt");
ok((await db.query(`SELECT "personId" FROM "Observation" WHERE id = 'o1'`)).rows[0].personId === "c2", "Belege umgehängt");
ok((await A.personenDerFirma(pool, "q")).length === 2, "bei QUIKK stehen nur noch zwei Personen");

const zurueck = await A.zuruecknehmen(pool, r.id);
const wieder = JSON.stringify((await db.query(`SELECT * FROM "Fact" ORDER BY id`)).rows);
ok(zurueck && wieder === vorher, "Rücknahme stellt alle Fakten exakt wieder her");
ok((await A.personenDerFirma(pool, "q")).length === 3 && (await db.query(`SELECT title FROM "Employment" WHERE id = 'e2'`)).rows[0].title === null, "Rücknahme: drei Personen, Titel wie vorher");
ok((await A.zuruecknehmen(pool, r.id)) === null, "zweite Rücknahme tut nichts");

console.log(fehler ? `\n${fehler} Fehler` : "\nAlle Prüfungen grün.");
process.exit(fehler ? 1 : 0);
