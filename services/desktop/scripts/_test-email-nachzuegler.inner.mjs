// V4 (docs/PLAN_EMAIL_VERIFIZIERUNG.md): Der Hintergrund-Job ist Nachzuegler des
// Producers company-email — gemeinsamer Tages-Deckel, frische Live-Laeufe bleiben
// unangetastet. Netz ist "nicht erreichbar" gesetzt: kein echter SMTP-Verkehr.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const load = async (p) => { const m = await import(p); return m.default && typeof m.default === "object" && Object.keys(m.default).length > 0 ? m.default : m; };
const { EmailMusterSupervisor } = await load("../src/main/contacts/email-muster/supervisor.ts");

const heute = new Date().toISOString().slice(0, 10);

function aufbau({ musterAntwort, budget }) {
  const dir = mkdtempSync(join(tmpdir(), "email-nachzuegler-"));
  // Netz frisch als gesperrt: kein pruefePort25, keine SMTP-Verbindung.
  writeFileSync(join(dir, "email-muster.json"), JSON.stringify({ netz: { erreichbar: false, grund: "Test", at: new Date().toISOString() } }));
  if (budget !== undefined) writeFileSync(join(dir, "email-budget.json"), JSON.stringify({ day: heute, count: budget }));
  const posts = [];
  const gatewayRequest = async (path, opts) => {
    if (path.startsWith("/v1/companies/matrix")) return { companies: [{ companyId: "c1" }] };
    if (path === "/v1/companies/c1/contacts")
      return {
        companyName: "Muster GmbH",
        websiteUrl: "https://muster.de",
        employments: [{ personId: "p1" }, { personId: "p2" }],
        companyObservations: [],
        companyFacts: [
          { status: "ACTIVE", entityType: "PERSON", personId: "p1", field: "fullName", value: "Anna Meier" },
          { status: "ACTIVE", entityType: "PERSON", personId: "p1", field: "email", value: "anna.meier@muster.de" },
          { status: "ACTIVE", entityType: "PERSON", personId: "p2", field: "fullName", value: "Bernd Kunz" },
        ],
      };
    if (path.startsWith("/v1/email-patterns/") && (opts?.method ?? "GET") === "GET") {
      if (!musterAntwort) throw new Error("404");
      return musterAntwort;
    }
    if (path.endsWith("/derived-email")) posts.push(opts.body);
    return {};
  };
  const sup = new EmailMusterSupervisor({ gatewayRequest, isSignedIn: () => true, isLlmBusy: () => false, isOnBattery: () => false, audit: () => {}, log: () => {}, urteil: null }, dir);
  return { sup, posts, dir };
}

// 1. Frischer Live-Lauf des Producers: Domain bleibt ihm ueberlassen.
{
  const { sup, posts } = aufbau({ musterAntwort: { muster: "vorname.nachname", konfidenz: 0.6, catchAllAt: null, checkedAt: new Date().toISOString(), stats: { quelle: "live" } } });
  const outcome = await sup.tick(false);
  assert.equal(posts.length, 0, `frischer Live-Lauf: nichts nachholen (${outcome})`);
}

// 2. Live-Lauf aelter als die Schonfrist: Nachzuegler leitet ab (hier unverifiziert, Netz gesperrt).
{
  const { sup, posts } = aufbau({ musterAntwort: { muster: "vorname.nachname", konfidenz: 0.6, catchAllAt: null, checkedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), stats: { quelle: "live" } } });
  await sup.tick(false);
  assert.equal(posts.length, 1, "alter Live-Lauf: Nachzuegler arbeitet");
  assert.equal(posts[0].email, "bernd.kunz@muster.de");
  assert.equal(posts[0].art, "offen");
}

// 3. Manuell ausgeloest: Schonfrist gilt nicht.
{
  const { sup, posts } = aufbau({ musterAntwort: { muster: "vorname.nachname", konfidenz: 0.6, catchAllAt: null, checkedAt: new Date().toISOString(), stats: { quelle: "live" } } });
  // runNow prueft Port 25 neu; hier direkt den manuellen Tick ohne Netzpruefung nachstellen.
  sup.getConfig().netz = { erreichbar: false, grund: "Test", at: new Date().toISOString() };
  await sup.pruefeFirma("c1", sup.getConfig(), true);
  assert.equal(posts.length, 1, "manuell: wird bearbeitet");
}

// 4. Gemeinsamer Tages-Deckel: hat der Producer ihn verbraucht, pausiert der Job.
{
  const { sup, posts } = aufbau({ musterAntwort: null, budget: 50 });
  const outcome = await sup.tick(false);
  assert.match(outcome, /Tages-Deckel/);
  assert.equal(posts.length, 0);
  assert.equal(sup.getConfig().tag.count, 50, "Anzeige zeigt den gemeinsamen Stand");
}

// 5. Uebergang: ein alter Tageszaehler geht ins gemeinsame Budget ein.
{
  const { sup, dir } = aufbau({ musterAntwort: null });
  sup.getConfig().tag = { day: heute, count: 7 };
  await sup.tick(false);
  assert.equal(JSON.parse(readFileSync(join(dir, "email-budget.json"), "utf8")).count, 7);
}

console.log("email-nachzuegler: alle Pruefungen bestanden");
