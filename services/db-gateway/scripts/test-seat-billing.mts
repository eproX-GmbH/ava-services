// B2 — Zaehlregeln (docs/PLAN_ABRECHNUNG_SEATS.md §3.2 Beispiele, §7 Katalog).
//
//   npx tsx scripts/test-seat-billing.ts
//
// DB-frei: prueft computeSeats()/tierAt() gegen die dokumentierten Faelle.

import assert from "node:assert/strict";

// Der Logger validiert die Gateway-Env beim Import; fuer den DB-freien
// Test reichen Platzhalter.
for (const k of ["DATABASE_URL", "UPSTREAM_MASTER_DATA_URL", "UPSTREAM_COMPANY_PROFILE_URL", "UPSTREAM_COMPANY_CONTACT_URL",
  "UPSTREAM_COMPANY_PUBLICATION_URL", "UPSTREAM_COMPANY_EVALUATION_URL", "UPSTREAM_WEBSITE_URL", "UPSTREAM_STRUCTURED_CONTENT_URL"]) {
  process.env[k] ??= "http://localhost:1";
}
process.env.EVENT_BUS_URL ??= "amqp://localhost:1";
process.env.DATABASE_URL = process.env.DATABASE_URL?.startsWith("http") ? "postgres://x:y@localhost:1/db" : process.env.DATABASE_URL;
process.env.BILLING_CRON_DISABLED = "1";
process.env.JWKS_URI ??= "http://localhost:1/jwks";

const { computeSeats, tierAt, periodBounds } = await import("../src/lib/seat-billing");
type MembershipInterval = import("../src/lib/seat-billing").MembershipInterval;
type TierChange = import("../src/lib/seat-billing").TierChange;

const d = (s: string) => new Date(s);
const prices = (t: "starter" | "pro") => (t === "starter" ? 4900 : 14900);
const P = "2026-09";
let tests = 0;
function t(name: string, fn: () => void) {
  tests++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}
const m = (actorId: string, joinedAt: string, leftAt: string | null = null): MembershipInterval => ({ actorId, email: `${actorId}@x.de`, name: actorId, joinedAt: d(joinedAt), leftAt: leftAt ? d(leftAt) : null });
const starterAll: TierChange[] = [{ tier: "starter", validFrom: d("2026-01-01T00:00:00Z") }];

t("periodBounds September = 30 Tage", () => {
  const b = periodBounds(P);
  assert.equal(b.days, 30);
  assert.equal(b.start.toISOString(), "2026-09-01T00:00:00.000Z");
});

t("A ganzer Monat Starter = 1 x 49", () => {
  const r = computeSeats({ periodKey: P, memberships: [m("A", "2026-05-01T10:00:00Z")], timeline: starterAll, prices });
  assert.equal(r.seatCount, 1);
  assert.equal(r.subtotalCents, 4900);
  assert.equal(r.seats[0]!.countedDays, 30);
  assert.equal(r.seats[0]!.firstCountedDay, "2026-09-01");
});

t("B tritt am 20. bei = voller Monat, Stichtage 21.-30.", () => {
  const r = computeSeats({ periodKey: P, memberships: [m("B", "2026-09-20T09:00:00Z")], timeline: starterAll, prices });
  assert.equal(r.seatCount, 1);
  assert.equal(r.seats[0]!.firstCountedDay, "2026-09-21");
  assert.equal(r.seats[0]!.countedDays, 10);
});

t("C 5. rein, 6. raus = 1 Seat (Stichtag 6. 00:00 bestand)", () => {
  const r = computeSeats({ periodKey: P, memberships: [m("C", "2026-09-05T09:00:00Z", "2026-09-06T12:00:00Z")], timeline: starterAll, prices });
  assert.equal(r.seatCount, 1);
  assert.equal(r.seats[0]!.countedDays, 1);
});

t("D am selben Tag rein und raus = 0 Seats", () => {
  const r = computeSeats({ periodKey: P, memberships: [m("D", "2026-09-05T09:00:00Z", "2026-09-05T17:00:00Z")], timeline: starterAll, prices });
  assert.equal(r.seatCount, 0);
  assert.equal(r.subtotalCents, 0);
});

t("E Upgrade am 12. auf Pro = 1 x 149", () => {
  const tl: TierChange[] = [{ tier: "starter", validFrom: d("2026-01-01T00:00:00Z") }, { tier: "pro", validFrom: d("2026-09-12T15:00:00Z") }];
  const r = computeSeats({ periodKey: P, memberships: [m("E", "2026-05-01T00:00:00Z")], timeline: tl, prices });
  assert.equal(r.seats[0]!.tier, "pro");
  assert.equal(r.subtotalCents, 14900);
});

t("F Downgrade wirkt ab Folgemonat: September Pro, Oktober Starter", () => {
  const tl: TierChange[] = [{ tier: "pro", validFrom: d("2026-01-01T00:00:00Z") }, { tier: "starter", validFrom: d("2026-10-01T00:00:00Z") }];
  const sep = computeSeats({ periodKey: "2026-09", memberships: [m("F", "2026-05-01T00:00:00Z")], timeline: tl, prices });
  const okt = computeSeats({ periodKey: "2026-10", memberships: [m("F", "2026-05-01T00:00:00Z")], timeline: tl, prices });
  assert.equal(sep.subtotalCents, 14900);
  assert.equal(okt.subtotalCents, 4900);
});

t("G geht am 2., H kommt am 3. = 2 Seats (je Person)", () => {
  const r = computeSeats({ periodKey: P, memberships: [m("G", "2026-05-01T00:00:00Z", "2026-09-02T08:00:00Z"), m("H", "2026-09-03T08:00:00Z")], timeline: starterAll, prices });
  assert.equal(r.seatCount, 2);
  assert.equal(r.subtotalCents, 9800);
});

t("Aktivierung am 28. mit 6 Mitgliedern = 6 Seats", () => {
  const tl: TierChange[] = [{ tier: "starter", validFrom: d("2026-09-28T14:00:00Z") }];
  const ms = ["1", "2", "3", "4", "5", "6"].map((i) => m(i, "2026-03-01T00:00:00Z"));
  const r = computeSeats({ periodKey: P, memberships: ms, timeline: tl, prices });
  assert.equal(r.seatCount, 6);
  assert.equal(r.seats[0]!.firstCountedDay, "2026-09-29");
  assert.equal(r.seats[0]!.countedDays, 2);
});

t("K2 Beitritt 31. 23:30 UTC zaehlt erst im Folgemonat", () => {
  const ms = [m("K2", "2026-08-31T23:30:00Z")];
  assert.equal(computeSeats({ periodKey: "2026-08", memberships: ms, timeline: starterAll, prices }).seatCount, 0);
  assert.equal(computeSeats({ periodKey: "2026-09", memberships: ms, timeline: starterAll, prices }).seatCount, 1);
});

t("K4 entfernt und im selben Monat erneut aufgenommen = 1 Seat", () => {
  const ms = [m("K4", "2026-05-01T00:00:00Z", "2026-09-10T00:00:00Z"), m("K4", "2026-09-20T00:00:00Z")];
  const r = computeSeats({ periodKey: P, memberships: ms, timeline: starterAll, prices });
  assert.equal(r.seatCount, 1);
  assert.equal(r.seats[0]!.firstCountedDay, "2026-09-01");
  assert.equal(r.seats[0]!.lastCountedDay, "2026-09-30");
  assert.equal(r.seats[0]!.countedDays, 9 + 11);
});

t("Sammelabrechnung aus (none) = keine Seats", () => {
  const tl: TierChange[] = [{ tier: "starter", validFrom: d("2026-01-01T00:00:00Z") }, { tier: "none", validFrom: d("2026-09-01T00:00:00Z") }];
  const r = computeSeats({ periodKey: P, memberships: [m("A", "2026-05-01T00:00:00Z")], timeline: tl, prices });
  assert.equal(r.seatCount, 0);
});

t("K20 Karenzband 25: Beitritt 26. zaehlt erst im Folgemonat", () => {
  const ms = [m("K20", "2026-09-26T10:00:00Z", "2026-10-03T10:00:00Z")];
  assert.equal(computeSeats({ periodKey: "2026-09", memberships: ms, timeline: starterAll, prices, karenzTag: 25 }).seatCount, 0);
  const okt = computeSeats({ periodKey: "2026-10", memberships: ms, timeline: starterAll, prices, karenzTag: 25 });
  assert.equal(okt.seatCount, 1);
  assert.equal(okt.seats[0]!.countedDays, 3);
});

t("Mischung: 2 Starter-Zeilen bleiben eine Position, Hash stabil", () => {
  const r1 = computeSeats({ periodKey: P, memberships: [m("A", "2026-05-01T00:00:00Z"), m("B", "2026-05-01T00:00:00Z")], timeline: starterAll, prices });
  const r2 = computeSeats({ periodKey: P, memberships: [m("B", "2026-05-01T00:00:00Z"), m("A", "2026-05-01T00:00:00Z")], timeline: starterAll, prices });
  assert.equal(r1.lines.length, 1);
  assert.equal(r1.lines[0]!.seats, 2);
  assert.equal(r1.computeHash, r2.computeHash);
});

t("tierAt ohne Eintrag = none, vor erster Aenderung = none", () => {
  assert.equal(tierAt([], d("2026-09-01T00:00:00Z")), "none");
  assert.equal(tierAt(starterAll, d("2025-12-31T23:59:59Z")), "none");
  assert.equal(tierAt(starterAll, d("2026-01-01T00:00:00Z")), "starter");
});

console.log(`\n${tests} Tests bestanden.`);
