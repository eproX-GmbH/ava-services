// docs/PLAN_PRICING_TIERS.md P1 — tagesanteiliges Monatskontingent je Nutzer.
import assert from "node:assert/strict";
const { kontingentAusZeitraeumen, monatsGrenzen } = await import("../src/lib/kontingent-rechnung.ts");
const { planEintrag } = await import("../src/lib/billing-plans.ts");

const nov = "2026-11";
const jetzt = new Date("2026-11-20T12:00:00Z");
const d = (s) => new Date(s);
const pro = planEintrag("pro").kontingentCents;
const max = planEintrag("max").kontingentCents;

assert.equal(monatsGrenzen(nov).tage, 30);
assert.equal(monatsGrenzen("2026-02").tage, 28);

// Kein Zeitraum → Free, 0.
assert.deepEqual(kontingentAusZeitraeumen([], nov, jetzt), { kontingentCents: 0, planHeute: "free", anteilig: false });

// Ganzer Monat Pro → volles Kontingent.
assert.deepEqual(kontingentAusZeitraeumen([{ plan: "pro", ab: d("2026-10-03T00:00:00Z"), bis: null }], nov, jetzt), { kontingentCents: pro, planHeute: "pro", anteilig: false });

// Einstieg am 16.11. (15 von 30 Tagen) → halbes Pro-Kontingent, anteilig.
const halb = kontingentAusZeitraeumen([{ plan: "pro", ab: d("2026-11-16T00:00:00Z"), bis: null }], nov, jetzt);
assert.equal(halb.kontingentCents, Math.round(pro / 2));
assert.equal(halb.anteilig, true);

// Upgrade am 28.11. von Pro auf Max: 27 Tage Pro + 3 Tage Max — kein volles Max-Kontingent (Missbrauchsschutz).
const up = kontingentAusZeitraeumen(
  [
    { plan: "pro", ab: d("2026-10-01T00:00:00Z"), bis: d("2026-11-28T00:00:00Z") },
    { plan: "max", ab: d("2026-11-28T00:00:00Z"), bis: null },
  ],
  nov,
  new Date("2026-11-29T00:00:00Z"),
);
assert.equal(up.kontingentCents, Math.round((pro * 27 + max * 3) / 30));
assert.equal(up.planHeute, "max");
assert.equal(up.anteilig, true);
assert.ok(up.kontingentCents < max && up.kontingentCents > pro);

// Enterprise → kein Kontingent (Vertrag).
assert.deepEqual(kontingentAusZeitraeumen([{ plan: "enterprise", ab: d("2026-01-01T00:00:00Z"), bis: null }], nov, jetzt), { kontingentCents: null, planHeute: "enterprise", anteilig: false });

// Zeitraum endete im Vormonat → zaehlt nicht.
assert.deepEqual(kontingentAusZeitraeumen([{ plan: "pro", ab: d("2026-09-01T00:00:00Z"), bis: d("2026-10-31T00:00:00Z") }], nov, jetzt).kontingentCents, 0);

console.log("test-kontingent: ok");
